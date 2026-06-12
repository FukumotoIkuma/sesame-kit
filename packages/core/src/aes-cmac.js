// AES-128-CMAC (RFC 4493) の内製実装 — node:crypto の AES-128-ECB/CBC のみ使用。
//
// ★内製化の動機 (REFACTORING_PLAN P5-2 / ARCH-03):
//   従来依存していた `node-aes-cmac` は 2014 年公開以降無メンテで、内部で deprecated な
//   `new Buffer(...)` コンストラクタを使用していた。AES-CMAC はロック施錠 MAC 生成・
//   セッション鍵導出というセキュリティ要所であり、無メンテ外部パッケージへの依存を排して
//   RFC 4493 準拠の純 Node 実装に置き換える (RFC 4493 §4 の全 Test Vector を
//   tests/crypto/aes-cmac.test.js で固定)。
//
// アルゴリズム出典: RFC 4493 §2.3 (Subkey Generation) / §2.4 (MAC Generation)。
//   - K1/K2: L = AES-128(K, 0^128) を GF(2^128) 上で x 倍 (左 1bit シフト + MSB 立ちなら
//     Rb=0x87 を末尾 XOR)。
//   - MAC: 最終ブロックを K1 (完全ブロック) / K2 (10^i パディング) で XOR し、
//     IV=0 の AES-128-CBC を全ブロックに流した最終暗号ブロックが MAC。
//     CBC の連鎖 (C_i = AES(K, C_{i-1} XOR M_i)) は RFC 4493 Figure 2 の逐次 AES と等価。

import { createCipheriv } from "node:crypto";
import { Buffer } from "node:buffer";

const BLOCK = 16;
const ZERO_BLOCK = Buffer.alloc(BLOCK);
const RB = 0x87; // RFC 4493 §2.3 const_Rb の最下位バイト (0^120 || 10000111)

/**
 * GF(2^128) 上の x 倍 (RFC 4493 §2.3 の「左 1bit シフト + 条件付き const_Rb XOR」)。
 * @param {Buffer} b 16B
 * @returns {Buffer} 16B
 */
function dbl(b) {
  const out = Buffer.alloc(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    out[i] = ((b[i] << 1) & 0xff) | (i + 1 < BLOCK ? b[i + 1] >>> 7 : 0);
  }
  if (b[0] & 0x80) out[BLOCK - 1] ^= RB;
  return out;
}

/**
 * AES-128-CMAC (RFC 4493)。
 * @param {Buffer|Uint8Array} key 16B AES 鍵
 * @param {Buffer|Uint8Array} message 署名対象 (0B 可)
 * @returns {Buffer} 16B MAC
 */
export function aesCmac(key, message) {
  const k = Buffer.isBuffer(key) ? key : key instanceof Uint8Array ? Buffer.from(key) : null;
  if (!k || k.length !== BLOCK) {
    throw new Error(`aesCmac: key must be a 16-byte Buffer (got ${k ? `${k.length}B` : typeof key})`);
  }
  const msg = Buffer.isBuffer(message)
    ? message
    : message instanceof Uint8Array ? Buffer.from(message) : null;
  if (!msg) throw new Error(`aesCmac: message must be a Buffer/Uint8Array (got ${typeof message})`);

  // §2.3: L = AES-128(K, 0^128) → K1 = dbl(L), K2 = dbl(K1)。
  // ECB 1 ブロック (パディング無し) = 生 AES ブロック暗号化。
  const ecb = createCipheriv("aes-128-ecb", k, null);
  ecb.setAutoPadding(false);
  const l = Buffer.concat([ecb.update(ZERO_BLOCK), ecb.final()]);
  const k1 = dbl(l);
  const k2 = dbl(k1);

  // §2.4: n = max(1, ceil(len/16))。最終ブロックは
  //   完全ブロック → M_last = M_n XOR K1
  //   不完全/空    → M_last = (M_n || 10^j) XOR K2
  const n = Math.max(1, Math.ceil(msg.length / BLOCK));
  const lastIsComplete = msg.length > 0 && msg.length % BLOCK === 0;
  const head = msg.subarray(0, (n - 1) * BLOCK);
  let last;
  if (lastIsComplete) {
    last = Buffer.from(msg.subarray((n - 1) * BLOCK));
    for (let i = 0; i < BLOCK; i++) last[i] ^= k1[i];
  } else {
    last = Buffer.alloc(BLOCK); // 0 埋め = 10^j パディングの 0 部分
    msg.copy(last, 0, (n - 1) * BLOCK);
    last[msg.length - (n - 1) * BLOCK] = 0x80; // パディング先頭の 1 ビット
    for (let i = 0; i < BLOCK; i++) last[i] ^= k2[i];
  }

  // IV=0 の AES-128-CBC で (head || last) を流し、最終暗号ブロック = MAC (§2.4 Step 6)。
  const cbc = createCipheriv("aes-128-cbc", k, ZERO_BLOCK);
  cbc.setAutoPadding(false);
  const ct = Buffer.concat([cbc.update(Buffer.concat([head, last])), cbc.final()]);
  return Buffer.from(ct.subarray(ct.length - BLOCK));
}

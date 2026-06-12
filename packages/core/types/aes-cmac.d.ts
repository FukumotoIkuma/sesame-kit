/**
 * AES-128-CMAC (RFC 4493)。
 * @param {Buffer|Uint8Array} key 16B AES 鍵
 * @param {Buffer|Uint8Array} message 署名対象 (0B 可)
 * @returns {Buffer} 16B MAC
 */
export function aesCmac(key: Buffer | Uint8Array, message: Buffer | Uint8Array): Buffer;
import { Buffer } from "node:buffer";
//# sourceMappingURL=aes-cmac.d.ts.map
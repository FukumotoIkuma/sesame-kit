// P4-3 / P4-7 回帰テスト (biometric.test.js とは別ファイル)。
// biometric.test.js は os2-mech レーンも触るため、本 lane (biometric) の追加項目を分離した。
import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { parsePubKeySesame, parseTouchFace } from "../../src/ble/biometric.js";

// ── P4-3: SS2 分岐の decoded.length !== 16 ガード ──────────────────────────
//
// 修正前は Buffer.from(b64, "base64") が常に続行し、16B 以外の decoded でも
// ssmID (short/long hex) が keys に混入していた。
// 修正後は decoded.length !== 16 のチャンクを continue でスキップする。
//
// テストベクタの導出:
//   SDK SS2 経路: it[0..21] を ASCII 文字列とみなし "==" を補って base64 デコードする
//   (CHSesameBiometricDeviceImpl.kt:243-245)。
//   正規の 22B は 16B UUID の base64(末尾 "==" 除去)。
//   不正 22B (lockStatus≠0) = base64 デコードが 16B でない任意の ASCII 列。
//
//   ケース A: 22B 中に "+" "=" 等が混ざると decoded が 16B にならないことがある。
//     例: 22B = b"AAAAAAAAAAAAAAAAAAAAAA" → base64("AAAAAAAAAAAAAAAAAAAAAA==")
//         = decode of 22-char base64url-alphabet → depends on char values.
//     確実な方法: 22B のうち先頭を 0x00 で埋めると "" が多くなり decoded が短くなる。
//     実際には Buffer.from("base64") は不正文字を無視するため、デコード長は入力文字数に依存する。
//
//   確実な不正ケース: 22B の ASCII 列で base64 デコードが 16B を超える場合 (パディング付きで
//   24 文字以上になる等は無いが) は難しいので、代わりに「lockStatus≠0 で it[21]≠0 だが
//   22B の base64 decode が 16B 未満になる入力」を使う。
//
//   実際には Buffer.from("AAAAAAAAAAAAAAAAAAAAAA==", "base64") = 16B になる。
//   Base64 decode: 22文字 + "==" = 24文字 = 18B の base64 → 18 * 6 / 8 = 13.5 → ??
//   正しくは: 22文字は 22*6 = 132bit を表し、padding "==" は 2文字不足 → 24字 = 18B 生成。
//
//   別アプローチ: 22B すべてを有効な base64 文字で満たすと 16B になる (22char base64 → 16.5B = 16B floor)。
//   実測: Buffer.from("A".repeat(22) + "==", "base64").length → 16。(22文字 padding 込み24字)
//   22-char base64 is actually: 22*6=132 bits, 132/8=16.5, so 16 bytes with 4 bits remaining.
//   With "==" padding: 22+2=24 chars = 18 bytes raw decoded (nodejs base64 may vary).
//
//   直接実測して確認する:
describe("P4-3: parsePubKeySesame SS2 分岐の decoded.length !== 16 ガード", () => {
  /**
   * 23B チャンクを組み立てる。
   * @param {Buffer|number[]} bytes0to21  先頭 22B (it[0..21])
   * @param {number} lockStatus           it[22]
   * @param {boolean} setSS2              it[21] を非ゼロにするか (SS2 経路)
   * @returns {Buffer}
   */
  function makeChunk(bytes0to21, lockStatus, setSS2 = true) {
    const chunk = Buffer.alloc(23, 0x00);
    Buffer.from(bytes0to21).copy(chunk, 0);
    if (setSS2 && chunk[21] === 0x00) {
      chunk[21] = 0x01; // SS2 経路判定: it[21] != 0
    }
    chunk[22] = lockStatus;
    return chunk;
  }

  it("正常な 22B base64 → decoded=16B → keys に含まれる", () => {
    // 16B UUID を base64 して末尾 "==" を除去した 22 文字が正規の SS2 エントリ。
    // 導出: Buffer.alloc(16, 0xab).toString("base64") = "q6urq6urq6urq6urq6s=" (24 chars)
    //   → 末尾 "=" を取ると 23 chars、"==" を取ると 22 chars。
    // CHSesameBiometricDeviceImpl.kt:243: it.sliceArray(IntRange(0,21)) を String() + "==" で decode。
    // 正規 UUID の base64 末尾は "==" になることが保証されないため、確実に 22 文字になる例を使う:
    // Buffer.alloc(16, 0x00) → "AAAAAAAAAAAAAAAAAAAAAA==" (24 chars, 末尾 "==")
    //   → slice(0, 22) = "AAAAAAAAAAAAAAAAAAAAAA" → decode back = 16B。
    const uuid16 = Buffer.alloc(16, 0x00);
    const b64full = uuid16.toString("base64"); // "AAAAAAAAAAAAAAAAAAAAAA=="
    expect(b64full.length).toBe(24);
    const b22 = b64full.slice(0, 22); // 末尾 "==" を取る
    expect(b22.length).toBe(22);
    // 実際に decode して 16B になることを確認
    const roundTrip = Buffer.from(b22 + "==", "base64");
    expect(roundTrip.length).toBe(16);

    const chunk = makeChunk(Buffer.from(b22, "latin1"), 0x03);
    const r = parsePubKeySesame(chunk);
    expect(r.keys).toHaveLength(1);
    expect(r.keys[0].keyType).toBe(0x04);
    expect(r.keys[0].lockStatus).toBe(3);
    expect(r.keys[0].ssmID).toBe("00".repeat(16));
  });

  it("P4-3: base64 decode が 16B でない SS2 チャンク(lockStatus≠0) は keys に含まれない", () => {
    // 22B の内容を「base64 decode が 16B にならない文字列」にする。
    // Node.js Buffer.from(str, "base64") は不正文字を無視するため、
    // スペースや制御文字を混ぜると有効文字数が減り decoded が短くなる。
    // スペース(0x20)は base64 アルファベット外なので無視される:
    //   例: "A " * 11 = 22B だが有効文字は "A" * 11 = 11文字。
    //   11文字 base64 decode ≈ 8B (11*6/8=8.25) → 8B。
    //
    // 導出:
    //   chunk[0..21] = ASCII で 'A'(0x41) と ' '(0x20) 交互 11 ペア = 22B。
    //   Buffer.from("A " * 11 + "==", "base64") の有効文字 = 11 個の 'A' = 8B 前後。
    const b22 = Buffer.alloc(22);
    for (let i = 0; i < 22; i++) {
      b22[i] = i % 2 === 0 ? 0x41 : 0x20; // 'A' と ' ' 交互
    }
    // it[21] = 0x20 (space) は非ゼロなので SS2 経路に入る。
    expect(b22[21]).toBe(0x20); // SS2 判定 (it[21] != 0)

    // decoded 長を事前確認 (テストの前提検証)
    const decoded = Buffer.from(b22.toString("latin1") + "==", "base64");
    expect(decoded.length).not.toBe(16); // 不正 → 16B でないことを確認

    const chunk = makeChunk(b22, 0x05, false); // false: it[21] は b22[21]=0x20 のまま使う
    chunk[22] = 0x05; // lockStatus≠0
    const r = parsePubKeySesame(chunk);
    // P4-3 ガードにより keys に含まれない
    expect(r.keys).toHaveLength(0);
  });

  it("P4-3: 全ゼロ以外だが base64 decode が 16B でない → keys に含まれず空きスロット計上もされない", () => {
    // 全ゼロでない (lockStatus=0x01) が decoded が 16B でないチャンク:
    //   keys に含まれず、emptySlotCount にも含まれない (全ゼロでないため)。
    const b22 = Buffer.from("!".repeat(22), "latin1"); // '!'(0x21) は base64 アルファベット外
    expect(b22[21]).toBe(0x21); // SS2 経路
    const decoded = Buffer.from(b22.toString("latin1") + "==", "base64");
    expect(decoded.length).not.toBe(16);

    const chunk = Buffer.concat([b22, Buffer.from([0x01])]); // lockStatus=1
    const r = parsePubKeySesame(chunk);
    expect(r.keys).toHaveLength(0);
    expect(r.emptySlotCount).toBe(0); // 全ゼロではないので空きスロット扱いされない
  });

  it("P4-3: 不正 SS2 チャンクと正常 SS5 チャンクが混在 → SS5 のみ keys に含まれる", () => {
    // SS5 チャンク: it[21]=0x00 → 先頭 16B が直接 ssmID
    const ss5id = Buffer.alloc(16, 0xcc);
    const ss5chunk = Buffer.concat([ss5id, Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02])]); // [21]=0, [22]=2
    expect(ss5chunk.length).toBe(23);
    expect(ss5chunk[21]).toBe(0x00); // SS5
    expect(ss5chunk[22]).toBe(0x02); // lockStatus

    // 不正 SS2 チャンク
    const b22bad = Buffer.from("!".repeat(22), "latin1");
    const ss2bad = Buffer.concat([b22bad, Buffer.from([0x01])]); // lockStatus=1
    expect(ss2bad.length).toBe(23);
    expect(ss2bad[21]).toBe(0x21); // SS2 (非ゼロ)
    const decodedBad = Buffer.from(b22bad.toString("latin1") + "==", "base64");
    expect(decodedBad.length).not.toBe(16); // 前提確認

    const r = parsePubKeySesame(Buffer.concat([ss5chunk, ss2bad]));
    expect(r.keys).toHaveLength(1); // SS5 のみ
    expect(r.keys[0].keyType).toBe(0x05);
    expect(r.keys[0].ssmID).toBe("cc".repeat(16));
    expect(r.keys[0].lockStatus).toBe(2);
  });
});

// ── P4-7: 虚偽コメント是正の確認 ────────────────────────────────────────────
//
// P4-7 はコメントのみ変更で挙動変更なし。
// 以下テストで parseTouchFace / parsePubKeySesame の hex 返し挙動が維持されることを確認し、
// 「コメントを読んだ実装者が hexToUuid を使えることを知っている」状態の基準テストとして記録する。
describe("P4-7: parseTouchFace / parsePubKeySesame は hex 正規形で識別子を返す(挙動確認)", () => {
  it("parseTouchFace: id / nameUUID はハイフン無し小文字 hex を返す", () => {
    // type=02, idLen=01, id=0x7f, nameLen=04, name=deadbeef
    const data = Buffer.from([0x02, 0x01, 0x7f, 0x04, 0xde, 0xad, 0xbe, 0xef]);
    const f = parseTouchFace(data);
    // id: hex 正規形 (ハイフン無し)
    expect(f.id).toBe("7f");
    // nameUUID: hex 正規形 (ハイフン無し)。消費側が hexToUuid で整形する (crypto.js:hexToUuid)。
    expect(f.nameUUID).toBe("deadbeef");
    // ハイフンは含まれない
    expect(f.nameUUID).not.toContain("-");
  });

  it("parsePubKeySesame: SS5 ssmID はハイフン無し小文字 hex を返す", () => {
    const id16 = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex");
    const chunk = Buffer.concat([id16, Buffer.alloc(5, 0x00), Buffer.from([0x00, 0x01])]);
    const r = parsePubKeySesame(chunk);
    expect(r.keys).toHaveLength(1);
    // ssmID: hex 正規形。消費側が必要なら hexToUuid で整形する。
    expect(r.keys[0].ssmID).toBe("0102030405060708090a0b0c0d0e0f10");
    expect(r.keys[0].ssmID).not.toContain("-");
  });
});

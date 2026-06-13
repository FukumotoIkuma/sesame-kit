// P5-8 契約フィンガープリントテスト (規範7 のゲート)。
//
// 目的: 公開 RPC メソッド集合が変わったのに CONTRACT_VERSION が据え置かれた状態を
//       CI で検出し、バージョン bump を強制する。
//
// 算出方法: buildRegistry().keys() をソートして "," 結合し SHA-256 下位 64bit (16 hex)。
//
// 判定ルール:
//   PASS → 現在の hash が KNOWN_FINGERPRINTS[CONTRACT_VERSION] と一致
//   FAIL → 不一致の場合は以下のどちらかを行う:
//     (A) メソッドを増減させた → CONTRACT_VERSION を bump し KNOWN_FINGERPRINTS に新エントリを追加
//     (B) ハッシュ算出ロジックのバグ / 偶発的な生成物崩れ → 原因を調査してから修正
//
// なぜ KNOWN_FINGERPRINTS を jsonrpc.js に置くか:
//   - CONTRACT_VERSION を bump するのは jsonrpc.js の責務 (規範7: 1:1 連動が必須)
//   - 同ファイルにフィンガープリントを置くことで「version を変えたら hash も更新」が
//     1 ファイルのレビューで完結する
//   - result 形・params 形・gRPC presence 等の変更は hash を変えないため bump 不要が
//     このテストで機械的に証明される

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { buildRegistry } from "../../src/serve/registry.js";
import { CONTRACT_VERSION, KNOWN_FINGERPRINTS } from "@sesame-kit/core/jsonrpc";

/**
 * 公開メソッド集合のフィンガープリントを計算する。
 * @param {Map<string, unknown>} registry buildRegistry() の戻り値
 * @returns {string} SHA-256 下位 64bit の hex 文字列 (16 文字)
 */
function computeFingerprint(registry) {
  const methods = [...registry.keys()].sort().join(",");
  return createHash("sha256").update(methods).digest("hex").slice(0, 16);
}

describe("P5-8 契約フィンガープリント (規範7 ゲート)", () => {
  it("現在のメソッド集合 hash が KNOWN_FINGERPRINTS[CONTRACT_VERSION] と一致 (不一致 → bump 必要)", () => {
    // 不一致の場合は下記を実施すること:
    //   1. 追加/削除/改名したメソッドを確認する。
    //   2. packages/core/src/jsonrpc.js の CONTRACT_VERSION を次の minor (または major) に bump。
    //   3. KNOWN_FINGERPRINTS に新バージョン: "新hash" を追記 (旧エントリは消さない)。
    //   4. changelog コメントに追加/削除メソッドを記載。
    // result 形のみの変更は hash 不変なので bump 不要 — このテストが緑なら bump 不要を機械証明する。
    const registry = buildRegistry();
    const actual = computeFingerprint(registry);

    const knownHash = KNOWN_FINGERPRINTS[CONTRACT_VERSION];
    expect(
      knownHash,
      `KNOWN_FINGERPRINTS["${CONTRACT_VERSION}"] が未定義 — jsonrpc.js に新しいバージョンのエントリを追加してください`,
    ).toBeDefined();

    expect(
      actual,
      [
        `メソッド集合のフィンガープリントが変わりました。`,
        `  CONTRACT_VERSION : ${CONTRACT_VERSION}`,
        `  expected (known) : ${knownHash}`,
        `  actual           : ${actual}`,
        `  メソッド数       : ${registry.size}`,
        ``,
        `対処: packages/core/src/jsonrpc.js の CONTRACT_VERSION を bump し、`,
        `  KNOWN_FINGERPRINTS に "${CONTRACT_VERSION}+1": "${actual}" を追記してください。`,
      ].join("\n"),
    ).toBe(knownHash);
  });

  it("KNOWN_FINGERPRINTS は CONTRACT_VERSION を含む (版とフィンガープリントの 1:1 連動)", () => {
    // KNOWN_FINGERPRINTS に CONTRACT_VERSION エントリが無い場合、上の not-defined メッセージで
    // 分かるが、二重保証として独立テストにしておく。
    expect(CONTRACT_VERSION in KNOWN_FINGERPRINTS).toBe(true);
  });

  it("フィンガープリント算出が決定的 (同 registry で 2 回呼んでも同じ値)", () => {
    // ソートが非決定的になっていないか / ランダム要素が混入していないかを検証。
    const r = buildRegistry();
    const h1 = computeFingerprint(r);
    const h2 = computeFingerprint(r);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(16); // 16 hex 文字 = SHA-256 下位 64bit
  });

  it("P5-8: CONTRACT_VERSION=1.4.0 のメソッド数は 205 (keystore 3 メソッド追加 P3-2)", () => {
    // 計画書 P5-8 の受け入れ基準: メソッド集合が 205 件であることを機械的に確認。
    // 内訳: v1.3.0 の 202 メソッド + keystore.list / keystore.put / keystore.remove (P3-2)。
    // result 形変更 (isStop nullable P4-2 / payment.changeDefaultPayment reqContext P3-8) は
    // メソッド集合に変化を与えないため、ここの数値には影響しない。
    const registry = buildRegistry();
    expect(
      registry.size,
      `メソッド数が 205 と一致しない — メソッドを追加/削除した場合は CONTRACT_VERSION を bump し KNOWN_FINGERPRINTS を更新すること`,
    ).toBe(205);
  });
});

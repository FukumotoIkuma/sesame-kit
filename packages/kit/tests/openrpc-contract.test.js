// 公開 OpenRPC 成果物 (schema/openrpc.json) ↔ 実装 の双方向 drift gate。
//
// これが iii の核心: 「実装が真実」を成果物に固定し、両者がずれたら CI で必ず落とす。
// ずれる典型: メソッド/イベント追加・param 変更・tier 変更を commit したが
// `npm run build:openrpc` を忘れた → 公開契約が黙って腐るのを防ぐ。
//
// 比較対象は「機械契約の射影」(メソッド名 / params 名・required・schema / result 型 /
// x-stability / x-provenance / events)。要約・説明文はローカライズされた *ドキュメント* で
// あって契約ではないので、locale 非依存にするため射影から除外する (SDK 生成が依存するのは
// 機械的な形だけ)。
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildRegistry, buildOpenRpcDoc } from "../src/serve/registry.js";
import { CONTRACT_VERSION } from "@sesame-kit/core/jsonrpc";

/** OpenRPC doc → 機械契約だけの射影 (散文を落とす)。 */
function machineContract(doc) {
  const param = (p) => ({ name: p.name, required: p.required, schema: p.schema });
  return {
    openrpc: doc.openrpc,
    info: {
      title: doc.info.title,
      version: doc.info.version,
      "x-apiVersion": doc.info["x-apiVersion"],
      "x-contractVersion": doc.info["x-contractVersion"],
    },
    methods: doc.methods.map((m) => ({
      name: m.name,
      params: (m.params || []).map(param),
      // 結果スキーマ全体を契約に含める (型付き SDK return の drift を捕捉)。description は散文なので除く。
      result: m.result?.schema ? { ...m.result.schema, description: undefined } : undefined,
      "x-stability": m["x-stability"],
      "x-provenance": m["x-provenance"],
    })),
    events: doc["x-events"].map((e) => ({
      name: e.name,
      "x-stability": e["x-stability"],
      "x-provenance": e["x-provenance"],
    })),
    eventTopics: doc["x-event-topics"],
  };
}

const committed = JSON.parse(readFileSync(new URL("../../../schema/openrpc.json", import.meta.url)));

describe("OpenRPC contract artifact (schema/openrpc.json)", () => {
  it("機械契約が実装と一致する (ずれたら `npm run build:openrpc` で再生成)", () => {
    const live = buildOpenRpcDoc(buildRegistry(), CONTRACT_VERSION);
    expect(machineContract(committed)).toEqual(machineContract(live));
  });

  it("info.version / x-apiVersion は CONTRACT_VERSION", () => {
    expect(committed.info.version).toBe(CONTRACT_VERSION);
    expect(committed.info["x-apiVersion"]).toBe(CONTRACT_VERSION);
  });

  it("rpc.discover 自身も公開契約に含む", () => {
    const discover = committed.methods.find((m) => m.name === "rpc.discover");
    expect(discover).toBeTruthy();
    expect(discover["x-stability"]).toBe("stable");
    expect(discover["x-provenance"]).toBe("local");
  });

  it("全 method/event が x-stability / x-provenance を持つ (公開契約の完全性)", () => {
    for (const m of committed.methods) {
      expect(["stable", "experimental"]).toContain(m["x-stability"]);
      expect(typeof m["x-provenance"]).toBe("string");
    }
    for (const e of committed["x-events"]) {
      expect(["stable", "experimental"]).toContain(e["x-stability"]);
    }
  });
});

// ── メソッド集合 + x-event-topics のハッシュ ↔ CONTRACT_VERSION 連動テスト (規範7) ────────────
//
// 目的: 新しいメソッドや event topic を追加した際に CONTRACT_VERSION を bump し忘れると
//       このテストが fail する (機械的強制)。
//
// 仕組み:
//   1. live レジストリから「メソッド名一覧(ソート済み) + x-event-topics」を JSON 連結し
//      SHA-256 の先頭 16 hex 桁 (64-bit) を「集合フィンガープリント」とする。
//   2. 各 CONTRACT_VERSION に対応するフィンガープリントをこのファイルに固定する。
//   3. 現在の集合フィンガープリントが、現 CONTRACT_VERSION に登録された値と一致しなければ fail。
//
// 更新方法:
//   - メソッド追加/削除・topics 変更をした後 `npm run build` を実行し、
//     その後このファイルの KNOWN_FINGERPRINTS に新 version → 新ハッシュ を登録し、
//     CONTRACT_VERSION を bump する。
//   - 集合が変わったのにハッシュ登録も version bump もしなかった場合、
//     下段の "ハッシュが KNOWN_FINGERPRINTS に未登録" アサーションが失敗する。
//
// フィンガープリントの導出:
//   SHA-256(JSON.stringify(methodNames.sort()) + JSON.stringify(eventTopics))
//   の先頭 16 hex 桁。
//
// 登録済みフィンガープリント一覧:
//   1.2.0 → "1.2.0 は 1.3.0 へ移行済み。集合フィンガープリントは 1.3.0 に統合"
//   1.3.0 → d19ad7b056be728e  (202 メソッド / topics: lockState,deviceUpdate,deviceListChanged)
//            Phase1-4 の全追加(ble.scan, auth-data 4op, os2.reset/position, syncRemotesFromServer,
//            events topics enum) + P3-27 の ble.wifi.networkStatus 削除 を含む。
//   1.4.0 → 64ea81ba7ced77e0  (205 メソッド / topics: lockState,deviceUpdate,deviceListChanged)
//            P3-2: keystore.list / keystore.put / keystore.remove を追加 (@experimental §9 V15)。
/** @type {Record<string, string>} */
const KNOWN_FINGERPRINTS = {
  "1.3.0": "d19ad7b056be728e",
  "1.4.0": "64ea81ba7ced77e0",
};

/**
 * メソッド名一覧 (ソート済み) + x-event-topics から SHA-256 先頭 16 hex を返す。
 * @param {object} doc OpenRPC doc
 * @returns {string}
 */
function methodSetFingerprint(doc) {
  const methods = doc.methods.map((m) => m.name).sort();
  const topics = doc["x-event-topics"] ?? [];
  const combined = JSON.stringify(methods) + JSON.stringify(topics);
  return createHash("sha256").update(combined).digest("hex").slice(0, 16);
}

describe("CONTRACT_VERSION ↔ メソッド集合フィンガープリント連動 (規範7)", () => {
  it("現 CONTRACT_VERSION がフィンガープリント表に登録されている", () => {
    // この assert が fail した場合: version を bump してフィンガープリントを KNOWN_FINGERPRINTS に追加する。
    const registered = Object.hasOwn(KNOWN_FINGERPRINTS, CONTRACT_VERSION);
    expect(registered).toBe(
      true,
      `CONTRACT_VERSION=${CONTRACT_VERSION} が KNOWN_FINGERPRINTS に未登録。` +
      "version bump 後にフィンガープリントを登録してください。",
    );
  });

  it("live レジストリのメソッド集合が CONTRACT_VERSION に登録されたフィンガープリントと一致する", () => {
    const live = buildOpenRpcDoc(buildRegistry(), CONTRACT_VERSION);
    const fingerprint = methodSetFingerprint(live);
    const expected = KNOWN_FINGERPRINTS[CONTRACT_VERSION];
    // この assert が fail した場合: メソッド集合が変化したのに CONTRACT_VERSION が据え置きの可能性がある。
    // `npm run build` を実行して openrpc.json を再生成し、CONTRACT_VERSION を bump し、
    // 新フィンガープリントを KNOWN_FINGERPRINTS に登録する。
    expect(fingerprint).toBe(
      expected,
      `メソッド集合が変化しましたが CONTRACT_VERSION=${CONTRACT_VERSION} が据え置きです。` +
      `現フィンガープリント: ${fingerprint} / 登録値: ${expected}。` +
      "CONTRACT_VERSION を bump して KNOWN_FINGERPRINTS を更新してください。",
    );
  });

  it("committed openrpc.json のフィンガープリントも現 CONTRACT_VERSION に一致する (build 済み確認)", () => {
    const fingerprint = methodSetFingerprint(committed);
    const expected = KNOWN_FINGERPRINTS[CONTRACT_VERSION];
    // この assert が fail した場合: CONTRACT_VERSION を変更したが `npm run build` が未実行の可能性がある。
    // `npm run build` を実行して schema/openrpc.json を再生成してください。
    expect(fingerprint).toBe(
      expected,
      `schema/openrpc.json のフィンガープリント (${fingerprint}) が ` +
      `CONTRACT_VERSION=${CONTRACT_VERSION} の登録値 (${expected}) と不一致。` +
      "`npm run build` を実行して再生成してください。",
    );
  });
});

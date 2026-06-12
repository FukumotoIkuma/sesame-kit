// P4-11 (R2:SURF-37): stable 昇格時のスキーマ漏れを CI で検出するテスト。
//
// 問題: STABLE_METHODS に新メソッドを追加した際、RESULT_SCHEMAS への対応追加を
// 忘れると SDK 生成時の戻り型が unknown/Any に劣化する。これをビルド前に検出する。
//
// 1 アサーション: STABLE_METHODS のキー(rpc.discover 除く) ⊆ RESULT_SCHEMAS のキー
// rpc.discover 除外理由: rpc.discover はメタ API でドメインデータを返さないため
//   スキーマは不要(戻り値は生成系が固定出力)。
import { describe, it, expect } from "vitest";
import { STABLE_METHODS } from "../../src/serve/stability.js";
import { RESULT_SCHEMAS } from "../../src/serve/result-schemas.js";
import { generateProto } from "../../../../scripts/gen-grpc-proto.mjs";

describe("P4-11: STABLE_METHODS ⊆ RESULT_SCHEMAS の整合", () => {
  it("STABLE_METHODS の全キー(rpc.discover 除く)に対応する RESULT_SCHEMAS のエントリが存在する(stable 昇格時のスキーマ漏れ検出)", () => {
    const schemaKeys = new Set(Object.keys(RESULT_SCHEMAS));
    const missing = Object.keys(STABLE_METHODS)
      .filter((name) => name !== "rpc.discover")
      .filter((name) => !schemaKeys.has(name));
    expect(
      missing,
      `RESULT_SCHEMAS に未登録の stable メソッド: ${missing.join(", ")} — SDK 戻り型が unknown に劣化する。result-schemas.js にスキーマを追加すること。`,
    ).toEqual([]);
  });
});

// P4-12 (R2:SURF-38): gRPC 生成物に stability コメントが正しく伝播するテスト。
//
// generateProto() の戻り値 protoText を直接検査することで、
// sesame.proto の再生成前でも stability コメント伝播ロジックを CI で検証できる。
// schema-drift.test.js の drift テスト(生成物 ↔ ファイル比較)は生成関数を共有しており、
// build 後は自動追従する。
describe("P4-12: gRPC proto に stability コメントが伝播する", () => {
  // generateProto は registry + stability.js を呼ぶ非同期関数
  it("STABLE_METHODS に含まれる op は '// stable' コメントが rpc 宣言直前に付く", async () => {
    const { protoText } = await generateProto();
    const lines = protoText.split("\n");

    // stable として期待するメソッドのサンプル(stability.js の STABLE_METHODS より)。
    // rpc.discover は RpcDiscover として生成されるが events.* は service に含まれない。
    // status は Status, account.whoami は AccountWhoami として pascal 変換される。
    const stableExpected = [
      // (JSON-RPC メソッド名, 期待する rpc Pascal 名)
      ["status", "Status"],
      ["account.whoami", "AccountWhoami"],
      ["lock.lock", "LockLock"],
      ["lock.unlock", "LockUnlock"],
      ["lock.toggle", "LockToggle"],
      ["lock.click", "LockClick"],
      ["lock.status", "LockStatus"],
      ["devices.list", "DevicesList"],
      ["device.history", "DeviceHistory"],
      ["device.battery", "DeviceBattery"],
    ];

    for (const [, pascalName] of stableExpected) {
      // rpc 宣言行を探す
      const rpcLineIdx = lines.findIndex((l) => l.trimStart().startsWith(`rpc ${pascalName} (`));
      expect(
        rpcLineIdx,
        `rpc ${pascalName} が生成 proto に存在しない`,
      ).toBeGreaterThan(-1);

      // 直前行が '  // stable' であること
      const commentLine = lines[rpcLineIdx - 1]?.trim();
      expect(
        commentLine,
        `rpc ${pascalName} の直前行が '// stable' でない(実際: '${commentLine}')`,
      ).toBe("// stable");
    }
  });

  it("STABLE_METHODS に含まれない op は '// experimental (unverified)' コメントが rpc 宣言直前に付く", async () => {
    const { protoText } = await generateProto();
    const lines = protoText.split("\n");

    // experimental として期待するメソッドのサンプル
    const experimentalExpected = [
      ["org.getEmployees", "OrgGetEmployees"],
      ["ble.invoke", "BleInvoke"],
      ["ir.send", "IrSend"],
      ["iot.sendIotCmd", "IotSendIotCmd"],
    ];

    for (const [, pascalName] of experimentalExpected) {
      const rpcLineIdx = lines.findIndex((l) => l.trimStart().startsWith(`rpc ${pascalName} (`));
      expect(
        rpcLineIdx,
        `rpc ${pascalName} が生成 proto に存在しない`,
      ).toBeGreaterThan(-1);

      const commentLine = lines[rpcLineIdx - 1]?.trim();
      expect(
        commentLine,
        `rpc ${pascalName} の直前行が '// experimental (unverified)' でない(実際: '${commentLine}')`,
      ).toBe("// experimental (unverified)");
    }
  });

  it("生成 proto の stable rpc 数は STABLE_METHODS から events と rpc.discover を除いた数と一致する", async () => {
    const { protoText } = await generateProto();
    const lines = protoText.split("\n");

    // proto 内の '// stable' コメント行数を数える
    const stableCommentCount = lines.filter((l) => l.trim() === "// stable").length;

    // STABLE_METHODS から、events.* (service 非掲載) と rpc.discover を除いた数
    const stableInService = Object.keys(STABLE_METHODS).filter(
      (name) => !name.startsWith("events."),
    ).length;

    expect(
      stableCommentCount,
      `生成 proto の '// stable' 行数 (${stableCommentCount}) が STABLE_METHODS の service 掲載数 (${stableInService}) と一致しない`,
    ).toBe(stableInService);
  });
});

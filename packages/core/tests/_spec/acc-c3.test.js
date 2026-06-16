// spec: access.md ACC-0058 〜 ACC-0075 の実行可能単体テスト (統合版: A/B 精査後の最良採用)。
// 対象 spec: 18 件
//   ACC-0058 SDK(ts/py): access.* 11 op の生成シグネチャが core 契約と一致
//   ACC-0059 gRPC 生成契約に access auth-data/register の 4+2 メソッドが存在する
//   ACC-0060 cli access cards ls: --device 正規化(variadic/カンマ連結)→ getCards
//   ACC-0061 cli access cards ls --json: items/byDevice を JSON 封筒で出力
//   ACC-0062 cli access cards rm: --json 必須・配列検証 (exit 2)
//   ACC-0063 cli access cards clear: 対話 confirm 拒否で中止(送信なし)
//   ACC-0064 cli access cards name: 非v4 cardNameUUID で警告 stderr 後に続行
//   ACC-0065 cli access cards owner: ownerSubUUID undefined で必須エラー / '' で解除送信
//   ACC-0066 cli access passcodes post: 空 list で emptyList 表示(null 戻り)
//   ACC-0067 cli access cards enroll: 複数タップ集約 → hub.registerCards 一括登録
//   ACC-0068 cli access passcodes enroll: onKeyBoardReceive 収集 → hub.registerPasscodes
//   ACC-0069 cli enroll: 同一 id 重複排除と 0 件時 enrolled:0 早期return
//   ACC-0070 cli enroll: bioCaps 限定ビューに能力メソッドが無い機種は die(2)
//   ACC-0071 cli enroll: secretKey 欠落/デバイス未発見/BLE 失敗の終了コード
//   ACC-0072 cli access auth-data post: operation/device-id/items 必須検証と die(2)
//   ACC-0073 cli access auth-data put/delete: post と同型の必須検証
//   ACC-0074 cli access auth-data name: kind 省略可、--json で残りフィールド合成
//   ACC-0075 cli auth-data 系の --json 出力封筒 (ctx.out human/json 分岐)
//
// 実行環境: vitest unit project — ネットワーク・実機不使用・全モック

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Command } from "commander";

// ── パス計算 ─────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// このファイルは packages/core/tests/_spec/ に置かれる
const CORE_ROOT = path.resolve(__dirname, "../../");
const REPO_ROOT = path.resolve(CORE_ROOT, "../../");
const KIT_ROOT  = path.resolve(REPO_ROOT, "packages/kit");

// ── 静的アセット (SDK テキスト / gRPC JSON) ──────────────────────────────────
const tsSDK   = readFileSync(path.join(KIT_ROOT, "sdk/ts/sesame-client.ts"), "utf8");
const pySDK   = readFileSync(path.join(KIT_ROOT, "sdk/python/sesame_client.py"), "utf8");
const grpcJson = JSON.parse(
  readFileSync(path.join(KIT_ROOT, "src/serve/grpc-methods.generated.json"), "utf8"),
);

// ── CLI import ────────────────────────────────────────────────────────────────
// このファイルは packages/core/tests/_spec/ に置かれる。
// packages/kit への相対パス: ../../../kit/src/cli/access.js
import { registerAccessCommands } from "../../../kit/src/cli/access.js";
// NAMESPACE_OPS: access.* 11 op 一覧 (core 側でも export されている)
// packages/core/src への相対パス: ../../src/access.js
import { NAMESPACE_OPS } from "../../src/access.js";

// ── 共通ヘルパ ────────────────────────────────────────────────────────────────

/**
 * fake ctx。
 * - out: outputs 配列に jsonObj を積む (json=true 前提)。
 * - die: Error を throw して parseAsync のリジェクション経由でテストへ伝搬。
 * - withHub: fn(hub, {opts:{json}}) を即呼び出す (connect/close を省略)。
 * - parseJson: 本物同様、パース失敗時は die(2)。成功時に値を返す。
 */
function makeCtx({ hub, ble = null, canPrompt = false, json = true } = {}) {
  const outputs = [];
  const ctx = {
    outputs,
    out: (isJson, humanFn, jsonObj) => {
      if (isJson) outputs.push(jsonObj);
      else humanFn();
    },
    die: (msg, code) => {
      const e = new Error(msg);
      e.code = code;
      throw e;
    },
    canPrompt: () => canPrompt,
    withHub: (fn) => fn(hub, { opts: { json } }),
    prompts: {
      promptText:    vi.fn(async () => ""),
      selectFromList: vi.fn(async () => null),
      confirm:       vi.fn(async () => false),
      promptLine:    vi.fn(async () => ""),
    },
    makeBle: () => ble,
    parseJson: (raw, _hint) => {
      try { return JSON.parse(raw); }
      catch (e) {
        const err = new Error(String(e));
        err.code = 2;
        throw err;
      }
    },
  };
  return { ctx, outputs };
}

/** Commander program ファクトリ。exitOverride で parseAsync が throw するようにする。 */
function buildProgram(ctx) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerAccessCommands(program, ctx);
  return program;
}

/** カード enroll 用 fake BLE。cardModeSet(1) で records を delegate.onCardReceive へ流す。 */
function makeFakeBle(records, { failConnect = false, noBiometric = false, noCardModeSet = false } = {}) {
  let delegate = null;
  const calls = [];
  const emit = (r) => { if (delegate?.onCardReceive) delegate.onCardReceive(r.cardID, r.cardName, r.cardType); };
  const bio = noCardModeSet
    ? { registerDelegate: vi.fn(() => () => calls.push(["unsub"])) }
    : {
        registerDelegate(d) { delegate = d; return () => calls.push(["unsub"]); },
        async cardModeSet(mode) {
          calls.push(["cardModeSet", mode]);
          if (mode === 1) for (const r of records) emit(r);
        },
      };
  const obj = {
    calls,
    async connect() { calls.push(["connect"]); if (failConnect) throw new Error("ble down"); },
    async close()   { calls.push(["close"]); },
  };
  if (noBiometric) {
    // Object.defineProperty を使って getter を定義する。
    // スプレッド構文 {...{get biometric(){throw}}} はスプレッド時にゲッタを呼び出すため
    // オブジェクト生成時点で例外が発生してしまう (makeFakeBle 呼び出し側が死ぬ)。
    Object.defineProperty(obj, "biometric", {
      get() { throw new Error("not biometric"); },
      configurable: true,
    });
  } else {
    obj.biometric = bio;
  }
  return obj;
}

/** パスコード enroll 用 fake BLE。passcodeModeSet(1) で delegate.onKeyBoardReceive へ流す。 */
function makeFakePasscodeBle(records, { noPasscodeModeSet = false } = {}) {
  let delegate = null;
  const calls = [];
  const bio = noPasscodeModeSet
    ? { registerDelegate: vi.fn(() => () => calls.push(["unsub"])) }
    : {
        registerDelegate(d) { delegate = d; return () => calls.push(["unsub"]); },
        async passcodeModeSet(mode) {
          calls.push(["passcodeModeSet", mode]);
          if (mode === 1 && delegate?.onKeyBoardReceive) {
            for (const r of records) delegate.onKeyBoardReceive(r.cardID, r.cardName, r.cardType);
          }
        },
      };
  return {
    calls,
    biometric: bio,
    async connect() { calls.push(["connect"]); },
    async close()   { calls.push(["close"]); },
  };
}

/** テスト全体で共用するデバイス定義。 */
const DEV = {
  deviceUUID: "u1",
  secretKey: "00112233445566778899aabbccddeeff",
  deviceModel: "sesame_touch_pro",
};

// ======================================================================
// ACC-0058: SDK(ts/py) access.* 11 op の生成シグネチャが core 契約と一致
// ======================================================================
describe("[ACC-0058] SDK(ts/py): access.* 11 op の生成シグネチャが core 契約と一致", () => {
  const ELEVEN_OPS = NAMESPACE_OPS; // core から輸入

  it("[ACC-0058] ts SDK に access.* 11 op が全て存在する (キー名一致)", () => {
    for (const op of ELEVEN_OPS) {
      expect(tsSDK, `ts SDK に ${op} が無い`).toContain(`${op}:`);
    }
  });

  it("[ACC-0058] ts SDK: getCards は deviceUUIDs: Array<string> パラメタを持つ", () => {
    expect(tsSDK).toMatch(/getCards.*deviceUUIDs.*Array.*string/);
  });

  it("[ACC-0058] ts SDK: postCards は deviceUUID と list を受ける", () => {
    expect(tsSDK).toMatch(/postCards.*deviceUUID.*list/);
  });

  it("[ACC-0058] ts SDK: delCards は items を受ける", () => {
    expect(tsSDK).toMatch(/delCards.*items/);
  });

  it("[ACC-0058] ts SDK: updateCardOwner は item/cardID/ownerSubUUID を受ける (core 互換)", () => {
    expect(tsSDK).toMatch(/updateCardOwner.*item.*cardID.*ownerSubUUID/s);
  });

  it("[ACC-0058] py SDK に access.* 11 op がメソッドとして全て存在する", () => {
    for (const op of ELEVEN_OPS) {
      expect(pySDK, `py SDK に ${op} が無い`).toContain(`def ${op}(`);
    }
  });

  it("[ACC-0058] py SDK: getCards は deviceUUIDs: list[str] を受ける (core params 形一致)", () => {
    expect(pySDK).toMatch(/def getCards.*deviceUUIDs.*list\[str\]/);
  });

  it("[ACC-0058] py SDK: postCards は deviceUUID と list を受ける", () => {
    expect(pySDK).toMatch(/def postCards.*deviceUUID.*list/);
  });

  it("[ACC-0058] py SDK: updateCardOwner は item と ownerSubUUID を受ける", () => {
    expect(pySDK).toContain("def updateCardOwner(self, *, item:");
    expect(pySDK).toContain("ownerSubUUID:");
  });
});

// ======================================================================
// ACC-0059: gRPC 生成契約に access auth-data/register の 4+2 メソッドが存在
// ======================================================================
describe("[ACC-0059] gRPC 生成契約に access auth-data/register の 4+2 メソッドが存在する", () => {
  it("[ACC-0059] grpc-methods.generated.json がパース可能", () => {
    expect(typeof grpcJson).toBe("object");
  });

  it("[ACC-0059] AccessRegisterCards が access.registerCards に配線されている", () => {
    expect(grpcJson["AccessRegisterCards"]).toBeDefined();
    expect(grpcJson["AccessRegisterCards"].method).toBe("access.registerCards");
  });

  it("[ACC-0059] AccessRegisterPasscodes が access.registerPasscodes に配線されている", () => {
    expect(grpcJson["AccessRegisterPasscodes"]).toBeDefined();
    expect(grpcJson["AccessRegisterPasscodes"].method).toBe("access.registerPasscodes");
  });

  it("[ACC-0059] AccessPostAuthenticationData が access.postAuthenticationData に配線されている", () => {
    expect(grpcJson["AccessPostAuthenticationData"]).toBeDefined();
    expect(grpcJson["AccessPostAuthenticationData"].method).toBe("access.postAuthenticationData");
  });

  it("[ACC-0059] AccessPutAuthenticationData が access.putAuthenticationData に配線されている", () => {
    expect(grpcJson["AccessPutAuthenticationData"]).toBeDefined();
    expect(grpcJson["AccessPutAuthenticationData"].method).toBe("access.putAuthenticationData");
  });

  it("[ACC-0059] AccessDeleteAuthenticationData が access.deleteAuthenticationData に配線されている", () => {
    expect(grpcJson["AccessDeleteAuthenticationData"]).toBeDefined();
    expect(grpcJson["AccessDeleteAuthenticationData"].method).toBe("access.deleteAuthenticationData");
  });

  it("[ACC-0059] AccessUpdateAuthenticationName が access.updateAuthenticationName に配線されている", () => {
    expect(grpcJson["AccessUpdateAuthenticationName"]).toBeDefined();
    expect(grpcJson["AccessUpdateAuthenticationName"].method).toBe("access.updateAuthenticationName");
  });
});

// ======================================================================
// ACC-0060: cli access cards ls --device 正規化 → getCards
// ======================================================================
describe("[ACC-0060] cli access cards ls: --device 正規化(variadic/カンマ連結)→ getCards", () => {
  it("[ACC-0060] --device にカンマ連結文字列を渡すと分解して配列になる", async () => {
    const getCards = vi.fn(async () => ({ items: [], byDevice: {} }));
    const hub = { access: { getCards }, listDevices: vi.fn(async () => []) };
    const { ctx } = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["access", "cards", "ls", "--device", "uuid-A,uuid-B"],
      { from: "user" },
    );
    expect(getCards).toHaveBeenCalledWith(
      expect.objectContaining({ deviceUUIDs: ["uuid-A", "uuid-B"] }),
    );
  });

  it("[ACC-0060] --device variadic(複数フラグ)で渡すと全て配列に入る", async () => {
    const getCards = vi.fn(async () => ({ items: [], byDevice: {} }));
    const hub = { access: { getCards }, listDevices: vi.fn(async () => []) };
    const { ctx } = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["access", "cards", "ls", "--device", "uuid-A", "--device", "uuid-B"],
      { from: "user" },
    );
    expect(getCards).toHaveBeenCalledWith(
      expect.objectContaining({ deviceUUIDs: expect.arrayContaining(["uuid-A", "uuid-B"]) }),
    );
  });

  it("[ACC-0060] --device に単一 UUID を渡すと getCards が deviceUUIDs に配列で届く", async () => {
    const getCards = vi.fn(async () => ({ items: [], byDevice: {} }));
    const hub = { access: { getCards }, listDevices: vi.fn(async () => []) };
    const { ctx } = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["access", "cards", "ls", "--device", "uuid-A"],
      { from: "user" },
    );
    expect(getCards).toHaveBeenCalledWith(
      expect.objectContaining({ deviceUUIDs: ["uuid-A"] }),
    );
  });

  it("[ACC-0060] --device 未指定かつ非対話(canPrompt=false)なら die(2) して getCards を呼ばない", async () => {
    const getCards = vi.fn();
    const hub = { access: { getCards }, listDevices: vi.fn(async () => []) };
    const { ctx } = makeCtx({ hub, canPrompt: false });
    await expect(
      buildProgram(ctx).parseAsync(["access", "cards", "ls"], { from: "user" }),
    ).rejects.toMatchObject({ code: 2 });
    expect(getCards).not.toHaveBeenCalled();
  });
});

// ======================================================================
// ACC-0061: cli access cards ls --json: items/byDevice を JSON 封筒で出力
// ======================================================================
describe("[ACC-0061] cli access cards ls --json: items/byDevice を JSON 封筒で出力", () => {
  it("[ACC-0061] --json 時は {ok,count,items,byDevice} を出力する", async () => {
    const fakeItems = [{ cardID: "C1", name: "Card1", cardType: 1, uuids: ["u1"] }];
    const fakeByDevice = { u1: fakeItems };
    const hub = {
      access: { getCards: vi.fn(async () => ({ items: fakeItems, byDevice: fakeByDevice })) },
      listDevices: vi.fn(),
    };
    const { ctx, outputs } = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["access", "cards", "ls", "--device", "u1"],
      { from: "user" },
    );
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      ok: true,
      count: 1,
      items: fakeItems,
      byDevice: fakeByDevice,
    });
  });

  it("[ACC-0061] 0 件の場合も ok:true で count:0、items:[]、byDevice:{} を返す", async () => {
    const hub = {
      access: { getCards: vi.fn(async () => ({ items: [], byDevice: {} })) },
      listDevices: vi.fn(),
    };
    const { ctx, outputs } = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["access", "cards", "ls", "--device", "u1"],
      { from: "user" },
    );
    expect(outputs[0]).toMatchObject({ ok: true, count: 0, items: [], byDevice: {} });
  });
});

// ======================================================================
// ACC-0062: cli access cards rm: --json 必須・配列検証 (exit 2)
// ======================================================================
describe("[ACC-0062] cli access cards rm: --json 必須・配列検証 (exit 2)", () => {
  it("[ACC-0062] --json 欠落で die(2) し delCards を呼ばない", async () => {
    const hub = { access: { delCards: vi.fn() } };
    const { ctx } = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(["access", "cards", "rm"], { from: "user" }),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.access.delCards).not.toHaveBeenCalled();
  });

  it("[ACC-0062] --json に非配列 JSON を渡すと die(2) し delCards を呼ばない", async () => {
    const hub = { access: { delCards: vi.fn() } };
    const { ctx } = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(
        ["access", "cards", "rm", "--json", '{"not":"array"}'],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.access.delCards).not.toHaveBeenCalled();
  });

  it("[ACC-0062] --json に有効な配列を渡すと delCards を呼び sent boolean を反映する", async () => {
    const items = [{ deviceID: "d1", cardID: "c1" }];
    const hub = { access: { delCards: vi.fn(() => true) } };
    const { ctx, outputs } = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["access", "cards", "rm", "--json", JSON.stringify(items)],
      { from: "user" },
    );
    expect(hub.access.delCards).toHaveBeenCalledWith(expect.objectContaining({ items }));
    expect(outputs[0]).toMatchObject({ ok: true, sent: true });
  });

  it("[ACC-0062] 空配列を渡すと delCards が false を返し sent:false になる", async () => {
    const hub = { access: { delCards: vi.fn(() => false) } };
    const { ctx, outputs } = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["access", "cards", "rm", "--json", "[]"],
      { from: "user" },
    );
    expect(outputs[0]).toMatchObject({ ok: true, sent: false });
  });
});

// ======================================================================
// ACC-0063: cli access cards clear: 対話 confirm 拒否で中止(送信なし)
// ======================================================================
describe("[ACC-0063] cli access cards clear: 対話 confirm 拒否で中止(送信なし)", () => {
  it("[ACC-0063] 対話可能・confirm 拒否(false) → clearCards 呼ばない", async () => {
    const hub = { access: { clearCards: vi.fn() }, listDevices: vi.fn() };
    const { ctx } = makeCtx({ hub, canPrompt: true });
    ctx.prompts.confirm.mockResolvedValue(false);
    await buildProgram(ctx).parseAsync(
      ["access", "cards", "clear", "--device", "u1"],
      { from: "user" },
    );
    expect(hub.access.clearCards).not.toHaveBeenCalled();
  });

  it("[ACC-0063] 対話可能・confirm 承認(true) → clearCards を呼ぶ", async () => {
    const hub = {
      access: { clearCards: vi.fn(async () => ({ ok: true })) },
      listDevices: vi.fn(),
    };
    const { ctx } = makeCtx({ hub, canPrompt: true });
    ctx.prompts.confirm.mockResolvedValue(true);
    await buildProgram(ctx).parseAsync(
      ["access", "cards", "clear", "--device", "u1"],
      { from: "user" },
    );
    expect(hub.access.clearCards).toHaveBeenCalledWith(
      expect.objectContaining({ deviceUUID: "u1" }),
    );
  });

  it("[ACC-0063] 非対話(canPrompt=false) → confirm なしで clearCards を呼ぶ", async () => {
    const hub = {
      access: { clearCards: vi.fn(async () => null) },
      listDevices: vi.fn(),
    };
    const { ctx } = makeCtx({ hub, canPrompt: false });
    await buildProgram(ctx).parseAsync(
      ["access", "cards", "clear", "--device", "u1"],
      { from: "user" },
    );
    expect(hub.access.clearCards).toHaveBeenCalledTimes(1);
    expect(ctx.prompts.confirm).not.toHaveBeenCalled();
  });
});

// ======================================================================
// ACC-0064: cli access cards name: 非v4 cardNameUUID で警告 stderr 後に続行
// ======================================================================
describe("[ACC-0064] cli access cards name: 非v4 cardNameUUID で警告 stderr 後に続行", () => {
  it("[ACC-0064] --json 欠落で die(2) し updateCardName を呼ばない", async () => {
    const hub = { access: { updateCardName: vi.fn() } };
    const { ctx } = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(["access", "cards", "name"], { from: "user" }),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.access.updateCardName).not.toHaveBeenCalled();
  });

  it("[ACC-0064] v4 UUID なら警告なしで updateCardName を呼ぶ", async () => {
    const hub = { access: { updateCardName: vi.fn(async () => ({ ok: true })) } };
    const { ctx } = makeCtx({ hub, json: true });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const item = { cardNameUUID: "550e8400-e29b-41d4-a716-446655440000", cardID: "C1" };
    try {
      await buildProgram(ctx).parseAsync(
        ["access", "cards", "name", "--json", JSON.stringify(item)],
        { from: "user" },
      );
    } finally {
      stderrSpy.mockRestore();
    }
    expect(hub.access.updateCardName).toHaveBeenCalledWith(expect.objectContaining({ item }));
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("[ACC-0064] 非v4 UUID なら stderr 警告を出すが updateCardName は呼ばれる (処理継続)", async () => {
    const hub = { access: { updateCardName: vi.fn(async () => ({ ok: true })) } };
    const { ctx } = makeCtx({ hub, json: true });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // v1 形式: version nibble が 1
    const nonV4UUID = "550e8400-e29b-11d4-a716-446655440000";
    const item = { cardNameUUID: nonV4UUID, cardID: "C2" };
    try {
      await buildProgram(ctx).parseAsync(
        ["access", "cards", "name", "--json", JSON.stringify(item)],
        { from: "user" },
      );
      // mock.calls を mockRestore() の前に検証する (mockRestore は mock.calls をリセットするため)
      expect(stderrSpy).toHaveBeenCalled();
      expect(stderrSpy.mock.calls[0][0]).toMatch(/Warning/);
      expect(stderrSpy.mock.calls[0][0]).toMatch(nonV4UUID);
      expect(hub.access.updateCardName).toHaveBeenCalledTimes(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("[ACC-0064] item.nameUUID も cardNameUUID と同じ非v4 判定パスを使う (フォールバック)", async () => {
    const hub = { access: { updateCardName: vi.fn(async () => ({})) } };
    const { ctx } = makeCtx({ hub, json: true });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const item = { nameUUID: "550e8400-e29b-11d4-a716-446655440000", cardID: "C3" };
    try {
      await buildProgram(ctx).parseAsync(
        ["access", "cards", "name", "--json", JSON.stringify(item)],
        { from: "user" },
      );
      // mock.calls を mockRestore() の前に検証する (mockRestore は mock.calls をリセットするため)
      expect(stderrSpy).toHaveBeenCalled();
      expect(hub.access.updateCardName).toHaveBeenCalledTimes(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// ======================================================================
// ACC-0065: cli access cards owner: ownerSubUUID undefined で必須エラー / '' で解除送信
// ======================================================================
describe("[ACC-0065] cli access cards owner: ownerSubUUID undefined で必須エラー / '' で解除送信", () => {
  it("[ACC-0065] ownerSubUUID 省略かつ非対話 → die(2) して updateCardOwner を呼ばない", async () => {
    const hub = { access: { updateCardOwner: vi.fn() } };
    const { ctx } = makeCtx({ hub, canPrompt: false });
    await expect(
      buildProgram(ctx).parseAsync(
        ["access", "cards", "owner", "card-id-1"],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.access.updateCardOwner).not.toHaveBeenCalled();
  });

  it("[ACC-0065] ownerSubUUID='' (空文字) → updateCardOwner を呼ぶ (未割当解除)", async () => {
    const hub = { access: { updateCardOwner: vi.fn(async () => ({ ok: true })) } };
    const { ctx } = makeCtx({ hub, canPrompt: false });
    await buildProgram(ctx).parseAsync(
      ["access", "cards", "owner", "card-id-1", ""],
      { from: "user" },
    );
    expect(hub.access.updateCardOwner).toHaveBeenCalledWith(
      expect.objectContaining({ cardID: "card-id-1", ownerSubUUID: "" }),
    );
  });

  it("[ACC-0065] ownerSubUUID に通常値を渡すと updateCardOwner を呼ぶ", async () => {
    const hub = { access: { updateCardOwner: vi.fn(async () => ({ ok: true })) } };
    const { ctx } = makeCtx({ hub, canPrompt: false });
    await buildProgram(ctx).parseAsync(
      ["access", "cards", "owner", "card-id-1", "sub-uuid-123"],
      { from: "user" },
    );
    expect(hub.access.updateCardOwner).toHaveBeenCalledWith(
      expect.objectContaining({ cardID: "card-id-1", ownerSubUUID: "sub-uuid-123" }),
    );
  });

  it("[ACC-0065] 対話時 ownerSubUUID 省略 → promptText を呼んで値を使う (die しない)", async () => {
    const hub = { access: { updateCardOwner: vi.fn(async () => ({})) } };
    const { ctx } = makeCtx({ hub, canPrompt: true });
    ctx.prompts.promptText.mockResolvedValue("prompted-owner");
    await buildProgram(ctx).parseAsync(
      ["access", "cards", "owner", "card-id-1"],
      { from: "user" },
    );
    expect(ctx.prompts.promptText).toHaveBeenCalled();
    expect(hub.access.updateCardOwner).toHaveBeenCalledWith(
      expect.objectContaining({ ownerSubUUID: "prompted-owner" }),
    );
  });
});

// ======================================================================
// ACC-0066: cli access passcodes post: 空 list で emptyList 表示(null 戻り)
// ======================================================================
describe("[ACC-0066] cli access passcodes post: 空 list で emptyList 表示(null 戻り)", () => {
  it("[ACC-0066] --json 欠落で die(2) し postPasscodes を呼ばない", async () => {
    const hub = { access: { postPasscodes: vi.fn() }, listDevices: vi.fn() };
    const { ctx } = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(
        ["access", "passcodes", "post", "--device", "u1"],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.access.postPasscodes).not.toHaveBeenCalled();
  });

  it("[ACC-0066] --json に非配列 JSON を渡すと die(2) し postPasscodes を呼ばない", async () => {
    const hub = { access: { postPasscodes: vi.fn() }, listDevices: vi.fn() };
    const { ctx } = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(
        ["access", "passcodes", "post", "--device", "u1", "--json", '"notarray"'],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.access.postPasscodes).not.toHaveBeenCalled();
  });

  it("[ACC-0066] postPasscodes が null を返す(list 空) → 出力封筒に ok:true と count:0 が入る", async () => {
    // core: list.length < 1 で null を返す。CLI はその null を emptyList 分岐として扱う。
    const hub = {
      access: { postPasscodes: vi.fn(async () => null) },
      listDevices: vi.fn(),
    };
    const { ctx, outputs } = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["access", "passcodes", "post", "--device", "u1", "--json", "[]"],
      { from: "user" },
    );
    expect(hub.access.postPasscodes).toHaveBeenCalledWith(
      expect.objectContaining({ deviceUUID: "u1", list: [] }),
    );
    expect(outputs[0]).toMatchObject({ ok: true, deviceUUID: "u1", count: 0 });
    // response は null (emptyList パス)
    expect(outputs[0].response).toBeNull();
  });

  it("[ACC-0066] list 非空なら postPasscodes を呼び ok:true を出力する", async () => {
    const list = [{ passwordID: "p1", name: "pin1", nameUUID: "550e8400-e29b-41d4-a716-446655440000" }];
    const hub = {
      access: { postPasscodes: vi.fn(async () => ({ ok: true })) },
      listDevices: vi.fn(),
    };
    const { ctx, outputs } = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["access", "passcodes", "post", "--device", "u1", "--json", JSON.stringify(list)],
      { from: "user" },
    );
    expect(hub.access.postPasscodes).toHaveBeenCalledWith(
      expect.objectContaining({ deviceUUID: "u1", list }),
    );
    expect(outputs[0]).toMatchObject({ ok: true, count: 1 });
  });
});

// ======================================================================
// ACC-0067: cli access cards enroll: 複数タップ集約 → hub.registerCards 一括登録
// ======================================================================
describe("[ACC-0067] cli access cards enroll: 複数タップ集約 → hub.registerCards 一括登録", () => {
  it("[ACC-0067] BLE cardModeSet(1)→collect→cardModeSet(0)→unsub の順で registerCards を呼ぶ", async () => {
    const hub = {
      listDevices: vi.fn(async () => [DEV]),
      registerCards: vi.fn(async (uuid, cards) => ({ ok: true, count: cards.length })),
    };
    const ble = makeFakeBle([
      { cardID: "AA11", cardName: "n1", cardType: 1 },
      { cardID: "BB22", cardName: "n2", cardType: 0 },
    ]);
    const { ctx, outputs } = makeCtx({ hub, ble, canPrompt: true });
    await buildProgram(ctx).parseAsync(
      ["access", "cards", "enroll", "--device", "u1"],
      { from: "user" },
    );
    expect(ble.calls).toContainEqual(["cardModeSet", 1]);
    expect(ble.calls).toContainEqual(["cardModeSet", 0]);
    expect(ble.calls).toContainEqual(["close"]);
    expect(hub.registerCards).toHaveBeenCalledTimes(1);
    expect(hub.registerCards).toHaveBeenCalledWith("u1", [
      { cardID: "AA11", cardName: "n1", cardType: 1 },
      { cardID: "BB22", cardName: "n2", cardType: 0 },
    ]);
    expect(outputs[0]).toMatchObject({ ok: true, enrolled: 2, deviceUUID: "u1" });
  });

  it("[ACC-0067] cardModeSet(0) の後に unsub が来る (取りこぼし防止順序)", async () => {
    const hub = {
      listDevices: vi.fn(async () => [DEV]),
      registerCards: vi.fn(async () => ({ ok: true })),
    };
    const ble = makeFakeBle([{ cardID: "AA11", cardName: "n1", cardType: 1 }]);
    const { ctx } = makeCtx({ hub, ble, canPrompt: true });
    await buildProgram(ctx).parseAsync(
      ["access", "cards", "enroll", "--device", "u1"],
      { from: "user" },
    );
    const modeOnIdx  = ble.calls.findIndex((c) => c[0] === "cardModeSet" && c[1] === 1);
    const modeOffIdx = ble.calls.findIndex((c) => c[0] === "cardModeSet" && c[1] === 0);
    const unsubIdx   = ble.calls.findIndex((c) => c[0] === "unsub");
    expect(modeOnIdx).toBeGreaterThanOrEqual(0);
    expect(modeOffIdx).toBeGreaterThan(modeOnIdx);
    expect(unsubIdx).toBeGreaterThan(modeOffIdx);
  });
});

// ======================================================================
// ACC-0068: cli access passcodes enroll: onKeyBoardReceive 収集 → hub.registerPasscodes
// ======================================================================
describe("[ACC-0068] cli access passcodes enroll: onKeyBoardReceive 収集 → hub.registerPasscodes", () => {
  it("[ACC-0068] passcodeModeSet(1)→onKeyBoardReceive 収集→registerPasscodes を呼ぶ (cards enroll と対称)", async () => {
    const hub = {
      listDevices: vi.fn(async () => [DEV]),
      registerPasscodes: vi.fn(async (uuid, records) => ({ ok: true, count: records.length })),
    };
    const ble = makeFakePasscodeBle([
      { cardID: "1234", cardName: "31323334", cardType: 0 },
      { cardID: "5678", cardName: "35363738", cardType: 0 },
    ]);
    const { ctx, outputs } = makeCtx({ hub, ble, canPrompt: true });
    await buildProgram(ctx).parseAsync(
      ["access", "passcodes", "enroll", "--device", "u1"],
      { from: "user" },
    );
    expect(ble.calls).toContainEqual(["passcodeModeSet", 1]);
    expect(ble.calls).toContainEqual(["passcodeModeSet", 0]);
    expect(ble.calls).toContainEqual(["close"]);
    expect(hub.registerPasscodes).toHaveBeenCalledTimes(1);
    expect(hub.registerPasscodes).toHaveBeenCalledWith("u1", [
      { cardID: "1234", cardName: "31323334", cardType: 0 },
      { cardID: "5678", cardName: "35363738", cardType: 0 },
    ]);
    expect(outputs[0]).toMatchObject({ ok: true, enrolled: 2, deviceUUID: "u1" });
  });

  it("[ACC-0068] passcodeModeSet(0) の後に unsub が来る (取りこぼし防止順序)", async () => {
    const hub = {
      listDevices: vi.fn(async () => [DEV]),
      registerPasscodes: vi.fn(async () => ({ ok: true })),
    };
    const ble = makeFakePasscodeBle([{ cardID: "1234", cardName: "n", cardType: 0 }]);
    const { ctx } = makeCtx({ hub, ble, canPrompt: true });
    await buildProgram(ctx).parseAsync(
      ["access", "passcodes", "enroll", "--device", "u1"],
      { from: "user" },
    );
    const modeOffIdx = ble.calls.findIndex((c) => c[0] === "passcodeModeSet" && c[1] === 0);
    const unsubIdx   = ble.calls.findIndex((c) => c[0] === "unsub");
    expect(modeOffIdx).toBeGreaterThanOrEqual(0);
    expect(unsubIdx).toBeGreaterThan(modeOffIdx);
  });
});

// ======================================================================
// ACC-0069: cli enroll: 同一 id 重複排除と 0 件時 enrolled:0 早期return
// ======================================================================
describe("[ACC-0069] cli enroll: 同一 id 重複排除と 0 件時 enrolled:0 早期 return", () => {
  it("[ACC-0069] 同一 cardID は重複排除される (cards enroll)", async () => {
    const hub = {
      listDevices: vi.fn(async () => [DEV]),
      registerCards: vi.fn(async () => ({ ok: true })),
    };
    const ble = makeFakeBle([
      { cardID: "AA11", cardName: "n1",     cardType: 1 },
      { cardID: "AA11", cardName: "n1-dup", cardType: 1 },
    ]);
    const { ctx } = makeCtx({ hub, ble, canPrompt: true });
    await buildProgram(ctx).parseAsync(
      ["access", "cards", "enroll", "--device", "u1"],
      { from: "user" },
    );
    expect(hub.registerCards.mock.calls[0][1]).toHaveLength(1);
  });

  it("[ACC-0069] 0 件なら registerCards を呼ばず enrolled:0 を出力する (cards enroll)", async () => {
    const hub = {
      listDevices: vi.fn(async () => [DEV]),
      registerCards: vi.fn(),
    };
    const ble = makeFakeBle([]);
    const { ctx, outputs } = makeCtx({ hub, ble, canPrompt: true });
    await buildProgram(ctx).parseAsync(
      ["access", "cards", "enroll", "--device", "u1"],
      { from: "user" },
    );
    expect(hub.registerCards).not.toHaveBeenCalled();
    expect(outputs[0]).toMatchObject({ ok: true, enrolled: 0, deviceUUID: "u1" });
  });

  it("[ACC-0069] 同一 cardID は重複排除される (passcodes enroll)", async () => {
    const hub = {
      listDevices: vi.fn(async () => [DEV]),
      registerPasscodes: vi.fn(async () => ({ ok: true })),
    };
    const ble = makeFakePasscodeBle([
      { cardID: "1111", cardName: "n1",     cardType: 0 },
      { cardID: "1111", cardName: "n1-dup", cardType: 0 },
    ]);
    const { ctx } = makeCtx({ hub, ble, canPrompt: true });
    await buildProgram(ctx).parseAsync(
      ["access", "passcodes", "enroll", "--device", "u1"],
      { from: "user" },
    );
    expect(hub.registerPasscodes.mock.calls[0][1]).toHaveLength(1);
  });

  it("[ACC-0069] 0 件なら registerPasscodes を呼ばず enrolled:0 を出力する (passcodes enroll)", async () => {
    const hub = {
      listDevices: vi.fn(async () => [DEV]),
      registerPasscodes: vi.fn(),
    };
    const ble = makeFakePasscodeBle([]);
    const { ctx, outputs } = makeCtx({ hub, ble, canPrompt: true });
    await buildProgram(ctx).parseAsync(
      ["access", "passcodes", "enroll", "--device", "u1"],
      { from: "user" },
    );
    expect(hub.registerPasscodes).not.toHaveBeenCalled();
    expect(outputs[0]).toMatchObject({ ok: true, enrolled: 0 });
  });
});

// ======================================================================
// ACC-0070: cli enroll: bioCaps 限定ビューに能力メソッドが無い機種は die(2)
// ======================================================================
describe("[ACC-0070] cli enroll: bioCaps 限定ビューに能力メソッドが無い機種は die(2)", () => {
  it("[ACC-0070] biometric ゲッタが throw する機種 → die(2) (cards enroll)", async () => {
    const hub = { listDevices: vi.fn(async () => [DEV]), registerCards: vi.fn() };
    const ble = makeFakeBle([], { noBiometric: true });
    const { ctx } = makeCtx({ hub, ble, canPrompt: false });
    await expect(
      buildProgram(ctx).parseAsync(
        ["access", "cards", "enroll", "--device", "u1"],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.registerCards).not.toHaveBeenCalled();
  });

  it("[ACC-0070] biometric は生えるが cardModeSet が無い → die(2) (cards enroll)", async () => {
    const hub = { listDevices: vi.fn(async () => [DEV]), registerCards: vi.fn() };
    const ble = makeFakeBle([], { noCardModeSet: true });
    const { ctx } = makeCtx({ hub, ble, canPrompt: false });
    await expect(
      buildProgram(ctx).parseAsync(
        ["access", "cards", "enroll", "--device", "u1"],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.registerCards).not.toHaveBeenCalled();
  });

  it("[ACC-0070] biometric は生えるが passcodeModeSet が無い → die(2) (passcodes enroll)", async () => {
    const hub = { listDevices: vi.fn(async () => [DEV]), registerPasscodes: vi.fn() };
    const ble = makeFakePasscodeBle([], { noPasscodeModeSet: true });
    const { ctx } = makeCtx({ hub, ble, canPrompt: false });
    await expect(
      buildProgram(ctx).parseAsync(
        ["access", "passcodes", "enroll", "--device", "u1"],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.registerPasscodes).not.toHaveBeenCalled();
  });
});

// ======================================================================
// ACC-0071: cli enroll: secretKey 欠落/デバイス未発見/BLE 失敗の終了コード
// ======================================================================
describe("[ACC-0071] cli enroll: secretKey 欠落/デバイス未発見/BLE 失敗の終了コード", () => {
  it("[ACC-0071] クラウド一覧にデバイスが無い → die(2) (deviceNotFound)", async () => {
    const hub = { listDevices: vi.fn(async () => []), registerCards: vi.fn() };
    const ble = makeFakeBle([]);
    const { ctx } = makeCtx({ hub, ble, canPrompt: false });
    await expect(
      buildProgram(ctx).parseAsync(
        ["access", "cards", "enroll", "--device", "u1"],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.registerCards).not.toHaveBeenCalled();
  });

  it("[ACC-0071] secretKey が無いデバイス → die(2) (noSecretKey)", async () => {
    const hub = {
      listDevices: vi.fn(async () => [
        { deviceUUID: "u1", deviceModel: "sesame_touch_pro" }, // secretKey なし
      ]),
      registerCards: vi.fn(),
    };
    const ble = makeFakeBle([]);
    const { ctx } = makeCtx({ hub, ble, canPrompt: false });
    await expect(
      buildProgram(ctx).parseAsync(
        ["access", "cards", "enroll", "--device", "u1"],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.registerCards).not.toHaveBeenCalled();
  });

  it("[ACC-0071] BLE connect 失敗 → die(1) (bleFailed)", async () => {
    const hub = { listDevices: vi.fn(async () => [DEV]), registerCards: vi.fn() };
    const ble = makeFakeBle([], { failConnect: true });
    const { ctx } = makeCtx({ hub, ble, canPrompt: false });
    await expect(
      buildProgram(ctx).parseAsync(
        ["access", "cards", "enroll", "--device", "u1"],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 1 });
    expect(hub.registerCards).not.toHaveBeenCalled();
  });
});

// ======================================================================
// ACC-0072: cli access auth-data post: operation/device-id/items 必須検証と die(2)
// ======================================================================
describe("[ACC-0072] cli access auth-data post: operation/device-id/items 必須検証と die(2)", () => {
  it("[ACC-0072] --operation 欠落で die(2)", async () => {
    const hub = { postAuthenticationData: vi.fn() };
    const { ctx } = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(
        ["access", "auth-data", "post", "--device-id", "d1", "--items", "[]"],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.postAuthenticationData).not.toHaveBeenCalled();
  });

  it("[ACC-0072] --device-id 欠落で die(2)", async () => {
    const hub = { postAuthenticationData: vi.fn() };
    const { ctx } = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(
        ["access", "auth-data", "post", "--operation", "nfc_card", "--items", "[]"],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.postAuthenticationData).not.toHaveBeenCalled();
  });

  it("[ACC-0072] --items 欠落で die(2)", async () => {
    const hub = { postAuthenticationData: vi.fn() };
    const { ctx } = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(
        ["access", "auth-data", "post", "--operation", "nfc_card", "--device-id", "d1"],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.postAuthenticationData).not.toHaveBeenCalled();
  });

  it("[ACC-0072] --items が非配列 JSON で die(2)", async () => {
    const hub = { postAuthenticationData: vi.fn() };
    const { ctx } = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(
        ["access", "auth-data", "post", "--operation", "nfc_card", "--device-id", "d1", "--items", '"notarray"'],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.postAuthenticationData).not.toHaveBeenCalled();
  });

  it("[ACC-0072] 全て揃えば hub.postAuthenticationData を呼ぶ", async () => {
    const hub = { postAuthenticationData: vi.fn(async () => ({ items: [] })) };
    const { ctx, outputs } = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["access", "auth-data", "post",
        "--operation", "nfc_card",
        "--device-id", "device-123",
        "--items", "[]"],
      { from: "user" },
    );
    expect(hub.postAuthenticationData).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "nfc_card", deviceID: "device-123", items: [] }),
    );
    expect(outputs[0]).toMatchObject({ ok: true, operation: "nfc_card", deviceID: "device-123" });
  });
});

// ======================================================================
// ACC-0073: cli access auth-data put/delete: post と同型の必須検証
// ======================================================================
describe("[ACC-0073] cli access auth-data put/delete: post と同型の必須検証", () => {
  it("[ACC-0073] put: --operation 欠落で die(2)", async () => {
    const hub = { putAuthenticationData: vi.fn() };
    const { ctx } = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(
        ["access", "auth-data", "put", "--device-id", "d1", "--items", "[]"],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.putAuthenticationData).not.toHaveBeenCalled();
  });

  it("[ACC-0073] put: items が非配列で die(2)", async () => {
    const hub = { putAuthenticationData: vi.fn() };
    const { ctx } = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(
        ["access", "auth-data", "put",
          "--operation", "nfc_card",
          "--device-id", "d1",
          "--items", '"scalar"'],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.putAuthenticationData).not.toHaveBeenCalled();
  });

  it("[ACC-0073] put: 全て揃えば hub.putAuthenticationData を呼ぶ", async () => {
    const hub = { putAuthenticationData: vi.fn(async () => ({ items: [] })) };
    const { ctx, outputs } = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["access", "auth-data", "put",
        "--operation", "nfc_card",
        "--device-id", "device-123",
        "--items", "[]"],
      { from: "user" },
    );
    expect(hub.putAuthenticationData).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "nfc_card", deviceID: "device-123", items: [] }),
    );
    expect(outputs[0]).toMatchObject({ ok: true, operation: "nfc_card", deviceID: "device-123" });
  });

  it("[ACC-0073] delete: --operation 欠落で die(2)", async () => {
    const hub = { deleteAuthenticationData: vi.fn() };
    const { ctx } = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(
        ["access", "auth-data", "delete", "--device-id", "d1", "--items", "[]"],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.deleteAuthenticationData).not.toHaveBeenCalled();
  });

  it("[ACC-0073] delete: items が非配列で die(2)", async () => {
    const hub = { deleteAuthenticationData: vi.fn() };
    const { ctx } = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(
        ["access", "auth-data", "delete",
          "--operation", "nfc_card",
          "--device-id", "d1",
          "--items", '"scalar"'],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.deleteAuthenticationData).not.toHaveBeenCalled();
  });

  it("[ACC-0073] delete: 全て揃えば hub.deleteAuthenticationData を呼ぶ", async () => {
    const hub = { deleteAuthenticationData: vi.fn(async () => ({ items: [] })) };
    const { ctx, outputs } = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["access", "auth-data", "delete",
        "--operation", "nfc_card",
        "--device-id", "device-123",
        "--items", "[]"],
      { from: "user" },
    );
    expect(hub.deleteAuthenticationData).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "nfc_card", deviceID: "device-123", items: [] }),
    );
    expect(outputs[0]).toMatchObject({ ok: true, operation: "nfc_card", deviceID: "device-123" });
  });
});

// ======================================================================
// ACC-0074: cli access auth-data name: kind 省略可、--json で残りフィールド合成
// ======================================================================
describe("[ACC-0074] cli access auth-data name: kind 省略可、--json で残りフィールド合成", () => {
  it("[ACC-0074] --kind と --json を指定すると {kind, ...extra} で updateAuthenticationName を呼ぶ", async () => {
    const hub = { updateAuthenticationName: vi.fn(async () => ({ ok: true })) };
    const { ctx, outputs } = makeCtx({ hub, json: true });
    const extra = { cardID: "C1", name: "MyCard", stpDeviceUUID: "u1" };
    await buildProgram(ctx).parseAsync(
      ["access", "auth-data", "name", "--kind", "card", "--json", JSON.stringify(extra)],
      { from: "user" },
    );
    expect(hub.updateAuthenticationName).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "card", cardID: "C1", name: "MyCard" }),
    );
    expect(outputs[0]).toMatchObject({ ok: true, kind: "card" });
  });

  it("[ACC-0074] kind 省略・--json に request ごと入れても動く (kind 無し = request 直指定パス)", async () => {
    const hub = { updateAuthenticationName: vi.fn(async () => ({ ok: true })) };
    const { ctx, outputs } = makeCtx({ hub, json: true });
    const request = { op: "nfc_card_putname", cardID: "C2", name: "X" };
    await buildProgram(ctx).parseAsync(
      ["access", "auth-data", "name", "--json", JSON.stringify({ request })],
      { from: "user" },
    );
    expect(hub.updateAuthenticationName).toHaveBeenCalledWith(
      expect.objectContaining({ request }),
    );
    // kind は undefined → CLI は null として出力する
    expect(outputs[0]).toMatchObject({ ok: true, kind: null });
  });

  it("[ACC-0074] --json 無しなら {} を extra として合成する (kind のみ渡せる)", async () => {
    const hub = { updateAuthenticationName: vi.fn(async () => ({ ok: true })) };
    const { ctx } = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["access", "auth-data", "name", "--kind", "face"],
      { from: "user" },
    );
    expect(hub.updateAuthenticationName).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "face" }),
    );
  });

  it("[ACC-0074] kind 省略時の updateAuthenticationName 呼び出しで params.kind は null", async () => {
    const hub = { updateAuthenticationName: vi.fn(async () => ({})) };
    const { ctx } = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["access", "auth-data", "name"],
      { from: "user" },
    );
    const callArg = hub.updateAuthenticationName.mock.calls[0][0];
    expect(callArg.kind == null).toBe(true);
  });
});

// ======================================================================
// ACC-0075: cli auth-data 系の --json 出力封筒 (ctx.out human/json 分岐)
// ======================================================================
describe("[ACC-0075] cli auth-data 系の --json 出力封筒 (ctx.out human/json 分岐)", () => {
  it("[ACC-0075] auth-data post: {ok,operation,deviceID,response} 封筒", async () => {
    const hub = { postAuthenticationData: vi.fn(async () => ({ items: [1] })) };
    const { ctx, outputs } = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["access", "auth-data", "post",
        "--operation", "nfc_card",
        "--device-id", "device-xyz",
        "--items", "[]"],
      { from: "user" },
    );
    expect(outputs[0]).toMatchObject({ ok: true, operation: "nfc_card", deviceID: "device-xyz" });
    expect(outputs[0]).toHaveProperty("response");
  });

  it("[ACC-0075] auth-data put: {ok,operation,deviceID,response} 封筒", async () => {
    const hub = { putAuthenticationData: vi.fn(async () => ({ items: [] })) };
    const { ctx, outputs } = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["access", "auth-data", "put",
        "--operation", "nfc_card",
        "--device-id", "device-xyz",
        "--items", "[]"],
      { from: "user" },
    );
    expect(outputs[0]).toMatchObject({ ok: true, operation: "nfc_card", deviceID: "device-xyz" });
    expect(outputs[0]).toHaveProperty("response");
  });

  it("[ACC-0075] auth-data delete: {ok,operation,deviceID,response} 封筒", async () => {
    const hub = { deleteAuthenticationData: vi.fn(async () => null) };
    const { ctx, outputs } = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["access", "auth-data", "delete",
        "--operation", "nfc_card",
        "--device-id", "device-xyz",
        "--items", "[]"],
      { from: "user" },
    );
    expect(outputs[0]).toMatchObject({ ok: true, operation: "nfc_card", deviceID: "device-xyz" });
  });

  it("[ACC-0075] auth-data name: {ok,kind,response} 封筒 (deviceID でなく kind)", async () => {
    const hub = { updateAuthenticationName: vi.fn(async () => ({ ok: true })) };
    const { ctx, outputs } = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["access", "auth-data", "name", "--kind", "card"],
      { from: "user" },
    );
    expect(outputs[0]).toMatchObject({ ok: true, kind: "card" });
    expect(outputs[0]).toHaveProperty("response");
    expect(outputs[0]).not.toHaveProperty("deviceID");
  });

  it("[ACC-0075] auth-data name: kind 省略時は jsonObj.kind が null", async () => {
    const hub = { updateAuthenticationName: vi.fn(async () => ({})) };
    const { ctx, outputs } = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["access", "auth-data", "name"],
      { from: "user" },
    );
    expect(outputs[0].ok).toBe(true);
    expect(outputs[0].kind).toBeNull();
  });

  it("[ACC-0075] json=false (human パス) では outputs に何も積まれず console.log を呼ぶ", async () => {
    const hub = { postAuthenticationData: vi.fn(async () => ({})) };
    const { ctx, outputs } = makeCtx({ hub, json: false });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await buildProgram(ctx).parseAsync(
        ["access", "auth-data", "post",
          "--operation", "nfc_card",
          "--device-id", "d1",
          "--items", "[]"],
        { from: "user" },
      );
      // mock.calls を mockRestore() の前に検証する (mockRestore は mock.calls をリセットするため)
      expect(outputs).toHaveLength(0);
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});

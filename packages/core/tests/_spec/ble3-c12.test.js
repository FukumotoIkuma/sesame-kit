// BLE3-0224..BLE3-0235: Bot2 スクリプト系 / publish キャッシュ / 購読契約 / 面パリティ / i18n 完全性
//
// 対象実装:
//   packages/core/src/ble/bot2.js     — clickItemCode / bot2ActionToBytes / scriptToBytes /
//                                        parseCurrentScript / parseScriptNameList / Bot2Commands /
//                                        SCRIPT_RPC_OPS
//   packages/core/src/ble/index.js    — SesameBle#script ゲッタ / BLE_RPC_OPS / BLE_RPC_ALLOWLIST
//   packages/core/src/ble/session.js  — SesameBleSession._onPacket (item80/81/92 publish キャッシュ) /
//                                        SesameBleSession.onStatus
//   packages/core/src/ble/devicemodel.js — capabilitiesForModel (script フラグ)
//   packages/core/src/i18n/ble.js     — en/ja カタログ完全性
//
// 実行: npx vitest run --project unit packages/core/tests/_spec/ble3-c12.test.js

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Buffer } from "node:buffer";

// i18n setup (setup.i18n.js の beforeEach が ja 固定するが明示 import も残す)
import { setLocale } from "../../src/i18n.js";

// 対象モジュール
import {
  clickItemCode,
  bot2ActionToBytes,
  scriptToBytes,
  parseCurrentScript,
  parseScriptNameList,
  Bot2Commands,
  BOT_ACTION_TYPE,
  SCRIPT_RPC_OPS,
} from "../../src/ble/bot2.js";
import { ITEM_CODES } from "../../src/itemcodes.js";
import { capabilitiesForModel } from "../../src/ble/devicemodel.js";
import {
  SesameBle,
  BLE_RPC_OPS,
  BLE_RPC_ALLOWLIST,
} from "../../src/ble/index.js";
import { SesameBleSession } from "../../src/ble/session.js";
import { OP, SEG, splitSegments } from "../../src/ble/protocol.js";
import bleMessages from "../../src/i18n/ble.js";

beforeEach(() => setLocale("ja"));

// ── ヘルパ ──────────────────────────────────────────────────────────────────

/**
 * PUBLISH フレームをセグメント分割し session._onPacket に 1 チャンクずつ注入する。
 * splitSegments(frame, SEG.PLAINTEXT) で生成した各チャンクを session._onPacket に渡す。
 * @param {SesameBleSession} session
 * @param {number} itemCode
 * @param {Buffer} body
 */
function injectPlainPublish(session, itemCode, body) {
  // recv frame: [op=PUBLISH(8)][itemCode][body...]
  const frame = Buffer.concat([Buffer.from([OP.PUBLISH, itemCode]), body]);
  const chunks = splitSegments(frame, SEG.PLAINTEXT);
  for (const chunk of chunks) {
    session._onPacket(chunk);
  }
}

/**
 * SesameBleSession を最小スタブ transport で生成する (connect しない)。
 */
function makeSession({ secretKey = "0102030405060708090a0b0c0d0e0f10" } = {}) {
  const transport = {
    connect: vi.fn(),
    write: vi.fn(),
    disconnect: vi.fn(),
  };
  return new SesameBleSession({
    transport,
    secretKey,
    mechStatusKind: "lock",
    profile: "lock",
  });
}

/**
 * SesameBle ファサードを最小スタブで生成 (connect しない)。
 * @param {string|null} model
 * @param {string} [secretKey]
 */
function makeFacade(model, secretKey = "0102030405060708090a0b0c0d0e0f10") {
  const transport = {
    connect: vi.fn(),
    write: vi.fn(),
    disconnect: vi.fn(),
    onNotify: vi.fn(),
    offNotify: vi.fn(),
  };
  return new SesameBle({ secretKey, model, transport });
}

/**
 * session.request を mock した Bot2Commands を返す。
 * @param {Buffer} [payload]
 */
function makeBotCommands(payload = Buffer.alloc(0)) {
  const session = {
    request: vi.fn(() => Promise.resolve({ resultCode: 0, payload })),
  };
  return { session, cmds: new Bot2Commands(session) };
}

// ────────────────────────────────────────────────────────────────────────────
// BLE3-0224: clickItemCode index>9 / 非 UByte で range エラー
// ────────────────────────────────────────────────────────────────────────────
describe("[BLE3-0224] clickItemCode: index 0..9 のみ許可、それ以外は ble.bot2ScriptIndexRange を throw", () => {
  // ref: bot2.js:63-68 / SesameProtocols.kt:47 RUN_SCRIPT_0(170)..RUN_SCRIPT_9(179) の 10 本

  it("[BLE3-0224] index=0 は RUN_SCRIPT_0(170) を返す (下限)", () => {
    expect(clickItemCode(0)).toBe(ITEM_CODES.BOT2_ITEM_CODE_RUN_SCRIPT_0); // 170
  });

  it("[BLE3-0224] index=9 は RUN_SCRIPT_9(179) を返す (上限)", () => {
    expect(clickItemCode(9)).toBe(179);
  });

  it("[BLE3-0224] index=10 は ble.bot2ScriptIndexRange を throw (上限超)", () => {
    expect(() => clickItemCode(10)).toThrow();
  });

  it("[BLE3-0224] 負数 (-1) は throw する (非 UByte)", () => {
    expect(() => clickItemCode(-1)).toThrow();
  });

  it("[BLE3-0224] 非整数 (1.5) は throw する", () => {
    expect(() => clickItemCode(1.5)).toThrow();
  });

  it("[BLE3-0224] 256 は UByte 外として throw する", () => {
    expect(() => clickItemCode(256)).toThrow();
  });

  it("[BLE3-0224] null/undefined は click(89) を返す (index 省略 = 通常 click)", () => {
    // ref: bot2.js:64 index == null で ITEM.CLICK(89) を返す
    expect(clickItemCode(null)).toBe(89);
    expect(clickItemCode(undefined)).toBe(89);
  });

  it("[BLE3-0224] エラーメッセージに max=9 が含まれる (i18n ble.bot2ScriptIndexRange)", () => {
    // ref: bot2.js:66 t("ble.bot2ScriptIndexRange", { max: MAX_SCRIPT_INDEX })
    let msg = "";
    try { clickItemCode(10); } catch (e) { msg = e.message; }
    expect(msg).toMatch(/9/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BLE3-0225: selectScript(index) は SCRIPT_SELECT(94) に [index 1B] を送る
// ────────────────────────────────────────────────────────────────────────────
describe("[BLE3-0225] selectScript: item=SCRIPT_SELECT(94), payload=[index 1B]", () => {
  // ref: bot2.js:276-279 / SDK CHSesameBot2Device.kt:112-121

  it("[BLE3-0225] selectScript(7) は item=94, data=[7] を session.request に渡す", async () => {
    const { session, cmds } = makeBotCommands();
    await cmds.selectScript(7);
    const [item, data] = session.request.mock.calls[0];
    expect(item).toBe(ITEM_CODES.SCRIPT_SELECT); // 94
    expect(data.length).toBe(1);
    expect(data[0]).toBe(7);
  });

  it("[BLE3-0225] selectScript(0) は item=94, data=[0x00]", async () => {
    const { session, cmds } = makeBotCommands();
    await cmds.selectScript(0);
    const [item, data] = session.request.mock.calls[0];
    expect(item).toBe(94);
    expect(data[0]).toBe(0);
  });

  it("[BLE3-0225] selectScript(255) は data=[0xFF] (UByte 上限)", async () => {
    const { session, cmds } = makeBotCommands();
    await cmds.selectScript(255);
    const [item, data] = session.request.mock.calls[0];
    expect(item).toBe(94);
    expect(data[0]).toBe(255);
  });

  it("[BLE3-0225] selectScript(非UByte) は ble.bot2BadIndex を throw", () => {
    // ref: bot2.js:277 if (!isUByte(index)) throw t("ble.bot2BadIndex")
    const { cmds } = makeBotCommands();
    expect(() => cmds.selectScript(-1)).toThrow();
    expect(() => cmds.selectScript(256)).toThrow();
  });

  it("[BLE3-0225] ITEM_CODES.SCRIPT_SELECT は 94 (SesameProtocols.kt:36 と 1:1)", () => {
    expect(ITEM_CODES.SCRIPT_SELECT).toBe(94);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BLE3-0226: sendClickScript(index,script) は EDIT_SCRIPT(181) に [index 1B]+scriptBytes を送る
// ────────────────────────────────────────────────────────────────────────────
describe("[BLE3-0226] sendClickScript: item=EDIT_SCRIPT(181), data=[index]+scriptBytes", () => {
  // ref: bot2.js:261-268 / SDK CHSesameBot2Device.kt:99-110

  it("[BLE3-0226] 構造体スクリプト: item=181, data[0]=index, data[1..]=scriptToBytes(script)", async () => {
    const script = { name: "test", actions: [{ action: BOT_ACTION_TYPE.FORWARD, time: 10 }] };
    const { session, cmds } = makeBotCommands();
    await cmds.sendClickScript(3, script);
    const [item, data] = session.request.mock.calls[0];
    expect(item).toBe(ITEM_CODES.BOT2_ITEM_CODE_EDIT_SCRIPT); // 181
    expect(data[0]).toBe(3); // index 先頭 1B
    const expected = scriptToBytes(script);
    expect(Buffer.from(data.subarray(1)).equals(expected)).toBe(true);
  });

  it("[BLE3-0226] 生 Buffer を渡すとそのまま結合 (script=Buffer 分岐)", async () => {
    const scriptBytes = scriptToBytes({ name: "raw", actions: [] });
    const { session, cmds } = makeBotCommands();
    await cmds.sendClickScript(0, scriptBytes);
    const [item, data] = session.request.mock.calls[0];
    expect(item).toBe(181);
    expect(data[0]).toBe(0);
    expect(Buffer.from(data.subarray(1)).equals(scriptBytes)).toBe(true);
  });

  it("[BLE3-0226] index が非 UByte のとき ble.bot2BadIndex を throw", () => {
    // ref: bot2.js:262 if (!isUByte(index)) throw t("ble.bot2BadIndex")
    const { cmds } = makeBotCommands();
    expect(() => cmds.sendClickScript(-1, { name: "x", actions: [] })).toThrow();
  });

  it("[BLE3-0226] ITEM_CODES.BOT2_ITEM_CODE_EDIT_SCRIPT は 181 (SesameProtocols.kt:48 と 1:1)", () => {
    expect(ITEM_CODES.BOT2_ITEM_CODE_EDIT_SCRIPT).toBe(181);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BLE3-0227: scriptToBytes のレイアウト [nameLen 1B][name 領域 20B][actionLen 1B][action,time...]
// ────────────────────────────────────────────────────────────────────────────
describe("[BLE3-0227] scriptToBytes: nameLen → name領域20B → actionLen → actions (CHSesamebot2Event.toByteArray)", () => {
  // ref: bot2.js:95-116 / CHSesameBot2.kt:71-81

  it("[BLE3-0227] actions=2 個: レイアウト一致、total=26B、actionLength は byte21", () => {
    // total = 1(nameLen) + 20(name field) + 1(actionLen) + 2*2(actions) = 26
    const buf = scriptToBytes({
      name: "ab",
      actions: [
        { action: BOT_ACTION_TYPE.FORWARD, time: 4 },
        { action: BOT_ACTION_TYPE.STOP, time: 2 },
      ],
    });
    expect(buf.length).toBe(26);
    expect(buf[0]).toBe(2);                                          // nameLength
    expect(buf.subarray(1, 3).toString("utf8")).toBe("ab");          // name 先頭
    expect(buf.subarray(3, 21).equals(Buffer.alloc(18))).toBe(true); // 0x00 埋め
    expect(buf[21]).toBe(2);                                         // actionLength (byte 21)
    expect(buf[22]).toBe(BOT_ACTION_TYPE.FORWARD);
    expect(buf[23]).toBe(4);
    expect(buf[24]).toBe(BOT_ACTION_TYPE.STOP);
    expect(buf[25]).toBe(2);
  });

  it("[BLE3-0227] actions=0 個: actionLength=0 を byte21 に載せ、total=22B", () => {
    const buf = scriptToBytes({ name: "x", actions: [] });
    expect(buf.length).toBe(22); // 1+20+1
    expect(buf[0]).toBe(1);
    expect(buf[21]).toBe(0); // actionLength=0 (byte21)
  });

  it("[BLE3-0227] name 20B が上限: name=20B のとき 0x00 埋め 0B で total=22B", () => {
    const name = "a".repeat(20);
    const buf = scriptToBytes({ name, actions: [] });
    expect(buf[0]).toBe(20);
    expect(buf.subarray(1, 21).toString("utf8")).toBe(name);
    expect(buf[21]).toBe(0); // actionLength
    expect(buf.length).toBe(22);
  });

  it("[BLE3-0227] scriptToBytes と parseCurrentScript の往復一致 (round-trip)", () => {
    const actions = [
      { action: BOT_ACTION_TYPE.REVERSE, time: 7 },
      { action: BOT_ACTION_TYPE.SLEEP, time: 1 },
    ];
    const buf = scriptToBytes({ name: "door", actions });
    const got = parseCurrentScript(buf);
    expect(got).not.toBeNull();
    expect(got.nameLength).toBe(4);
    expect(got.name.toString("utf8")).toBe("door");
    expect(got.actionLength).toBe(2);
    expect(got.actions).toEqual(actions);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BLE3-0228: scriptToBytes のバリデーション (name>20B / 不正action / 不正time)
// ────────────────────────────────────────────────────────────────────────────
describe("[BLE3-0228] scriptToBytes バリデーション: name>20B / 不正 action / 不正 time", () => {
  // ref: bot2.js:95-116 / CHSesameBot2.kt:74

  it("[BLE3-0228] name が 21B 超のとき ble.bot2ScriptNameLen を throw する", () => {
    // ref: bot2.js:101 name.length>SCRIPT_NAME_FIELD_LEN(20)
    expect(() => scriptToBytes({ name: "x".repeat(21), actions: [] })).toThrow();
  });

  it("[BLE3-0228] name が非文字列/非Buffer のとき ble.bot2BadScriptName を throw する", () => {
    expect(() => scriptToBytes({ name: 123, actions: [] })).toThrow();
    expect(() => scriptToBytes({ name: null, actions: [] })).toThrow();
  });

  it("[BLE3-0228] actions が非配列 ('wrong'文字列) のとき throw する", () => {
    // ref: bot2.js:104 !Array.isArray(actions) で throw t("ble.bot2BadScript")
    expect(() => scriptToBytes({ name: "x", actions: "wrong" })).toThrow();
  });

  it("[BLE3-0228] action が BOT_ACTION_TYPE 外 (4, -1) のとき ble.bot2BadAction を throw する", () => {
    // ref: bot2.js:77 !BOT_ACTION_VALUES.has(a.action) で throw
    expect(() => bot2ActionToBytes({ action: 4, time: 0 })).toThrow();
    expect(() => bot2ActionToBytes({ action: -1, time: 0 })).toThrow();
  });

  it("[BLE3-0228] time が UByte 外 (256, -1, 1.5) のとき ble.bot2BadActionTime を throw する", () => {
    // ref: bot2.js:78 !isUByte(a.time) で throw
    expect(() => bot2ActionToBytes({ action: BOT_ACTION_TYPE.FORWARD, time: 256 })).toThrow();
    expect(() => bot2ActionToBytes({ action: BOT_ACTION_TYPE.FORWARD, time: -1 })).toThrow();
    expect(() => bot2ActionToBytes({ action: BOT_ACTION_TYPE.FORWARD, time: 1.5 })).toThrow();
  });

  it("[BLE3-0228] time が UByte 上限 (255) は許容 (境界値)", () => {
    expect(() => bot2ActionToBytes({ action: BOT_ACTION_TYPE.FORWARD, time: 255 })).not.toThrow();
    expect(() => scriptToBytes({ name: "x", actions: [{ action: 0, time: 255 }] })).not.toThrow();
  });

  it("[BLE3-0228] event=null/undefined のとき ble.bot2BadScript を throw する", () => {
    // ref: bot2.js:96 if (!event) throw t("ble.bot2BadScript")
    expect(() => scriptToBytes(null)).toThrow();
    expect(() => scriptToBytes(undefined)).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BLE3-0229: getCurrentScript / parseCurrentScript (SCRIPT_CURRENT=95)
// ────────────────────────────────────────────────────────────────────────────
describe("[BLE3-0229] getCurrentScript / parseCurrentScript: SCRIPT_CURRENT(95) 送受信", () => {
  // ref: bot2.js:288-296, 132-165 / SDK CHSesameBot2Device.kt:123-144

  it("[BLE3-0229] index 指定: item=95, data=[index 1B] (CHSesameBot2Device.kt:127-136)", async () => {
    const payload = scriptToBytes({ name: "go", actions: [{ action: BOT_ACTION_TYPE.STOP, time: 3 }] });
    const { session, cmds } = makeBotCommands(payload);
    await cmds.getCurrentScript(4);
    const [item, data] = session.request.mock.calls[0];
    expect(item).toBe(ITEM_CODES.SCRIPT_CURRENT); // 95
    expect(data.length).toBe(1);
    expect(data[0]).toBe(4);
  });

  it("[BLE3-0229] index 省略: data 空 (CHSesameBot2Device.kt:127 index==null branch)", async () => {
    const payload = scriptToBytes({ name: "z", actions: [] });
    const { session, cmds } = makeBotCommands(payload);
    await cmds.getCurrentScript();
    const [, data] = session.request.mock.calls[0];
    expect(data.length).toBe(0);
  });

  it("[BLE3-0229] parseCurrentScript: nameLength<1 → null (CHSesamebot2Event.fromByteArray:52)", () => {
    // ref: bot2.js:136 if (nameLength < 1) return null
    const buf = Buffer.alloc(22); // nameLength=0
    expect(parseCurrentScript(buf)).toBeNull();
  });

  it("[BLE3-0229] parseCurrentScript: actionLength==0 → actions=null (bot2.js:141-143)", () => {
    // ref: bot2.js:141-143; CHSesamebot2Event.fromByteArray:59-61
    const buf = scriptToBytes({ name: "x", actions: [] });
    const parsed = parseCurrentScript(buf);
    expect(parsed).not.toBeNull();
    expect(parsed.actionLength).toBeNull();
    expect(parsed.actions).toBeNull();
  });

  it("[BLE3-0229] parseCurrentScript が null のとき bot2ScriptParseFailed を throw", async () => {
    // ref: bot2.js:296 if (parsed == null) throw t("ble.bot2ScriptParseFailed")
    const { cmds } = makeBotCommands(Buffer.alloc(22)); // nameLength=0 → null
    await expect(cmds.getCurrentScript()).rejects.toThrow();
  });

  it("[BLE3-0229] actionLength が byte21 に来る (name 領域は常に 20B)", () => {
    // ref: bot2.js:139 cursor += SCRIPT_NAME_FIELD_LEN(20) → 21
    const actions = [{ action: BOT_ACTION_TYPE.REVERSE, time: 10 }];
    const buf = scriptToBytes({ name: "hi", actions });
    expect(buf[21]).toBe(actions.length);
    const parsed = parseCurrentScript(buf);
    expect(parsed.actionLength).toBe(1);
    expect(parsed.actions).toEqual(actions);
  });

  it("[BLE3-0229] ITEM_CODES.SCRIPT_CURRENT は 95 (SesameProtocols.kt と 1:1)", () => {
    expect(ITEM_CODES.SCRIPT_CURRENT).toBe(95);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BLE3-0230: getScriptNameList / parseScriptNameList (SCRIPT_NAME_LIST=96)
// ────────────────────────────────────────────────────────────────────────────
describe("[BLE3-0230] getScriptNameList / parseScriptNameList: SCRIPT_NAME_LIST(96) 空 payload + 直列化", () => {
  // ref: bot2.js:311-316, 174-191 / SDK CHSesameBot2Device.kt:146-193

  /** name エントリ [nameLength 1B][name 領域 20B] を組み立てる */
  function makeNameEntry(name) {
    const nb = Buffer.from(name, "utf8");
    const f = Buffer.alloc(20);
    nb.copy(f);
    return Buffer.concat([Buffer.from([nb.length]), f]);
  }

  /** [curIdx][eventLength] + eventLength 個の [nameLength][name 領域 20B] */
  function buildNameList(curIdx, names) {
    return Buffer.concat([
      Buffer.from([curIdx, names.length]),
      ...names.map(makeNameEntry),
    ]);
  }

  it("[BLE3-0230] getScriptNameList() は item=SCRIPT_NAME_LIST(96), 空 payload を送る", async () => {
    const payload = buildNameList(0, ["alpha", "beta"]);
    const { session, cmds } = makeBotCommands(payload);
    await cmds.getScriptNameList();
    const [item, data] = session.request.mock.calls[0];
    expect(item).toBe(ITEM_CODES.SCRIPT_NAME_LIST); // 96
    expect(data.length).toBe(0);
  });

  it("[BLE3-0230] parseScriptNameList は curIdx/eventLength/events を解析する (CHSesameBot2.kt:93-109)", () => {
    const buf = buildNameList(1, ["alpha", "beta", "gamma"]);
    const got = parseScriptNameList(buf);
    expect(got).not.toBeNull();
    expect(got.curIdx).toBe(1);
    expect(got.eventLength).toBe(3);
    expect(got.events.length).toBe(3);
    expect(got.events.map((e) => e.name.subarray(0, 5).toString("utf8"))).toEqual(["alpha", "beta", "gamma"]);
  });

  it("[BLE3-0230] curIdx >= eventLength のとき null を返す (CHSesameBot2.kt:98)", () => {
    expect(parseScriptNameList(buildNameList(3, ["a", "b", "c"]))).toBeNull();
    expect(parseScriptNameList(buildNameList(2, ["a", "b"]))).toBeNull();
  });

  it("[BLE3-0230] 成功時に this.scripts キャッシュを更新する (CHSesameBot2Device.kt:178)", async () => {
    const payload = buildNameList(0, ["a", "bb"]);
    const { cmds } = makeBotCommands(payload);
    expect(cmds.scripts.eventLength).toBe(0); // 初期値
    const got = await cmds.getScriptNameList();
    expect(cmds.scripts).toBe(got); // 同一参照
    expect(cmds.scripts.eventLength).toBe(2);
  });

  it("[BLE3-0230] parse 失敗時は bot2ScriptParseFailed を throw し scripts は更新しない", async () => {
    const { cmds } = makeBotCommands(Buffer.from([5, 1])); // curIdx=5 >= eventLength=1 → null
    await expect(cmds.getScriptNameList()).rejects.toThrow();
    expect(cmds.scripts.eventLength).toBe(0); // 更新されない
  });

  it("[BLE3-0230] ITEM_CODES.SCRIPT_NAME_LIST は 96 (SesameProtocols.kt と 1:1)", () => {
    expect(ITEM_CODES.SCRIPT_NAME_LIST).toBe(96);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BLE3-0231: script ゲッタの能力ゲート (Bot2/Bot3 のみ露出、他機種は bot2NotSupported)
// ────────────────────────────────────────────────────────────────────────────
describe("[BLE3-0231] SesameBle#script ゲッタ: Bot2/Bot3 のみ Bot2Commands を返す", () => {
  // ref: index.js:669 / devicemodel.js:84

  it("[BLE3-0231] bot_2 は caps.script=true (Bot2Commands を返す)", () => {
    expect(capabilitiesForModel("bot_2").script).toBe(true);
    const ble = makeFacade("bot_2");
    expect(() => ble.script).not.toThrow();
    expect(ble.script).toBeDefined();
  });

  it("[BLE3-0231] bot_3 も caps.script=true (Bot2Commands を返す)", () => {
    expect(capabilitiesForModel("bot_3").script).toBe(true);
    const ble = makeFacade("bot_3");
    expect(() => ble.script).not.toThrow();
    expect(ble.script).toBeDefined();
  });

  it("[BLE3-0231] sesame_5 は script:false — ble.bot2NotSupported で throw する", () => {
    expect(capabilitiesForModel("sesame_5").script).toBe(false);
    const ble = makeFacade("sesame_5");
    expect(() => ble.script).toThrow();
  });

  it("[BLE3-0231] bike_2 は script:false — throw する", () => {
    expect(capabilitiesForModel("bike_2").script).toBe(false);
    const ble = makeFacade("bike_2");
    expect(() => ble.script).toThrow();
  });

  it("[BLE3-0231] hub_3 は script:false — throw する", () => {
    expect(capabilitiesForModel("hub_3").script).toBe(false);
    const ble = makeFacade("hub_3");
    expect(() => ble.script).toThrow();
  });

  it("[BLE3-0231] ssm_touch は script:false — throw する", () => {
    expect(capabilitiesForModel("ssm_touch").script).toBe(false);
    const ble = makeFacade("ssm_touch");
    expect(() => ble.script).toThrow();
  });

  it("[BLE3-0231] capabilitiesForModel: bot2/bot3=true, wm_2=false (devicemodel.js)", () => {
    expect(capabilitiesForModel("bot_2").script).toBe(true);
    expect(capabilitiesForModel("bot_3").script).toBe(true);
    expect(capabilitiesForModel("sesame_5").script).toBe(false);
    expect(capabilitiesForModel("bike_2").script).toBe(false);
    expect(capabilitiesForModel("hub_3").script).toBe(false);
    expect(capabilitiesForModel("wm_2").script).toBe(false);
  });

  it("[BLE3-0231] BLE_RPC_ALLOWLIST に 'script' が含まれる (index.js:153)", () => {
    expect(BLE_RPC_ALLOWLIST).toContain("script");
  });

  it("[BLE3-0231] i18n キー ble.bot2NotSupported が en/ja 両方に存在する", () => {
    expect(bleMessages.en["ble.bot2NotSupported"]).toBeTruthy();
    expect(bleMessages.ja["ble.bot2NotSupported"]).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BLE3-0232: mechSetting(80)/opsSetting(92) publish キャッシュ更新
// ────────────────────────────────────────────────────────────────────────────
describe("[BLE3-0232] SesameBleSession: item80/92 publish で _lastMechSetting/_lastOpsSetting が更新される", () => {
  // ref: session.js:785-789 / SDK CHSesame5Device.kt:220-227

  it("[BLE3-0232] MECH_SETTING(80) publish で _lastMechSetting が更新される", () => {
    const session = makeSession();
    expect(session.lastMechSetting).toBeNull();

    // mechSetting 6B: lockPosition=-100(LE), unlockPosition=200(LE), autoLockSecond=5(LE)
    const body = Buffer.alloc(6);
    body.writeInt16LE(-100, 0);
    body.writeInt16LE(200, 2);
    body.writeInt16LE(5, 4);
    injectPlainPublish(session, ITEM_CODES.MECH_SETTING, body);

    expect(session.lastMechSetting).not.toBeNull();
    expect(session.lastMechSetting.lockPosition).toBe(-100);
    expect(session.lastMechSetting.unlockPosition).toBe(200);
    expect(session.lastMechSetting.autoLockSecond).toBe(5);
  });

  it("[BLE3-0232] OPS_CONTROL(92) publish で _lastOpsSetting が更新される", () => {
    const session = makeSession();
    expect(session.lastOpsSetting).toBeNull();

    // opsLockSecond=120
    const body = Buffer.alloc(2);
    body.writeUInt16LE(120, 0);
    injectPlainPublish(session, ITEM_CODES.OPS_CONTROL, body);

    expect(session.lastOpsSetting).not.toBeNull();
    expect(session.lastOpsSetting.opsLockSecond).toBe(120);
  });

  it("[BLE3-0232] mechSetting parse 失敗 (短すぎる body) は握りつぶし — _lastMechSetting は null のまま", () => {
    // ref: session.js:786 try { ... } catch { /* ignore */ }
    const session = makeSession();
    expect(() => injectPlainPublish(session, ITEM_CODES.MECH_SETTING, Buffer.alloc(3))).not.toThrow();
    expect(session.lastMechSetting).toBeNull();
  });

  it("[BLE3-0232] opsSetting parse 失敗 (短すぎる body) は握りつぶし — _lastOpsSetting は null のまま", () => {
    const session = makeSession();
    expect(() => injectPlainPublish(session, ITEM_CODES.OPS_CONTROL, Buffer.alloc(1))).not.toThrow();
    expect(session.lastOpsSetting).toBeNull();
  });

  it("[BLE3-0232] 複数回 publish で最新値に上書きされる", () => {
    const session = makeSession();
    const body1 = Buffer.alloc(6);
    body1.writeInt16LE(10, 0); body1.writeInt16LE(20, 2); body1.writeInt16LE(0, 4);
    injectPlainPublish(session, ITEM_CODES.MECH_SETTING, body1);
    expect(session.lastMechSetting.lockPosition).toBe(10);

    const body2 = Buffer.alloc(6);
    body2.writeInt16LE(50, 0); body2.writeInt16LE(80, 2); body2.writeInt16LE(3, 4);
    injectPlainPublish(session, ITEM_CODES.MECH_SETTING, body2);
    expect(session.lastMechSetting.lockPosition).toBe(50);
    expect(session.lastMechSetting.unlockPosition).toBe(80);
    expect(session.lastMechSetting.autoLockSecond).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BLE3-0233: status() / onStatus() — mechStatus publish 購読-タイムアウト契約
// ────────────────────────────────────────────────────────────────────────────
describe("[BLE3-0233] SesameBleSession.onStatus: mechStatus(81) publish リスナ登録/解除", () => {
  // ref: session.js:208, 781 / index.js:978-984

  it("[BLE3-0233] onStatus(fn) は unsubscribe 関数を返し、_statusListeners に fn を追加する", () => {
    const session = makeSession();
    const fn = vi.fn();
    const off = session.onStatus(fn);
    expect(typeof off).toBe("function");
    expect(session._statusListeners.has(fn)).toBe(true);
  });

  it("[BLE3-0233] unsubscribe 後は mechStatus publish でリスナが呼ばれない", () => {
    const session = makeSession();
    const fn = vi.fn();
    const off = session.onStatus(fn);
    off();
    expect(session._statusListeners.has(fn)).toBe(false);
  });

  it("[BLE3-0233] 複数リスナが各 mechStatus publish で個別に呼ばれる (session.js:781)", () => {
    const session = makeSession();
    // lock 7B mechStatus (parseMechStatus が 7B を受け入れる)
    const mechStatusBuf = Buffer.alloc(7);
    mechStatusBuf.writeInt16LE(0, 0);      // battery raw
    mechStatusBuf.writeInt16LE(-32768, 2); // target=-32768 → null
    mechStatusBuf.writeInt16LE(100, 4);    // position
    mechStatusBuf[6] = 0b00000011;         // flags

    const fn1 = vi.fn();
    const fn2 = vi.fn();
    session.onStatus(fn1);
    session.onStatus(fn2);
    injectPlainPublish(session, ITEM_CODES.MECH_STATUS, mechStatusBuf);

    expect(fn1).toHaveBeenCalledOnce();
    expect(fn2).toHaveBeenCalledOnce();
  });

  it("[BLE3-0233] onStatus は publish ごとに fn を呼び出し、unsubscribe で解除される", () => {
    const session = makeSession();
    const results = [];
    const mechStatusBuf = Buffer.alloc(7);
    const off = session.onStatus((s) => results.push(s));

    injectPlainPublish(session, ITEM_CODES.MECH_STATUS, mechStatusBuf);
    expect(results.length).toBe(1);

    injectPlainPublish(session, ITEM_CODES.MECH_STATUS, mechStatusBuf);
    expect(results.length).toBe(2);

    off();
    injectPlainPublish(session, ITEM_CODES.MECH_STATUS, mechStatusBuf);
    expect(results.length).toBe(2); // 増えない
  });

  it("[BLE3-0233] status() タイムアウト: timeoutMs 経過で reject する (STATUS_WAIT_MS=4000 相当)", async () => {
    vi.useFakeTimers();
    const session = makeSession();
    // lastStatus が null の状態で onStatus を使って同型の Promise を組む
    const waitStatus = (timeoutMs) =>
      new Promise((resolve, reject) => {
        const to = setTimeout(() => { off(); reject(new Error("timeout")); }, timeoutMs);
        const off = session.onStatus((s) => { clearTimeout(to); off(); resolve(s); });
      });

    const p = waitStatus(4000);
    vi.advanceTimersByTime(4001);
    await expect(p).rejects.toThrow("timeout");
    vi.useRealTimers();
  }, 10000);

  it("[BLE3-0233] BLE_RPC_ALLOWLIST に 'status' / 'lastMechSetting' / 'lastOpsSetting' が掲載 (index.js:144)", () => {
    expect(BLE_RPC_ALLOWLIST).toContain("status");
    expect(BLE_RPC_ALLOWLIST).toContain("lastMechSetting");
    expect(BLE_RPC_ALLOWLIST).toContain("lastOpsSetting");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BLE3-0234: script.getCurrentScript/getScriptNameList の RPC 公開仕様 (result:'raw') 面パリティ
// ────────────────────────────────────────────────────────────────────────────
describe("[BLE3-0234] SCRIPT_RPC_OPS: getCurrentScript/getScriptNameList が result:'raw' で公開される", () => {
  // ref: bot2.js:215-230 / index.js:277-285

  it("[BLE3-0234] SCRIPT_RPC_OPS に script.getCurrentScript が result:'raw' で定義される", () => {
    expect(SCRIPT_RPC_OPS["script.getCurrentScript"]).toBeDefined();
    expect(SCRIPT_RPC_OPS["script.getCurrentScript"].result).toBe("raw");
  });

  it("[BLE3-0234] SCRIPT_RPC_OPS に script.getScriptNameList が result:'raw' で定義される", () => {
    expect(SCRIPT_RPC_OPS["script.getScriptNameList"]).toBeDefined();
    expect(SCRIPT_RPC_OPS["script.getScriptNameList"].result).toBe("raw");
    expect(SCRIPT_RPC_OPS["script.getScriptNameList"].params.length).toBe(0);
  });

  it("[BLE3-0234] BLE_RPC_OPS に SCRIPT_RPC_OPS が合成されている (index.js:278 ...SCRIPT_RPC_OPS)", () => {
    expect(BLE_RPC_OPS["script.getCurrentScript"]).toBeDefined();
    expect(BLE_RPC_OPS["script.getScriptNameList"]).toBeDefined();
    expect(BLE_RPC_OPS["script.getCurrentScript"].result).toBe("raw");
    expect(BLE_RPC_OPS["script.getScriptNameList"].result).toBe("raw");
  });

  it("[BLE3-0234] script.click は result:'ack' (ack 封筒系)", () => {
    expect(SCRIPT_RPC_OPS["script.click"]).toBeDefined();
    expect(SCRIPT_RPC_OPS["script.click"].result).toBe("ack");
  });

  it("[BLE3-0234] script.selectScript は result:'ack'", () => {
    expect(SCRIPT_RPC_OPS["script.selectScript"]).toBeDefined();
    expect(SCRIPT_RPC_OPS["script.selectScript"].result).toBe("ack");
  });

  it("[BLE3-0234] script.sendClickScript は result:'ack'", () => {
    expect(SCRIPT_RPC_OPS["script.sendClickScript"]).toBeDefined();
    expect(SCRIPT_RPC_OPS["script.sendClickScript"].result).toBe("ack");
  });

  it("[BLE3-0234] BLE_RPC_ALLOWLIST に 'script' が掲載されている (index.js:153)", () => {
    expect(BLE_RPC_ALLOWLIST).toContain("script");
  });

  it("[BLE3-0234] SCRIPT_RPC_OPS の全 op が BLE_RPC_OPS に存在する (漏れなし)", () => {
    for (const key of Object.keys(SCRIPT_RPC_OPS)) {
      expect(BLE_RPC_OPS[key]).toBeDefined();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BLE3-0235: i18n ble.bot2*/ble.cli.script* スクリプト系カタログの en/ja 完全性
// ────────────────────────────────────────────────────────────────────────────
describe("[BLE3-0235] i18n: ble.bot2* / ble.cli.script* スクリプト系カタログの en/ja 完全性", () => {
  // ref: i18n/ble.js:85-95 (en bot2), 258-268 (ja bot2), 129-142 (en cli), 302-315 (ja cli)

  const EN = bleMessages.en;
  const JA = bleMessages.ja;

  // ble.bot2* キー群
  const BOT2_KEYS = [
    "ble.bot2NotSupported",
    "ble.bot2ScriptIndexRange",
    "ble.bot2BadIndex",
    "ble.bot2BadAction",
    "ble.bot2BadActionTime",
    "ble.bot2BadScript",
    "ble.bot2BadScriptName",
    "ble.bot2ScriptNameLen",
    "ble.bot2ScriptParseFailed",
  ];

  // ble.cli.script.* / scriptRun.* / scriptSelect.* / scriptWrite.* キー群
  const CLI_SCRIPT_KEYS = [
    "ble.cli.script.desc",
    "ble.cli.script.opt.index",
    "ble.cli.script.notSupported",
    "ble.cli.scriptRun.desc",
    "ble.cli.scriptRun.badIndex",
    "ble.cli.scriptRun.done",
    "ble.cli.scriptSelect.desc",
    "ble.cli.scriptSelect.done",
    "ble.cli.scriptWrite.desc",
    "ble.cli.scriptWrite.opt.json",
    "ble.cli.scriptWrite.jsonRequired",
    "ble.cli.scriptWrite.done",
    "ble.cli.script.header",
    "ble.cli.script.current",
  ];

  for (const key of BOT2_KEYS) {
    it(`[BLE3-0235] en カタログに '${key}' が定義されている`, () => {
      expect(EN[key]).toBeTruthy();
    });
    it(`[BLE3-0235] ja カタログに '${key}' が定義されている`, () => {
      expect(JA[key]).toBeTruthy();
    });
  }

  for (const key of CLI_SCRIPT_KEYS) {
    it(`[BLE3-0235] en カタログに '${key}' が定義されている`, () => {
      expect(EN[key]).toBeTruthy();
    });
    it(`[BLE3-0235] ja カタログに '${key}' が定義されている`, () => {
      expect(JA[key]).toBeTruthy();
    });
  }

  it("[BLE3-0235] ble.bot2ScriptIndexRange の en/ja メッセージに {max} プレースホルダが含まれる", () => {
    expect(EN["ble.bot2ScriptIndexRange"]).toMatch(/\{max\}/);
    expect(JA["ble.bot2ScriptIndexRange"]).toMatch(/\{max\}/);
  });

  it("[BLE3-0235] ble.bot2ScriptNameLen の en/ja メッセージに {max} プレースホルダが含まれる", () => {
    expect(EN["ble.bot2ScriptNameLen"]).toMatch(/\{max\}/);
    expect(JA["ble.bot2ScriptNameLen"]).toMatch(/\{max\}/);
  });

  it("[BLE3-0235] en/ja 両ロケールのスクリプト系キーが対称 (片方だけ定義されていない)", () => {
    const scriptPattern = /^ble\.(bot2|cli\.script|cli\.scriptRun|cli\.scriptSelect|cli\.scriptWrite)/;
    const enKeys = Object.keys(EN).filter((k) => scriptPattern.test(k));
    const jaKeys = new Set(Object.keys(JA).filter((k) => scriptPattern.test(k)));
    for (const key of enKeys) {
      expect(jaKeys.has(key), `ja に ${key} が無い`).toBe(true);
    }
    const enKeySet = new Set(enKeys);
    for (const key of jaKeys) {
      expect(enKeySet.has(key), `en に ${key} が無い`).toBe(true);
    }
  });
});

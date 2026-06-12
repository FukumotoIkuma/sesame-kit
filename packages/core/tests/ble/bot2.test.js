// SESAME Bot2 / Bot3 スクリプト機能の単体テスト (純 JS、ハードウェア不要)。
// 移植元 CHSesameBot2Device.kt / CHSesameBot2.kt のバイト列・itemCode・分岐を assert する。
import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";
import {
  Bot2Commands, BOT_ACTION_TYPE,
  clickItemCode, bot2ActionToBytes, scriptToBytes,
  parseCurrentScript, parseScriptNameList,
} from "../../src/ble/bot2.js";
import { ITEM_CODES } from "../../src/itemcodes.js";
import { capabilitiesForModel } from "../../src/ble/devicemodel.js";

describe("itemcodes (SesameProtocols.kt:36,47-48)", () => {
  it("SCRIPT_* / RUN_SCRIPT_* / EDIT_SCRIPT の値が SDK と一致", () => {
    expect(ITEM_CODES.SCRIPT_SELECT).toBe(94);
    expect(ITEM_CODES.SCRIPT_CURRENT).toBe(95);
    expect(ITEM_CODES.SCRIPT_NAME_LIST).toBe(96);
    expect(ITEM_CODES.BOT2_ITEM_CODE_RUN_SCRIPT_0).toBe(170);
    expect(ITEM_CODES.BOT2_ITEM_CODE_RUN_SCRIPT_9).toBe(179);
    expect(ITEM_CODES.BOT2_ITEM_CODE_EDIT_SCRIPT).toBe(181);
    expect(ITEM_CODES.CLICK).toBe(89);
  });
});

describe("clickItemCode (CHSesameBot2Device.kt:75-80)", () => {
  it("index==null は click(89)", () => {
    expect(clickItemCode(null)).toBe(89);
    expect(clickItemCode(undefined)).toBe(89);
  });
  it("index は RUN_SCRIPT_0(170)+index", () => {
    expect(clickItemCode(0)).toBe(170);
    expect(clickItemCode(5)).toBe(175);
    expect(clickItemCode(9)).toBe(179);
  });
  it("index は 0..9 の範囲外を拒否", () => {
    expect(() => clickItemCode(10)).toThrow();
    expect(() => clickItemCode(-1)).toThrow();
    expect(() => clickItemCode(1.5)).toThrow();
  });
});

describe("bot2ActionToBytes (CHSesameBot2.kt:33-35)", () => {
  it("[action, time] の 2B", () => {
    expect(bot2ActionToBytes({ action: BOT_ACTION_TYPE.FORWARD, time: 10 }).equals(Buffer.from([0, 10]))).toBe(true);
    expect(bot2ActionToBytes({ action: BOT_ACTION_TYPE.SLEEP, time: 255 }).equals(Buffer.from([3, 255]))).toBe(true);
  });
  it("不正 action / time を拒否", () => {
    expect(() => bot2ActionToBytes({ action: 9, time: 1 })).toThrow();
    expect(() => bot2ActionToBytes({ action: 0, time: 256 })).toThrow();
  });
});

describe("scriptToBytes (CHSesamebot2Event.toByteArray, CHSesameBot2.kt:71-81)", () => {
  it("nameLength + name領域20B + actionLength + actions の順 (actionLength は byte 21)", () => {
    const buf = scriptToBytes({
      name: "ab",
      actions: [{ action: BOT_ACTION_TYPE.FORWARD, time: 4 }, { action: BOT_ACTION_TYPE.STOP, time: 2 }],
    });
    expect(buf.length).toBe(1 + 20 + 1 + 2 * 2); // 26
    expect(buf[0]).toBe(2);                       // nameLength
    expect(buf.subarray(1, 3).toString("utf8")).toBe("ab");
    expect(buf.subarray(3, 21).equals(Buffer.alloc(18))).toBe(true); // 0x00 埋め
    expect(buf[21]).toBe(2);                       // actionLength (byte 21)
    expect(buf.subarray(22).equals(Buffer.from([0, 4, 2, 2]))).toBe(true);
  });
  it("actions 空でも actionLength=0 を載せる", () => {
    const buf = scriptToBytes({ name: "x", actions: [] });
    expect(buf.length).toBe(22);
    expect(buf[0]).toBe(1);
    expect(buf[21]).toBe(0);
  });
  it("name 20B 超を拒否 / 不正 name 型を拒否", () => {
    expect(() => scriptToBytes({ name: "x".repeat(21), actions: [] })).toThrow();
    expect(() => scriptToBytes({ name: 123, actions: [] })).toThrow();
  });
});

describe("parseCurrentScript (CHSesamebot2Event.fromByteArray, CHSesameBot2.kt:47-68)", () => {
  it("scriptToBytes と往復一致 (actions あり)", () => {
    const actions = [
      { action: BOT_ACTION_TYPE.FORWARD, time: 4 },
      { action: BOT_ACTION_TYPE.REVERSE, time: 7 },
      { action: BOT_ACTION_TYPE.SLEEP, time: 1 },
    ];
    const buf = scriptToBytes({ name: "door", actions });
    const got = parseCurrentScript(buf);
    expect(got.nameLength).toBe(4);
    expect(got.name.toString("utf8")).toBe("door");
    expect(got.actionLength).toBe(3);
    expect(got.actions).toEqual(actions);
  });
  it("actionLength==0 は actions=null で返す (kt:56)", () => {
    const buf = scriptToBytes({ name: "y", actions: [] });
    const got = parseCurrentScript(buf);
    expect(got.actionLength).toBe(null);
    expect(got.actions).toBe(null);
    expect(got.name.toString("utf8")).toBe("y");
  });
  it("nameLength < 1 は null (kt:50)", () => {
    const buf = Buffer.alloc(22); // nameLength=0
    expect(parseCurrentScript(buf)).toBe(null);
  });
});

describe("parseScriptNameList (CHSesamebot2Status.fromByteArray, CHSesameBot2.kt:93-109)", () => {
  // レイアウト: [curIdx][eventLength] then eventLength 個の [nameLength][name領域20B]。
  function buildNameList(curIdx, names) {
    const head = Buffer.from([curIdx, names.length]);
    const entries = names.map((n) => {
      const nameBuf = Buffer.from(n, "utf8");
      const field = Buffer.alloc(20);
      nameBuf.copy(field);
      return Buffer.concat([Buffer.from([nameBuf.length]), field]);
    });
    return Buffer.concat([head, ...entries]);
  }

  it("curIdx / eventLength / events(name,nameLength) を解析", () => {
    const buf = buildNameList(1, ["alpha", "beta", "gamma"]);
    const got = parseScriptNameList(buf);
    expect(got.curIdx).toBe(1);
    expect(got.eventLength).toBe(3);
    expect(got.events.map((e) => e.name.toString("utf8"))).toEqual(["alpha", "beta", "gamma"]);
    expect(got.events.map((e) => e.nameLength)).toEqual([5, 4, 5]);
  });

  it("curIdx >= eventLength は null (kt:98)", () => {
    expect(parseScriptNameList(buildNameList(3, ["a", "b", "c"]))).toBe(null);
    expect(parseScriptNameList(buildNameList(2, ["a", "b"]))).toBe(null);
  });

  it("nameLength は最低 1 に丸める (maxOf(buf[cursor],1u), kt:102)", () => {
    // nameLength バイトを 0 にしても 1 として読む。
    const buf = buildNameList(0, ["", "z"]);
    buf[2] = 0; // 1 件目の nameLength を 0 に
    const got = parseScriptNameList(buf);
    expect(got.events[0].nameLength).toBe(1);
  });
});

describe("Bot2Commands (CHSesameBot2Device.kt:73-193)", () => {
  function fakeSession(payload = Buffer.alloc(0)) {
    return {
      request: vi.fn(() => Promise.resolve({ resultCode: 0, payload })),
    };
  }
  const tagBuilder = (tag) => Buffer.from(tag ? [0x00, 0x0e, ...tag] : [0x00, 0x0e]);

  it("click(index) は RUN_SCRIPT_0+index で historyTag を送る (kt:91-96)", async () => {
    const s = fakeSession();
    const c = new Bot2Commands(s, tagBuilder);
    await c.click(3, Buffer.from([0xaa]));
    expect(s.request.mock.calls[0][0]).toBe(173);
    expect(s.request.mock.calls[0][1].equals(Buffer.from([0x00, 0x0e, 0xaa]))).toBe(true);
  });

  it("click() (index 無し) は click(89)", async () => {
    const s = fakeSession();
    const c = new Bot2Commands(s, tagBuilder);
    await c.click();
    expect(s.request.mock.calls[0][0]).toBe(89);
  });

  it("historyTagBLE 未注入でも click は protocol.historyTagBLE を既定で使い最低 [0x00,0x0E] 2B を送る (kt:91-93, P1-10)", async () => {
    // SDK の click は常に sesame2KeyData!!.historyTagBLE(historytag) を payload にする
    // (CHSesameBot2Device.kt:91-93)。tag 無しでも type 2B が乗り、空 payload は存在しない。
    // 旧実装は Bot2Commands を直接 new した (注入無し) とき空 payload を送っていた。
    const s = fakeSession();
    const c = new Bot2Commands(s); // 注入なし → protocol.js の historyTagBLE が既定
    await c.click();
    expect(s.request.mock.calls[0][0]).toBe(89);
    expect(s.request.mock.calls[0][1].equals(Buffer.from([0x00, 0x0e]))).toBe(true);
    // tag 付き: [0x00,0x0E] ++ tag (先頭 20B 切り詰めは historyTagBLE 側の契約)
    await c.click(2, Buffer.from([0xbe, 0xef]));
    expect(s.request.mock.calls[1][0]).toBe(172);
    expect(s.request.mock.calls[1][1].equals(Buffer.from([0x00, 0x0e, 0xbe, 0xef]))).toBe(true);
  });

  it("sendClickScript は EDIT_SCRIPT(181) + [index]+scriptBytes (kt:103-105)", async () => {
    const s = fakeSession();
    const c = new Bot2Commands(s, tagBuilder);
    const script = { name: "x", actions: [{ action: BOT_ACTION_TYPE.FORWARD, time: 9 }] };
    await c.sendClickScript(2, script);
    const [item, data] = s.request.mock.calls[0];
    expect(item).toBe(181);
    expect(data[0]).toBe(2); // index 先頭
    expect(data.subarray(1).equals(scriptToBytes(script))).toBe(true);
  });

  it("sendClickScript は直列化済みバイト列も受ける", async () => {
    const s = fakeSession();
    const c = new Bot2Commands(s, tagBuilder);
    const bytes = scriptToBytes({ name: "y", actions: [] });
    await c.sendClickScript(0, bytes);
    const data = s.request.mock.calls[0][1];
    expect(data.subarray(1).equals(bytes)).toBe(true);
  });

  it("selectScript は SCRIPT_SELECT(94) + [index] (kt:116)", async () => {
    const s = fakeSession();
    const c = new Bot2Commands(s, tagBuilder);
    await c.selectScript(7);
    expect(s.request.mock.calls[0][0]).toBe(94);
    expect(s.request.mock.calls[0][1].equals(Buffer.from([7]))).toBe(true);
  });

  it("getCurrentScript(index) は SCRIPT_CURRENT(95) + [index]、応答を parse (kt:127-136)", async () => {
    const payload = scriptToBytes({ name: "go", actions: [{ action: BOT_ACTION_TYPE.STOP, time: 3 }] });
    const s = fakeSession(payload);
    const c = new Bot2Commands(s, tagBuilder);
    const got = await c.getCurrentScript(4);
    expect(s.request.mock.calls[0][0]).toBe(95);
    expect(s.request.mock.calls[0][1].equals(Buffer.from([4]))).toBe(true);
    expect(got.name.toString("utf8")).toBe("go");
    expect(got.actions).toEqual([{ action: BOT_ACTION_TYPE.STOP, time: 3 }]);
  });

  it("getCurrentScript() (index 無し) は空 data (kt:127)", async () => {
    const payload = scriptToBytes({ name: "z", actions: [] });
    const s = fakeSession(payload);
    const c = new Bot2Commands(s, tagBuilder);
    await c.getCurrentScript();
    expect(s.request.mock.calls[0][1].length).toBe(0);
  });

  it("getScriptNameList は SCRIPT_NAME_LIST(96)、応答を parse し scripts を更新 (kt:163-178)", async () => {
    const field = (n) => { const f = Buffer.alloc(20); Buffer.from(n).copy(f); return Buffer.concat([Buffer.from([n.length]), f]); };
    const payload = Buffer.concat([Buffer.from([0, 2]), field("a"), field("bb")]);
    const s = fakeSession(payload);
    const c = new Bot2Commands(s, tagBuilder);
    expect(c.scripts).toEqual({ curIdx: 0, eventLength: 0, events: [] }); // 初期値 (kt:40-41)
    const got = await c.getScriptNameList();
    expect(s.request.mock.calls[0][0]).toBe(96);
    expect(s.request.mock.calls[0][1].length).toBe(0);
    expect(got.eventLength).toBe(2);
    expect(c.scripts).toBe(got); // キャッシュ更新 (kt:178)
  });

  it("parse 失敗時は明示エラー (curIdx>=eventLength)", async () => {
    const s = fakeSession(Buffer.from([5, 1])); // curIdx=5 >= eventLength=1
    const c = new Bot2Commands(s, tagBuilder);
    await expect(c.getScriptNameList()).rejects.toThrow();
  });
});

describe("devicemodel: bot2/bot3 の script 能力", () => {
  it("bot_2 / bot_3 は script:true、click は ble に残る", () => {
    for (const m of ["bot_2", "bot_3"]) {
      const caps = capabilitiesForModel(m);
      expect(caps.script).toBe(true);
      expect(caps.ble).toContain("click");
      expect(caps.kind).toBe("bot2");
    }
  });
  it("ロック/Bike/Hub3 等は script:false", () => {
    for (const m of ["sesame_5", "bike_2", "hub_3", "ssm_touch", "wm_2"]) {
      expect(capabilitiesForModel(m).script).toBe(false);
    }
  });
});

// iot.js の単体テスト。biz3OperateIoT / op='cmd' の送信フレーム正確性
// (topic 構築 / payload バイト連結順 / base64) と応答パースを検証する。
//
// crypto.cmacTime は時刻依存で非決定的なので、固定値 'aabbccdd' に mock して
// payload のバイト列を決定的に検証する。
import { describe, it, expect, vi } from "vitest";

// cmacTime を固定値にする (sign = 4B = aa bb cc dd)。
vi.mock("../../src/crypto.js", () => ({
  cmacTime: () => "aabbccdd",
}));

import {
  buildIotTopic,
  buildIotPayload,
  sendIotCmd,
  subscribeIotResponse,
  sendIotCmdAwait,
  setHub3LedDuty,
  hub3RelaySwitch,
  addSesameToHub3,
  removeSesameFromHub3,
  startFirmwareUpdate,
  clearHub3WifiSsid,
  getMatterPairingCode,
  openMatterPairingWindow,
  __internal,
} from "../../src/iot.js";

// 最小 mock client: send を記録、subscribe を記録して push を手動発火できる。
function mockClient() {
  const sent = [];
  /** @type {Map<string, Set<Function>>} */
  const subs = new Map();
  return {
    sent,
    subs,
    send(frame) {
      sent.push(frame);
    },
    subscribe(key, fn) {
      let set = subs.get(key);
      if (!set) { set = new Set(); subs.set(key, set); }
      set.add(fn);
      return () => set.delete(fn);
    },
    // テストヘルパー: 指定 key の購読者全員に push
    push(key, msg) {
      const set = subs.get(key);
      if (set) for (const fn of [...set]) fn(msg);
    },
  };
}

// payload(base64) を hex 文字列にデコードして検証しやすくする。
function payloadHex(base64) {
  return Buffer.from(base64, "base64").toString("hex");
}

const HUB3 = "11111111-2222-3333-4444-555555555555";
const SECRET = "00112233445566778899aabbccddeeff"; // 32hex

describe("buildIotTopic", () => {
  it("hub3_id 末尾セグメントから wm2{seg}cmd を作る (大文字小文字変換なし)", () => {
    expect(buildIotTopic(HUB3)).toBe("wm2555555555555cmd");
  });
  it("大文字はそのまま (case 変換しない)", () => {
    expect(buildIotTopic("AAAA-BBBB-CCCCDDDDEEEE")).toBe("wm2CCCCDDDDEEEEcmd");
  });
  it("hub3_id 未指定は throw", () => {
    expect(() => buildIotTopic("")).toThrow(/hub3Id required/);
  });
});

describe("buildIotPayload (バイト連結順)", () => {
  it("sign(4B) + cmd(1B) + device_id UTF8 の順で base64 化", () => {
    const b64 = buildIotPayload({ cmd: 0x03, deviceId: HUB3, secretKey: SECRET });
    const hex = payloadHex(b64);
    // sign = aabbccdd, cmd = 03, device_id = HUB3 を UTF8 (= ASCII) 化した hex
    const didHex = Buffer.from(HUB3, "utf8").toString("hex");
    expect(hex).toBe("aabbccdd" + "03" + didHex);
  });

  it("device_id は hex デコードではなく UTF8 (ハイフン込み36文字=36バイト)", () => {
    const b64 = buildIotPayload({ cmd: 0x03, deviceId: HUB3, secretKey: SECRET });
    const buf = Buffer.from(b64, "base64");
    // 4 (sign) + 1 (cmd) + 36 (UUID 文字列バイト) = 41
    expect(buf.length).toBe(4 + 1 + 36);
  });

  it("cmd は下位8bit のみ採用 (0x15C → 0x5C)", () => {
    const b64 = buildIotPayload({ cmd: 0x15c, deviceId: HUB3, secretKey: SECRET });
    const hex = payloadHex(b64);
    expect(hex.slice(8, 10)).toBe("5c");
  });

  it("extra バイトは末尾に連結", () => {
    const b64 = buildIotPayload({
      cmd: 92,
      deviceId: HUB3,
      secretKey: SECRET,
      extra: new Uint8Array([0x01, 0x64]),
    });
    const hex = payloadHex(b64);
    expect(hex.endsWith("0164")).toBe(true);
  });

  it("必須欠落は throw", () => {
    expect(() => buildIotPayload({ deviceId: HUB3, secretKey: SECRET })).toThrow(/cmd required/);
    expect(() => buildIotPayload({ cmd: 1, secretKey: SECRET })).toThrow(/deviceId required/);
    expect(() => buildIotPayload({ cmd: 1, deviceId: HUB3 })).toThrow(/secretKey required/);
  });
});

describe("sendIotCmd (フレーム)", () => {
  it("{action:'biz3OperateIoT', topic, payload, op:'cmd'} を send", () => {
    const c = mockClient();
    sendIotCmd(c, { topic: "wm2xxxcmd", payload: "QkFTRTY0" });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3OperateIoT",
      topic: "wm2xxxcmd",
      payload: "QkFTRTY0",
      op: "cmd",
    });
  });
  it("op を上書きできる", () => {
    const c = mockClient();
    sendIotCmd(c, { topic: "t", payload: "p", op: "cmd" });
    expect(c.sent[0].op).toBe("cmd");
  });
  it("topic / payload 欠落は throw", () => {
    const c = mockClient();
    expect(() => sendIotCmd(c, { payload: "p" })).toThrow(/topic required/);
    expect(() => sendIotCmd(c, { topic: "t" })).toThrow(/payload required/);
  });
});

describe("subscribeIotResponse", () => {
  it("購読キーは biz3OperateIoT:<数値cmdCode>", () => {
    const c = mockClient();
    const fn = vi.fn();
    subscribeIotResponse(c, 92, fn);
    expect(c.subs.has("biz3OperateIoT:92")).toBe(true);
    c.push("biz3OperateIoT:92", { op: 92, data: { ledDuty: 100 } });
    expect(fn).toHaveBeenCalledWith({ op: 92, data: { ledDuty: 100 } });
  });
});

describe("sendIotCmdAwait", () => {
  it("送信後に op 一致 push を 1 件解決し、UUID で device 照合", async () => {
    const c = mockClient();
    const p = sendIotCmdAwait(c, { topic: "t", payload: "p", cmd: 92, deviceId: HUB3 });
    // 別デバイスの push は無視
    c.push("biz3OperateIoT:92", { op: 92, UUID: "ffffffff-0000-0000-0000-000000000000", data: {} });
    // 対象デバイスの push で解決
    c.push("biz3OperateIoT:92", { op: 92, UUID: HUB3, data: { ledDuty: 50 } });
    const msg = await p;
    expect(msg.data.ledDuty).toBe(50);
    // 送信フレームも確認
    expect(c.sent[0].action).toBe("biz3OperateIoT");
  });

  it("timeout で reject", async () => {
    vi.useFakeTimers();
    const c = mockClient();
    const p = sendIotCmdAwait(c, { topic: "t", payload: "p", cmd: 99, timeoutMs: 1000 });
    const assertion = expect(p).rejects.toThrow(/iot cmd timeout/);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    vi.useRealTimers();
  });
});

describe("setHub3LedDuty (cmdCode=92)", () => {
  it("extra=[op,duty]、topic、cmd、応答 ledDuty を返す", async () => {
    const c = mockClient();
    const p = setHub3LedDuty(c, { deviceId: HUB3, secretKey: SECRET, op: 0x01, duty: 0x64 });
    c.push("biz3OperateIoT:92", { op: 92, UUID: HUB3, data: { ledDuty: 100 } });
    const r = await p;
    expect(r.ledDuty).toBe(100);
    const frame = c.sent[0];
    expect(frame.topic).toBe("wm2555555555555cmd");
    const hex = payloadHex(frame.payload);
    // aabbccdd + 5c(=92) + did + 0164(op,duty)
    expect(hex.startsWith("aabbccdd5c")).toBe(true);
    expect(hex.endsWith("0164")).toBe(true);
  });
  it("op/duty 欠落は throw", async () => {
    const c = mockClient();
    await expect(setHub3LedDuty(c, { deviceId: HUB3, secretKey: SECRET, op: 1 })).rejects.toThrow(/op and duty required/);
  });
  it("範囲外は throw", async () => {
    const c = mockClient();
    await expect(setHub3LedDuty(c, { deviceId: HUB3, secretKey: SECRET, op: 1, duty: 256 })).rejects.toThrow(/out of range/);
  });
});

describe("hub3RelaySwitch (cmdCode=208, fire-and-forget)", () => {
  it("extra=[op] (既定 0x01)、応答待たずに send", () => {
    const c = mockClient();
    hub3RelaySwitch(c, { deviceId: HUB3, secretKey: SECRET });
    expect(c.sent).toHaveLength(1);
    const hex = payloadHex(c.sent[0].payload);
    // aabbccdd + d0(=208) + did + 01(op)
    expect(hex.startsWith("aabbccddd0")).toBe(true);
    expect(hex.endsWith("01")).toBe(true);
  });
  it("op 指定可", () => {
    const c = mockClient();
    hub3RelaySwitch(c, { deviceId: HUB3, secretKey: SECRET, op: 0x02 });
    expect(payloadHex(c.sent[0].payload).endsWith("02")).toBe(true);
  });
});

describe("addSesameToHub3 / removeSesameFromHub3 (cmdCode=101/103)", () => {
  const SESAME = "aabbccdd-eeff-0011-2233-445566778899";
  const SSK = "ffeeddccbbaa99887766554433221100";

  it("ADD: device_id=hub3、extra=sesameId(16)+secret(16)+nameLen(1)+name+pt(1)+matter(1)", async () => {
    const c = mockClient();
    const p = addSesameToHub3(c, {
      hub3Id: HUB3,
      secretKey: SECRET,
      sesameId: SESAME,
      ssmSecKa: SSK,
      nickName: "玄関",
      deviceModel: "sesame_5", // productType 5 → matter 0
    });
    c.push("biz3OperateIoT:101", { op: 101, UUID: HUB3, data: { ssks: [{ id: 1 }] } });
    const r = await p;
    expect(r.ssks).toEqual([{ id: 1 }]);

    const frame = c.sent[0];
    expect(frame.topic).toBe("wm2555555555555cmd");
    const buf = Buffer.from(frame.payload, "base64");
    // header: sign(4) + cmd(1=0x65) + did(hub3 UTF8 36B)
    expect(buf[4]).toBe(0x65); // 101
    const didLen = Buffer.from(HUB3, "utf8").length; // 36
    let off = 4 + 1 + didLen;
    // sesameId 16B (ハイフン除去 hex デコード)
    const sesameBytes = buf.subarray(off, off + 16).toString("hex");
    expect(sesameBytes).toBe(SESAME.replace(/-/g, ""));
    off += 16;
    // secretKey 16B
    expect(buf.subarray(off, off + 16).toString("hex")).toBe(SSK);
    off += 16;
    // nickName length (UTF8 バイト長): "玄関" = 6 バイト
    const nameBytes = Buffer.from("玄関", "utf8");
    expect(buf[off]).toBe(nameBytes.length);
    off += 1;
    expect(buf.subarray(off, off + nameBytes.length).toString("utf8")).toBe("玄関");
    off += nameBytes.length;
    // productType 5, matter 0
    expect(buf[off]).toBe(5);
    expect(buf[off + 1]).toBe(0);
    // 末尾ちょうど
    expect(off + 2).toBe(buf.length);
  });

  it("REMOVE: cmd=0x67 (103) で同形 packing", async () => {
    const c = mockClient();
    const p = removeSesameFromHub3(c, {
      hub3Id: HUB3, secretKey: SECRET, sesameId: SESAME, ssmSecKa: SSK,
      nickName: "x", deviceModel: "sesame_5",
    });
    c.push("biz3OperateIoT:103", { op: 103, UUID: HUB3, data: { ssks: [] } });
    await p;
    const buf = Buffer.from(c.sent[0].payload, "base64");
    expect(buf[4]).toBe(0x67); // 103
  });

  it("nickName 空でも nameLen=0 で連結", () => {
    const extra = __internal.buildSesameItemExtra({
      sesameId: SESAME, ssmSecKa: SSK, deviceModel: "sesame_5",
    });
    // 16 + 16 + 1(len=0) + 0 + 1(pt) + 1(matter) = 35
    expect(extra.length).toBe(35);
    expect(extra[32]).toBe(0); // nameLen
  });

  it("必須欠落は throw", async () => {
    const c = mockClient();
    await expect(addSesameToHub3(c, { secretKey: SECRET, sesameId: SESAME, ssmSecKa: SSK, deviceModel: "sesame_5" }))
      .rejects.toThrow(/hub3Id required/);
  });

  it("未知の deviceModel は productType=0 を黙って送らず throw する", () => {
    expect(() => __internal.buildSesameItemExtra({
      sesameId: SESAME, ssmSecKa: SSK, deviceModel: "__nope__",
    })).toThrow(/未知の deviceModel/);
  });
});

describe("startFirmwareUpdate (cmdCode=0x03, long-running)", () => {
  it("payload は sign+cmd+device_id のみ、進捗を複数回受ける", () => {
    const c = mockClient();
    const progress = [];
    const unsub = startFirmwareUpdate(c, {
      deviceId: HUB3, secretKey: SECRET,
      onProgress: (d) => progress.push(d),
    });
    // 送信フレーム
    const buf = Buffer.from(c.sent[0].payload, "base64");
    expect(buf.length).toBe(4 + 1 + 36); // 追加バイト無し
    expect(buf[4]).toBe(0x03);
    // 複数回 push
    c.push("biz3OperateIoT:3", { op: 3, UUID: HUB3, data: { progress: 30 } });
    c.push("biz3OperateIoT:3", { op: 3, UUID: HUB3, data: { progress: 100, versionTag: "1.2.3" } });
    expect(progress).toEqual([{ progress: 30 }, { progress: 100, versionTag: "1.2.3" }]);
    unsub();
    // unsubscribe 後は届かない
    c.push("biz3OperateIoT:3", { op: 3, UUID: HUB3, data: { progress: 0 } });
    expect(progress).toHaveLength(2);
  });
});

describe("clearHub3WifiSsid (cmdCode=210, fire-and-forget)", () => {
  it("追加バイト無し、send のみ", () => {
    const c = mockClient();
    clearHub3WifiSsid(c, { deviceId: HUB3, secretKey: SECRET });
    const buf = Buffer.from(c.sent[0].payload, "base64");
    expect(buf.length).toBe(4 + 1 + 36);
    expect(buf[4]).toBe(0xd2); // 210
  });
});

describe("getMatterPairingCode (cmdCode=137)", () => {
  it("payload は sign+cmd+device_id、応答 qrCode/manualCode を返す", async () => {
    const c = mockClient();
    const p = getMatterPairingCode(c, { deviceId: HUB3, secretKey: SECRET });
    c.push("biz3OperateIoT:137", { op: 137, UUID: HUB3, data: { qrCode: "MT:XXX", manualCode: "123-456" } });
    const r = await p;
    expect(r.qrCode).toBe("MT:XXX");
    expect(r.manualCode).toBe("123-456");
    const buf = Buffer.from(c.sent[0].payload, "base64");
    expect(buf[4]).toBe(0x89); // 137
    expect(buf.length).toBe(4 + 1 + 36);
  });
});

describe("openMatterPairingWindow (cmdCode=153)", () => {
  it("応答 statusCode を返す", async () => {
    const c = mockClient();
    const p = openMatterPairingWindow(c, { deviceId: HUB3, secretKey: SECRET });
    c.push("biz3OperateIoT:153", { op: 153, UUID: HUB3, data: { statusCode: 0 } });
    const r = await p;
    expect(r.statusCode).toBe(0);
    const buf = Buffer.from(c.sent[0].payload, "base64");
    expect(buf[4]).toBe(0x99); // 153
  });
});

describe("__internal helpers (biz3utils 移植)", () => {
  it("hexStringToUint8Array: 2文字ずつ、null/undefined は空", () => {
    expect([...__internal.hexStringToUint8Array("00ff10")]).toEqual([0, 255, 16]);
    expect(__internal.hexStringToUint8Array(null).length).toBe(0);
    expect(__internal.hexStringToUint8Array(undefined).length).toBe(0);
    expect(() => __internal.hexStringToUint8Array("abc")).toThrow(/Invalid hexString/);
  });
  it("stringToUint8Array: UTF8 エンコード", () => {
    expect([...__internal.stringToUint8Array("AB")]).toEqual([0x41, 0x42]);
    // "玄" = E7 8E 84
    expect([...__internal.stringToUint8Array("玄")]).toEqual([0xe7, 0x8e, 0x84]);
  });
  it("getProductTypeFromModelName: 逆引き、未知は null", () => {
    expect(__internal.getProductTypeFromModelName("sesame_5")).toBe(5);
    expect(__internal.getProductTypeFromModelName("hub_3")).toBe(13);
    expect(__internal.getProductTypeFromModelName("__nope__")).toBe(null);
  });
  it("getMatterProductTypeFromModelName: map 通り (5→0, 17→1, 13→255)", () => {
    expect(__internal.getMatterProductTypeFromModelName("sesame_5")).toBe(0); // pt 5
    expect(__internal.getMatterProductTypeFromModelName("bot_2")).toBe(1);    // pt 17
    expect(__internal.getMatterProductTypeFromModelName("hub_3")).toBe(255);  // pt 13
    expect(__internal.getMatterProductTypeFromModelName("__nope__")).toBe(null);
    // pt 29 (sesame_miwa) は map に無い → undefined (biz3 でもコメントアウト)
    expect(__internal.getMatterProductTypeFromModelName("sesame_miwa")).toBeUndefined();
  });
  it("concatBytes: 順序保持で連結", () => {
    const r = __internal.concatBytes(new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5]));
    expect([...r]).toEqual([1, 2, 3, 4, 5]);
  });
});

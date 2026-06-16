// packages/core/tests/_spec/iot-c0.test.js
//
// IOT spec テスト: IOT-0001 〜 IOT-0018
//
// 対象実装: packages/core/src/iot.js
//
// 方針:
//   - crypto.cmacTime を固定値 'aabbccdd' に mock して決定論的に検証。
//   - ネットワーク/実機不使用。chunkMockClient + push() で疑似配信。
//   - 期待値は spec どおり (TDD: red になってよい)。

// ---------- mock (import より前に宣言) ----------
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../src/crypto.js", async (importOriginal) => ({
  .../** @type {object} */ (await importOriginal()),
  cmacTime: () => "aabbccdd",
}));

// ---------- 実装 import ----------
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
  NAMESPACE_OPS,
} from "../../src/iot.js";

import { SesameError, ERR } from "../../src/errors.js";
import { chunkMockClient } from "../helpers/mock-ws.js";

// ---------- テストユーティリティ ----------

/** base64 payload を hex 文字列に変換 */
function payloadHex(base64) {
  return Buffer.from(base64, "base64").toString("hex");
}

const HUB3 = "11111111-2222-3333-4444-555555555555";
const SECRET = "00112233445566778899aabbccddeeff"; // 32hex

// 定数 (payload 検証に使う)
const SIGN_HEX = "aabbccdd";
const CMD_LED_HEX = "5c"; // 92 = 0x5C
const DID_HEX = Buffer.from(HUB3.toUpperCase(), "utf8").toString("hex"); // 36バイト分

// =====================================================================
// IOT-0001  sendIotCmd 送信フレーム封筒 {action:'biz3OperateIoT', topic, payload, op}
// =====================================================================

describe("[IOT-0001] sendIotCmd 送信フレーム封筒 {action:'biz3OperateIoT', topic, payload, op}", () => {
  it("[IOT-0001] op 省略時は既定 'cmd' で {action,topic,payload,op} のみ送る", () => {
    const c = chunkMockClient();
    sendIotCmd(c, { topic: "wm2555555555555cmd", payload: "QkFTRTY0" });
    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];
    // キー集合: action/topic/payload/op のみ (companyID/apiKeyId/connectionId は付けない)
    expect(Object.keys(frame).sort()).toEqual(
      ["action", "op", "payload", "topic"].sort()
    );
    expect(frame.action).toBe("biz3OperateIoT");
    expect(frame.topic).toBe("wm2555555555555cmd");
    expect(frame.payload).toBe("QkFTRTY0");
    expect(frame.op).toBe("cmd");
    // connectionId はクラウド自動付与なのでフレームに含めない
    expect(frame).not.toHaveProperty("connectionId");
    expect(frame).not.toHaveProperty("companyID");
    expect(frame).not.toHaveProperty("apiKeyId");
  });

  it("[IOT-0001] op 明示指定時はその値が乗る", () => {
    const c = chunkMockClient();
    sendIotCmd(c, { topic: "wm2ABCcmd", payload: "AAAA", op: "custom" });
    expect(c.sent[0].op).toBe("custom");
  });
});

// =====================================================================
// IOT-0002  sendIotCmd 必須検証 (topic/payload 欠落で badRequest)
// =====================================================================

describe("[IOT-0002] sendIotCmd 必須検証 (topic/payload 欠落で badRequest)", () => {
  it("[IOT-0002] topic 欠落で SesameError(bad_request) を throw し send しない", () => {
    const c = chunkMockClient();
    let err;
    try {
      sendIotCmd(c, { payload: "p" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/topic required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[IOT-0002] payload 欠落で SesameError(bad_request) を throw し send しない", () => {
    const c = chunkMockClient();
    let err;
    try {
      sendIotCmd(c, { topic: "t" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/payload required/);
    expect(c.sent).toHaveLength(0);
  });
});

// =====================================================================
// IOT-0003  buildIotTopic = wm2{末尾セグメント大文字}cmd
// =====================================================================

describe("[IOT-0003] buildIotTopic = wm2{末尾セグメント大文字}cmd", () => {
  it("[IOT-0003] hub3Id 末尾セグメントから wm2{SEG}cmd を生成する", () => {
    // HUB3 末尾セグメント = 555555555555
    expect(buildIotTopic(HUB3)).toBe("wm2555555555555cmd");
  });

  it("[IOT-0003] 別の hub3Id でも末尾セグメントが正しく取れる (大文字入力)", () => {
    expect(buildIotTopic("aaaabbbb-cccc-dddd-eeee-FFFF00001234")).toBe("wm2FFFF00001234cmd");
  });

  it("[IOT-0003] vendor sendCommandToHub3WithConnectionId と同一形式: wm2{lastSeg大文字}cmd", () => {
    const hub3Id = "aabbccdd-1122-3344-5566-778899aabbcc";
    const lastSeg = hub3Id.split("-").pop().toUpperCase();
    expect(buildIotTopic(hub3Id)).toBe(`wm2${lastSeg}cmd`);
  });
});

// =====================================================================
// IOT-0004  buildIotTopic 末尾セグメント uppercase 正規化 (App方式)
// =====================================================================

describe("[IOT-0004] buildIotTopic 末尾セグメント uppercase 正規化 (CHAPIClientBiz.kt:235)", () => {
  it("[IOT-0004] 小文字入力でも末尾セグメントが toUpperCase される", () => {
    expect(buildIotTopic("aaaa-bbbb-cccc-dddd-abcdef012345")).toBe("wm2ABCDEF012345cmd");
  });

  it("[IOT-0004] 混在入力でも大文字正規化される", () => {
    expect(buildIotTopic("aaaa-bbbb-cccc-dddd-AbCdEf012345")).toBe("wm2ABCDEF012345cmd");
  });

  it("[IOT-0004] 全大文字入力はそのまま通る (べき等)", () => {
    expect(buildIotTopic("AAAA-BBBB-CCCC-DDDD-AABBCCDDEEFF")).toBe("wm2AABBCCDDEEFFcmd");
  });
});

// =====================================================================
// IOT-0005  buildIotTopic は hub3Id 必須 (空は badRequest)
// =====================================================================

describe("[IOT-0005] buildIotTopic hub3Id 必須 (空/undefined で iot.err.hub3IdRequiredTopic)", () => {
  it("[IOT-0005] 空文字で SesameError(bad_request) を throw する", () => {
    let err;
    try {
      buildIotTopic("");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.message).toMatch(/hub3Id required/);
  });

  it("[IOT-0005] undefined で SesameError(bad_request) を throw する", () => {
    expect(() => buildIotTopic(undefined)).toThrow(/hub3Id required/);
  });

  it("[IOT-0005] null で SesameError(bad_request) を throw する", () => {
    expect(() => buildIotTopic(null)).toThrow(/hub3Id required/);
  });
});

// =====================================================================
// IOT-0006  buildIotPayload 連結順 sign(4B)++cmd(1B)++deviceId(UTF8)(++extra)
// =====================================================================

describe("[IOT-0006] buildIotPayload 連結順 sign(4B)++cmd(1B)++deviceId(UTF8)(++extra)", () => {
  it("[IOT-0006] extra 無しで sign(4B)++cmd(1B)++deviceId(UTF8) の base64 になる", () => {
    const b64 = buildIotPayload({ cmd: 0x03, deviceId: HUB3, secretKey: SECRET });
    const hex = payloadHex(b64);
    // sign = aabbccdd (mock), cmd = 03, deviceId = HUB3 大文字を UTF8 化した hex
    expect(hex).toBe(SIGN_HEX + "03" + DID_HEX);
  });

  it("[IOT-0006] extra 有りで末尾に連結される", () => {
    const extra = new Uint8Array([0x01, 0x64]);
    const b64 = buildIotPayload({ cmd: 92, deviceId: HUB3, secretKey: SECRET, extra });
    const hex = payloadHex(b64);
    expect(hex).toBe(SIGN_HEX + CMD_LED_HEX + DID_HEX + "0164");
  });
});

// =====================================================================
// IOT-0007  buildIotPayload device_id は UTF8 36バイト (hex デコードしない)
// =====================================================================

describe("[IOT-0007] buildIotPayload device_id は UTF8 36バイト (hex デコードしない)", () => {
  it("[IOT-0007] payload 全長は 4+1+36 = 41 バイト (extra 無し)", () => {
    const b64 = buildIotPayload({ cmd: 0x03, deviceId: HUB3, secretKey: SECRET });
    const buf = Buffer.from(b64, "base64");
    expect(buf.length).toBe(4 + 1 + 36);
  });

  it("[IOT-0007] device_id バイトはハイフン込み UUID 文字列の UTF8 バイト (TextEncoder 相当)", () => {
    const b64 = buildIotPayload({ cmd: 0x01, deviceId: HUB3, secretKey: SECRET });
    const hex = payloadHex(b64);
    // sign(8hex)+cmd(2hex) の後が DID_HEX
    expect(hex.slice(10)).toBe(DID_HEX);
  });

  it("[IOT-0007] extra 有りでは全長 4+1+36+extra.length になる", () => {
    const extra = new Uint8Array([0xaa, 0xbb]);
    const b64 = buildIotPayload({ cmd: 1, deviceId: HUB3, secretKey: SECRET, extra });
    const buf = Buffer.from(b64, "base64");
    expect(buf.length).toBe(4 + 1 + 36 + 2);
  });
});

// =====================================================================
// IOT-0008  buildIotPayload device_id を toUpperCase してから UTF8 化
// =====================================================================

describe("[IOT-0008] buildIotPayload device_id を toUpperCase 正規化 (CHAPIClientBiz.kt:216-217)", () => {
  it("[IOT-0008] 小文字 deviceId でも大文字 UUID の UTF8 バイトが payload に入る", () => {
    const lowerUuid = "aabbccdd-1122-3344-5566-778899aabbcc";
    const b64 = buildIotPayload({ cmd: 0x01, deviceId: lowerUuid, secretKey: SECRET });
    const hex = payloadHex(b64);
    const expectedDidHex = Buffer.from(lowerUuid.toUpperCase(), "utf8").toString("hex");
    expect(hex.slice(10)).toBe(expectedDidHex);
  });

  it("[IOT-0008] 大文字入力は変化しない (べき等)", () => {
    const upperUuid = "AABBCCDD-1122-3344-5566-778899AABBCC";
    const b64 = buildIotPayload({ cmd: 0x01, deviceId: upperUuid, secretKey: SECRET });
    const hex = payloadHex(b64);
    const expectedDidHex = Buffer.from(upperUuid, "utf8").toString("hex");
    expect(hex.slice(10)).toBe(expectedDidHex);
  });
});

// =====================================================================
// IOT-0009  buildIotPayload cmd 下位8bit のみ採用 (cmd & 0xff)
// =====================================================================

describe("[IOT-0009] buildIotPayload cmd 下位8bit のみ採用 (cmd & 0xff)", () => {
  it("[IOT-0009] 0x15C (348) → 下位8bit の 0x5C (92) が payload[4] に入る", () => {
    const b64 = buildIotPayload({ cmd: 0x15c, deviceId: HUB3, secretKey: SECRET });
    const hex = payloadHex(b64);
    expect(hex.slice(8, 10)).toBe("5c");
  });

  it("[IOT-0009] 0xff は 0xff のまま (境界値)", () => {
    const b64 = buildIotPayload({ cmd: 0xff, deviceId: HUB3, secretKey: SECRET });
    const hex = payloadHex(b64);
    expect(hex.slice(8, 10)).toBe("ff");
  });

  it("[IOT-0009] 0x100 は 0x00 になる (8bit ラップ)", () => {
    const b64 = buildIotPayload({ cmd: 0x100, deviceId: HUB3, secretKey: SECRET });
    const hex = payloadHex(b64);
    expect(hex.slice(8, 10)).toBe("00");
  });
});

// =====================================================================
// IOT-0010  buildIotPayload 必須欠落検証 (cmd/deviceId/secretKey)
// =====================================================================

describe("[IOT-0010] buildIotPayload 必須欠落検証 (cmd/deviceId/secretKey)", () => {
  it("[IOT-0010] cmd undefined で SesameError(bad_request) を throw する", () => {
    let err;
    try {
      buildIotPayload({ deviceId: HUB3, secretKey: SECRET });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.message).toMatch(/cmd required/);
  });

  it("[IOT-0010] cmd が string でも非 number として弾かれる", () => {
    expect(() =>
      buildIotPayload({ cmd: "92", deviceId: HUB3, secretKey: SECRET })
    ).toThrow(/cmd required/);
  });

  it("[IOT-0010] deviceId 空文字で SesameError(bad_request) を throw する", () => {
    let err;
    try {
      buildIotPayload({ cmd: 1, deviceId: "", secretKey: SECRET });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.message).toMatch(/deviceId required/);
  });

  it("[IOT-0010] secretKey 空文字で SesameError(bad_request) を throw する", () => {
    let err;
    try {
      buildIotPayload({ cmd: 1, deviceId: HUB3, secretKey: "" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.message).toMatch(/secretKey required/);
  });
});

// =====================================================================
// IOT-0011  sign = cmacTime(secretKey) の 8hex を 4B 復元して payload 先頭連結
// =====================================================================

describe("[IOT-0011] sign = cmacTime(secretKey) の 8hex を 4B 復元して payload 先頭連結", () => {
  it("[IOT-0011] cmacTime が 'aabbccdd' を返すとき payload 先頭 4B は 0xaa 0xbb 0xcc 0xdd", () => {
    const b64 = buildIotPayload({ cmd: 0x03, deviceId: HUB3, secretKey: SECRET });
    const buf = Buffer.from(b64, "base64");
    expect(buf[0]).toBe(0xaa);
    expect(buf[1]).toBe(0xbb);
    expect(buf[2]).toBe(0xcc);
    expect(buf[3]).toBe(0xdd);
  });

  it("[IOT-0011] sign は 4B ちょうど (hexStringToUint8Array('aabbccdd').length === 4)", () => {
    const signArr = __internal.hexStringToUint8Array("aabbccdd");
    expect(signArr.length).toBe(4);
  });
});

// =====================================================================
// IOT-0012  hexStringToUint8Array: null/undefined→空・偶数hex変換・奇数/非hex→throw
// =====================================================================

describe("[IOT-0012] hexStringToUint8Array: iot 固有境界 (null→空, 奇数/非hex→badRequest 再ラップ)", () => {
  it("[IOT-0012] null は Uint8Array(0) を返す", () => {
    const result = __internal.hexStringToUint8Array(null);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(0);
  });

  it("[IOT-0012] undefined は Uint8Array(0) を返す", () => {
    const result = __internal.hexStringToUint8Array(undefined);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(0);
  });

  it("[IOT-0012] 偶数長 hex は正しく変換される", () => {
    expect([...__internal.hexStringToUint8Array("00ff10")]).toEqual([0, 255, 16]);
    expect([...__internal.hexStringToUint8Array("aabbccdd")]).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
  });

  it("[IOT-0012] 奇数長 hex は SesameError(bad_request) に再ラップされる", () => {
    let err;
    try {
      __internal.hexStringToUint8Array("abc");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.message).toMatch(/Invalid hexString/);
  });

  it("[IOT-0012] 非 hex 文字を含む偶数長は SesameError(bad_request) に再ラップされる", () => {
    let err;
    try {
      __internal.hexStringToUint8Array("zzzz");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.message).toMatch(/Invalid hexString/);
  });
});

// =====================================================================
// IOT-0013  subscribeIotResponse 購読キー biz3OperateIoT:<数値cmdCode>
// =====================================================================

describe("[IOT-0013] subscribeIotResponse 購読キー biz3OperateIoT:<数値cmdCode>", () => {
  it("[IOT-0013] 購読キーは 'biz3OperateIoT:<cmd>' になる (cmd=92)", () => {
    const c = chunkMockClient();
    const fn = vi.fn();
    subscribeIotResponse(c, 92, fn);
    expect(c.subs.has("biz3OperateIoT:92")).toBe(true);
  });

  it("[IOT-0013] push(key, msg) で購読コールバックが呼ばれる", () => {
    const c = chunkMockClient();
    const fn = vi.fn();
    subscribeIotResponse(c, 92, fn);
    c.push("biz3OperateIoT:92", { op: 92, data: { ledDuty: 100 } });
    expect(fn).toHaveBeenCalledWith({ op: 92, data: { ledDuty: 100 } });
  });

  it("[IOT-0013] cmdCode=3 (ssmOSUpdate) は 'biz3OperateIoT:3' で購読される", () => {
    const c = chunkMockClient();
    const fn = vi.fn();
    subscribeIotResponse(c, 3, fn);
    expect(c.subs.has("biz3OperateIoT:3")).toBe(true);
  });

  it("[IOT-0013] unsubscribe 後は push が届かない", () => {
    const c = chunkMockClient();
    const fn = vi.fn();
    const unsub = subscribeIotResponse(c, 92, fn);
    unsub();
    c.push("biz3OperateIoT:92", { op: 92 });
    expect(fn).not.toHaveBeenCalled();
  });
});

// =====================================================================
// IOT-0014  sendIotCmdAwait: 購読確立後に送信し op 一致 push を1件で解決
// =====================================================================

describe("[IOT-0014] sendIotCmdAwait: 購読確立後に送信し op 一致 push を1件で解決 (race防止)", () => {
  it("[IOT-0014] subscribe を先に張ってから sendIotCmd し、op 一致 push 1件で resolve する", async () => {
    const c = chunkMockClient();
    const p = sendIotCmdAwait(c, { topic: "wm2ABCcmd", payload: "QkFTRTY0", cmd: 92, deviceId: HUB3 });

    // 購読が確立済み (race 防止確認)
    expect(c.subs.has("biz3OperateIoT:92")).toBe(true);
    // 送信がされている
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0].action).toBe("biz3OperateIoT");

    // op 一致 push で resolve
    c.push("biz3OperateIoT:92", { op: 92, UUID: HUB3, data: { ledDuty: 50 } });
    const msg = await p;
    expect(msg.data.ledDuty).toBe(50);
  });

  it("[IOT-0014] 解決後は unsub されている (2件目の push は無視)", async () => {
    const c = chunkMockClient();
    const p = sendIotCmdAwait(c, { topic: "t", payload: "p", cmd: 92, deviceId: HUB3 });
    c.push("biz3OperateIoT:92", { op: 92, UUID: HUB3, data: { ledDuty: 50 } });
    await p;
    // 購読が解除されている
    expect(c.subs.get("biz3OperateIoT:92")?.size).toBe(0);
  });

  it("[IOT-0014] 送信フレームの action は biz3OperateIoT で topic が一致する", async () => {
    const c = chunkMockClient();
    const p = sendIotCmdAwait(c, { topic: "wm2XYZcmd", payload: "p", cmd: 92 });
    c.push("biz3OperateIoT:92", { op: 92, data: {} });
    await p;
    expect(c.sent[0].action).toBe("biz3OperateIoT");
    expect(c.sent[0].topic).toBe("wm2XYZcmd");
  });
});

// =====================================================================
// IOT-0015  sendIotCmdAwait: device 照合は msg.UUID || msg.touch_id
// =====================================================================

describe("[IOT-0015] sendIotCmdAwait: device 照合は msg.UUID || msg.touch_id", () => {
  it("[IOT-0015] deviceId 指定時: 不一致 UUID の push を無視し一致 UUID で resolve", async () => {
    const c = chunkMockClient();
    const other = "ffffffff-0000-0000-0000-000000000000";
    const p = sendIotCmdAwait(c, { topic: "t", payload: "p", cmd: 92, deviceId: HUB3 });

    // 別デバイスからの push は無視
    c.push("biz3OperateIoT:92", { op: 92, UUID: other, data: { ledDuty: 99 } });
    // 対象デバイスの push で resolve
    c.push("biz3OperateIoT:92", { op: 92, UUID: HUB3, data: { ledDuty: 42 } });
    const msg = await p;
    expect(msg.data.ledDuty).toBe(42);
  });

  it("[IOT-0015] touch_id による照合も機能する", async () => {
    const c = chunkMockClient();
    const p = sendIotCmdAwait(c, { topic: "t", payload: "p", cmd: 92, deviceId: HUB3 });
    c.push("biz3OperateIoT:92", { op: 92, touch_id: HUB3, data: { ledDuty: 7 } });
    const msg = await p;
    expect(msg.data.ledDuty).toBe(7);
  });

  it("[IOT-0015] deviceId 省略時は最初の op 一致 push を採用 (照合スキップ)", async () => {
    const c = chunkMockClient();
    const p = sendIotCmdAwait(c, { topic: "t", payload: "p", cmd: 92 }); // deviceId 省略
    c.push("biz3OperateIoT:92", { op: 92, UUID: "any-device", data: { ledDuty: 5 } });
    const msg = await p;
    expect(msg.data.ledDuty).toBe(5);
  });
});

// =====================================================================
// IOT-0016  sendIotCmdAwait: timeout で timeoutError reject (既定10s)
// =====================================================================

describe("[IOT-0016] sendIotCmdAwait: timeout で timeoutError reject + unsubscribe", () => {
  afterEach(() => vi.useRealTimers());

  it("[IOT-0016] 既定 DEFAULT_TIMEOUT_MS=10000 で timeout reject される", async () => {
    vi.useFakeTimers();
    const c = chunkMockClient();
    const p = sendIotCmdAwait(c, { topic: "t", payload: "p", cmd: 99 });
    const assertion = expect(p).rejects.toMatchObject({
      message: expect.stringMatching(/timeout/i),
    });
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
  });

  it("[IOT-0016] カスタム timeoutMs 経過で timeoutError を reject する", async () => {
    vi.useFakeTimers();
    const c = chunkMockClient();
    const p = sendIotCmdAwait(c, { topic: "t", payload: "p", cmd: 99, timeoutMs: 500 });
    const assertion = expect(p).rejects.toMatchObject({
      message: expect.stringMatching(/timeout/i),
    });
    await vi.advanceTimersByTimeAsync(501);
    await assertion;
  });

  it("[IOT-0016] timeout 後は購読が解除されている", async () => {
    vi.useFakeTimers();
    const c = chunkMockClient();
    const p = sendIotCmdAwait(c, { topic: "t", payload: "p", cmd: 55, timeoutMs: 200 });
    // catch を先に登録してから時間を進める (unhandled rejection 回避)
    const settled = p.catch(() => {});
    await vi.advanceTimersByTimeAsync(201);
    await settled;
    // 購読が解除されている
    expect(c.subs.get("biz3OperateIoT:55")?.size ?? 0).toBe(0);
  });
});

// =====================================================================
// IOT-0017  sendIotCmdAwait 並行呼び出しの応答相関 (同一 op 複数待ち)
// =====================================================================

describe("[IOT-0017] sendIotCmdAwait 並行呼び出しの応答相関 (同一 op 複数待ち)", () => {
  it("[IOT-0017] 同一 op・異なる deviceId の並行待ちがそれぞれの push で独立解決する", async () => {
    const c = chunkMockClient();
    const deviceA = "aaaaaaaa-0000-0000-0000-000000000000";
    const deviceB = "bbbbbbbb-0000-0000-0000-000000000000";

    const pA = sendIotCmdAwait(c, { topic: "t", payload: "p", cmd: 92, deviceId: deviceA });
    const pB = sendIotCmdAwait(c, { topic: "t", payload: "p", cmd: 92, deviceId: deviceB });

    // B へのレスポンスを先に届ける → pA は無視、pB のみ解決
    c.push("biz3OperateIoT:92", { op: 92, UUID: deviceB, data: { ledDuty: 20 } });
    const msgB = await pB;
    expect(msgB.data.ledDuty).toBe(20);

    // A へのレスポンス
    c.push("biz3OperateIoT:92", { op: 92, UUID: deviceA, data: { ledDuty: 10 } });
    const msgA = await pA;
    expect(msgA.data.ledDuty).toBe(10);
  });

  it("[IOT-0017] deviceId 無し並行待ちは最初の push をそれぞれ採用 (fan-out)", async () => {
    const c = chunkMockClient();
    const p1 = sendIotCmdAwait(c, { topic: "t", payload: "p", cmd: 137 });
    const p2 = sendIotCmdAwait(c, { topic: "t", payload: "p", cmd: 137 });
    // 同一 push が fan-out で両者に届く
    c.push("biz3OperateIoT:137", { op: 137, data: { qrCode: "MT:X" } });
    const [m1, m2] = await Promise.all([p1, p2]);
    expect(m1.data.qrCode).toBe("MT:X");
    expect(m2.data.qrCode).toBe("MT:X");
  });
});

// =====================================================================
// IOT-0018  setHub3LedDuty (cmd=92) extra=[op(1B),duty(1B)]・set=0x01/get=0x02
// =====================================================================

describe("[IOT-0018] setHub3LedDuty (cmd=92) extra=[op(1B),duty(1B)]・set=0x01/get=0x02", () => {
  it("[IOT-0018] set (op=0x01) で extra=[0x01,duty] が payload 末尾に入り ledDuty を返す", async () => {
    const c = chunkMockClient();
    const p = setHub3LedDuty(c, {
      deviceId: HUB3,
      secretKey: SECRET,
      op: 0x01,
      duty: 0x64, // 100
    });
    c.push("biz3OperateIoT:92", { op: 92, UUID: HUB3, data: { ledDuty: 100 } });
    const r = await p;

    // 応答 data.ledDuty を返す
    expect(r.ledDuty).toBe(100);

    const frame = c.sent[0];
    expect(frame.action).toBe("biz3OperateIoT");
    // hub3Id 省略 → deviceId から topic 構築
    expect(frame.topic).toBe("wm2555555555555cmd");

    const hex = payloadHex(frame.payload);
    // sign(4B)+cmd=0x5C(1B)+did(36B)+extra[op=0x01,duty=0x64]
    expect(hex.startsWith(SIGN_HEX + CMD_LED_HEX)).toBe(true);
    expect(hex.endsWith("0164")).toBe(true);

    // cmd byte (payload[4]) = 92
    const buf = Buffer.from(frame.payload, "base64");
    expect(buf[4]).toBe(92);
  });

  it("[IOT-0018] get (op=0x02) でも duty バイトを送る (vendor getLEDBrightness は duty:100 ダミー)", async () => {
    const c = chunkMockClient();
    const p = setHub3LedDuty(c, {
      deviceId: HUB3,
      secretKey: SECRET,
      op: 0x02, // get
      duty: 0,  // ダミー (get でも duty 必須)
    });
    c.push("biz3OperateIoT:92", { op: 92, UUID: HUB3, data: { ledDuty: 80 } });
    const r = await p;
    expect(r.ledDuty).toBe(80);
    const hex = payloadHex(c.sent[0].payload);
    // extra = [0x02, 0x00]
    expect(hex.endsWith("0200")).toBe(true);
  });

  it("[IOT-0018] hub3Id 指定時は hub3Id から topic を構築する", async () => {
    const c = chunkMockClient();
    const hub3Id = "99999999-8888-7777-6666-aabbccddeeff";
    const p = setHub3LedDuty(c, {
      deviceId: HUB3,
      secretKey: SECRET,
      hub3Id,
      op: 0x01,
      duty: 50,
    });
    c.push("biz3OperateIoT:92", { op: 92, UUID: HUB3, data: { ledDuty: 50 } });
    await p;
    const lastSeg = hub3Id.split("-").pop().toUpperCase();
    expect(c.sent[0].topic).toBe(`wm2${lastSeg}cmd`);
  });

  it("[IOT-0018] op/duty 欠落で SesameError(bad_request) を throw する", async () => {
    const c = chunkMockClient();
    // duty 欠落
    await expect(
      setHub3LedDuty(c, { deviceId: HUB3, secretKey: SECRET, op: 0x01 })
    ).rejects.toThrow(/op and duty required/);
    // op 欠落
    await expect(
      setHub3LedDuty(c, { deviceId: HUB3, secretKey: SECRET, duty: 100 })
    ).rejects.toThrow(/op and duty required/);
  });

  it("[IOT-0018] duty が 256 で SesameError(bad_request) を throw する (範囲外)", async () => {
    const c = chunkMockClient();
    await expect(
      setHub3LedDuty(c, { deviceId: HUB3, secretKey: SECRET, op: 0x01, duty: 256 })
    ).rejects.toThrow(/out of range/);
  });

  it("[IOT-0018] op が -1 で SesameError(bad_request) を throw する (範囲外)", async () => {
    const c = chunkMockClient();
    await expect(
      setHub3LedDuty(c, { deviceId: HUB3, secretKey: SECRET, op: -1, duty: 100 })
    ).rejects.toThrow(/out of range/);
  });
});

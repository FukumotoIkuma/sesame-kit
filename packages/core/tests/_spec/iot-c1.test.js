// packages/core/tests/_spec/iot-c1.test.js
// Spec-driven tests for IOT-0019 through IOT-0036 (iot domain).
// Merged from two independent implementations (A & B).
// Each it() is prefixed with the spec ID. TDD: red tests are acceptable.
// No network / BLE / real device access — all mocked or pure-function.

import { describe, it, expect, vi } from "vitest";

// cmacTime is time-dependent; pin to a fixed 4B value for deterministic payloads.
vi.mock("../../src/crypto.js", async (importOriginal) => ({
  .../** @type {object} */ (await importOriginal()),
  cmacTime: () => "aabbccdd",
}));

import {
  setHub3LedDuty,
  hub3RelaySwitch,
  buildIotPayload,
  addSesameToHub3,
  removeSesameFromHub3,
  startFirmwareUpdate,
  clearHub3WifiSsid,
  getMatterPairingCode,
  openMatterPairingWindow,
  NAMESPACE_OPS,
  __internal,
} from "../../src/iot.js";

import { cmdCode } from "../../src/vendor/biz3/constants/cmdCode.js";
import { chunkMockClient } from "../helpers/mock-ws.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** base64 → hex string */
function payloadHex(base64) {
  return Buffer.from(base64, "base64").toString("hex");
}

/** base64 → Buffer */
function payloadBuf(base64) {
  return Buffer.from(base64, "base64");
}

const HUB3   = "11111111-2222-3333-4444-555555555555";
const SECRET = "00112233445566778899aabbccddeeff"; // 32hex
const SESAME = "aabbccdd-eeff-0011-2233-445566778899";
const SSK    = "ffeeddccbbaa99887766554433221100"; // 32hex

// HUB3 末尾セグメント (大文字): 555555555555
const LAST_SEG = "555555555555";

// ---------------------------------------------------------------------------
// [IOT-0019] setHub3LedDuty: op/duty 必須・範囲検証 (0..255)
// ref: useIotCtrl.js:169-178; iot.js:277-280; i18n/iot.js:93-94
// ---------------------------------------------------------------------------

describe("[IOT-0019] setHub3LedDuty op/duty 必須・範囲検証 (0..255)", () => {
  it("[IOT-0019] op 未定義で iot.err.opDutyRequired の badRequest", async () => {
    const c = chunkMockClient();
    await expect(
      setHub3LedDuty(c, { deviceId: HUB3, secretKey: SECRET, duty: 100 }),
    ).rejects.toThrow(/op and duty required/i);
    expect(c.sent).toHaveLength(0);
  });

  it("[IOT-0019] duty 未定義で iot.err.opDutyRequired の badRequest", async () => {
    const c = chunkMockClient();
    await expect(
      setHub3LedDuty(c, { deviceId: HUB3, secretKey: SECRET, op: 0x01 }),
    ).rejects.toThrow(/op and duty required/i);
    expect(c.sent).toHaveLength(0);
  });

  it("[IOT-0019] op=-1 で iot.err.opDutyRange の badRequest", async () => {
    const c = chunkMockClient();
    await expect(
      setHub3LedDuty(c, { deviceId: HUB3, secretKey: SECRET, op: -1, duty: 100 }),
    ).rejects.toThrow(/out of range/i);
    expect(c.sent).toHaveLength(0);
  });

  it("[IOT-0019] duty=256 で iot.err.opDutyRange の badRequest", async () => {
    const c = chunkMockClient();
    await expect(
      setHub3LedDuty(c, { deviceId: HUB3, secretKey: SECRET, op: 0x01, duty: 256 }),
    ).rejects.toThrow(/out of range/i);
    expect(c.sent).toHaveLength(0);
  });

  it("[IOT-0019] op が 0..255 外 (op=256) で iot.err.opDutyRange の badRequest", async () => {
    const c = chunkMockClient();
    await expect(
      setHub3LedDuty(c, { deviceId: HUB3, secretKey: SECRET, op: 256, duty: 100 }),
    ).rejects.toThrow(/out of range/i);
    expect(c.sent).toHaveLength(0);
  });

  it("[IOT-0019] duty が 0..255 外 (duty=-1) で iot.err.opDutyRange の badRequest", async () => {
    const c = chunkMockClient();
    await expect(
      setHub3LedDuty(c, { deviceId: HUB3, secretKey: SECRET, op: 0x01, duty: -1 }),
    ).rejects.toThrow(/out of range/i);
    expect(c.sent).toHaveLength(0);
  });

  it("[IOT-0019] op=0/duty=0 は範囲内 (境界値: throw しない、送信される)", async () => {
    const c = chunkMockClient();
    const p = setHub3LedDuty(c, { deviceId: HUB3, secretKey: SECRET, op: 0, duty: 0 });
    expect(c.sent).toHaveLength(1);
    c.push(`biz3OperateIoT:${cmdCode.HUB3_ITEM_CODE_LED_DUTY}`, {
      op: cmdCode.HUB3_ITEM_CODE_LED_DUTY, UUID: HUB3, data: { ledDuty: 0 },
    });
    await expect(p).resolves.toBeDefined();
  });

  it("[IOT-0019] 境界値 op=0/duty=255 は送信される (範囲内)", async () => {
    const c = chunkMockClient();
    const p = setHub3LedDuty(c, { deviceId: HUB3, secretKey: SECRET, op: 0, duty: 255 });
    c.push("biz3OperateIoT:92", { op: 92, UUID: HUB3, data: { ledDuty: 255 } });
    const r = await p;
    expect(r.ledDuty).toBe(255);
    expect(c.sent).toHaveLength(1);
  });

  it("[IOT-0019] op=255/duty=255 は範囲内 (境界値: throw しない)", async () => {
    const c = chunkMockClient();
    const p = setHub3LedDuty(c, { deviceId: HUB3, secretKey: SECRET, op: 255, duty: 255 });
    expect(c.sent).toHaveLength(1);
    c.push(`biz3OperateIoT:${cmdCode.HUB3_ITEM_CODE_LED_DUTY}`, {
      op: cmdCode.HUB3_ITEM_CODE_LED_DUTY, UUID: HUB3, data: { ledDuty: 255 },
    });
    await expect(p).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// [IOT-0020] hub3RelaySwitch (cmd=208): extra=[op] 既定0x01・fire-and-forget
// ref: useIotCtrl.js:192-213; VIotSwitch.js:61-66; iot.js:306-314
// ---------------------------------------------------------------------------

describe("[IOT-0020] hub3RelaySwitch (cmd=208): extra=[op] 既定0x01・fire-and-forget", () => {
  it("[IOT-0020] op 省略時は 0x01 が extra バイトに入る (fire-and-forget, 返値 undefined)", () => {
    const c = chunkMockClient();
    const ret = hub3RelaySwitch(c, { deviceId: HUB3, secretKey: SECRET });
    expect(ret).toBeUndefined();
    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];
    expect(frame.action).toBe("biz3OperateIoT");
    // payload 末尾が 0x01 (op)
    expect(payloadHex(frame.payload).endsWith("01")).toBe(true);
    const buf = payloadBuf(frame.payload);
    expect(buf[buf.length - 1]).toBe(0x01);
  });

  it("[IOT-0020] op 明示指定時はその値が extra バイトに入る", () => {
    const c = chunkMockClient();
    hub3RelaySwitch(c, { deviceId: HUB3, secretKey: SECRET, op: 0x02 });
    expect(c.sent).toHaveLength(1);
    const buf = payloadBuf(c.sent[0].payload);
    expect(buf[buf.length - 1]).toBe(0x02);
    expect(payloadHex(c.sent[0].payload).endsWith("02")).toBe(true);
  });

  it("[IOT-0020] cmd=208(0xd0) が payload に入る", () => {
    const c = chunkMockClient();
    hub3RelaySwitch(c, { deviceId: HUB3, secretKey: SECRET });
    const buf = payloadBuf(c.sent[0].payload);
    expect(buf[4]).toBe(0xd0); // 208
    // sign(4B)=aabbccdd, cmd byte at offset 4-5 in hex = d0
    expect(payloadHex(c.sent[0].payload).slice(8, 10)).toBe("d0");
  });

  it("[IOT-0020] 送信フレームの action は 'biz3OperateIoT'", () => {
    const c = chunkMockClient();
    hub3RelaySwitch(c, { deviceId: HUB3, secretKey: SECRET });
    expect(c.sent[0].action).toBe("biz3OperateIoT");
  });

  it("[IOT-0020] topic は buildIotTopic(deviceId) (hub3Id 省略時 deviceId から構築)", () => {
    const c = chunkMockClient();
    hub3RelaySwitch(c, { deviceId: HUB3, secretKey: SECRET });
    expect(c.sent[0].topic).toBe(`wm2${LAST_SEG}cmd`);
  });

  it("[IOT-0020] hub3Id 指定時は hub3Id から topic を構築", () => {
    const hub3 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const c = chunkMockClient();
    hub3RelaySwitch(c, { deviceId: HUB3, secretKey: SECRET, hub3Id: hub3 });
    expect(c.sent[0].topic).toBe("wm2EEEEEEEEEEEEcmd");
  });

  it("[IOT-0020] 応答を待たない (subscribe が登録されない)", () => {
    const c = chunkMockClient();
    hub3RelaySwitch(c, { deviceId: HUB3, secretKey: SECRET });
    expect(c.hasSub("biz3OperateIoT:208")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [IOT-0021] hub3RelaySwitch: relay payload は web基準(op 1B)・App 2B 予約との差異
// ref: useIotCtrl.js:204-211; CHAPIClientBiz.kt:221-233; iot.js:311
// ---------------------------------------------------------------------------

describe("[IOT-0021] hub3RelaySwitch: extra は op 1B のみ (web 基準・App 2B 予約との差異)", () => {
  it("[IOT-0021] payload 全長は sign(4)+cmd(1)+device_id(36)+extra(1) = 42B (web/core 基準)", () => {
    const c = chunkMockClient();
    hub3RelaySwitch(c, { deviceId: HUB3, secretKey: SECRET });
    const buf = payloadBuf(c.sent[0].payload);
    // 4(sign) + 1(cmd) + 36(UUID UTF8) + 1(op) = 42
    expect(buf.length).toBe(42);
  });

  it("[IOT-0021] extra は op 1B のみ (末尾 1 バイトが op、2B ではない)", () => {
    const c = chunkMockClient();
    hub3RelaySwitch(c, { deviceId: HUB3, secretKey: SECRET, op: 0x01 });
    const buf = payloadBuf(c.sent[0].payload);
    // sign(4) + cmd(1) + deviceId(36) = 41、残り 1B のみ
    expect(buf.length - 41).toBe(1);
    expect(buf[41]).toBe(0x01);
    // App は 4+1+36+2=43 だが web/core は 42
    expect(buf.length).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// [IOT-0022] hub3RelaySwitch: op 範囲検証 (0..255)
// ref: useIotCtrl.js:198-202; iot.js:308; i18n/iot.js:95
// ---------------------------------------------------------------------------

describe("[IOT-0022] hub3RelaySwitch: op 範囲検証 (0..255)", () => {
  it("[IOT-0022] op=-1 で iot.err.opRange の badRequest (送信しない)", () => {
    const c = chunkMockClient();
    expect(() => hub3RelaySwitch(c, { deviceId: HUB3, secretKey: SECRET, op: -1 }))
      .toThrow(/op out of range/i);
    expect(c.sent).toHaveLength(0);
  });

  it("[IOT-0022] op=256 で iot.err.opRange の badRequest (送信しない)", () => {
    const c = chunkMockClient();
    expect(() => hub3RelaySwitch(c, { deviceId: HUB3, secretKey: SECRET, op: 256 }))
      .toThrow(/op out of range/i);
    expect(c.sent).toHaveLength(0);
  });

  it("[IOT-0022] op=0 は範囲内 (境界値: throw しない)", () => {
    const c = chunkMockClient();
    expect(() => hub3RelaySwitch(c, { deviceId: HUB3, secretKey: SECRET, op: 0 }))
      .not.toThrow();
    expect(c.sent).toHaveLength(1);
  });

  it("[IOT-0022] op=255 は範囲内 (境界値: throw しない)", () => {
    const c = chunkMockClient();
    expect(() => hub3RelaySwitch(c, { deviceId: HUB3, secretKey: SECRET, op: 255 }))
      .not.toThrow();
    expect(c.sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// [IOT-0023] buildSesameItemExtra 連結順
//   sesameId(16B) ++ ssmSecKa(16B) ++ nickNameLen(1B) ++ nickNameUTF8 ++ productType(1B) ++ matterProductType(1B)
// ref: useIotCtrl.js:53-107; iot.js:324-360
// ---------------------------------------------------------------------------

describe("[IOT-0023] buildSesameItemExtra: 連結順 sesameId(16)+secret(16)+nameLen(1)+name+pt(1)+matter(1)", () => {
  it("[IOT-0023] ニックネーム有り: バイト連結順と各部の長さが仕様と一致", () => {
    const nickName = "玄関"; // UTF8: 6バイト
    const extra = __internal.buildSesameItemExtra({
      sesameId: SESAME, ssmSecKa: SSK, nickName, deviceModel: "sesame_5",
    });

    let off = 0;

    // sesameId: ハイフン除去 hex → 16B
    const sesameHex = SESAME.replace(/-/g, "");
    expect(Buffer.from(extra.subarray(off, off + 16)).toString("hex")).toBe(sesameHex);
    off += 16;

    // ssmSecKa: hex → 16B
    expect(Buffer.from(extra.subarray(off, off + 16)).toString("hex")).toBe(SSK);
    off += 16;

    // nameLen: UTF8 バイト長 "玄関"=6B
    const nameBytes = Buffer.from(nickName, "utf8");
    expect(extra[off]).toBe(nameBytes.length); // 6
    off += 1;

    // name: UTF8 bytes
    expect(Buffer.from(extra.subarray(off, off + nameBytes.length)).toString("utf8")).toBe(nickName);
    off += nameBytes.length;

    // productType: 5 (sesame_5)
    expect(extra[off]).toBe(5);
    off += 1;

    // matterProductType: 0 (sesame_5 → pt5 → map 0)
    expect(extra[off]).toBe(0);
    off += 1;

    // 末尾ちょうど
    expect(off).toBe(extra.length);
    // 全長確認
    expect(extra.length).toBe(16 + 16 + 1 + nameBytes.length + 1 + 1);
  });

  it("[IOT-0023] ニックネーム空: nameLen=0 でゼロバイト名前部 (total=35B)", () => {
    const extra = __internal.buildSesameItemExtra({
      sesameId: SESAME, ssmSecKa: SSK, nickName: "", deviceModel: "sesame_5",
    });
    // 16 + 16 + 1(len=0) + 0(name) + 1(pt) + 1(matter) = 35
    expect(extra.length).toBe(35);
    expect(extra[32]).toBe(0); // nameLen at offset 32
  });

  it("[IOT-0023] nickName 省略 (undefined) は空文字扱いで nameLen=0", () => {
    const extra = __internal.buildSesameItemExtra({
      sesameId: SESAME, ssmSecKa: SSK, deviceModel: "sesame_5",
    });
    expect(extra[32]).toBe(0);
    expect(extra.length).toBe(35);
  });
});

// ---------------------------------------------------------------------------
// [IOT-0024] addSesameToHub3 (cmd=101): device_id=親Hub3 UUID・応答 data.ssks
// ref: MobileBindDevice.js:70-92; useIotCtrl.js:159-161; iot.js:378-414
// ---------------------------------------------------------------------------

describe("[IOT-0024] addSesameToHub3 (cmd=101): device_id=親Hub3・応答 data.ssks", () => {
  it("[IOT-0024] cmd=101(0x65)、payload の device_id は親 Hub3 UUID、応答 ssks を返す", async () => {
    const c = chunkMockClient();
    const p = addSesameToHub3(c, {
      hub3Id: HUB3,
      secretKey: SECRET,
      sesameId: SESAME,
      ssmSecKa: SSK,
      nickName: "test",
      deviceModel: "sesame_5",
    });
    c.push(`biz3OperateIoT:${cmdCode.SSM3_ITEM_ADD_SESAME}`, {
      op: cmdCode.SSM3_ITEM_ADD_SESAME, UUID: HUB3, data: { ssks: [{ id: 1 }, { id: 2 }] },
    });
    const r = await p;
    expect(r.ssks).toEqual([{ id: 1 }, { id: 2 }]);

    // cmd byte = 101 = 0x65
    const buf = payloadBuf(c.sent[0].payload);
    expect(buf[4]).toBe(0x65);

    // topic は hub3Id から構築
    expect(c.sent[0].topic).toBe(`wm2${LAST_SEG}cmd`);

    // device_id は hub3Id (sesameId ではない): payload 内の 5〜40 バイトが hub3Id UTF8
    const didInPayload = Buffer.from(buf.subarray(5, 5 + 36)).toString("utf8");
    expect(didInPayload).toBe(HUB3.toUpperCase());
  });

  it("[IOT-0024] payload の cmd バイトは 0x65 (=101)", async () => {
    const c = chunkMockClient();
    const p = addSesameToHub3(c, {
      hub3Id: HUB3, secretKey: SECRET, sesameId: SESAME, ssmSecKa: SSK, deviceModel: "sesame_5",
    });
    c.push("biz3OperateIoT:101", { op: 101, UUID: HUB3, data: { ssks: [] } });
    await p;
    const buf = payloadBuf(c.sent[0].payload);
    expect(buf[4]).toBe(0x65); // 101
  });

  it("[IOT-0024] topic は hub3Id から構築 (SESAME UUID ではない)", async () => {
    const c = chunkMockClient();
    const p = addSesameToHub3(c, {
      hub3Id: HUB3, secretKey: SECRET, sesameId: SESAME, ssmSecKa: SSK, deviceModel: "sesame_5",
    });
    c.push("biz3OperateIoT:101", { op: 101, UUID: HUB3, data: { ssks: [] } });
    await p;
    expect(c.sent[0].topic).toBe("wm2555555555555cmd");
  });

  it("[IOT-0024] 応答 data.ssks が null でも {ssks:undefined} を返す", async () => {
    const c = chunkMockClient();
    const p = addSesameToHub3(c, {
      hub3Id: HUB3, secretKey: SECRET, sesameId: SESAME, ssmSecKa: SSK, deviceModel: "sesame_5",
    });
    c.push(`biz3OperateIoT:${cmdCode.SSM3_ITEM_ADD_SESAME}`, {
      op: cmdCode.SSM3_ITEM_ADD_SESAME, UUID: HUB3, data: null,
    });
    const r = await p;
    expect(r).toHaveProperty("ssks");
    expect(r.ssks).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// [IOT-0025] removeSesameFromHub3 (cmd=103): ADD と完全同形 packing
// ref: useIotCtrl.js:155-158; MobileBindDevice.js:100-102; iot.js:391-414
// ---------------------------------------------------------------------------

describe("[IOT-0025] removeSesameFromHub3 (cmd=103): ADD と同形 packing", () => {
  it("[IOT-0025] cmd=103(0x67)、extra/topic/device_id は ADD と同形", async () => {
    const c = chunkMockClient();
    const p = removeSesameFromHub3(c, {
      hub3Id: HUB3,
      secretKey: SECRET,
      sesameId: SESAME,
      ssmSecKa: SSK,
      nickName: "test",
      deviceModel: "sesame_5",
    });
    c.push(`biz3OperateIoT:${cmdCode.SSM3_ITEM_REMOVE_SESAME}`, {
      op: cmdCode.SSM3_ITEM_REMOVE_SESAME, UUID: HUB3, data: { ssks: [] },
    });
    const r = await p;

    // cmd=103
    const buf = payloadBuf(c.sent[0].payload);
    expect(buf[4]).toBe(0x67); // 103

    // topic は hub3Id から構築
    expect(c.sent[0].topic).toBe(`wm2${LAST_SEG}cmd`);

    // device_id は hub3Id
    const didInPayload = Buffer.from(buf.subarray(5, 5 + 36)).toString("utf8");
    expect(didInPayload).toBe(HUB3.toUpperCase());

    // 応答 ssks
    expect(r.ssks).toEqual([]);
  });

  it("[IOT-0025] topic は ADD と同じ hub3Id ベース", async () => {
    const c = chunkMockClient();
    const p = removeSesameFromHub3(c, {
      hub3Id: HUB3, secretKey: SECRET, sesameId: SESAME, ssmSecKa: SSK, deviceModel: "sesame_5",
    });
    c.push("biz3OperateIoT:103", { op: 103, UUID: HUB3, data: { ssks: [] } });
    await p;
    expect(c.sent[0].topic).toBe("wm2555555555555cmd");
  });

  it("[IOT-0025] extra packing (sesameId/secret/nameLen/name/pt/matter) は ADD と同形", async () => {
    const expectedExtra = __internal.buildSesameItemExtra({
      sesameId: SESAME, ssmSecKa: SSK, nickName: "x", deviceModel: "sesame_5",
    });

    const c = chunkMockClient();
    const p = removeSesameFromHub3(c, {
      hub3Id: HUB3, secretKey: SECRET, sesameId: SESAME, ssmSecKa: SSK,
      nickName: "x", deviceModel: "sesame_5",
    });
    c.push("biz3OperateIoT:103", { op: 103, UUID: HUB3, data: { ssks: [] } });
    await p;

    const buf = payloadBuf(c.sent[0].payload);
    // extra starts at offset 5+36=41
    const extraFromPayload = buf.subarray(41);
    expect(extraFromPayload.length).toBe(expectedExtra.length);
    expect(Buffer.from(extraFromPayload).toString("hex"))
      .toBe(Buffer.from(expectedExtra).toString("hex"));
  });

  it("[IOT-0025] ADD と REMOVE で extra バイト列が同一 (cmd バイトを除く)", async () => {
    // ADD
    const cA = chunkMockClient();
    const pA = addSesameToHub3(cA, {
      hub3Id: HUB3, secretKey: SECRET, sesameId: SESAME, ssmSecKa: SSK,
      nickName: "nick", deviceModel: "sesame_5",
    });
    cA.push(`biz3OperateIoT:${cmdCode.SSM3_ITEM_ADD_SESAME}`, {
      op: cmdCode.SSM3_ITEM_ADD_SESAME, UUID: HUB3, data: { ssks: [] },
    });
    await pA;

    // REMOVE
    const cR = chunkMockClient();
    const pR = removeSesameFromHub3(cR, {
      hub3Id: HUB3, secretKey: SECRET, sesameId: SESAME, ssmSecKa: SSK,
      nickName: "nick", deviceModel: "sesame_5",
    });
    cR.push(`biz3OperateIoT:${cmdCode.SSM3_ITEM_REMOVE_SESAME}`, {
      op: cmdCode.SSM3_ITEM_REMOVE_SESAME, UUID: HUB3, data: { ssks: [] },
    });
    await pR;

    const bufA = payloadBuf(cA.sent[0].payload);
    const bufR = payloadBuf(cR.sent[0].payload);

    // 全長は同じ
    expect(bufA.length).toBe(bufR.length);

    // sign(0..3)/deviceId(5..40)/extra(41..) は同一、cmd バイト(4) のみ異なる
    expect(bufA.subarray(0, 4).toString("hex")).toBe(bufR.subarray(0, 4).toString("hex"));
    expect(bufA.subarray(5).toString("hex")).toBe(bufR.subarray(5).toString("hex"));
    expect(bufA[4]).not.toBe(bufR[4]); // 101 vs 103
  });
});

// ---------------------------------------------------------------------------
// [IOT-0026] sesame-item nickName: UTF8・nameLen 1B・空は0・255超で throw
// ref: useIotCtrl.js:61-70; iot.js:333-338
// ---------------------------------------------------------------------------

describe("[IOT-0026] sesame-item nickName: UTF8 len 1B・空=0・>255 throw", () => {
  it("[IOT-0026] 通常 nickName を UTF8 化し nameLen を 1B で先置き", () => {
    const extra = __internal.buildSesameItemExtra({
      sesameId: SESAME, ssmSecKa: SSK, nickName: "AB", deviceModel: "sesame_5",
    });
    // offset 32 = nameLen (=2 for "AB")
    expect(extra[32]).toBe(2);
    // offset 33-34 = 'A'=0x41 'B'=0x42
    expect(extra[33]).toBe(0x41);
    expect(extra[34]).toBe(0x42);
  });

  it("[IOT-0026] 通常の nickName は UTF8 バイト長を nameLen に格納 (日本語)", () => {
    // "テスト" は UTF8 9バイト
    const extra = __internal.buildSesameItemExtra({
      sesameId: SESAME, ssmSecKa: SSK, nickName: "テスト", deviceModel: "sesame_5",
    });
    const nameBytes = Buffer.from("テスト", "utf8");
    expect(extra[32]).toBe(nameBytes.length); // 9
    expect(Buffer.from(extra.subarray(33, 33 + nameBytes.length)).toString("utf8")).toBe("テスト");
  });

  it("[IOT-0026] nickName='' は nameLen=0 でバイト無し", () => {
    const extra = __internal.buildSesameItemExtra({
      sesameId: SESAME, ssmSecKa: SSK, nickName: "", deviceModel: "sesame_5",
    });
    expect(extra[32]).toBe(0);
  });

  it("[IOT-0026] nickName 省略も nameLen=0", () => {
    const extra = __internal.buildSesameItemExtra({
      sesameId: SESAME, ssmSecKa: SSK, deviceModel: "sesame_5",
    });
    expect(extra[32]).toBe(0);
  });

  it("[IOT-0026] UTF8 バイト長 255 は許容 (境界値: throw しない)", () => {
    const nickName255 = "A".repeat(255);
    expect(() => __internal.buildSesameItemExtra({
      sesameId: SESAME, ssmSecKa: SSK, nickName: nickName255, deviceModel: "sesame_5",
    })).not.toThrow();
  });

  it("[IOT-0026] UTF8 バイト長 256超 で iot.err.nicknameTooLong の badRequest", () => {
    const tooLong = "A".repeat(256);
    expect(() => __internal.buildSesameItemExtra({
      sesameId: SESAME, ssmSecKa: SSK, nickName: tooLong, deviceModel: "sesame_5",
    })).toThrow(/Nickname too long/i);
  });

  it("[IOT-0026] マルチバイト文字で UTF8 バイト長が 1B フィールドを超えたら throw", () => {
    // "あ" は UTF8 3バイト。86文字 = 258バイトで超過
    const tooLong = "あ".repeat(86);
    expect(() => __internal.buildSesameItemExtra({
      sesameId: SESAME, ssmSecKa: SSK, nickName: tooLong, deviceModel: "sesame_5",
    })).toThrow(/Nickname too long/i);
  });
});

// ---------------------------------------------------------------------------
// [IOT-0027] sesame-item productType/matterProductType の deviceModel 逆引き写像
// ref: biz3utils.js:53-101; iot.js:85-109; iot.js:343-350
// ---------------------------------------------------------------------------

describe("[IOT-0027] productType/matterProductType の deviceModel 逆引き写像", () => {
  it("[IOT-0027] getProductTypeFromModelName: known model → productType 数値", () => {
    expect(__internal.getProductTypeFromModelName("sesame_5")).toBe(5);
    expect(__internal.getProductTypeFromModelName("hub_3")).toBe(13);
    expect(__internal.getProductTypeFromModelName("bot_2")).toBe(17);
    expect(__internal.getProductTypeFromModelName("sesame_6")).toBe(20);
  });

  it("[IOT-0027] getProductTypeFromModelName: 未知 model → null", () => {
    expect(__internal.getProductTypeFromModelName("__totally_unknown__")).toBeNull();
  });

  it("[IOT-0027] getMatterProductTypeFromModelName: map 通り (pt5→0, pt17→1, pt13→255)", () => {
    expect(__internal.getMatterProductTypeFromModelName("sesame_5")).toBe(0);
    expect(__internal.getMatterProductTypeFromModelName("bot_2")).toBe(1);
    expect(__internal.getMatterProductTypeFromModelName("hub_3")).toBe(255);
  });

  it("[IOT-0027] getMatterProductTypeFromModelName: 未知 model → null (productType が null)", () => {
    expect(__internal.getMatterProductTypeFromModelName("__totally_unknown__")).toBe(null);
  });

  it("[IOT-0027] pt 29 (sesame_miwa) は MATTER_PRODUCT_TYPE_MAP に無し → undefined (biz3 コメントアウト相当)", () => {
    // sesame_miwa = pt 29。biz3utils でもコメントアウト→ undefined
    const result = __internal.getMatterProductTypeFromModelName("sesame_miwa");
    expect(result).toBeUndefined();
  });

  it("[IOT-0027] matter map 外のモデルは 0 フォールバックで extra に格納される (??0 意図的逸脱)", () => {
    // sesame_miwa (pt29) はmap外→undefined??0=0 で extra に 0 が入る
    const extra = __internal.buildSesameItemExtra({
      sesameId: SESAME, ssmSecKa: SSK, deviceModel: "sesame_miwa",
    });
    // matterProductType byte = extra の末尾
    expect(extra[extra.length - 1]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// [IOT-0028] 未知 deviceModel は productType=0 を黙送せず badRequest
// ref: useIotCtrl.js:67-73; iot.js:343-346; i18n/iot.js:97
// ---------------------------------------------------------------------------

describe("[IOT-0028] 未知 deviceModel → productType=0 黙送せず badRequest", () => {
  it("[IOT-0028] buildSesameItemExtra: 未知 deviceModel で iot.err.unknownModel を投げる", () => {
    expect(() => __internal.buildSesameItemExtra({
      sesameId: SESAME, ssmSecKa: SSK, deviceModel: "__nope__",
    })).toThrow(/unknown|未知/i);
  });

  it("[IOT-0028] addSesameToHub3: 未知 deviceModel で reject (黙って 0 を送らない)", async () => {
    const c = chunkMockClient();
    await expect(addSesameToHub3(c, {
      hub3Id: HUB3, secretKey: SECRET,
      sesameId: SESAME, ssmSecKa: SSK, deviceModel: "__unknown_model__",
    })).rejects.toThrow(/unknown/i);
    expect(c.sent).toHaveLength(0);
  });

  it("[IOT-0028] 既知 model (sesame_5) は throw しない (sanity check)", () => {
    expect(() => __internal.buildSesameItemExtra({
      sesameId: SESAME, ssmSecKa: SSK, deviceModel: "sesame_5",
    })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// [IOT-0029] add/rm-sesame 必須欠落検証 (hub3Id/sesameId/ssmSecKa/deviceModel)
// ref: iot.js:403-406; i18n/iot.js:98-101
// ---------------------------------------------------------------------------

describe("[IOT-0029] add/rm-sesame 必須欠落検証 (hub3Id/sesameId/ssmSecKa/deviceModel)", () => {
  const BASE = {
    hub3Id: HUB3, secretKey: SECRET, sesameId: SESAME, ssmSecKa: SSK, deviceModel: "sesame_5",
  };

  it("[IOT-0029] hub3Id 欠落で iot.err.hub3IdRequired (add)", async () => {
    const c = chunkMockClient();
    const { hub3Id: _, ...rest } = BASE;
    await expect(addSesameToHub3(c, rest)).rejects.toThrow(/hub3Id required/i);
    expect(c.sent).toHaveLength(0);
  });

  it("[IOT-0029] sesameId 欠落で iot.err.sesameIdRequired (add)", async () => {
    const c = chunkMockClient();
    await expect(addSesameToHub3(c, { ...BASE, sesameId: "" })).rejects.toThrow(/sesameId required/i);
    expect(c.sent).toHaveLength(0);
  });

  it("[IOT-0029] ssmSecKa 欠落で iot.err.ssmSecKaRequired (add)", async () => {
    const c = chunkMockClient();
    await expect(addSesameToHub3(c, { ...BASE, ssmSecKa: "" })).rejects.toThrow(/ssmSecKa required/i);
    expect(c.sent).toHaveLength(0);
  });

  it("[IOT-0029] deviceModel 欠落で iot.err.deviceModelRequired (add)", async () => {
    const c = chunkMockClient();
    await expect(addSesameToHub3(c, { ...BASE, deviceModel: "" })).rejects.toThrow(/deviceModel required/i);
    expect(c.sent).toHaveLength(0);
  });

  it("[IOT-0029] hub3Id 欠落で iot.err.hub3IdRequired (remove)", async () => {
    const c = chunkMockClient();
    const { hub3Id: _, ...rest } = BASE;
    await expect(removeSesameFromHub3(c, rest)).rejects.toThrow(/hub3Id required/i);
    expect(c.sent).toHaveLength(0);
  });

  it("[IOT-0029] sesameId 欠落で iot.err.sesameIdRequired (remove)", async () => {
    const c = chunkMockClient();
    await expect(removeSesameFromHub3(c, { ...BASE, sesameId: "" })).rejects.toThrow(/sesameId required/i);
    expect(c.sent).toHaveLength(0);
  });

  it("[IOT-0029] ssmSecKa 欠落で iot.err.ssmSecKaRequired (remove)", async () => {
    const c = chunkMockClient();
    await expect(removeSesameFromHub3(c, { ...BASE, ssmSecKa: "" })).rejects.toThrow(/ssmSecKa required/i);
    expect(c.sent).toHaveLength(0);
  });

  it("[IOT-0029] deviceModel 欠落で iot.err.deviceModelRequired (remove)", async () => {
    const c = chunkMockClient();
    await expect(removeSesameFromHub3(c, { ...BASE, deviceModel: "" })).rejects.toThrow(/deviceModel required/i);
    expect(c.sent).toHaveLength(0);
  });

  it("[IOT-0029] 必須欠落時は送信されない (sesameId 欠落 add)", async () => {
    const c = chunkMockClient();
    await expect(
      addSesameToHub3(c, { hub3Id: HUB3, secretKey: SECRET, sesameId: SESAME, ssmSecKa: SSK }),
    ).rejects.toThrow();
    expect(c.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// [IOT-0030] startFirmwareUpdate (cmd=0x03): extra 無し・hub3Id フォールバック
// ref: useIotCtrl.js:110-153; UpgradeFirmware.js:98-104; iot.js:435-454
// ---------------------------------------------------------------------------

describe("[IOT-0030] startFirmwareUpdate (cmd=0x03): payload=sign+cmd+device_id のみ・hub3Id フォールバック", () => {
  it("[IOT-0030] extra 無し: payload 長は sign(4)+cmd(1)+UUID(36)=41 バイト", () => {
    const c = chunkMockClient();
    startFirmwareUpdate(c, { deviceId: HUB3, secretKey: SECRET });
    expect(c.sent).toHaveLength(1);
    const buf = payloadBuf(c.sent[0].payload);
    expect(buf.length).toBe(41);
  });

  it("[IOT-0030] cmd バイトは ssmOSUpdate=0x03", () => {
    const c = chunkMockClient();
    startFirmwareUpdate(c, { deviceId: HUB3, secretKey: SECRET });
    const buf = payloadBuf(c.sent[0].payload);
    expect(buf[4]).toBe(0x03);
  });

  it("[IOT-0030] hub3Id 省略時は deviceId から topic を構築", () => {
    const c = chunkMockClient();
    startFirmwareUpdate(c, { deviceId: HUB3, secretKey: SECRET });
    expect(c.sent[0].topic).toBe(`wm2${LAST_SEG}cmd`);
  });

  it("[IOT-0030] hub3Id 指定時は hub3Id から topic を構築 (WiFi モデルの hub3 分離)", () => {
    const WIFI_DEVICE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const HUB3_PARENT = "11111111-2222-3333-4444-555555555555";
    const c = chunkMockClient();
    startFirmwareUpdate(c, { deviceId: WIFI_DEVICE, hub3Id: HUB3_PARENT, secretKey: SECRET });
    expect(c.sent[0].topic).toBe("wm2555555555555cmd");
  });

  it("[IOT-0030] 送信フレームの action は 'biz3OperateIoT'", () => {
    const c = chunkMockClient();
    startFirmwareUpdate(c, { deviceId: HUB3, secretKey: SECRET });
    expect(c.sent[0].action).toBe("biz3OperateIoT");
  });

  it("[IOT-0030] 戻り値は unsubscribe 関数", () => {
    const c = chunkMockClient();
    const unsub = startFirmwareUpdate(c, { deviceId: HUB3, secretKey: SECRET });
    expect(typeof unsub).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// [IOT-0031] startFirmwareUpdate: progress 複数回 push・versionTag で完了・unsubscribe を返す
// ref: UpgradeFirmware.js:105-120; iot.js:441-454
// ---------------------------------------------------------------------------

describe("[IOT-0031] startFirmwareUpdate: progress 複数回 push・unsubscribe を返す", () => {
  it("[IOT-0031] onProgress が data を複数回受信し versionTag で完了扱い", () => {
    const c = chunkMockClient();
    const events = [];
    const unsub = startFirmwareUpdate(c, {
      deviceId: HUB3,
      secretKey: SECRET,
      onProgress: (d) => events.push(d),
    });

    c.push(`biz3OperateIoT:${cmdCode.ssmOSUpdate}`, {
      op: cmdCode.ssmOSUpdate, UUID: HUB3, data: { progress: 30 },
    });
    c.push(`biz3OperateIoT:${cmdCode.ssmOSUpdate}`, {
      op: cmdCode.ssmOSUpdate, UUID: HUB3, data: { progress: 100, versionTag: "1.2.3" },
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ progress: 30 });
    expect(events[1]).toEqual({ progress: 100, versionTag: "1.2.3" });
  });

  it("[IOT-0031] onProgress が 3 回受信し unsub 後は届かない", () => {
    const c = chunkMockClient();
    const events = [];
    const unsub = startFirmwareUpdate(c, {
      deviceId: HUB3, secretKey: SECRET,
      onProgress: (d) => events.push(d),
    });

    c.push(`biz3OperateIoT:${cmdCode.ssmOSUpdate}`, {
      op: cmdCode.ssmOSUpdate, UUID: HUB3, data: { progress: 30 },
    });
    c.push(`biz3OperateIoT:${cmdCode.ssmOSUpdate}`, {
      op: cmdCode.ssmOSUpdate, UUID: HUB3, data: { progress: 80 },
    });
    c.push(`biz3OperateIoT:${cmdCode.ssmOSUpdate}`, {
      op: cmdCode.ssmOSUpdate, UUID: HUB3, data: { progress: 100, versionTag: "1.2.3" },
    });

    expect(events).toHaveLength(3);

    // unsub 後は届かない
    unsub();
    c.push(`biz3OperateIoT:${cmdCode.ssmOSUpdate}`, {
      op: cmdCode.ssmOSUpdate, UUID: HUB3, data: { progress: 0 },
    });
    expect(events).toHaveLength(3);
  });

  it("[IOT-0031] unsubscribe 後は push を受け取らない", () => {
    const c = chunkMockClient();
    const events = [];
    const unsub = startFirmwareUpdate(c, {
      deviceId: HUB3, secretKey: SECRET,
      onProgress: (d) => events.push(d),
    });

    c.push("biz3OperateIoT:3", { op: 3, UUID: HUB3, data: { progress: 50 } });
    unsub();
    c.push("biz3OperateIoT:3", { op: 3, UUID: HUB3, data: { progress: 100, versionTag: "1.2.3" } });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ progress: 50 });
  });

  it("[IOT-0031] onProgress 省略時でも unsubscribe 関数が返る (no-op)", () => {
    const c = chunkMockClient();
    const unsub = startFirmwareUpdate(c, { deviceId: HUB3, secretKey: SECRET });
    expect(typeof unsub).toBe("function");
    expect(() => unsub()).not.toThrow();
  });

  it("[IOT-0031] onProgress 省略時は購読を登録しない (subscribe キー不在)", () => {
    const c = chunkMockClient();
    startFirmwareUpdate(c, { deviceId: HUB3, secretKey: SECRET });
    expect(c.hasSub("biz3OperateIoT:3")).toBe(false);
  });

  it("[IOT-0031] onProgress 省略時も send は行われる (fire-and-forget トリガ)", () => {
    const c = chunkMockClient();
    startFirmwareUpdate(c, { deviceId: HUB3, secretKey: SECRET });
    expect(c.sent).toHaveLength(1);
  });

  it("[IOT-0031] 別デバイス UUID の push は onProgress に届かない (device 照合)", () => {
    const c = chunkMockClient();
    const events = [];
    startFirmwareUpdate(c, {
      deviceId: HUB3, secretKey: SECRET,
      onProgress: (d) => events.push(d),
    });
    // 別デバイスからの push
    c.push(`biz3OperateIoT:${cmdCode.ssmOSUpdate}`, {
      op: cmdCode.ssmOSUpdate, UUID: "ffffffff-0000-0000-0000-000000000000", data: { progress: 10 },
    });
    // 対象デバイスからの push は届く
    c.push(`biz3OperateIoT:${cmdCode.ssmOSUpdate}`, {
      op: cmdCode.ssmOSUpdate, UUID: HUB3, data: { progress: 50 },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ progress: 50 });
  });
});

// ---------------------------------------------------------------------------
// [IOT-0032] clearHub3WifiSsid (cmd=210): 追加バイト無し・fire-and-forget
// ref: useIotCtrl.js:214-215; MobileWifiModule.js:146-153; iot.js:466-471
// ---------------------------------------------------------------------------

describe("[IOT-0032] clearHub3WifiSsid (cmd=210): extra 無し・fire-and-forget", () => {
  it("[IOT-0032] payload = sign+cmd+device_id のみ (extra 無し, 41B)", () => {
    const c = chunkMockClient();
    clearHub3WifiSsid(c, { deviceId: HUB3, secretKey: SECRET });
    const buf = payloadBuf(c.sent[0].payload);
    expect(buf.length).toBe(41);
  });

  it("[IOT-0032] cmd バイトは HUB3_ITEM_CODE_CLEAR_WIFI_SSID=210(0xd2)", () => {
    const c = chunkMockClient();
    clearHub3WifiSsid(c, { deviceId: HUB3, secretKey: SECRET });
    expect(c.sent).toHaveLength(1);
    const buf = payloadBuf(c.sent[0].payload);
    expect(buf[4]).toBe(0xd2); // 210
  });

  it("[IOT-0032] fire-and-forget: 返値 undefined・購読キー未登録", () => {
    const c = chunkMockClient();
    const ret = clearHub3WifiSsid(c, { deviceId: HUB3, secretKey: SECRET });
    expect(ret).toBeUndefined();
    expect(c.hasSub("biz3OperateIoT:210")).toBe(false);
  });

  it("[IOT-0032] 送信フレームの action は 'biz3OperateIoT'・op は 'cmd'", () => {
    const c = chunkMockClient();
    clearHub3WifiSsid(c, { deviceId: HUB3, secretKey: SECRET });
    expect(c.sent[0].action).toBe("biz3OperateIoT");
    expect(c.sent[0].op).toBe("cmd");
  });

  it("[IOT-0032] hub3Id 指定時は hub3Id から topic を構築", () => {
    const hub3 = "00000000-0000-0000-0000-abcdefabcdef";
    const c = chunkMockClient();
    clearHub3WifiSsid(c, { deviceId: HUB3, secretKey: SECRET, hub3Id: hub3 });
    expect(c.sent[0].topic).toBe("wm2ABCDEFABCDEFcmd");
  });
});

// ---------------------------------------------------------------------------
// [IOT-0033] getMatterPairingCode (cmd=137): extra 無し・応答 qrCode/manualCode
// ref: MobileWifiModule.js:82-96; iot.js:484-491
// ---------------------------------------------------------------------------

describe("[IOT-0033] getMatterPairingCode (cmd=137): extra 無し・応答 qrCode/manualCode", () => {
  it("[IOT-0033] payload は sign+cmd+device_id のみ (extra 無し, 41B)", async () => {
    const c = chunkMockClient();
    const p = getMatterPairingCode(c, { deviceId: HUB3, secretKey: SECRET });
    c.push(`biz3OperateIoT:${cmdCode.HUB3_MATTER_PAIRING_CODE}`, {
      op: cmdCode.HUB3_MATTER_PAIRING_CODE, UUID: HUB3,
      data: { qrCode: "MT:ABCDE", manualCode: "123-456-789" },
    });
    await p;
    const buf = payloadBuf(c.sent[0].payload);
    expect(buf.length).toBe(41);
  });

  it("[IOT-0033] cmd バイトは HUB3_MATTER_PAIRING_CODE=137(0x89)", async () => {
    const c = chunkMockClient();
    const p = getMatterPairingCode(c, { deviceId: HUB3, secretKey: SECRET });
    c.push("biz3OperateIoT:137", { op: 137, UUID: HUB3, data: { qrCode: "MT:Y.XXX", manualCode: "1234-567" } });
    await p;
    const buf = payloadBuf(c.sent[0].payload);
    expect(buf[4]).toBe(0x89); // 137
  });

  it("[IOT-0033] 応答 data.qrCode と data.manualCode を返す", async () => {
    const c = chunkMockClient();
    const p = getMatterPairingCode(c, { deviceId: HUB3, secretKey: SECRET });
    c.push(`biz3OperateIoT:${cmdCode.HUB3_MATTER_PAIRING_CODE}`, {
      op: cmdCode.HUB3_MATTER_PAIRING_CODE, UUID: HUB3,
      data: { qrCode: "MT:XXXX", manualCode: "0000-0000" },
    });
    const r = await p;
    expect(r.qrCode).toBe("MT:XXXX");
    expect(r.manualCode).toBe("0000-0000");
  });

  it("[IOT-0033] 応答 data に qrCode/manualCode が無い場合 undefined を返す", async () => {
    const c = chunkMockClient();
    const p = getMatterPairingCode(c, { deviceId: HUB3, secretKey: SECRET });
    c.push(`biz3OperateIoT:${cmdCode.HUB3_MATTER_PAIRING_CODE}`, {
      op: cmdCode.HUB3_MATTER_PAIRING_CODE, UUID: HUB3, data: {},
    });
    const r = await p;
    expect(r.qrCode).toBeUndefined();
    expect(r.manualCode).toBeUndefined();
  });

  it("[IOT-0033] data 欠落時は qrCode/manualCode が undefined", async () => {
    const c = chunkMockClient();
    const p = getMatterPairingCode(c, { deviceId: HUB3, secretKey: SECRET });
    c.push("biz3OperateIoT:137", { op: 137, UUID: HUB3 });
    const r = await p;
    expect(r.qrCode).toBeUndefined();
    expect(r.manualCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// [IOT-0034] openMatterPairingWindow (cmd=153): 応答 statusCode (===0 成功)
// ref: MobileWifiModule.js:97-126; iot.js:501-508
// ---------------------------------------------------------------------------

describe("[IOT-0034] openMatterPairingWindow (cmd=153): 応答 statusCode", () => {
  it("[IOT-0034] cmd=153(0x99)、payload は sign+cmd+device_id のみ (41B)", async () => {
    const c = chunkMockClient();
    const p = openMatterPairingWindow(c, { deviceId: HUB3, secretKey: SECRET });
    c.push(`biz3OperateIoT:${cmdCode.HUB3_MATTER_PAIRING_WINDOW}`, {
      op: cmdCode.HUB3_MATTER_PAIRING_WINDOW, UUID: HUB3, data: { statusCode: 0 },
    });
    await p;
    const buf = payloadBuf(c.sent[0].payload);
    expect(buf.length).toBe(41);
    expect(buf[4]).toBe(0x99); // 153
  });

  it("[IOT-0034] statusCode=0 で成功 (===0 判定は呼出側責任)", async () => {
    const c = chunkMockClient();
    const p = openMatterPairingWindow(c, { deviceId: HUB3, secretKey: SECRET });
    c.push(`biz3OperateIoT:${cmdCode.HUB3_MATTER_PAIRING_WINDOW}`, {
      op: cmdCode.HUB3_MATTER_PAIRING_WINDOW, UUID: HUB3, data: { statusCode: 0 },
    });
    const r = await p;
    expect(r.statusCode).toBe(0);
  });

  it("[IOT-0034] statusCode 非0 は返す (throw しない、成功判定は呼出側)", async () => {
    const c = chunkMockClient();
    const p = openMatterPairingWindow(c, { deviceId: HUB3, secretKey: SECRET });
    c.push(`biz3OperateIoT:${cmdCode.HUB3_MATTER_PAIRING_WINDOW}`, {
      op: cmdCode.HUB3_MATTER_PAIRING_WINDOW, UUID: HUB3, data: { statusCode: 5 },
    });
    const r = await p;
    expect(r.statusCode).toBe(5);
  });

  it("[IOT-0034] statusCode 欠落 (data={}) は undefined を返す", async () => {
    const c = chunkMockClient();
    const p = openMatterPairingWindow(c, { deviceId: HUB3, secretKey: SECRET });
    c.push(`biz3OperateIoT:${cmdCode.HUB3_MATTER_PAIRING_WINDOW}`, {
      op: cmdCode.HUB3_MATTER_PAIRING_WINDOW, UUID: HUB3, data: {},
    });
    const r = await p;
    expect(r.statusCode).toBeUndefined();
  });

  it("[IOT-0034] statusCode 欠落 (data 無し) は statusCode=undefined を返す", async () => {
    const c = chunkMockClient();
    const p = openMatterPairingWindow(c, { deviceId: HUB3, secretKey: SECRET });
    c.push("biz3OperateIoT:153", { op: 153, UUID: HUB3 });
    const r = await p;
    expect(r.statusCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// [IOT-0035] vendor cmdCode 定数の数値同期
// ref: references_web/src/constants/cmdCode.js:46-92; packages/core/src/vendor/biz3/constants/cmdCode.js:46-92
// ---------------------------------------------------------------------------

describe("[IOT-0035] vendor cmdCode 定数の数値同期 (core ↔ references_web)", () => {
  it("[IOT-0035] ssmOSUpdate = 0x03", () => {
    expect(cmdCode.ssmOSUpdate).toBe(0x03);
  });

  it("[IOT-0035] HUB3_ITEM_CODE_LED_DUTY = 92", () => {
    expect(cmdCode.HUB3_ITEM_CODE_LED_DUTY).toBe(92);
  });

  it("[IOT-0035] SSM3_ITEM_ADD_SESAME = 101", () => {
    expect(cmdCode.SSM3_ITEM_ADD_SESAME).toBe(101);
  });

  it("[IOT-0035] SSM3_ITEM_REMOVE_SESAME = 103", () => {
    expect(cmdCode.SSM3_ITEM_REMOVE_SESAME).toBe(103);
  });

  it("[IOT-0035] HUB3_MATTER_PAIRING_CODE = 137", () => {
    expect(cmdCode.HUB3_MATTER_PAIRING_CODE).toBe(137);
  });

  it("[IOT-0035] HUB3_MATTER_PAIRING_WINDOW = 153", () => {
    expect(cmdCode.HUB3_MATTER_PAIRING_WINDOW).toBe(153);
  });

  it("[IOT-0035] HUB3_ITEM_CODE_RELAY_SWITCH = 208", () => {
    expect(cmdCode.HUB3_ITEM_CODE_RELAY_SWITCH).toBe(208);
  });

  it("[IOT-0035] HUB3_ITEM_CODE_CLEAR_WIFI_SSID = 210", () => {
    expect(cmdCode.HUB3_ITEM_CODE_CLEAR_WIFI_SSID).toBe(210);
  });

  it("[IOT-0035] 137 は HUB3_MATTER_PAIRING_CODE と STP_ITEM_CODE_PASSCODE_CHANGE_VALUE で重複定義される (仕様上の ambiguity を固定)", () => {
    expect(cmdCode.HUB3_MATTER_PAIRING_CODE).toBe(cmdCode.STP_ITEM_CODE_PASSCODE_CHANGE_VALUE);
    expect(cmdCode.HUB3_MATTER_PAIRING_CODE).toBe(137);
  });
});

// ---------------------------------------------------------------------------
// [IOT-0036] iot NAMESPACE_OPS allowlist (hub.iot.* に出す 10 op)
// ref: iot.js:530-536; registry.js:288-303
// ---------------------------------------------------------------------------

describe("[IOT-0036] iot NAMESPACE_OPS allowlist (10 op)", () => {
  const EXPECTED_OPS = [
    "sendIotCmd",
    "sendIotCmdAwait",
    "setHub3LedDuty",
    "hub3RelaySwitch",
    "addSesameToHub3",
    "removeSesameFromHub3",
    "startFirmwareUpdate",
    "clearHub3WifiSsid",
    "getMatterPairingCode",
    "openMatterPairingWindow",
  ];

  it("[IOT-0036] NAMESPACE_OPS に 10 op が揃っている", () => {
    expect(NAMESPACE_OPS).toHaveLength(10);
  });

  it("[IOT-0036] NAMESPACE_OPS に所定の 10 op が全て含まれる", () => {
    for (const op of EXPECTED_OPS) {
      expect(NAMESPACE_OPS, `NAMESPACE_OPS should contain '${op}'`).toContain(op);
    }
  });

  it("[IOT-0036] buildIotTopic は NAMESPACE_OPS に含まれない (内部ヘルパー)", () => {
    expect(NAMESPACE_OPS).not.toContain("buildIotTopic");
  });

  it("[IOT-0036] buildIotPayload は NAMESPACE_OPS に含まれない (内部ヘルパー)", () => {
    expect(NAMESPACE_OPS).not.toContain("buildIotPayload");
  });

  it("[IOT-0036] subscribeIotResponse は NAMESPACE_OPS に含まれない (購読プリミティブ)", () => {
    expect(NAMESPACE_OPS).not.toContain("subscribeIotResponse");
  });

  it("[IOT-0036] __internal は NAMESPACE_OPS に含まれない", () => {
    expect(NAMESPACE_OPS).not.toContain("__internal");
  });

  it("[IOT-0036] NAMESPACE_OPS の内容が EXPECTED_OPS と完全一致 (順序不問)", () => {
    expect([...NAMESPACE_OPS].sort()).toEqual([...EXPECTED_OPS].sort());
  });
});

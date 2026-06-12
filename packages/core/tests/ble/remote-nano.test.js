// SesameBle#remoteNano (Remote / Remote Nano 専用面、追加バックログ 7) の単体テスト。
//
// 参照 (送信側 Kotlin):
//   - CHRemoteNanoCapable.kt:8 / CHRemoteNanoCapableImpl.kt:19-28
//       setTriggerDelayTime(time: UByte) = SesameOS3Payload(190, byteArrayOf(time.toByte()))
//   - CHDeivceProtocols.kt:317-322 (CHSesameConnector) / CHDeviceConnectCapableImpl.kt:23-95
//       insertSesame / removeSesame / setRadarSensitivity(payload は生バイト無加工 → 200)
//   - CHRemoteNanoEventHandler.kt:15-21
//       PUB_TRIGGER_DELAYTIME(191) publish → isRemote() のとき onTriggerDelaySecondReceived
//   - CHSesameBiometricDeviceImpl.kt:176,210-212
//       RADAR_PARAM_PUBLISH(201) publish → onRadarReceive(payload 生)
import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { SesameBle } from "../../src/ble/index.js";
import {
  deriveSessionKey, ccmEncrypt, ccmDecrypt, splitSegments, SegmentAssembler,
  OP, ITEM, SEG,
} from "../../src/ble/protocol.js";

const SECRET = "0123456789abcdef0123456789abcdef";

/**
 * facade.test.js の MockSesame と同型の mock (remote/remote_nano は BIOMETRIC kind = profile
 * "lock" の handshake — CHSesameBiometricDeviceImpl は CHSesameOS3 直継承で initial(14)+login(2))。
 * 応答フレームは送信側 Kotlin (CHSesameOS3.kt sendCommand → SSM3ResponsePayload) から導出:
 * [OP.RESPONSE, item, resultCode] (++ payload)。
 */
class MockRemote {
  constructor() {
    this.secret = Buffer.from(SECRET, "hex");
    this.token = Buffer.from([9, 9, 9, 9]);
    this.key = deriveSessionKey(this.secret, this.token);
    this.asm = new SegmentAssembler();
    this.encCount = 0; this.decCount = 0;
    this.onPacket = null; this.lastCommand = null; this.disconnected = false;
  }
  connect(onPacket) {
    this.onPacket = onPacket;
    this._emitPlain(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), this.token]));
    return Promise.resolve();
  }
  write(seg) {
    const a = this.asm.feed(Buffer.from(seg));
    if (!a) return;
    let frame;
    if (a.type === SEG.CIPHERTEXT) { frame = ccmDecrypt(this.key, this.decCount, this.token, a.data); this.decCount++; }
    else frame = a.data;
    const item = frame[0];
    if (item === ITEM.LOGIN) {
      this._emitCipher(Buffer.from([OP.RESPONSE, ITEM.LOGIN, 0, 0, 0, 0, 0]));
      return;
    }
    this.lastCommand = { item, data: Buffer.from(frame.subarray(1)) };
    this._emitCipher(Buffer.from([OP.RESPONSE, item, 0x00]));
  }
  /** publish フレームをデバイス側から流す (テスト用)。 */
  emitPublish(itemCode, payload) {
    this._emitCipher(Buffer.concat([Buffer.from([OP.PUBLISH, itemCode]), payload]));
  }
  disconnect() { this.disconnected = true; return Promise.resolve(); }
  _emitPlain(f) { for (const s of splitSegments(f, SEG.PLAINTEXT)) this.onPacket(s); }
  _emitCipher(f) { const ct = ccmEncrypt(this.key, this.encCount, this.token, f); this.encCount++; for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s); }
}

describe("SesameBle#remoteNano", () => {
  it.each(["remote", "remote_nano"])("%s: setTriggerDelayTime は 190 + [time(1B)] を送る (CHRemoteNanoCapableImpl.kt:19-28)", async (model) => {
    const dev = new MockRemote();
    const ble = new SesameBle({ secretKey: SECRET, model, transport: dev });
    await ble.connect();
    await ble.remoteNano.setTriggerDelayTime(30);
    expect(dev.lastCommand.item).toBe(ITEM.REMOTE_NANO_SET_TRIGGER_DELAYTIME); // 190
    expect([...dev.lastCommand.data]).toEqual([30]); // byteArrayOf(time.toByte())
    await ble.close();
  });

  it("setTriggerDelayTime は UByte 範囲外 (256 / -1) で throw する (原典の UByte 型制約)", async () => {
    const dev = new MockRemote();
    const ble = new SesameBle({ secretKey: SECRET, model: "remote_nano", transport: dev });
    await ble.connect();
    await expect(ble.remoteNano.setTriggerDelayTime(256)).rejects.toThrow(/UByte 0\.\.255/);
    await expect(ble.remoteNano.setTriggerDelayTime(-1)).rejects.toThrow(/UByte 0\.\.255/);
    await ble.close();
  });

  it("setRadarSensitivity は 200 に raw payload を無加工で載せる (CHDeviceConnectCapableImpl.kt:89-95)", async () => {
    const dev = new MockRemote();
    const ble = new SesameBle({ secretKey: SECRET, model: "remote_nano", transport: dev });
    await ble.connect();
    // app の組み立て例: [0x33][sensitivity(4B LE)] (SSMBiometricSettingFG.kt:259-266)。
    const payload = Buffer.from([0x33, 0x74, 0x00, 0x00, 0x00]);
    await ble.remoteNano.setRadarSensitivity(payload);
    expect(dev.lastCommand.item).toBe(ITEM.SSM_OS3_RADAR_PARAM_SET); // 200
    expect(dev.lastCommand.data.equals(payload)).toBe(true);
    await ble.close();
  });

  it("insertSesame は ADD_SESAME(101) に UUID16+secretKey16 を送る (CHDeviceConnectCapableImpl.kt:23-51 OS3 形)", async () => {
    const dev = new MockRemote();
    const ble = new SesameBle({ secretKey: SECRET, model: "remote_nano", transport: dev });
    await ble.connect();
    const childUUID = "11223344-5566-7788-99aa-bbccddeeff00";
    const childSecret = "00112233445566778899aabbccddeeff";
    await ble.remoteNano.insertSesame({ deviceUUID: childUUID, secretKey: childSecret });
    expect(dev.lastCommand.item).toBe(ITEM.ADD_SESAME); // 101
    expect(dev.lastCommand.data.toString("hex")).toBe(
      childUUID.replace(/-/g, "") + childSecret, // noDashUUIDDATA ++ ssmSecKa
    );
    await ble.close();
  });

  it("registerDelegate: 191 publish が onTriggerDelaySecondReceived へ、201 publish が onRadarReceive へ届く", async () => {
    const dev = new MockRemote();
    const ble = new SesameBle({ secretKey: SECRET, model: "remote_nano", transport: dev });
    await ble.connect();
    /** @type {any[]} */ const triggers = [];
    /** @type {any[]} */ const radars = [];
    const off = ble.remoteNano.registerDelegate({
      onTriggerDelaySecondReceived: (_d, setting) => triggers.push(setting),
      onRadarReceive: (_d, payload) => radars.push(payload),
    });
    // PUB_TRIGGER_DELAYTIME(191) payload 先頭 1B (LE) = triggerDelaySecond
    // (CHSesameBiometricParseData.kt:59-74)。
    dev.emitPublish(ITEM.REMOTE_NANO_PUB_TRIGGER_DELAYTIME, Buffer.from([12]));
    // RADAR_PARAM_PUBLISH(201) は payload 生バイトを素通し (CHSesameBiometricDeviceImpl.kt:210-212)。
    dev.emitPublish(ITEM.SSM_OS3_RADAR_PARAM_PUBLISH, Buffer.from([0x33, 0x74, 0, 0, 0]));
    expect(triggers).toEqual([{ triggerDelaySecond: 12 }]);
    expect(radars.length).toBe(1);
    expect(radars[0].toString("hex")).toBe("3374000000");
    off();
    await ble.close();
  });

  it("remoteNano は Remote 系以外 (lock/touch/open sensor/hub3/wm2/bot) では明示エラー", () => {
    const fake = { connect: async () => {}, write: () => {}, disconnect: async () => {} };
    for (const model of ["sesame_5", "ssm_touch", "sesame_face", "open_sensor_1", "open_sensor_2", "hub_3", "wm_2", "bot_2"]) {
      const ble = new SesameBle({ secretKey: SECRET, model, transport: fake });
      expect(() => ble.remoteNano, model).toThrow(/Remote/);
    }
  });

  it("remote/remote_nano では biometric ゲッタは従来どおり明示エラー (bioCaps 空集合 P3-15)", () => {
    const fake = { connect: async () => {}, write: () => {}, disconnect: async () => {} };
    for (const model of ["remote", "remote_nano"]) {
      const ble = new SesameBle({ secretKey: SECRET, model, transport: fake });
      expect(() => ble.biometric, model).toThrow();
      expect(() => ble.remoteNano, model).not.toThrow();
    }
  });
});

describe("BIO_VIEW_METHODS の palm 群 (追加バックログ 3 の検証)", () => {
  it("palmChange は SDK に送信実装が無いため biometric ビューに存在しない (CHPalmCapableImpl.kt:13-67)", () => {
    const fake = { connect: async () => {}, write: () => {}, disconnect: async () => {} };
    // palm capability を持つ機種 (sesame_face) のビューで palm 群を確認する。
    const ble = new SesameBle({ secretKey: SECRET, model: "sesame_face", transport: fake });
    const view = ble.biometric;
    // 送信実装が SDK に実在する 4 メソッドだけが生える (palmModeSet/Get, palmListGet, palmDelete)。
    expect(typeof view.palmModeSet).toBe("function");
    expect(typeof view.palmModeGet).toBe("function");
    expect(typeof view.palmListGet).toBe("function");
    expect(typeof view.palmDelete).toBe("function");
    // PALM_CHANGE(162) は受信専用 (CHPalmEventHandlers.kt:16-18) — 送信メソッドを捏造しない。
    expect(/** @type {any} */ (view).palmChange).toBeUndefined();
  });
});

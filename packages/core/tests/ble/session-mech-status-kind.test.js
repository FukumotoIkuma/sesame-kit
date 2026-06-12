// P3-18: MECH_STATUS(81) の kind 別静的ディスパッチを検証。
//
// 問題: 旧実装は「try parseMechStatus; catch → parseBiometricMechStatus」のフォールバック連鎖で
// Hub3 の 1B payload が biometric 形で lastStatus にキャッシュされ、
// hub3().onPublish (parseNetworkStatus) と status() が別形を返していた。
//
// 修正 (P3-18): SesameBleSession に mechStatusKind を導入し kind で静的ディスパッチする。
// ベクタ導出元:
//   - lock  (7B): protocol.js parseMechStatusLock (CHSesame5MechStatus)
//   - bot   (3B): protocol.js parseMechStatusBot  (CHSesameBot2MechStatus)
//   - hub3  (1B): protocol.js parseNetworkStatus  (CHHub3Device.kt:291-301)
//   - biometric : biometric.js parseBiometricMechStatus (CHSesameBiometricDeviceImpl.kt:214-217)
import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { SesameBleSession } from "../../src/ble/session.js";
import {
  deriveSessionKey, ccmEncrypt, splitSegments,
  OP, ITEM, SEG,
} from "../../src/ble/protocol.js";
import { SesameBle } from "../../src/ble/index.js";

const SECRET = "0102030405060708090a0b0c0d0e0f10";

// MockSesame: セッション確立後に MECH_STATUS publish を注入できる最小モック。
// ベクタ: セッション鍵 = deriveSessionKey(secret, token) (CHSesameOS3LockBase.kt:119-124 と同型)。
class MockSesame {
  constructor({ secret = SECRET, token = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]) } = {}) {
    this.token = token;
    this.key = deriveSessionKey(Buffer.from(secret, "hex"), token);
    this.encCount = 0;
    this.onPacket = null;
  }
  connect(onPacket) {
    this.onPacket = onPacket;
    // initial publish (PLAINTEXT) を送る
    const frame = Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), this.token]);
    for (const s of splitSegments(frame, SEG.PLAINTEXT)) onPacket(s);
    return Promise.resolve();
  }
  write(seg) {
    // login コマンドに対して response(7)+login(2)+resultCode0 を返す
    const frame = Buffer.from([OP.RESPONSE, ITEM.LOGIN, 0x00, 0, 0, 0, 0]);
    const ct = ccmEncrypt(this.key, this.encCount++, this.token, frame);
    for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s);
  }
  /** MECH_STATUS(81) publish を暗号化して注入する。 */
  emitMechStatus(payload) {
    const frame = Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.MECH_STATUS]), payload]);
    const ct = ccmEncrypt(this.key, this.encCount++, this.token, frame);
    for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s);
  }
  disconnect() { return Promise.resolve(); }
}

// ヘルパ: セッションを接続してから mechStatus を emit し lastStatus を返す。
async function runKind(mechStatusKind, payload) {
  const dev = new MockSesame();
  const session = new SesameBleSession({ transport: dev, secretKey: SECRET, syncTime: false, mechStatusKind });
  await session.connect();
  dev.emitMechStatus(payload);
  return session.lastStatus;
}

describe("P3-18: MECH_STATUS(81) kind 別静的ディスパッチ", () => {
  // ---- kind="lock" --------------------------------------------------------
  it('kind="lock": 7B payload を parseMechStatus(lock 形式) で解釈する', async () => {
    // ベクタ: protocol.js parseMechStatusLock — batteryRaw=LE16, target=LE16, position=LE16, flags=1B
    // flags bit1=isInLockRange (CHSesame5MechStatus 参照: CHDeivceProtocols.kt:324-330)
    const payload = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0b0000_0010]);
    const s = await runKind("lock", payload);
    expect(s).not.toBeNull();
    expect(s.state).toBe("locked");          // isInLockRange=true → "locked"
    expect(s.position).toBe(0);
    expect(typeof s.batteryRaw).toBe("number");
    // biometric 形 { data } にはならないことを確認
    expect(s.data).toBeUndefined();
    // networkStatus 形 { isAp } にはならないことを確認
    expect(s.isAp).toBeUndefined();
  });

  it('kind="lock": 3B (bot 長) でも parseMechStatus が処理する (長さ分岐は parseMechStatus 内)', async () => {
    // parseMechStatus は 3B を parseMechStatusBot に委譲する。
    // ベクタ: parseMechStatusBot — flags bit1=isInLockRange (CHSesameBot2MechStatus)
    const payload = Buffer.from([0x00, 0x00, 0b0000_0010]);
    const s = await runKind("lock", payload);
    expect(s).not.toBeNull();
    expect(s.state).toBe("locked");
  });

  // ---- kind="bot" ---------------------------------------------------------
  it('kind="bot": 3B payload を parseMechStatus(bot 形式) で解釈する', async () => {
    // ベクタ: parseMechStatusBot (CHSesameBot2MechStatus)
    // flags bit1=isInLockRange (CHDeivceProtocols.kt:340-341)
    const payload = Buffer.from([0x00, 0x00, 0b0000_0010]);
    const s = await runKind("bot", payload);
    expect(s).not.toBeNull();
    expect(s.state).toBe("locked");
    expect(s.position).toBe(0);
    expect(s.data).toBeUndefined();
    expect(s.isAp).toBeUndefined();
  });

  it('kind="bot": 長さ不一致 (5B) はエラーログのみで lastStatus を更新しない', async () => {
    // parseMechStatus は 5B を throw する (3B/>=7B 以外)。
    // kind ディスパッチはフォールバックせず null のまま。
    const dev = new MockSesame();
    const session = new SesameBleSession({ transport: dev, secretKey: SECRET, syncTime: false, mechStatusKind: "bot" });
    await session.connect();
    dev.emitMechStatus(Buffer.alloc(5)); // 5B は parseMechStatus が throw
    expect(session.lastStatus).toBeNull(); // フォールバックせず null のまま
  });

  // ---- kind="hub3" --------------------------------------------------------
  it('kind="hub3": 1B payload を parseNetworkStatus で解釈する (CHHub3Device.kt:291-301)', async () => {
    // Hub3 では mechStatus(81) は CHWifiModule2NetWorkStatus として解釈される。
    // ベクタ: CHHub3Device.kt:293-299 — bit1=isAp / bit2=isNet / bit3=isIot
    // bit4=isAPCheck / bit5=isAPConnecting / bit6=isNETConnecting / bit7=isIOTConnecting
    const s = await runKind("hub3", Buffer.from([0b0000_0110])); // bit1=isAp, bit2=isNet
    expect(s).not.toBeNull();
    expect(s.isAp).toBe(true);
    expect(s.isNet).toBe(true);
    expect(s.isIot).toBe(false);
    // ロック形式 { state } にはならない
    expect(s.state).toBeUndefined();
    // biometric 形 { data } にはならない
    expect(s.data).toBeUndefined();
  });

  it('kind="hub3": 全 bit (0xFE) でフルフラグ (CHHub3Device.kt:291-301)', async () => {
    const s = await runKind("hub3", Buffer.from([0xfe]));
    expect(s.isAp).toBe(true);
    expect(s.isNet).toBe(true);
    expect(s.isIot).toBe(true);
    expect(s.isAPCheck).toBe(true);
    expect(s.isAPConnecting).toBe(true);
    expect(s.isNETConnecting).toBe(true);
    expect(s.isIOTConnecting).toBe(true);
  });

  // ---- kind="biometric" ---------------------------------------------------
  it('kind="biometric": raw 素通しで parseBiometricMechStatus を返す (CHSesameBiometricDeviceImpl.kt:214-217)', async () => {
    // 生体デバイスの mechStatus は可変長 raw payload をそのまま保持する。
    const payload = Buffer.from([0x12, 0x34, 0x56, 0xab]);
    const s = await runKind("biometric", payload);
    expect(s).not.toBeNull();
    expect(Buffer.isBuffer(s.data)).toBe(true);
    expect([...s.data]).toEqual([0x12, 0x34, 0x56, 0xab]);
    // ロック形式 { state } にはならない
    expect(s.state).toBeUndefined();
    // hub3 形式 { isAp } にはならない
    expect(s.isAp).toBeUndefined();
  });

  it('kind="biometric": batteryRaw は先頭 2B LE (CHSesameProtocolMechStatus 既定)', async () => {
    // parseBiometricMechStatus: batteryRaw = buf.readUInt16LE(0)
    const payload = Buffer.from([0x34, 0x12, 0xff]); // LE16 = 0x1234
    const s = await runKind("biometric", payload);
    expect(s.batteryRaw).toBe(0x1234);
  });

  // ---- 受け入れ基準: 同一 publish に facade と onPublish が同形を返す --
  it('Hub3: session.lastStatus と onPublish body が同じ parseNetworkStatus 形式を持つ', async () => {
    // 旧実装では session._lastStatus が parseBiometricMechStatus({data:…}) になり、
    // Hub3Commands.onPublish の parseNetworkStatus 結果と形式が食い違っていた。
    // 修正後は両者とも parseNetworkStatus 形式 { isAp, isNet, … } になる。
    const dev = new MockSesame();
    const session = new SesameBleSession({ transport: dev, secretKey: SECRET, syncTime: false, mechStatusKind: "hub3" });
    const publishedBodies = [];
    session.onPublish(({ itemCode, body }) => {
      if (itemCode === ITEM.MECH_STATUS) publishedBodies.push(body);
    });
    await session.connect();
    dev.emitMechStatus(Buffer.from([0b0000_0100])); // isNet=true

    expect(session.lastStatus).not.toBeNull();
    // lastStatus は parseNetworkStatus 形式
    expect(session.lastStatus.isNet).toBe(true);
    // onPublish の raw body も受信されていること (ファサードはこれを parseNetworkStatus に渡す)
    expect(publishedBodies.length).toBe(1);
    expect(publishedBodies[0][0] & 4).toBeGreaterThan(0); // bit2=isNet
  });

  // ---- SesameBle facade が kind を正しく session に渡すことを確認 -----------
  it('SesameBle: hub_3 model は mechStatusKind="hub3" でセッション構築される', () => {
    // SesameBle のコンストラクタが caps.kind===KIND.HUB3 に "hub3" を渡すことを
    // session._mechStatusKind で確認する (内部状態への直接アクセス = ホワイトボックス確認)。
    const ble = new SesameBle({
      model: "hub_3",
      secretKey: SECRET,
      transport: { connect() {}, write() {}, disconnect() {} },
    });
    expect(ble._session._mechStatusKind).toBe("hub3");
  });

  it('SesameBle: ssm_touch_pro model (BIOMETRIC kind) は mechStatusKind="biometric"', () => {
    // model 文字列は devicemodel.js PRODUCT_TYPES[9] = "ssm_touch_pro" (KIND.BIOMETRIC)。
    const ble = new SesameBle({
      model: "ssm_touch_pro",
      secretKey: SECRET,
      transport: { connect() {}, write() {}, disconnect() {} },
    });
    expect(ble._session._mechStatusKind).toBe("biometric");
  });

  it('SesameBle: bot_2 model (BOT2 kind) は mechStatusKind="bot"', () => {
    const ble = new SesameBle({
      model: "bot_2",
      secretKey: SECRET,
      transport: { connect() {}, write() {}, disconnect() {} },
    });
    expect(ble._session._mechStatusKind).toBe("bot");
  });

  it('SesameBle: sesame_5 model (LOCK5 kind) は mechStatusKind="lock"', () => {
    const ble = new SesameBle({
      model: "sesame_5",
      secretKey: SECRET,
      transport: { connect() {}, write() {}, disconnect() {} },
    });
    expect(ble._session._mechStatusKind).toBe("lock");
  });

  it('SesameBle: bike_2 model (BIKE2 kind) は mechStatusKind="bot" (3B 形式)', () => {
    const ble = new SesameBle({
      model: "bike_2",
      secretKey: SECRET,
      transport: { connect() {}, write() {}, disconnect() {} },
    });
    expect(ble._session._mechStatusKind).toBe("bot");
  });
});

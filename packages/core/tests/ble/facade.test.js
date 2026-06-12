// SesameBle ファサードの単体テスト。mock SESAME を transport 注入し、lock/autolock/toggle/use を検証。
import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { SesameBle } from "../../src/ble/index.js";
import {
  deriveSessionKey, ccmEncrypt, ccmDecrypt, splitSegments, SegmentAssembler,
  OP, ITEM, SEG,
} from "../../src/ble/protocol.js";

const SECRET = "0123456789abcdef0123456789abcdef";

/** session.test.js の MockSesame を簡略再掲 (mechStatus を connect 直後に流せる)。 */
class MockSesame {
  constructor({ initialState = null } = {}) {
    this.secret = Buffer.from(SECRET, "hex");
    this.token = Buffer.from([9, 9, 9, 9]);
    this.key = deriveSessionKey(this.secret, this.token);
    this.asm = new SegmentAssembler();
    this.encCount = 0; this.decCount = 0;
    this.onPacket = null; this.lastCommand = null; this.disconnected = false;
    this.initialState = initialState; // 接続後に流す mechStatus (locked/unlocked)
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
      // login 直後に mechStatus publish (実機同様)
      if (this.initialState) this._emitCipher(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.MECH_STATUS]), this.initialState]));
      return;
    }
    this.lastCommand = { item, data: Buffer.from(frame.subarray(1)) };
    // versionTag(5) 応答の payload = バージョン文字列の UTF-8 bytes (送信側導出:
    // CHSesameOS3.kt:398-418 — String(res.payload) で解釈される値をそのまま載せる)。
    const extra = (this.versionTagAscii && item === ITEM.VERSION_TAG)
      ? Buffer.from(this.versionTagAscii, "utf8") : Buffer.alloc(0);
    this._emitCipher(Buffer.concat([Buffer.from([OP.RESPONSE, item, 0x00]), extra]));
  }
  disconnect() { this.disconnected = true; return Promise.resolve(); }
  _emitPlain(f) { for (const s of splitSegments(f, SEG.PLAINTEXT)) this.onPacket(s); }
  _emitCipher(f) { const ct = ccmEncrypt(this.key, this.encCount, this.token, f); this.encCount++; for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s); }
}

const LOCKED = Buffer.from([0x70, 0x17, 0, 0, 0, 0, 0b010]);
const UNLOCKED = Buffer.from([0x70, 0x17, 0, 0, 0, 0, 0b100]);

/**
 * WM2 profile の鏡像 mock。導出元: CHWifiModule2Device.kt:314-321 (login override) /
 * :521-528 (INITIAL=13) / :539-541 (WM2ActionCode) / SesameOS3BleCipher.kt:8-32 (sault=token4)。
 * ロックと違い initial itemCode=13、cipher 鍵 = secretKey **生 16B**、CCM sault = token4 (nonce 12B)。
 * バイト列の固定ベクタ検証は wm2-session.test.js が担い、ここはファサード配線 (profile "wm2" が
 * kind===WIFI で自動選択され handshake が成立すること) の検証に使う。
 */
class MockWM2 {
  constructor() {
    this.secret = Buffer.from(SECRET, "hex");
    this.token = Buffer.from([9, 9, 9, 9]);
    this.asm = new SegmentAssembler();
    this.encCount = 0; this.decCount = 0;
    this.onPacket = null; this.lastCommand = null; this.disconnected = false;
  }
  connect(onPacket) {
    this.onPacket = onPacket;
    // initial publish は WM2ActionCode.INITIAL = 13 (CHWifiModule2Device.kt:521,540)
    this._emitPlain(Buffer.concat([Buffer.from([OP.PUBLISH, 13]), this.token]));
    return Promise.resolve();
  }
  write(seg) {
    const a = this.asm.feed(Buffer.from(seg));
    if (!a) return;
    let frame;
    if (a.type === SEG.CIPHERTEXT) { frame = ccmDecrypt(this.secret, this.decCount, this.token, a.data, "wm2"); this.decCount++; }
    else frame = a.data;
    const item = frame[0];
    // login = [LOGIN_WM2(2)] ++ CMAC(secretKey, token) 16B 全量 = 17B 平文 (kt:316-318)
    if (a.type === SEG.PLAINTEXT && item === 2) {
      if (frame.length !== 17) throw new Error(`wm2 login frame must be 17B, got ${frame.length}`);
      this._emitCipher(Buffer.from([OP.RESPONSE, 2, 0]));
      return;
    }
    this.lastCommand = { item, data: Buffer.from(frame.subarray(1)) };
    // WM2 VERSION_TAG(127) 応答の payload = バージョン文字列の UTF-8 bytes (送信側導出:
    // CHWifiModule2Device.kt:423-435 — val versionTag = String(res.payload))。
    const extra = (this.versionTagAscii && item === 127)
      ? Buffer.from(this.versionTagAscii, "utf8") : Buffer.alloc(0);
    this._emitCipher(Buffer.concat([Buffer.from([OP.RESPONSE, item, 0x00]), extra]));
  }
  disconnect() { this.disconnected = true; return Promise.resolve(); }
  _emitPlain(f) { for (const s of splitSegments(f, SEG.PLAINTEXT)) this.onPacket(s); }
  _emitCipher(f) { const ct = ccmEncrypt(this.secret, this.encCount, this.token, f, "wm2"); this.encCount++; for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s); }
}

describe("SesameBle facade", () => {
  it("connect → unlock → autolock → close", async () => {
    const dev = new MockSesame();
    const ble = new SesameBle({ secretKey: SECRET, transport: dev });
    await ble.connect();
    expect(ble.isConnected).toBe(true);

    await ble.unlock(); // 履歴タグ無し
    expect(dev.lastCommand.item).toBe(ITEM.UNLOCK);
    expect(dev.lastCommand.data).toEqual(Buffer.from([0x00, 0x0e])); // historyTagBLE() = type のみ

    const r = await ble.autolock(30);
    expect(r.resultCode).toBe(0);
    expect(dev.lastCommand.item).toBe(ITEM.AUTOLOCK);
    expect([...dev.lastCommand.data]).toEqual([30, 0]); // 2B LE

    await ble.close();
    expect(dev.disconnected).toBe(true);
  });

  it("magnet は MAGNET(17) を空ペイロードで送る (lock5)", async () => {
    const dev = new MockSesame();
    const ble = new SesameBle({ secretKey: SECRET, transport: dev });
    await ble.connect();
    const r = await ble.magnet();
    expect(r.resultCode).toBe(0);
    expect(dev.lastCommand.item).toBe(ITEM.MAGNET);
    expect(dev.lastCommand.data.length).toBe(0);
    await ble.close();
  });

  it("magnet は LOCK5 系以外 (bot_2/bike_2) では型エラー", async () => {
    const bot = new SesameBle({ secretKey: SECRET, model: "bot_2", transport: new MockSesame() });
    await bot.connect();
    expect(() => bot.magnet()).toThrow();
    await bot.close();
    const bike = new SesameBle({ secretKey: SECRET, model: "bike_2", transport: new MockSesame() });
    await bike.connect();
    expect(() => bike.magnet()).toThrow();
    await bike.close();
  });

  it("opSensorControl は OPS_CONTROL(92) を 2B LE で送る (lock5)", async () => {
    const dev = new MockSesame();
    const ble = new SesameBle({ secretKey: SECRET, transport: dev });
    await ble.connect();
    const r = await ble.opSensorControl(300);
    expect(r.resultCode).toBe(0);
    expect(dev.lastCommand.item).toBe(ITEM.OPS_CONTROL); // 92
    expect(dev.lastCommand.data.toString("hex")).toBe("2c01");
    await ble.close();
  });

  it("sendAdvProductType は SET_ADV_PRODUCT_TYPE(205) に生バイト列を載せる (lock5)", async () => {
    const dev = new MockSesame();
    const ble = new SesameBle({ secretKey: SECRET, transport: dev });
    await ble.connect();
    const r = await ble.sendAdvProductType(Buffer.from("dead", "hex"));
    expect(r.resultCode).toBe(0);
    expect(dev.lastCommand.item).toBe(ITEM.SS3_ITEM_CODE_SET_ADV_PRODUCT_TYPE); // 205
    expect(dev.lastCommand.data.toString("hex")).toBe("dead");
    await ble.close();
  });

  it("opSensorControl/sendAdvProductType は LOCK5 系以外 (bot_2) では型エラー", async () => {
    const bot = new SesameBle({ secretKey: SECRET, model: "bot_2", transport: new MockSesame() });
    await bot.connect();
    expect(() => bot.opSensorControl(30)).toThrow();
    expect(() => bot.sendAdvProductType(Buffer.alloc(1))).toThrow();
    await bot.close();
  });

  // CHSesame5 固有コマンド (magnet/opSensorControl/sendAdvProductType/configureLockPosition) は
  // SDK では CHSesame5 にのみ宣言される (OS2 ロックは持たない)。OS2 SESAME2/4 も autolock 能力を
  // 持つため、かつて _assertOp("autolock") でゲートしていた頃は誤って通っていた (over-exposure)。
  // os===3 && kind===LOCK5 ゲートで OS2 ロックが弾かれることを確認する。
  it.each(["sesame_2", "sesame_4"])("CHSesame5 固有コマンドは OS2 ロック (%s) では型エラー", async (model) => {
    const ble = new SesameBle({ secretKey: SECRET, model, transport: new MockSesame() });
    await ble.connect();
    expect(() => ble.magnet()).toThrow();
    expect(() => ble.opSensorControl(30)).toThrow();
    expect(() => ble.sendAdvProductType(Buffer.alloc(1))).toThrow();
    expect(() => ble.configureLockPosition(0, 0)).toThrow();
    await ble.close();
  });

  it("setBleTxPower は BLE_TX_POWER_SETTING(206) を符号付き 1B で送る (lock5)", async () => {
    const dev = new MockSesame();
    const ble = new SesameBle({ secretKey: SECRET, model: "sesame_5", transport: dev });
    await ble.connect();
    const r = await ble.setBleTxPower(-4);
    expect(r.resultCode).toBe(0);
    expect(dev.lastCommand.item).toBe(ITEM.SSM3_ITEM_CODE_BLE_TX_POWER_SETTING); // 206
    expect(dev.lastCommand.data.toString("hex")).toBe("fc"); // -4 → 0xFC
    await ble.close();
  });

  it("setBleTxPower は biometric 機種でも送れる (CHSesameBiometricDeviceImpl も実装)", async () => {
    const dev = new MockSesame();
    const ble = new SesameBle({ secretKey: SECRET, model: "ssm_touch", transport: dev });
    await ble.connect();
    const r = await ble.setBleTxPower(0);
    expect(r.resultCode).toBe(0);
    expect(dev.lastCommand.item).toBe(ITEM.SSM3_ITEM_CODE_BLE_TX_POWER_SETTING);
    await ble.close();
  });

  it("setBleTxPower は Hub3/WM2/OS2 では型エラー (OS3 lock + biometric のみ)", async () => {
    // wm_2 は profile "wm2" (initial=13/生鍵/sault=token4) で handshake するため専用 mock を使う (P1-6)。
    for (const model of ["hub_3", "wm_2", "sesame_2", "bot_2", "bike_2"]) {
      const ble = new SesameBle({ secretKey: SECRET, model, transport: model === "wm_2" ? new MockWM2() : new MockSesame() });
      await ble.connect();
      expect(() => ble.setBleTxPower(0), model).toThrow();
      await ble.close();
    }
  });

  it("reset は RESET(104) を空ペイロードで送り WM2 以外の全 OS3 機種で使える", async () => {
    for (const model of ["sesame_5", "bot_2", "bike_2", "bike_3", "ssm_touch", "hub_3"]) {
      const dev = new MockSesame();
      const ble = new SesameBle({ secretKey: SECRET, model, transport: dev });
      await ble.connect();
      const r = await ble.reset();
      expect(r.resultCode, model).toBe(0);
      expect(dev.lastCommand.item, model).toBe(ITEM.RESET); // 104
      expect(dev.lastCommand.data.length, model).toBe(0);
      // 成功時に session 破棄 = transport.disconnect 呼び出し
      expect(dev.disconnected, model).toBe(true);
    }
  });

  it("reset は wm_2 では RESET_WM2(18) へ自動ルーティングする (CHWifiModule2Device.kt:437-448)", async () => {
    // Kotlin の WM2 は reset() を RESET_WM2(18) にオーバーライドし、成功時に dropKey (= 切断) する。
    // ファサード reset() は wifiProvisioning のとき WifiModule2.reset() (wm2.js) へ委譲する
    // (追加バックログ 1)。wm_2 は profile "wm2" の handshake (P1-6) なので専用 mock を使う。
    const dev = new MockWM2();
    const ble = new SesameBle({ secretKey: SECRET, model: "wm_2", transport: dev });
    await ble.connect();
    const r = await ble.reset();
    expect(r.resultCode).toBe(0);
    expect(dev.lastCommand.item).toBe(18); // WM2ActionCode.RESET_WM2 (kt:540)
    expect(dev.lastCommand.data.length).toBe(0); // byteArrayOf() (kt:443)
    // 成功時 dropKey 相当 = session 破棄 (transport.disconnect 呼び出し)
    expect(dev.disconnected).toBe(true);
  });

  it("getVersionTag は lock 系で versionTag(5) を、wm_2 で WM2 VERSION_TAG(127) を送る", async () => {
    // lock profile: CHSesameOS3.kt:398-418 — item=5, payload=UTF-8 文字列。
    const lockDev = new MockSesame();
    lockDev.versionTagAscii = "3.0-4-abcdef"; // 応答 payload に載せる固定ベクタ
    const lock = new SesameBle({ secretKey: SECRET, model: "sesame_5", transport: lockDev });
    await lock.connect();
    expect(await lock.getVersionTag()).toBe("3.0-4-abcdef");
    expect(lockDev.lastCommand.item).toBe(ITEM.VERSION_TAG); // 5
    expect(lockDev.lastCommand.data.length).toBe(0);
    await lock.close();

    // wm2 profile: CHWifiModule2Device.kt:423-435 — item=WM2ActionCode.VERSION_TAG(127)、
    // data=byteArrayOf()、応答 payload は String(res.payload)。WM2 の action code 空間では
    // 5=CONNECT_WIFI なので 5 を送る旧挙動は Wi-Fi 接続開始の誤発火だった (追加バックログ 2)。
    const wm2Dev = new MockWM2();
    wm2Dev.versionTagAscii = "wm2-1.0-cafe";
    const wm2 = new SesameBle({ secretKey: SECRET, model: "wm_2", transport: wm2Dev });
    await wm2.connect();
    expect(await wm2.getVersionTag()).toBe("wm2-1.0-cafe");
    expect(wm2Dev.lastCommand.item).toBe(127); // WM2ActionCode.VERSION_TAG (kt:540)
    expect(wm2Dev.lastCommand.data.length).toBe(0);
    await wm2.close();
  });

  it("reset は OS2 機種では型エラー (別系統の reset)", async () => {
    for (const model of ["sesame_2", "sesame_4", "ssmbot_1", "bike_1"]) {
      const ble = new SesameBle({ secretKey: SECRET, model, transport: new MockSesame() });
      await ble.connect();
      expect(() => ble.reset(), model).toThrow();
      await ble.close();
    }
  });

  it("toggle は lastStatus が locked なら unlock", async () => {
    const dev = new MockSesame({ initialState: LOCKED });
    const ble = new SesameBle({ secretKey: SECRET, transport: dev });
    await ble.connect();
    expect(ble.lastStatus.state).toBe("locked");
    await ble.toggle();
    expect(dev.lastCommand.item).toBe(ITEM.UNLOCK);
    await ble.close();
  });

  it("toggle は unlocked なら lock", async () => {
    const dev = new MockSesame({ initialState: UNLOCKED });
    const ble = new SesameBle({ secretKey: SECRET, transport: dev });
    await ble.connect();
    expect(ble.lastStatus.state).toBe("unlocked");
    await ble.toggle();
    expect(dev.lastCommand.item).toBe(ITEM.LOCK);
    await ble.close();
  });

  it("status() は受信済み mechStatus を返す", async () => {
    const dev = new MockSesame({ initialState: LOCKED });
    const ble = new SesameBle({ secretKey: SECRET, transport: dev });
    await ble.connect();
    const s = await ble.status();
    expect(s.state).toBe("locked");
    await ble.close();
  });

  it("SesameBle.use は connect/close を自動化", async () => {
    const dev = new MockSesame();
    let called = false;
    await SesameBle.use({ secretKey: SECRET, transport: dev }, async (lock) => {
      called = true;
      await lock.lock();
    });
    expect(called).toBe(true);
    expect(dev.disconnected).toBe(true);
    expect(dev.lastCommand.item).toBe(ITEM.LOCK);
  });

  it("secretKey 必須", () => {
    expect(() => new SesameBle({})).toThrow(/secretKey required/);
  });

  it("model=bot_2 は click のみ。lock/unlock/toggle/autolock は型エラー", async () => {
    const dev = new MockSesame();
    const ble = new SesameBle({ secretKey: SECRET, model: "bot_2", transport: dev });
    await ble.connect();
    expect(ble.capabilities.kind).toBe("bot2");
    await ble.click();
    expect(dev.lastCommand.item).toBe(ITEM.CLICK); // 89
    expect(() => ble.lock()).toThrow(/click/);     // 同期 throw。非対応 → 可能操作を案内
    expect(() => ble.unlock()).toThrow();
    expect(() => ble.autolock(30)).toThrow();
    await expect(ble.toggle()).rejects.toThrow();  // toggle は async なので reject
    await ble.close();
  });

  it("model=bike_2 は unlock のみ。lock/click は型エラー", async () => {
    const dev = new MockSesame();
    const ble = new SesameBle({ secretKey: SECRET, model: "bike_2", transport: dev });
    await ble.connect();
    await ble.unlock();
    expect(dev.lastCommand.item).toBe(ITEM.UNLOCK);
    expect(() => ble.lock()).toThrow();
    expect(() => ble.click()).toThrow();
    await ble.close();
  });

  it("model=sesame_5 (既定) は click 非対応", async () => {
    const dev = new MockSesame();
    const ble = new SesameBle({ secretKey: SECRET, model: "sesame_5", transport: dev });
    await ble.connect();
    expect(ble.capabilities.kind).toBe("lock5");
    expect(() => ble.click()).toThrow();
    await ble.close();
  });

  it("script ゲッタ: bot_2/bot_3 でのみ露出し、click(index)/select/sendClickScript を送る", async () => {
    const dev = new MockSesame();
    const ble = new SesameBle({ secretKey: SECRET, model: "bot_3", transport: dev });
    await ble.connect();
    expect(ble.capabilities.script).toBe(true);
    // index 指定 click → RUN_SCRIPT_0(170)+index
    await ble.script.click(2);
    expect(dev.lastCommand.item).toBe(172);
    // selectScript → SCRIPT_SELECT(94) + [index]
    await ble.script.selectScript(5);
    expect(dev.lastCommand.item).toBe(94);
    expect(dev.lastCommand.data.equals(Buffer.from([5]))).toBe(true);
    // sendClickScript → EDIT_SCRIPT(181)
    await ble.script.sendClickScript(0, { name: "x", actions: [] });
    expect(dev.lastCommand.item).toBe(181);
    // 同じ getter は同一インスタンスを返す (遅延キャッシュ)
    expect(ble.script).toBe(ble.script);
    await ble.close();
  });

  it("script ゲッタ: bot 以外 (sesame_5/bike_2/hub_3) では非対応エラー", async () => {
    for (const model of ["sesame_5", "bike_2", "hub_3"]) {
      const ble = new SesameBle({ secretKey: SECRET, model, transport: new MockSesame() });
      expect(() => ble.script).toThrow();
    }
  });

  it("fingerPrint ゲッタ: bike_3 でのみ露出し、指紋系 itemCode (115-122) を送る", async () => {
    const dev = new MockSesame();
    const ble = new SesameBle({ secretKey: SECRET, model: "bike_3", transport: dev });
    await ble.connect();
    expect(ble.capabilities.fingerprint).toBe(true);
    // fingerPrintModeSet(mode) → SSM_OS3_FINGERPRINT_MODE_SET(122) + [mode]
    await ble.fingerPrint.fingerPrintModeSet(1);
    expect(dev.lastCommand.item).toBe(122);
    expect(dev.lastCommand.data.equals(Buffer.from([1]))).toBe(true);
    // fingerPrints() → SSM_OS3_FINGERPRINT_GET(117) + 空
    await ble.fingerPrint.fingerPrints();
    expect(dev.lastCommand.item).toBe(117);
    expect(dev.lastCommand.data.length).toBe(0);
    // fingerPrintDelete(id) → SSM_OS3_FINGERPRINT_DELETE(116) + id(hex→bytes)
    await ble.fingerPrint.fingerPrintDelete("0a0b");
    expect(dev.lastCommand.item).toBe(116);
    expect(dev.lastCommand.data.equals(Buffer.from([0x0a, 0x0b]))).toBe(true);
    // 指紋サブセットのみ露出 (card/passcode/face/palm は無い)
    expect(ble.fingerPrint.cardModeSet).toBeUndefined();
    expect(ble.fingerPrint.passcodeModeSet).toBeUndefined();
    // 同じ getter は同一インスタンスを返す (遅延キャッシュ)
    expect(ble.fingerPrint).toBe(ble.fingerPrint);
    await ble.close();
  });

  it("fingerPrint ゲッタ: bike_3 以外 (bike_2/sesame_5/bot_2/ssm_touch) では非対応エラー", async () => {
    for (const model of ["bike_2", "sesame_5", "bot_2", "ssm_touch"]) {
      const ble = new SesameBle({ secretKey: SECRET, model, transport: new MockSesame() });
      expect(() => ble.fingerPrint).toThrow();
    }
  });

  it("hub3 ゲッタ: connect → Hub3 Wi-Fi コマンドが SesameItemCode 直で送れる (hub_3)", async () => {
    const dev = new MockSesame();
    const ble = new SesameBle({ secretKey: SECRET, model: "hub_3", transport: dev });
    await ble.connect();
    expect(ble.isConnected).toBe(true); // Hub3 は ble[] 空でも connect/login できる
    // scanWifiSSID → HUB3_ITEM_CODE_WIFI_SSID(131) + 空
    await ble.hub3().scanWifiSSID();
    expect(dev.lastCommand.item).toBe(ITEM.HUB3_ITEM_CODE_WIFI_SSID);
    expect(dev.lastCommand.data.length).toBe(0);
    // setWifiSSID → HUB3_UPDATE_WIFI_SSID(136) + UTF-8
    await ble.hub3().setWifiSSID("net");
    expect(dev.lastCommand.item).toBe(ITEM.HUB3_UPDATE_WIFI_SSID);
    expect(dev.lastCommand.data.equals(Buffer.from("net", "utf8"))).toBe(true);
    // 同じ getter は同一インスタンスを返す (遅延キャッシュ)
    expect(ble.hub3()).toBe(ble.hub3());
    await ble.close();
  });

  it("hub3 ゲッタ: Hub3 以外 (sesame_5/wm_2/bot_2) では非対応エラー", () => {
    for (const model of ["sesame_5", "wm_2", "bot_2", "ssm_touch"]) {
      const ble = new SesameBle({ secretKey: SECRET, model, transport: new MockSesame() });
      expect(() => ble.hub3()).toThrow();
    }
  });

  it("updateFirmware(hub_3) は MOVE_TO(84) を送る (CHHub3Device.kt:217-230 のデッドコード解消)", async () => {
    // Hub3 が connect/login できる経路が無く到達不能だった HUB3 分岐が、connect 配線で到達可能に。
    const dev = new MockSesame();
    const ble = new SesameBle({ secretKey: SECRET, model: "hub_3", transport: dev });
    await ble.connect();
    const r = await ble.updateFirmware();
    expect(dev.lastCommand.item).toBe(ITEM.MOVE_TO); // 84 (updateFirmwareBleOnly)
    expect(dev.lastCommand.data.length).toBe(0);
    expect(r.resultCode).toBe(0);
    await ble.close();
  });
});

describe("SesameBle facade — biometric の機種別 capability ゲート (P3-15)", () => {
  it("ssm_touch: card+fingerprint のみ (passcode/face/palm 系メソッドは見えない — DeviceProfiles.SESAME_TOUCH)", async () => {
    const dev = new MockSesame();
    const ble = new SesameBle({ secretKey: SECRET, model: "ssm_touch", transport: dev });
    const bio = ble.biometric;
    // 集合内 (CHSesameBiometricDevice.kt:45 = {CARD, FINGERPRINT})
    expect(typeof bio.cardModeSet).toBe("function");
    expect(typeof bio.cardBatchAdd).toBe("function");
    expect(typeof bio.fingerPrintModeSet).toBe("function");
    // 集合外: passcode/face/palm は持たない
    expect(bio.passcodeModeSet).toBeUndefined();
    expect(bio.passcodeAdd).toBeUndefined();
    expect(bio.passcodeBatchAdd).toBeUndefined();
    expect(bio.faceModeSet).toBeUndefined();
    expect(bio.palmModeSet).toBeUndefined();
    // 共通 API (CHSesameConnector / delegate 結線) は常に載る
    expect(typeof bio.insertSesame).toBe("function");
    expect(typeof bio.removeSesame).toBe("function");
    expect(typeof bio.registerDelegate).toBe("function");
    expect(typeof bio.onEnroll).toBe("function");
    // 遅延キャッシュ (同一インスタンス)
    expect(ble.biometric).toBe(ble.biometric);
    // 実際に card コマンドが送れる (connect 後)
    await ble.connect();
    await bio.cardModeSet(1);
    expect(dev.lastCommand.item).toBe(ITEM.CARD_MODE_SET);
    await ble.close();
  });

  it("ssm_touch_pro: passcode 系が見える (DeviceProfiles.SESAME_TOUCH_PRO)", () => {
    const ble = new SesameBle({ secretKey: SECRET, model: "ssm_touch_pro", transport: new MockSesame() });
    const bio = ble.biometric;
    expect(typeof bio.passcodeModeSet).toBe("function");
    expect(typeof bio.cardModeSet).toBe("function");
    expect(typeof bio.fingerPrintModeSet).toBe("function");
    // face/palm は無い
    expect(bio.faceModeSet).toBeUndefined();
    expect(bio.palmModeSet).toBeUndefined();
  });

  it("sesame_face_ai: palm+face のみ (card/fingerprint/passcode は見えない — DeviceProfiles.SESAME_FACE_AI)", () => {
    const ble = new SesameBle({ secretKey: SECRET, model: "sesame_face_ai", transport: new MockSesame() });
    const bio = ble.biometric;
    expect(typeof bio.faceModeSet).toBe("function");
    expect(typeof bio.palmModeSet).toBe("function");
    expect(bio.cardModeSet).toBeUndefined();
    expect(bio.cardAdd).toBeUndefined();
    expect(bio.fingerPrintModeSet).toBeUndefined();
    expect(bio.passcodeModeSet).toBeUndefined();
  });

  it("sesame_face_Pro: 全 capability (DeviceProfiles.SESAME_FACE_PRO)", () => {
    const ble = new SesameBle({ secretKey: SECRET, model: "sesame_face_Pro", transport: new MockSesame() });
    const bio = ble.biometric;
    for (const m of ["cardModeSet", "fingerPrintModeSet", "passcodeModeSet", "faceModeSet", "palmModeSet"]) {
      expect(typeof bio[m]).toBe("function");
    }
  });

  it("空集合機種 (open_sensor_1/open_sensor_2/remote/remote_nano) は biometric ゲッタが throw", () => {
    // CHDeivceProtocols.kt:81,112,118,172: deviceFactory(..., setOf()) — enroll API を一切持たない。
    for (const model of ["open_sensor_1", "open_sensor_2", "remote", "remote_nano"]) {
      const ble = new SesameBle({ secretKey: SECRET, model, transport: new MockSesame() });
      expect(() => ble.biometric).toThrow(/capability/);
    }
  });

  it("BLE3-03: Hub3/biometric は login 後の time(8) 自動同期を送らない (CHHub3Device.kt:167-178 / CHSesameBiometricDeviceImpl.kt:258-277)", async () => {
    // lock (既定 model): mock の login 応答 systemTime=0 (遠過去) → time(8) が飛ぶ。
    const lockDev = new MockSesame();
    const lock = new SesameBle({ secretKey: SECRET, transport: lockDev });
    await lock.connect();
    expect(lockDev.lastCommand?.item).toBe(ITEM.TIME);
    await lock.close();
    // Hub3/biometric: login override は handleLoginResponse (時刻同期) を呼ばないため
    // 同条件でも何も送られない (CHSesameBiometricDeviceImpl は CHSesameOS3 直継承)。
    for (const model of ["hub_3", "ssm_touch"]) {
      const dev = new MockSesame();
      const ble = new SesameBle({ secretKey: SECRET, model, transport: dev });
      await ble.connect();
      expect(ble.isConnected).toBe(true);
      expect(dev.lastCommand).toBeNull();
      await ble.close();
    }
  });
});

// BLE3-0170..BLE3-0187: fingerPrint / remoteNano / radar / connector / pubkey
//
// 対象実装: packages/core/src/ble/biometric.js
//
// 方針:
//   - ネットワーク/実機に触れない (全て純関数 + セッションスタブ)
//   - 各 it のタイトル先頭に [BLE3-NNNN] を置く
//   - spec の assert を正とし、実装が食い違う箇所はそのまま red (TDD)

import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";
import {
  parseTouchCard,
  parsePubKeySesame,
  parseRemoteNanoTrigger,
  fingerPrintGetData,
  fingerPrintDeleteData,
  fingerPrintChangeData,
  remoteNanoTriggerDelayData,
  radarSensitivityData,
  insertSesameData,
  removeSesameData,
  handleBiometricPublish,
  BiometricCommands,
} from "../../src/ble/biometric.js";

import { ITEM_CODES as ITEM } from "../../src/itemcodes.js";

// ============================================================
// ヘルパ: 最小セッションスタブを生成する
// ============================================================
/**
 * BiometricCommands 用の最小セッションスタブを返す。
 * request は vi.fn() で、呼び出し引数を後から検証できる。
 * @param {{resultCode?:number, payload?:Buffer}} [ackOverride]
 * @returns {{ session: object, requestSpy: ReturnType<typeof vi.fn> }}
 */
function makeSessionStub(ackOverride = {}) {
  const ack = { resultCode: 0, payload: Buffer.alloc(0), ...ackOverride };
  const requestSpy = vi.fn(async () => ack);
  const session = {
    request: requestSpy,
    onPublish: undefined,
  };
  return { session, requestSpy };
}

// ヘルパ: publish パケットを組み立てる
function makePkt(itemCode, payloadBytes) {
  return { itemCode, body: Buffer.from(payloadBytes) };
}

// ============================================================
// BLE3-0170: fingerPrints → FINGERPRINT_GET(117) 空 data
// ============================================================
describe("BLE3-0170: fingerPrints → FINGERPRINT_GET(117) 空 data", () => {
  it("[BLE3-0170] fingerPrints は itemCode=117・空 data を request に渡す", async () => {
    const { session, requestSpy } = makeSessionStub();
    const cmd = new BiometricCommands(session);
    await cmd.fingerPrints();
    expect(requestSpy).toHaveBeenCalledOnce();
    const [itemCode, data] = requestSpy.mock.calls[0];
    expect(itemCode).toBe(ITEM.FINGERPRINT_GET); // 117
    expect(Buffer.isBuffer(data)).toBe(true);
    expect(data.length).toBe(0);
  });

  it("[BLE3-0170] fingerPrintGetData() は長さ 0 の Buffer を返す", () => {
    const d = fingerPrintGetData();
    expect(d).toBeInstanceOf(Buffer);
    expect(d.length).toBe(0);
  });
});

// ============================================================
// BLE3-0171: fingerPrintDelete → FINGERPRINT_DELETE(116) + id(hex→bytes 全体)
// ============================================================
describe("BLE3-0171: fingerPrintDelete → FINGERPRINT_DELETE(116) + id(hex→bytes 全体)", () => {
  it("[BLE3-0171] fingerPrintDeleteData は hex 文字列 全体を bytes に変換する", () => {
    const fingerPrintID = "0102030405"; // 5B
    const data = fingerPrintDeleteData(fingerPrintID);
    expect(data).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]));
  });

  it("[BLE3-0171] fingerPrintDelete は itemCode=116 を使う", async () => {
    const { session, requestSpy } = makeSessionStub();
    const cmd = new BiometricCommands(session);
    await cmd.fingerPrintDelete("0a0b");
    const [itemCode] = requestSpy.mock.calls[0];
    expect(itemCode).toBe(ITEM.FINGERPRINT_DELETE); // 116
  });

  it("[BLE3-0171] fingerPrintDelete の data は hex 全体 (card の部分切り出しとは異なる)", async () => {
    const { session, requestSpy } = makeSessionStub();
    const cmd = new BiometricCommands(session);
    const id = "deadbeef00112233"; // 8B
    await cmd.fingerPrintDelete(id);
    const [, data] = requestSpy.mock.calls[0];
    expect(data.length).toBe(8);
    expect(data.toString("hex")).toBe(id);
  });

  it("[BLE3-0171] fingerPrintDeleteData: 1B hex でも全バイト (= 1B) を返す", () => {
    const d = fingerPrintDeleteData("7f");
    expect(d.length).toBe(1);
    expect(d[0]).toBe(0x7f);
  });
});

// ============================================================
// BLE3-0172: fingerPrintChange → FINGERPRINT_CHANGE(115) + [idLen][id][hexName畳み]
// ============================================================
describe("BLE3-0172: fingerPrintChange → FINGERPRINT_CHANGE(115) + [idLen][id(hex→bytes)][hexName畳み]", () => {
  it("[BLE3-0172] fingerPrintChangeData は [idLen][id bytes][hexName 畳み] のバイト列", () => {
    // SDK kt:68 byteArrayOf(id.size) + id + hexName.chunked(2){toInt(16).toByte}
    const ID = "0102";
    const hexName = "0304";
    const data = fingerPrintChangeData(ID, hexName);
    // [idLen=2][0x01][0x02][0x03][0x04]
    expect(data).toEqual(Buffer.from([2, 0x01, 0x02, 0x03, 0x04]));
  });

  it("[BLE3-0172] hexName 奇数長末尾の 1 文字も byte として畳む (chunked 挙動)", () => {
    // SDK hexName.chunked(2) は末尾の 1 文字も独立 chunk として残す ("abc" → ["ab","c"])
    // "c".toInt(16) = 12 = 0x0c
    const ID = "01";
    const hexName = "abc"; // 3文字: "ab"(0xab) + "c"(0x0c)
    const data = fingerPrintChangeData(ID, hexName);
    // [idLen=1][0x01][0xab][0x0c]
    expect(data).toEqual(Buffer.from([1, 0x01, 0xab, 0x0c]));
  });

  it("[BLE3-0172] fingerPrintChange は itemCode=115 を使う", async () => {
    const { session, requestSpy } = makeSessionStub();
    const cmd = new BiometricCommands(session);
    await cmd.fingerPrintChange("0102", "0304");
    const [itemCode] = requestSpy.mock.calls[0];
    expect(itemCode).toBe(ITEM.FINGERPRINT_CHANGE); // 115
  });

  it("[BLE3-0172] fingerPrintChangeData: byteArrayOf(id.size) ++ id ++ hexName.chunked(2)", () => {
    const d = fingerPrintChangeData("ff", "0a0b");
    // id="ff"→[0xff] (1B), idLen=1, hexName="0a0b"→[0x0a,0x0b]
    expect([...d]).toEqual([0x01, 0xff, 0x0a, 0x0b]);
  });
});

// ============================================================
// BLE3-0173: FINGERPRINT_NOTIFY(118) publish → 1 レコード parse → onFingerPrintReceive
// ============================================================
describe("BLE3-0173: FINGERPRINT_NOTIFY(118) publish → 単一レコード parse → onFingerPrintReceive", () => {
  it("[BLE3-0173] FINGERPRINT_NOTIFY は 1 レコードだけ parse して onFingerPrintReceive を呼ぶ", () => {
    // cardType=0x05, idLen=2, id=0x0a0b, nameLen=2, name=0x0c0d → 7B
    const payload = Buffer.from([0x05, 0x02, 0x0a, 0x0b, 0x02, 0x0c, 0x0d]);
    const device = { id: "test-device" };
    const received = [];
    const delegate = {
      onFingerPrintReceive: (dev, cardID, cardName, cardType) => {
        received.push({ dev, cardID, cardName, cardType });
      },
    };
    const pkt = { itemCode: ITEM.FINGERPRINT_NOTIFY, body: payload };
    const result = handleBiometricPublish(pkt, delegate, device);
    expect(result).toBe(true);
    // 単一呼び出し (ループ無し)
    expect(received).toHaveLength(1);
    expect(received[0].cardID).toBe("0a0b");
    expect(received[0].cardName).toBe("0c0d");
    expect(received[0].cardType).toBe(0x05);
    expect(received[0].dev).toBe(device);
  });

  it("[BLE3-0173] FINGERPRINT_NOTIFY: 2 レコード連結でも 1 件のみ処理する (ループ無し)", () => {
    // FINGERPRINT_NOTIFY は CHFingerPrintEventHandlers.kt:30-33: 単一生成 + return true (ループ無し)
    const record = Buffer.from([0x04, 0x01, 0xff, 0x01, 0xee]); // 5B
    const doublePayload = Buffer.concat([record, record]); // 2 レコード連結
    const received = [];
    const delegate = {
      onFingerPrintReceive: (dev, cardID) => received.push(cardID),
    };
    const pkt = { itemCode: ITEM.FINGERPRINT_NOTIFY, body: doublePayload };
    handleBiometricPublish(pkt, delegate, null);
    // spec: 1 レコードのみ (ループ無し)
    expect(received).toHaveLength(1);
    expect(received[0]).toBe("ff");
  });
});

// ============================================================
// BLE3-0174: FINGERPRINT_DELETE(116) publish → payload 全体 hex → onFingerDelete
// ============================================================
describe("BLE3-0174: FINGERPRINT_DELETE(116) publish → payload 全体 hex → onFingerDelete", () => {
  it("[BLE3-0174] FINGERPRINT_DELETE publish は payload 全体を hex 化して onFingerDelete に渡す", () => {
    const payload = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const received = [];
    const delegate = {
      onFingerDelete: (dev, hexID) => received.push(hexID),
    };
    const pkt = { itemCode: ITEM.FINGERPRINT_DELETE, body: payload };
    const result = handleBiometricPublish(pkt, delegate, null);
    expect(result).toBe(true);
    // payload 全体を hex 化 (card/passcode の idLen 切り出しとは異なる)
    expect(received).toHaveLength(1);
    expect(received[0]).toBe("01020304");
  });

  it("[BLE3-0174] FINGERPRINT_DELETE payload 全体が hex (先頭3B 切りは行わない)", () => {
    // card CARD_DELETE は payload[2]=idLen で切り出すが、FINGERPRINT_DELETE は切り出し無し
    const payload = Buffer.from([0xaa, 0xbb, 0x02, 0xcc, 0xdd]);
    const received = [];
    const delegate = { onFingerDelete: (dev, hex) => received.push(hex) };
    handleBiometricPublish({ itemCode: ITEM.FINGERPRINT_DELETE, body: payload }, delegate, null);
    expect(received[0]).toBe("aabb02ccdd"); // 全体 (ccdd だけでない)
  });

  it("[BLE3-0174] 1B payload でも全体 hex を渡す", () => {
    const pkt = makePkt(ITEM.FINGERPRINT_DELETE, [0x7f]);
    let received = null;
    const delegate = { onFingerDelete: (_, id) => { received = id; } };
    handleBiometricPublish(pkt, delegate, null);
    expect(received).toBe("7f");
  });
});

// ============================================================
// BLE3-0175: FINGERPRINT_CHANGE(115)/FIRST(120)/LAST(119)/MODE_SET(122) publish 分岐
// ============================================================
describe("BLE3-0175: FINGERPRINT_CHANGE/FIRST/LAST/MODE_SET publish 分岐", () => {
  it("[BLE3-0175] FINGERPRINT_CHANGE(115) → onFingerPrintChanged(cardID, cardName, cardType)", () => {
    // card と同形: parseTouchCard 1 回して 3 フィールドを渡す (SDK kt:17-21)
    const payload = Buffer.from([0x05, 0x01, 0xaa, 0x01, 0xbb]); // type=5,idLen=1,id=aa,nameLen=1,name=bb
    const received = [];
    const delegate = {
      onFingerPrintChanged: (dev, cardID, cardName, cardType) =>
        received.push({ cardID, cardName, cardType }),
    };
    handleBiometricPublish({ itemCode: ITEM.FINGERPRINT_CHANGE, body: payload }, delegate, null);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ cardID: "aa", cardName: "bb", cardType: 0x05 });
  });

  it("[BLE3-0175] FINGERPRINT_FIRST(120) → onFingerPrintReceiveStart を呼ぶ (SDK kt:22-25)", () => {
    const called = [];
    const delegate = { onFingerPrintReceiveStart: (dev) => called.push(dev) };
    const result = handleBiometricPublish(
      { itemCode: ITEM.FINGERPRINT_FIRST, body: Buffer.alloc(0) },
      delegate,
      "DEV",
    );
    expect(result).toBe(true);
    expect(called).toHaveLength(1);
    expect(called[0]).toBe("DEV");
  });

  it("[BLE3-0175] FINGERPRINT_LAST(119) → onFingerPrintReceiveEnd を呼ぶ (SDK kt:26-29)", () => {
    const called = [];
    const delegate = { onFingerPrintReceiveEnd: (dev) => called.push(dev) };
    handleBiometricPublish(
      { itemCode: ITEM.FINGERPRINT_LAST, body: Buffer.alloc(0) },
      delegate,
      "DEV",
    );
    expect(called).toHaveLength(1);
  });

  it("[BLE3-0175] FINGERPRINT_MODE_SET(122) → onFingerModeChange(payload[0]) (SDK kt:35-38)", () => {
    const called = [];
    const delegate = { onFingerModeChange: (dev, mode) => called.push(mode) };
    handleBiometricPublish(
      { itemCode: ITEM.FINGERPRINT_MODE_SET, body: Buffer.from([0x02]) },
      delegate,
      null,
    );
    expect(called[0]).toBe(0x02);
  });
});

// ============================================================
// BLE3-0176: setTriggerDelayTime → REMOTE_NANO_SET_TRIGGER_DELAYTIME(190) + [time UByte 1B]
// ============================================================
describe("BLE3-0176: setTriggerDelayTime → REMOTE_NANO_SET_TRIGGER_DELAYTIME(190) + [time UByte 1B]", () => {
  it("[BLE3-0176] remoteNanoTriggerDelayData は 1B バッファを返す", () => {
    const data = remoteNanoTriggerDelayData(5);
    expect(data.length).toBe(1);
    expect(data[0]).toBe(5);
  });

  it("[BLE3-0176] setTriggerDelay は itemCode=190 を使う", async () => {
    const { session, requestSpy } = makeSessionStub();
    const cmd = new BiometricCommands(session);
    await cmd.setTriggerDelay(10);
    const [itemCode, data] = requestSpy.mock.calls[0];
    expect(itemCode).toBe(ITEM.REMOTE_NANO_SET_TRIGGER_DELAYTIME); // 190
    expect(data.length).toBe(1);
    expect(data[0]).toBe(10);
  });

  it("[BLE3-0176] time=0 と time=255 (UByte 境界) は正常", () => {
    expect(remoteNanoTriggerDelayData(0)[0]).toBe(0);
    expect(remoteNanoTriggerDelayData(255)[0]).toBe(255);
  });

  it("[BLE3-0176] remoteNanoTriggerDelayData: 128 を正しく 1B で返す", () => {
    expect([...remoteNanoTriggerDelayData(128)]).toEqual([0x80]);
  });
});

// ============================================================
// BLE3-0177: setTriggerDelayTime の UByte 範囲外 は rejected promise
// ============================================================
describe("BLE3-0177: setTriggerDelay の UByte 範囲外 (>255/<0/非整数) は rejected promise", () => {
  it("[BLE3-0177] time=256 は rejected promise (request 未発行)", async () => {
    const { session, requestSpy } = makeSessionStub();
    const cmd = new BiometricCommands(session);
    await expect(cmd.setTriggerDelay(256)).rejects.toThrow();
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("[BLE3-0177] time=-1 は rejected promise", async () => {
    const { session, requestSpy } = makeSessionStub();
    const cmd = new BiometricCommands(session);
    await expect(cmd.setTriggerDelay(-1)).rejects.toThrow();
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("[BLE3-0177] time=1.5 (非整数) は rejected promise", async () => {
    const { session, requestSpy } = makeSessionStub();
    const cmd = new BiometricCommands(session);
    await expect(cmd.setTriggerDelay(1.5)).rejects.toThrow();
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("[BLE3-0177] 同期 throw でなく rejected promise (async 関数として公開される)", async () => {
    // BiometricCommands.setTriggerDelay は async のため、throw は rejected promise に包まれる
    const { session } = makeSessionStub();
    const cmd = new BiometricCommands(session);
    const result = cmd.setTriggerDelay(999);
    expect(typeof result.then).toBe("function");
    await expect(result).rejects.toThrow();
  });

  it("[BLE3-0177] remoteNanoTriggerDelayData 直接呼び出しでも 256 は throw", () => {
    expect(() => remoteNanoTriggerDelayData(256)).toThrow();
    expect(() => remoteNanoTriggerDelayData(-1)).toThrow();
    expect(() => remoteNanoTriggerDelayData(1.5)).toThrow();
  });
});

// ============================================================
// BLE3-0178: TRIGGER_DELAYTIME(191) publish → fromData(先頭1B) → onTriggerDelaySecondReceived
// ============================================================
describe("BLE3-0178: TRIGGER_DELAYTIME(191) publish → fromData(先頭1B) → onTriggerDelaySecondReceived", () => {
  it("[BLE3-0178] parseRemoteNanoTrigger は先頭 1B を triggerDelaySecond として返す", () => {
    const data = Buffer.from([0x05, 0xff]);
    const result = parseRemoteNanoTrigger(data);
    expect(result.triggerDelaySecond).toBe(5); // 先頭 1B のみ
  });

  it("[BLE3-0178] parseRemoteNanoTrigger: 0x00 と 0xff の境界値", () => {
    expect(parseRemoteNanoTrigger(Buffer.from([0xff])).triggerDelaySecond).toBe(255);
    expect(parseRemoteNanoTrigger(Buffer.from([0x00])).triggerDelaySecond).toBe(0);
    expect(parseRemoteNanoTrigger(Buffer.from([0x0a])).triggerDelaySecond).toBe(10);
  });

  it("[BLE3-0178] parseRemoteNanoTrigger: 複数バイト payload でも先頭 1B のみ使う", () => {
    const result = parseRemoteNanoTrigger(Buffer.from([0x05, 0xff, 0xaa]));
    expect(result.triggerDelaySecond).toBe(5);
  });

  it("[BLE3-0178] TRIGGER_DELAYTIME(191) publish → onTriggerDelaySecondReceived({triggerDelaySecond})", () => {
    const called = [];
    const delegate = { onTriggerDelaySecondReceived: (dev, setting) => called.push(setting) };
    const payload = Buffer.from([0x0a]); // 10秒
    handleBiometricPublish(
      { itemCode: ITEM.REMOTE_NANO_PUB_TRIGGER_DELAYTIME, body: payload },
      delegate,
      null,
      { isRemote: true },
    );
    expect(called).toHaveLength(1);
    expect(called[0].triggerDelaySecond).toBe(10);
  });

  it("[BLE3-0178] payload[0] が 30 (0x1e) のとき triggerDelaySecond=30", () => {
    const pkt = makePkt(ITEM.REMOTE_NANO_PUB_TRIGGER_DELAYTIME, [0x1e]);
    let received = null;
    const delegate = {
      onTriggerDelaySecondReceived: (dev, setting) => { received = setting; },
    };
    handleBiometricPublish(pkt, delegate, "dev0");
    expect(received).not.toBeNull();
    expect(received.triggerDelaySecond).toBe(30);
  });
});

// ============================================================
// BLE3-0179: TRIGGER_DELAYTIME(191) dispatch は isRemote ゲートで分岐
// ============================================================
describe("BLE3-0179: TRIGGER_DELAYTIME(191) dispatch は isRemote ゲートで分岐 (BLEP-09)", () => {
  it("[BLE3-0179] isRemote=false → onTriggerDelaySecondReceived を呼ばず handled=true", () => {
    const called = [];
    const delegate = { onTriggerDelaySecondReceived: (dev, s) => called.push(s) };
    const result = handleBiometricPublish(
      { itemCode: ITEM.REMOTE_NANO_PUB_TRIGGER_DELAYTIME, body: Buffer.from([0x05]) },
      delegate,
      null,
      { isRemote: false },
    );
    expect(result).toBe(true); // handled=true (黙殺・処理済み)
    expect(called).toHaveLength(0); // dispatch しない
  });

  it("[BLE3-0179] isRemote=true → onTriggerDelaySecondReceived を呼ぶ", () => {
    const called = [];
    const delegate = { onTriggerDelaySecondReceived: (dev, s) => called.push(s) };
    handleBiometricPublish(
      { itemCode: ITEM.REMOTE_NANO_PUB_TRIGGER_DELAYTIME, body: Buffer.from([0x03]) },
      delegate,
      null,
      { isRemote: true },
    );
    expect(called).toHaveLength(1);
    expect(called[0].triggerDelaySecond).toBe(3);
  });

  it("[BLE3-0179] isRemote=null (機種不明) → dispatch する (後方互換)", () => {
    const called = [];
    const delegate = { onTriggerDelaySecondReceived: (dev, s) => called.push(s) };
    handleBiometricPublish(
      { itemCode: ITEM.REMOTE_NANO_PUB_TRIGGER_DELAYTIME, body: Buffer.from([0x07]) },
      delegate,
      null,
      { isRemote: null },
    );
    expect(called).toHaveLength(1);
  });

  it("[BLE3-0179] opts 省略 (isRemote 未指定) → dispatch する (従来互換)", () => {
    const called = [];
    const delegate = { onTriggerDelaySecondReceived: (dev, s) => called.push(s) };
    handleBiometricPublish(
      { itemCode: ITEM.REMOTE_NANO_PUB_TRIGGER_DELAYTIME, body: Buffer.from([0x0a]) },
      delegate,
      null,
    );
    expect(called).toHaveLength(1);
  });

  it("[BLE3-0179] BiometricCommands(model='remote_nano') → isRemote=true で publish dispatch される", () => {
    // capabilitiesForModel('remote_nano').isRemote === true (devicemodel.js:205)
    const received = [];
    let publishHandler;
    const session = {
      request: vi.fn(async () => ({ resultCode: 0, payload: Buffer.alloc(0) })),
      onPublish: (fn) => { publishHandler = fn; return () => {}; },
    };
    const cmd = new BiometricCommands(session, { model: "remote_nano" });
    const delegate = { onTriggerDelaySecondReceived: (dev, s) => received.push(s) };
    cmd.registerDelegate(delegate, null);
    // publish を手動で流す
    publishHandler({ itemCode: ITEM.REMOTE_NANO_PUB_TRIGGER_DELAYTIME, body: Buffer.from([0x0f]) });
    expect(received).toHaveLength(1);
    expect(received[0].triggerDelaySecond).toBe(15);
  });

  it("[BLE3-0179] BiometricCommands(model='sesame_face') → isRemote=false で dispatch 黙殺", () => {
    const received = [];
    let publishHandler;
    const session = {
      request: vi.fn(async () => ({ resultCode: 0, payload: Buffer.alloc(0) })),
      onPublish: (fn) => { publishHandler = fn; return () => {}; },
    };
    const cmd = new BiometricCommands(session, { model: "sesame_face" });
    const delegate = { onTriggerDelaySecondReceived: (dev, s) => received.push(s) };
    cmd.registerDelegate(delegate, null);
    publishHandler({ itemCode: ITEM.REMOTE_NANO_PUB_TRIGGER_DELAYTIME, body: Buffer.from([0x05]) });
    expect(received).toHaveLength(0); // 黙殺
  });
});

// ============================================================
// BLE3-0180: setTriggerDelayTime の ack 契約 (ack を捨てない)
// ============================================================
describe("BLE3-0180: setTriggerDelayTime の ack 契約 (ack を捨てない)", () => {
  it("[BLE3-0180] setTriggerDelay は request の {resultCode, payload} をそのまま返す", async () => {
    const ack = { resultCode: 0, payload: Buffer.from([0xab]) };
    const { session } = makeSessionStub(ack);
    const cmd = new BiometricCommands(session);
    const result = await cmd.setTriggerDelay(5);
    // ack を捨てず返すこと (bleCommandAck が {resultCode,payload} を包む契約に乗る)
    expect(result).toEqual(ack);
    expect(result.resultCode).toBe(0);
  });

  it("[BLE3-0180] setTriggerDelay は resultCode 非 0 の ack もそのまま返す (reject しない)", async () => {
    const ack = { resultCode: 3, payload: Buffer.alloc(0) };
    const { session } = makeSessionStub(ack);
    const cmd = new BiometricCommands(session);
    const result = await cmd.setTriggerDelay(0);
    expect(result.resultCode).toBe(3);
  });

  it("[BLE3-0180] setTriggerDelay が async であることを確認 (Promise を返す)", async () => {
    const ack = { resultCode: 0, payload: Buffer.alloc(0) };
    const { session } = makeSessionStub(ack);
    const cmd = new BiometricCommands(session);
    const p = cmd.setTriggerDelay(5);
    expect(p).toBeInstanceOf(Promise);
    expect(await p).toEqual(ack);
  });
});

// ============================================================
// BLE3-0181: setRadarSensitivity → RADAR_PARAM_SET(200) に raw payload を無加工
// ============================================================
describe("BLE3-0181: setRadarSensitivity → SSM_OS3_RADAR_PARAM_SET(200) に raw payload 無加工", () => {
  it("[BLE3-0181] radarSensitivityData は payload の Buffer をそのまま (Buffer.from コピー) 返す", () => {
    const payload = Buffer.from([0x01, 0x02, 0x03]);
    const data = radarSensitivityData(payload);
    expect(data).toEqual(payload);
    expect(Buffer.isBuffer(data)).toBe(true);
  });

  it("[BLE3-0181] setRadarSensitivity は itemCode=200 を使う", async () => {
    const { session, requestSpy } = makeSessionStub();
    const cmd = new BiometricCommands(session);
    const payload = Buffer.from([0xde, 0xad]);
    await cmd.setRadarSensitivity(payload);
    const [itemCode, data] = requestSpy.mock.calls[0];
    expect(itemCode).toBe(ITEM.SSM_OS3_RADAR_PARAM_SET); // 200
    expect(data).toEqual(payload);
  });

  it("[BLE3-0181] payload を構造変換しない (生バイト pass-through)", async () => {
    const payload = Buffer.alloc(10, 0xff);
    const { session, requestSpy } = makeSessionStub();
    const cmd = new BiometricCommands(session);
    await cmd.setRadarSensitivity(payload);
    const [, data] = requestSpy.mock.calls[0];
    expect(data.length).toBe(10);
    expect(data.every((b) => b === 0xff)).toBe(true);
  });

  it("[BLE3-0181] radarSensitivityData は空 payload でも動作する", () => {
    const d = radarSensitivityData(Buffer.alloc(0));
    expect(d.length).toBe(0);
  });
});

// ============================================================
// BLE3-0182: RADAR_PARAM_PUBLISH(201) publish → 生 payload → onRadarReceive
// ============================================================
describe("BLE3-0182: RADAR_PARAM_PUBLISH(201) publish → 生 payload → onRadarReceive", () => {
  it("[BLE3-0182] RADAR_PARAM_PUBLISH(201) publish は payload を加工せず onRadarReceive へ渡す", () => {
    const rawPayload = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
    const received = [];
    const delegate = { onRadarReceive: (dev, payload) => received.push(Buffer.from(payload)) };
    const result = handleBiometricPublish(
      { itemCode: ITEM.SSM_OS3_RADAR_PARAM_PUBLISH, body: rawPayload },
      delegate,
      null,
    );
    expect(result).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(rawPayload);
  });

  it("[BLE3-0182] onRadarReceive には 1B でも 10B でも生データがそのまま届く", () => {
    for (const len of [1, 10]) {
      const payload = Buffer.alloc(len, 0xab);
      const received = [];
      const delegate = { onRadarReceive: (dev, p) => received.push(p) };
      handleBiometricPublish(
        { itemCode: ITEM.SSM_OS3_RADAR_PARAM_PUBLISH, body: payload },
        delegate,
        null,
      );
      expect(received[0].length).toBe(len);
    }
  });

  it("[BLE3-0182] 空 payload でも onRadarReceive が呼ばれる", () => {
    const pkt = makePkt(ITEM.SSM_OS3_RADAR_PARAM_PUBLISH, []);
    let called = false;
    const delegate = { onRadarReceive: () => { called = true; } };
    handleBiometricPublish(pkt, delegate, null);
    expect(called).toBe(true);
  });
});

// ============================================================
// BLE3-0183: insertSesame OS3 子鍵 → ADD_SESAME(101) + UUID(16B)++secretKey(16B)
// ============================================================
describe("BLE3-0183: insertSesame OS3 子鍵 → ADD_SESAME(101) + UUID(16B)++secretKey(16B)", () => {
  const uuid = "0102030405060708090a0b0c0d0e0f10"; // 32hex = 16B
  const secret = "a1a2a3a4a5a6a7a8a9aaabacadaeafb0"; // 32hex = 16B

  it("[BLE3-0183] sesame2PublicKey 未指定 → UUID(16B)++secretKey(16B) の 32B", () => {
    // SDK kt:33 noDashUUIDDATA+ssmSecKa (OS3 分岐)
    const data = insertSesameData({ deviceUUID: uuid, secretKey: secret });
    expect(data.length).toBe(32);
    expect(data.subarray(0, 16).toString("hex")).toBe(uuid);
    expect(data.subarray(16, 32).toString("hex")).toBe(secret);
  });

  it("[BLE3-0183] insertSesame は itemCode=101 を使う", async () => {
    const { session, requestSpy } = makeSessionStub();
    const cmd = new BiometricCommands(session);
    await cmd.insertSesame({ deviceUUID: uuid, secretKey: secret });
    const [itemCode] = requestSpy.mock.calls[0];
    expect(itemCode).toBe(ITEM.ADD_SESAME); // 101
  });

  it("[BLE3-0183] insertSesameData OS3: ハイフン付き UUID 形式も受け入れる", () => {
    const hyphenUUID = "01020304-0506-0708-090a-0b0c0d0e0f10";
    const d = insertSesameData({ deviceUUID: hyphenUUID, secretKey: secret });
    expect(d.length).toBe(32);
    expect(d.subarray(0, 16).toString("hex")).toBe(uuid);
  });
});

// ============================================================
// BLE3-0184: insertSesame OS2 子鍵 → ADD_SESAME(101) + b64(UUID)(22B)++pubKey(64B)++secretKey(16B)
// ============================================================
describe("BLE3-0184: insertSesame OS2 子鍵 → ADD_SESAME(101) + b64(UUID)(22B)++pubKey(64B)++secretKey(16B)", () => {
  const uuid = "00112233445566778899aabbccddeeff"; // 32hex = 16B
  const pubKey = "aa".repeat(64); // 128hex = 64B
  const secret = "bb".repeat(16); // 32hex = 16B

  it("[BLE3-0184] sesame2PublicKey 指定 → b64(UUID)(22B)++pubKey(64B)++secretKey(16B) の 102B", () => {
    // SDK kt:44 ssmIRData+ssmPKData+ssmSecKa
    const data = insertSesameData({ deviceUUID: uuid, secretKey: secret, sesame2PublicKey: pubKey });
    const expectedTotal = 22 + 64 + 16; // 102B
    expect(data.length).toBe(expectedTotal);

    // 先頭 22B は base64(UUID16).replace('=','') の UTF-8
    const uuidBuf = Buffer.from(uuid, "hex");
    const b64k = uuidBuf.toString("base64").replace(/=/g, "");
    expect(b64k.length).toBe(22);
    expect(data.subarray(0, 22).toString("utf8")).toBe(b64k);

    // 次の 64B が pubKey
    expect(data.subarray(22, 86).toString("hex")).toBe(pubKey);

    // 最後の 16B が secret
    expect(data.subarray(86, 102).toString("hex")).toBe(secret);
  });

  it("[BLE3-0184] OS2 insertSesame は itemCode=101 を使う (OS3 と同じ ADD_SESAME)", async () => {
    const { session, requestSpy } = makeSessionStub();
    const cmd = new BiometricCommands(session);
    await cmd.insertSesame({ deviceUUID: uuid, secretKey: secret, sesame2PublicKey: pubKey });
    const [itemCode] = requestSpy.mock.calls[0];
    expect(itemCode).toBe(ITEM.ADD_SESAME); // 101
  });

  it("[BLE3-0184] allKey 連結順が ssmIRData+ssmPKData+ssmSecKa (kt:44) と一致する", () => {
    const d = insertSesameData({ deviceUUID: uuid, secretKey: secret, sesame2PublicKey: pubKey });
    const b64Part = d.subarray(0, 22);
    const pubPart = d.subarray(22, 86);
    const secPart = d.subarray(86, 102);
    // pubKey 確認
    expect(pubPart.toString("hex")).toBe(pubKey);
    // secretKey 確認
    expect(secPart.toString("hex")).toBe(secret);
    // b64 部分が UUID の base64 (末尾 "==" 除去)
    const decoded = Buffer.from(b64Part.toString("utf8") + "==", "base64");
    expect([...decoded]).toEqual([...Buffer.from(uuid, "hex")]);
  });
});

// ============================================================
// BLE3-0185: insertSesame の secretKey 16B / pubKey 64B 必須検証
// ============================================================
describe("BLE3-0185: insertSesame の secretKey 16B / pubKey 64B / deviceUUID 必須検証", () => {
  const validUUID = "0102030405060708090a0b0c0d0e0f10";
  const validSecret = "a1a2a3a4a5a6a7a8a9aaabacadaeafb0";
  const validPubKey = "ee".repeat(64);

  it("[BLE3-0185] secretKey が 16B でない (短い) → throw", () => {
    expect(() =>
      insertSesameData({ deviceUUID: validUUID, secretKey: "0102030405" /* 5B */ }),
    ).toThrow();
  });

  it("[BLE3-0185] secretKey が 16B でない (長い) → throw", () => {
    expect(() =>
      insertSesameData({ deviceUUID: validUUID, secretKey: "aa".repeat(17) /* 17B */ }),
    ).toThrow();
  });

  it("[BLE3-0185] sesame2PublicKey が 64B でない → throw", () => {
    expect(() =>
      insertSesameData({
        deviceUUID: validUUID,
        secretKey: validSecret,
        sesame2PublicKey: "aabb", /* 2B */
      }),
    ).toThrow();
  });

  it("[BLE3-0185] deviceUUID が 16B hex/UUID でない → throw", () => {
    expect(() =>
      insertSesameData({ deviceUUID: "zzzz", secretKey: validSecret }),
    ).toThrow();
  });

  it("[BLE3-0185] 正常値 (OS3) は throw しない", () => {
    expect(() =>
      insertSesameData({ deviceUUID: validUUID, secretKey: validSecret }),
    ).not.toThrow();
  });

  it("[BLE3-0185] 正常値 (OS2) は throw しない", () => {
    expect(() =>
      insertSesameData({ deviceUUID: validUUID, secretKey: validSecret, sesame2PublicKey: validPubKey }),
    ).not.toThrow();
  });
});

// ============================================================
// BLE3-0186: removeSesame keyType 分岐 → REMOVE_SESAME(103) payload
// ============================================================
describe("BLE3-0186: removeSesame keyType 分岐 → REMOVE_SESAME(103) payload", () => {
  const uuid = "00112233445566778899aabbccddeeff"; // 32hex = 16B

  it("[BLE3-0186] keyType=0x04 (OS2) → base64(UUID16).replace('=','') の UTF-8 bytes", () => {
    // SDK kt:72-77: base64(UUID).replace("=","").toByteArray()
    const data = removeSesameData(uuid, { keyType: 0x04 });
    const uuidBuf = Buffer.from(uuid, "hex");
    const expected = Buffer.from(uuidBuf.toString("base64").replace(/=/g, ""), "utf8");
    expect(data).toEqual(expected);
    expect(data.length).toBe(22); // 16B base64 → 22文字 (末尾 "==" 除去)
  });

  it("[BLE3-0186] keyType=0x05 (OS3 既定) → UUID16 raw bytes (16B)", () => {
    // SDK kt:80-83: raw UUID bytes
    const data = removeSesameData(uuid, { keyType: 0x05 });
    expect(data.length).toBe(16);
    expect(data.toString("hex")).toBe(uuid);
  });

  it("[BLE3-0186] keyType 省略 (既定=0x05) → OS3 形 UUID16 raw", () => {
    const data = removeSesameData(uuid);
    expect(data.length).toBe(16);
    expect(data.toString("hex")).toBe(uuid);
  });

  it("[BLE3-0186] removeSesame は itemCode=103 を使う", async () => {
    const { session, requestSpy } = makeSessionStub();
    const cmd = new BiometricCommands(session);
    await cmd.removeSesame(uuid, { keyType: 0x05 });
    const [itemCode] = requestSpy.mock.calls[0];
    expect(itemCode).toBe(ITEM.REMOVE_SESAME); // 103
  });

  it("[BLE3-0186] removeSesameData: keyType=0x04 → b64 UTF-8 / 0x05 → raw UUID", () => {
    const uuidBuf = Buffer.from(uuid, "hex");
    const b64k = uuidBuf.toString("base64").replace(/=/g, "");

    const os2 = removeSesameData(uuid, { keyType: 0x04 });
    expect(os2.toString("utf8")).toBe(b64k);

    const os3 = removeSesameData(uuid, { keyType: 0x05 });
    expect([...os3]).toEqual([...uuidBuf]);
  });
});

// ============================================================
// BLE3-0187: PUB_KEY_SESAME(102) publish → 23B 分割 → SS5/SS2 子鍵束 parse
// ============================================================
describe("BLE3-0187: PUB_KEY_SESAME(102) publish → 23B 分割 → SS5/SS2 子鍵束 parse", () => {
  /**
   * 23B SS5 チャンク: it[21]=0x00 → id=it[0..15] hex, keyType=0x05, lockStatus=it[22]
   */
  function makeSS5Chunk(id16hex, lockStatus) {
    const chunk = Buffer.alloc(23, 0x00);
    Buffer.from(id16hex, "hex").copy(chunk, 0); // it[0..15]
    chunk[21] = 0x00; // SS5 判定
    chunk[22] = lockStatus;
    return chunk;
  }

  /**
   * 23B SS2 チャンク: it[21]!=0x00, it[0..21]=base64(UUID16).replace('=','') の ASCII 22B
   */
  function makeSS2Chunk(uuid16hex, lockStatus) {
    const uuid16 = Buffer.from(uuid16hex, "hex");
    const b64 = uuid16.toString("base64"); // 24文字 (末尾 "==")
    const b22 = b64.slice(0, 22); // 末尾 "==" を除去
    const chunk = Buffer.alloc(23, 0x00);
    Buffer.from(b22, "latin1").copy(chunk, 0); // ASCII 22B
    // chunk[21] は b22[21] (非ゼロ = SS2 判定)
    chunk[22] = lockStatus;
    return chunk;
  }

  it("[BLE3-0187] SS5 チャンク (it[21]==0) → keyType=0x05, id=先頭16B hex", () => {
    const id16 = "0102030405060708090a0b0c0d0e0f10";
    const chunk = makeSS5Chunk(id16, 0x01);
    const { keys } = parsePubKeySesame(chunk);
    expect(keys).toHaveLength(1);
    expect(keys[0].keyType).toBe(0x05);
    expect(keys[0].ssmID).toBe(id16);
    expect(keys[0].lockStatus).toBe(1);
  });

  it("[BLE3-0187] SS2 チャンク (it[21]!=0) → keyType=0x04, id=base64decode(22B+'==') hex", () => {
    const uuid16 = "00112233445566778899aabbccddeeff";
    const chunk = makeSS2Chunk(uuid16, 0x02);
    const { keys } = parsePubKeySesame(chunk);
    expect(keys).toHaveLength(1);
    expect(keys[0].keyType).toBe(0x04);
    expect(keys[0].ssmID).toBe(uuid16);
    expect(keys[0].lockStatus).toBe(2);
  });

  it("[BLE3-0187] lockStatus=0 のチャンクはスキップ (空きスロット)", () => {
    const id16 = "aabbccddeeff00112233445566778899";
    const chunk = makeSS5Chunk(id16, 0x00); // lockStatus=0
    const { keys } = parsePubKeySesame(chunk);
    expect(keys).toHaveLength(0);
  });

  it("[BLE3-0187] 全ゼロチャンクは emptySlotCount に計上される", () => {
    const empty = Buffer.alloc(23, 0x00);
    const { keys, emptySlotCount, slotFull } = parsePubKeySesame(empty);
    expect(keys).toHaveLength(0);
    expect(emptySlotCount).toBe(1);
    expect(slotFull).toBe(false); // 空きあり
  });

  it("[BLE3-0187] SS2 復号長が 16B でないチャンクはスキップ (壊れスロット)", () => {
    // 22B に base64 非文字 (スペース) を混ぜて decoded が 16B にならないようにする
    const badChunk = Buffer.alloc(23, 0x00);
    for (let i = 0; i < 22; i++) badChunk[i] = i % 2 === 0 ? 0x41 : 0x20; // 'A' と ' ' 交互
    badChunk[21] = 0x20; // SS2 判定 (非ゼロ)
    badChunk[22] = 0x01; // lockStatus!=0
    // 復号長が 16B でないことを先に確認
    const decodedLen = Buffer.from(badChunk.subarray(0, 22).toString("latin1") + "==", "base64").length;
    expect(decodedLen).not.toBe(16);

    const { keys } = parsePubKeySesame(badChunk);
    expect(keys).toHaveLength(0);
  });

  it("[BLE3-0187] 複数チャンク (SS5 + SS2 + 空き) の混在 → 正常なものだけ keys に含まれる", () => {
    const ss5id = "0102030405060708090a0b0c0d0e0f10";
    const ss2id = "00112233445566778899aabbccddeeff";
    const ss5 = makeSS5Chunk(ss5id, 1);
    const ss2 = makeSS2Chunk(ss2id, 2);
    const empty = Buffer.alloc(23, 0x00);
    const payload = Buffer.concat([ss5, ss2, empty]);
    const { keys, emptySlotCount, slotFull } = parsePubKeySesame(payload);
    expect(keys).toHaveLength(2);
    expect(keys.find((k) => k.keyType === 0x05).ssmID).toBe(ss5id);
    expect(keys.find((k) => k.keyType === 0x04).ssmID).toBe(ss2id);
    expect(emptySlotCount).toBe(1);
    expect(slotFull).toBe(false);
  });

  it("[BLE3-0187] PUB_KEY_SESAME(102) publish → onSesameKeysReceived({keys,slotFull,emptySlotCount})", () => {
    const ss5id = "aabbccddeeff00112233445566778899";
    const chunk = makeSS5Chunk(ss5id, 3);
    const received = [];
    const delegate = { onSesameKeysReceived: (dev, result) => received.push(result) };
    const result = handleBiometricPublish(
      { itemCode: ITEM.PUB_KEY_SESAME, body: chunk },
      delegate,
      null,
    );
    expect(result).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].keys).toHaveLength(1);
    expect(received[0].keys[0].ssmID).toBe(ss5id);
    expect(received[0].slotFull).toBe(true); // emptySlotCount=0 → slotFull=true
  });

  it("[BLE3-0187] isOpenSensor=true のとき空きスロット判定が >1 になる (BLEP-11)", () => {
    // OpenSensor: hasEmptySlot = emptySlotCount > 1 (kt:228 >1)
    const emptyChunk1 = Buffer.alloc(23, 0x00);
    const emptyChunk2 = Buffer.alloc(23, 0x00);
    const r2 = parsePubKeySesame(Buffer.concat([emptyChunk1, emptyChunk2]), { isOpenSensor: true });
    expect(r2.emptySlotCount).toBe(2);
    expect(r2.slotFull).toBe(false); // >1 → 空きあり

    // 1 個だと slotFull=true (OpenSensor は >1 なので 1 個では空きなし)
    const r1 = parsePubKeySesame(emptyChunk1, { isOpenSensor: true });
    expect(r1.emptySlotCount).toBe(1);
    expect(r1.slotFull).toBe(true); // !hasEmptySlot (1 > 1 は false → slotFull)
  });

  it("[BLE3-0187] isOpenSensor=false (既定) のとき空きスロット判定が >=1 になる", () => {
    // 既定: hasEmptySlot = emptySlotCount > 0 (kt:230 >=1)
    const emptyChunk = Buffer.alloc(23, 0x00);
    const r = parsePubKeySesame(emptyChunk, { isOpenSensor: false });
    expect(r.emptySlotCount).toBe(1);
    expect(r.slotFull).toBe(false); // 1 >= 1 → 空きあり
  });
});

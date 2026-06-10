// 生体・アクセス制御 (card/finger/passcode/face/palm) 登録経路の単体テスト。
// バイト列・分割・publish ディスパッチが SDK と 1:1 か検証 (ハードウェア不要)。
import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";
import {
  parseTouchCard, parseTouchFace,
  cardAddData, cardDeleteData, cardChangeData, cardMoveData, cardChangeValueData, cardModeSetData,
  passcodeAddData, faceDeleteData, palmDeleteData,
  batchAddPacket,
  parseRemoteNanoTrigger, remoteNanoTriggerDelayData, radarSensitivityData,
  parseBiometricMechStatus, parsePubKeySesame,
  handleBiometricPublish, BiometricCommands, STP_ITEM,
  createEnrollCollector,
} from "../../src/ble/biometric.js";
import { ITEM_CODES as ITEM } from "../../src/itemcodes.js";

describe("parseTouchCard", () => {
  it("CHSesameTouchCard と同じ分解 (type/idLen/id/nameLen/name/recordSize)", () => {
    // type=04, idLen=02, id=aabb, nameLen=03, name=010203
    const data = Buffer.from([0x04, 0x02, 0xaa, 0xbb, 0x03, 0x01, 0x02, 0x03]);
    const c = parseTouchCard(data);
    expect(c.cardType).toBe(0x04);
    expect(c.idLength).toBe(2);
    expect(c.cardID).toBe("aabb");
    expect(c.nameLength).toBe(3);
    expect(c.cardName).toBe("010203");
    expect(c.recordSize).toBe(1 + 1 + 2 + 1 + 3);
  });
});

describe("parseTouchFace", () => {
  it("CHSesameTouchFace と同じ分解 (type/idLen/id/nameLen/nameUUID)", () => {
    const data = Buffer.from([0x01, 0x01, 0x7f, 0x02, 0xde, 0xad]);
    const f = parseTouchFace(data);
    expect(f.type).toBe(1);
    expect(f.idLength).toBe(1);
    expect(f.id).toBe("7f");
    expect(f.nameLength).toBe(2);
    expect(f.nameUUID).toBe("dead");
  });
});

describe("cardAddData / passcodeAddData", () => {
  it("[F0][00][idLen] ++ id.padEnd(16) ++ [nameLen] ++ name.padEnd(16) = 35B", () => {
    const id = Buffer.from([0x11, 0x22, 0x33]);
    const d = cardAddData(id, "AB"); // name UTF-8 = 0x41,0x42
    expect(d.length).toBe(3 + 16 + 1 + 16);
    expect(d[0]).toBe(0xf0);
    expect(d[1]).toBe(0x00);
    expect(d[2]).toBe(3); // idLen
    expect(d.subarray(3, 6).equals(id)).toBe(true);
    expect(d[19]).toBe(2); // nameLen (UTF-8 "AB")
    expect(d[20]).toBe(0x41);
    expect(d[21]).toBe(0x42);
    // passcode は同一レイアウト
    expect(passcodeAddData(id, "AB").equals(d)).toBe(true);
  });
});

describe("change/move/delete のバイト列", () => {
  it("cardChange: [idLen] ++ id ++ hexName(畳み)", () => {
    const d = cardChangeData("aabb", "0102");
    expect(Buffer.from([0x02, 0xaa, 0xbb, 0x01, 0x02]).equals(d)).toBe(true);
  });
  it("cardMove: [idLen] ++ id ++ uuid(UTF-8)", () => {
    const d = cardMoveData("aa", "XY");
    expect(Buffer.from([0x01, 0xaa, 0x58, 0x59]).equals(d)).toBe(true);
  });
  it("cardChangeValue: [idLen] ++ id ++ newID(UTF-8)", () => {
    const d = cardChangeValueData("aa", "Z");
    expect(Buffer.from([0x01, 0xaa, 0x5a]).equals(d)).toBe(true);
  });
  it("cardDelete: id(hex→bytes)", () => {
    expect(cardDeleteData("aabb").equals(Buffer.from([0xaa, 0xbb]))).toBe(true);
  });
  it("faceDelete/palmDelete: 単一 byte (hex→int)", () => {
    expect(faceDeleteData("0a").equals(Buffer.from([0x0a]))).toBe(true);
    expect(palmDeleteData("ff").equals(Buffer.from([0xff]))).toBe(true);
  });
  it("cardModeSet: [mode]", () => {
    expect(cardModeSetData(0x02).equals(Buffer.from([0x02]))).toBe(true);
  });
});

describe("batchAddPacket", () => {
  it("[idx LE 2B][size LE 2B][chunk] で 209B 上限分割", () => {
    const data = Buffer.alloc(500, 0x7);
    const p0 = batchAddPacket(data, 0);
    expect(p0.packet.subarray(0, 2).equals(Buffer.from([0x00, 0x00]))).toBe(true); // idx=0 LE
    expect(p0.packet.readUInt16LE(2)).toBe(500); // size LE
    expect(p0.packet.length).toBe(4 + 209);
    expect(p0.nextIndex).toBe(209);
    const p1 = batchAddPacket(data, 209);
    expect(p1.packet.readUInt16LE(0)).toBe(209);
    expect(p1.nextIndex).toBe(418);
    const p2 = batchAddPacket(data, 418);
    expect(p2.packet.length).toBe(4 + (500 - 418)); // 残り 82B
    expect(p2.nextIndex).toBe(500);
  });
});

describe("handleBiometricPublish", () => {
  it("CARD_FIRST/NOTIFY/LAST を delegate へ写像", () => {
    const calls = [];
    const delegate = {
      onCardReceiveStart: () => calls.push("start"),
      onCardReceiveEnd: () => calls.push("end"),
      onCardReceive: (_d, id, name, type) => calls.push(["recv", id, name, type]),
    };
    expect(handleBiometricPublish({ itemCode: ITEM.CARD_FIRST, body: Buffer.alloc(0) }, delegate)).toBe(true);
    // NOTIFY: 2 レコード連結
    const rec = Buffer.from([0x04, 0x01, 0xaa, 0x00]); // type04 idLen1 id=aa nameLen0
    handleBiometricPublish({ itemCode: ITEM.CARD_NOTIFY, body: Buffer.concat([rec, rec]) }, delegate);
    handleBiometricPublish({ itemCode: ITEM.CARD_LAST, body: Buffer.alloc(0) }, delegate);
    expect(calls[0]).toBe("start");
    expect(calls[1]).toEqual(["recv", "aa", "", 0x04]);
    expect(calls[2]).toEqual(["recv", "aa", "", 0x04]);
    expect(calls[3]).toBe("end");
  });

  it("CARD_DELETE は payload[2]=idLen, id=payload[3..]", () => {
    let got = null;
    handleBiometricPublish(
      { itemCode: ITEM.CARD_DELETE, body: Buffer.from([0x00, 0x00, 0x02, 0xaa, 0xbb]) },
      { onCardDelete: (_d, id) => { got = id; } },
    );
    expect(got).toBe("aabb");
  });

  it("FACE_MODE_DELETE_NOTIFY: faceID + 成功フラグ(payload[1]==0)", () => {
    let res = null;
    handleBiometricPublish(
      { itemCode: ITEM.FACE_MODE_DELETE_NOTIFY, body: Buffer.from([0x05, 0x00]) },
      { onFaceDeleted: (_d, id, ok) => { res = [id, ok]; } },
    );
    expect(res).toEqual([5, true]);
  });

  it("FINGERPRINT_DELETE は payload 全体を hex 化", () => {
    let got = null;
    handleBiometricPublish(
      { itemCode: ITEM.FINGERPRINT_DELETE, body: Buffer.from([0xab, 0xcd]) },
      { onFingerDelete: (_d, id) => { got = id; } },
    );
    expect(got).toBe("abcd");
  });

  it("未対応 itemCode は false", () => {
    // MECH_SETTING(80) は生体 capability の switch に無い (= ロック側の publish) → false。
    expect(handleBiometricPublish({ itemCode: ITEM.MECH_SETTING, body: Buffer.alloc(0) }, {})).toBe(false);
  });
});

describe("BiometricCommands", () => {
  it("cardModeSet が CARD_MODE_SET を request で送る", async () => {
    const request = vi.fn().mockResolvedValue({ resultCode: 0, payload: Buffer.alloc(0) });
    const bio = new BiometricCommands({ request });
    await bio.cardModeSet(2);
    expect(request).toHaveBeenCalledWith(ITEM.CARD_MODE_SET, Buffer.from([0x02]));
  });

  it("cardBatchAdd が STP_ITEM_CODE_CARDS_ADD を必要回数送る", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValue({ resultCode: 0, payload: Buffer.alloc(0) });
    const bio = new BiometricCommands({ request });
    const data = Buffer.alloc(420, 0x1); // 209*2 + 2 = 3 パケット
    const progress = vi.fn();
    const p = bio.cardBatchAdd(data, progress);
    await vi.runAllTimersAsync();
    await p;
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0][0]).toBe(STP_ITEM.STP_ITEM_CODE_CARDS_ADD);
    expect(progress).toHaveBeenCalledWith(1, 3);
    expect(progress).toHaveBeenCalledWith(3, 3);
    vi.useRealTimers();
  });

  it("registerDelegate が onPublish に handleBiometricPublish を結線", () => {
    let pub = null;
    const session = { request: vi.fn(), onPublish: (fn) => { pub = fn; return () => {}; } };
    const bio = new BiometricCommands(session);
    let started = false;
    bio.registerDelegate({ onCardReceiveStart: () => { started = true; } });
    pub({ itemCode: ITEM.CARD_FIRST, body: Buffer.alloc(0) });
    expect(started).toBe(true);
  });

  it("faceModeGet は空 payload で throw", async () => {
    const request = vi.fn().mockResolvedValue({ resultCode: 0, payload: Buffer.alloc(0) });
    const bio = new BiometricCommands({ request });
    await expect(bio.faceModeGet()).rejects.toThrow(/data error/);
  });

  it("setTriggerDelay が REMOTE_NANO_SET_TRIGGER_DELAYTIME(190) + [time] を送る", async () => {
    const request = vi.fn().mockResolvedValue({ resultCode: 0, payload: Buffer.alloc(0) });
    const bio = new BiometricCommands({ request });
    await bio.setTriggerDelay(30);
    expect(request).toHaveBeenCalledWith(ITEM.REMOTE_NANO_SET_TRIGGER_DELAYTIME, Buffer.from([30]));
    expect(ITEM.REMOTE_NANO_SET_TRIGGER_DELAYTIME).toBe(190);
  });

  it("setTriggerDelay は UByte 範囲外で throw", async () => {
    const bio = new BiometricCommands({ request: vi.fn() });
    await expect(bio.setTriggerDelay(256)).rejects.toThrow(/UByte 0\.\.255/);
    await expect(bio.setTriggerDelay(-1)).rejects.toThrow(/UByte 0\.\.255/);
  });

  it("setRadarSensitivity が SSM_OS3_RADAR_PARAM_SET(200) + raw payload を送る", async () => {
    const request = vi.fn().mockResolvedValue({ resultCode: 0, payload: Buffer.alloc(0) });
    const bio = new BiometricCommands({ request });
    const payload = Buffer.from([0x01, 0x02, 0x03]);
    await bio.setRadarSensitivity(payload);
    expect(request).toHaveBeenCalledWith(ITEM.SSM_OS3_RADAR_PARAM_SET, payload);
    expect(ITEM.SSM_OS3_RADAR_PARAM_SET).toBe(200);
  });
});

describe("remoteNano trigger delay / radar publish", () => {
  it("parseRemoteNanoTrigger: payload 先頭 1B(LE) = triggerDelaySecond", () => {
    // CHRemoteNanoTriggerSettings.fromData: ByteBuffer LE の get().toUByte()。
    expect(parseRemoteNanoTrigger(Buffer.from([0x1e])).triggerDelaySecond).toBe(30);
    expect(parseRemoteNanoTrigger(Buffer.from([0xff, 0x00])).triggerDelaySecond).toBe(255);
  });

  it("remoteNanoTriggerDelayData: [time(1B)] (UByte 範囲外は throw)", () => {
    expect(remoteNanoTriggerDelayData(0).equals(Buffer.from([0x00]))).toBe(true);
    expect(remoteNanoTriggerDelayData(255).equals(Buffer.from([0xff]))).toBe(true);
    expect(() => remoteNanoTriggerDelayData(256)).toThrow();
  });

  it("radarSensitivityData: payload をそのまま (内容は不透明)", () => {
    const p = Buffer.from([0x0a, 0x14, 0x1e]);
    expect(radarSensitivityData(p).equals(p)).toBe(true);
  });

  it("REMOTE_NANO_PUB_TRIGGER_DELAYTIME(191) を onTriggerDelaySecondReceived へ", () => {
    let got = null;
    const ok = handleBiometricPublish(
      { itemCode: ITEM.REMOTE_NANO_PUB_TRIGGER_DELAYTIME, body: Buffer.from([0x2d]) },
      { onTriggerDelaySecondReceived: (_d, s) => { got = s; } },
    );
    expect(ok).toBe(true);
    expect(got).toEqual({ triggerDelaySecond: 45 });
  });

  it("SSM_OS3_RADAR_PARAM_PUBLISH(201) は生 payload を onRadarReceive へ", () => {
    let got = null;
    const raw = Buffer.from([0x01, 0x05, 0x09]);
    const ok = handleBiometricPublish(
      { itemCode: ITEM.SSM_OS3_RADAR_PARAM_PUBLISH, body: raw },
      { onRadarReceive: (_d, payload) => { got = payload; } },
    );
    expect(ok).toBe(true);
    expect(got.equals(raw)).toBe(true);
  });
});

describe("parseBiometricMechStatus (CHSesameTouchProMechStatus pass-through)", () => {
  it("raw payload を保持し、ロック系フィールドは既定値 (override 無し)", () => {
    // 生体 mechStatus は CHSesameProtocolMechStatus の既定値に落ちる (position=0/target=0/
    // isInLockRange=false/isStop=null/isCritical=null/isBatteryCritical=false)。
    const raw = Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a]);
    const s = parseBiometricMechStatus(raw);
    expect(s.data.equals(raw)).toBe(true);
    expect(s.position).toBe(0);
    expect(s.target).toBe(0);
    expect(s.isInLockRange).toBe(false);
    expect(s.isInUnlockRange).toBe(true);
    expect(s.isStop).toBeNull();
    expect(s.isCritical).toBeNull();
    expect(s.isBatteryCritical).toBe(false);
    // reportBatteryData が使う先頭 2B (LE)。
    expect(s.batteryRaw).toBe(0x3412);
  });

  it("2B 未満なら batteryRaw は null", () => {
    expect(parseBiometricMechStatus(Buffer.from([0x01])).batteryRaw).toBeNull();
    expect(parseBiometricMechStatus(Buffer.alloc(0)).batteryRaw).toBeNull();
  });

  it("MECH_STATUS publish を onMechStatus へ写像 (handleBiometricPublish)", () => {
    let got = null;
    const raw = Buffer.from([0xaa, 0xbb, 0xcc]);
    const ok = handleBiometricPublish(
      { itemCode: ITEM.MECH_STATUS, body: raw },
      { onMechStatus: (_d, st) => { got = st; } },
    );
    expect(ok).toBe(true);
    expect(got.data.equals(raw)).toBe(true);
    expect(got.batteryRaw).toBe(0xbbaa);
  });
});

describe("parsePubKeySesame (handlePubKeySesame 23B 分割)", () => {
  it("SS5 鍵 (it[21]==0): id=先頭16B hex, keyType=0x05, lockStatus=it[22]", () => {
    const id16 = Buffer.alloc(16, 0x11);
    const chunk = Buffer.concat([id16, Buffer.alloc(5, 0x00), Buffer.from([0x00, 0x07])]); // [21]=0, [22]=7
    const r = parsePubKeySesame(chunk);
    expect(r.keys).toHaveLength(1);
    expect(r.keys[0]).toEqual({ ssmID: "11".repeat(16), keyType: 0x05, lockStatus: 7 });
    expect(r.slotFull).toBe(true); // 全 23B 占有 → 空きなし
    expect(r.emptySlotCount).toBe(0);
  });

  it("SS2 鍵 (it[21]!=0): 22B を base64decode → hex, keyType=0x04", () => {
    // 16B を base64 すると 24 文字 (末尾 "=="); 先頭 22 文字を ASCII で詰めるのが SDK の SS2 経路。
    const decoded16 = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
    const b64full = decoded16.toString("base64"); // 24 chars ending in "=="
    const b22 = b64full.slice(0, 22);
    const chunk = Buffer.alloc(23, 0x00);
    Buffer.from(b22, "latin1").copy(chunk, 0);     // [0..21] = 22 ASCII chars
    chunk[21] = b22.charCodeAt(21);                // 念のため上書き (slice 済みなので同値)
    chunk[22] = 0x05;                              // lockStatus
    // it[21] は base64 文字 (非 0) なので SS2 経路に入る。
    const r = parsePubKeySesame(chunk);
    expect(r.keys).toHaveLength(1);
    expect(r.keys[0].keyType).toBe(0x04);
    expect(r.keys[0].lockStatus).toBe(5);
    expect(r.keys[0].ssmID).toBe(decoded16.toString("hex"));
  });

  it("lockStatus==0 のスロットは skip、全ゼロは空きスロット計上", () => {
    const occupied = Buffer.concat([Buffer.alloc(16, 0x22), Buffer.alloc(5, 0x00), Buffer.from([0x00, 0x03])]);
    const lockStatusZero = Buffer.concat([Buffer.alloc(16, 0x33), Buffer.alloc(5, 0x00), Buffer.from([0x00, 0x00])]); // it[22]=0 skip
    const empty = Buffer.alloc(23, 0x00); // 全ゼロ → 空きスロット
    const r = parsePubKeySesame(Buffer.concat([occupied, lockStatusZero, empty]));
    expect(r.keys).toHaveLength(1); // occupied のみ
    expect(r.emptySlotCount).toBe(1); // empty の 1 つ (lockStatusZero は非ゼロ id があり全ゼロでない)
    expect(r.slotFull).toBe(false);  // 既定 (非 OpenSensor): 空き 1 つで slotFull=false
  });

  it("OpenSensor は空き 1 つでは slotFull=true (>1 で空きあり)", () => {
    const occupied = Buffer.concat([Buffer.alloc(16, 0x44), Buffer.alloc(5, 0x00), Buffer.from([0x00, 0x09])]);
    const empty = Buffer.alloc(23, 0x00);
    // 空き 1 つ: 非 OpenSensor は slotFull=false、OpenSensor は予約枠とみなし slotFull=true。
    expect(parsePubKeySesame(Buffer.concat([occupied, empty])).slotFull).toBe(false);
    expect(parsePubKeySesame(Buffer.concat([occupied, empty]), { isOpenSensor: true }).slotFull).toBe(true);
    // 空き 2 つなら OpenSensor でも slotFull=false。
    expect(parsePubKeySesame(Buffer.concat([occupied, empty, empty]), { isOpenSensor: true }).slotFull).toBe(false);
  });

  it("末尾端数チャンクは 0x00 ゼロ埋め (divideArray と一致) → 全ゼロなら空き計上", () => {
    // 23B + 5B の端数。端数は 23B にゼロ埋めされ、全ゼロなら空きスロット 1 つになる。
    const occupied = Buffer.concat([Buffer.alloc(16, 0x55), Buffer.alloc(5, 0x00), Buffer.from([0x00, 0x02])]);
    const r = parsePubKeySesame(Buffer.concat([occupied, Buffer.alloc(5, 0x00)]));
    expect(r.keys).toHaveLength(1);
    expect(r.emptySlotCount).toBe(1);
  });

  it("PUB_KEY_SESAME publish を onSesameKeysReceived へ写像", () => {
    let got = null;
    const occupied = Buffer.concat([Buffer.alloc(16, 0x66), Buffer.alloc(5, 0x00), Buffer.from([0x00, 0x01])]);
    const ok = handleBiometricPublish(
      { itemCode: ITEM.PUB_KEY_SESAME, body: occupied },
      { onSesameKeysReceived: (_d, r) => { got = r; } },
    );
    expect(ok).toBe(true);
    expect(got.keys).toHaveLength(1);
    expect(got.keys[0].keyType).toBe(0x05);
  });
});

describe("生体 publish: battery / unsupport / bleTxPower", () => {
  it("BATTERY_VOLTAGE(202) は payload を hex 化して onBatteryVoltageReceived へ", () => {
    let got = null;
    const ok = handleBiometricPublish(
      { itemCode: ITEM.SSM3_ITEM_CODE_BATTERY_VOLTAGE, body: Buffer.from([0xde, 0xad]) },
      { onBatteryVoltageReceived: (_d, hex) => { got = hex; } },
    );
    expect(ok).toBe(true);
    expect(got).toBe("dead");
    expect(ITEM.SSM3_ITEM_CODE_BATTERY_VOLTAGE).toBe(202);
  });

  it("SESAME_UNSUPPORT(204) は onSupportChanged(false)", () => {
    let got = "unset";
    const ok = handleBiometricPublish(
      { itemCode: ITEM.SSM3_ITEM_CODE_SESAME_UNSUPPORT, body: Buffer.alloc(0) },
      { onSupportChanged: (_d, s) => { got = s; } },
    );
    expect(ok).toBe(true);
    expect(got).toBe(false);
    expect(ITEM.SSM3_ITEM_CODE_SESAME_UNSUPPORT).toBe(204);
  });

  it("BLE_TX_POWER_SETTING(206) publish は payload[0] を符号付き 1B で onBleTxPowerReceive へ", () => {
    let got = null;
    const ok = handleBiometricPublish(
      { itemCode: ITEM.SSM3_ITEM_CODE_BLE_TX_POWER_SETTING, body: Buffer.from([0xfb]) }, // -5 (符号付き)
      { onBleTxPowerReceive: (_d, tx) => { got = tx; } },
    );
    expect(ok).toBe(true);
    expect(got).toBe(-5);
    expect(ITEM.SSM3_ITEM_CODE_BLE_TX_POWER_SETTING).toBe(206);
  });
});

describe("createEnrollCollector (enroll → DB 同期ブリッジ)", () => {
  // card: type=01, idLen=01, id=aa, nameLen=01, name=41 → 1 レコード
  const cardRec = Buffer.from([0x01, 0x01, 0xaa, 0x01, 0x41]);

  it("_FIRST → _NOTIFY(複数) → _LAST を 1 バッチに集約して onEnrolled へ渡す", () => {
    const batches = [];
    const delegate = createEnrollCollector({ onEnrolled: (b) => batches.push(b) });
    handleBiometricPublish({ itemCode: ITEM.CARD_FIRST, body: Buffer.alloc(0) }, delegate);
    handleBiometricPublish({ itemCode: ITEM.CARD_NOTIFY, body: Buffer.concat([cardRec, cardRec]) }, delegate);
    handleBiometricPublish({ itemCode: ITEM.CARD_LAST, body: Buffer.alloc(0) }, delegate);

    expect(batches).toHaveLength(1);
    expect(batches[0].kind).toBe("card");
    expect(batches[0].records).toEqual([
      { cardID: "aa", cardName: "41", cardType: 1 },
      { cardID: "aa", cardName: "41", cardType: 1 },
    ]);
  });

  it("_FIRST がレコードをリセットする (前セッションの残りが混ざらない)", () => {
    const batches = [];
    const delegate = createEnrollCollector({ onEnrolled: (b) => batches.push(b) });
    handleBiometricPublish({ itemCode: ITEM.CARD_NOTIFY, body: cardRec }, delegate); // _FIRST 前のノイズ
    handleBiometricPublish({ itemCode: ITEM.CARD_FIRST, body: Buffer.alloc(0) }, delegate); // ここでリセット
    handleBiometricPublish({ itemCode: ITEM.CARD_LAST, body: Buffer.alloc(0) }, delegate);
    expect(batches[0].records).toEqual([]); // 空登録も通知する
  });

  it("passcode の enroll を独立バッチで集約する (kind='passcode')", () => {
    const batches = [];
    const delegate = createEnrollCollector({ onEnrolled: (b) => batches.push(b) });
    handleBiometricPublish({ itemCode: ITEM.PASSCODE_FIRST, body: Buffer.alloc(0) }, delegate);
    handleBiometricPublish({ itemCode: ITEM.PASSCODE_NOTIFY, body: cardRec }, delegate);
    handleBiometricPublish({ itemCode: ITEM.PASSCODE_LAST, body: Buffer.alloc(0) }, delegate);
    expect(batches).toHaveLength(1);
    expect(batches[0].kind).toBe("passcode");
    expect(batches[0].records).toEqual([{ cardID: "aa", cardName: "41", cardType: 1 }]);
  });

  it("device トークンを batch に同梱して渡す", () => {
    const batches = [];
    const delegate = createEnrollCollector({ onEnrolled: (b) => batches.push(b) });
    const dev = { uuid: "dev-1" };
    handleBiometricPublish({ itemCode: ITEM.CARD_FIRST, body: Buffer.alloc(0) }, delegate, dev);
    handleBiometricPublish({ itemCode: ITEM.CARD_LAST, body: Buffer.alloc(0) }, delegate, dev);
    expect(batches[0].device).toBe(dev);
  });

  it("card:false で card の enroll を集約しない", () => {
    const batches = [];
    const delegate = createEnrollCollector({ onEnrolled: (b) => batches.push(b), card: false });
    expect(delegate.onCardReceiveStart).toBeUndefined();
    expect(typeof delegate.onKeyBoardReceiveStart).toBe("function");
  });

  it("onEnrolled 未指定は throw", () => {
    expect(() => createEnrollCollector({})).toThrow(/onEnrolled/);
  });

  it("BiometricCommands.onEnroll が session.onPublish に結線する", () => {
    let pub = null;
    const session = { request: vi.fn(), onPublish: (fn) => { pub = fn; return () => {}; } };
    const bio = new BiometricCommands(session);
    const batches = [];
    bio.onEnroll((b) => batches.push(b));
    pub({ itemCode: ITEM.CARD_FIRST, body: Buffer.alloc(0) });
    pub({ itemCode: ITEM.CARD_NOTIFY, body: cardRec });
    pub({ itemCode: ITEM.CARD_LAST, body: Buffer.alloc(0) });
    expect(batches).toHaveLength(1);
    expect(batches[0].records).toEqual([{ cardID: "aa", cardName: "41", cardType: 1 }]);
  });
});

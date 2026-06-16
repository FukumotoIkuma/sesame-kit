// BLE3-0134..BLE3-0151: card/passcode/face capability — payload fidelity & publish dispatch.
// Spec: spec/ble-os3.md §card/passcode/face
// Implementation: packages/core/src/ble/biometric.js
// All tests are self-contained, network-free, deterministic.

import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";

import {
  cardChangeData,
  cardChangeValueData,
  cardAddData,
  cardDeleteData,
  cardModeSetData,
  cardModeGetData,
  cardGetData,
  passcodeModeSetData,
  passcodeModeGetData,
  passcodeGetData,
  batchAddPacket,
  handleBiometricPublish,
  BiometricCommands,
  faceModeSetData,
  faceModeGetData,
  faceGetData,
  faceChangeData,
  faceDeleteData,
  parseTouchCard,
  parseTouchFace,
} from "../../src/ble/biometric.js";

import { ITEM_CODES as ITEM, STP_ITEM_CODES as STP_ITEM } from "../../src/itemcodes.js";
import { reviveJsonArg } from "../../src/ble/rpc-helpers.js";
import { RpcError } from "../../src/jsonrpc.js";

// ---------------------------------------------------------------------------
// Helper: session mock
// ---------------------------------------------------------------------------

function makeSessionMock(resp = { resultCode: 0, payload: Buffer.alloc(0) }) {
  const spyRequest = vi.fn().mockResolvedValue(resp);
  return { session: { request: spyRequest }, spyRequest };
}

// ---------------------------------------------------------------------------
// BLE3-0134: cardChange (hex 畳み込み) と cardChangeValue (UTF-8) の name エンコード非対称
// Ref: biometric.js:409-426; CHCardCapableImpl.kt:162,:173
// ---------------------------------------------------------------------------

describe("[BLE3-0134] cardChange vs cardChangeValue name encoding asymmetry", () => {
  it("[BLE3-0134] cardChangeData uses hex-fold (2char/byte) for name, cardChangeValueData uses UTF-8", () => {
    // cardChangeData: hexName.chunked(2).map{toInt(16)} (CHCardCapableImpl.kt:162)
    // id = "0102" -> [0x01, 0x02], hexName = "4142" -> [0x41, 0x42]
    const id = "0102";
    const hexName = "4142";

    const changeData = cardChangeData(id, hexName);
    const idBuf = Buffer.from([0x01, 0x02]);
    expect(changeData[0]).toBe(idBuf.length); // idLen
    expect(changeData[1]).toBe(0x01);
    expect(changeData[2]).toBe(0x02);
    // hex-folded: "41" -> 0x41, "42" -> 0x42
    expect(changeData[3]).toBe(0x41);
    expect(changeData[4]).toBe(0x42);

    // cardChangeValueData: newID.toByteArray() = UTF-8 (CHCardCapableImpl.kt:173)
    const changeValueData = cardChangeValueData(id, "AB");
    expect(changeValueData[0]).toBe(idBuf.length);
    expect(changeValueData[1]).toBe(0x01);
    expect(changeValueData[2]).toBe(0x02);
    expect(changeValueData[3]).toBe(0x41); // 'A'
    expect(changeValueData[4]).toBe(0x42); // 'B'
  });

  it("[BLE3-0134] cardChangeData と cardChangeValueData は同じ文字列引数に対して異なるバイト列を生成する", () => {
    // "41424344" は hex-fold なら [0x41,0x42,0x43,0x44] (2B/char)
    // UTF-8 なら '4','1','4','2','4','3','4','4' = 8B (ASCII code)
    const hexFolded = cardChangeData("01", "2764");
    // "27" -> 0x27, "64" -> 0x64 (2 bytes)
    expect(hexFolded.length).toBe(1 + 1 + 2); // idLen(1) + id(1) + name(2)

    const utf8Encoded = cardChangeValueData("01", "2764");
    // UTF-8 of "2764" = 4 bytes (ASCII '2','7','6','4')
    expect(utf8Encoded.length).toBe(1 + 1 + 4); // idLen(1) + id(1) + name(4)
  });

  it("[BLE3-0134] cardChangeData: name 位置を hexNameToBytes (hex 畳み込み, 2 文字/byte) でエンコードする", () => {
    // CHCardCapableImpl.kt:162 hexName.chunked(2).map{toInt(16).toByte()}
    const ID = "ab01";
    const hexName = "deadbeef";
    const data = cardChangeData(ID, hexName);
    const idBuf = Buffer.from([0xab, 0x01]);
    // expected: [idLen=2, 0xab, 0x01, 0xde, 0xad, 0xbe, 0xef]
    const expected = Buffer.from([idBuf.length, ...idBuf, 0xde, 0xad, 0xbe, 0xef]);
    expect(data).toEqual(expected);
  });

  it("[BLE3-0134] hexNameToBytes odd-length: trailing single char also produces 1 byte", () => {
    // Kotlin chunked(2) on "abc" gives ["ab","c"]: "c".toInt(16)=12=0x0c
    const data = cardChangeData("ff", "abc");
    // idLen=1, id=[0xff], hexName="abc" -> [0xab, 0x0c]
    expect(data[0]).toBe(1);
    expect(data[1]).toBe(0xff);
    expect(data[2]).toBe(0xab);
    expect(data[3]).toBe(0x0c);
    expect(data.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0135: cardModeSet payload = [mode 1B], itemCode CARD_MODE_SET=114
// Ref: biometric.js:362, itemcodes.js:96; CHCardCapableImpl.kt:49
// ---------------------------------------------------------------------------

describe("[BLE3-0135] cardModeSet payload and itemCode", () => {
  it("[BLE3-0135] cardModeSetData(mode) returns [mode & 0xff] 1B matching CHCardCapableImpl.cardModeSet", () => {
    // SDK: SesameOS3Payload(SSM_OS3_CARD_MODE_SET, byteArrayOf(mode)) where SSM_OS3_CARD_MODE_SET=114
    expect(ITEM.CARD_MODE_SET).toBe(114);
    expect(cardModeSetData(0)).toEqual(Buffer.from([0x00]));
    expect(cardModeSetData(1)).toEqual(Buffer.from([0x01]));
    expect(cardModeSetData(255)).toEqual(Buffer.from([0xff]));
    // high byte masked out (& 0xff)
    expect(cardModeSetData(0x100)).toEqual(Buffer.from([0x00]));
    expect(cardModeSetData(3)).toEqual(Buffer.from([3]));
  });

  it("[BLE3-0135] BiometricCommands.cardModeSet sends ITEM.CARD_MODE_SET=114 with 1B data", async () => {
    const { session, spyRequest } = makeSessionMock({ resultCode: 0, payload: Buffer.alloc(0) });
    const cmd = new BiometricCommands(session);
    await cmd.cardModeSet(2);
    expect(spyRequest).toHaveBeenCalledWith(ITEM.CARD_MODE_SET, cardModeSetData(2));
    expect(ITEM.CARD_MODE_SET).toBe(114);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0136: passcodeModeSet payload = [mode 1B], itemCode PASSCODE_MODE_SET=130
// Ref: biometric.js:451, itemcodes.js:119; CHPassCodeCapableImpl.kt:33-37
// ---------------------------------------------------------------------------

describe("[BLE3-0136] passcodeModeSet payload and itemCode", () => {
  it("[BLE3-0136] passcodeModeSetData(mode) returns [mode & 0xff] 1B matching CHPassCodeCapableImpl", () => {
    // SDK: SesameOS3Payload(SSM_OS3_PASSCODE_MODE_SET, byteArrayOf(mode)) where code=130
    expect(ITEM.PASSCODE_MODE_SET).toBe(130);
    expect(passcodeModeSetData(0)).toEqual(Buffer.from([0x00]));
    expect(passcodeModeSetData(1)).toEqual(Buffer.from([0x01]));
    expect(passcodeModeSetData(0xff)).toEqual(Buffer.from([0xff]));
    // mask
    expect(passcodeModeSetData(0x101)).toEqual(Buffer.from([0x01]));
  });

  it("[BLE3-0136] BiometricCommands.passcodeModeSet sends PASSCODE_MODE_SET=130", async () => {
    const { session, spyRequest } = makeSessionMock({ resultCode: 0, payload: Buffer.alloc(0) });
    const cmd = new BiometricCommands(session);
    await cmd.passcodeModeSet(2);
    expect(spyRequest).toHaveBeenCalledWith(ITEM.PASSCODE_MODE_SET, passcodeModeSetData(2));
    expect(ITEM.PASSCODE_MODE_SET).toBe(130);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0137: cardModeGet 空 payload 送信 / 応答 payload[0]=mode, itemCode CARD_MODE_GET=113
// Ref: biometric.js:364; CHCardCapableImpl.kt:38-47
// ---------------------------------------------------------------------------

describe("[BLE3-0137] cardModeGet empty payload, response payload[0]=mode", () => {
  it("[BLE3-0137] cardModeGetData() returns empty Buffer", () => {
    // SDK: SesameOS3Payload(SSM_OS3_CARD_MODE_GET, byteArrayOf()) = empty
    expect(ITEM.CARD_MODE_GET).toBe(113);
    const data = cardModeGetData();
    expect(data.length).toBe(0);
    expect(data).toEqual(Buffer.alloc(0));
  });

  it("[BLE3-0137] BiometricCommands.cardModeGet sends CARD_MODE_GET=113 and returns payload[0]", async () => {
    const { session, spyRequest } = makeSessionMock({ resultCode: 0, payload: Buffer.from([7]) });
    const cmd = new BiometricCommands(session);
    const result = await cmd.cardModeGet();
    expect(spyRequest).toHaveBeenCalledWith(ITEM.CARD_MODE_GET, cardModeGetData());
    expect(ITEM.CARD_MODE_GET).toBe(113);
    // 応答は payload[0] = mode byte
    expect(result).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0138: passcodeModeGet 空 payload / 応答 payload[0]=mode, itemCode PASSCODE_MODE_GET=129
// Ref: biometric.js:452; CHPassCodeCapableImpl.kt:27-31
// ---------------------------------------------------------------------------

describe("[BLE3-0138] passcodeModeGet empty payload, response payload[0]=mode", () => {
  it("[BLE3-0138] passcodeModeGetData() returns empty Buffer", () => {
    expect(ITEM.PASSCODE_MODE_GET).toBe(129);
    const data = passcodeModeGetData();
    expect(data.length).toBe(0);
  });

  it("[BLE3-0138] BiometricCommands.passcodeModeGet sends PASSCODE_MODE_GET=129 and returns payload[0]", async () => {
    const { session, spyRequest } = makeSessionMock({ resultCode: 0, payload: Buffer.from([5]) });
    const cmd = new BiometricCommands(session);
    const result = await cmd.passcodeModeGet();
    expect(spyRequest).toHaveBeenCalledWith(ITEM.PASSCODE_MODE_GET, passcodeModeGetData());
    expect(ITEM.PASSCODE_MODE_GET).toBe(129);
    expect(result).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0139: cardGet 空 payload 送信, itemCode CARD_GET=109
// Ref: biometric.js:365, itemcodes.js:91; CHCardCapableImpl.kt:29-36
// ---------------------------------------------------------------------------

describe("[BLE3-0139] cardGet empty payload and itemCode CARD_GET=109", () => {
  it("[BLE3-0139] cardGetData() returns empty Buffer", () => {
    // SDK: SesameOS3Payload(SSM_OS3_CARD_GET, byteArrayOf())
    expect(ITEM.CARD_GET).toBe(109);
    expect(cardGetData().length).toBe(0);
    expect(cardGetData()).toEqual(Buffer.alloc(0));
  });

  it("[BLE3-0139] BiometricCommands.cardGet sends CARD_GET=109 with empty data", async () => {
    const { session, spyRequest } = makeSessionMock();
    const cmd = new BiometricCommands(session);
    await cmd.cardGet();
    expect(spyRequest).toHaveBeenCalledWith(ITEM.CARD_GET, cardGetData());
    expect(ITEM.CARD_GET).toBe(109);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0140: passcodeGet 空 payload 送信, itemCode PASSCODE_GET=125
// Ref: biometric.js:453, itemcodes.js:114; CHPassCodeCapableImpl.kt:139-141
// ---------------------------------------------------------------------------

describe("[BLE3-0140] passcodeGet empty payload and itemCode PASSCODE_GET=125", () => {
  it("[BLE3-0140] passcodeGetData() returns empty Buffer", () => {
    expect(ITEM.PASSCODE_GET).toBe(125);
    expect(passcodeGetData().length).toBe(0);
  });

  it("[BLE3-0140] BiometricCommands.passcodeGet sends PASSCODE_GET=125 with empty data", async () => {
    const { session, spyRequest } = makeSessionMock();
    const cmd = new BiometricCommands(session);
    await cmd.passcodeGet();
    expect(spyRequest).toHaveBeenCalledWith(ITEM.PASSCODE_GET, passcodeGetData());
    expect(ITEM.PASSCODE_GET).toBe(125);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0141: cardAdd id 引数 Buffer 復元 ({type:'Buffer'}/{$buffer}) → 16B 枠
// Ref: rpc-helpers.js:26-43, biometric.js:374-382
// ---------------------------------------------------------------------------

describe("[BLE3-0141] cardAdd id Buffer revival ({type:Buffer}/{$buffer}) and padEnd(16)", () => {
  it("[BLE3-0141] reviveJsonArg restores {type:'Buffer', data:[]} to Buffer", () => {
    const raw = { type: "Buffer", data: [0x01, 0x02, 0x03] };
    const restored = reviveJsonArg(raw);
    expect(Buffer.isBuffer(restored)).toBe(true);
    expect(restored).toEqual(Buffer.from([0x01, 0x02, 0x03]));
  });

  it("[BLE3-0141] reviveJsonArg restores {$buffer: hex} to Buffer", () => {
    const raw = { $buffer: "010203", encoding: "hex" };
    const restored = reviveJsonArg(raw);
    expect(Buffer.isBuffer(restored)).toBe(true);
    expect(restored).toEqual(Buffer.from([0x01, 0x02, 0x03]));
  });

  it("[BLE3-0141] reviveJsonArg rejects prototype pollution keys (__proto__) with RpcError", () => {
    // NOTE: JS object literal syntax { "__proto__": ... } silently sets the prototype rather than
    // creating an enumerable own key, so Object.entries() cannot observe it.
    // The guard in reviveJsonArg covers 'prototype' and 'constructor' (enumerable own keys).
    // For __proto__, use Object.create(null) + defineProperty to simulate an enumerable key.
    const obj = Object.create(null);
    Object.defineProperty(obj, "__proto__", { value: { x: 1 }, enumerable: true, configurable: true });
    expect(() => reviveJsonArg(obj)).toThrow(RpcError);
  });

  it("[BLE3-0141] reviveJsonArg rejects 'prototype' key with RpcError", () => {
    expect(() => reviveJsonArg({ "prototype": {} })).toThrow(RpcError);
  });

  it("[BLE3-0141] reviveJsonArg rejects 'constructor' key with RpcError", () => {
    expect(() => reviveJsonArg({ "constructor": {} })).toThrow(RpcError);
  });

  it("[BLE3-0141] cardAddData pads id to 16B (CHCardCapableImpl.kt:87 padEnd(16,0x00))", () => {
    // [0xF0][0x00][idLen=3] ++ id(3B).padEnd(16) ++ [nameLen=2] ++ name(2B).padEnd(16)
    const id = Buffer.from([0x11, 0x22, 0x33]);
    const data = cardAddData(id, "AB");
    expect(data.length).toBe(3 + 16 + 1 + 16); // header(3) + id_padded(16) + nameLen(1) + name_padded(16)
    expect(data[0]).toBe(0xf0); // CARD_DATA_USED
    expect(data[1]).toBe(0x00); // TYPE_CLOUD_BASE
    expect(data[2]).toBe(3);    // idLen
    expect(data[3]).toBe(0x11);
    expect(data[4]).toBe(0x22);
    expect(data[5]).toBe(0x33);
    // padEnd zeroes
    expect(data[6]).toBe(0x00);
    expect(data[18]).toBe(0x00);
    // nameLen = "AB" = 2 UTF-8 bytes
    expect(data[19]).toBe(2);
  });

  it("[BLE3-0141] cardAddData: JSON-serialized {type:'Buffer'} id is restored via reviveJsonArg and works", () => {
    // RPC 経由で JSON serialize された id の復元を模擬する
    const rawId = Buffer.from([0xaa, 0xbb]);
    const jsonForm = rawId.toJSON(); // {type:'Buffer', data:[170,187]}
    const restored = reviveJsonArg(jsonForm);
    expect(Buffer.isBuffer(restored)).toBe(true);
    expect(restored).toEqual(rawId);
    // そのまま cardAddData に渡せること (16B 枠に収まる)
    const result = cardAddData(restored, "00");
    expect(result[2]).toBe(2); // idLen=2
    expect(result[3]).toBe(0xaa);
    expect(result[4]).toBe(0xbb);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0142: card/passcode batchAdd 209B 分割, [dataIndex LE2B][dataSize LE2B][chunk]
// Ref: biometric.js:617-628, itemcodes.js:256; CHCardCapableImpl.kt:94-155
// ---------------------------------------------------------------------------

describe("[BLE3-0142] batchAdd 209B split and StpItemCode 182/184", () => {
  it("[BLE3-0142] StpItemCode STP_ITEM_CODE_CARDS_ADD=182, STP_ITEM_CODE_PASSCODES_ADD=184", () => {
    // SDK SesameProtocols.kt:65-67 StpItemCode enum
    expect(STP_ITEM.STP_ITEM_CODE_CARDS_ADD).toBe(182);
    expect(STP_ITEM.STP_ITEM_CODE_PASSCODES_ADD).toBe(184);
  });

  it("[BLE3-0142] batchAddPacket: single packet for data <= 209B", () => {
    // [dataIndex(2B LE)][dataSize(2B LE)][chunk(5B)] = 9B
    const data = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
    const { packet, nextIndex } = batchAddPacket(data, 0);
    expect(packet[0]).toBe(0x00); // dataIndex low byte
    expect(packet[1]).toBe(0x00); // dataIndex high byte
    expect(packet[2]).toBe(0x05); // dataSize low byte
    expect(packet[3]).toBe(0x00); // dataSize high byte
    expect(packet.subarray(4)).toEqual(data);
    expect(nextIndex).toBe(5);
  });

  it("[BLE3-0142] batchAddPacket: first packet of multi-packet (>209B) is 209B chunk", () => {
    const data = Buffer.alloc(500, 0xcc);
    const { packet, nextIndex } = batchAddPacket(data, 0);
    // chunk = min(500, 209) = 209B
    expect(packet.length).toBe(2 + 2 + 209);
    // dataIndex=0 LE2B
    expect(packet[0]).toBe(0x00);
    // dataSize=500 LE2B = 0xf4, 0x01
    expect(packet[2]).toBe(500 & 0xff);        // 0xf4
    expect(packet[3]).toBe((500 >> 8) & 0xff); // 0x01
    expect(nextIndex).toBe(209);
  });

  it("[BLE3-0142] batchAddPacket: second packet has correct dataIndex", () => {
    const totalSize = 210;
    const data = Buffer.allocUnsafe(totalSize);
    for (let i = 0; i < totalSize; i++) data[i] = i & 0xff;

    const { packet: p1, nextIndex: next1 } = batchAddPacket(data, 0);
    expect(p1.packet ? false : true).toBe(true); // p1 is already destructured
    expect(next1).toBe(209);

    const { packet: p2, nextIndex: next2 } = batchAddPacket(data, next1);
    // dataIndex = 209 in LE2B
    expect(p2[0]).toBe(209 & 0xff);        // 0xd1
    expect(p2[1]).toBe((209 >> 8) & 0xff); // 0x00
    // dataSize = 210 in LE2B
    expect(p2.readUInt16LE(2)).toBe(totalSize); // 210
    // remaining chunk = 1B
    expect(p2.length).toBe(2 + 2 + 1);
    expect(next2).toBe(210);
  });

  it("[BLE3-0142] cardBatchAdd uses STP_ITEM_CODE_CARDS_ADD=182", async () => {
    const { session, spyRequest } = makeSessionMock({ resultCode: 0, payload: Buffer.alloc(0) });
    const cmd = new BiometricCommands(session);
    const smallData = Buffer.from([0xaa, 0xbb, 0xcc]);
    await cmd.cardBatchAdd(smallData);
    expect(spyRequest).toHaveBeenCalledTimes(1);
    const [calledItemCode, calledData] = spyRequest.mock.calls[0];
    expect(calledItemCode).toBe(STP_ITEM.STP_ITEM_CODE_CARDS_ADD); // 182
    // dataSize part
    expect(calledData.readUInt16LE(2)).toBe(smallData.length);
  });

  it("[BLE3-0142] passcodeBatchAdd uses STP_ITEM_CODE_PASSCODES_ADD=184", async () => {
    const { session, spyRequest } = makeSessionMock({ resultCode: 0, payload: Buffer.alloc(0) });
    const cmd = new BiometricCommands(session);
    const smallData = Buffer.from([0x11, 0x22]);
    await cmd.passcodeBatchAdd(smallData);
    expect(spyRequest).toHaveBeenCalledTimes(1);
    const [calledItemCode] = spyRequest.mock.calls[0];
    expect(calledItemCode).toBe(STP_ITEM.STP_ITEM_CODE_PASSCODES_ADD); // 184
  });
});

// ---------------------------------------------------------------------------
// BLE3-0143: batchAdd dataIndex/dataSize = Short.toReverseBytes() LE, 32767 boundary
// Ref: biometric.js:104-108; DataExtention.kt:108-112; CHCardCapableImpl.kt:97-98
// ---------------------------------------------------------------------------

describe("[BLE3-0143] batchAdd LE encoding matches Short.toReverseBytes", () => {
  it("[BLE3-0143] dataIndex=0x0102, dataSize=0x0304: LE バイト順で packet 先頭 4B に入る", () => {
    // Kotlin DataExtention.kt:108-112: Short.toReverseBytes() = ByteBuffer.putShort → [buf[1],buf[0]] = LE
    const totalSize = 0x0304;
    const data = Buffer.alloc(totalSize, 0xaa);
    const dataIndex = 0x0102;
    const { packet } = batchAddPacket(data, dataIndex);
    // LE 2B: 0x0102 -> [0x02, 0x01]
    expect(packet[0]).toBe(0x02); // low byte of dataIndex
    expect(packet[1]).toBe(0x01); // high byte of dataIndex
    // LE 2B: 0x0304 -> [0x04, 0x03]
    expect(packet[2]).toBe(0x04); // low byte of dataSize
    expect(packet[3]).toBe(0x03); // high byte of dataSize
  });

  it("[BLE3-0143] dataIndex=209 encoded as LE2B [0xd1, 0x00]", () => {
    const data = Buffer.alloc(500, 0xee);
    const { packet } = batchAddPacket(data, 209);
    expect(packet[0]).toBe(0xd1); // 209 & 0xff
    expect(packet[1]).toBe(0x00); // 209 >> 8
  });

  it("[BLE3-0143] dataSize=32767 (Short.MAX_VALUE) encoded as LE2B [0xff, 0x7f]", () => {
    const data = Buffer.alloc(32767, 0x00);
    const { packet } = batchAddPacket(data, 0);
    // dataSize=32767: LE = 0xff, 0x7f
    expect(packet[2]).toBe(0xff);
    expect(packet[3]).toBe(0x7f);
  });

  it("[BLE3-0143] dataSize <= 32767: LE bytes match Kotlin Short.toReverseBytes", () => {
    // Kotlin Short.toReverseBytes (DataExtention.kt:108-112): identical to writeUInt16LE for v<=32767
    // v=0 is skipped: batchAdd is never called with zero-length data in practice
    const testValues = [1, 100, 209, 1000, 32767];
    for (const v of testValues) {
      const data = Buffer.alloc(v, 0x00);
      const { packet } = batchAddPacket(data, 0);
      const expectedLow = v & 0xff;
      const expectedHigh = (v >> 8) & 0xff;
      expect(packet[2]).toBe(expectedLow);
      expect(packet[3]).toBe(expectedHigh);
    }
  });
});

// ---------------------------------------------------------------------------
// BLE3-0144: CARD_NOTIFY 複数レコード連結を recordSize ずつ前進して parse
// Ref: biometric.js:744-760; CHCardEventHandlers.kt:22-34; CHSesameBiometricParseData.kt:10-17
// ---------------------------------------------------------------------------

describe("[BLE3-0144] CARD_NOTIFY multi-record concat parse via handleBiometricPublish", () => {
  it("[BLE3-0144] single CARD_NOTIFY record calls onCardReceive once with cardID/cardName/cardType", () => {
    // Payload: [cardType=0x04][idLen=2][id=0xaa,0xbb][nameLen=3][name=0x01,0x02,0x03]
    const payload = Buffer.from([0x04, 0x02, 0xaa, 0xbb, 0x03, 0x01, 0x02, 0x03]);
    const received = [];
    const delegate = {
      onCardReceive: (_dev, cardID, cardName, cardType) => received.push({ cardID, cardName, cardType }),
    };
    const handled = handleBiometricPublish({ itemCode: ITEM.CARD_NOTIFY, body: payload }, delegate, null);
    expect(handled).toBe(true);
    expect(received.length).toBe(1);
    expect(received[0].cardID).toBe("aabb");
    expect(received[0].cardName).toBe("010203");
    expect(received[0].cardType).toBe(0x04);
  });

  it("[BLE3-0144] two concatenated CARD_NOTIFY records calls onCardReceive twice", () => {
    // Record 1: [type=01][idLen=1][id=aa][nameLen=2][name=bbcc] = 6B
    // Record 2: [type=02][idLen=1][id=dd][nameLen=1][name=ee]   = 5B
    const rec1 = Buffer.from([0x01, 0x01, 0xaa, 0x02, 0xbb, 0xcc]);
    const rec2 = Buffer.from([0x02, 0x01, 0xdd, 0x01, 0xee]);
    const payload = Buffer.concat([rec1, rec2]);
    const received = [];
    const delegate = {
      onCardReceive: (_dev, cardID, cardName, cardType) => received.push({ cardID, cardName, cardType }),
    };
    const handled = handleBiometricPublish({ itemCode: ITEM.CARD_NOTIFY, body: payload }, delegate, null);
    expect(handled).toBe(true);
    expect(received.length).toBe(2);
    expect(received[0].cardID).toBe("aa");
    expect(received[0].cardName).toBe("bbcc");
    expect(received[0].cardType).toBe(0x01);
    expect(received[1].cardID).toBe("dd");
    expect(received[1].cardName).toBe("ee");
    expect(received[1].cardType).toBe(0x02);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0145: PASSCODE_NOTIFY 複数レコード連結 parse (card と同型)
// Ref: biometric.js:803-819, itemcodes.js:115; CHPassCodeEventHandlers.kt:22-34
// ---------------------------------------------------------------------------

describe("[BLE3-0145] PASSCODE_NOTIFY multi-record parse via handleBiometricPublish", () => {
  it("[BLE3-0145] single PASSCODE_NOTIFY record calls onKeyBoardReceive once", () => {
    // Same layout as CHSesameTouchCard (passcode reuses same parse structure)
    const payload = Buffer.from([0x01, 0x02, 0x11, 0x22, 0x02, 0xaa, 0xbb]);
    const received = [];
    const delegate = {
      onKeyBoardReceive: (_dev, cardID, cardName, cardType) => received.push({ cardID, cardName, cardType }),
    };
    const handled = handleBiometricPublish({ itemCode: ITEM.PASSCODE_NOTIFY, body: payload }, delegate, null);
    expect(handled).toBe(true);
    expect(received.length).toBe(1);
    expect(received[0].cardID).toBe("1122");
    expect(received[0].cardName).toBe("aabb");
    expect(received[0].cardType).toBe(0x01);
  });

  it("[BLE3-0145] two concatenated PASSCODE_NOTIFY records calls onKeyBoardReceive twice", () => {
    // Record 1: [type=03][idLen=1][id=ff][nameLen=1][name=ee] = 5B
    // Record 2: [type=04][idLen=1][id=dd][nameLen=2][name=cc,bb] = 6B
    const rec1 = Buffer.from([0x03, 0x01, 0xff, 0x01, 0xee]);
    const rec2 = Buffer.from([0x04, 0x01, 0xdd, 0x02, 0xcc, 0xbb]);
    const payload = Buffer.concat([rec1, rec2]);
    const received = [];
    const delegate = {
      onKeyBoardReceive: (_dev, cardID, cardName, cardType) => received.push({ cardID, cardName, cardType }),
    };
    handleBiometricPublish({ itemCode: ITEM.PASSCODE_NOTIFY, body: payload }, delegate, null);
    expect(received.length).toBe(2);
    expect(received[0].cardID).toBe("ff");
    expect(received[0].cardType).toBe(0x03);
    expect(received[1].cardID).toBe("dd");
    expect(received[1].cardType).toBe(0x04);
  });

  it("[BLE3-0145] PASSCODE_NOTIFY: delegate callback is onKeyBoardReceive (not onCardReceive)", () => {
    const rec = Buffer.from([0x01, 0x01, 0x01, 0x01, 0x02]);
    const delegate = {
      onKeyBoardReceive: vi.fn(),
      onCardReceive: vi.fn(),
    };
    handleBiometricPublish({ itemCode: ITEM.PASSCODE_NOTIFY, body: rec }, delegate);
    expect(delegate.onKeyBoardReceive).toHaveBeenCalledTimes(1);
    expect(delegate.onCardReceive).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// BLE3-0146: CARD_DELETE publish parse = [_][_][idLen][id..], onCardDelete(hex(id))
// Ref: biometric.js:768-774; CHCardEventHandlers.kt:48-55
// ---------------------------------------------------------------------------

describe("[BLE3-0146] CARD_DELETE publish parse asymmetry: [_][_][idLen][id..]", () => {
  it("[BLE3-0146] CARD_DELETE publish: payload[2]=idLen, id=payload[3..idLen+2], onCardDelete called with hex id", () => {
    // SDK CHCardEventHandlers.kt:51: payload.sliceArray(3..cardIDLen+2) (inclusive = idLen bytes)
    const payload = Buffer.from([0x00, 0x00, 0x02, 0x11, 0x22]);
    let deletedCardID = null;
    const delegate = {
      onCardDelete: (_dev, cardID) => { deletedCardID = cardID; },
    };
    const handled = handleBiometricPublish({ itemCode: ITEM.CARD_DELETE, body: payload }, delegate, null);
    expect(handled).toBe(true);
    expect(deletedCardID).toBe("1122");
  });

  it("[BLE3-0146] CARD_DELETE: idLen=3, id=payload[3..5] three bytes", () => {
    const idBytes = Buffer.from([0x12, 0x34, 0x56]);
    const payload = Buffer.concat([Buffer.from([0x00, 0x00, idBytes.length]), idBytes]);
    const delegate = { onCardDelete: vi.fn() };
    const handled = handleBiometricPublish({ itemCode: ITEM.CARD_DELETE, body: payload }, delegate, "dev");
    expect(handled).toBe(true);
    expect(delegate.onCardDelete).toHaveBeenCalledTimes(1);
    const [device, cardID] = delegate.onCardDelete.mock.calls[0];
    expect(device).toBe("dev");
    expect(cardID).toBe("123456");
  });

  it("[BLE3-0146] CARD_DELETE publish vs send cardDeleteData asymmetry: send is raw id bytes only (no header)", () => {
    // 送信: cardDeleteData は hexToBytes(cardID) のみ (ヘッダ [_][_][idLen] を付けない)
    const cardID = "123456";
    const sendData = cardDeleteData(cardID);
    // 送信データは 3B のみ (ヘッダ無し)
    expect(sendData).toEqual(Buffer.from([0x12, 0x34, 0x56]));
    // publish 受信は [0x00, 0x00, 0x03, 0x12, 0x34, 0x56] の 6B 形式 — 送信と受信は非対称
    expect(sendData.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0147: PASSCODE_DELETE publish parse = [_][_][idLen][id..]
// Ref: biometric.js:827-833; CHPassCodeEventHandlers.kt:48-55
// ---------------------------------------------------------------------------

describe("[BLE3-0147] PASSCODE_DELETE publish parse [_][_][idLen][id..]", () => {
  it("[BLE3-0147] PASSCODE_DELETE publish: payload[2]=idLen, id=payload[3..idLen+2], onKeyBoardDelete called", () => {
    // SDK CHPassCodeEventHandlers.kt:51: payload.sliceArray(3..pwdIDLen+2) (idLen bytes)
    const payload = Buffer.from([0x00, 0x00, 0x03, 0xde, 0xad, 0xbe]);
    let deletedID = null;
    const delegate = {
      onKeyBoardDelete: (_dev, pwdID) => { deletedID = pwdID; },
    };
    const handled = handleBiometricPublish({ itemCode: ITEM.PASSCODE_DELETE, body: payload }, delegate, null);
    expect(handled).toBe(true);
    expect(deletedID).toBe("deadbe");
  });

  it("[BLE3-0147] PASSCODE_DELETE: idLen=2 gives 2-byte id hex", () => {
    const payload = Buffer.from([0x01, 0x02, 0x02, 0x11, 0x22, 0x33]);
    let deletedID = null;
    const delegate = { onKeyBoardDelete: (_dev, id) => { deletedID = id; } };
    handleBiometricPublish({ itemCode: ITEM.PASSCODE_DELETE, body: payload }, delegate, null);
    expect(deletedID).toBe("1122");
  });

  it("[BLE3-0147] PASSCODE_DELETE calls onKeyBoardDelete, not onCardDelete", () => {
    const payload = Buffer.from([0x00, 0x00, 0x01, 0xff]);
    const delegate = {
      onKeyBoardDelete: vi.fn(),
      onCardDelete: vi.fn(),
    };
    handleBiometricPublish({ itemCode: ITEM.PASSCODE_DELETE, body: payload }, delegate);
    expect(delegate.onKeyBoardDelete).toHaveBeenCalledTimes(1);
    expect(delegate.onCardDelete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// BLE3-0148: CARD_CHANGE publish parse → onCardChanged(cardID,cardName,cardType)
// Ref: biometric.js:761-765; CHCardEventHandlers.kt:17-21
// ---------------------------------------------------------------------------

describe("[BLE3-0148] CARD_CHANGE publish parsed as single CHSesameTouchCard record → onCardChanged", () => {
  it("[BLE3-0148] CARD_CHANGE publish calls onCardChanged with cardID/cardName/cardType (single record)", () => {
    // SDK CHCardEventHandlers.kt:17-21: single CHSesameTouchCard parse, no loop
    const payload = Buffer.from([0x05, 0x02, 0xca, 0xfe, 0x03, 0xba, 0xbe, 0x01]);
    let changed = null;
    const delegate = {
      onCardChanged: (_dev, cardID, cardName, cardType) => { changed = { cardID, cardName, cardType }; },
    };
    const handled = handleBiometricPublish({ itemCode: ITEM.CARD_CHANGE, body: payload }, delegate, null);
    expect(handled).toBe(true);
    expect(changed).not.toBeNull();
    expect(changed.cardID).toBe("cafe");
    expect(changed.cardName).toBe("babe01");
    expect(changed.cardType).toBe(0x05);
  });

  it("[BLE3-0148] CARD_CHANGE publish does not loop (single record only, 2nd ignored)", () => {
    // NOTIFY はループ、CHANGE は単発 (CHCardEventHandlers.kt:17-21)
    const rec1 = Buffer.from([0x01, 0x01, 0xaa, 0x01, 0xbb]);
    const rec2 = Buffer.from([0x02, 0x01, 0xcc, 0x01, 0xdd]);
    const payload = Buffer.concat([rec1, rec2]);
    const delegate = { onCardChanged: vi.fn() };
    handleBiometricPublish({ itemCode: ITEM.CARD_CHANGE, body: payload }, delegate);
    // 1 回のみ (2 レコード目は無視)
    expect(delegate.onCardChanged).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0149: CARD_MODE_SET publish → onCardModeChanged(payload[0])
// Ref: biometric.js:766-767; CHCardEventHandlers.kt:43-47
// ---------------------------------------------------------------------------

describe("[BLE3-0149] CARD_MODE_SET publish → onCardModeChanged(payload[0])", () => {
  it("[BLE3-0149] CARD_MODE_SET(114) publish calls onCardModeChanged with payload[0] as mode byte", () => {
    // SDK: delegate.onCardModeChanged(device, payload.payload[0]) (CHCardEventHandlers.kt:45)
    const payload = Buffer.from([0x03]);
    const delegate = { onCardModeChanged: vi.fn() };
    const handled = handleBiometricPublish(
      { itemCode: ITEM.CARD_MODE_SET, body: payload },
      delegate,
      "dev",
    );
    expect(handled).toBe(true);
    expect(delegate.onCardModeChanged).toHaveBeenCalledTimes(1);
    const [device, mode] = delegate.onCardModeChanged.mock.calls[0];
    expect(device).toBe("dev");
    expect(mode).toBe(0x03);
  });

  it("[BLE3-0149] CARD_MODE_SET with mode=0 calls onCardModeChanged(0)", () => {
    const payload = Buffer.from([0x00]);
    let modeChanged = null;
    const delegate = { onCardModeChanged: (_dev, mode) => { modeChanged = mode; } };
    handleBiometricPublish({ itemCode: ITEM.CARD_MODE_SET, body: payload }, delegate, null);
    expect(modeChanged).toBe(0);
  });

  it("[BLE3-0149] CARD_MODE_SET=114 itemCode constant matches SDK", () => {
    expect(ITEM.CARD_MODE_SET).toBe(114);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0150: faceModeSet → SSM_OS3_FACE_MODE_SET(161) + [mode 1B]
// Ref: biometric.js:503, itemcodes.js:143; CHFaceCapableImpl.kt:22-23
// ---------------------------------------------------------------------------

describe("[BLE3-0150] faceModeSet itemCode=161 and payload=[mode 1B]", () => {
  it("[BLE3-0150] faceModeSetData(mode) returns [mode & 0xff] 1B", () => {
    // SDK: SesameOS3Payload(SSM_OS3_FACE_MODE_SET, byteArrayOf(mode)) (CHFaceCapableImpl.kt:22)
    expect(ITEM.FACE_MODE_SET).toBe(161);
    expect(faceModeSetData(0)).toEqual(Buffer.from([0x00]));
    expect(faceModeSetData(5)).toEqual(Buffer.from([5]));
    expect(faceModeSetData(0xff)).toEqual(Buffer.from([0xff]));
    // mask: 0x100 & 0xff = 0x00
    expect(faceModeSetData(0x100)).toEqual(Buffer.from([0x00]));
  });

  it("[BLE3-0150] BiometricCommands.faceModeSet sends FACE_MODE_SET=161 with [mode] data", async () => {
    const { session, spyRequest } = makeSessionMock({ resultCode: 0, payload: Buffer.alloc(0) });
    const cmd = new BiometricCommands(session);
    await cmd.faceModeSet(2);
    expect(spyRequest).toHaveBeenCalledWith(ITEM.FACE_MODE_SET, faceModeSetData(2));
    expect(ITEM.FACE_MODE_SET).toBe(161);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0151: faceModeGet → SSM_OS3_FACE_MODE_GET(160) empty data, response payload[0]=mode
// Ref: biometric.js:504, 1044-1048; CHFaceCapableImpl.kt:29-37; itemcodes.js:142
// ---------------------------------------------------------------------------

describe("[BLE3-0151] faceModeGet itemCode=160, empty payload, response payload[0]=mode, empty throws", () => {
  it("[BLE3-0151] faceModeGetData() returns empty Buffer", () => {
    expect(ITEM.FACE_MODE_GET).toBe(160);
    const data = faceModeGetData();
    expect(data.length).toBe(0);
    expect(data).toEqual(Buffer.alloc(0));
  });

  it("[BLE3-0151] BiometricCommands.faceModeGet sends FACE_MODE_GET=160 with empty data and returns payload[0]", async () => {
    const { session, spyRequest } = makeSessionMock({ resultCode: 0, payload: Buffer.from([9]) });
    const cmd = new BiometricCommands(session);
    const result = await cmd.faceModeGet();
    expect(spyRequest).toHaveBeenCalledWith(ITEM.FACE_MODE_GET, faceModeGetData());
    expect(result).toBe(9);
  });

  it("[BLE3-0151] faceModeGet throws 'faceModeGet data error' when response payload is empty", async () => {
    // CHFaceCapableImpl.kt:35 Result.failure(Exception("Data Error")) when empty
    const { session } = makeSessionMock({ resultCode: 0, payload: Buffer.alloc(0) });
    const cmd = new BiometricCommands(session);
    await expect(cmd.faceModeGet()).rejects.toThrow(/faceModeGet data error/);
  });
});

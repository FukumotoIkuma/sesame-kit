// プリセット (HXD) IR リモコンの command 生成 + 発射 (remoteEmit)。
//
// Ported from biz3 (CANDY-HOUSE/biz3, MIT):
//   - vendor reference: references_web/src/pages/personal/devices/wifi-module/ir/utils/HXDCommandProcessor.js
//   - vendor reference: references_web/src/pages/personal/devices/wifi-module/ir/utils/HXDParametersSwapper.js
//   - vendor reference: references_web/src/pages/personal/devices/wifi-module/ir/remote-air/index.js
//   - vendor reference: references_web/src/pages/personal/devices/wifi-module/ir/remote-non-air/index.js
//   - vendor reference: references_web/src/api/useRemoteCtrl.js:460-484 (sendIR frame), 65-80 (response)
//
// 概要:
//   メーカー DB から取得したプリセットリモコン (remote.code を持つ) に対し、
//   エアコン/TV/照明/扇風機の HEX command 文字列をローカル生成し、
//   既存 sendIR (op:'sendIR', operation:'remoteEmit') で Hub3 に投げる。
//   presetIR 固有の新 WS op は無い (sendIR は learnIR 等と完全共通)。
//
// ⚠️ irType (= remote.type) は **実値** をそのまま渡す:
//   0xC000=エアコン, 0x8000=扇風機, 0xE000=ライト, 0x2000=TV。
//   (UI メニュー id の 0xFEFF=学習 はここでは扱わない。crypto.js / ir.js の IR_TYPE トラップ参照)
//
// ⚠️ getAirKey の keyMap トラップ (過去バグ源・biz3 をそのまま再現):
//   remote-air/index.js:122 は buildCommand 内で getAirKey(item.type) を呼ぶが、
//   airControlItems (remote-air:238-302) の item.type は
//   'POWER_ON','POWER_OFF','TEMP_ADD','TEMP_REDUCE','MODE','FAN_SPEED','WIND_DIRECTION','AUTO_SWING'。
//   一方 getAirKey の keyMap キーは 'POWER_STATUS_ON','POWER_STATUS_OFF',
//   'TEMP_CONTROL_ADD','TEMP_CONTROL_REDUCE','MODE','FAN_SPEED','WIND_DIRECTION','AUTO_WIND_DIRECTION'。
//   → POWER_*/TEMP_*/AUTO_SWING は keyMap に無く default 0x01 にフォールバックする。
//     MODE/FAN_SPEED/WIND_DIRECTION のみ一致。
//   Air では key は buf[9] に入るだけで、実際の状態 (温度/モード/風速/風向/電源) は
//   buildAirCommand が buf[4..10] へ直接書き込むため、key の値は発射動作にほぼ影響しない。
//   本実装は biz3 の keyMap をそのまま移植し、UI type → keyMap キーの読み替えは行わない
//   (biz3 の挙動を 1bit も変えない)。呼び出し側で keyMap のキー名を直接渡すこともできる。

import { ACTION_TYPES } from "../vendor/biz3/constants/messageConstants.js";
import { assertSuccess, badRequest } from "./util.js";

const ACTION = ACTION_TYPES.BIZ3_IR_REMOTE; // "biz3IRRemote" (vendor 由来)
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * irType (remote.type) の確定値。
 * 一次資料: presetIR.json extraLogic C / HXDParametersSwapper.getKeyByDeviceType:166-180。
 * @readonly
 */
export const IR_TYPE = Object.freeze({
  AIR: 0xc000, // エアコン (remote-air ページ)
  FAN: 0x8000, // 扇風機
  LIGHT: 0xe000, // ライト
  TV: 0x2000, // TV
});

// =====================================================================
// A. HXDCommandProcessor (vendor: HXDCommandProcessor.js)
//    内部状態 setter チェーン → buildAir/NonAirCommand で 16 byte を生成。
// =====================================================================

/**
 * HXD プリセット command の組み立て器。
 * biz3 HXDCommandProcessor.js を 1:1 移植 (constructor 既定値・byte 配置・checksum 完全一致)。
 */
export class HXDCommandProcessor {
  constructor() {
    // 既定値 (HXDCommandProcessor.js:3-15)
    this.power = 0x00;
    this.temperature = 25;
    this.fanSpeed = 0x01;
    this.windDirection = 0x02;
    this.autoWindDirection = 0x01;
    this.mode = 0x02;
    this.key = 0x01;
    this.code = 0x00;
    this.defaultTable = [0, 0, 0];
    this.AirPrefixCode = [0x30, 0x01];
    this.commonPrefixCode = [0x30, 0x00];
  }

  /**
   * エアコン command (16 byte) を生成。
   * vendor: HXDCommandProcessor.js:17-34。
   * 配置: [0x30,0x01, codeHi,codeLo, temp,fanSpeed,windDir,autoWind,power,key,mode, 1,0,0, 0xff, checksum]
   * @returns {number[]} 16 byte の配列
   */
  buildAirCommand() {
    const buf = this.buildKeyData(this.AirPrefixCode, this.code, this.defaultTable);
    buf[4] = this.temperature;
    buf[5] = this.fanSpeed;
    buf[6] = this.windDirection;
    buf[7] = this.autoWindDirection;
    buf[8] = this.power;
    buf[9] = this.key;
    buf[10] = this.mode;
    buf[buf.length - 2] = 0xff;

    // checksum: 末尾 1 byte を除く先頭全 byte の総和の下位 8bit (HXDCommandProcessor.js:29-30)
    const checkSum = buf.slice(0, -1).reduce((sum, byte) => sum + byte, 0);
    buf[buf.length - 1] = checkSum & 0xff;
    return buf;
  }

  /**
   * 非エアコン (TV/ライト/扇風機) command (16 byte) を生成。
   * vendor: HXDCommandProcessor.js:36-47。
   * 配置: [0x30,0x00, codeHi,codeLo, 0,0,0,0,0, key, 0, 1,0,0, 0xff, checksum]
   * @returns {number[]} 16 byte の配列
   */
  buildNonAirCommand() {
    const buf = this.buildKeyData(this.commonPrefixCode, this.code, this.defaultTable);
    buf[9] = this.key;
    buf[buf.length - 2] = 0xff;

    const checkSum = buf.slice(0, -1).reduce((sum, byte) => sum + byte, 0);
    buf[buf.length - 1] = checkSum & 0xff;
    return buf;
  }

  /**
   * command の骨格 (16 byte) を生成。Air/NonAir 共通。
   * vendor: HXDCommandProcessor.js:49-71。
   * @param {number[]} prefixCodeArray 2 byte prefix ([0x30,0x01] か [0x30,0x00])
   * @param {number} code  remote.code (16bit, ビッグエンディアンで 2 byte に分割)
   * @param {number[]} table  既定 [0,0,0] (table[0]+1 が buf[11] に入る)
   * @returns {number[]} 16 byte
   */
  buildKeyData(prefixCodeArray, code, table) {
    const indexTable = [...table];
    const buf = [];

    // prefix 2 byte → buf[0],buf[1]
    buf.push(...prefixCodeArray);

    // code 16bit (ビッグエンディアン) → buf[2]=上位, buf[3]=下位
    const [firstPart, secondPart] = this.decimalToTwoHexInts(code);
    buf.push(firstPart, secondPart);

    // 0 を 7 個 → buf[4..10]
    buf.push(...new Array(7).fill(0));

    // index table: indexTable[0] = (table[0]+1)&0xff → buf[11..13]
    indexTable[0] = (table[0] + 1) & 0xff;
    buf.push(...indexTable);

    // 終端マーカー → buf[14]=0xff, buf[15]=0
    buf.push(0xff, 0);

    return buf;
  }

  /**
   * 数値を 16bit ビッグエンディアンの 2 byte に分割。
   * vendor: HXDCommandProcessor.js:73-77。
   * @param {number} number
   * @returns {[number, number]} [上位 byte, 下位 byte]
   */
  decimalToTwoHexInts(number) {
    const firstPart = Math.floor(number / 256);
    const secondPart = number % 256;
    return [firstPart, secondPart];
  }

  /**
   * byte 配列を大文字 HEX 文字列に変換 (区切り無し・各 byte 2 桁 0 埋め)。
   * これが sendIR の command フィールドに入る文字列。
   * vendor: HXDCommandProcessor.js:132-134。
   * @param {number[]} byteArray
   * @returns {string} 例 "30010000..."
   */
  toHexString(byteArray) {
    return byteArray.map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join("");
  }

  /**
   * HEX 文字列を byte 配列に戻す。
   * vendor: HXDCommandProcessor.js:124-130。
   * @param {string} hexString
   * @returns {number[]}
   */
  hexStringToByteArray(hexString) {
    const result = [];
    for (let i = 0; i < hexString.length; i += 2) {
      result.push(parseInt(hexString.substr(i, 2), 16));
    }
    return result;
  }

  /**
   * 保存済みエアコン command HEX から状態を復元 (発射には不要・state 復元用)。
   * vendor: HXDCommandProcessor.js:84-117。
   * 前提: length>=22, bytes[0]===0x30 && bytes[1]===0x01。不正時は null。
   * @param {string} hexString
   * @returns {{temperature:number,fanSpeed:number,windDirection:number,autoWindDirection:number,power:number,key:number,mode:number}|null}
   */
  parseAirCommand(hexString) {
    if (!hexString || hexString.length < 22) return null;
    const bytes = this.hexStringToByteArray(hexString);
    if (bytes.length < 11 || bytes[0] !== 0x30 || bytes[1] !== 0x01) return null;
    return {
      temperature: bytes[4],
      fanSpeed: bytes[5],
      windDirection: bytes[6],
      autoWindDirection: bytes[7],
      power: bytes[8],
      key: bytes[9],
      mode: bytes[10],
    };
  }

  // --- setter (チェーン可・vendor:136-176) ---
  /** @param {number} power */
  setPower(power) { this.power = power; return this; }
  /** @param {number} temperature */
  setTemperature(temperature) { this.temperature = temperature; return this; }
  /** @param {number} model */
  setModel(model) { this.mode = model; return this; } // vendor 名は setModel (mode を設定)
  /** @param {number} fanSpeed */
  setFanSpeed(fanSpeed) { this.fanSpeed = fanSpeed; return this; }
  /** @param {number} windDirection */
  setWindDirection(windDirection) { this.windDirection = windDirection; return this; }
  /** @param {number} autoWindDirection */
  setAutoWindDirection(autoWindDirection) { this.autoWindDirection = autoWindDirection; return this; }
  /** @param {number} key */
  setKey(key) { this.key = key; return this; }
  /** @param {number} code */
  setCode(code) { this.code = code; return this; }
}

// =====================================================================
// B. HXDParametersSwapper (vendor: HXDParametersSwapper.js)
//    UI 値 ↔ HXD 実値変換 + device type 別 key テーブル。
// =====================================================================

/**
 * HXD パラメータ変換器。biz3 HXDParametersSwapper.js を 1:1 移植。
 * key テーブルは vendor の値・default フォールバックまで完全一致させている。
 */
export class HXDParametersSwapper {
  /**
   * エアコン key (HXDParametersSwapper.js:4-17)。
   * 注: UI type 'POWER_ON'/'TEMP_ADD' 等は keyMap に無く default 0x01 (ファイル冒頭トラップ参照)。
   * @param {string} [type]  未指定時は default 0x01
   * @returns {number}
   */
  getAirKey(type) {
    const keyMap = {
      POWER_STATUS_ON: 0x01,
      POWER_STATUS_OFF: 0x01,
      TEMP_CONTROL_ADD: 0x06,
      TEMP_CONTROL_REDUCE: 0x07,
      MODE: 0x02,
      FAN_SPEED: 0x03,
      WIND_DIRECTION: 0x04,
      AUTO_WIND_DIRECTION: 0x05,
    };
    return /** @type {Record<string, number>} */ (keyMap)[type ?? ""] || 0x01;
  }

  /**
   * mode index → HXD 値 (vendor:45-54)。{0:自動,1:制冷,2:除湿,3:送風,4:制熱}
   * @param {number} index @returns {number}
   */
  getModeValue(index) {
    const valueMap = { 0: 0x01, 1: 0x02, 2: 0x03, 3: 0x04, 4: 0x05 };
    return /** @type {Record<number, number>} */ (valueMap)[index] || 0x01;
  }

  /**
   * fanSpeed index → HXD 値 (vendor:67-75)。{0:自動,1:低,2:中,3:高}
   * @param {number} index @returns {number}
   */
  getFanSpeedValue(index) {
    const valueMap = { 0: 0x01, 1: 0x02, 2: 0x03, 3: 0x04 };
    return /** @type {Record<number, number>} */ (valueMap)[index] || 0x01;
  }

  /**
   * windDirection index → HXD 値 (vendor:87-94)。{0:上,1:中,2:下}。default 0x02。
   * @param {number} index @returns {number}
   */
  getWindDirectionValue(index) {
    const valueMap = { 0: 0x01, 1: 0x02, 2: 0x03 };
    return /** @type {Record<number, number>} */ (valueMap)[index] || 0x02;
  }

  /**
   * ライト key (vendor:114-125)。
   * @param {string} type @returns {number}
   */
  getLightKey(type) {
    const keyMap = {
      POWER_STATUS_ON: 0x01,
      POWER_STATUS_OFF: 0x02,
      MODE: 0x05,
      BRIGHTNESS_UP: 0x03,
      BRIGHTNESS_DOWN: 0x04,
      COLOR_TEMP_UP: 0x09,
      COLOR_TEMP_DOWN: 0x0a,
    };
    return /** @type {Record<string, number>} */ (keyMap)[type] || 0x01;
  }

  /**
   * TV key (vendor:128-147)。
   * @param {string} type @returns {number}
   */
  getTVKey(type) {
    const keyMap = {
      POWER_STATUS_ON: 0x06,
      POWER_STATUS_OFF: 0x06,
      MUTE: 0x07,
      BACK: 0x14,
      UP: 0x16,
      MENU: 0x03,
      LEFT: 0x17,
      OK: 0x15,
      RIGHT: 0x18,
      VOLUME_UP: 0x05,
      DOWN: 0x19,
      CHANNEL_UP: 0x02,
      VOLUME_DOWN: 0x01,
      HOME: 0x1a,
      CHANNEL_DOWN: 0x04,
    };
    return /** @type {Record<string, number>} */ (keyMap)[type] || 0x01;
  }

  /**
   * 扇風機 key (vendor:150-162)。
   * @param {string} type @returns {number}
   */
  getFanKey(type) {
    const keyMap = {
      POWER_STATUS_ON: 0x01,
      POWER_STATUS_OFF: 0x01,
      FAN_SPEED: 0x02,
      SHAKE_HEAD: 0x03,
      MODE: 0x04,
      LOW: 0x14,
      MIDDLE: 0x15,
      HIGH: 0x16,
    };
    return /** @type {Record<string, number>} */ (keyMap)[type] || 0x01;
  }

  /**
   * device type (irType) 別に key を引く (非エアコン UI 経由)。
   * vendor: HXDParametersSwapper.js:166-180。
   * 未知 type は warn を出さず default 0x01 (CLI なので console.warn は省略)。
   * @param {number} irType  IR_TYPE のいずれか
   * @param {string} type    ボタン種別文字列
   * @returns {number}
   */
  getKeyByDeviceType(irType, type) {
    switch (irType) {
      case 0xc000:
        return this.getAirKey(type);
      case 0xe000:
        return this.getLightKey(type);
      case 0x2000:
        return this.getTVKey(type);
      case 0x8000:
        return this.getFanKey(type);
      default:
        return 0x01;
    }
  }
}

// =====================================================================
// C. 高レベル command 生成 (純関数・biz3 呼び出しフローを再現)
// =====================================================================

/**
 * エアコンの発射 command (HEX 文字列) を生成。
 * biz3 buildCommand を再現 (remote-air/index.js:117-138, 呼び出しフロー extraLogic D)。
 *
 * 状態は buildAirCommand が buf[4..10] へ直接書き込むため、key 値は発射にほぼ影響しない
 * (key は buf[9] に入るが、power は buf[8] が支配的)。keyType 未指定時は default 0x01。
 *
 * @param {{
 *   code: number,            // remote.code (プリセット DB 由来の数値)
 *   power?: boolean,         // 電源 ON/OFF (remote-air:126: power?0x01:0x00)
 *   temperature?: number,    // UI 温度値 (16-32, 変換なしでそのまま)
 *   mode?: number,           // mode index 0-4 (getModeValue で HXD 値に変換)
 *   fanSpeed?: number,       // fanSpeed index 0-3
 *   windDirection?: number,  // windDirection index 0-2
 *   autoSwing?: boolean,     // 自動風向 (remote-air:131: autoSwing?0x01:0x00)
 *   keyType?: string,        // getAirKey に渡す type (省略時 buf[9]=0x01)
 * }} state
 * @returns {string} 大文字 HEX command 文字列
 */
export function buildAirCommandHex(state) {
  const swapper = new HXDParametersSwapper();
  const proc = new HXDCommandProcessor();
  const key = swapper.getAirKey(state.keyType);
  const cmd = proc
    .setKey(key)
    .setCode(state.code)
    .setPower(state.power ? 0x01 : 0x00)
    .setTemperature(state.temperature ?? 25)
    .setModel(swapper.getModeValue(state.mode ?? 0))
    .setFanSpeed(swapper.getFanSpeedValue(state.fanSpeed ?? 0))
    .setWindDirection(swapper.getWindDirectionValue(state.windDirection ?? 1))
    .setAutoWindDirection(state.autoSwing ? 0x01 : 0x00)
    .buildAirCommand();
  return proc.toHexString(cmd);
}

/**
 * 非エアコン (TV/ライト/扇風機) の発射 command (HEX 文字列) を生成。
 * biz3 buildCommand を再現 (remote-non-air/index.js:113-124, 呼び出しフロー extraLogic D)。
 *
 * @param {{
 *   irType: number,   // IR_TYPE.TV / LIGHT / FAN (getKeyByDeviceType に渡す)
 *   code: number,     // remote.code
 *   buttonType: string, // ボタン種別 (getTVKey/getLightKey/getFanKey の keyMap キー)
 * }} p
 * @returns {string} 大文字 HEX command 文字列
 */
export function buildNonAirCommandHex({ irType, code, buttonType }) {
  const swapper = new HXDParametersSwapper();
  const proc = new HXDCommandProcessor();
  const key = swapper.getKeyByDeviceType(irType, buttonType);
  const cmd = proc.setKey(key).setCode(code).buildNonAirCommand();
  return proc.toHexString(cmd);
}

// =====================================================================
// D. sendIR (remoteEmit) — WS 発射 op
// =====================================================================

/**
 * 既に生成した HEX command をそのまま Hub3 に発射する。
 * frame は learnIR 等の sendIR と完全共通 (useRemoteCtrl.js:460-484)。
 *
 * フィールド名トラップ:
 *   - deviceId    : Hub3 の deviceUUID 文字列 (hub3DeviceId ではなく **deviceId**)
 *   - irDeviceUUID: 保存済みリモコンの uuid。未保存プリセットでは **空文字 ''**
 *                   (remote-air:369 / remote-non-air:155 で remote.uuid || '')
 *
 * 応答: action:'biz3IRRemote', op:'sendIR', success:bool, message?, data?
 *   (handleRemoteResponse:65-80 は op==='sendIR' && success で成功扱い)
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{
 *   deviceId: string,        // Hub3 deviceUUID
 *   command: string,         // HEX command (buildAir/NonAirCommandHex の戻り値)
 *   irType: number,          // remote.type 実値 (IR_TYPE)
 *   companyID: string,       // gStripe.customerInfo.companyID
 *   irDeviceUUID?: string,   // remote.uuid (未保存は '')
 *   operation?: string,      // 既定 'remoteEmit'
 *   timeoutMs?: number,
 * }} p
 * @returns {Promise<object>} 応答メッセージ (success / data / message)
 */
export async function sendIR(client, p) {
  if (!p || !p.deviceId) throw badRequest("presetir.err.deviceIdRequired");
  if (!p.command) throw badRequest("presetir.err.commandRequired");
  if (p.irType == null) throw badRequest("presetir.err.irTypeRequired");
  if (!p.companyID) throw badRequest("presetir.err.companyIdRequired");

  const frame = {
    action: ACTION,
    op: "sendIR",
    deviceId: p.deviceId,
    command: p.command,
    operation: p.operation ?? "remoteEmit",
    irType: p.irType,
    companyID: p.companyID,
    irDeviceUUID: p.irDeviceUUID ?? "",
  };
  const resp = await client.request(frame, p.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // ir.js/biz3 の sendIR と同じく success===true を要求する (strict)。
  assertSuccess(resp, "sendIR", { strict: true });
  return resp;
}

/**
 * エアコン: 状態から command を生成してそのまま発射する複合関数。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{
 *   deviceId: string, companyID: string, code: number,
 *   irDeviceUUID?: string, timeoutMs?: number,
 *   power?: boolean, temperature?: number, mode?: number,
 *   fanSpeed?: number, windDirection?: number, autoSwing?: boolean, keyType?: string,
 * }} p
 * @returns {Promise<{command:string, response:object}>}
 */
export async function emitAir(client, p) {
  const command = buildAirCommandHex(p);
  const response = await sendIR(client, {
    deviceId: p.deviceId,
    command,
    irType: IR_TYPE.AIR,
    companyID: p.companyID,
    irDeviceUUID: p.irDeviceUUID ?? "",
    timeoutMs: p.timeoutMs,
  });
  return { command, response };
}

/**
 * 非エアコン (TV/ライト/扇風機): ボタン押下を生成して発射する複合関数。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{
 *   deviceId: string, companyID: string, code: number,
 *   irType: number, buttonType: string,
 *   irDeviceUUID?: string, timeoutMs?: number,
 * }} p
 * @returns {Promise<{command:string, response:object}>}
 */
export async function emitButton(client, p) {
  const command = buildNonAirCommandHex({
    irType: p.irType,
    code: p.code,
    buttonType: p.buttonType,
  });
  const response = await sendIR(client, {
    deviceId: p.deviceId,
    command,
    irType: p.irType,
    companyID: p.companyID,
    irDeviceUUID: p.irDeviceUUID ?? "",
    timeoutMs: p.timeoutMs,
  });
  return { command, response };
}

/**
 * namespace (hub.presetir.*) に露出する client op の allowlist。
 * HXDCommandProcessor / HXDParametersSwapper (class) と buildAirCommandHex /
 * buildNonAirCommandHex (client を取らない純ビルダ) は namespace に出さない
 * (client.js _bindNs が ws を第1引数に注入して壊れるため)。これらは低レベル
 * ユーティリティとして index.js の presetir namespace から直接 import して使う。
 */
export const NAMESPACE_OPS = ["sendIR", "emitAir", "emitButton"];

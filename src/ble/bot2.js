// SESAME Bot2 / Bot3 のスクリプト機能 (OS3)。
//
// 移植元 (1:1):
//   - open/devices/os3/CHSesameBot2Device.kt:73-193
//       click(index) / sendClickScript / selectScript / getCurrentScript / getScriptNameList
//   - open/devices/CHSesameBot2.kt
//       BotActionType / Bot2Action(.toByteArray) / CHSesamebot2Event(.fromByteArray/.toByteArray) /
//       CHSesamebot2Status(.fromByteArray) / interface CHSesameBot2
//   - itemCode 値: ble/SesameProtocols.kt:36,47-48 (SCRIPT_SELECT=94 / SCRIPT_CURRENT=95 /
//       SCRIPT_NAME_LIST=96 / BOT2_ITEM_CODE_RUN_SCRIPT_0=170..179 / BOT2_ITEM_CODE_EDIT_SCRIPT=181)
//
// Bot2/Bot3 は「click」のほかに、最大 10 個のスクリプトを保持する。各スクリプトは
//   name (最大 20B) + 最大 20 個の Bot2Action (action 種別 + 時間)
// から成り、click(index) で index 番のスクリプトを実行できる。
//
// 設計は biometric.js / wm2.js と同じ流儀: protocol.js 同様の **純関数の payload 生成器/parser** と、
// それを session に束ねる薄い `Bot2Commands` クラスに分ける。session への結線 (request) は
// このモジュールが内部で行うが、parser / builder は単独 export して結線フェーズで index.js が
// 自由に組めるようにする。
//
// ★ 実機未検証: バイト列・itemCode は SDK Kotlin と 1:1 で移植したが、Bot2/Bot3 実機での
//   往復確認は行っていない。

import { Buffer } from "node:buffer";
import { ITEM_CODES } from "../itemcodes.js";
import { t } from "../i18n.js";
import { historyTagBLE as defaultHistoryTagBLE } from "./protocol.js";

const ITEM = ITEM_CODES;

// click(index) が許す script index の上限 (RUN_SCRIPT_0..RUN_SCRIPT_9 の 10 本)。
const MAX_SCRIPT_INDEX = 9;
// スクリプト name のバイト長 (CHSesamebot2Event は name 領域を常に 20B 確保する)。
const SCRIPT_NAME_FIELD_LEN = 20;

/**
 * 動作種別 (CHSesameBot2.kt BotActionType と 1:1)。
 * 正転 / 反転 / 停止 (惰性なし) / 睡眠 (惰性あり)。
 */
export const BOT_ACTION_TYPE = Object.freeze({
  FORWARD: 0,
  REVERSE: 1,
  STOP: 2,
  SLEEP: 3,
});

/** @type {Set<number>} */
const BOT_ACTION_VALUES = new Set(Object.values(BOT_ACTION_TYPE));

/**
 * UByte 値域 (0..255) の整数か。
 * @param {unknown} v
 * @returns {boolean}
 */
function isUByte(v) { return Number.isInteger(v) && typeof v === "number" && v >= 0 && v <= 0xff; }

/**
 * index → click 用 itemCode (RUN_SCRIPT_0 + index)。
 * CHSesameBot2Device.kt:75-80 と 1:1: index 指定時は RUN_SCRIPT_0(170)+index、未指定は click(89)。
 * @param {number|null|undefined} index 0..9 (null/undefined で通常 click)
 * @returns {number} itemCode
 */
export function clickItemCode(index) {
  if (index == null) return ITEM.CLICK;
  if (!isUByte(index) || index > MAX_SCRIPT_INDEX) {
    throw new Error(t("ble.bot2ScriptIndexRange", { max: MAX_SCRIPT_INDEX }));
  }
  return ITEM.BOT2_ITEM_CODE_RUN_SCRIPT_0 + index;
}

/**
 * Bot2Action → 2B (action 種別, time)。CHSesameBot2.kt:33-35 Bot2Action.toByteArray() と 1:1。
 * @param {{action:number, time:number}} a
 * @returns {Buffer} 2B
 */
export function bot2ActionToBytes(a) {
  if (!a || !BOT_ACTION_VALUES.has(a.action)) throw new Error(t("ble.bot2BadAction"));
  if (!isUByte(a.time)) throw new Error(t("ble.bot2BadActionTime"));
  return Buffer.from([a.action, a.time]);
}

/**
 * スクリプト 1 件を ByteArray に直列化する。CHSesamebot2Event.toByteArray() (CHSesameBot2.kt:71-81) と 1:1:
 *   [nameLength 1B][name 領域 20B (name + 0x00 埋め)][actionLength 1B][action,time ...×actionLength]
 *
 * SDK は result に nameLength → name+ByteArray(20-size) (= 常に 20B) → actionLength → 各 action
 * の順で add する。したがって actionLength は **byte 21** (nameLength 1B + name 領域 20B の直後) に来る。
 * これは fromByteArray が actionLength を buf[21] から読む位置とも一致する。
 *
 * name は 20B を超えると SDK 同様あふれる (SDK は ByteArray(20-name.size) で負長を作り例外になる) ため、
 * ここでは 20B 超を明示エラーにする (SDK の暗黙クラッシュより安全側; 値域は同じ ≤20B)。
 * @param {{name:(Buffer|Uint8Array|string), actions:Array<{action:number,time:number}>}} event
 * @returns {Buffer}
 */
export function scriptToBytes(event) {
  if (!event) throw new Error(t("ble.bot2BadScript"));
  let name;
  if (typeof event.name === "string") name = Buffer.from(event.name, "utf8");
  else if (Buffer.isBuffer(event.name) || event.name instanceof Uint8Array) name = Buffer.from(event.name);
  else throw new Error(t("ble.bot2BadScriptName"));
  if (name.length > SCRIPT_NAME_FIELD_LEN) throw new Error(t("ble.bot2ScriptNameLen", { max: SCRIPT_NAME_FIELD_LEN }));

  const actions = event.actions || [];
  if (!Array.isArray(actions)) throw new Error(t("ble.bot2BadScript"));

  const nameField = Buffer.alloc(SCRIPT_NAME_FIELD_LEN); // 0x00 埋め (SDK の name + ByteArray(20-size))
  name.copy(nameField);
  const actionBytes = actions.map(bot2ActionToBytes);
  // SDK 順: nameLength(1B) ++ name 領域(20B) ++ actionLength(1B) ++ actions。actionLength は byte 21。
  return Buffer.concat([
    Buffer.from([name.length]),
    nameField,
    Buffer.from([actions.length]),
    ...actionBytes,
  ]);
}

/**
 * SCRIPT_CURRENT(95) 応答の parse。CHSesamebot2Event.fromByteArray() (CHSesameBot2.kt:47-68) と 1:1。
 *
 * レイアウト: [nameLength 1B][name 領域 20B][actionLength 1B][action,time ...]。
 *   - cursor=0: nameLength = buf[0]。nameLength < 1 なら null。
 *   - name = buf[1 .. 1+nameLength)。
 *   - cursor を +20 (name 領域は常に 20B) → 21。
 *   - actionLength = buf[21]。0 なら actions 無しで返す。
 *   - actions: SDK は `while (cursor < buf.size-1) { cursor++; action; cursor++; time }`。
 *     cursor=21 から開始するので action 群は buf[22] 以降を 2B ずつ読む。
 *
 * @param {Buffer} buf
 * @returns {{nameLength:number, name:Buffer, actionLength:(number|null), actions:(Array<{action:number,time:number}>|null)}|null}
 */
export function parseCurrentScript(buf) {
  const b = Buffer.from(buf);
  let cursor = 0;
  const nameLength = b[cursor];
  if (nameLength == null || nameLength < 1) return null;
  cursor++;
  const name = b.subarray(cursor, cursor + nameLength);
  cursor += SCRIPT_NAME_FIELD_LEN; // → 21 (name 領域は常に 20B)
  const actionLength = b[cursor];
  if (actionLength === 0) {
    return { nameLength, name, actionLength: null, actions: null };
  }
  const actions = [];
  // SDK 1:1: while (cursor < buf.size - 1) { cursor++; action=buf[cursor]; cursor++; time=buf[cursor] }
  while (cursor < b.length - 1) {
    cursor++;
    const action = b[cursor];
    cursor++;
    const time = b[cursor];
    actions.push({ action, time });
  }
  return { nameLength, name, actionLength, actions };
}

/**
 * SCRIPT_NAME_LIST(96) 応答の parse。CHSesamebot2Status.fromByteArray() (CHSesameBot2.kt:93-109) と 1:1。
 *
 * レイアウト: [curIdx 1B][eventLength 1B] (続けて eventLength 個の name エントリ)。
 *   - curIdx = buf[0]、eventLength = buf[1]。curIdx >= eventLength なら null。
 *   - 各エントリ: nameLength = max(buf[cursor], 1); cursor++; name = buf[cursor .. cursor+nameLength);
 *     cursor += 20 (name 領域は常に 20B)。
 *   - events の action は name/nameLength のみ (本一覧では actions を含まない)。
 *
 * @typedef {{nameLength:number, name:Buffer}} ScriptNameEntry
 * @typedef {{curIdx:number, eventLength:number, events:ScriptNameEntry[]}} ScriptNameList
 */

/**
 * SCRIPT_NAME_LIST(96) 応答の parse。
 * @param {Buffer} buf
 * @returns {ScriptNameList|null}
 */
export function parseScriptNameList(buf) {
  const b = Buffer.from(buf);
  let cursor = 0;
  const curIdx = b[cursor];
  cursor++;
  const eventLength = b[cursor];
  if (curIdx == null || eventLength == null) return null;
  if (curIdx >= eventLength) return null;
  cursor++;
  const events = [];
  for (let i = 0; i < eventLength; i++) {
    const nameLength = Math.max(b[cursor], 1); // SDK maxOf(buf[cursor], 1u)
    cursor++;
    const name = b.subarray(cursor, cursor + nameLength);
    events.push({ nameLength, name });
    cursor += SCRIPT_NAME_FIELD_LEN; // name 領域は常に 20B
  }
  return { curIdx, eventLength, events };
}

/**
 * Bot2/Bot3 スクリプト機能を session に束ねる薄いコマンドクラス。
 *
 * SDK CHSesameBot2Device.kt の各 fun と 1:1 で対応する:
 *   - click(index, tag)        → click(index!=null は RUN_SCRIPT_0+index, null は click(89))
 *   - sendClickScript(idx, ..) → BOT2_ITEM_CODE_EDIT_SCRIPT(181), payload=[idx]+scriptBytes
 *   - selectScript(index)      → SCRIPT_SELECT(94), payload=[index]
 *   - getCurrentScript(index)  → SCRIPT_CURRENT(95), payload=[index] or 空、応答を parseCurrentScript
 *   - getScriptNameList()      → SCRIPT_NAME_LIST(96), payload=空、応答を parseScriptNameList。
 *                                成功時に this.scripts キャッシュを更新 (SDK の scripts プロパティ相当)。
 *
 * click(index) はファサード SesameBle.click(tag) (CLICK 89) と棲み分ける。CLICK は従来通り残し、
 * 本クラスは index 指定 click と script 管理を担う。
 */
export class Bot2Commands {
  /**
   * @param {import("./session.js").SesameBleSession} session login 済み (request が使える) session
   * @param {(tag?: Buffer) => Buffer} [historyTagBLE] 履歴タグ生成器の上書き (省略時は
   *   protocol.historyTagBLE を直接使う)。SDK の click は常に historyTagBLE を payload にする
   *   (CHSesameBot2Device.kt:91-93: sendCommand(..., historyTagBLE(historytag))。tag 無しでも
   *   最低 [0x00,0x0E] の 2B)。旧実装は未注入時に空 payload を送っており SDK と乖離していた (P1-10)。
   */
  constructor(session, historyTagBLE = defaultHistoryTagBLE) {
    this._session = session;
    this._historyTagBLE = historyTagBLE || defaultHistoryTagBLE;
    // SDK の override var scripts (CHSesameBot2Device.kt:40-41 初期値 curIdx=0/eventLength=0/events=[])。
    /** @type {ScriptNameList} */
    this.scripts = { curIdx: 0, eventLength: 0, events: [] };
  }

  /**
   * index 指定 click。CHSesameBot2Device.kt:73-97 と 1:1:
   *   index!=null → itemCode = RUN_SCRIPT_0(170)+index、index==null → click(89)。
   *   payload は **常に** historyTagBLE(tag) (CHSesameBot2Device.kt:91-93。tag 無しでも
   *   最低 [0x00,0x0E] 2B を送る — 空 payload は SDK に存在しない)。
   * @param {number|null} [index] 0..9 (省略で通常 click)
   * @param {Buffer} [tag] 履歴タグ
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  click(index = null, tag) {
    const itemCode = clickItemCode(index);
    return this._session.request(itemCode, this._historyTagBLE(tag));
  }

  /**
   * スクリプトを書き込む。CHSesameBot2Device.kt:99-110 sendClickScript と 1:1:
   *   item = BOT2_ITEM_CODE_EDIT_SCRIPT(181)、payload = [index 1B] + scriptBytes。
   * @param {number} index 書き込み先 index (UByte)
   * @param {{name:(Buffer|Uint8Array|string), actions:Array<{action:number,time:number}>}|Buffer|Uint8Array} script
   *   スクリプト構造体 (scriptToBytes で直列化) もしくは直列化済みバイト列。
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  sendClickScript(index, script) {
    if (!isUByte(index)) throw new Error(t("ble.bot2BadIndex"));
    let scriptBytes;
    if (Buffer.isBuffer(script) || script instanceof Uint8Array) scriptBytes = Buffer.from(script);
    else scriptBytes = scriptToBytes(script);
    const data = Buffer.concat([Buffer.from([index]), scriptBytes]);
    return this._session.request(ITEM.BOT2_ITEM_CODE_EDIT_SCRIPT, data);
  }

  /**
   * アクティブなスクリプトを切り替える。CHSesameBot2Device.kt:112-121 selectScript と 1:1:
   *   item = SCRIPT_SELECT(94)、payload = [index 1B]。
   * @param {number} index UByte
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  selectScript(index) {
    if (!isUByte(index)) throw new Error(t("ble.bot2BadIndex"));
    return this._session.request(ITEM.SCRIPT_SELECT, Buffer.from([index]));
  }

  /**
   * 現在 (または index 指定) のスクリプト内容を取得する。CHSesameBot2Device.kt:123-144 getCurrentScript と 1:1:
   *   item = SCRIPT_CURRENT(95)、payload = index!=null なら [index 1B]、null なら空。
   *   応答 payload を parseCurrentScript で解析する。parse 失敗は明示エラー。
   * @param {number|null} [index] UByte (省略で現在のスクリプト)
   * @returns {Promise<{nameLength:number, name:Buffer, actionLength:(number|null), actions:(Array<{action:number,time:number}>|null)}>}
   */
  async getCurrentScript(index = null) {
    let data = Buffer.alloc(0);
    if (index != null) {
      if (!isUByte(index)) throw new Error(t("ble.bot2BadIndex"));
      data = Buffer.from([index]);
    }
    const res = await this._session.request(ITEM.SCRIPT_CURRENT, data);
    const parsed = parseCurrentScript(res.payload);
    if (parsed == null) throw new Error(t("ble.bot2ScriptParseFailed"));
    return parsed;
  }

  /**
   * 全スクリプトの index/name 一覧を取得する。CHSesameBot2Device.kt:146-193 getScriptNameList と 1:1:
   *   item = SCRIPT_NAME_LIST(96)、payload = 空。応答 payload を parseScriptNameList で解析し、
   *   成功時に this.scripts キャッシュを更新する (SDK の scripts = status 相当)。parse 失敗は明示エラー。
   *
   * 注: SDK は同時呼び出しを inFlight フラグ + pending リストで 1 回の送信にマージするが、
   *   本 session 層は request(itemCode) を itemCode ごとのキューで多重化しており、同一 itemCode の
   *   並行 request はそれぞれ独立の応答待ちになる (SDK のマージは省く)。応答パースとキャッシュ更新は
   *   SDK と 1:1。
   * @returns {Promise<ScriptNameList>}
   */
  async getScriptNameList() {
    const res = await this._session.request(ITEM.SCRIPT_NAME_LIST, Buffer.alloc(0));
    const status = parseScriptNameList(res.payload);
    if (status == null) throw new Error(t("ble.bot2ScriptParseFailed"));
    this.scripts = status; // SDK: scripts = status (CHSesameBot2Device.kt:178)
    return status;
  }
}

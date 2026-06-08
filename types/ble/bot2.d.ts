/**
 * index → click 用 itemCode (RUN_SCRIPT_0 + index)。
 * CHSesameBot2Device.kt:75-80 と 1:1: index 指定時は RUN_SCRIPT_0(170)+index、未指定は click(89)。
 * @param {number|null|undefined} index 0..9 (null/undefined で通常 click)
 * @returns {number} itemCode
 */
export function clickItemCode(index: number | null | undefined): number;
/**
 * Bot2Action → 2B (action 種別, time)。CHSesameBot2.kt:33-35 Bot2Action.toByteArray() と 1:1。
 * @param {{action:number, time:number}} a
 * @returns {Buffer} 2B
 */
export function bot2ActionToBytes(a: {
    action: number;
    time: number;
}): Buffer;
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
export function scriptToBytes(event: {
    name: (Buffer | Uint8Array | string);
    actions: Array<{
        action: number;
        time: number;
    }>;
}): Buffer;
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
export function parseCurrentScript(buf: Buffer): {
    nameLength: number;
    name: Buffer;
    actionLength: (number | null);
    actions: (Array<{
        action: number;
        time: number;
    }> | null);
} | null;
/**
 * SCRIPT_NAME_LIST(96) 応答の parse。CHSesamebot2Status.fromByteArray() (CHSesameBot2.kt:93-109) と 1:1。
 *
 * レイアウト: [curIdx 1B][eventLength 1B] (続けて eventLength 個の name エントリ)。
 *   - curIdx = buf[0]、eventLength = buf[1]。curIdx >= eventLength なら null。
 *   - 各エントリ: nameLength = max(buf[cursor], 1); cursor++; name = buf[cursor .. cursor+nameLength);
 *     cursor += 20 (name 領域は常に 20B)。
 *   - events の action は name/nameLength のみ (本一覧では actions を含まない)。
 *
 * @param {Buffer} buf
 * @returns {{curIdx:number, eventLength:number, events:Array<{nameLength:number, name:Buffer}>}|null}
 */
export function parseScriptNameList(buf: Buffer): {
    curIdx: number;
    eventLength: number;
    events: Array<{
        nameLength: number;
        name: Buffer;
    }>;
} | null;
/**
 * 動作種別 (CHSesameBot2.kt BotActionType と 1:1)。
 * 正転 / 反転 / 停止 (惰性なし) / 睡眠 (惰性あり)。
 */
export const BOT_ACTION_TYPE: Readonly<{
    FORWARD: 0;
    REVERSE: 1;
    STOP: 2;
    SLEEP: 3;
}>;
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
     * @param {(...args:any[])=>void} [historyTagBLE] 履歴タグ生成器 (protocol.historyTagBLE を注入)
     */
    constructor(session: import("./session.js").SesameBleSession, historyTagBLE?: (...args: any[]) => void);
    _session: import("./session.js").SesameBleSession;
    _historyTagBLE: (...args: any[]) => void;
    scripts: {
        curIdx: number;
        eventLength: number;
        events: any[];
    };
    /**
     * index 指定 click。CHSesameBot2Device.kt:73-97 と 1:1:
     *   index!=null → itemCode = RUN_SCRIPT_0(170)+index、index==null → click(89)。
     *   payload は historyTagBLE(tag) (CLICK と同じ履歴タグ)。
     * @param {number|null} [index] 0..9 (省略で通常 click)
     * @param {Buffer} [tag] 履歴タグ
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    click(index?: number | null, tag?: Buffer): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * スクリプトを書き込む。CHSesameBot2Device.kt:99-110 sendClickScript と 1:1:
     *   item = BOT2_ITEM_CODE_EDIT_SCRIPT(181)、payload = [index 1B] + scriptBytes。
     * @param {number} index 書き込み先 index (UByte)
     * @param {{name:(Buffer|Uint8Array|string), actions:Array<{action:number,time:number}>}|Buffer|Uint8Array} script
     *   スクリプト構造体 (scriptToBytes で直列化) もしくは直列化済みバイト列。
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    sendClickScript(index: number, script: {
        name: (Buffer | Uint8Array | string);
        actions: Array<{
            action: number;
            time: number;
        }>;
    } | Buffer | Uint8Array): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * アクティブなスクリプトを切り替える。CHSesameBot2Device.kt:112-121 selectScript と 1:1:
     *   item = SCRIPT_SELECT(94)、payload = [index 1B]。
     * @param {number} index UByte
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    selectScript(index: number): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * 現在 (または index 指定) のスクリプト内容を取得する。CHSesameBot2Device.kt:123-144 getCurrentScript と 1:1:
     *   item = SCRIPT_CURRENT(95)、payload = index!=null なら [index 1B]、null なら空。
     *   応答 payload を parseCurrentScript で解析する。parse 失敗は明示エラー。
     * @param {number|null} [index] UByte (省略で現在のスクリプト)
     * @returns {Promise<{nameLength:number, name:Buffer, actionLength:(number|null), actions:(Array<{action:number,time:number}>|null)}>}
     */
    getCurrentScript(index?: number | null): Promise<{
        nameLength: number;
        name: Buffer;
        actionLength: (number | null);
        actions: (Array<{
            action: number;
            time: number;
        }> | null);
    }>;
    /**
     * 全スクリプトの index/name 一覧を取得する。CHSesameBot2Device.kt:146-193 getScriptNameList と 1:1:
     *   item = SCRIPT_NAME_LIST(96)、payload = 空。応答 payload を parseScriptNameList で解析し、
     *   成功時に this.scripts キャッシュを更新する (SDK の scripts = status 相当)。parse 失敗は明示エラー。
     *
     * 注: SDK は同時呼び出しを inFlight フラグ + pending リストで 1 回の送信にマージするが、
     *   本 session 層は request(itemCode) を itemCode ごとのキューで多重化しており、同一 itemCode の
     *   並行 request はそれぞれ独立の応答待ちになる (SDK のマージは省く)。応答パースとキャッシュ更新は
     *   SDK と 1:1。
     * @returns {Promise<{curIdx:number, eventLength:number, events:Array<{nameLength:number, name:Buffer}>}>}
     */
    getScriptNameList(): Promise<{
        curIdx: number;
        eventLength: number;
        events: Array<{
            nameLength: number;
            name: Buffer;
        }>;
    }>;
}
import { Buffer } from "node:buffer";
//# sourceMappingURL=bot2.d.ts.map
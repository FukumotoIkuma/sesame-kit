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
export function buildAirCommandHex(state: {
    code: number;
    power?: boolean;
    temperature?: number;
    mode?: number;
    fanSpeed?: number;
    windDirection?: number;
    autoSwing?: boolean;
    keyType?: string;
}): string;
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
export function buildNonAirCommandHex({ irType, code, buttonType }: {
    irType: number;
    code: number;
    buttonType: string;
}): string;
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
export function sendIR(client: import("./transport.js").Hub3WsClient, p: {
    deviceId: string;
    command: string;
    irType: number;
    companyID: string;
    irDeviceUUID?: string;
    operation?: string;
    timeoutMs?: number;
}): Promise<object>;
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
export function emitAir(client: import("./transport.js").Hub3WsClient, p: {
    deviceId: string;
    companyID: string;
    code: number;
    irDeviceUUID?: string;
    timeoutMs?: number;
    power?: boolean;
    temperature?: number;
    mode?: number;
    fanSpeed?: number;
    windDirection?: number;
    autoSwing?: boolean;
    keyType?: string;
}): Promise<{
    command: string;
    response: object;
}>;
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
export function emitButton(client: import("./transport.js").Hub3WsClient, p: {
    deviceId: string;
    companyID: string;
    code: number;
    irType: number;
    buttonType: string;
    irDeviceUUID?: string;
    timeoutMs?: number;
}): Promise<{
    command: string;
    response: object;
}>;
/**
 * irType (remote.type) の確定値。
 * 一次資料: presetIR.json extraLogic C / HXDParametersSwapper.getKeyByDeviceType:166-180。
 * @readonly
 */
export const IR_TYPE: Readonly<{
    AIR: 49152;
    FAN: 32768;
    LIGHT: 57344;
    TV: 8192;
}>;
/**
 * HXD プリセット command の組み立て器。
 * biz3 HXDCommandProcessor.js を 1:1 移植 (constructor 既定値・byte 配置・checksum 完全一致)。
 */
export class HXDCommandProcessor {
    power: number;
    temperature: number;
    fanSpeed: number;
    windDirection: number;
    autoWindDirection: number;
    mode: number;
    key: number;
    code: number;
    defaultTable: number[];
    AirPrefixCode: number[];
    commonPrefixCode: number[];
    /**
     * エアコン command (16 byte) を生成。
     * vendor: HXDCommandProcessor.js:17-34。
     * 配置: [0x30,0x01, codeHi,codeLo, temp,fanSpeed,windDir,autoWind,power,key,mode, 1,0,0, 0xff, checksum]
     * @returns {number[]} 16 byte の配列
     */
    buildAirCommand(): number[];
    /**
     * 非エアコン (TV/ライト/扇風機) command (16 byte) を生成。
     * vendor: HXDCommandProcessor.js:36-47。
     * 配置: [0x30,0x00, codeHi,codeLo, 0,0,0,0,0, key, 0, 1,0,0, 0xff, checksum]
     * @returns {number[]} 16 byte の配列
     */
    buildNonAirCommand(): number[];
    /**
     * command の骨格 (16 byte) を生成。Air/NonAir 共通。
     * vendor: HXDCommandProcessor.js:49-71。
     * @param {number[]} prefixCodeArray 2 byte prefix ([0x30,0x01] か [0x30,0x00])
     * @param {number} code  remote.code (16bit, ビッグエンディアンで 2 byte に分割)
     * @param {number[]} table  既定 [0,0,0] (table[0]+1 が buf[11] に入る)
     * @returns {number[]} 16 byte
     */
    buildKeyData(prefixCodeArray: number[], code: number, table: number[]): number[];
    /**
     * 数値を 16bit ビッグエンディアンの 2 byte に分割。
     * vendor: HXDCommandProcessor.js:73-77。
     * @param {number} number
     * @returns {[number, number]} [上位 byte, 下位 byte]
     */
    decimalToTwoHexInts(number: number): [number, number];
    /**
     * byte 配列を大文字 HEX 文字列に変換 (区切り無し・各 byte 2 桁 0 埋め)。
     * これが sendIR の command フィールドに入る文字列。
     * vendor: HXDCommandProcessor.js:132-134。
     * @param {number[]} byteArray
     * @returns {string} 例 "30010000..."
     */
    toHexString(byteArray: number[]): string;
    /**
     * HEX 文字列を byte 配列に戻す。
     * vendor: HXDCommandProcessor.js:124-130。
     * @param {string} hexString
     * @returns {number[]}
     */
    hexStringToByteArray(hexString: string): number[];
    /**
     * 保存済みエアコン command HEX から状態を復元 (発射には不要・state 復元用)。
     * vendor: HXDCommandProcessor.js:84-117。
     * 前提: length>=22, bytes[0]===0x30 && bytes[1]===0x01。不正時は null。
     * @param {string} hexString
     * @returns {{temperature:number,fanSpeed:number,windDirection:number,autoWindDirection:number,power:number,key:number,mode:number}|null}
     */
    parseAirCommand(hexString: string): {
        temperature: number;
        fanSpeed: number;
        windDirection: number;
        autoWindDirection: number;
        power: number;
        key: number;
        mode: number;
    } | null;
    /** @param {number} power */
    setPower(power: number): this;
    /** @param {number} temperature */
    setTemperature(temperature: number): this;
    /** @param {number} model */
    setModel(model: number): this;
    /** @param {number} fanSpeed */
    setFanSpeed(fanSpeed: number): this;
    /** @param {number} windDirection */
    setWindDirection(windDirection: number): this;
    /** @param {number} autoWindDirection */
    setAutoWindDirection(autoWindDirection: number): this;
    /** @param {number} key */
    setKey(key: number): this;
    /** @param {number} code */
    setCode(code: number): this;
}
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
    getAirKey(type?: string): number;
    /**
     * mode index → HXD 値 (vendor:45-54)。{0:自動,1:制冷,2:除湿,3:送風,4:制熱}
     * @param {number} index @returns {number}
     */
    getModeValue(index: number): number;
    /**
     * fanSpeed index → HXD 値 (vendor:67-75)。{0:自動,1:低,2:中,3:高}
     * @param {number} index @returns {number}
     */
    getFanSpeedValue(index: number): number;
    /**
     * windDirection index → HXD 値 (vendor:87-94)。{0:上,1:中,2:下}。default 0x02。
     * @param {number} index @returns {number}
     */
    getWindDirectionValue(index: number): number;
    /**
     * ライト key (vendor:114-125)。
     * @param {string} type @returns {number}
     */
    getLightKey(type: string): number;
    /**
     * TV key (vendor:128-147)。
     * @param {string} type @returns {number}
     */
    getTVKey(type: string): number;
    /**
     * 扇風機 key (vendor:150-162)。
     * @param {string} type @returns {number}
     */
    getFanKey(type: string): number;
    /**
     * device type (irType) 別に key を引く (非エアコン UI 経由)。
     * vendor: HXDParametersSwapper.js:166-180。
     * 未知 type は warn を出さず default 0x01 (CLI なので console.warn は省略)。
     * @param {number} irType  IR_TYPE のいずれか
     * @param {string} type    ボタン種別文字列
     * @returns {number}
     */
    getKeyByDeviceType(irType: number, type: string): number;
}
/**
 * namespace (hub.presetir.*) に露出する client op の allowlist。
 * HXDCommandProcessor / HXDParametersSwapper (class) と buildAirCommandHex /
 * buildNonAirCommandHex (client を取らない純ビルダ) は namespace に出さない
 * (client.js _bindNs が ws を第1引数に注入して壊れるため)。これらは低レベル
 * ユーティリティとして index.js の presetir namespace から直接 import して使う。
 */
export const NAMESPACE_OPS: string[];
//# sourceMappingURL=presetir.d.ts.map
/**
 * OS2 の sessionToken (8B) = mAppToken(4B) ++ mSesameToken(4B)。
 * (CHSesame2Device.kt:237 / CHSesameBotDevice.kt:439)
 *
 * mSesameToken は initial publish payload の全長をそのまま渡すこと (_handleInitial で確認済み)。
 * 実ファームウェアは必ず 4B を送る (CHSesame2Device.kt:519 で切り詰めなく格納)。
 * 4B 以外が来た場合はここで明示エラーを出す (session.js _handleInitial が先に reject する)。
 *
 * @param {Buffer} mAppToken 4B (アプリ側ランダム、CHSesameOS2.kt:17 generateRandomData(4))
 * @param {Buffer} mSesameToken 4B (initial publish payload の全長: CHSesame2Device.kt:519 参照)
 * @returns {Buffer} 8B
 */
export function sessionToken(mAppToken: Buffer, mSesameToken: Buffer): Buffer;
/**
 * OS2 login の sessionKey (16B) を ECDH 共有秘密の先頭 16B から導出する。
 *   sessionKey = AES-128-CMAC(ecdhSecretPre16, sessionToken8)
 *   (CHSesame2Device.kt:246-248 / CHSesameBotDevice.kt:448-450 / CHSesameBikeDevice.kt:339-341)
 * @param {Buffer} ecdhSecretPre16 ECDH 共有秘密の先頭 16B (crypto.js:ecdhSecretPre16 の戻り)
 * @param {Buffer} sessionToken8 8B (sessionToken() の戻り)
 * @returns {Buffer} 16B
 */
export function deriveSessionKey(ecdhSecretPre16: Buffer, sessionToken8: Buffer): Buffer;
/**
 * OS2 login の sessionAuth (16B) をローカル secretKey から計算する (isNeedAuthFromServer=false 経路)。
 *   signPayload = userIdx ++ appPublicKey64 ++ sessionToken8
 *   sessionAuth = AES-128-CMAC(secretKey, signPayload)
 *   (CHSesame2Device.kt:238-243 / CHSesameBotDevice.kt:441-447 / CHSesameBikeDevice.kt:333-338)
 * サーバ認証 (isNeedAuthFromServer=true) の場合はサーバ署名 token を使うため呼ばない
 * (CHSesame2Device.kt:240-242)。
 * @param {Buffer} secretKey 16B (sesame2KeyData.secretKey)
 * @param {Buffer} userIdx keyIndex のバイト列 (sesame2KeyData.keyIndex)
 * @param {Buffer} appPublicKey64 アプリ ECDH 生公開鍵 64B (X‖Y, prefix 無し)
 * @param {Buffer} sessionToken8 8B
 * @returns {Buffer} 16B (loginPayload では先頭 4B のみ使用)
 */
export function sessionAuth(secretKey: Buffer, userIdx: Buffer, appPublicKey64: Buffer, sessionToken8: Buffer): Buffer;
/**
 * OS2 login コマンドの平文 data を組み立てる。
 *   data = userIdx ++ appPublicKey64 ++ mAppToken4 ++ sessionAuth[0:4]
 *   (CHSesame2Device.kt:252 / CHSesameBotDevice.kt:451 / CHSesameBikeDevice.kt:342)
 * これを buildSendFrame(OP.SYNC, ITEM.LOGIN, data) でフレーム化し PLAINTEXT 送出する
 * (CHSesame2Device.kt:254-255: SSM2OpCode.sync, SesameItemCode.login, DeviceSegmentType.plain)。
 * @param {Buffer} userIdx
 * @param {Buffer} appPublicKey64 64B
 * @param {Buffer} mAppToken4 4B
 * @param {Buffer} sessionAuth16 sessionAuth() の戻り (先頭 4B のみ使用)
 * @returns {Buffer}
 */
export function loginPayload(userIdx: Buffer, appPublicKey64: Buffer, mAppToken4: Buffer, sessionAuth16: Buffer): Buffer;
/**
 * OS2 登録ハンドシェイクの鍵束を ECDH 共有秘密とトークンから導出する。
 *   sessionToken = serverToken ++ mSesameToken          (CHSesame2Device.kt:451)
 *   registerKey  = CMAC(ecdhSecretPre16, sessionToken)  (CHSesame2Device.kt:452)
 *   ownerKey     = CMAC(registerKey, "owner_key")       (CHSesame2Device.kt:453)
 *   sessionKey   = CMAC(registerKey, sessionToken)      (CHSesame2Device.kt:454)
 * sessionKey/sessionToken で cipher を確立し (os2/cipher.js)、REGISTRATION 応答以降を暗号化する。
 * ownerKey は登録完了後に保存する device の鍵 (CHSesame2Device.kt:462-471 CHDevice の owner_key)。
 *
 * 注: registration の sessionToken は **serverToken(4B) ++ mSesameToken(4B) = 8B 固定** である。
 * serverToken は CHServerAuth.kt:54 の `val serverToken = ByteArray(4)` が示すとおり常に 4B。
 * したがって sessionToken = 4B + 4B = 8B となり、login 経路の sessionToken
 * (mAppToken4 ++ mSesameToken4 = 8B) と同じ長さになる。
 * cipher.js の SesameOS2BleCipher コンストラクタが要求する 8B 検証は登録・ログイン両経路で満たされる。
 * SesameOS2BleCipher.kt:7 はコンストラクタで長さ検証をしていないが、CCM nonce = counter5B ++ token
 * の制約(nonce 上限 13B)から token ≤ 8B が必要であり、4B+4B=8B は最大値を使い切る正準形である。
 *
 * @param {Buffer} ecdhSecretPre16 16B
 * @param {Buffer} serverToken サーバが返すトークン (registerSesame1.st)
 * @param {Buffer} mSesameToken 4B (initial publish のトークン)
 * @returns {{registerKey:Buffer, ownerKey:Buffer, sessionKey:Buffer, sessionToken:Buffer}}
 */
export function deriveRegisterKeys(ecdhSecretPre16: Buffer, serverToken: Buffer, mSesameToken: Buffer): {
    registerKey: Buffer;
    ownerKey: Buffer;
    sessionKey: Buffer;
    sessionToken: Buffer;
};
/**
 * OS2 REGISTRATION コマンドの平文 data を組み立てる。
 *   payload = sig1[0:4] ++ appPublicKey64 ++ serverToken   (CHSesame2Device.kt:447)
 * buildSendFrame(OP.CREATE, ITEM.REGISTRATION, payload) で PLAINTEXT 送出
 * (CHSesame2Device.kt:449,458: SSM2OpCode.create, registration, DeviceSegmentType.plain)。
 * @param {Buffer} sig1 サーバ署名 (registerSesame1.sig1)。先頭 4B のみ使用。
 * @param {Buffer} appPublicKey64 64B
 * @param {Buffer} serverToken サーバトークン (registerSesame1.st)
 * @returns {Buffer}
 */
export function registrationData(sig1: Buffer, appPublicKey64: Buffer, serverToken: Buffer): Buffer;
/**
 * OS2 送信フレーム = [op_code, item_code] ++ data。
 * SDK SSM2Payload.toDataWithHeader() (CHSesameOS2.kt:29-31) を 1:1 で移植。
 * ★OS3 との最大の差: OS2 は op_code をフレーム先頭に **含める**。
 * @param {number} opCode OP.* (sync/create/read/update/async など)
 * @param {number} itemCode ITEM.*
 * @param {Buffer} [data]
 * @returns {Buffer}
 */
export function buildSendFrame(opCode: number, itemCode: number, data?: Buffer): Buffer;
/**
 * 受信フレーム (復号後 or 平文) を分解。
 * SesameNotifypayload (notifyOpCode=buf[0], payload=buf[1:]) → SSM2ResponsePayload / SSM3PublishPayload。
 *   notify[0]      = notifyOpCode (response=7 / publish=8)
 *   response body  = [cmdItemCode, cmdOpCode, cmdResultCode, ...payload]   (SesameProtocols.kt:15-19)
 *   publish  body  = [cmdItemCode, ...payload]                             (SesameProtocols.kt:5-8)
 * 親 OS3 protocol.parseRecvFrame は op+item の 2B ヘッダだったが、OS2 は notify 種別で構造が
 * 変わる (response は 3B ヘッダ、publish は 1B ヘッダ) ため OS2 専用に分解する。
 * ★response は **itemCode が先頭** (cmdItCode=data[0], cmdOPCode=data[1])。送信フレーム
 *   (toDataWithHeader = [opCode, itemCode]) とは順序が逆である点に注意。
 *
 * @param {Buffer} buf notify ペイロード全体 (SesameNotifypayload 入力)
 * @returns {{notifyOpCode:number} & ({type:"response", cmdOpCode:number, itemCode:number,
 *            resultCode:number, payload:Buffer} | {type:"publish", itemCode:number, payload:Buffer}
 *            | {type:"other", body:Buffer})}
 */
export function parseRecvFrame(buf: Buffer): {
    notifyOpCode: number;
} & ({
    type: "response";
    cmdOpCode: number;
    itemCode: number;
    resultCode: number;
    payload: Buffer;
} | {
    type: "publish";
    itemCode: number;
    payload: Buffer;
} | {
    type: "other";
    body: Buffer;
});
/**
 * SDK の createHistag(histag) (CHDBModel.kt:18-23) を 1:1 で移植する。
 *   limitedHistag = histag.take(21)                       // 先頭 21B に切り詰め
 *   padding       = 22 - limitedHistag.size - 1           // 全長 22B に 0 埋め
 *   結果          = [size:1B] ++ limitedHistag ++ 0*padding  // 常に 22B
 * tag 省略 (null) 時は size=0、本体 0B、padding=21 → [0x00] ++ 0*21 = 22B の全 0。
 *
 * ★OS2 の **履歴タグを伴うコマンドはすべてこの 22B 構造を送る**:
 *   - lock/unlock      : CHSesame2Device.kt:185,201 (data = createHistag(historytag))
 *   - Bot lock/unlock/click : CHSesameBotDevice.kt:370,387,408
 *   - Bike unlock      : CHSesameBikeDevice.kt:311
 *   - autolock         : CHSesame2Device.kt:141 (2B LE 秒数 ++ createHistag)
 *   - configureLockPosition / Bot updateSetting : CHSesame2Device.kt:557 / CHSesameBotDevice.kt:421-422
 *   タグ無しでも全 0 の 22B を送る (実機は先頭 1B を長さとしてパースするため、生バイト透過や
 *   0B 送信はフォーマット不正になる)。
 * @param {Buffer|Uint8Array|null} [tag] 履歴タグ (バイト列)。省略/null 時は全 0 の 22B。
 * @returns {Buffer} 常に 22B
 */
export function createHistag(tag?: Buffer | Uint8Array | null): Buffer;
/**
 * SESAME2/3/4 の施錠/解錠角設定ペイロードを生成する (CHSesameLockPositionConfiguration:635-645)。
 *
 * SDK は度数 (lockTarget/unlockTarget) を内部単位へ変換する:
 *   tick = (deg * 1024 / 360).toShort()  (CHSesame2Device.kt:557 — Int 演算後に Short へ)
 * その tick から ±150 の range を作り、すべて Short の LE 2B (toReverseBytes、DataExtention.kt:108-112) で連結:
 *   payload = lock ++ unlock ++ lockMin ++ lockMax ++ unlockMin ++ unlockMax   (各 2B LE、計 12B)
 *   lockMin/Max   = lock   ∓150 / ±150
 *   unlockMin/Max = unlock ∓150 / ±150   (toPayload:642-643)
 *
 * range の加減算 (lock-150 等) は SDK 同様 16bit でラップする (Short 演算) ため writeInt16LE で
 * 切り詰める。configureLockPosition の送信 data はこの 12B に createHistag(null) を連結する
 * (CHSesame2Device.kt:557)。
 *
 * @param {number} lockDeg   施錠角 (度、SDK 引数 lockTarget: Short)
 * @param {number} unlockDeg 解錠角 (度、SDK 引数 unlockTarget: Short)
 * @returns {Buffer} 12B (lock/unlock/lockMin/lockMax/unlockMin/unlockMax の LE Short 列)
 */
export function lockPositionConfiguration(lockDeg: number, unlockDeg: number): Buffer;
/**
 * SESAME2/3/4 configureLockPosition の送信 data を組み立てる (CHSesame2Device.kt:556-558)。
 *   payload = lockPositionConfiguration(...) ++ createHistag(null)   (12B ++ 22B = 34B)
 * buildSendFrame(OP.UPDATE, ITEM.MECH_SETTING, ...) で送る (item=80)。
 * @param {number} lockDeg   施錠角 (度)
 * @param {number} unlockDeg 解錠角 (度)
 * @returns {Buffer} 34B
 */
export function lockPositionData(lockDeg: number, unlockDeg: number): Buffer;
/**
 * @typedef {object} BotMechSetting 初代 SESAME Bot の mech_setting フィールド (各値 -128..255 の 1B)。
 * @property {number} userPrefDir
 * @property {number} lockSec
 * @property {number} unlockSec
 * @property {number} clickLockSec
 * @property {number} clickHoldSec
 * @property {number} clickUnlockSec
 * @property {number} buttonMode
 */
/**
 * 初代 SESAME Bot の mech_setting ペイロードを生成する (CHSesameBotMechSettings.data(), CHSesameBot.kt:17-20)。
 *   data = [userPrefDir, lockSec, unlockSec, clickLockSec, clickHoldSec, clickUnlockSec, buttonMode]
 *          ++ [0,0,0,0,0]   // 5B の予約 0 埋め (計 12B)
 * 各値は符号付き Byte (-128..127) として 1B で書く (Kotlin Byte)。
 * @param {BotMechSetting} setting
 * @returns {Buffer} 12B
 */
export function botMechSettingData(setting: BotMechSetting): Buffer;
/**
 * 初代 SESAME Bot updateSetting の送信 data を組み立てる (CHSesameBotDevice.kt:418-422)。
 *   data = setting.data() ++ createHistag(historyTag)   (12B ++ 22B = 34B)
 * buildSendFrame(OP.UPDATE, ITEM.MECH_SETTING, ...) で送る (item=80)。
 * @param {BotMechSetting} setting botMechSettingData の引数
 * @param {Buffer|Uint8Array} [tag] 履歴タグ
 * @returns {Buffer} 34B
 */
export function botUpdateSettingData(setting: BotMechSetting, tag?: Buffer | Uint8Array): Buffer;
/**
 * BLE DFU (ファームウェア更新) 開始コマンドの data。
 * SDK updateFirmware は enableDFU(7) に "01" (1B) を送る (CHSesame2Device.kt:580-599)。
 * 登録済み (login 済み) なら暗号化、未登録なら平文で送る。本実装は **開始コマンド送信まで**を
 * 担い、本体ファーム転送 (Nordic DFU 等の OTA バイナリ転送) は別 GATT サービスを扱う外部 DFU 層の責務。
 * @returns {Buffer} 1B (0x01)
 */
export function enableDfuData(): Buffer;
/**
 * autolock の data = 2B LE 秒数 (delay.toShort().toReverseBytes()) ++ createHistag(tag) = 24B。
 * (CHSesame2Device.kt:141: SSM2OpCode.update, autolock, delay.toShort().toReverseBytes() ++ createHistag(historytag))
 * 0 で無効化 (disableAutolock = enableAutolock(0), CHSesame2Device.kt:150-152)。
 * @param {number} seconds 0..65535
 * @param {Buffer|Uint8Array} [tag] 履歴タグ
 * @returns {Buffer} 24B (2B LE 秒数 ++ 22B createHistag)
 */
export function autolockData(seconds: number, tag?: Buffer | Uint8Array): Buffer;
/**
 * OS2 の mech_status を解析する。
 *
 * SESAME2/3/4 (CHSesame2MechStatus, open/devices/CHSesame2.kt:31-40) — 8B mech_status_t
 * (CHSesame2Device.kt:631 mech_status_t = [20..27]):
 *   data[0..1]: 電池電圧 ADC 生値 (LE)
 *   data[2..3]: target   (i16 LE、Short.MIN_VALUE=-32768 は「未設定」→ null。CHSesame2.kt:34)
 *   data[4..5]: position (i16 LE)
 *   data[6]   : retCode (0 以外は履歴読み出しトリガ。CHSesame2.kt:35 / CHSesame2Device.kt:545)
 *   data[7]   : flags  (bit1=2 isInLockRange / bit2=4 isInUnlockRange / bit5=32 isBatteryCritical。
 *                       CHSesame2.kt:37-40: flags and 2 / and 4 / and 32)
 *
 * Bot/Bike (CHSesameBotMechStatus, open/devices/CHSesameBot.kt:22-29) も同じ 8B レイアウトで、
 * Bot 固有に motorStatus = data[4] (noPower=0/forward=1/hold=2/backward=3) を持つ
 * (CHSesameBot.kt:23 / CHSesameBotDevice.kt:286-293 の isStop 判定)。
 * flags は同じく data[7] (CHSesameBot.kt:24-28)。
 *
 * ★retCode=data[6] / flags=data[7] の順 (CHSesame2.kt:35-37)。旧実装はこれを逆 (flags=buf[6])
 *   に読んでおり、施錠/解錠判定・電池警告・履歴トリガが全機種で誤値だった (BLE2-02)。
 *
 * 施錠/解錠/中間は isInLockRange / isInUnlockRange の 2 ビットで判定する
 * (CHSesame2Device.kt:551 / CHSesameBikeDevice.kt:299: lock / unlock / else=moved)。
 *
 * kind 3 値化 (P4-2):
 *   - kind="os2bot"  : Bot1 固有意味論 (P3-24 / R2:BLE2-15)。
 *       state は 2 値のみ: isInLockRange → LOCKED、else → UNLOCKED (MOVED は出ない)。
 *       出典: CHSesameBotDevice.kt:303 / :346 —
 *         `deviceStatus = if (isInLockRange) CHDeviceStatus.Locked else CHDeviceStatus.Unlocked`
 *       isStop は motorStatus 由来で上書き計算される (CHSesameBotDevice.kt:286-293 / :334-344):
 *         motorStatus 0 (noPower) → true
 *         motorStatus 1 (forward)  → false
 *         motorStatus 2 (hold)     → true
 *         motorStatus 3 (backward) → false
 *         else                     → false
 *       (CHSesameBot.kt:28 の flags-based isStop はクラス初期値であり、
 *        CHSesameBotDevice.kt:286-293 の when ブロックで必ず上書きされる)
 *   - kind="os2bike" : Bike1 固有。isStop は flags bit0 由来 (CHSesameBotMechStatus と同クラス利用。
 *       出典: CHSesameBot.kt:28 `isStop: Boolean? = (flags and 1 == 0)` /
 *             CHSesameBikeDevice.kt:296 Bike1 は CHSesameBotMechStatus を使う)。
 *   - 既定 (os2lock / kind 未指定) : Sesame2/3/4。**isStop = null**。
 *       出典: CHSesame2.kt:40 `override var isStop: Boolean? = null` — SDK が明示的に null。
 *       flags bit0 の意味論は一次資料がないため null で公開するのが 1:1 移植として正しい。
 *
 * @param {Buffer} buf mech_status_t (8B。Kotlin は data[7] まで読む固定レイアウト)
 * @param {{kind?: string}} [opts] オプション。kind="os2bot"/"os2bike" で固有意味論を適用。
 * @returns {{state:string, isInLockRange:boolean, isInUnlockRange:boolean, isBatteryCritical:boolean,
 *            target:number|null, position:number|null, targetDeg:number|null, positionDeg:number,
 *            batteryRaw:number, retCode:number, flags:number, motorStatus:number, isStop:boolean|null}}
 */
export function parseMechStatus(buf: Buffer, { kind }?: {
    kind?: string;
}): {
    state: string;
    isInLockRange: boolean;
    isInUnlockRange: boolean;
    isBatteryCritical: boolean;
    target: number | null;
    position: number | null;
    targetDeg: number | null;
    positionDeg: number;
    batteryRaw: number;
    retCode: number;
    flags: number;
    motorStatus: number;
    isStop: boolean | null;
};
/**
 * OS2 の mech_setting (12B) を SESAME2/3/4 として解析する (BLE2-07)。
 * CHSesame2MechSettings (open/devices/CHSesame2.kt:24-28) を 1:1 で移植:
 *   lockPosition   = (bytesToShort(data[0], data[1]).toInt() * 360 / 1024).toShort()   — 度数
 *   unlockPosition = (bytesToShort(data[2], data[3]).toInt() * 360 / 1024).toShort()   — 度数
 *   isConfigured   = (lockPosition != unlockPosition)
 * bytesToShort は符号付き LE (DataExtention.kt:99-102)。raw (エンコーダ生値) も併記する。
 * @param {Buffer} buf mech_setting_t (4B 以上。login 応答では 12B が来る)
 * @returns {{lockPosition:number, unlockPosition:number, isConfigured:boolean,
 *            lockPositionRaw:number, unlockPositionRaw:number}}
 */
export function parseMechSettingSesame2(buf: Buffer): {
    lockPosition: number;
    unlockPosition: number;
    isConfigured: boolean;
    lockPositionRaw: number;
    unlockPositionRaw: number;
};
/**
 * OS2 の mech_setting (12B) を初代 SESAME Bot として解析する (BLE2-07)。
 * SSMBotLoginResponsePayload (CHSesameBikeDevice.kt:520) は mech_setting_t[0..6] の 7 バイトを
 * そのまま CHSesameBotMechSettings の 7 フィールド (CHSesameBot.kt:17 — すべて Kotlin Byte =
 * 符号付き 1B) に渡す。残り 5B は予約 0 埋め (CHSesameBot.kt:19 data() の対称)。
 * @param {Buffer} buf mech_setting_t (7B 以上)
 * @returns {{userPrefDir:number, lockSec:number, unlockSec:number, clickLockSec:number,
 *            clickHoldSec:number, clickUnlockSec:number, buttonMode:number}}
 */
export function parseMechSettingBot(buf: Buffer): {
    userPrefDir: number;
    lockSec: number;
    unlockSec: number;
    clickLockSec: number;
    clickHoldSec: number;
    clickUnlockSec: number;
    buttonMode: number;
};
/**
 * OS2 login 応答ペイロードを解析する。
 * SSM2LoginResponsePayload (CHSesame2Device.kt:626-634) / SSMBotLoginResponsePayload
 * (CHSesameBikeDevice.kt:513-521) を 1:1 で移植。
 *   payload[0..3] : systemTime (toBigLong = reversedArray を hex parse → **little-endian** u32。
 *                   DataExtention.kt:69-71。旧実装の readUInt32BE は逆読みで、時刻差判定が常に
 *                   発火する誤りだった)
 *   payload[4]    : fw_version
 *   payload[6]    : historyCnt
 *   payload[8..19]: mech_setting_t (12B)
 *   payload[20..27]: mech_status_t (8B、Sesame2)。Bot/Bike も同レイアウトを使用。
 *
 * mech_setting は機種でクラスが分かれる (BLE2-07):
 *   - Sesame2/3/4: CHSesame2MechSettings (CHSesame2.kt:24-28) → mechSetting
 *   - Bot1       : CHSesameBotMechSettings の 7 フィールド (CHSesameBikeDevice.kt:520) → mechSettingBot
 * 呼び出し側は機種に応じてどちらかを読む (両方とも常に解析して返す。生バイトは mechSettingBytes)。
 * isConfigured は Sesame2 形の判定 (lock != unlock) をトップレベルへ併記する
 * (CHSesame2Device.kt:268 の NoSettings 判定に対応)。
 *
 * @param {Buffer} payload login response の payload (resultCode は含まない)
 * @param {{kind?: string}} [opts] オプション。parseMechStatus へ転送 (Bot1 固有意味論に使用。P3-24)。
 * @returns {{systemTime:number, fwVersion:number, historyCnt:number,
 *            mechSetting:ReturnType<typeof parseMechSettingSesame2>,
 *            mechSettingBot:ReturnType<typeof parseMechSettingBot>,
 *            mechSettingBytes:Buffer, isConfigured:boolean, mechStatus:object}}
 */
export function parseLoginResponse(payload: Buffer, opts?: {
    kind?: string;
}): {
    systemTime: number;
    fwVersion: number;
    historyCnt: number;
    mechSetting: ReturnType<typeof parseMechSettingSesame2>;
    mechSettingBot: ReturnType<typeof parseMechSettingBot>;
    mechSettingBytes: Buffer;
    isConfigured: boolean;
    mechStatus: object;
};
/**
 * timePhone (時刻同期) コマンドの data = currentTimeMillis().toUInt32ByteArray() (4B LE)。
 * login 後に時刻差が大きい場合に送る (CHSesame2Device.kt:263 / CHSesameBotDevice.kt:280,466)。
 *
 * ★SDK の toUInt32ByteArray() (DataExtention.kt:138-147) は **ms を 1000 で割って秒値**にし、
 *   その下位 32bit を LE 4B にする (固定 ms=1605929466482 → 秒 1605929466 → "fa89b85f")。
 *   ms をそのまま使わない点に注意 (login response の systemTime も同じく「秒」)。
 *   この変換は親 protocol.js:registrationTimestampBytes が唯一の実装なので委譲する
 *   (toUInt32ByteArray の実装が分散して仕様がズレるのを防ぐ)。
 * @param {number} [nowMs=Date.now()]
 * @returns {Buffer} 4B LE (秒値の下位 32bit)
 */
export function timePhoneData(nowMs?: number): Buffer;
/**
 * item_code (OS2/OS3 共通の正準ソース = itemcodes.js)。
 *
 * OS2 専用コード IRER(15) / TIMEPHONE(16) も itemcodes.js に昇格済みなので、ここは
 * ITEM_CODES をそのまま参照する (二重定義を避ける)。
 *   - IRER = 15      : 登録時の IR/ER 読み出し (SesameProtocols.kt:34)。
 *   - TIMEPHONE = 16 : login 後の時刻同期コマンド (SesameProtocols.kt:34、SesameItemCode.timePhone)。
 *     ★OS2 の時刻同期は TIME(8) ではなく timePhone(16)。CHSesame2Device.kt:263 は
 *       SesameItemCode.timePhone を使う (TIME(8) と混同しないこと)。
 */
export const ITEM: Readonly<{
    NONE: 0;
    REGISTRATION: 1;
    LOGIN: 2;
    USER: 3;
    HISTORY: 4;
    VERSION_TAG: 5;
    DISCONNECT_REBOOT_NOW: 6;
    ENABLE_DFU: 7;
    TIME: 8;
    BLE_CONNECTION_PARAM: 9;
    BLE_ADV_PARAM: 10;
    AUTOLOCK: 11;
    SERVER_ADV_KICK: 12;
    SSMTOKEN: 13;
    INITIAL: 14;
    IRER: 15;
    TIMEPHONE: 16;
    MAGNET: 17;
    HISTORY_DELETE: 18;
    SENSOR_INTERVAL: 19;
    SENSOR_INTERVAL_GET: 20;
    MECH_SETTING: 80;
    MECH_STATUS: 81;
    LOCK: 82;
    UNLOCK: 83;
    MOVE_TO: 84;
    DRIVE_DIRECTION: 85;
    STOP: 86;
    DETECT_DIR: 87;
    TOGGLE: 88;
    CLICK: 89;
    DOOR_OPEN: 90;
    DOOR_CLOSE: 91;
    OPS_CONTROL: 92;
    SCRIPT_SETTING: 93;
    SCRIPT_SELECT: 94;
    SCRIPT_CURRENT: 95;
    SCRIPT_NAME_LIST: 96;
    BOT2_ITEM_CODE_RUN_SCRIPT_0: 170;
    BOT2_ITEM_CODE_RUN_SCRIPT_1: 171;
    BOT2_ITEM_CODE_RUN_SCRIPT_2: 172;
    BOT2_ITEM_CODE_RUN_SCRIPT_3: 173;
    BOT2_ITEM_CODE_RUN_SCRIPT_4: 174;
    BOT2_ITEM_CODE_RUN_SCRIPT_5: 175;
    BOT2_ITEM_CODE_RUN_SCRIPT_6: 176;
    BOT2_ITEM_CODE_RUN_SCRIPT_7: 177;
    BOT2_ITEM_CODE_RUN_SCRIPT_8: 178;
    BOT2_ITEM_CODE_RUN_SCRIPT_9: 179;
    ADD_HUB3: 180;
    BOT2_ITEM_CODE_EDIT_SCRIPT: 181;
    STP_ITEM_CODE_CARDS_ADD: 182;
    STP_ITEM_CODE_DEVICE_STATUS: 183;
    CARD_CHANGE: 107;
    CARD_DELETE: 108;
    CARD_GET: 109;
    CARD_NOTIFY: 110;
    CARD_LAST: 111;
    CARD_FIRST: 112;
    CARD_MODE_GET: 113;
    CARD_MODE_SET: 114;
    CARD_CHANGE_VALUE: 139;
    CARD_ADD: 140;
    CARD_MOVE: 141;
    FINGERPRINT_CHANGE: 115;
    FINGERPRINT_DELETE: 116;
    FINGERPRINT_GET: 117;
    FINGERPRINT_NOTIFY: 118;
    FINGERPRINT_LAST: 119;
    FINGERPRINT_FIRST: 120;
    FINGERPRINT_MODE_GET: 121;
    FINGERPRINT_MODE_SET: 122;
    PASSCODE_CHANGE: 123;
    PASSCODE_DELETE: 124;
    PASSCODE_GET: 125;
    PASSCODE_NOTIFY: 126;
    PASSCODE_LAST: 127;
    PASSCODE_FIRST: 128;
    PASSCODE_MODE_GET: 129;
    PASSCODE_MODE_SET: 130;
    PASSCODE_ADD: 138;
    PASSCODE_MOVE: 142;
    SSM_OS3_IR_MODE_SET: 143;
    SSM_OS3_IR_CODE_CHANGE: 144;
    SSM_OS3_IR_CODE_EMIT: 145;
    SSM_OS3_IR_CODE_GET: 146;
    SSM_OS3_IR_CODE_LAST: 147;
    SSM_OS3_IR_CODE_FIRST: 148;
    SSM_OS3_IR_CODE_DELETE: 149;
    SSM_OS3_IR_MODE_GET: 150;
    SSM_OS3_IR_CODE_NOTIFY: 151;
    HUB3_MATTER_PAIRING_WINDOW: 153;
    FACE_CHANGE: 154;
    FACE_DELETE: 155;
    FACE_GET: 156;
    FACE_NOTIFY: 157;
    FACE_LAST: 158;
    FACE_FIRST: 159;
    FACE_MODE_GET: 160;
    FACE_MODE_SET: 161;
    FACE_MODE_DELETE_NOTIFY: 192;
    PALM_CHANGE: 162;
    PALM_DELETE: 163;
    PALM_GET: 164;
    PALM_NOTIFY: 165;
    PALM_LAST: 166;
    PALM_FIRST: 167;
    PALM_MODE_GET: 168;
    PALM_MODE_SET: 169;
    PALM_MODE_DELETE_NOTIFY: 193;
    ADD_SESAME: 101;
    PUB_KEY_SESAME: 102;
    REMOVE_SESAME: 103;
    RESET: 104;
    NOTIFY_LOCK_DOWN: 106;
    HUB3_ITEM_CODE_WIFI_SSID: 131;
    HUB3_ITEM_CODE_SSID_FIRST: 132;
    HUB3_ITEM_CODE_SSID_NOTIFY: 133;
    HUB3_ITEM_CODE_SSID_LAST: 134;
    HUB3_ITEM_CODE_WIFI_PASSWORD: 135;
    HUB3_UPDATE_WIFI_SSID: 136;
    HUB3_MATTER_PAIRING_CODE: 137;
    HUB3_ITEM_CODE_RELAY_SWITCH: 208;
    REMOTE_NANO_SET_TRIGGER_DELAYTIME: 190;
    REMOTE_NANO_PUB_TRIGGER_DELAYTIME: 191;
    SSM_OS3_RADAR_PARAM_SET: 200;
    SSM_OS3_RADAR_PARAM_PUBLISH: 201;
    SSM3_ITEM_CODE_BATTERY_VOLTAGE: 202;
    SSM3_ITEM_CODE_SESAME_UNSUPPORT: 204;
    SS3_ITEM_CODE_SET_ADV_PRODUCT_TYPE: 205;
    SSM3_ITEM_CODE_BLE_TX_POWER_SETTING: 206;
}>;
/** OS2 ロック状態。Sesame2/3/4 は施錠/解錠範囲フラグに加え中間 (moved) を持つ。 */
export const MECH_STATE: Readonly<{
    LOCKED: "locked";
    UNLOCKED: "unlocked";
    MOVED: "moved";
}>;
/**
 * 初代 SESAME Bot の mech_setting フィールド (各値 -128..255 の 1B)。
 */
export type BotMechSetting = {
    userPrefDir: number;
    lockSec: number;
    unlockSec: number;
    clickLockSec: number;
    clickHoldSec: number;
    clickUnlockSec: number;
    buttonMode: number;
};
import { Buffer } from "node:buffer";
import { OP } from "../protocol.js";
import { SEG } from "../protocol.js";
import { splitSegments } from "../protocol.js";
import { SegmentAssembler } from "../protocol.js";
import { RESULT } from "../protocol.js";
import { resultName } from "../protocol.js";
export { OP, SEG, splitSegments, SegmentAssembler, RESULT, resultName };
//# sourceMappingURL=protocol.d.ts.map
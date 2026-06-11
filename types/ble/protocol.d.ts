/**
 * 結果コード → 名前 (未知は unknown(N))。
 * @param {number} code
 * @returns {string}
 */
export function resultName(code: number): string;
/**
 * プロファイル名の検証 (lock / wm2 以外を黙って lock 扱いしない)。
 * @param {string} profile
 * @returns {"lock"|"wm2"}
 */
export function assertProfile(profile: string): "lock" | "wm2";
/**
 * 既存 secretKey と initial token から CCM セッション鍵 (16B) を導出する。
 * token16 = AES-128-CMAC(secretKey, randomToken)  (ssm_cmd.c:43 / CHSesameOS3LockBase.kt:109)
 *
 * @param {string|Buffer} secretKey 16B (32hex)
 * @param {Buffer} token 4B (initial publish のランダム値)
 * @returns {Buffer} 16B セッション鍵
 */
export function deriveSessionKey(secretKey: string | Buffer, token: Buffer): Buffer;
/**
 * 登録 (registration) 直後の sessionAuth 用セッション鍵を ECDH 共有秘密から導出する。
 *   sessionKey16 = AES-128-CMAC(ecdhSecretPre16, token4)   (CHHub3Device.kt:202-203)
 *
 * 通常 login (deriveSessionKey 上記) との分岐:
 *   - 通常 login : 鍵 = 既存の pre-shared secretKey (CMAC(secretKey, token), CHHub3Device.kt:168)。
 *   - register 直後: 鍵 = ECDH 共有秘密の先頭 16B (= crypto.js:ecdhSecretPre16, CHHub3Device.kt:163-174,197)。
 *   どちらも CMAC の **メッセージは token4 (4B)** で共通、戻りは 16B。違いは CMAC の鍵だけ。
 *
 * sault も両者共通 (lock profile): sault = 0x00 ++ token4 (CHHub3Device.kt:170,203 /
 * SesameOS3BleCipher.kt:8-19)。sault は CCM nonce の組み立て側 (ccmNonce(count, ccmSault(profile,
 * token4))) で消費するため、この鍵導出関数自体は sault を引数に取らない (session 確立後の暗号化は
 * ccmEncrypt/ccmDecrypt が担う)。
 * なお wm2 profile はこの関数を **使わない** (登録後鍵 = pre16 生・login 鍵 = secretKey 生、
 * CHWifiModule2Device.kt:295-297,317。SESSION_PROFILES 参照)。
 *
 * 実装方針: アルゴリズム (16B 鍵 + 4B token → AES-128-CMAC(鍵, token4) で 16B) は login 経路の
 *   deriveSessionKey と完全に同一で、違いは「鍵の出所」だけ。よって CMAC コードパスを二重に
 *   持たず deriveSessionKey へ委譲する (将来 CMAC 仕様が変わっても 1 箇所だけ直せばよい)。
 *   ここでは ecdhSecretPre16 という意味的別名のための薄いラッパに徹し、register 文脈で分かりやすい
 *    ecdhSecretPre16 専用エラーメッセージだけを先に検証してから本体へ渡す。
 *
 * @param {Buffer} ecdhSecretPre16 ECDH 共有秘密の先頭 16B (crypto.js:ecdhSecretPre16 の戻り)。
 * @param {Buffer} token4 initial publish のランダム値 4B。
 * @returns {Buffer} 16B セッション鍵 (= sessionAuth)。
 */
export function deriveSessionKeyFromEcdh(ecdhSecretPre16: Buffer, token4: Buffer): Buffer;
/**
 * login コマンドの平文ペイロード (PLAINTEXT セグメントで送る)。プロファイルで形が分かれる:
 *   - lock: [LOGIN(2)] ++ token16[0:4] = 5B (ssm_cmd.c:44-45 / CHSesameOS3LockBase.kt:118-120)
 *   - wm2 : [LOGIN_WM2(2)] ++ loginTag **16B 全量** = 17B
 *           (CHWifiModule2Device.kt:314-321: sendCommand(SesameOS3Payload(LOGIN_WM2, loginTag), plain)。
 *            loginTag = AesCmac(secretKey 生 16B).computeMac(mSesameToken) で切り詰めない)
 * LOGIN(2) と WM2ActionCode.LOGIN_WM2(2) は同値なので先頭バイトは共通、続く長さだけが異なる。
 * @param {Buffer} token16 deriveSessionKey の戻り (lock: session 鍵 / wm2: loginTag = CMAC(secretKey, token))
 * @param {"lock"|"wm2"} [profile="lock"]
 * @returns {Buffer} lock: 5B / wm2: 17B
 */
export function loginPayload(token16: Buffer, profile?: "lock" | "wm2"): Buffer;
/**
 * CCM sault をプロファイルから組み立てる (SesameOS3BleCipher のコンストラクタ第 3 引数に相当)。
 *   - lock: "00" + mSesameToken (CHHub3Device.kt:170,203 / CHSesame5 系・Bot2/Bike2 も同形)
 *   - wm2 : mSesameToken そのまま 4B — 0x00 を挟まない (CHWifiModule2Device.kt:297,317)
 * @param {"lock"|"wm2"} profile
 * @param {Buffer} token4 initial token (4B)
 * @returns {Buffer} lock: 5B / wm2: 4B
 */
export function ccmSault(profile: "lock" | "wm2", token4: Buffer): Buffer;
/**
 * コマンド平文を CCM 暗号化し、末尾に 4B tag を付けて返す。
 * @param {Buffer} token16 セッション鍵
 * @param {number|bigint} count 送信カウンタ (送信ごと +1)
 * @param {Buffer} token4 initial token
 * @param {Buffer} plaintext 暗号化前フレーム ([item, ...data])
 * @param {"lock"|"wm2"} [profile="lock"] nonce sault の形 (ccmSault 参照)。既定は従来どおり lock。
 * @returns {Buffer} ciphertext ++ tag(4B)
 */
export function ccmEncrypt(token16: Buffer, count: number | bigint, token4: Buffer, plaintext: Buffer, profile?: "lock" | "wm2"): Buffer;
/**
 * CCM 復号。入力は ciphertext ++ tag(4B)。tag 不一致なら throw。
 * @param {Buffer} token16
 * @param {number|bigint} count 受信カウンタ (受信ごと +1)
 * @param {Buffer} token4
 * @param {Buffer} ctWithTag ciphertext ++ tag(4B)
 * @param {"lock"|"wm2"} [profile="lock"] nonce sault の形 (ccmSault 参照)。既定は従来どおり lock。
 * @returns {Buffer} 復号平文
 */
export function ccmDecrypt(token16: Buffer, count: number | bigint, token4: Buffer, ctWithTag: Buffer, profile?: "lock" | "wm2"): Buffer;
/**
 * 1 メッセージ (平文 or 暗号文+tag) を 20B パケット列に分割する。
 * 先頭パケットのみ start bit、最終パケットで parsing type を立てる (中間は APPEND_ONLY)。
 * @param {Buffer} payload 送るバイト列 (平文ならフレーム、暗号なら ct++tag)
 * @param {number} parsingType SEG.PLAINTEXT | SEG.CIPHERTEXT
 * @returns {Buffer[]} 各 ≤20B
 */
export function splitSegments(payload: Buffer, parsingType: number): Buffer[];
/**
 * 送信フレーム = [item_code] ++ data。op_code は送信時付与しない (CHSesameOS3.kt:495-499)。
 * @param {number} itemCode
 * @param {Buffer} [data]
 * @returns {Buffer}
 */
export function buildSendFrame(itemCode: number, data?: Buffer): Buffer;
/**
 * 受信フレーム (復号後) = [op_code][item_code][body...] を分解。
 * response(7) は body=[resultCode][payload...]、publish(8) は body=[payload...] (呼び出し側で解釈)。
 * @param {Buffer} buf
 * @returns {{opCode:number, itemCode:number, body:Buffer}}
 */
export function parseRecvFrame(buf: Buffer): {
    opCode: number;
    itemCode: number;
    body: Buffer;
};
/**
 * lock/unlock の data = `[0x00, 0x0E] ++ historyTag`、先頭 20B に切詰め (CHDBModel.kt:37-57)。
 * 先頭 2B `0x000E` (BE) は tag type = "Android user BLE UUID" (SesameProtocols.kt:70)。
 *
 * tag 省略時は type のみ (`[0x00,0x0E]`) を送る = SDK の `historytag=null` パスと同じ。
 * tag を渡す場合は **Buffer (バイト列) を渡すこと**。type が UUID を示すため、任意 utf8 文字列を
 * 入れると型と中身が不整合になる (操作ログ用途であり実害は小さいが、SDK 準拠なら bytes)。
 *
 * @param {Buffer|Uint8Array} [tag] 操作ログ用タグ (バイト列)。省略可。
 * @returns {Buffer}
 */
export function historyTagBLE(tag?: Buffer | Uint8Array): Buffer;
/**
 * autolock の data = 2B LE 秒数 (delay.toShort().toReverseBytes()、CHSesame5Device.kt:96-105)。0=無効。
 * @param {number} seconds 0..65535
 * @returns {Buffer} 2B
 */
export function autolockData(seconds: number): Buffer;
/**
 * configureLockPosition(lockTarget, unlockTarget) コマンドの data を組み立てる。
 *   data = lockTarget.toReverseBytes() ++ unlockTarget.toReverseBytes() = 4B
 *   (CHSesame5Device.kt:69-73)。
 *
 * lockTarget / unlockTarget は施錠位置・解錠位置の **角度 (エンコーダ生値、符号付き 16bit)**。
 * 各々を toReverseBytes (= LE 2B) で詰め、`[lockLE(2)] ++ [unlockLE(2)]` の 4B にする。
 * これを buildSendFrame(ITEM.MECH_SETTING, data) → CIPHERTEXT で送る (sendCommand cipher)。
 *
 * @param {number} lockTarget   施錠目標角 (-32768..32767)
 * @param {number} unlockTarget 解錠目標角 (-32768..32767)
 * @returns {Buffer} 4B
 */
export function configureLockPositionData(lockTarget: number, unlockTarget: number): Buffer;
/**
 * mechSetting (item 80) の publish/response payload を解析する。
 * CHSesame5MechSettings(data) (CHSesame5.kt:34-38) を 1:1 で移植:
 *   data[0..1]: lockPosition   (bytesToShort = i16 LE)
 *   data[2..3]: unlockPosition (i16 LE)
 *   data[4..5]: autoLockSecond (i16 LE)
 *
 * 登録応答 (handleRegisterResponse, CHSesame5Device.kt:201) では payload[7..12] の 6B が
 * この mechSetting に相当する。publish (handleDevicePublish, CHSesame5Device.kt:220-222) では
 * payload 全体が 6B の mechSetting。どちらも先頭 6B を読むので length>=6 を要求する。
 *
 * 注: bytesToShort(b1,b2) = (b2<<8)|b1 = **符号付き** little-endian (DataExtention.kt:99-102)。
 * SDK は autoLockSecond も Short (符号付き) で持つため、ここも readInt16LE で揃える。
 *
 * @param {Buffer} buf 6B 以上
 * @returns {{lockPosition:number, unlockPosition:number, autoLockSecond:number}}
 */
export function parseMechSetting(buf: Buffer): {
    lockPosition: number;
    unlockPosition: number;
    autoLockSecond: number;
};
/**
 * opsSetting (item OPS_CONTROL) の payload を解析する。
 * CHSesame5OpsSettings(data) (CHSesame5.kt:40-42) を移植:
 *   data[0..1]: opsLockSecond (bytesToUShort = u16 LE)
 * SDK は UShort (符号なし) で持つため readUInt16LE。
 * @param {Buffer} buf 2B 以上
 * @returns {{opsLockSecond:number}}
 */
export function parseOpsSetting(buf: Buffer): {
    opsLockSecond: number;
};
/**
 * opSensorControl(isEnable) コマンドの data を組み立てる。
 *   data = isEnable.toShort().toReverseBytes() = 2B LE (CHSesame5Device.kt:107-116)。
 *
 * SDK の引数名は isEnable だが、実体は opsLockSecond (Open Sensor の自動施錠秒数) を
 * 載せる 16bit 値で、成功時に opsSetting?.opsLockSecond = isEnable.toUShort() でキャッシュ更新する。
 * autolock(11) と同じ 2B LE 形式。0=無効。範囲は UShort (0..65535)。
 * @param {number} seconds 0..65535 (0 = 無効)
 * @returns {Buffer} 2B LE
 */
export function opSensorControlData(seconds: number): Buffer;
/**
 * setBleTxPower(txPower) コマンドの data を組み立てる。
 *   data = byteArrayOf(txPower) = 1B (CHSesameOS3LockBase.kt:62-71 /
 *   CHSesameBiometricDeviceImpl.kt:332-341)。
 *
 * txPower は Kotlin の Byte = **符号付き 8bit** (-128..127)。publish 受信
 * (CHSesameOS3LockBase.kt:229-231) でも payload[0] を Byte として bleTxPower に格納する。
 * 1B なので符号付き/符号なしどちらで書いても同一バイトだが、SDK の意味論 (Byte) に揃えて
 * -128..127 を受け、writeInt8 で詰める。
 * @param {number} txPower -128..127
 * @returns {Buffer} 1B
 */
export function bleTxPowerData(txPower: number): Buffer;
/**
 * time(8) コマンドの data を組み立てる。
 *   data = System.currentTimeMillis().toUInt32ByteArray() = 4B (CHSesameOS3LockBase.kt:131-137)。
 *
 * toUInt32ByteArray (DataExtention.kt:138-147) は ms→秒 (floor) の下位 32bit を little-endian 4B
 * にするもので、registrationTimestampBytes と **完全に同一アルゴリズム** (登録時刻も同じ関数を使う、
 * CHSesameOS3LockBase.kt:93)。よって唯一の実装である registrationTimestampBytes に委譲し、
 * time 文脈で分かりやすい別名を提供する (アルゴリズムを二重に持たない)。
 *
 * 送出経路 (CHSesameOS3LockBase.kt:126-138 handleLoginResponse):
 *   login 応答の payload[0..3] (デバイス時刻 toBigLong, 秒) と端末の現在秒を比較し、
 *   差の絶対値が 3 秒を超えたときだけ time(8) を CIPHERTEXT 送出する。
 *   差判定は session 側 (parseTimeSyncPayload) で行う。
 *
 * @param {number} [nowMs=Date.now()] エポックミリ秒
 * @returns {Buffer} 4B (秒値の下位 32bit を LE)
 */
export function timeSyncData(nowMs?: number): Buffer;
/**
 * login 応答 payload からデバイス側の現在時刻 (秒) を取り出す。
 * SDK: loginPayload.payload.sliceArray(0..3).toBigLong() (CHSesameOS3LockBase.kt:127)。
 * toBigLong (DataExtention.kt:69-71) = reversedArray().toHexString() を 16進 Long parse
 *   = 4B を **big-endian 並べ替え後の値** = 元バイト列を little-endian u32 として読むのと等価。
 * payload が 4B 未満なら null (時刻同期判定をスキップさせる)。
 * @param {Buffer} payload login response の payload (resultCode を除いた本体)
 * @returns {number|null} デバイス時刻 (秒) or null
 */
export function parseDeviceTimeSeconds(payload: Buffer): number | null;
/**
 * デバイス時刻 (秒) と端末時刻の差が同期しきい値 (>3 秒) を超えるか。
 * SDK: abs(currentTimestamp - systemTime) > 3 (CHSesameOS3LockBase.kt:128-130)。
 * @param {number} deviceSeconds parseDeviceTimeSeconds の戻り
 * @param {number} [nowMs=Date.now()] 端末のエポックミリ秒
 * @returns {boolean} true なら time(8) を送るべき
 */
export function needsTimeSync(deviceSeconds: number, nowMs?: number): boolean;
/**
 * history(4) 読み出しコマンドの data = byteArrayOf(0x01) (CHSesameOS3LockBase.kt:187-188)。
 * 1 件分の履歴を要求する固定 1B フラグ。
 * @returns {Buffer} 1B
 */
export function historyReadData(): Buffer;
/**
 * historyDelete(18, SSM2_ITEM_CODE_HISTORY_DELETE) コマンドの data を組み立てる。
 *   data = recordId = historyPayload.sliceArray(0..3) = 履歴 payload 先頭 4B
 *   (CHSesameOS3LockBase.kt:201-207)。
 * サーバへ履歴を post できた後、その 1 件をデバイスから消すために送る。
 * 渡す historyPayload は history(4) 応答の payload (先頭 4B が recordId)。
 * @param {Buffer} historyPayload history(4) 応答 payload (4B 以上)
 * @returns {Buffer} 4B recordId
 */
export function historyDeleteData(historyPayload: Buffer): Buffer;
/**
 * 登録 (registration) コマンドの末尾に付ける現在時刻を 4B にエンコードする。
 * SDK の `Long.toUInt32ByteArray()` (DataExtention.kt:138-147) を 1:1 で移植する。
 *
 * ★配線状況 (2026-06 時点): この関数は登録フローに**配線済み**である。
 *   registrationData() がこのバイト列を pubKey64 の後ろに連結し (下記の (a))、
 *   session.register() (src/ble/session.js:226) が
 *   `_sendPlain(buildSendFrame(ITEM.REGISTRATION, registrationData(pubK64, nowMs)))` で
 *   REGISTRATION(1) を PLAINTEXT セグメント送出する形で本番フローに乗っている。
 *   登録フローの配線済み要素:
 *     (a) registrationData() = pubKey64(64B) ++ registrationTimestampBytes(4B) の組み立て
 *         (CHHub3Device.kt:193)。この関数の直下に実装済み。
 *     (b) ITEM.REGISTRATION(=1) を PLAINTEXT で送る session 経路 (session.js:226)。配線済み。
 *     (c) crypto.js の ECDH ブロック (ecdhSecretPre16) は session.register() (session.js:234)
 *         で device の返す公開鍵から共有秘密を導く形で接続済み。
 *   ファサード層も SesameBle.register() / registerOnce() として公開済み (index.js)。
 *   注: バイト列・ハンドシェイクは mock vector で単体/end-to-end テスト済みだが、**実機 OS3
 *   デバイスに対する検証は未了** (README の Known limitations 参照)。配線は完了している。
 *
 * 用途 (CHHub3Device.kt:193):
 *   registration payload = EccKey.getPubK()(64B) ++ currentTimeMillis().toUInt32ByteArray()(4B)
 * を plain セグメントで送る。
 *
 * SDK 原典 (DataExtention.kt:138-147):
 *   val tmp = this / 1000                       // ms → 秒 (Long 除算 = floor)
 *   bytes[3] = (tmp and 0xFFFF).toByte()         // 0xFFFF でマスク後 .toByte() で下位8bitに切り詰め → bits 0..7
 *   bytes[2] = (tmp ushr 8  and 0xFFFF).toByte() // 同上 → bits 8..15
 *   bytes[1] = (tmp ushr 16 and 0xFFFF).toByte() // 同上 → bits 16..23
 *   bytes[0] = (tmp ushr 24 and 0xFFFF).toByte() // 同上 → bits 24..31
 *   return bytes.reversedArray()                 // [b24,b16,b8,b0] (BE) → reverse → [b0,b8,b16,b24] (LE)
 *
 * 注: 原典のマスク定数は 0xFF ではなく 0xFFFF だが、最後の `.toByte()` が下位 8bit へ切り詰めるため
 *   0xFFFF マスクの上位 8bit (bits 8..15) は捨てられ、出力は本実装の `& 0xFFn` と完全に等価。
 *
 * 結果は「秒値の下位 32bit を little-endian 4B」で詰めたものと等価。
 * `ushr` (符号なし右シフト) と各バイトの `.toByte()` 切り詰めにより、秒値が 32bit を超える
 * 遠未来でも自動的に下位 32bit だけが採られる (bits >=32 は b0 にも乗らない)。
 *
 * ★仕様上限: 秒値が 2^32 を超える遠未来 (>2106年, 約 0xFFFFFFFF 秒) では下位 32bit へ
 *   無言ラップする。これは SDK の toUInt32ByteArray() (Kotlin Long の ushr + 下位 8bit
 *   マスク) と一致する移植であり正しさの欠陥ではない。ただし登録時刻はデバイス側で時計
 *   照合される可能性があり、ラップ後の値で invalidParam 系を誘発し得る (デバイス側時刻
 *   検証がある場合の挙動は未検証)。配線時に留意。
 *
 * 固定 ms=1605929466482 → tmp=1605929466(=0x5FB889FA) → 戻り `fa89b85f`
 * (DataExtention.kt:139 のコメント "fa89b85f" と一致)。
 *
 * @param {number} [nowMs=Date.now()] エポックミリ秒 (非負整数)。
 * @returns {Buffer} 4B (秒値の下位 32bit を LE)
 */
export function registrationTimestampBytes(nowMs?: number): Buffer;
/**
 * REGISTRATION(1) コマンドの平文 data を組み立てる。
 *   data = EccKey.getPubK()(64B) ++ currentTimeMillis().toUInt32ByteArray()(4B) = 68B
 *   (CHHub3Device.kt:191-194)。
 *
 * これを buildSendFrame(ITEM.REGISTRATION, data) に通すと [01] ++ data = 69B フレームになり、
 * **PLAINTEXT セグメント** (SEG.PLAINTEXT) で送る (CHSesameOS3.kt:495-499: 送信フレームは
 * [item_code] ++ data で op_code は付与しない。registration は session 確立前なので暗号化せず平文)。
 *
 * pubK は ECDH 鍵ペア (crypto.js の createECDH("prime256v1")) の **生 P-256 公開鍵 X‖Y(64B)**。
 * SDK の EccKey.getPubK() は uncompressed prefix 0x04 を含まない 64B raw を返す (EccKey.kt の
 * fixheader 規約 / crypto.js:220-228 と同契約)。よってここは 64B/128hex のみを受け、Node の
 * getPublicKey() が既定で返す 0x04 付き 65B はそのまま渡せない (呼び出し側で剥がすこと)。
 *
 * ★配線状況 (2026-06 時点): registrationTimestampBytes と同様、この関数は登録フローに
 *   **配線済み**。session.register() (session.js:226) が
 *   `_sendPlain(buildSendFrame(ITEM.REGISTRATION, registrationData(pubK64, nowMs)))` で
 *   REGISTRATION(1) を PLAINTEXT 送出し、ファサード SesameBle.register()/registerOnce()
 *   から到達できる。mock vector でテスト済みだが**実機 OS3 検証は未了** (README 参照)。
 *
 * プロファイル分岐 (P1-6):
 *   - lock (既定): pubK64 ++ timestamp4 = 68B (CHHub3Device.kt:191-194 / CHSesameOS3LockBase.kt:93)
 *   - wm2        : **pubK64 のみ** = 64B — timestamp を付けない
 *                  (CHWifiModule2Device.kt:290: sendCommand(SesameOS3Payload(REGISTER_WM2,
 *                   EccKey.getPubK().hexStringToByteArray()), plain) — data は公開鍵 64B のみ)
 *
 * @param {Buffer|string} pubK ECDH 生公開鍵 64B (X‖Y, prefix 無し) または 128hex 文字列。
 * @param {number} [nowMs=Date.now()] エポックミリ秒 (registrationTimestampBytes へ委譲。wm2 では未使用)。
 * @param {"lock"|"wm2"} [profile="lock"]
 * @returns {Buffer} lock: 68B (pubK 64B ++ timestamp 4B) / wm2: 64B (pubK のみ)。
 */
export function registrationData(pubK: Buffer | string, nowMs?: number, profile?: "lock" | "wm2"): Buffer;
/**
 * mech_status を OS3 デバイスの種別に応じて解析する。
 *
 * SDK は publish payload の **長さ** で具象 MechStatus クラスを選ぶ (CHSesame5Device.kt:213-218,
 * CHSesameBot2Device.kt:245-248)。それに倣い長さで分岐する:
 *
 *   7B = CHSesame5MechStatus (Sesame5/6 系ロック)
 *     data[0..1]: 電池電圧 ADC 生値 (LE。換算式は本体に無くサーバ側 → ここでは batteryRaw として返すのみ)
 *     data[2..3]: target   (i16 LE、-32768 は「未設定」→ null)
 *     data[4..5]: position (i16 LE)
 *     data[6]   : flags — bit1 isInLockRange / bit3 critical / bit4 stop / bit5 batteryCritical
 *   3B = CHSesameBot2MechStatus / CHSesameBike2MechStatus (Bot2/Bot3/Bike2/Bike3)
 *     data[0..1]: 電池電圧 ADC 生値 (LE)
 *     data[2]   : flags — bit1 isInLockRange / bit2 stop
 *     position/target の概念なし (null)
 *
 * 施錠/解錠は **isInLockRange の有無のみ** で判定する。OS3 に unlock-range ビットも中間 (moved) も無い
 * (CHSesame5.kt:24-32 / CHSesameBot2.kt:123-126: isInUnlockRange = !isInLockRange)。
 *
 * @param {Buffer} buf 3B (bot/bike) または 7B 以上 (lock)
 * @returns {{state:string, isInLockRange:boolean, target:number|null, position:number|null,
 *            isStop:boolean, isCritical:boolean, isBatteryCritical:boolean, batteryRaw:number, flags:number}}
 */
export function parseMechStatus(buf: Buffer): {
    state: string;
    isInLockRange: boolean;
    target: number | null;
    position: number | null;
    isStop: boolean;
    isCritical: boolean;
    isBatteryCritical: boolean;
    batteryRaw: number;
    flags: number;
};
/** GATT (blecent.c:13-15 / SesameProtocols.kt:80-83)。 */
export const GATT: Readonly<{
    SERVICE: "fd81";
    WRITE_CHAR: "16860002-a5ae-9856-b6d3-dbb4c676993e";
    NOTIFY_CHAR: "16860003-a5ae-9856-b6d3-dbb4c676993e";
}>;
/** advertise の company ID (LE 5A 05 = 0x055A)。blecent.c:132 */
export const COMPANY_ID: 1370;
/** op_code (candy.h:66-69 / SesameProtocols.kt:55-57)。受信で意味を持つのは response/publish。 */
export const OP: Readonly<{
    CREATE: 1;
    READ: 2;
    UPDATE: 3;
    DELETE: 4;
    SYNC: 5;
    ASYNC: 6;
    RESPONSE: 7;
    PUBLISH: 8;
}>;
/** item_code。クラウドと共通の正準ソース (src/itemcodes.js) を参照する (重複定義を避ける)。 */
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
    HUB3_ITEM_CODE_NETWORK_TYPE: 209;
    REMOTE_NANO_SET_TRIGGER_DELAYTIME: 190;
    REMOTE_NANO_PUB_TRIGGER_DELAYTIME: 191;
    SSM_OS3_RADAR_PARAM_SET: 200;
    SSM_OS3_RADAR_PARAM_PUBLISH: 201;
    SSM3_ITEM_CODE_BATTERY_VOLTAGE: 202;
    SSM3_ITEM_CODE_SESAME_UNSUPPORT: 204;
    SS3_ITEM_CODE_SET_ADV_PRODUCT_TYPE: 205;
    SSM3_ITEM_CODE_BLE_TX_POWER_SETTING: 206;
}>;
/** セグメントの parsing type (candy.h:44-46 / SesameBleReceiver.kt:5)。ヘッダ = (type<<1) | startBit。 */
export const SEG: Readonly<{
    APPEND_ONLY: 0;
    PLAINTEXT: 1;
    CIPHERTEXT: 2;
}>;
/**
 * SESAME OS3 デバイスがコマンド応答 (response 0x07) の先頭バイトで返す結果コード。
 * 出典: 公式 SesameSDK `enum SesameResultCode: UInt8`
 *   (references_ios/Sources/SesameSDK/Ble/CHDeviceProtocol.swift:195)。
 * これは **デバイス層 (SesameOS3) の taxonomy** で BLE/WM2 で共通。クラウド (biz3) 経路は
 * この code を surface しないため、利用できるのは BLE 直接経路のみ。
 */
export const RESULT: Readonly<{
    0: "success";
    1: "invalidFormat";
    2: "notSupported";
    3: "resultStorageFail";
    4: "invalidSig";
    5: "notFound";
    6: "unknown";
    7: "busy";
    8: "invalidParam";
    9: "invalidAction";
}>;
export const SESSION_PROFILES: Readonly<{
    lock: Readonly<{
        initialItemCode: 14;
    }>;
    wm2: Readonly<{
        initialItemCode: 13;
    }>;
}>;
/**
 * 受信セグメントを結合するアセンブラ。feed() で 1 パケットずつ与え、メッセージ完結時に
 * { type, data } を返す (未完なら null)。start bit でバッファをリセット。
 */
export class SegmentAssembler {
    /**
     * @param {Buffer} packet notify で届いた 1 パケット
     * @returns {{type:number, data:Buffer}|null} 完結時のみ {type, data}
     */
    feed(packet: Buffer): {
        type: number;
        data: Buffer;
    } | null;
}
/** ロック状態。SESAME 5 (OS3) は施錠範囲フラグの有無の 2 値 (中間 "moved" は無い)。 */
export const MECH_STATE: Readonly<{
    LOCKED: "locked";
    UNLOCKED: "unlocked";
}>;
import { Buffer } from "node:buffer";
//# sourceMappingURL=protocol.d.ts.map
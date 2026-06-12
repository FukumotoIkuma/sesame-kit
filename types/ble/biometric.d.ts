/**
 * CHSesameTouchCard(data) (CHSesameBiometricParseData.kt:10-17) を 1:1 で移植。
 *   data[0]                     : cardType
 *   data[1]                     : idLength
 *   data[2 .. idLength+1]       : cardID   (hex)
 *   data[idLength+2]            : nameLength
 *   data[idLength+3 .. +len]    : cardName (hex)
 * card / fingerprint / passcode の NOTIFY/CHANGE 受信に共通で使う。
 *
 * @param {Buffer} data
 * @returns {{cardType:number, idLength:number, cardID:string, nameLength:number, cardName:string, recordSize:number}}
 */
export function parseTouchCard(data: Buffer): {
    cardType: number;
    idLength: number;
    cardID: string;
    nameLength: number;
    cardName: string;
    recordSize: number;
};
/**
 * CHSesameTouchFace(data) (CHSesameBiometricParseData.kt:28-36) を移植。
 * face / palm の NOTIFY/CHANGE 受信に使う。nameUUID は hex を noHashtoUUID した文字列だが、
 * kit には UUID 整形ヘルパが無いため nameUUID は **hex 文字列のまま** 返す
 * (SDK の noHashtoUUID は表示用整形であり、識別子としての値は hex と同値)。
 *
 * @param {Buffer} data
 * @returns {{type:number, idLength:number, id:string, nameLength:number, nameUUID:string}}
 */
export function parseTouchFace(data: Buffer): {
    type: number;
    idLength: number;
    id: string;
    nameLength: number;
    nameUUID: string;
};
/**
 * CHRemoteNanoTriggerSettings.fromData(buf) (CHSesameBiometricParseData.kt:59-74) を移植。
 * Remote Nano の TRIGGER_DELAYTIME publish (itemCode 191) の payload を解釈する。
 * SDK は ByteBuffer を LITTLE_ENDIAN で wrap し先頭 1 byte を get().toUByte() で読む。
 * 1 byte 値なので LE/BE は同値だが、原典どおり LE・先頭 1B を triggerDelaySecond (0..255) とする。
 *
 * @param {Buffer} data publish payload
 * @returns {{triggerDelaySecond:number}}
 */
export function parseRemoteNanoTrigger(data: Buffer): {
    triggerDelaySecond: number;
};
/**
 * 生体・アクセス制御デバイス (Touch / Touch Pro / Face / Palm) の mechStatus を解釈する。
 *
 * SDK: CHSesameTouchProMechStatus(data) (CHSesameBiometricParseData.kt:76) を 1:1 で移植。
 * このクラスは CHSesameProtocolMechStatus (CHDeivceProtocols.kt:334-351) を実装するだけで、
 * position/target/isInLockRange/isStop/isCritical/isBatteryCritical の **どの getter も
 * オーバーライドしない**。よって全フィールドはインタフェース既定値に落ちる:
 *   position=0, target=0, isInLockRange=false (→ isInUnlockRange=true),
 *   isStop=null, isCritical=null, isBatteryCritical=false。
 * 保持されるのは raw payload (data) のみ。
 *
 * ★重要: 生体デバイスの mechStatus は **ロックの 7B/3B レイアウト (protocol.js parseMechStatus)
 *   とは別物**。ロック用 parse は position/target/flags をバイト位置から読むが、生体 mechStatus
 *   にはその構造が無い (SDK は raw を保持するだけ)。そのため protocol.js の parseMechStatus に
 *   生体 payload を流すと長さ不一致で throw する。ここではロック解釈を一切行わず、SDK の
 *   pass-through 意味論をそのまま再現する。
 *
 * batteryRaw は SDK が reportBatteryData(payload.sliceArray(0..1)) として電池報告に使う
 * 先頭 2B (CHSesameBiometricDeviceImpl.kt:216) を LE u16 として参考値で同梱する
 * (mechStatus クラス自体は電池を解釈しないが、呼び出し側の利便のため)。payload が 2B 未満なら
 * batteryRaw は null。
 *
 * @param {Buffer} data publish payload (raw)
 * @returns {{data:Buffer, position:number, target:number, isInLockRange:boolean,
 *            isInUnlockRange:boolean, isStop:null, isCritical:null, isBatteryCritical:boolean,
 *            batteryRaw:number|null}}
 */
export function parseBiometricMechStatus(data: Buffer): {
    data: Buffer;
    position: number;
    target: number;
    isInLockRange: boolean;
    isInUnlockRange: boolean;
    isStop: null;
    isCritical: null;
    isBatteryCritical: boolean;
    batteryRaw: number | null;
};
/**
 * PUB_KEY_SESAME(102) publish の子鍵束を解釈する。
 * SDK: CHSesameBiometricDeviceImpl.handlePubKeySesame (kt:219-255) を 1:1 で移植。
 *
 * payload を **23B ずつ** に分割する (SDK divideArray(23), DataExtention.kt:20-34)。
 * divideArray は末尾の端数チャンクを **0x00 で 23B までゼロ埋め** する (事前確保 ByteArray を
 * arraycopy で部分的に埋めるため)。よって全ゼロ判定はこのゼロ埋めも込みで行う。
 *
 * 各 23B チャンク (it):
 *   it[22] = lockStatus。0 のスロットは空き (skip)。
 *   it[21] == 0x00 → SS5 鍵:  id = it[0..15] (16B) の hex、value = [0x05, it[22]]。
 *   it[21] != 0x00 → SS2 鍵:  id = base64decode(utf8(it[0..21]) + "==") の hex、value = [0x04, it[22]]。
 *       (SS2 系は 22B の base64 文字列を ASCII で詰めており、"==" を補って復号する)。
 * SDK は id をさらに noHashtoUUID で UUID 整形するが、kit は parseTouchFace と同じ方針で
 * **hex 文字列のまま** id とする (noHashtoUUID は表示整形であり識別子としての値は hex と同値)。
 * base64 復号に失敗したチャンクは SDK 同様スキップする (kt:247-249 catch)。
 *
 * 空きスロット判定 (hasEmptySlot, kt:225-231):
 *   既定 (非 OpenSensor): 全ゼロチャンクが 1 つでもあれば空きあり。
 *   OpenSensor 系: hub3 用に 1 スロット予約するため、全ゼロチャンクが **2 つ以上** で空きあり。
 * kit は product model 文脈を持たない (handleBiometricPublish と同様) ため、呼び出し側が
 * isOpenSensor を渡して切り替える。
 *
 * @param {Buffer} data PUB_KEY_SESAME publish payload
 * @param {{isOpenSensor?:boolean}} [opts]
 * @returns {{keys:Array<{ssmID:string, keyType:number, lockStatus:number}>,
 *            slotFull:boolean, emptySlotCount:number}}
 *   keys: 占有スロットのみ (lockStatus!=0)。keyType は 0x05(SS5)/0x04(SS2)、value 第2バイトは lockStatus。
 *   slotFull: !hasEmptySlot (SDK setSlotFull(!hasEmptySlot) と同義)。
 */
export function parsePubKeySesame(data: Buffer, { isOpenSensor }?: {
    isOpenSensor?: boolean;
}): {
    keys: Array<{
        ssmID: string;
        keyType: number;
        lockStatus: number;
    }>;
    slotFull: boolean;
    emptySlotCount: number;
};
/**
 * cardModeSet: data = [mode] (CHCardCapableImpl.kt:53)。
 * @param {number} mode
 * @returns {Buffer}
 */
export function cardModeSetData(mode: number): Buffer;
/** cardModeGet / cardGet: data = [] (空)。 */
export function cardModeGetData(): Buffer<ArrayBuffer>;
export function cardGetData(): Buffer<ArrayBuffer>;
/**
 * cardAdd: data = [F0][00][idLen] ++ id.padEnd(16) ++ [nameLen] ++ name.padEnd(16)
 * (CHCardCapableImpl.kt:101-104)。id は raw bytes、hexName は UTF-8 文字列としてバイト化
 * (SDK は hexName.toByteArray() = UTF-8。padEnd(16) で 16B 固定枠)。
 * @param {Buffer} id      カード UID 生バイト列
 * @param {string} hexName 名前 (UTF-8 文字列)
 */
export function cardAddData(id: Buffer, hexName: string): Buffer<ArrayBuffer>;
/**
 * cardDelete: data = cardID(hex→bytes) (CHCardCapableImpl.kt:62)。
 * @param {string} cardID hex
 * @returns {Buffer}
 */
export function cardDeleteData(cardID: string): Buffer;
/**
 * cardMove: data = [idLen] ++ id(hex→bytes) ++ touchProUUID(UTF-8) (CHCardCapableImpl.kt:71)。
 * @param {string} cardId       hex
 * @param {string} touchProUUID 移動先デバイスの UUID 文字列 (UTF-8)
 */
export function cardMoveData(cardId: string, touchProUUID: string): Buffer<ArrayBuffer>;
/**
 * cardChange: data = [idLen] ++ id(hex→bytes) ++ hexName(2文字ずつ畳んだ bytes)
 * (CHCardCapableImpl.kt:160-166)。新方式は 16B UUID を name として渡す。
 * @param {string} ID hex
 * @param {string} hexName hex
 * @returns {Buffer}
 */
export function cardChangeData(ID: string, hexName: string): Buffer;
/**
 * cardChangeValue: data = [idLen] ++ id(hex→bytes) ++ newID(UTF-8) (CHCardCapableImpl.kt:174)。
 * @param {string} ID hex
 * @param {string} newID UTF-8 文字列
 * @returns {Buffer}
 */
export function cardChangeValueData(ID: string, newID: string): Buffer;
/** @param {number} mode @returns {Buffer} */
export function fingerPrintModeSetData(mode: number): Buffer;
export function fingerPrintModeGetData(): Buffer<ArrayBuffer>;
export function fingerPrintGetData(): Buffer<ArrayBuffer>;
/**
 * fingerPrintDelete: data = fingerPrintID(hex→bytes) (CHFingerPrintCapableImpl.kt:50)。
 * @param {string} fingerPrintID hex
 * @returns {Buffer}
 */
export function fingerPrintDeleteData(fingerPrintID: string): Buffer;
/**
 * fingerPrintsChange: data = [idLen] ++ id(hex→bytes) ++ hexName(畳んだ bytes) (CHFingerPrintCapableImpl.kt:74)。
 * @param {string} ID hex
 * @param {string} hexName hex
 * @returns {Buffer}
 */
export function fingerPrintChangeData(ID: string, hexName: string): Buffer;
/** @param {number} mode @returns {Buffer} */
export function passcodeModeSetData(mode: number): Buffer;
export function passcodeModeGetData(): Buffer<ArrayBuffer>;
export function passcodeGetData(): Buffer<ArrayBuffer>;
/**
 * keyBoardPassCodeAdd: data = [F0][00][idLen] ++ id.padEnd(16) ++ [nameLen] ++ name.padEnd(16)
 * (CHPassCodeCapableImpl.kt:44-49)。card と同一レイアウト (定数名のみ KB_*)。
 * @param {Buffer} id
 * @param {string} hexName
 * @returns {Buffer}
 */
export function passcodeAddData(id: Buffer, hexName: string): Buffer;
/**
 * keyBoardPassCodeDelete: data = id(hex→bytes) (CHPassCodeCapableImpl.kt:104)。
 * @param {string} keyBoardPassCodeID hex
 * @returns {Buffer}
 */
export function passcodeDeleteData(keyBoardPassCodeID: string): Buffer;
/**
 * keyBoardPassCodeMove: data = [idLen] ++ id(hex→bytes) ++ touchProUUID(UTF-8) (CHPassCodeCapableImpl.kt:113)。
 * @param {string} cardId hex
 * @param {string} touchProUUID UTF-8
 * @returns {Buffer}
 */
export function passcodeMoveData(cardId: string, touchProUUID: string): Buffer;
/**
 * keyBoardPassCodeChange: data = [idLen] ++ id(hex→bytes) ++ hexName(畳んだ bytes) (CHPassCodeCapableImpl.kt:123)。
 * @param {string} ID hex
 * @param {string} hexName hex
 * @returns {Buffer}
 */
export function passcodeChangeData(ID: string, hexName: string): Buffer;
/** @param {number} mode @returns {Buffer} */
export function faceModeSetData(mode: number): Buffer;
export function faceModeGetData(): Buffer<ArrayBuffer>;
export function faceGetData(): Buffer<ArrayBuffer>;
/**
 * faceChange: data = [idLen] ++ id(hex→bytes) ++ name(畳んだ bytes) (CHFaceCapableImpl.kt:50)。
 * @param {string} ID hex
 * @param {string} name hex
 * @returns {Buffer}
 */
export function faceChangeData(ID: string, name: string): Buffer;
/**
 * faceDelete: data = [faceID(hex→単一 byte)] (CHFaceCapableImpl.kt:56 byteArrayOf(faceID.toInt(16).toByte()))。
 * @param {string} faceID hex
 * @returns {Buffer}
 */
export function faceDeleteData(faceID: string): Buffer;
/** @param {number} mode @returns {Buffer} */
export function palmModeSetData(mode: number): Buffer;
export function palmModeGetData(): Buffer<ArrayBuffer>;
export function palmGetData(): Buffer<ArrayBuffer>;
/**
 * palmDelete: data = [palmID(hex→単一 byte)] (CHPalmCapableImpl.kt:47)。
 * @param {string} palmID hex
 * @returns {Buffer}
 */
export function palmDeleteData(palmID: string): Buffer;
/**
 * setTriggerDelayTime: data = [time(UByte 1B)] (CHRemoteNanoCapableImpl.kt:19-28
 * byteArrayOf(time.toByte()))。time は UByte 0..255。範囲外は throw (誇張せず原典の型制約を再現)。
 * @param {number} time 0..255
 */
export function remoteNanoTriggerDelayData(time: number): Buffer<ArrayBuffer>;
/**
 * setRadarSensitivity: data = payload をそのまま (CHDeviceConnectCapableImpl.kt:89-95)。
 * SDK は raw payload Buffer を SSM_OS3_RADAR_PARAM_SET(200) に無加工で載せる
 * (payload[1] をログ出力するのみで構造は触らない)。kit でも生バイトを通す。
 * @param {Buffer} payload レーダーパラメータの生バイト列
 */
export function radarSensitivityData(payload: Buffer): Buffer<ArrayBuffer>;
/**
 * insertSesame の ADD_SESAME payload を組み立てる。
 *
 * SDK:
 *   - OS3 子デバイス (SS5/5Pro/Bike2): UUID(16B) ++ secretKey(16B)
 *   - OS2 子デバイス (SS3/4/Bot1/Bike1): base64(UUID16).replace("=","")(22B)
 *       ++ sesame2PublicKey(64B) ++ secretKey(16B)
 *
 * `sesame2PublicKey` を渡した場合は OS2 形、それ以外は OS3 形で送る。
 *
 * @param {{deviceUUID:string, secretKey:string|Buffer, sesame2PublicKey?:string|Buffer}} sesame
 * @returns {Buffer}
 */
export function insertSesameData({ deviceUUID, secretKey, sesame2PublicKey }?: {
    deviceUUID: string;
    secretKey: string | Buffer;
    sesame2PublicKey?: string | Buffer;
}): Buffer;
/**
 * removeSesame の REMOVE_SESAME payload を組み立てる。
 * keyType=0x04 は OS2 子鍵 (base64(UUID16).replace("=",""))、それ以外は OS3 子鍵 (UUID16)。
 *
 * @param {string} tag UUID/hex
 * @param {{keyType?:number}} [opts]
 * @returns {Buffer}
 */
export function removeSesameData(tag: string, { keyType }?: {
    keyType?: number;
}): Buffer;
/**
 * batchAdd 1 パケットの data を組み立てる。
 *   data = dataIndex.toReverseBytes()(2B LE) ++ dataSize.toReverseBytes()(2B LE) ++ chunk
 * (CHCardCapableImpl.kt:117-122 / CHPassCodeCapableImpl.kt:73-78)。
 * chunk は全データ data[dataIndex .. dataIndex+chunkSize) で chunkSize = min(残り, 209)。
 *
 * @param {Buffer} data      全登録データ
 * @param {number} dataIndex 現在の読み出し位置
 * @returns {{packet:Buffer, nextIndex:number}}
 */
export function batchAddPacket(data: Buffer, dataIndex: number): {
    packet: Buffer;
    nextIndex: number;
};
/**
 * publish パケット 1 件 (session.onPublish が渡す {opCode, itemCode, body})。
 * @typedef {{itemCode:number, body?:Buffer, payload?:Buffer}} BiometricPublishPacket
 */
/**
 * handleBiometricPublish が呼ぶ delegate。全コールバックは任意 (未定義なら no-op)。
 * 第1引数は呼び出し側が渡す device トークン (省略可)。SDK CH*Delegate.kt と 1:1。
 * @typedef {Object} BiometricDelegate
 * @property {(device?: unknown) => void} [onCardReceiveStart]
 * @property {(device: unknown, cardID: string, cardName: string, cardType: number) => void} [onCardReceive]
 * @property {(device?: unknown) => void} [onCardReceiveEnd]
 * @property {(device: unknown, cardID: string, cardName: string, cardType: number) => void} [onCardChanged]
 * @property {(device: unknown, mode: number) => void} [onCardModeChanged]
 * @property {(device: unknown, cardID: string) => void} [onCardDelete]
 * @property {(device?: unknown) => void} [onFingerPrintReceiveStart]
 * @property {(device: unknown, cardID: string, cardName: string, cardType: number) => void} [onFingerPrintReceive]
 * @property {(device?: unknown) => void} [onFingerPrintReceiveEnd]
 * @property {(device: unknown, cardID: string, cardName: string, cardType: number) => void} [onFingerPrintChanged]
 * @property {(device: unknown, mode: number) => void} [onFingerModeChange]
 * @property {(device: unknown, id: string) => void} [onFingerDelete]
 * @property {(device?: unknown) => void} [onKeyBoardReceiveStart]
 * @property {(device: unknown, cardID: string, cardName: string, cardType: number) => void} [onKeyBoardReceive]
 * @property {(device?: unknown) => void} [onKeyBoardReceiveEnd]
 * @property {(device: unknown, cardID: string, cardName: string, cardType: number) => void} [onKeyBoardChanged]
 * @property {(device: unknown, mode: number) => void} [onKeyBoardModeChange]
 * @property {(device: unknown, id: string) => void} [onKeyBoardDelete]
 * @property {(device?: unknown) => void} [onFaceReceiveStart]
 * @property {(device: unknown, face: ReturnType<typeof parseTouchFace>) => void} [onFaceReceive]
 * @property {(device?: unknown) => void} [onFaceReceiveEnd]
 * @property {(device: unknown, face: ReturnType<typeof parseTouchFace>) => void} [onFaceChanged]
 * @property {(device: unknown, mode: number) => void} [onFaceModeChanged]
 * @property {(device: unknown, faceID: number, ok: boolean) => void} [onFaceDeleted]
 * @property {(device?: unknown) => void} [onPalmReceiveStart]
 * @property {(device: unknown, face: ReturnType<typeof parseTouchFace>) => void} [onPalmReceive]
 * @property {(device?: unknown) => void} [onPalmReceiveEnd]
 * @property {(device: unknown, face: ReturnType<typeof parseTouchFace>) => void} [onPalmChanged]
 * @property {(device: unknown, mode: number) => void} [onPalmModeChanged]
 * @property {(device: unknown, palmID: number, ok: boolean) => void} [onPalmDeleted]
 * @property {(device: unknown, setting: ReturnType<typeof parseRemoteNanoTrigger>) => void} [onTriggerDelaySecondReceived]
 * @property {(device: unknown, payload: Buffer) => void} [onRadarReceive]
 * @property {(device: unknown, status: ReturnType<typeof parseBiometricMechStatus>) => void} [onMechStatus]
 * @property {(device: unknown, keys: ReturnType<typeof parsePubKeySesame>) => void} [onSesameKeysReceived]
 * @property {(device: unknown, payloadHex: string) => void} [onBatteryVoltageReceived]
 * @property {(device: unknown, support: boolean) => void} [onSupportChanged]
 * @property {(device: unknown, txPower: number) => void} [onBleTxPowerReceive]
 */
/**
 * publish パケット 1 件を delegate へディスパッチする純関数。
 *
 * SDK では capability ごとに EventHandler を登録し handleEvent が true を返すまで巡回するが、
 * itemCode が一意に capability を決めるためここでは単一 switch で 1:1 に写像する。
 * いずれの delegate コールバックも任意 (未定義なら no-op)。device 引数は SDK の delegate 第1引数
 * (CHDevices) に相当する不透明トークンで、呼び出し側が文脈 (どのデバイスか) を持たせるために渡す。
 *
 * 受理した itemCode は true を、未対応 (mechStatus 等の非生体 publish) は false を返す
 * (CHSesameBiometricDeviceImpl.kt の handled フラグ相当)。
 *
 * @param {BiometricPublishPacket} pkt    publish パケット (session.onPublish の引数)
 * @param {BiometricDelegate} delegate  下記コールバックの一部または全部を持つオブジェクト
 * @param {unknown} [device]     コールバックへ素通しする識別子 (省略可)
 * @param {{isRemote?:(boolean|null), isOpenSensor?:boolean}} [opts] 機種文脈 (P3-15 の model 伝搬):
 *   - isRemote: Remote/Remote Nano 系か。SDK は TRIGGER_DELAYTIME(191) publish を
 *     device.isRemote() のときだけ delegate へ流す (CHRemoteNanoEventHandler.kt:15-21。BLEP-09)。
 *     false を渡すと 191 は「処理済み・dispatch 無し」(SDK の handled=true と同義)。
 *     省略 (null) 時は機種不明として従来どおり dispatch する (後方互換。ファサード経由では
 *     BiometricCommands が model から確定値を渡す)。
 *   - isOpenSensor: OpenSensor 系か。PUB_KEY_SESAME(102) の空きスロット判定が >1 になる
 *     (CHSesameBiometricDeviceImpl.kt:225-231。BLEP-11)。既定 false。
 * @returns {boolean} 生体 capability として処理したら true
 *
 * delegate コールバック (SDK CH*Delegate.kt 1:1):
 *   card:        onCardReceiveStart/onCardReceive/onCardReceiveEnd/onCardChanged/onCardModeChanged/onCardDelete
 *   fingerPrint: onFingerPrintReceiveStart/onFingerPrintReceive/onFingerPrintReceiveEnd/onFingerPrintChanged/onFingerModeChange/onFingerDelete
 *   passcode:    onKeyBoardReceiveStart/onKeyBoardReceive/onKeyBoardReceiveEnd/onKeyBoardChanged/onKeyBoardModeChange/onKeyBoardDelete
 *   face:        onFaceReceiveStart/onFaceReceive/onFaceReceiveEnd/onFaceChanged/onFaceModeChanged/onFaceDeleted
 *   palm:        onPalmReceiveStart/onPalmReceive/onPalmReceiveEnd/onPalmChanged/onPalmModeChanged/onPalmDeleted
 *   remoteNano:  onTriggerDelaySecondReceived({triggerDelaySecond})  (CHRemoteNanoDelegate.kt)
 *   radar:       onRadarReceive(payload:Buffer)                      (CHDeviceConnectDelegate.kt onRadarReceive)
 *   mechStatus:  onMechStatus(status)  status = parseBiometricMechStatus の結果
 *                  (CHSesameBiometricDeviceImpl.kt:214-217 handleMechStatus + CHDeviceStatusDelegate.onMechStatus)
 *   pubKey:      onSesameKeysReceived({keys,slotFull,emptySlotCount})
 *                  (kt:219-255 handlePubKeySesame + ObservableMutableMap.setSlotFull)。
 *                  ※ slotFull の OpenSensor 判定 (>1) は opts.isOpenSensor で切り替わる (BLEP-11)。
 *   battery:     onBatteryVoltageReceived(payloadHex)  (kt:185-187 reportBatteryData(payload.toHexString()))
 *   support:     onSupportChanged(false)               (kt:189-192 setSupport(false))
 *   bleTxPower:  onBleTxPowerReceive(txPower)           (kt:194-197 bleTxPower=payload[0]、符号付き 1B)
 */
export function handleBiometricPublish(pkt: BiometricPublishPacket, delegate: BiometricDelegate, device?: unknown, { isRemote, isOpenSensor }?: {
    isRemote?: (boolean | null);
    isOpenSensor?: boolean;
}): boolean;
/**
 * card / passcode の enroll publish を 1 登録セッション単位に集約し、セッション終端
 * (*_LAST) で sink へ渡す delegate を生成する。戻り値は BiometricCommands.registerDelegate /
 * handleBiometricPublish にそのまま渡せる delegate オブジェクト。
 *
 * 集約レコードは parseTouchCard 由来の { cardID, cardName, cardType } (NOTIFY で渡る 3 値) に、
 * 取れる場合は **ファームウェア採番の nameUUID** を加えた 4 値 (P3-11)。
 *
 * nameUUID の出典トレース:
 *   - BLE NOTIFY/ack payload の「名前」位置 ([type 1B][idLen 1B][id idLen B][nameLen 1B][name nameLen B]、
 *     CHSesameBiometricParseData.kt:10-17 CHSesameTouchCard) に、ファームはタップ登録時に
 *     **自前で採番した 16B UUID** を載せる。biz3 web は同じ位置のフィールドを `nameUUID` として
 *     読み (references_web/src/utils/biz3utils.js:365-391 parseHexStrToCardInfo: id の後の
 *     [nameUUIDLen 1B][nameUUID 16B]。passcode は :393-420 parseHexStrToPasscodeInfo で id 枠 16B
 *     固定の後に同形)、タップ登録の ack ではこの値を updateCardName へそのまま渡して DB と
 *     ファームの nameUUID を一致させる (references_web/src/pages/biz/cards/index.js:104-136)。
 *   - よって BLE 側では parseTouchCard の cardName (hex) が名前位置のフィールドであり、
 *     それが 16B (= 32 hex) のとき「ファーム採番の nameUUID」とみなして record.nameUUID に載せる。
 *     16B でない場合 (ユーザーが短い表示名へ rename 済み等) は省略する (取れない種別では省略可)。
 *   - 値は parseTouchFace と同じ方針で **ハイフン無し hex (小文字)** のまま返す。web の表示は
 *     insertUUIDIsolationCharacter (biz3utils.js:236-238) でハイフン整形しているだけで、識別子と
 *     しての値は hex と同値 (ハイフン整形は消費側 access.js の責務)。
 *
 * sink には kind ('card'|'passcode') と集約配列を渡すだけで、DB へどう載せるか
 * (access.toPostCardList → access.postCards 等) は呼び出し側が決める。
 *
 * 集約済みの 1 enroll セッション分のレコード。
 * @typedef {Object} EnrollRecord
 * @property {string} cardID
 * @property {string} cardName
 * @property {number} cardType
 * @property {string} [nameUUID] ファームウェア採番の nameUUID (32hex 小文字・ハイフン無し)。
 *   NOTIFY の名前フィールドが 16B のときのみ存在 (P3-11。access.js 側が postCards/updateCardName
 *   の同期に消費する)。
 *
 * @typedef {Object} EnrollBatch
 * @property {'card'|'passcode'} kind
 * @property {EnrollRecord[]} records
 * @property {unknown} device
 *
 * @param {{onEnrolled?: (batch: EnrollBatch) => void, card?: boolean, passcode?: boolean}} [cfg]
 *   onEnrolled: 1 セッション分が出揃った (= *_LAST 受信) 時に呼ばれる。records が空でも呼ぶ (空登録の検知用)。
 *   card/passcode: それぞれの enroll を集約するか (既定 true)。
 * @returns {BiometricDelegate} handleBiometricPublish 用 delegate (onCardReceive* / onKeyBoardReceive* を実装)
 */
export function createEnrollCollector({ onEnrolled, card, passcode }?: {
    onEnrolled?: (batch: EnrollBatch) => void;
    card?: boolean;
    passcode?: boolean;
}): BiometricDelegate;
/**
 * GET 要求 → publish(FIRST → NOTIFY×N → LAST/END) を収集し、END または timeout で確定する。
 *
 * serve の collectWifiScan (registry.js) と同パターン:
 *   1. registerDelegate でコールバックを登録する
 *   2. getter を呼ぶ (ack は即返るが実データは publish で来る)
 *   3. END コールバック or timeout で resolve する
 *
 * spec.single=true の場合 (face/palm): recv コールバックは (device, obj) の形で
 *   obj がパース済みオブジェクト。false (card/passcode/finger): (device, id, name, cardType) の
 *   形で {id, name(UTF-8化), type} に整形する。
 *
 * @param {Record<string, Function>} cmds  BiometricCommands インスタンス (registerDelegate + getter を持つ)
 * @param {BioSpec} spec  BIO_LIST の 1 entry
 * @param {number} timeoutMs
 * @returns {Promise<unknown[]>}
 */
export function collectBiometricList(cmds: Record<string, Function>, spec: BioSpec, timeoutMs: number): Promise<unknown[]>;
/**
 * BiometricCommands が消費する session の最小契約 (SesameBleSession 互換)。
 * @typedef {Object} BiometricSession
 * @property {(itemCode: number, data: Buffer, opts?: object) => Promise<{resultCode:number, payload:Buffer}>} request
 * @property {(fn: (pkt: BiometricPublishPacket) => void) => (() => void)} [onPublish]
 */
export class BiometricCommands {
    /**
     * @param {BiometricSession} session SesameBleSession 互換 (request(itemCode,data)→Promise<{resultCode,payload}> と
     *                         onPublish(fn)→unsubscribe を持つこと)。
     * @param {{model?:(string|null)}} [opts] model: デバイス model 文字列 (例 "remote_nano")。
     *   渡すと publish ディスパッチに機種文脈が伝搬する (P3-15 の model 伝搬):
     *     - isRemote: TRIGGER_DELAYTIME(191) を remote/remote_nano 以外で黙殺 (BLEP-09、
     *       CHRemoteNanoEventHandler.kt:15-21)
     *     - isOpenSensor: PUB_KEY_SESAME の空きスロット判定を >1 に (BLEP-11、
     *       CHSesameBiometricDeviceImpl.kt:225-231)
     *   省略時は機種不明として従来挙動 (191 dispatch あり / 非 OpenSensor 判定)。
     */
    constructor(session: BiometricSession, { model }?: {
        model?: (string | null);
    });
    /**
     * 登録モード設定。応答後にデバイスが CARD_FIRST/NOTIFY/LAST を push する。
     * @param {number} mode
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    cardModeSet(mode: number): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    cardModeGet(): Promise<number>;
    /** @returns {Promise<{resultCode:number, payload:Buffer}>} */
    cardGet(): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** @param {Buffer} id @param {string} hexName @returns {Promise<{resultCode:number, payload:Buffer}>} */
    cardAdd(id: Buffer, hexName: string): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** @param {string} cardID @returns {Promise<{resultCode:number, payload:Buffer}>} */
    cardDelete(cardID: string): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** @param {string} cardId @param {string} touchProUUID @returns {Promise<{resultCode:number, payload:Buffer}>} */
    cardMove(cardId: string, touchProUUID: string): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** @param {string} ID @param {string} hexName @returns {Promise<{resultCode:number, payload:Buffer}>} */
    cardChange(ID: string, hexName: string): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** @param {string} ID @param {string} newID @returns {Promise<{resultCode:number, payload:Buffer}>} */
    cardChangeValue(ID: string, newID: string): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * card の一括登録 (STP 分割転送)。STP_ITEM_CODE_CARDS_ADD で送る。
     * @param {Buffer} id @param {(current:number,total:number)=>void} [progress]
     */
    cardBatchAdd(id: Buffer, progress?: (current: number, total: number) => void): Promise<void>;
    /** @param {number} mode @returns {Promise<{resultCode:number, payload:Buffer}>} */
    fingerPrintModeSet(mode: number): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    fingerPrintModeGet(): Promise<number>;
    /** @returns {Promise<{resultCode:number, payload:Buffer}>} */
    fingerPrints(): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** @param {string} fingerPrintID @returns {Promise<{resultCode:number, payload:Buffer}>} */
    fingerPrintDelete(fingerPrintID: string): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** @param {string} ID @param {string} hexName @returns {Promise<{resultCode:number, payload:Buffer}>} */
    fingerPrintChange(ID: string, hexName: string): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** @param {number} mode @returns {Promise<{resultCode:number, payload:Buffer}>} */
    passcodeModeSet(mode: number): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    passcodeModeGet(): Promise<number>;
    /** @returns {Promise<{resultCode:number, payload:Buffer}>} */
    passcodeGet(): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** @param {Buffer} id @param {string} hexName @returns {Promise<{resultCode:number, payload:Buffer}>} */
    passcodeAdd(id: Buffer, hexName: string): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** @param {string} keyBoardPassCodeID @returns {Promise<{resultCode:number, payload:Buffer}>} */
    passcodeDelete(keyBoardPassCodeID: string): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** @param {string} cardId @param {string} touchProUUID @returns {Promise<{resultCode:number, payload:Buffer}>} */
    passcodeMove(cardId: string, touchProUUID: string): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** @param {string} ID @param {string} hexName @returns {Promise<{resultCode:number, payload:Buffer}>} */
    passcodeChange(ID: string, hexName: string): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * passcode の一括登録 (STP 分割転送)。STP_ITEM_CODE_PASSCODES_ADD で送る。
     * @param {Buffer} data @param {(current:number,total:number)=>void} [progress]
     */
    passcodeBatchAdd(data: Buffer, progress?: (current: number, total: number) => void): Promise<void>;
    /** @param {number} mode @returns {Promise<{resultCode:number, payload:Buffer}>} */
    faceModeSet(mode: number): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    faceModeGet(): Promise<number>;
    /** @returns {Promise<{resultCode:number, payload:Buffer}>} */
    faceListGet(): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** @param {string} ID @param {string} name @returns {Promise<{resultCode:number, payload:Buffer}>} */
    faceChange(ID: string, name: string): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** @param {string} faceID @returns {Promise<{resultCode:number, payload:Buffer}>} */
    faceDelete(faceID: string): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** @param {number} mode @returns {Promise<{resultCode:number, payload:Buffer}>} */
    palmModeSet(mode: number): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    palmModeGet(): Promise<number>;
    /** @returns {Promise<{resultCode:number, payload:Buffer}>} */
    palmListGet(): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** @param {string} palmID @returns {Promise<{resultCode:number, payload:Buffer}>} */
    palmDelete(palmID: string): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * Remote Nano のトリガ遅延秒を設定する (CHRemoteNanoCapableImpl.setTriggerDelayTime と 1:1)。
     * itemCode 190 + [time(UByte 1B)]。応答後にデバイスが TRIGGER_DELAYTIME(191) を push しうる
     * (publish は registerDelegate の onTriggerDelaySecondReceived で受ける)。
     * @param {number} time 0..255 (秒)
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    setTriggerDelay(time: number): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * Face のレーダー感度パラメータを設定する (CHDeviceConnectCapableImpl.setRadarSensitivity と 1:1)。
     * itemCode 200 + payload を無加工で送る。payload 構造は SDK 側でも不透明 (生バイト)。
     * 受信 (RADAR_PARAM_PUBLISH=201) は registerDelegate の onRadarReceive で生 payload を受ける。
     * @param {Buffer} payload レーダーパラメータの生バイト列
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    setRadarSensitivity(payload: Buffer): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * 子 Sesame の鍵を connector デバイスへ追加する (CHDeviceConnectCapableImpl.insertSesame と 1:1)。
     * OS3 子鍵は `{deviceUUID, secretKey}`、OS2 子鍵はそれに `sesame2PublicKey` を加えて渡す。
     * @param {{deviceUUID:string, secretKey:string|Buffer, sesame2PublicKey?:string|Buffer}} sesame
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    insertSesame(sesame: {
        deviceUUID: string;
        secretKey: string | Buffer;
        sesame2PublicKey?: string | Buffer;
    }): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * 子 Sesame の鍵を connector デバイスから削除する (CHDeviceConnectCapableImpl.removeSesame と 1:1)。
     * PUB_KEY_SESAME の parse 結果で keyType=0x04 なら OS2、0x05 なら OS3 として payload を切り替える。
     * @param {string} tag 削除対象 Sesame UUID
     * @param {{keyType?:number}} [opts]
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    removeSesame(tag: string, opts?: {
        keyType?: number;
    }): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * publish 受信を delegate に結線する (session.onPublish へ handleBiometricPublish を登録)。
     * コンストラクタへ渡した model から確定した機種文脈 (isRemote / isOpenSensor) を
     * handleBiometricPublish へ伝搬する (BLEP-09 / BLEP-11)。
     * @param {BiometricDelegate} delegate handleBiometricPublish の delegate
     * @param {unknown} [device] コールバックへ素通しする識別子
     * @returns {() => void} unsubscribe (session.onPublish が無ければ no-op)
     */
    registerDelegate(delegate: BiometricDelegate, device?: unknown): () => void;
    /**
     * 実機タップ登録 (enroll) を 1 セッション単位に集約し、終端で onEnrolled へ渡す delegate を
     * 結線する registerDelegate の薄いショートカット。BLE=実機の責務はここまでで、onEnrolled の
     * 中で access.postCards/postPasscodes を呼ぶ (= DB 同期) かは呼び出し側が決める
     * (本クラスは access.js を知らない)。createEnrollCollector + registerDelegate と等価。
     *
     * @param {(batch: EnrollBatch) => void} onEnrolled
     * @param {{card?:boolean, passcode?:boolean, device?:unknown}} [opts]
     * @returns {() => void} unsubscribe
     */
    onEnroll(onEnrolled: (batch: EnrollBatch) => void, { card, passcode, device }?: {
        card?: boolean;
        passcode?: boolean;
        device?: unknown;
    }): () => void;
}
export { STP_ITEM_CODES as STP_ITEM };
/**
 * 生体タイプ別の「GET メソッド名」と「収集に使う delegate コールバック名」。
 * CLI (cli/ble.js) と serve (registry.js の専用収集ハンドラ) の両方が参照する。
 * @typedef {{ getter: string, start: string, recv: string, end: string, single?: boolean }} BioSpec
 */
/**
 * card/passcode/finger/face/palm ごとの spec 表。
 * 出典: BiometricCommands の各 getter (cardGet/passcodeGet/fingerPrints/faceListGet/palmListGet) と
 *   registerDelegate の delegate コールバック名 (CHCard/PassCode/FingerPrint/Face/PalmEventHandlers.kt)。
 * @type {Readonly<Record<string, BioSpec>>}
 */
export const BIO_LIST: Readonly<Record<string, BioSpec>>;
/**
 * `biometric` サブファサード (Touch / Touch Pro / Face / Palm の card/passcode/face/palm 登録 +
 * connector 共通面) の RPC 公開仕様。
 *
 * 各 op の出典 (位置引数の意味・順序の裏取り):
 *   card:     CHCardCapableImpl.kt:38-174 (cardModeGet/Set:38,49 / cardAdd:83 / cardDelete:60 /
 *             cardMove:72 / cardChange:158 / cardChangeValue:169)
 *   passcode: CHPassCodeCapableImpl.kt:27-130 (keyBoardPassCode* — modeGet/Set:27,33 / add:39 /
 *             delete:113 / move:119 / change:130)
 *   face:     CHFaceCapableImpl.kt:22-51 (faceModeSet:22 / faceModeGet:29 / faceListGet:39 /
 *             faceChange:45 / faceDelete:51)
 *   palm:     CHPalmCapableImpl.kt:19-42 (palmModeSet:19 / palmModeGet:26 / palmListGet:36 / palmDelete:42)
 *   connect:  CHDeviceConnectCapableImpl.kt:23-95 (insertSesame:23 / removeSesame:52 / setRadarSensitivity:89)
 * @type {import("./index.js").BleRpcOpSpec}
 */
export const BIOMETRIC_RPC_OPS: import("./index.js").BleRpcOpSpec;
/**
 * `fingerPrint` サブファサード (SESAME Bike3 の指紋登録、CHFingerPrintCapable) の RPC 公開仕様。
 * Bike3 は card/passcode/face/palm を持たず指紋のみ。registerDelegate は除外 (publish 購読の
 * ローカルコールバック登録)。
 *
 * 出典: CHFingerPrintCapableImpl.kt:20-64 (fingerPrintModeGet:20 / fingerPrintModeSet:31 /
 *   fingerPrintDelete:42 / fingerPrints:53 / fingerPrintsChange:64)。
 * ※ ファサード公開名は `fingerPrintChange` (SDK の fingerPrintsChange に対応、index.js fingerPrint ゲッタ)。
 * @type {import("./index.js").BleRpcOpSpec}
 */
export const FINGERPRINT_RPC_OPS: import("./index.js").BleRpcOpSpec;
/**
 * `remoteNano` サブファサード (Remote / Remote Nano 専用面、connector 共通面 + trigger delay) の
 * RPC 公開仕様。registerDelegate は除外 (publish 購読のローカルコールバック登録)。
 *
 * ★ 公開名 `setTriggerDelayTime` は SDK CHRemoteNanoCapable.kt:8 と 1:1 (index.js remoteNano ゲッタが
 *   BiometricCommands.setTriggerDelay へ委譲)。読み出しコマンドは SDK に無い (現在値は
 *   TRIGGER_DELAYTIME(191) publish が運び registerDelegate で受ける) ため getTriggerDelay 等は無い。
 *
 * 出典: CHRemoteNanoCapableImpl.kt:19-28 (setTriggerDelayTime) /
 *   CHDeviceConnectCapableImpl.kt:23-95 (insertSesame:23 / removeSesame:52 / setRadarSensitivity:89)。
 * @type {import("./index.js").BleRpcOpSpec}
 */
export const REMOTE_NANO_RPC_OPS: import("./index.js").BleRpcOpSpec;
/**
 * publish パケット 1 件 (session.onPublish が渡す {opCode, itemCode, body})。
 */
export type BiometricPublishPacket = {
    itemCode: number;
    body?: Buffer;
    payload?: Buffer;
};
/**
 * handleBiometricPublish が呼ぶ delegate。全コールバックは任意 (未定義なら no-op)。
 * 第1引数は呼び出し側が渡す device トークン (省略可)。SDK CH*Delegate.kt と 1:1。
 */
export type BiometricDelegate = {
    onCardReceiveStart?: ((device?: unknown) => void) | undefined;
    onCardReceive?: ((device: unknown, cardID: string, cardName: string, cardType: number) => void) | undefined;
    onCardReceiveEnd?: ((device?: unknown) => void) | undefined;
    onCardChanged?: ((device: unknown, cardID: string, cardName: string, cardType: number) => void) | undefined;
    onCardModeChanged?: ((device: unknown, mode: number) => void) | undefined;
    onCardDelete?: ((device: unknown, cardID: string) => void) | undefined;
    onFingerPrintReceiveStart?: ((device?: unknown) => void) | undefined;
    onFingerPrintReceive?: ((device: unknown, cardID: string, cardName: string, cardType: number) => void) | undefined;
    onFingerPrintReceiveEnd?: ((device?: unknown) => void) | undefined;
    onFingerPrintChanged?: ((device: unknown, cardID: string, cardName: string, cardType: number) => void) | undefined;
    onFingerModeChange?: ((device: unknown, mode: number) => void) | undefined;
    onFingerDelete?: ((device: unknown, id: string) => void) | undefined;
    onKeyBoardReceiveStart?: ((device?: unknown) => void) | undefined;
    onKeyBoardReceive?: ((device: unknown, cardID: string, cardName: string, cardType: number) => void) | undefined;
    onKeyBoardReceiveEnd?: ((device?: unknown) => void) | undefined;
    onKeyBoardChanged?: ((device: unknown, cardID: string, cardName: string, cardType: number) => void) | undefined;
    onKeyBoardModeChange?: ((device: unknown, mode: number) => void) | undefined;
    onKeyBoardDelete?: ((device: unknown, id: string) => void) | undefined;
    onFaceReceiveStart?: ((device?: unknown) => void) | undefined;
    onFaceReceive?: ((device: unknown, face: ReturnType<typeof parseTouchFace>) => void) | undefined;
    onFaceReceiveEnd?: ((device?: unknown) => void) | undefined;
    onFaceChanged?: ((device: unknown, face: ReturnType<typeof parseTouchFace>) => void) | undefined;
    onFaceModeChanged?: ((device: unknown, mode: number) => void) | undefined;
    onFaceDeleted?: ((device: unknown, faceID: number, ok: boolean) => void) | undefined;
    onPalmReceiveStart?: ((device?: unknown) => void) | undefined;
    onPalmReceive?: ((device: unknown, face: ReturnType<typeof parseTouchFace>) => void) | undefined;
    onPalmReceiveEnd?: ((device?: unknown) => void) | undefined;
    onPalmChanged?: ((device: unknown, face: ReturnType<typeof parseTouchFace>) => void) | undefined;
    onPalmModeChanged?: ((device: unknown, mode: number) => void) | undefined;
    onPalmDeleted?: ((device: unknown, palmID: number, ok: boolean) => void) | undefined;
    onTriggerDelaySecondReceived?: ((device: unknown, setting: ReturnType<typeof parseRemoteNanoTrigger>) => void) | undefined;
    onRadarReceive?: ((device: unknown, payload: Buffer) => void) | undefined;
    onMechStatus?: ((device: unknown, status: ReturnType<typeof parseBiometricMechStatus>) => void) | undefined;
    onSesameKeysReceived?: ((device: unknown, keys: ReturnType<typeof parsePubKeySesame>) => void) | undefined;
    onBatteryVoltageReceived?: ((device: unknown, payloadHex: string) => void) | undefined;
    onSupportChanged?: ((device: unknown, support: boolean) => void) | undefined;
    onBleTxPowerReceive?: ((device: unknown, txPower: number) => void) | undefined;
};
/**
 * card / passcode の enroll publish を 1 登録セッション単位に集約し、セッション終端
 * (*_LAST) で sink へ渡す delegate を生成する。戻り値は BiometricCommands.registerDelegate /
 * handleBiometricPublish にそのまま渡せる delegate オブジェクト。
 *
 * 集約レコードは parseTouchCard 由来の { cardID, cardName, cardType } (NOTIFY で渡る 3 値) に、
 * 取れる場合は **ファームウェア採番の nameUUID** を加えた 4 値 (P3-11)。
 *
 * nameUUID の出典トレース:
 *   - BLE NOTIFY/ack payload の「名前」位置 ([type 1B][idLen 1B][id idLen B][nameLen 1B][name nameLen B]、
 *     CHSesameBiometricParseData.kt:10-17 CHSesameTouchCard) に、ファームはタップ登録時に
 *     **自前で採番した 16B UUID** を載せる。biz3 web は同じ位置のフィールドを `nameUUID` として
 *     読み (references_web/src/utils/biz3utils.js:365-391 parseHexStrToCardInfo: id の後の
 *     [nameUUIDLen 1B][nameUUID 16B]。passcode は :393-420 parseHexStrToPasscodeInfo で id 枠 16B
 *     固定の後に同形)、タップ登録の ack ではこの値を updateCardName へそのまま渡して DB と
 *     ファームの nameUUID を一致させる (references_web/src/pages/biz/cards/index.js:104-136)。
 *   - よって BLE 側では parseTouchCard の cardName (hex) が名前位置のフィールドであり、
 *     それが 16B (= 32 hex) のとき「ファーム採番の nameUUID」とみなして record.nameUUID に載せる。
 *     16B でない場合 (ユーザーが短い表示名へ rename 済み等) は省略する (取れない種別では省略可)。
 *   - 値は parseTouchFace と同じ方針で **ハイフン無し hex (小文字)** のまま返す。web の表示は
 *     insertUUIDIsolationCharacter (biz3utils.js:236-238) でハイフン整形しているだけで、識別子と
 *     しての値は hex と同値 (ハイフン整形は消費側 access.js の責務)。
 *
 * sink には kind ('card'|'passcode') と集約配列を渡すだけで、DB へどう載せるか
 * (access.toPostCardList → access.postCards 等) は呼び出し側が決める。
 *
 * 集約済みの 1 enroll セッション分のレコード。
 */
export type EnrollRecord = {
    cardID: string;
    cardName: string;
    cardType: number;
    /**
     * ファームウェア採番の nameUUID (32hex 小文字・ハイフン無し)。
     * NOTIFY の名前フィールドが 16B のときのみ存在 (P3-11。access.js 側が postCards/updateCardName
     * の同期に消費する)。
     */
    nameUUID?: string | undefined;
};
/**
 * card / passcode の enroll publish を 1 登録セッション単位に集約し、セッション終端
 * (*_LAST) で sink へ渡す delegate を生成する。戻り値は BiometricCommands.registerDelegate /
 * handleBiometricPublish にそのまま渡せる delegate オブジェクト。
 *
 * 集約レコードは parseTouchCard 由来の { cardID, cardName, cardType } (NOTIFY で渡る 3 値) に、
 * 取れる場合は **ファームウェア採番の nameUUID** を加えた 4 値 (P3-11)。
 *
 * nameUUID の出典トレース:
 *   - BLE NOTIFY/ack payload の「名前」位置 ([type 1B][idLen 1B][id idLen B][nameLen 1B][name nameLen B]、
 *     CHSesameBiometricParseData.kt:10-17 CHSesameTouchCard) に、ファームはタップ登録時に
 *     **自前で採番した 16B UUID** を載せる。biz3 web は同じ位置のフィールドを `nameUUID` として
 *     読み (references_web/src/utils/biz3utils.js:365-391 parseHexStrToCardInfo: id の後の
 *     [nameUUIDLen 1B][nameUUID 16B]。passcode は :393-420 parseHexStrToPasscodeInfo で id 枠 16B
 *     固定の後に同形)、タップ登録の ack ではこの値を updateCardName へそのまま渡して DB と
 *     ファームの nameUUID を一致させる (references_web/src/pages/biz/cards/index.js:104-136)。
 *   - よって BLE 側では parseTouchCard の cardName (hex) が名前位置のフィールドであり、
 *     それが 16B (= 32 hex) のとき「ファーム採番の nameUUID」とみなして record.nameUUID に載せる。
 *     16B でない場合 (ユーザーが短い表示名へ rename 済み等) は省略する (取れない種別では省略可)。
 *   - 値は parseTouchFace と同じ方針で **ハイフン無し hex (小文字)** のまま返す。web の表示は
 *     insertUUIDIsolationCharacter (biz3utils.js:236-238) でハイフン整形しているだけで、識別子と
 *     しての値は hex と同値 (ハイフン整形は消費側 access.js の責務)。
 *
 * sink には kind ('card'|'passcode') と集約配列を渡すだけで、DB へどう載せるか
 * (access.toPostCardList → access.postCards 等) は呼び出し側が決める。
 *
 * 集約済みの 1 enroll セッション分のレコード。
 */
export type EnrollBatch = {
    kind: "card" | "passcode";
    records: EnrollRecord[];
    device: unknown;
};
/**
 * BiometricCommands が消費する session の最小契約 (SesameBleSession 互換)。
 */
export type BiometricSession = {
    request: (itemCode: number, data: Buffer, opts?: object) => Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    onPublish?: ((fn: (pkt: BiometricPublishPacket) => void) => (() => void)) | undefined;
};
/**
 * 生体タイプ別の「GET メソッド名」と「収集に使う delegate コールバック名」。
 * CLI (cli/ble.js) と serve (registry.js の専用収集ハンドラ) の両方が参照する。
 */
export type BioSpec = {
    getter: string;
    start: string;
    recv: string;
    end: string;
    single?: boolean;
};
import { Buffer } from "node:buffer";
import { STP_ITEM_CODES } from "../itemcodes.js";
//# sourceMappingURL=biometric.d.ts.map
<!-- spec-domain: ble-os3 | prefix: BLE3 | tests: packages/core/tests/ble, packages/kit/tests/ble, packages/kit/tests/serve, packages/kit/tests/cli -->

# BLE OS3 直結 spec (BLE3)

OS3 デバイス直結(scan/register/session/biometric/fingerprint/remoteNano/WiFi(WM2)/Hub3 provisioning/magnet/history/script/firmware 他)を Android SesameSDK(Kotlin)に照らして payload バイト列・itemCode・mech status まで監査する。lock 動詞(lock/unlock/toggle/click/autolock)は lock.md(LOCK)へ。

## advertisement

BLE manufacturerData/deviceName から SESAME 判定・model/kind・deviceUUID・各種フラグを切り出す広告パース。company ID ゲートと機種別レイアウト分岐が SesameSDK の Sesame2BleAdvertisement と一致することを固定する。

### [BLE3-0001] parseAdvertisement: company ID 0x055A ゲート (LE 5A 05) で SESAME 判定
- surface: core
- backend: ble
- command: `parseAdvertisement / advToDeviceUUID`
- branch: company一致 | company不一致(null) | 長さ不足(null)
- assert: manufacturerData 先頭 2B が LE 0x055A でなければ null を返す。advBytes[i]=md[i+2] の ADV_OFF=2 補正が SDK CHadv (advBytes=manufacturerSpecificData.valueAt(0) で company ID 除去済み座標) と一致する
- ref: packages/core/src/ble/transport.js:177; packages/core/src/ble/protocol.js:31; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/Sesame2BleAdvertisement.kt:31
- kind: payload-fidelity
- status: planned
- note: COMPANY_ID=0x055A (protocol.js:31)。company ゲートの実コードは transport.js:177 (b[0]/b[1] を LE で照合)。ADV_OFF=2 補正は transport.js:96+180、advBytes 座標の起点は Kotlin :31 (valueAt(0)=company ID 除去後)。

### [BLE3-0002] parseAdvertisement: productType→model/kind マッピング (advBytes[0])
- surface: core
- backend: ble
- command: `parseAdvertisement`
- branch: 既知productType | 未知productType(model=null/kind=unknown)
- assert: advBytes[0] (=md[2]) を productType として PRODUCT_TYPES で model/kind を引く。未知は model=null/kind=UNKNOWN (操作を捏造しない)。CHProductModel.getByValue(copyOfRange(0,1)) と一致
- ref: packages/core/src/ble/transport.js:181; packages/core/src/ble/devicemodel.js:190; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/Sesame2BleAdvertisement.kt:37
- kind: payload-fidelity
- status: planned
- note: transport.js:181 productType=a(0)、:182-184 で PRODUCT_TYPES 引き+未知時 model=null/kind=UNKNOWN。PRODUCT_TYPES 定義は devicemodel.js:190。Kotlin :37 getByValue(copyOfRange(0,1)) と一致。

### [BLE3-0003] parseAdvertisement: SS5/Touch/Face deviceUUID = advBytes[3..18] 16B
- surface: core
- backend: ble
- command: `parseAdvertisement / advToDeviceUUID`
- branch: SS5レイアウト | 長さ不足(deviceUUID=null)
- assert: SS5/Bot2/Bike2/OpenSensor/Remote は advBytes[3..18] (md[5..21)) の 16B をそのまま UUID 化する。Sesame2BleAdvertisement.kt:82-84 sliceArray(3..18).noHashtoUUID() と一致
- ref: packages/core/src/ble/transport.js:218; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/Sesame2BleAdvertisement.kt:82
- kind: payload-fidelity
- status: planned
- note: 実抽出行は transport.js:218 subarray(ADV_OFF+3, ADV_OFF+19)=md[5..21) (旧 217 は length>=ADV_OFF+19 のガード行)。Kotlin :82 sliceArray(3..18) (inclusive 16B)、:84 noHashtoUUID と一致。

### [BLE3-0004] parseAdvertisement: WM2 deviceUUID = prefix + advBytes[3..9) 6B / isConnectable=last()==0
- surface: core
- backend: ble
- command: `parseAdvertisement`
- branch: wm_2 model
- assert: WM2 は '00000000055afd810001' + advBytes[3..9) 6B hex を UUID 化し、isConnectable は advBytes.last()==0。Sesame2BleAdvertisement.kt:50-51 と一致
- ref: packages/core/src/ble/transport.js:196; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/Sesame2BleAdvertisement.kt:50
- kind: payload-fidelity
- status: planned
- note: transport.js:196 wm_2 分岐、:200 prefix+subarray(ADV_OFF+3,ADV_OFF+9) 6B、:202 isConnectable=b[last]===0。WM2_UUID_PREFIX は :111 で定義。Kotlin :50 isConnecable=(last()==0)、:51 wm2ID=copyOfRange(3,9) と一致。

### [BLE3-0005] parseAdvertisement: Hub3 deviceUUID = prefix + advBytes[2..8) 6B
- surface: core
- backend: ble
- command: `parseAdvertisement`
- branch: hub_3 | hub_3_lte
- assert: Hub3/Hub3_LTE は '00000000055afd810d00' + advBytes[2..8) 6B hex を UUID 化する。Sesame2BleAdvertisement.kt:60 と一致
- ref: packages/core/src/ble/transport.js:203; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/Sesame2BleAdvertisement.kt:60
- kind: payload-fidelity
- status: planned
- note: transport.js:203 isHub3 分岐 (:190 で model==hub_3||hub_3_lte 判定)、:206-207 prefix+subarray(ADV_OFF+2,ADV_OFF+8) 6B。HUB3_UUID_PREFIX は :112 で定義。Kotlin :60 copyOfRange(2,8)+'...0d00' prefix と一致。

### [BLE3-0006] parseAdvertisement: isRegistered bit 位置が Hub3 と他で非対称 (advBytes[1] vs [2])
- surface: core
- backend: ble
- command: `parseAdvertisement`
- branch: Hub3系(advBytes[1] bit0) | その他(advBytes[2] bit0)
- assert: Hub3/Hub3_LTE は isRegistered=(advBytes[1] and 1)、それ以外は (advBytes[2] and 1)。Matter 二合一広播の保留字圧縮を反映。Sesame2BleAdvertisement.kt:39-44 と一致
- ref: packages/core/src/ble/transport.js:191; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/Sesame2BleAdvertisement.kt:39
- kind: payload-fidelity
- status: planned
- note: 実コード行は transport.js:191 isRegistered=isHub3?(a(1)&1):(a(2)&1) (旧 190 は isHub3 判定行)。Kotlin :39-44 if(Hub3||Hub3_LTE) advBytes[1] else advBytes[2]、:41 のコメント (Matter 二合一広播の保留字圧縮) と一致。

### [BLE3-0007] parseAdvertisement: adv_tag_b1 = (advBytes[2] and 2)>0 (履歴有無フラグ)
- surface: core
- backend: ble
- command: `parseAdvertisement`
- branch: -
- assert: adv_tag_b1 = (advBytes[2] and 2) > 0。Sesame2BleAdvertisement.kt:33 と一致
- ref: packages/core/src/ble/transport.js:187; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/Sesame2BleAdvertisement.kt:33
- kind: payload-fidelity
- status: planned
- note: transport.js:187 advTagB1=(a(2)&0b10)>0 が Kotlin :33 (advBytes[2] and 2)>0 と一致。両行とも実在を確認済み。

### [BLE3-0008] os2NameToUuid: OS2 機種 deviceUUID = (deviceName+'==') base64decodeHex noHashtoUUID
- surface: core
- backend: ble-os2
- command: `os2NameToUuid / parseAdvertisement`
- branch: OS2 productType (SS2/Bot1/Bike1/SS4) | base64長16B不一致(null)
- assert: OS2 機種は manufacturerData でなく BLE deviceName から導出: (deviceName+'==') を base64 decode→16B でなければ null。Sesame2BleAdvertisement.kt:69 / DataExtention.kt:36-46 と一致
- ref: packages/core/src/ble/transport.js:137; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/Sesame2BleAdvertisement.kt:69; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/utils/DataExtention.kt:36-46
- kind: payload-fidelity
- status: planned
- note: OS2 backend だが OS3 transport が同関数で処理。長さ不正→null (Kotlin catch→null) の写像。DataExtention.kt:36 base64decodeHex / :41 noHashtoUUID。

## discovery

近接デバイス列挙とフィルタ。未知機種/deviceUUID=null/非 SESAME を列挙対象外にし、操作を捏造しない。

### [BLE3-0009] peripheralToDiscovery: 未知機種/deviceUUID=null を列挙対象外
- surface: core
- backend: ble
- command: `peripheralToDiscovery / listNearbyDevices`
- branch: 既知機種 | includeUnknown | deviceUUID=null(除外) | SESAMEでない(除外)
- assert: advertise が SESAME でない/deviceUUID=null/(既定で)未知機種 (model=null) のとき null を返し列挙しない。CHBleManager.kt onScanResult の productModel?.let フィルタと dedup (getOrPut) を反映
- ref: packages/core/src/ble/transport.js:482; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/CHBleManager.kt:135; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/CHBleManager.kt:136; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/Sesame2BleAdvertisement.kt:37
- kind: option-branch
- status: planned
- note: peripheralToDiscovery (transport.js:482) は !parsed→null (:486)、!parsed.deviceUUID→null (:487)、!includeUnknown && model===null→null (:489)。CHBleManager.kt onScanResult(:129) 内 productModel?.let フィルタ(:135) と chDeviceMap.getOrPut(deviceID) dedup(:136)。productModel 導出は Sesame2BleAdvertisement.kt:37 (getByValue→未知は null)。

## transport

GATT 定数・write リトライ・disconnect 二重発火防止・noble 子プロセスプローブ。NobleTransport 層の堅牢化。

### [BLE3-0010] GATT 定数 (service fd81 / write 16860002 / notify 16860003)
- surface: core
- backend: ble
- command: `GATT / NobleTransport.connect`
- branch: 既定SESAME GATT | WM2_GATT 注入
- assert: discover/subscribe する GATT が service=fd81 (0000fd81-..)、WRITE=16860002-..、NOTIFY=16860003-.. (SesameProtocols.kt:81-83 Sesame2Chracs) と一致。WM2 は専用 GATT (WM2_GATT) を注入
- ref: packages/core/src/ble/protocol.js:24; packages/core/src/ble/transport.js:664; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:81
- kind: contract-existence
- status: planned
- note: protocol.js:24 = GATT (SERVICE fd81 / WRITE 16860002 / NOTIFY 16860003)、transport.js:664 = discoverSomeServicesAndCharacteristicsAsync(this._gatt.SERVICE,...)、_gatt は opts.gatt||GATT (transport.js:609)。WM2_GATT は wm2.js:46。

### [BLE3-0011] write 有限回リトライ→全失敗で onDisconnect 発火 (fail-fast)
- surface: core
- backend: ble
- command: `NobleTransport._writeWithRetry`
- branch: 成功 | リトライ後成功 | 全失敗(disconnect+rethrow) | 既切断(notConnected)
- assert: writeAsync 失敗時に指数バックオフ (20..320ms, WRITE_MAX_RETRIES=5) で再送し、全失敗でリンク断扱い (_handleDisconnect→onDisconnect→pending fail-fast) としつつ最後の error を rethrow する。CHSesameOS3.kt:321-346 transmit のリトライ→disconnect と同流儀
- ref: packages/core/src/ble/transport.js:703; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/base/CHSesameOS3.kt:266
- kind: error-path
- status: planned
- note: SDK の 30000 回 (CHSesameOS3.kt:321-340 do/while + retry>30000 break → disconnect{}) はそのまま移植せず妥当な少数回 (WRITE_MAX_RETRIES=5, transport.js:105-106) に縮小 (調査仕様で許容)。transmit() は CHSesameOS3.kt:266、retry→disconnect は :321-346 で確認。

### [BLE3-0012] peripheral disconnect / write 失敗の onDisconnect 二重発火防止
- surface: core
- backend: ble
- command: `NobleTransport._handleDisconnect / disconnect`
- branch: peripheral'disconnect' | write全失敗 | 能動disconnect(コールバック抑止)
- assert: _disconnected フラグで onDisconnect を 1 回だけ発火し、能動 disconnect() 時は session へのコールバックを抑止しリスナを外す (write失敗とperipheral disconnect の競合で二重処理しない)
- ref: packages/core/src/ble/transport.js:733; packages/core/src/ble/transport.js:741
- kind: idempotency
- status: planned
- note: _handleDisconnect は transport.js:733 で _disconnected ガード後 onDisconnect を1回発火 (:734-738)。disconnect() は :741 で _disconnected=true / _onDisconnect=null / removeListener('disconnect') (:744-750)。_writeWithRetry 全失敗時も :724 で _handleDisconnect 経由。local-contract。

### [BLE3-0013] noble 子プロセスプローブで SIGABRT 由来エラーを SesameError 化
- surface: core
- backend: ble
- command: `loadNoble / probeBleAvailability / waitPoweredOn`
- branch: ok(in-process) | noAdapter(BLE_NO_ADAPTER) | aborted(UNAUTHORIZED/UNSUPPORTED) | poweredOff/unauthorized/unsupported/timeout
- assert: noble state アクセスでの SIGABRT を子プロセスで起こさせ生死を観測し、aborted/noAdapter/unauthorized/unsupported を retryable 付き SesameError (BLE_* code) にマップする (state を本プロセスで触る前に止める)
- ref: packages/core/src/ble/transport.js:312; packages/core/src/ble/transport.js:339; packages/core/src/ble/transport.js:360; packages/core/src/ble/transport.js:391
- kind: error-path
- status: planned
- note: probeBleAvailability(:312-328) が spawnSync で子プロセス実行し STATE:/LOADERR:/(signal=SIGABRT→aborted) を分類。bleAbortError(:339-350) が darwin→BLE_UNAUTHORIZED / 他→BLE_UNSUPPORTED にマップ。loadNoble(:360) が noAdapter→BLE_NO_ADAPTER / aborted→bleAbortError。waitPoweredOn(:391-418) が unauthorized/poweredOff/unsupported/timeout を各 BLE_* SesameError 化 (INIT_TIMEOUT のみ retryable:true)。純ローカル契約寄り。

## framing

セグメント分割/結合 (20B チャンク) と送受信フレームの op/item/body レイアウト・OP/SEG/RESULT enum 完全性。

### [BLE3-0014] splitSegments/SegmentAssembler: header=(type<<1)|startBit、20B チャンク
- surface: core
- backend: ble
- command: `splitSegments / SegmentAssembler.feed`
- branch: 単一セグメント | 複数セグメント(APPEND_ONLY中間) | 空payload
- assert: 先頭パケットのみ startBit、最終で parsingType、中間は APPEND_ONLY。受信は startBit でリセットし APPEND_ONLY は継続。SesameBleReceiver.kt feed/getChunk と一致
- ref: packages/core/src/ble/protocol.js:277; packages/core/src/ble/protocol.js:309; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameBleReceiver.kt:16
- kind: payload-fidelity
- status: planned
- note: 正源は SesameBleReceiver.kt:16-17 (isStartFlag=flag&1, parsingType=flag>>1)・:43 (segmentHeader=((type.value shl 1) or isStart))・:47 (copyOf(19) → 19B+header1B=20B)・:25 (parsingType>0 で完結、else 継続)。protocol.js:277 splitSegments の header=(parsingType<<1)|first・MAX_CHUNK_DATA=19、:309 feed の header&1 リセット/header>>1 が 1:1 対応。SEG 値 (APPEND_ONLY=0/PLAINTEXT=1/CIPHERTEXT=2) は kit 側列挙 (protocol.js:46)。

### [BLE3-0015] buildSendFrame/parseRecvFrame: 送信=[item]++data、受信=[op][item][body]
- surface: core
- backend: ble
- command: `buildSendFrame / parseRecvFrame`
- branch: response(7) | publish(8) | 長さ<2(throw)
- assert: 送信フレームは op_code を付けず [item]++data (CHSesameOS3.kt:497 toDataWithHeader = byteArrayOf(itemCode)+data)。受信は notify が op_code を剥がし (SesameNotifypayload.kt:10-12)、続けて [item][body] を読む。response(7) は body=[resultCode][payload] (SSM3ResponsePayload.kt:22-25)、publish(8) は body=payload (SSM3PublishPayload.kt:5-7)。op による分岐は CHSesameOS3.kt:144-148
- ref: packages/core/src/ble/protocol.js:330; packages/core/src/ble/protocol.js:340; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/base/CHSesameOS3.kt:495; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/base/CHSesameOS3.kt:144; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:22
- kind: wire-fidelity
- status: planned
- note: protocol.js:330=buildSendFrame, :340=parseRecvFrame。CHSesameOS3.kt:495-497=SesameOS3Payload.toDataWithHeader (送信 op 無し)。受信側 op 剥がし+item/body 分割は CHSesameOS3.kt:144-148 が SesameNotifypayload(op)→SSM3ResponsePayload(item,result,payload)/SSM3PublishPayload(item,payload) へ振り分ける形で支持。

### [BLE3-0016] OP/SEG/RESULT enum 完全性 (SesameProtocols.kt と 1:1)
- surface: core
- backend: local
- command: `OP / SEG / RESULT / resultName`
- branch: 既知code | 未知code(unknown(N)) | 未検証9(隔離)
- assert: OP (SSM2OpCode: create..publish/undefine0x10, SesameProtocols.kt:57)・SesameResultCode (success0..INVALID_PARAM8 で終端, SesameProtocols.kt:29)・resultName が参照と 1:1。未検証 9(invalidAction) は UNVERIFIED_RESULT_NAMES に隔離し resultName から除外
- ref: packages/core/src/ble/protocol.js:34; packages/core/src/ble/protocol.js:58; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:57; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:29
- kind: contract-existence
- status: planned
- note: protocol.js:34=OP enum, :58=RESULT enum, resultName=:85。SesameResultCode 値は SesameProtocols.kt:29 (success0..INVALID_PARAM8 で終端、9 不在)。OP(SSM2OpCode) 値は :57 (create0x01..publish0x08,undefine0x10)。SEG は protocol.js では SesameBleReceiver.kt 由来で SesameProtocols.kt には無いため assert は OP/RESULT/resultName のみに限定。

## crypto

AES-128-CMAC/CCM/ECDH の決定的ベクタ。実機不要の KAT。

### [BLE3-0017] aesCmac (RFC 4493) 既知応答ベクタ
- surface: core
- backend: local
- command: `aesCmac`
- branch: 空メッセージ | 16B | 非16B倍数 | 大メッセージ
- assert: 内製 AES-128-CMAC が RFC 4493 §4 の Test Vector (空/16/40/64B) を満たす (deriveSessionKey/loginPayload の基盤)。node-aes-cmac 置換後も同一出力
- ref: packages/core/src/aes-cmac.js:44; references_web/src/utils/Cmac.js:112
- kind: crypto-vector
- status: planned
- note: aesCmac export は aes-cmac.js:44。tests/crypto/aes-cmac.test.js が RFC 4493 §4 Example 1-4 (len 0/16/40/64B) を期待値 bb1d6929.../070a16b4... 等で固定。一次出典は RFC 4493 §4。references_web/src/utils/Cmac.js は web 実装の参考 (置換前出力同一性の対照)。

### [BLE3-0018] deriveSessionKey: sessionKey16 = AES-128-CMAC(secretKey16, token4)
- surface: core
- backend: ble
- command: `deriveSessionKey`
- branch: secretKey長≠16(throw) | token長≠4(throw)
- assert: 通常 login の session 鍵が CMAC(secretKey, token4) (16B) になる。CHSesameOS3LockBase.kt:109 sessionAuth と一致
- ref: packages/core/src/ble/protocol.js:138; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/base/CHSesameOS3LockBase.kt:109
- kind: crypto-vector
- status: planned
- note: backend は ble だが KAT は決定的 (実機不要)。CHSesameOS3LockBase.kt:109 = AesCmac(secretKey,16).computeMac(mSesameToken) 確認済み。

### [BLE3-0019] ccmEncrypt/Decrypt: AES-128-CCM, AAD=[0x00], tag 4B 既知ベクタ
- surface: core
- backend: ble
- command: `ccmEncrypt / ccmDecrypt`
- branch: 正常復号 | tag不一致(throw)
- assert: AES-128-CCM (AAD=0x00, authTagLength=4) の暗号化→復号がラウンドトリップし、tag 改竄で復号 throw。c_ccm.c / SesameOS3BleCipher.kt:16-19,27-31 と一致
- ref: packages/core/src/ble/protocol.js:240; packages/core/src/ble/protocol.js:257; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/base/SesameOS3BleCipher.kt:16
- kind: crypto-vector
- status: planned
- note: protocol.js:240 ccmEncrypt (setAAD CCM_AAD=[0x00], getAuthTag 末尾4B) / :257 ccmDecrypt (setAuthTag→final で改竄 throw)。SesameOS3BleCipher.kt:16 GCMParameterSpec(32)/18 updateAAD(0)/19 doFinal、復号は 27-31。確認済み。

### [BLE3-0020] ccmNonce: nonce = count(8B LE) ++ sault、lock sault=0x00++token4 (13B)
- surface: core
- backend: ble
- command: `ccmEncrypt / ccmDecrypt / ccmSault`
- branch: lock profile (nonce 13B)
- assert: lock の CCM nonce が encryptCounter(8B LE) ++ (0x00++token4) の 13B になる。SesameOS3BleCipher.kt:13 nonce + CHHub3Device.kt:174 '00'+token と一致
- ref: packages/core/src/ble/protocol.js:208; packages/core/src/ble/protocol.js:222; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/base/SesameOS3BleCipher.kt:13; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:174
- kind: crypto-vector
- status: planned
- note: GCMParameterSpec(32,...) = CCM tag 4B (32bit)。CCM_TAG_LEN=4 (protocol.js:89) と整合。protocol.js:208 ccmNonce / :222 ccmSault(lock→0x00++token4) / SesameOS3BleCipher.kt:13 nonce=counter.toBytes()+sault 確認済み。

## session

login/initial/time 同期など OS3 lock セッションの確立挙動。

### [BLE3-0021] loginPayload(lock): [LOGIN(2)] ++ sessionKey[0:4] = 5B
- surface: core
- backend: ble
- command: `loginPayload`
- branch: lock profile
- assert: lock の login 平文 = [2] ++ token16[0:4] の 5B (sessionAuth.sliceArray(0..3))。CHSesameOS3LockBase.kt:118-120 と一致
- ref: packages/core/src/ble/protocol.js:191; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/base/CHSesameOS3LockBase.kt:119
- kind: payload-fidelity
- status: planned
- note: protocol.js:194 が lock 経路 [ITEM.LOGIN] ++ token16[0:4]、ITEM.LOGIN=2 (protocol.js:101,182 注記)。CHSesameOS3LockBase.kt:119 = SesameOS3Payload(login.value, sessionAuth.sliceArray(0..3)) 確認済み。

### [BLE3-0022] 受信 dec counter は doFinal 前に inc (復号失敗でも counter 前進)
- surface: core
- backend: ble
- command: `SesameBleSession._onPacket`
- branch: 復号成功 | 復号失敗(frame捨て・counter前進)
- assert: 暗号フレーム受信で usedCount=decCount を採ってから decCount++ し、復号失敗時もその 1 フレームのみ捨てて counter は進める。SesameOS3BleCipher.kt:25 decryptCounter.inc() を doFinal の前に行う挙動と一致
- ref: packages/core/src/ble/session.js:733; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/base/SesameOS3BleCipher.kt:25
- kind: idempotency
- status: planned
- note: 取りこぼし/破損後も後続フレームと整合維持 (進めないと恒久ずれ)。実際の usedCount=this._decCount / this._decCount+=1 は session.js:733-734。SesameOS3BleCipher.kt:25 = decryptCounter.inc() (doFinal は :31) 確認済み。

### [BLE3-0023] initial token は 4B 固定: 長さ≠4 で login/ready 待機者を即 reject
- surface: core
- backend: ble
- command: `SesameBleSession._handleInitial`
- branch: token=4B(正常) | <4B(reject) | >4B(reject)
- assert: initial publish の token が 4B でなければ <4 も >4 も同一 fail-fast で _loginWaiter/_readyWaiter を reject する (旧実装は <4 をログのみ return で宙づり)。sault=0x00++token4(13B nonce) の前提を守る
- ref: packages/core/src/ble/session.js:811; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:174
- kind: error-path
- status: planned
- note: session.js:811 = if(!token||token.length!==4) fail-fast 確認済み。4B 前提を確立する CHHub3Device.kt:174 ('00'+mSesameToken→5B sault→13B nonce) に紐付け。

### [BLE3-0024] initial 受信→secretKey 無しで ReadyToRegister 遷移 (login しない)
- surface: core
- backend: ble
- command: `SesameBleSession._handleInitial / register`
- branch: secretKey有(login) | secretKey無(ReadyToRegister)
- assert: secretKey 未設定で initial を受けたとき login を試みず _readyToRegister=true へ遷移し _readyWaiter を resolve する。CHSesameOS3.kt:489 isRegistered=false → deviceStatus=ReadyToRegister と一致
- ref: packages/core/src/ble/session.js:830; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/base/CHSesameOS3.kt:489
- kind: option-branch
- status: planned
- note: session.js:830 `if (!this._secretKey)` ガード→830-839 で _readyToRegister=true + _readyWaiter resolve、840-868 が secretKey 有の login 経路。Kotlin CHSesameOS3.kt:488-490 else 分岐 (line 489 = ReadyToRegister 代入) と 1:1。

### [BLE3-0025] login 応答 resultCode==0 で loggedIn、非0 で BleResultError(login)
- surface: core
- backend: ble
- command: `SesameBleSession._handleLoginResponse`
- branch: resultCode=0(success) | 非0(reject)
- assert: login response の resultCode が 0 なら _loggedIn=true で resolve、非0 なら BleResultError('login', code) で reject する。SesameProtocols.kt:29 SesameResultCode (success(0U)..INVALID_PARAM(8U)) と一致
- ref: packages/core/src/ble/session.js:962; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:29
- kind: error-path
- status: planned
- note: session.js:967 resultCode===0→_loggedIn=true+resolve (977)、979 else→BleResultError('login', resultCode)。SesameProtocols.kt:28 enum 宣言・:29 が success(0U)..INVALID_PARAM(8U) の全値。

### [BLE3-0026] login 後 time(8) 同期: デバイス時刻差 >3s でのみ送出 (lock+syncTime)
- surface: core
- backend: ble
- command: `SesameBleSession._maybeSyncTime / needsTimeSync`
- branch: 差>3s(送出) | 差<=3s(無送出) | Hub3/WM2/生体(syncTime=false)
- assert: login 応答 payload[0..3] のデバイス秒と端末秒の abs 差が >3 のときだけ time(8) を CIPHERTEXT 送出。profile=lock かつ syncTime のみ。CHSesameOS3LockBase.kt:128-138 (abs(timeMinus)>3 → cipher time) と一致
- ref: packages/core/src/ble/session.js:988; packages/core/src/ble/protocol.js:542; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/base/CHSesameOS3LockBase.kt:128
- kind: payload-fidelity
- status: planned
- note: session.js:976 `if (this._profile==='lock' && this._syncTime) this._maybeSyncTime`、_maybeSyncTime(988) は needsTimeSync(protocol.js:542 abs>3) を見て ITEM.TIME を _sendCipher。Kotlin :130 abs(timeMinus)>3 → DeviceSegmentType.cipher。index.js:444 が kind=HUB3/WIFI/BIOMETRIC で syncTime=false を渡す。

### [BLE3-0027] syncTime ゲート: HUB3/WIFI/BIOMETRIC kind では login 後 time 同期しない
- surface: core
- backend: ble
- command: `SesameBle constructor (syncTime 導出)`
- branch: lock系(syncTime=true) | HUB3/WIFI/BIOMETRIC(false)
- assert: ファサードが caps.kind から syncTime を導出し、HUB3/WIFI/BIOMETRIC は false を session へ渡す (login override で handleLoginResponse を呼ばない SDK 挙動と一致)。CHHub3Device.kt:167-178 (login override が deviceStatus=Unlocked のみで handleLoginResponse 不呼出)
- ref: packages/core/src/ble/index.js:444; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:167
- kind: option-branch
- status: planned
- note: index.js:444 `syncTime: !(caps.kind===KIND.HUB3 || KIND.WIFI || KIND.BIOMETRIC)`。Kotlin CHHub3Device.kt:167 `override fun login(token)` は :175-177 で sendCommand 後 deviceStatus=Unlocked のみ、CHSesameOS3LockBase.handleLoginResponse を呼ばない。

## session-establish

connect/register の再入ガード・孤児 Promise 後始末・disconnect 時 fail-fast。

### [BLE3-0028] _isBusy 再入ガード: 二重 connect/register を alreadyConnected で拒否
- surface: core
- backend: ble
- command: `SesameBleSession.connect / register`
- branch: 初回 | login済/待機者進行中(reject)
- assert: login 済みまたは login/ready/register いずれかの待機者が進行中のとき connect()/register() を alreadyConnected で reject する (待機者上書き・古い token 流用を防ぐ)
- ref: packages/core/src/ble/session.js:192; packages/core/src/ble/session.js:234
- kind: error-path
- status: planned
- note: session.js:192-195=_isBusy (_loggedIn||_readyToRegister||3 待機者非 null)、:234=connect の alreadyConnected reject、:298=register 側の同 reject。local-contract 的だが SDK の 1 接続 1 セッション前提を反映。

### [BLE3-0029] connect 失敗時の孤児 login Promise 後始末 (unhandledRejection 抑止)
- surface: core
- backend: ble
- command: `SesameBleSession.connect`
- branch: transport.connect 成功 | 失敗(待機者clear+no-op catch)
- assert: transport.connect() が throw したとき _loginWaiter を即 clear し loginPromise に no-op catch を付けて rethrow する (孤児 Promise の unhandledRejection を発生させない。P1-1)
- ref: packages/core/src/ble/session.js:247; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/base/CHSesameOS3.kt:247
- kind: error-path
- status: planned
- note: session.js:247-257=try/catch で _loginWaiter clear + loginPromise.catch(()=>{}) + rethrow。register() 側も同型の readyPromise 後始末 (session.js:316-321)。Kotlin ref は JS 固有の unhandledRejection 対策に対する弱い類比 (CHSesameOS3.kt:247=STATE_DISCONNECTED 時 cmdCallBack.clear) — 本境界の主源は session.js:247。

### [BLE3-0030] transport 切断通知で pending/3待機者を fail-fast (timeout 宙づり防止)
- surface: core
- backend: ble
- command: `SesameBleSession._handleTransportDisconnect / _failAllPending`
- branch: 切断通知 | 能動disconnect
- assert: transport onDisconnect で全 pending request と login/ready/register 待機者を linkLost で reject し、状態フラグを倒す。CHSesameOS3.kt:247-248 STATE_DISCONNECTED → cmdCallBack.clear() と一致
- ref: packages/core/src/ble/session.js:426; packages/core/src/ble/session.js:447; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/base/CHSesameOS3.kt:247
- kind: error-path
- status: planned
- note: session.js:426-437=_failAllPending (pending 全 reject + _rejectWaiter x3 + フラグ倒し)、:447-450=_handleTransportDisconnect が linkLost で _failAllPending。CHSesameOS3.kt:247-248=if STATE_DISCONNECTED { cmdCallBack.clear() } 完全一致。i18n ble.linkLost (ble.js:44) 実在。

### [BLE3-0031] connect login 失敗時にファサードが transport を disconnect (GATT リーク防止)
- surface: core
- backend: ble
- command: `SesameBle.connect`
- branch: login成功 | login失敗(disconnect後rethrow)
- assert: login timeout/signLogin throw/非0 resultCode で失敗したとき、確立済み GATT 接続+notify をリークさせないよう disconnect してから rethrow する (connectMany/use の失敗パスと対称)
- ref: packages/core/src/ble/index.js:891; packages/core/src/ble/index.js:1180
- kind: error-path
- status: planned
- note: index.js:891 (catch 内 await this._session.disconnect().catch(()=>{}) + throw err)、:1180 (connectMany catch 内 ble.close().catch)。use の対称 close は index.js:1147。

### [BLE3-0032] connectMany: 1 スキャンで近接ロックへ並行接続、圏外を unreachable
- surface: core
- backend: ble
- command: `SesameBle.connectMany`
- branch: 全接続 | 一部圏外(unreachable) | 接続失敗(failed+close)
- assert: 1 回のスキャンで対象 deviceUUID を集め、圏外は unreachable、見つかったものは並行 connect+login し、失敗は failed に積んで close する (per-device scan timeout を払わない)
- ref: packages/core/src/ble/index.js:1160; packages/core/src/ble/index.js:856
- kind: idempotency
- status: planned
- note: connectMany(:1160) は scanSesames を1回呼び (:1161)、byNorm に無い entry を unreachable へ (:1172)、inRange を Promise.all で並行 connect (:1175-1181)、connect() (:856) は login まで含む (:848-864)、失敗は failed.push + ble.close() (:1180)。local-contract (マルチ接続の正攻法)。

## server-auth

signGuestKey 経由のサーバ署名 login と sentinel 自動判定。@experimental 実機未検証。

### [BLE3-0033] signGuestKey login: initial token を署名→サーバ署名 token を session 鍵に
- surface: core
- backend: ble
- command: `SesameBleSession._loginViaServer / connect({signLogin})`
- branch: needAuthFromServer=true(signLogin経路) | false(ローカル鍵)
- assert: isNeedAuthFromServer のとき deriveSessionKey を使わず signLogin(tokenHex) の戻り (16B hex) を session 鍵として平文 login する。CHSesameOS3.kt:474-482 signGuestKey→onSuccess{login(it.data)} と一致
- ref: packages/core/src/ble/session.js:876; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/base/CHSesameOS3.kt:474
- kind: wire-fidelity
- status: planned
- note: session.js:864 `if (this._signLogin) { this._loginViaServer(); return; }`、_loginViaServer(876) が signLogin(token.hex) の戻りを _key にして loginPayload を _sendPlain (894, login は PLAINTEXT)。connect({signLogin}) 受口は session.js:229/235。Kotlin :474 signGuestKey→:482 login(it.data)。

### [BLE3-0034] server token 長検証: signLogin 戻りが 16B でないと login 待機者を reject
- surface: core
- backend: ble
- command: `SesameBleSession._loginViaServer`
- branch: 16B(login) | 非16B(reject) | signLogin throw(reject)
- assert: signGuestKey の戻りが 16B でなければ _loginWaiter を明示 reject し、signLogin が throw した場合もその error で reject する (黙って login しない)。SDK は CHSesameOS3.kt:481-482 で onSuccess のみ処理し長さ検証/onFailure 分岐を持たない → JS はそれを上回るローカル堅牢化
- ref: packages/core/src/ble/session.js:888; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/base/CHSesameOS3.kt:481
- kind: error-path
- status: planned
- note: Kotlin は onSuccess のみで 16B 長検証も onFailure 分岐も持たないため、JS の 16B-reject (session.js:888) と throw-reject (catch→883) は SDK を上回るローカル堅牢化 (local-contract 寄り)。primary ref session.js:888 が assert を支持。

### [BLE3-0035] sentinel 自動判定: secretKey に '000000' を含むと needAuthFromServer 有効化
- surface: core
- backend: ble
- command: `SesameBle constructor / connect`
- branch: 明示needAuthFromServer | sentinel自動検出 | registerTransport無(明示エラー)
- assert: 呼び出し元が needAuthFromServer 未指定かつ secretKey が '000000' を含むとき server-auth を自動有効化する。CHBaseDevice.kt:115 isNeedAuthFromServer = it.secretKey.contains('000000') と一致
- ref: packages/core/src/ble/index.js:457; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/CHBaseDevice.kt:115
- kind: option-branch
- status: planned
- note: index.js:456 callerSetNeedAuth='needAuthFromServer' in opts、:457 sentinelDetected (未指定 & 非registerMode & secretKey.includes('000000'))、:458 で OR 合成。Kotlin CHBaseDevice.kt:115 sesame2KeyData setter 内 `isNeedAuthFromServer = it.secretKey.contains("000000")` と同条件。@experimental 実機未検証。sentinel 検出時 registerTransport 無は接続前に明示エラー (index.js:866)。

### [BLE3-0036] WM2 profile に server-auth 経路なし: signLogin 指定で明示 reject
- surface: core
- backend: ble
- command: `SesameBleSession._handleInitial (wm2)`
- branch: wm2 + signLogin(reject)
- assert: wm2 profile で _signLogin が設定されているとき黙って無視せず明示エラーで login 待機者を reject する (CHWifiModule2Device.login(token) override が token を使わないため op を捏造しない)
- ref: packages/core/src/ble/session.js:847; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:314
- kind: error-path
- status: planned
- note: session.js:847 が wm2 分岐内の if(this._signLogin)、reject は 850 行 (ble.wm2NoServerAuth)。CHWifiModule2Device.kt:314 の login(token) override は token 引数を無視し loginTag=AesCmac(secretKey).computeMac(token) を送るのみで isNeedAuthFromServer 経路を持たない。

## register

ECDH 登録ハンドシェイク。pubK 送出・registrationData レイアウト・応答 pubkey 抽出・失敗系。SS5(77B)/Bot-Bike(67B)/wm2 形は実機応答未検証。

### [BLE3-0037] register: ECDH 生公開鍵は 0x04 prefix を剥がした 64B で送る
- surface: core
- backend: ble
- command: `SesameBleSession.register`
- branch: 65B(0x04付き正常→剥がす) | 非65B/prefix不正(throw)
- assert: Node createECDH の getPublicKey() 65B (0x04++X32++Y32) から先頭 1B を剥がして 64B raw (X||Y) を registrationData へ渡す。EccKey.getPubK() の prefix 無し 64B 契約と一致
- ref: packages/core/src/ble/session.js:342; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/utils/EccKey.kt:23; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:197
- kind: payload-fidelity
- status: planned
- note: session.js は getPublicKey()=65B 取得後 (:342)、length!==65||[0]!==0x04 で throw (:343-346)、subarray(1) で 64B raw 化 (:347)。EccKey.kt:23-25 getPubK() = public.encoded.toHexString().cutEccHeader() (prefix 剥がし=64B hex)。CHHub3Device.kt:197 が EccKey.getPubK()++timestamp4 を registration へ送出。

### [BLE3-0038] registrationData(lock): pubK64 ++ timestamp4 = 68B、PLAINTEXT 送出
- surface: core
- backend: ble
- command: `registrationData / session.register`
- branch: lock profile(68B) | pubK長≠64(throw)
- assert: REGISTRATION(1) の data が EccKey.getPubK()(64B prefix無) ++ currentTimeMillis().toUInt32ByteArray()(4B) の 68B になり、平文セグメントで送られる。CHHub3Device.kt:194-199 / CHSesameOS3LockBase.kt:93 と一致
- ref: packages/core/src/ble/protocol.js:674; packages/core/src/ble/session.js:360; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:194
- kind: payload-fidelity
- status: planned
- note: protocol.js:674=registrationData 定義 (lock で 64+4=68B, wm2 で 64B のみ, len≠64 throw)、session.js:360=REGISTRATION を DeviceSegmentType.plain 相当で _sendPlain。CHHub3Device.kt:194 が sendCommand 開始 (pubK++ts は 197 行)、CHSesameOS3LockBase.kt:93 が pubK++toUInt32ByteArray 行。

### [BLE3-0039] registrationTimestampBytes: 秒値下位32bit を LE 4B (固定ベクタ fa89b85f)
- surface: core
- backend: local
- command: `registrationTimestampBytes / timeSyncData`
- branch: -
- assert: toUInt32ByteArray の移植: ms=1605929466482 → 'fa89b85f' を返す。DataExtention.kt:138-150 のコメント値 (1605929466.48249 → 'fa89b85f') と一致
- ref: packages/core/src/ble/protocol.js:627; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/utils/DataExtention.kt:138
- kind: crypto-vector
- status: planned
- note: 純算術 (ネットワーク非依存) のため backend local。DataExtention.kt:138 (toUInt32ByteArray 定義, 139/150 にベクタコメント) が定義かつ 'fa89b85f' コメントベクタを持つ。protocol.js:627=registrationTimestampBytes 定義で確認。

### [BLE3-0040] ECDH 共有秘密先頭16B → secretKey(wm2Key) を hex 確定
- surface: core
- backend: ble
- command: `ecdhSecretPre16 / session.register`
- branch: -
- assert: EccKey.ecdh(devicePubK64).sliceArray(0..15) = pre16 を hex 化したものが確定 secretKey になる。CHHub3Device.kt:201-204 / CHSesame5Device.kt:204 と一致
- ref: packages/core/src/ble/session.js:381; packages/core/src/crypto.js:447; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:201
- kind: crypto-vector
- status: planned
- note: session.js:381=const pre16 = ecdhSecretPre16(keyPair, devicePubK)、続く secretKey=pre16.toString('hex')。crypto.js:447=ecdhSecretPre16 定義 (ecdhSharedSecret(...).subarray(0,16) の独立コピー)。CHHub3Device.kt:201=EccKey.ecdh(IRRes.payload).sliceArray(0..15)、204=ecdhSecret.sliceArray(0..15).toHexString() で deviceSecret/wm2Key 確定。

### [BLE3-0041] deriveSessionKeyFromEcdh: 登録後 session 鍵 = CMAC(ecdhPre16, token4)
- surface: core
- backend: ble
- command: `deriveSessionKeyFromEcdh / session.register`
- branch: lock profile | ecdhPre16長≠16(throw)
- assert: 登録直後の session 鍵が ECDH 共有秘密先頭16B を鍵とした CMAC(pre16, token4) (16B) になる。CHHub3Device.kt:206 AesCmac(ecdhSecretPre16,16).computeMac(mSesameToken) と一致
- ref: packages/core/src/ble/protocol.js:172; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:206
- kind: crypto-vector
- status: planned
- note: protocol.js:172=deriveSessionKeyFromEcdh 定義 (pre16 長 16 を検証し deriveSessionKey へ委譲, ≠16 throw)。CHHub3Device.kt:206=val sessionAuth = AesCmac(ecdhSecretPre16,16).computeMac(mSesameToken)。session.js:357 で lock 時 deriveSessionKeyFromEcdh(pre16, token) を採用。

### [BLE3-0042] register 応答 pubkey 抽出: 機種別レイアウト分岐 (64/67/77B)
- surface: core
- backend: ble
- command: `SesameBleSession._extractRegisterDevicePubK`
- branch: 64B(Hub3全体) | 67B(Bot/Bike mech3B++pubk64) | 77B(SS5 mech7B++setting6B++pubk64) | 長さ外(throw)
- assert: REGISTRATION 応答から device 公開鍵 64B を機種別に切り出す: 64B=全体、67B=[3..66]、77B=[13..76]。CHSesame5Device.kt:200-202 / CHSesameBot2Device.kt:216-218 / CHHub3Device.kt:201 と一致
- ref: packages/core/src/ble/session.js:927; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesame5Device.kt:200
- kind: payload-fidelity
- status: planned
- note: session.js:927=_extractRegisterDevicePubK 定義 (wm2=先頭64B, 64B=全体, 67B=[3,67), 77B=[13,77), それ以外 throw)。CHSesame5Device.kt:200 が mechStatus[0..6]/setting[7..12]/pubk[13..76] 切り出し、CHSesameBot2Device.kt:216 が catch 分岐の mechStatus[0..2]++pubk[3..66]。SS5(77B)/Bot-Bike(67B)/wm2 形は実機応答未検証 (README Known limitations)。

### [BLE3-0043] register 失敗 (非0 resultCode/timeout) で REGISTRATION 待機者を reject
- surface: core
- backend: ble
- command: `SesameBleSession._handleRegistrationResponse / register`
- branch: resultCode=0(resolve) | 非0(BleResultError) | timeout(reject)
- assert: REGISTRATION 応答 resultCode!=0 で BleResultError('command', code, REGISTRATION(1)) を reject、応答無しは REGISTER_TIMEOUT_MS で reject する
- ref: packages/core/src/ble/session.js:898; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/base/CHSesameOS3.kt:415
- kind: error-path
- status: planned
- note: session.js:898=_handleRegistrationResponse (resultCode===0 で resolve、非0 で BleResultError('command',resultCode,ITEM.REGISTRATION) reject @904)。timeout は register() の REGISTER_TIMEOUT_MS setTimeout (session.js:352-356)。CHSesameOS3.kt:415 = 汎用コマンド結果失敗パターン (else→NSError(cmdResultCode...))。SDK の Hub3 register コールバック自身は resultCode を判定せず isRegistered=true とするため、kit 側は汎用コマンド失敗契約で REGISTRATION を強化する形 (実機 OS3 未検証)。

### [BLE3-0044] register: secretKey 付きセッションで呼ぶと registerNeedsFactory で拒否
- surface: core
- backend: ble
- command: `SesameBleSession.register / SesameBle.register`
- branch: registerMode | secretKey付き(reject) | deviceUUID無(reject)
- assert: secretKey ありで register() を呼ぶと registerNeedsFactory で reject、deviceUUID 無は registerDeviceUUIDRequired で reject。ファサードは事前に registerNeedsFactoryFacade で案内する
- ref: packages/core/src/ble/session.js:292; packages/core/src/ble/index.js:917
- kind: error-path
- status: planned
- note: session.js:292=registerNeedsFactory reject / :293=registerDeviceUUIDRequired reject、index.js:917=!_registerMode&&_secretKey で registerNeedsFactoryFacade throw。i18n キー (ble.js:47,51,53) 実在。

### [BLE3-0045] registerOnce: register reject 時も try/finally で必ず close
- surface: core
- backend: ble
- command: `SesameBle.registerOnce`
- branch: 成功 | registerTimeout/notReady/pubkey長/ECDH失敗(close)
- assert: registerOnce は ble 構築直後から try/finally で囲み、register の reject 時も含め必ず close() して GATT 接続をリークさせない
- ref: packages/core/src/ble/index.js:1141; packages/core/src/ble/index.js:1147
- kind: error-path
- status: planned
- note: index.js:1141=try / :1143=await ble.register / :1146=finally / :1147=await ble.close().catch(()=>{})。ble 構築 (:1136) 直後から finally 保護され、register reject 時も close する。

## request-fifo

itemCode ごとの FIFO 相関と能力ゲート。

### [BLE3-0046] request: item ごと FIFO キューで response を 1:1 消費
- surface: core
- backend: ble
- command: `SesameBleSession.request / _resolvePending`
- branch: resultCode=0(resolve) | 非0(BleResultError command) | timeout(dequeue+reject) | unsolicited(無視)
- assert: 同一 itemCode の request は FIFO キューに積まれ、response を FIFO 順に 1:1 で消費して resolve/reject する。timeout は該当 entry を dequeue。対応 request 無しの response は無視 (unsolicited)
- ref: packages/core/src/ble/session.js:489; packages/core/src/ble/session.js:1000
- kind: idempotency
- status: planned
- note: session.js:489 request は _pending.get(itemCode).push(entry)、timeout で _dequeue(itemCode,entry)+reject。session.js:1000 _resolvePending は queue 空なら return(unsolicited)、shift() で FIFO 1:1、resultCode===0→resolve / 非0→reject(BleResultError('command',resultCode,itemCode))。P3-27 意図的乖離: SDK(CHSesameOS3.kt:354-372)は in-flight 再送抑止するが kit は毎回送信。

### [BLE3-0047] _assertOp: BLE 非対応 op を機種能力で弾く (opNotSupported)
- surface: core
- backend: ble
- command: `SesameBle._assertOp / lock/unlock/click/autolock`
- branch: caps.ble に含む | 含まない(opNotSupported)
- assert: lock 動詞 (lock/unlock/click/toggle/autolock) の _assertOp 能力ゲートは [[LOCK-0065]] が正典 (cross-ref)
- ref: local-contract
- kind: error-path
- status: waived: 重複（正典 [[LOCK-0065]]）
- note: 正典 [[LOCK-0065]]。_assertOp は lock 動詞専用の能力ゲートのため lock.md(LOCK) が正典。本エントリは ID 保持で waive。

## control

lock/unlock/click/toggle/autolock/position/magnet/opsensor/txpower/advProductType の送信レイアウト。lock 動詞自体は LOCK ドメインだが BLE payload バイト列はここ。

### [BLE3-0048] lock/unlock/click data = [0x00,0x0E] ++ historyTag、先頭20B
- surface: core, serve, sdk
- backend: ble
- command: `SesameBle.lock / unlock / click / historyTagBLE`
- branch: tag省略([0x00,0x0E]) | tag付き(20B切詰) | 非Buffer(throw)
- assert: lock/unlock/click の data=[0x00,0x0E]++historyTag 20B 切詰めと itemCode(82/83/89) は [[LOCK-0051]]/[[LOCK-0052]]/[[LOCK-0053]]/[[LOCK-0054]] が正典 (cross-ref)
- ref: local-contract
- kind: payload-fidelity
- status: waived: 重複（正典 [[LOCK-0051]]）
- note: 正典 [[LOCK-0051]]/[[LOCK-0052]]/[[LOCK-0053]]/[[LOCK-0054]]。lock/unlock/click は lock 動詞で BLE payload バイト列 (historyTagBLE) も lock.md(LOCK) が正典 (LOCK-0054 が historyTagBLE バイト列を正典化)。本エントリは ID 保持で waive。

### [BLE3-0049] toggle: lastStatus が locked なら unlock、それ以外 lock
- surface: core
- backend: ble
- command: `SesameBle.toggle`
- branch: lastStatus有 | 無(status取得) | locked→unlock | それ以外→lock
- assert: OS3 toggle のクライアント側 lock/unlock 判定 (lastStatus.state===locked→UNLOCK else LOCK, status() 待ちフォールバック) は [[LOCK-0056]] が正典 (cross-ref)
- ref: local-contract
- kind: option-branch
- status: waived: 重複（正典 [[LOCK-0056]]）
- note: 正典 [[LOCK-0056]]。toggle は lock 動詞のため lock.md(LOCK) が正典。本エントリは ID 保持で waive。

### [BLE3-0050] autolock data = 2B LE 秒数、成功時 lastMechSetting.autoLockSecond 局所更新
- surface: core, serve, sdk
- backend: ble
- command: `SesameBle.autolock / autolockData`
- branch: 範囲内 | 範囲外0..65535(throw) | キャッシュ有/無
- assert: OS3 autolock の item=AUTOLOCK(11)/2B LE payload/範囲検証/成功時 _lastMechSetting.autoLockSecond 局所更新は [[LOCK-0057]]/[[LOCK-0058]]/[[LOCK-0059]] が正典 (cross-ref)
- ref: local-contract
- kind: payload-fidelity
- status: waived: 重複（正典 [[LOCK-0057]]）
- note: 正典 [[LOCK-0057]]/[[LOCK-0058]]/[[LOCK-0059]]。autolock は lock 動詞のため lock.md(LOCK) が BLE payload も含めて正典。本エントリは ID 保持で waive。

### [BLE3-0051] configureLockPosition data = lockTarget(LE2B) ++ unlockTarget(LE2B) = 4B
- surface: core, serve, sdk
- backend: ble
- command: `SesameBle.configureLockPosition / ble.position`
- branch: LOCK5のみ | 非LOCK5(lock5OnlyNotSupported) | 範囲外(throw)
- assert: item=MECH_SETTING(80)、data=lockTarget.toReverseBytes() ++ unlockTarget.toReverseBytes() の 4B (符号付き16bit LE)。CHSesame5Device.kt:69-73 と一致。os3+LOCK5 以外は _assertLock5 で弾く
- ref: packages/core/src/ble/protocol.js:413; packages/core/src/ble/session.js:516; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesame5Device.kt:69
- kind: payload-fidelity
- status: planned
- note: protocol.js:413=configureLockPositionData (shortToReverseBytes×2 = writeInt16LE 4B, -32768..32767 範囲外 throw)。session.js:516=configureLockPosition (request(ITEM.MECH_SETTING,data))。CHSesame5Device.kt:69 本体 69-83。非LOCK5 ガードは index.js:823-831 _assertLock5。CHSesame5.kt:17 で interface 宣言。MECH_SETTING=80。

### [BLE3-0052] magnet: item=17 空 payload、LOCK5 のみ (CHSesame5 固有)
- surface: core, serve, sdk
- backend: ble
- command: `SesameBle.magnet`
- branch: LOCK5(送出) | 非LOCK5(lock5OnlyNotSupported)
- assert: item=MAGNET(17) を空 ByteArray で送る。OS2/Bot/Bike/biometric/Hub3/WM2 では _assertLock5 で明示エラー。CHSesame5Device.kt:118-126 (magnet: SesameItemCode.magnet + byteArrayOf(), cipher) と一致
- ref: packages/core/src/ble/session.js:557; packages/core/src/ble/index.js:1009; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesame5Device.kt:118
- kind: option-branch
- status: planned
- note: session.js:557-559 magnet が request(ITEM.MAGNET, Buffer.alloc(0))。index.js:1009-1012 magnet が _assertLock5("magnet")→session.magnet()。CHSesame5Device.kt:118 本体 118-126。LOCK5 固有は CHSesame5.kt:16。MAGNET=17。

### [BLE3-0053] opSensorControl data = 2B LE 秒数 (UShort)、LOCK5 のみ
- surface: core, serve, sdk
- backend: ble
- command: `SesameBle.opSensorControl / opSensorControlData`
- branch: LOCK5 | 非LOCK5(reject) | 範囲外(throw)
- assert: item=OPS_CONTROL(92)、data=isEnable.toShort().toReverseBytes() の 2B LE。成功時 opsSetting.opsLockSecond 局所更新。CHSesame5Device.kt:107-116 と一致
- ref: packages/core/src/ble/protocol.js:468; packages/core/src/ble/session.js:571; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesame5Device.kt:107
- kind: payload-fidelity
- status: planned
- note: itemcodes.js:44 OPS_CONTROL=92、CHSesame5Device.kt:107-116 override fun opSensorControl が isEnable.toShort().toReverseBytes() (2B LE) を送り opsSetting?.opsLockSecond を更新。非LOCK5 は index.js:1023 _assertLock5 で reject、範囲外は opSensorControlData (0..0xffff) で throw。

### [BLE3-0054] setBleTxPower data = 符号付き 1B、LOCK5 または biometric のみ
- surface: core, serve, sdk
- backend: ble
- command: `SesameBle.setBleTxPower / bleTxPowerData`
- branch: LOCK5/biometric | その他(txPowerNotSupported) | 範囲外-128..127(throw)
- assert: item=BLE_TX_POWER_SETTING(206)、data=byteArrayOf(txPower) の符号付き 1B。OS3 LOCK5 または biometric のみ露出。CHSesameOS3LockBase.kt:62-71 / CHSesameBiometricDeviceImpl.kt:332-341 と一致
- ref: packages/core/src/ble/protocol.js:489; packages/core/src/ble/index.js:1050; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/base/CHSesameOS3LockBase.kt:62; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesameBiometricDeviceImpl.kt:332
- kind: payload-fidelity
- status: planned
- note: itemcodes.js:207 SSM3_ITEM_CODE_BLE_TX_POWER_SETTING=206。CHSesameOS3LockBase.kt:62 と CHSesameBiometricDeviceImpl.kt:332 がともに byteArrayOf(txPower) を送る。index.js:1050 のガードは os===3 && (kind===LOCK5 || biometric)、それ以外は txPowerNotSupported throw。bleTxPowerData (protocol.js:489) が -128..127 を writeInt8。

### [BLE3-0055] sendAdvProductType: item=205 raw ByteArray 素通し、非Buffer で throw
- surface: core, serve, sdk
- backend: ble
- command: `SesameBle.sendAdvProductType`
- branch: LOCK5+Buffer | 非Buffer(throw) | 非LOCK5(reject)
- assert: item=SET_ADV_PRODUCT_TYPE(205)、data は呼び出し側 Buffer をそのまま送る (非 Buffer は throw)。CHSesame5Device.kt:85-94 と一致。LOCK5 のみ
- ref: packages/core/src/ble/session.js:605; packages/core/src/ble/index.js:1035; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesame5Device.kt:85
- kind: payload-fidelity
- status: planned
- note: itemcodes.js:206 SS3_ITEM_CODE_SET_ADV_PRODUCT_TYPE=205。CHSesame5Device.kt:85 sendAdvProductTypeCommand(data: ByteArray) が raw data を素通し。session.js:606 が非Buffer を ble.advProductTypeMustBeBuffer で throw、index.js:1036 _assertLock5 が非LOCK5 を reject。OS3 メソッド allowlist index.js:150 と OS3_TOPLEVEL_RPC_OPS index.js:208 に掲載=sdk/serve 露出。

## history

履歴の読み出し/削除。recordId 4B の往復。

### [BLE3-0056] readHistory: item=4 data=[0x01]、payload 先頭4B=recordId
- surface: core, serve, sdk
- backend: ble
- command: `SesameBle.history / historyReadData`
- branch: -
- assert: item=HISTORY(4) を data=byteArrayOf(0x01) で送り、payload を生バイトで返す (先頭4B が recordId)。CHSesameOS3LockBase.kt:185-192 と一致
- ref: packages/core/src/ble/protocol.js:555; packages/core/src/ble/session.js:657; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/base/CHSesameOS3LockBase.kt:187
- kind: payload-fidelity
- status: planned
- note: itemcodes.js:15 HISTORY=4。CHSesameOS3LockBase.kt:185 readHistoryCommand が 187-188 で SesameOS3Payload(history.value, byteArrayOf(0x01)) を送り、recordId=historyPayload.sliceArray(0..3)。公開 op 名は history (index.js:1099 history()→session.readHistory)。index.js:148 method allowlist + 190 RPC op。

### [BLE3-0057] deleteHistory: item=18 data=historyPayload[0..3] (recordId 4B)
- surface: core, serve, sdk
- backend: ble
- command: `SesameBle.deleteHistory / historyDeleteData`
- branch: payload>=4B | <4B(throw)
- assert: item=SSM2_ITEM_CODE_HISTORY_DELETE(18)、data=history payload の先頭4B (recordId)。CHSesameOS3LockBase.kt:200-207 と一致
- ref: packages/core/src/ble/protocol.js:568; packages/core/src/ble/session.js:670; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/base/CHSesameOS3LockBase.kt:204
- kind: payload-fidelity
- status: planned
- note: itemcodes.js:29 HISTORY_DELETE=18。CHSesameOS3LockBase.kt:~202 val recordId = historyPayload.sliceArray(0..3)、~204 SesameOS3Payload(SSM2_ITEM_CODE_HISTORY_DELETE.value, recordId) 送出。historyDeleteData (protocol.js:568) が <4B/非Buffer を throw、>=4B で先頭4B を返す。index.js:148 + 194 RPC op。

## mech-status

mechStatus/networkStatus の解釈。lock(7B)/bot(3B)/hub3(1B)/biometric(raw) を静的ディスパッチ。

### [BLE3-0058] parseMechStatus(7B lock): battery/target/position/flags ビット解釈
- surface: core
- backend: ble
- command: `parseMechStatus (lock)`
- branch: 7B(lock) | target=-32768(null)
- assert: OS3 mechStatus の 7B lock ビットレイアウト (battery/target/position/flags) は [[LOCK-0060]]/[[LOCK-0062]] が正典 (cross-ref)
- ref: local-contract
- kind: payload-fidelity
- status: waived: 重複（正典 [[LOCK-0060]]）
- note: 正典 [[LOCK-0060]] (7B レイアウト)/[[LOCK-0062]] (長さ分岐)。lock の mechStatus 解釈は lock.md(LOCK) が正典。本エントリは ID 保持で waive (biometric/hub3 の mechStatus 解釈は BLE3-0060/0061/0189 で BLE3 固有のため重複しない)。

### [BLE3-0059] parseMechStatus(3B bot/bike): interface 既定値 (position/target=0, isCritical=null)
- surface: core
- backend: ble
- command: `parseMechStatus (bot)`
- branch: 3B(bot/bike)
- assert: OS3 mechStatus の 3B bot/bike レイアウト+interface 既定値は [[LOCK-0061]]/[[LOCK-0062]] が正典 (cross-ref)
- ref: local-contract
- kind: payload-fidelity
- status: waived: 重複（正典 [[LOCK-0061]]）
- note: 正典 [[LOCK-0061]] (3B レイアウト)/[[LOCK-0062]] (長さ分岐)。bot/bike の mechStatus 解釈は lock.md(LOCK) が正典。本エントリは ID 保持で waive。

### [BLE3-0060] MECH_STATUS(81) の解釈は mechStatusKind で静的ディスパッチ
- surface: core
- backend: ble
- command: `SesameBleSession._onPacket (item81) / mechStatusKind`
- branch: lock(7B) | bot(3B) | hub3(1B網) | biometric(raw)
- assert: item=81 publish を kind で静的に振り分ける: hub3=parseNetworkStatus(1B)/biometric=raw素通し/lock・bot=parseMechStatus。フォールバック連鎖を排除 (Hub3 1B が biometric 形に入る問題を解消, P3-18)。CHHub3Device.kt:291-301 と一致
- ref: packages/core/src/ble/session.js:758; packages/core/src/ble/index.js:425; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:291
- kind: option-branch
- status: planned
- note: biometric の SDK 実体は handleMechStatus→CHSesameTouchProMechStatus(CHSesameBiometricDeviceImpl.kt:214-217) で、kit 側は構造解釈せず raw 保持 (biometric.js:245-259, pass-through 意味論) として再現する。

### [BLE3-0061] parseNetworkStatus(1B): WM2/Hub3 共通ネットワーク bit flags
- surface: core
- backend: ble
- command: `parseNetworkStatus`
- branch: >=1B | 空(throw)
- assert: payload[0] の bit1..bit7 を isAp/isNet/isIot/isAPCheck/isAPConnecting/isNETConnecting/isIOTConnecting に展開する (bit7 = Kotlin signed byte<0 と等価)。CHWifiModule2Device.kt:503-510 / CHHub3Device.kt:293-300 と一致
- ref: packages/core/src/ble/protocol.js:807; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:293
- kind: payload-fidelity
- status: planned
- note: bit1..bit7 のフラグ展開 (and 2/4/8/16/32/64, payload[0]<0) は CHHub3Device.kt:293-299。WM2 側 NETWORK_STATUS(6) の同一展開は CHWifiModule2Device.kt:503-510。

## mech-setting

mechSetting/opsSetting の i16/u16 LE 解析。

### [BLE3-0062] parseMechSetting(6B): lockPosition/unlockPosition/autoLockSecond i16 LE
- surface: core
- backend: ble
- command: `parseMechSetting`
- branch: >=6B | <6B(throw)
- assert: item=80 payload: [0..1]lockPosition, [2..3]unlockPosition, [4..5]autoLockSecond を全て符号付き i16 LE で読む。CHSesame5MechSettings (CHSesame5.kt:34-38, bytesToShort) と一致
- ref: packages/core/src/ble/protocol.js:434; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesame5.kt:34
- kind: payload-fidelity
- status: planned
- note: フィールド分解の正準源 open/devices/CHSesame5.kt:34-38 (bytesToShort=signed LE, DataExtention.kt:99)。protocol.js:434 と 1:1。

### [BLE3-0063] parseOpsSetting(2B): opsLockSecond u16 LE
- surface: core
- backend: ble
- command: `parseOpsSetting`
- branch: >=2B | <2B(throw)
- assert: OPS_CONTROL(92) payload [0..1] を opsLockSecond として符号なし u16 LE で読む。CHSesame5OpsSettings (CHSesame5.kt:40-42, bytesToUShort) と一致
- ref: packages/core/src/ble/protocol.js:452; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesame5.kt:40
- kind: payload-fidelity
- status: planned
- note: 解析の正準源 open/devices/CHSesame5.kt:40-42 (opsLockSecond:UShort=bytesToUShort=u16 LE, DataExtention.kt:104)。publish 解析側は CHSesame5Device.kt:224-226。

## reset

reset の機種別ルーティングと dropKey 相当の disconnect。

### [BLE3-0064] reset: item=104 空 payload、成功時 dropKey 相当で disconnect
- surface: core, serve, sdk
- backend: ble
- command: `SesameBle.reset / ble.reset`
- branch: OS3 lock系(Reset104) | WM2(RESET_WM2へ自動route) | OS2(resetNotSupported) | 成功時disconnect
- assert: OS3 lock 系は item=Reset(104) を空 ByteArray で送り、resultCode==0 のとき disconnect (dropKey 相当)。WM2 は resetWifiModule2 へ自動ルーティング。CHSesameOS3.kt:420-439 と一致
- ref: packages/core/src/ble/session.js:620; packages/core/src/ble/index.js:1074; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/base/CHSesameOS3.kt:420
- kind: idempotency
- status: planned
- note: WM2 RESET_WM2(18) ルーティングは CHWifiModule2Device.kt:437-448 (RESET_WM2.value=18U, 値は同ファイル:540 enum 確認済) で成功時 dropKey。index.js:1082-1083 で wifiProvisioning→resetWifiModule2 に委譲。

## dfu

ファームウェア更新の機種別 OTA 経路 (WM2=OPEN_OTA_SERVER / Hub3=MOVE_TO / lock系=無送信) と進捗 publish。

### [BLE3-0065] updateFirmware 経路分岐: WM2=OPEN_OTA_SERVER / Hub3=MOVE_TO / lock系=無送信ハンドル返し
- surface: core, serve, sdk
- backend: ble
- command: `SesameBle.updateFirmware / ble.updateFirmware`
- branch: WM2(126) | Hub3(MOVE_TO 84) | LOCK5/Bot2/Bike/biometric(無送信) | OS2/未知(dfuNotSupported)
- assert: kind で OTA 経路を分岐: WM2=OPEN_OTA_SERVER(126)/Hub3=MOVE_TO(84) を暗号送出、OS3 lock 系は命令無送信で {session} ハンドル返し。CHSesameOS3.kt:441-449 / CHHub3Device.kt:217-230 / CHWifiModule2Device.kt:450-458 と一致
- ref: packages/core/src/ble/index.js:777; packages/core/src/ble/dfu.js:96; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/base/CHSesameOS3.kt:441
- kind: option-branch
- status: planned
- note: 旧実装は LOCK5 も MOVE_TO へ流していた誤り (P1-7 修正)。値確認: OPEN_OTA_SERVER=126U/RESET_WM2=18U (CHWifiModule2Device.kt:540), moveTo 送出は CHHub3Device.kt:222。dfu.js:96 は lock系 no-op ハンドル返し (CHSesameOS3.kt:441-449)。

### [BLE3-0066] DFU 進捗 publish: payload 先頭1B が進捗値、応答後に内部 unsubscribe
- surface: core
- backend: ble
- command: `updateFirmwareBleOnly / updateFirmwareWM2 / onMoveToOtaProgress`
- branch: MOVE_TO(84) | OPEN_OTA_SERVER(126) | onProgress無(no-op)
- assert: OTA 進捗は MOVE_TO/OPEN_OTA_SERVER publish の payload.first() で届き、updateFirmware* は応答時に内部購読を unsubscribe する。CHHub3Device.kt:320-322 / CHWifiModule2Device.kt:465-467 と一致
- ref: packages/core/src/ble/dfu.js:70; packages/core/src/ble/dfu.js:123; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:320
- kind: payload-fidelity
- status: planned
- note: dfu.js:70 subscribeProgress が firstByteProgress(body)=body[0] を渡し (dfu.js:48-50), updateFirmwareBleOnly/WM2 は finally で unsubscribe (dfu.js:134,165)。CHHub3Device.kt:321 / CHWifiModule2Device.kt:466 とも payload.first()。

### [BLE3-0067] updateFirmware(lock系): 未接続なら dfuDeviceNotAvailable で reject
- surface: core
- backend: ble
- command: `dfu.updateFirmware`
- branch: login済({session}) | 未login(throw)
- assert: OS3 lock 系の updateFirmware は login 済みを唯一の device-available 条件とし、未接続なら CHSesameOS3.kt:447 と同一メッセージで throw する (命令無送信・カウンタ非消費)
- ref: packages/core/src/ble/dfu.js:96; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/base/CHSesameOS3.kt:447
- kind: error-path
- status: planned
- note: dfu.js:96 updateFirmware(session) → :98 throw t('ble.dfuDeviceNotAvailable')。i18n/ble.js:82 = 'Bluetooth device is not available.' が CHSesameOS3.kt:447 RuntimeException 文字列と一致。

## wm2-profile

WM2 (WiFi Module 2) profile のセッション確立差分: initial=13 / login payload=CMAC 16B 全量 / register=pubK64のみ / nonce 12B / 登録後鍵=ecdhPre16 生16B。@experimental 実機未検証。

### [BLE3-0068] WM2 セッション確立: initial=13 / login payload=CMAC 16B 全量 / register=pubK64のみ
- surface: core
- backend: ble
- command: `SesameBleSession (profile=wm2) / loginPayload / registrationData`
- branch: wm2 profile
- assert: wm2 profile は initialItemCode=13、login 平文=[LOGIN_WM2(2)]++CMAC(secretKey,token)16B 全量、register data=pubK64 のみ(timestamp無)。CHWifiModule2Device.kt:314-321,290,521-528 と一致
- ref: packages/core/src/ble/protocol.js:111; packages/core/src/ble/session.js:846; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:314
- kind: wire-fidelity
- status: planned
- note: protocol.js:111 SESSION_PROFILES(wm2.initialItemCode=13)、session.js:846 wm2 login 分岐で loginPayload(loginTag,'wm2') が CMAC 16B 全量(:856)、register data=pubK64 のみ(kt:290 REGISTER_WM2 payload=getPubK のみ)。WM2ActionCode.INITIAL=13/LOGIN_WM2=2 (kt:540) 実値確認。@experimental 実機未検証。

### [BLE3-0069] WM2 CCM sault=token4 (12B nonce)、登録後鍵=ecdhPre16 生16B
- surface: core
- backend: ble
- command: `ccmSault(wm2) / session.register(wm2)`
- branch: wm2 profile (nonce 12B)
- assert: wm2 は CCM sault=token4 (0x00 を挟まない→nonce 12B)、cipher 鍵は ecdhSecret_pre16 生 16B (CMAC でない)。CHWifiModule2Device.kt:295-302 と一致
- ref: packages/core/src/ble/protocol.js:222; packages/core/src/ble/session.js:389; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:302
- kind: crypto-vector
- status: planned
- note: protocol.js:222 ccmSault は wm2→token4(4B)/lock→0x00++token4。session.js:389 wm2 登録後鍵=Buffer.from(pre16) 生16B。kt:302 register-after cipher = SesameOS3BleCipher(name, ecdhSecret_pre16, mSesameToken!!) が鍵=pre16生・sault=token(0x00無)を支持。SesameOS3BleCipher.kt:13 nonce=count(8B LE)+sault → wm2 は 8+4=12B。CHHub3Device.kt:174 は lock 系で '00'++token を使う(Hub3 vs WM2 経路差)。

### [BLE3-0070] WM2 profile login: 鍵=secretKey 生16B / payload=[LOGIN_WM2(2)]++CMAC 16B 全量
- surface: core
- backend: ble
- command: `loginPayload(profile=wm2) / SesameBleSession.connect`
- branch: wm2-profile
- assert: wm2 profile の login は cipher 鍵 = secretKey 生 16B、送信 payload = [LOGIN_WM2(2)] ++ CMAC(secretKey, token4) 16B 全量 = 17B (lock の鍵=CMAC/先頭4B とは非互換)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:314; packages/core/src/ble/protocol.js:191
- kind: payload-fidelity
- status: planned
- note: 実機未検証 @experimental。kt:316 loginTag=AesCmac(secretKey 生16B).computeMac(mSesameToken)、kt:317 cipher 鍵=secretKey 生16B、kt:318 sendCommand([LOGIN_WM2(2)]++loginTag(16B), plain)=17B。core loginPayload (protocol.js:191-194) は profile==='wim2' で [ITEM.LOGIN]++token16(全量)、lock では token16.subarray(0,4) と分岐し一致 (LOGIN_WM2(2)=LOGIN(2) 同値, enum kt:540)。

### [BLE3-0071] WM2 profile register: data=pubK64 のみ(timestamp 無し)/登録後鍵=ecdhSecret_pre16 生
- surface: core
- backend: ble
- command: `registrationData(profile=wm2) / SesameBleSession.register`
- branch: wm2-profile
- assert: wm2 profile の REGISTER_WM2(1) data = pubK64 のみ (64B, timestamp 無し)、応答 payload[0..63] を ECDH し pre16 を生鍵 (CMAC を掛けない) として cipher に使う
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:290; packages/core/src/ble/protocol.js:674; packages/core/src/ble/protocol.js:104
- kind: payload-fidelity
- status: planned
- note: kt:290 send=REGISTER_WM2(1)++EccKey.getPubK()(timestamp無)、kt:295 ecdhSecret_pre16=ecdh(payload[0..63])[0..15]、kt:302 cipher=SesameOS3BleCipher(.,ecdhSecret_pre16,mSesameToken) で pre16 を生鍵(CMAC無)。対比 lock= pubK64++ts4(CHSesameOS3LockBase.kt:93)・鍵=CMAC(pre16,token)(同:162)。

### [BLE3-0072] WM2 profile CCM sault=token4 (0x00 無し) → 12B nonce
- surface: core
- backend: ble
- command: `ccmSault(profile=wm2) / ccmNonce`
- branch: wm2-profile
- assert: wm2 profile の CCM sault = mSesameToken(4B) をそのまま (0x00 を挟まない) で nonce 12B を構成する (lock は 0x00++token → 13B)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:302; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/base/SesameOS3BleCipher.kt:8-23; packages/core/src/ble/protocol.js:199
- kind: payload-fidelity
- status: planned
- note: WM2 sault=mSesameToken は cipher 構築点(kt:302 register / kt:317 login)で 0x00 無し。nonce 12B 組立は SesameOS3BleCipher.kt:13 nonce=encryptCounter.toBytes()(8B,DataExtention.kt:114-129)+sault。対比 lock=0x00++token(CHSesameOS3LockBase.kt:115,166)→13B。

### [BLE3-0073] WM2 profile initial itemCode = 13 (lock は 14)
- surface: core
- backend: ble
- command: `SESSION_PROFILES.wm2 / SesameBleSession initialItemCode`
- branch: wm2-profile
- assert: wm2 profile の initial publish itemCode = WM2ActionCode.INITIAL = 13 を待つ (lock profile の SesameItemCode.INITIAL=14 と非互換)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:540; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:34; packages/core/src/ble/protocol.js:111
- kind: payload-fidelity
- status: planned
- note: WM2ActionCode.INITIAL=13U は kt:540、lock の SesameItemCode.initial=14u は SesameProtocols.kt:34。JS は protocol.js:113 wm2.initialItemCode=WM2_ACTION_CODES.INITIAL(=13, itemcodes.js:240)・lock=ITEM_CODES.INITIAL(=14, itemcodes.js:25)。

### [BLE3-0074] getVersionTag: lock=item5 / wm2=WM2ActionCode.VERSION_TAG(127)
- surface: core
- backend: ble
- command: `SesameBleSession.getVersionTag`
- branch: lock(5) | wm2(127)
- assert: versionTag の itemCode が profile で分岐: lock=5、wm2=127 (WM2 では 5=CONNECT_WIFI なので旧 '常に5' は誤発火)。応答は両 profile とも payload UTF-8 文字列。CHWifiModule2Device.kt:427 と一致
- ref: packages/core/src/ble/session.js:644; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:427
- kind: option-branch
- status: planned
- note: session.js:644 getVersionTag は itemCode = wm2?WM2_ACTION_CODES.VERSION_TAG:ITEM.VERSION_TAG、両 profile とも payload.toString('utf8')。kt:427 sendCommand(VERSION_TAG,空)→String(res.payload)。WM2ActionCode 実値で VERSION_TAG=127/CONNECT_WIFI=5 (kt:540)。@experimental wm2 127 経路は実機未検証。

### [BLE3-0075] WM2 facade route: SesameBle が kind===WIFI で profile 'wm2' を自動選択
- surface: core
- backend: ble
- command: `SesameBle (session profile 選択)`
- branch: wifi-kind | lock-kind
- assert: capabilitiesForModel(model).wifiProvisioning が true (= WM2) のとき session を profile 'wm2' で構築し syncTime を抑止する
- ref: packages/core/src/ble/index.js:413
- kind: option-branch
- status: planned
- note: index.js:413 isWm2=capabilitiesForModel(model).wifiProvisioning、:435 profile:isWm2?"wm2":"lock"、:444 syncTime=!(kind===HUB3||WIFI||BIOMETRIC) で WIFI の time(8) 自動同期を抑止。

### [BLE3-0076] wifi() ゲッタは wifiProvisioning 非対応機種で明示エラー
- surface: core
- backend: ble
- command: `SesameBle.wifi`
- branch: wm2 | unsupported
- assert: wifi() が wifiProvisioning 機種でのみ WifiModule2 を返し、非対応機種では bad_params 相当の明示エラーを投げる (能力ゲート)
- ref: packages/core/src/ble/index.js:699
- kind: option-branch
- status: planned
- note: index.js:700-705 !wifiProvisioning で badRequest("ble.wm2NotSupported")、:706-707 対応機種でのみ WifiModule2 生成。badRequest は code=BAD_REQUEST→kind=bad_params 写像(util.js:48,54-55)。

## wm2-gatt

WM2 専用 GATT/ActionCode enum 値が SDK と 1:1。

### [BLE3-0077] WM2 専用 GATT サービス/特性 UUID が Wm2Chracs と一致
- surface: core
- backend: ble
- command: `WM2_GATT`
- branch: -
- assert: WM2_GATT.SERVICE/WRITE_CHAR/NOTIFY_CHAR が Wm2Chracs.uuidService01/writeChrac/receiveChr の UUID リテラルと完全一致 (fd81 系ロックとは別サービス)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:533-537; packages/core/src/ble/wm2.js:46-50
- kind: payload-fidelity
- status: planned
- note: kt:534-536 uuidService01=1b7e8251.../writeChrac=aca0ef7c.../receiveChr=8ac32d3f...、wm2.js:47-49 と完全一致。fd81 系ロックは protocol.js:25。transport へ注入する WM2 用 GATT。

### [BLE3-0078] WM2ActionCode enum 値が SDK と 1:1
- surface: core
- backend: ble
- command: `WM2_ACTION_CODES`
- branch: -
- assert: WM2_ACTION_CODES の各キー値 (LOGIN_WM2=2/UPDATE_WIFI_SSID=3/UPDATE_WIFI_PASSWORD=4/CONNECT_WIFI=5/NETWORK_STATUS=6/DELETE_SESAME=7/ADD_SESAME=8/INITIAL=13/SESAME_KEYS=16/RESET_WM2=18/SCAN_WIFI_SSID=19) が WM2ActionCode と一致
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:539-541; packages/core/src/itemcodes.js:230-244
- kind: payload-fidelity
- status: planned
- note: kt:540 enum 各メンバ値と itemcodes.js:230-244 WM2_ACTION_CODES が一致。数値空間が SesameItemCode と重複するため別 enum (itemcodes.js:226)。

## wm2-send

WM2 の各送信コマンド (scan/setSsid/setPassword/connect/insertSesames/removeSesame/reset) のバイト列と入力検証。

### [BLE3-0079] WM2 scanWifiSSID 送信 = SCAN_WIFI_SSID(19) + 空 data
- surface: core
- backend: ble
- command: `ble.wifi.scan / WifiModule2.scanWifiSSID`
- branch: -
- assert: scanWifiSSID は action code 19・data 長 0 で session.request する (SDK の byteArrayOf())
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:323-334; packages/core/src/ble/wm2.js:396-398
- kind: payload-fidelity
- status: planned
- note: RPC 別名は専用 ble.wifi.scan (生成版は重複回避で WM2_RPC_OPS 除外、wm2.js:489-496。core メソッドは WifiModule2.scanWifiSSID wm2.js:396)。kt:324 byteArrayOf() 検証済。

### [BLE3-0080] WM2 setWifiSSID 送信 data = SSID の UTF-8 bytes
- surface: core
- backend: ble
- command: `ble.wifi.setSsid / WifiModule2.setWifiSSID`
- branch: -
- assert: setWifiSSID は action code 3・data = ssid.toByteArray() (UTF-8) で送る
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:336-347; packages/core/src/ble/wm2.js:404-406
- kind: payload-fidelity
- status: planned
- note: RPC 別名は専用 ble.wifi.setSsid (serve/entries/ble.js:209-224)。kt:337 ssid.toByteArray() 検証済。

### [BLE3-0081] WM2 setWifiSSID 空文字列は必須検証で reject
- surface: core
- backend: ble
- command: `setWifiSSIDData`
- branch: empty-ssid
- assert: ssid が非文字列または空文字列のとき ble.wm2SsidRequired で throw (SDK には無いローカル入力検証)
- ref: local-contract
- kind: error-path
- status: planned
- note: wm2.js:112-113 if(typeof ssid!=='string'||ssid.length===0) throw t('ble.wm2SsidRequired')。i18n key は i18n/ble.js:66(en),239(ja) に実在。

### [BLE3-0082] WM2 setWifiPassword 送信 data = password の UTF-8 bytes
- surface: core
- backend: ble
- command: `ble.wifi.setPassword / WifiModule2.setWifiPassword`
- branch: -
- assert: setWifiPassword は action code 4・data = password.toByteArray() (空文字許容)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:350-356; packages/core/src/ble/wm2.js:412-414
- kind: payload-fidelity
- status: planned
- note: RPC 別名は専用 ble.wifi.setPassword (serve/entries/ble.js:225-240)。kt:351 password.toByteArray()・空パスワード(オープン AP)許容 検証済。

### [BLE3-0083] WM2 setWifiPassword 非文字列は型検証で reject
- surface: core
- backend: ble
- command: `setWifiPasswordData`
- branch: non-string
- assert: password が string でないとき ble.wm2PasswordString で throw (空文字は許容)
- ref: local-contract
- kind: error-path
- status: planned
- note: wm2.js:122-125 `if (typeof password !== "string") throw t("ble.wm2PasswordString")`、length 検査なしで空文字許容。i18n キー ble.js:67 実在。Kotlin 原典は型検証を持たない (kt:350-356) ため local-contract が正。

### [BLE3-0084] WM2 connectWifi verification = company(:/- 除去) + ':' + UUID 末尾セグメント大文字
- surface: core
- backend: ble
- command: `ble.wifi.connect / WifiModule2.connectWifi`
- branch: -
- assert: connectWifi の data = (companyId から ':'/'-' を除去した文字列) + ':' + deviceUUID.toUpperCase().split('-').last() の UTF-8 と一致 (action code 5)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:358-370
- kind: payload-fidelity
- status: planned
- note: kt:359 company=replace(":","").replace("-","")、kt:361 verification=company+":"+deviceId.uppercase().split('-').last()、kt:363 CONNECT_WIFI.value 送信。CONNECT_WIFI=5U は kt:540 enum で確認。移植先 wm2.js:139-148 と 1:1。

### [BLE3-0085] WM2 connectWifi の既定 companyId = API_GATEWAY_CLIENT_ID
- surface: core, serve, cli
- backend: ble
- command: `WM2_API_GATEWAY_CLIENT_ID / wifiViewOf`
- branch: default-companyId | params-override
- assert: WM2_API_GATEWAY_CLIENT_ID 定数が app.properties の aws.apigateway.clientId (ap-northeast-1:0a1820f1-...) と一致し、companyId 未指定時に wifiViewOf がこれを注入する
- ref: _sesame_sdk_ref/app.properties:6; packages/core/src/ble/rpc-helpers.js:97; packages/core/src/ble/rpc-helpers.js:112-117
- kind: payload-fidelity
- status: planned
- note: app.properties:6 aws.apigateway.clientId=ap-northeast-1:0a1820f1-dbb3-4bca-9227-2a92f6abf0ae、rpc-helpers.js:97 WM2_API_GATEWAY_CLIENT_ID 同値、rpc-helpers.js:114 wifiViewOf が companyId ?? WM2_API_GATEWAY_CLIENT_ID を注入。定数は ble/index.js:119 で再 export。

### [BLE3-0086] WM2 connectWifi の companyId/deviceUUID 欠落は必須検証で reject
- surface: core
- backend: ble
- command: `connectWifiData`
- branch: missing-companyId | missing-deviceUUID
- assert: companyId 欠落は ble.wm2CompanyIdRequired、deviceUUID 欠落は ble.wm2DeviceUUIDRequired で throw (BLE 送信前に弾く)
- ref: local-contract
- kind: error-path
- status: planned
- note: wm2.js:140 companyId 非文字列/空→ble.wm2CompanyIdRequired、wm2.js:141 deviceUUID 非文字列/空→ble.wm2DeviceUUIDRequired。i18n キー ble.js:68-69 実在。Kotlin は deviceId/BuildConfig を device オブジェクトから取得し明示検証を持たない (kt:358-361) ため local-contract が正。

### [BLE3-0087] WM2 insertSesames allKey レイアウト = ssmIRData++ssmPKData++ssmSecKa++ssmUUid
- surface: core
- backend: ble
- command: `ble.wifi.insertSesames / WifiModule2.insertSesames`
- branch: -
- assert: allKey = base64(16B UUID,'='除去)のASCII(22B) ++ 公開鍵(64B) ++ secretKey(16B) ++ 大文字UUID文字列のASCII(36B) を連結し action code 8 で送る (合計 138B)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:372-409
- kind: payload-fidelity
- status: planned
- note: kt:381-383 ssmIRData=base64(16B,'='除去) ASCII=22B、kt:385-394 ssmPKData=64B、kt:399 ssmSecKa=16B、kt:400 ssmUUid=大文字ハイフン込み UUID 文字列 ASCII=36B、kt:401 連結 kt:404 ADD_SESAME.value(=8U, kt:540) 送信。合計 22+64+16+36=138B。移植先 wm2.js:177-206 と 1:1。

### [BLE3-0088] WM2 insertSesames は sesame_5/5_pro/5_us/bike_2 で固定 PK に差し替え
- surface: core
- backend: ble
- command: `insertSesamesData`
- branch: fixed-pk-model | sesame2PublicKey
- assert: deviceModel が sesame_5/5_pro/5_us/bike_2 のとき ssmPKData = 固定 64B 公開鍵リテラル、それ以外は sesame2PublicKey の hex decode を使う
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:385-394
- kind: option-branch
- status: planned
- note: kt:385-389 model 条件 (sesame_5/sesame_5_pro/sesame_5_us/bike_2)、kt:391 固定 64B PK リテラル '41B6D190...E45F27E'、kt:393 else sesame2PublicKey.hexStringToByteArray()。固定 PK リテラルは kt:391 と wm2.js:57-58 が 1:1。FIXED_PUBKEY_MODELS は wm2.js:61。

### [BLE3-0089] WM2 insertSesames 固定 PK 対象外 model は sesame2PublicKey 必須
- surface: core
- backend: ble
- command: `insertSesamesData`
- branch: missing-pubkey | missing-uuid-or-secret
- assert: deviceUUID/secretKey 欠落、または固定 PK 対象外 model で sesame2PublicKey 欠落のとき ble.wm2SesameKeyRequired で throw
- ref: local-contract
- kind: error-path
- status: planned
- note: wm2.js:179-180 deviceUUID 非文字列/空 or secretKey==null→ble.wm2SesameKeyRequired、wm2.js:193 固定 PK 対象外 model で sesame2PublicKey==null→同エラー。i18n キー ble.js:70 実在。Kotlin は sesame2KeyData を non-null 前提 (kt:393, !! 演算子) で明示検証を持たないため local-contract が正。

### [BLE3-0090] WM2 insertSesames noHashUUID は大小変換なしでハイフン除去のみ
- surface: core
- backend: ble
- command: `insertSesamesData`
- branch: -
- assert: noHashUUID = deviceUUID.replace('-','') を hex decode して base64 化 (toLowerCase しない)。ssmUUid は deviceUUID.toUpperCase() の ASCII
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:381-400
- kind: payload-fidelity
- status: planned
- note: P5-4 stripDashes 規範。kt:381 replace("-","")・kt:382 base64Encode・kt:400 deviceUUID.uppercase().toByteArray()。port は wm2.js:184-186,203 (stripDashes/ssmIRData/ssmUUid)。

### [BLE3-0091] WM2 removeSesame 送信 data = sesameKeyTag を大文字化した UTF-8
- surface: core
- backend: ble
- command: `ble.wifi.removeSesame / WifiModule2.removeSesame`
- branch: -
- assert: removeSesame は action code 7・data = sesameKeyTag.uppercase().toByteArray() (UTF-8 文字列。Hub3 の生 16B decode とは経路が異なる)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:413-420
- kind: payload-fidelity
- status: planned
- note: kt:415 DELETE_SESAME(7)・sesameKeyTag.uppercase(getDefault()).toByteArray()。port=wm2.js:213-215,439-440。Hub3 経路差は hub3.js:89-92 (生 16B decode)。

### [BLE3-0092] WM2 removeSesame 空タグは必須検証で reject
- surface: core
- backend: ble
- command: `removeSesameData`
- branch: empty-tag
- assert: sesameKeyTag が非文字列または空文字列のとき ble.wm2SesameKeyTagRequired で throw
- ref: local-contract
- kind: error-path
- status: planned
- note: 純ローカル検証契約。wm2.js:214 typeof!==string||length===0 → t("ble.wm2SesameKeyTagRequired")。i18n=ble.js:71,244。

### [BLE3-0093] WM2 reset 送信 = RESET_WM2(18) + 空ペイロード、成功時に dropKey 相当の session 破棄
- surface: core
- backend: ble
- command: `ble.wifi.reset / WifiModule2.reset / resetWifiModule2`
- branch: success-drop | non-success-keep
- assert: reset は action code 18・空 data を送り、resultCode==0 のときだけ session.disconnect (dropKey 写像)。非 0 では disconnect しない
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:437-448
- kind: payload-fidelity
- status: planned
- note: kt:443 RESET_WM2(18)+byteArrayOf()・kt:444-446 success→dropKey。port=wm2.js:465-473 (resultCode===0 のときのみ session.disconnect())。

### [BLE3-0094] WM2 未ログイン reset は session.request の notLoggedIn に委譲
- surface: core
- backend: ble
- command: `WifiModule2.reset`
- branch: unlogined
- assert: 未ログイン状態の reset は RESET_WM2 送出前に session.request が notLoggedIn で reject する (SDK kt:439-441 の BleInvalidAction ガードと等価)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:439-441; packages/core/src/ble/session.js:490
- kind: error-path
- status: planned
- note: notLoggedIn reject は request() 冒頭 session.js:490 (!this._loggedIn → reject t("ble.notLoggedIn"))。kt:439-441 は unlogined→BleInvalidAction ガード (SDK は return 無しだが kit 等価面は request reject)。

### [BLE3-0095] WM2 (wifiProvisioning) の汎用 reset は RESET_WM2(18) 経路へ自動ルーティング
- surface: core
- backend: ble
- command: `SesameBle.reset`
- branch: wm2-route | generic-reset
- assert: wifiProvisioning 機種で SesameBle.reset() が resetWifiModule2 (RESET_WM2=18) を呼ぶ。汎用 Reset(104) は送らない (WM2 action 空間で 104 未定義)
- ref: packages/core/src/ble/index.js:1064; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:437-448
- kind: option-branch
- status: planned
- note: index.js:1082-1083 if(_caps.wifiProvisioning) return this.resetWifiModule2()。resetWifiModule2=index.js:721-722→wifi().reset()。RESET=104 (itemcodes.js:161) は WM2_ACTION_CODES (kt:539-541 enum) に未定義・RESET_WM2=18。

### [BLE3-0096] WM2 NETWORK_STATUS 送信経路は存在しない (受信専用)
- surface: core, serve
- backend: ble
- command: `wifi.networkStatus`
- branch: -
- assert: WM2 に NETWORK_STATUS 送信メソッド/networkStatusData ビルダ/wifi.networkStatus RPC op は存在しない (SDK kt:502-510 は受信専用)。発明 op を捏造しない
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:502-510; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHWifiModule2.kt:30-39; packages/core/src/ble/wm2.js:218-222
- kind: contract-existence
- status: planned
- note: P3-20。kt:502-510 は onGattWM2Publish 内の受信ハンドラのみ、CHWifiModule2 interface(kt:30-39) に networkStatus 系の送信 API は無い。core 側 wm2.js:218-222/500-502 で旧 networkStatus()/networkStatusData()/wifi.networkStatus op を削除済みと明記。

## wm2-publish

WM2 publish のパース (scan/ssid/password/netstatus/sesameKeys/ota) と dispatch 網羅。

### [BLE3-0097] WM2 SCAN_WIFI_SSID publish = rssi(LE signed int16) + ssid(UTF-8)
- surface: core
- backend: ble
- command: `parseScanWifiSSID / parseWM2Publish`
- branch: -
- assert: SCAN_WIFI_SSID(19) publish の payload[0..1] を little-endian signed short (readInt16LE) で rssi、drop(2) を UTF-8 で ssid として解析 (bytesToShort は byte1=下位/byte2=上位)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:486-490; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/utils/DataExtention.kt:99-102
- kind: payload-fidelity
- status: planned
- note: kt:487 bytesToShort(payload[0],payload[1])・kt:488 String(payload.drop(2))。DataExtention.kt:99-102 ((byte2 and 0xFF) shl 8) or (byte1 and 0xFF) = byte1 下位/byte2 上位 = LE signed。port=wm2.js:242 readInt16LE(0)・wm2.js:243 subarray(2).toString(utf8)。

### [BLE3-0098] WM2 UPDATE_WIFI_SSID/PASSWORD publish = 現在値の文字列
- surface: core
- backend: ble
- command: `parseWifiSSIDPublish / parseWifiPasswordPublish`
- branch: ssid | password
- assert: UPDATE_WIFI_SSID(3)/UPDATE_WIFI_PASSWORD(4) publish の payload 全体を UTF-8 文字列として現在の SSID/パスワードに解析
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:491-500; packages/core/src/ble/wm2.js:252-265
- kind: payload-fidelity
- status: planned
- note: kt:491-495 が SSID publish(String(payload)→wifiSSID)、kt:496-500 が PASSWORD publish(String(payload)→wifiPassWord)。core 実装 (wm2.js:252-265) は buf.toString('utf8') で一致。

### [BLE3-0099] WM2 NETWORK_STATUS publish の payload[0] ビットフラグ解析
- surface: core
- backend: ble
- command: `parseNetworkStatus / parseWM2Publish`
- branch: -
- assert: NETWORK_STATUS(6) の payload[0] を isAp(b&2)/isNet(b&4)/isIot(b&8)/isAPCheck(b&16)/isAPConnecting(b&32)/isNETConnecting(b&64)/isIOTConnecting(b&0x80) に分解 (Kotlin signed byte<0 = bit7 と等価)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:502-510; packages/core/src/ble/protocol.js:807-820
- kind: payload-fidelity
- status: planned
- note: kt:503-509 が b&2/4/8/16/32/64 と payload[0]<0(=bit7) を抽出。core parseNetworkStatus (protocol.js:807-820) は bit7 を (b&0x80)>0 で判定し signed<0 と等価 (コメント protocol.js:799-801 で明記)。

### [BLE3-0100] WM2 SESAME_KEYS publish = 23B チャンク → base64 decode で {deviceUUID,status}
- surface: core
- backend: ble
- command: `parseSesameKeys (wm2)`
- branch: valid | corrupt-entry
- assert: SESAME_KEYS(16) を 23B チャンク分割し、各 chunk[0..21] を ASCII 文字列+'==' で base64 decode→16B→UUID、chunk[22] を status。壊れた (16B 以外) エントリはスキップ
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:468-485; packages/core/src/ble/wm2.js:287-306
- kind: payload-fidelity
- status: planned
- note: Hub3 の生 16B UUID 経路と区別。kt:471 divideArray(23)、kt:473 sliceArray(0,21)=22B、kt:474 lock_status=it[22]、kt:476 (String(ss2_ir_22)+'==').base64decodeHex().noHashtoUUID()、kt:479-480 try/catch でスキップ。core parseSesameKeys (wm2.js:287-306) が ascii+'=='→base64→raw.length!==16 で continue まで一致。

### [BLE3-0101] WM2 OPEN_OTA_SERVER publish = 進捗 1B
- surface: core
- backend: ble
- command: `parseWM2Publish (otaProgress)`
- branch: -
- assert: OPEN_OTA_SERVER(126) publish を payload.first() の進捗 1B として {kind:'otaProgress', progress} に正規化
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:465-467; packages/core/src/ble/wm2.js:347-349
- kind: payload-fidelity
- status: planned
- note: kt:465-467 onOTAProgress(this, receivePayload.payload.first())、enum OPEN_OTA_SERVER(126U) (kt:540)。core parseWM2Publish の OPEN_OTA_SERVER case (wm2.js:347-349) が {kind:'otaProgress', progress: buf[0]} を返し一致。

### [BLE3-0102] WM2 parseWM2Publish の itemCode ディスパッチ網羅と unknown fallback
- surface: core
- backend: ble
- command: `parseWM2Publish`
- branch: known-codes | unknown
- assert: parseWM2Publish が SCAN/UPDATE_SSID/UPDATE_PASSWORD/NETWORK_STATUS/SESAME_KEYS/OPEN_OTA_SERVER を正しい kind に振り分け、未対応 itemCode は {kind:'unknown', itemCode, body} を返す
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:461-529; packages/core/src/ble/wm2.js:334-353
- kind: payload-fidelity
- status: planned
- note: kt:461-529 onGattWM2Publish が OPEN_OTA(465)/SESAME_KEYS(468)/SCAN(486)/UPDATE_SSID(491)/UPDATE_PASSWORD(496)/NETWORK_STATUS(502)/INITIAL(521) を逐次 if で処理。core parseWM2Publish (wm2.js:334-353) は各 kind に振り分け default で {kind:'unknown',itemCode,body} (wm2.js:351)。注: INITIAL(13) は session 層で処理され parseWM2Publish では unknown 扱い。

## hub3-itemcodes

Hub3 Wi-Fi itemCode と各送信コマンドのバイト列。Hub3 は SESAME 既定 GATT・CMAC 鍵を WM2 のような override なしで継承。

### [BLE3-0103] Hub3 Wi-Fi itemCode が SesameItemCode と 1:1 (131/135/136/133/132/134)
- surface: core
- backend: ble
- command: `ITEM_CODES (Hub3 Wi-Fi)`
- branch: -
- assert: HUB3_ITEM_CODE_WIFI_SSID=131/SSID_FIRST=132/SSID_NOTIFY=133/SSID_LAST=134/WIFI_PASSWORD=135/UPDATE_WIFI_SSID=136 が SesameProtocols.kt の SesameItemCode と一致
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:40
- kind: payload-fidelity
- status: planned
- note: SesameProtocols.kt:40 で HUB3_ITEM_CODE_WIFI_SSID(131u)/SSID_FIRST(132u)/SSID_NOTIFY(133u)/SSID_LAST(134u)/WIFI_PASSWORD(135u)/HUB3_UPDATE_WIFI_SSID(136u) を確認、全 6 値一致。

### [BLE3-0104] Hub3 は SESAME 既定 GATT を使う (WM2 専用 GATT は使わない)
- surface: core
- backend: ble
- command: `Hub3Commands (GATT)`
- branch: -
- assert: Hub3 は CHSesameOS3 継承で fd81 系既定 GATT で discover/subscribe し、session.js (register/login=CMAC(secretKey,token4)) を WM2 のようなオーバーライドなしで使う
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:167-207; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/base/CHSesameOS3.kt:56; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:81
- kind: payload-fidelity
- status: planned
- note: CHHub3Device は onServicesDiscovered/connect/discover を override しない(grep 0 hit)→ CHSesameOS3.kt:56(open class : CHBaseDevice)・191-198(onServicesDiscovered で service01=fd81 を subscribe)を継承。fd81=SesameProtocols.kt:81 uuidService01。login(CHHub3Device.kt:172=CMAC(secretKey)/175=sliceArray(0..3)=token4)・register(181-207)。

### [BLE3-0105] Hub3 scanWifiSSID 送信 = HUB3_ITEM_CODE_WIFI_SSID(131) + 空 data
- surface: core
- backend: ble
- command: `ble.hub3.scanWifiSSID / Hub3Commands.scanWifiSSID`
- branch: -
- assert: scanWifiSSID は itemCode 131・data 長 0 で session.request する。結果は SSID_NOTIFY(133) publish
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:242-248; packages/core/src/itemcodes.js:170-172
- kind: payload-fidelity
- status: planned
- note: CHHub3Device.kt:245 sendCommand(SesameOS3Payload(HUB3_ITEM_CODE_WIFI_SSID(131),byteArrayOf())) で data 長 0。結果=SSID_NOTIFY(133) publish は itemcodes.js:170-172 のコメント/定数(HUB3_ITEM_CODE_SSID_NOTIFY=133)で裏付け。

### [BLE3-0106] Hub3 setWifiSSID 送信 = HUB3_UPDATE_WIFI_SSID(136) + SSID の UTF-8
- surface: core
- backend: ble
- command: `ble.hub3.setWifiSSID / Hub3Commands.setWifiSSID`
- branch: -
- assert: setWifiSSID は itemCode 136・data = ssid.toByteArray() (UTF-8) で送る
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:259-269; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:40
- kind: payload-fidelity
- status: planned
- note: CHHub3Device.kt:260 = SesameOS3Payload(HUB3_UPDATE_WIFI_SSID.value, ssid.toByteArray())。HUB3_UPDATE_WIFI_SSID=136u は SesameProtocols.kt:40。移植先 hub3.js:73-76,338-341 と 1:1。

### [BLE3-0107] Hub3 setWifiPassword 送信 = HUB3_ITEM_CODE_WIFI_PASSWORD(135) + password の UTF-8
- surface: core
- backend: ble
- command: `ble.hub3.setWifiPassword / Hub3Commands.setWifiPassword`
- branch: -
- assert: setWifiPassword は itemCode 135・data = password.toByteArray() (UTF-8) で送る
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:250-257; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:40
- kind: payload-fidelity
- status: planned
- note: CHHub3Device.kt:251 = SesameOS3Payload(HUB3_ITEM_CODE_WIFI_PASSWORD.value, password.toByteArray())。HUB3_ITEM_CODE_WIFI_PASSWORD=135u は SesameProtocols.kt:40。移植先 hub3.js:83-86,344-346 と 1:1。

### [BLE3-0108] Hub3 removeSesame 送信 = REMOVE_SESAME(103) + dash 除去 UUID を decode した生 16B
- surface: core
- backend: ble
- command: `ble.hub3.removeSesame / Hub3Commands.removeSesame`
- branch: -
- assert: removeSesame は itemCode 103・data = tag.replace('-','').hexStringToByteArray() の生 16B (WM2 の UTF-8 大文字文字列とは経路が異なる)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:232-240; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:413-415
- kind: payload-fidelity
- status: planned
- note: CHHub3Device.kt:234-236 = noDashUUID=tag.replace("-",""); SesameOS3Payload(REMOVE_SESAME.value, noDashUUID.hexStringToByteArray())。REMOVE_SESAME=103u は SesameProtocols.kt:36。対比 (WM2 経路) CHWifiModule2Device.kt:413-415 = sesameKeyTag.uppercase().toByteArray()。移植先 hub3.js:98-101 と 1:1。

### [BLE3-0109] Hub3 removeSesame 空タグは必須検証で reject
- surface: core
- backend: ble
- command: `removeSesameData (hub3)`
- branch: empty-tag
- assert: tag が非文字列または空文字列のとき ble.wm2SesameKeyTagRequired で throw
- ref: packages/core/src/ble/hub3.js:98-101; packages/core/src/i18n/ble.js:71
- kind: error-path
- status: planned
- note: 局所契約 (local-contract)。hub3.js:99 = if (typeof tag !== "string" || tag.length === 0) throw new Error(t("ble.wm2SesameKeyTagRequired"))。i18n キーは i18n/ble.js:71 に実在。SDK 原文 (CHHub3Device.kt:234-235) は noDashUUID!=null の null チェックのみで空文字列を reject しないため、これは移植先が追加した防御的検証 = local-contract。

### [BLE3-0110] Hub3 に connectWifi は存在しない (WM2 のみ CONNECT_WIFI)
- surface: core, serve, cli
- backend: ble
- command: `Hub3Commands / ble.wifi.connect`
- branch: hub3-reject
- assert: Hub3Commands に connectWifi メソッドは無く、ble.wifi.connect / CLI ble wifi connect が Hub3 (type!=='wm2') のとき bad_params で拒否する (Hub3 は SSID/PW 設定後に本体側で適用)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:232-269; packages/kit/src/serve/entries/ble.js:241-259
- kind: error-path
- status: planned
- note: CHHub3Device.kt:232-269 は Wi-Fi 系メソッド (removeSesame/scanWifiSSID/setWifiPassword/setWifiSSID) のみで connectWifi 無し。impl Hub3Commands (hub3.js:306-) も scanWifiSSID/setWifiSSID/setWifiPassword/removeSesame/networkType のみ。serve ble.js:241-259 の ble.wifi.connect handler は type!=='wm2' で RpcError(KIND.BAD_PARAMS) を throw。CLI ble.js:653 も connectWm2Only で die(…,2)。

## hub3-publish

Hub3 publish のパース (scan/marker/mechSetting/mechStatus/keys/ota) と dispatch・networkType(@experimental)。

### [BLE3-0111] Hub3 SSID_NOTIFY(133) publish = rssi(LE signed int16) + ssid(UTF-8)
- surface: core
- backend: ble
- command: `parseScanWifiSSID (hub3) / parseHub3Publish`
- branch: -
- assert: SSID_NOTIFY(133) publish の payload[0..1] を little-endian signed short で rssi、drop(2) を UTF-8 で ssid に解析 (WM2 と同一ロジック)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:326-330; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/utils/DataExtention.kt:99-102
- kind: payload-fidelity
- status: planned
- note: CHHub3Device.kt:327-328 = bytesToShort(payload[0], payload[1]) と String(payload.drop(2))。bytesToShort は DataExtention.kt:99-102 で LE signed short = readInt16LE 等価。HUB3_ITEM_CODE_SSID_NOTIFY=133u は SesameProtocols.kt:40。移植先 hub3.js:128-134 (readInt16LE) と 1:1。

### [BLE3-0112] Hub3 SSID_FIRST(132)/SSID_LAST(134) publish はマーカー (SDK no-op)
- surface: core
- backend: ble
- command: `parseHub3Publish (ssidMarker)`
- branch: first | last
- assert: SSID_FIRST(132)/SSID_LAST(134) publish を {kind:'ssidMarker', itemCode} に正規化 (SDK では両方とも空ブロック)。SSID_LAST は collectWifiScan の早期確定トリガ
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:324-325; packages/core/src/ble/rpc-helpers.js:148
- kind: payload-fidelity
- status: planned
- note: CHHub3Device.kt:324-325 = SSID_FIRST.value -> {} / SSID_LAST.value -> {} (両方とも空ブロック)。132/134 は SesameProtocols.kt:40。SSID_LAST 早期確定は rpc-helpers.js:148 = collectWifiScan が p.kind==="ssidMarker" && p.itemCode===HUB3_ITEM_CODE_SSID_LAST で収集を確定する。移植先 hub3.js:291-294 と 1:1。

### [BLE3-0113] Hub3 mechSetting(80) publish = SSID/パスワード (旧60B/新96B ファーム分岐)
- surface: core
- backend: ble
- command: `parseMechSetting / parseHub3Publish`
- branch: old-fw-60B | new-fw-96B
- assert: payload<96B は SSID=[0..29]/PW=[30..59]、>=96B は SSID=[0..31]/PW=[32..95] を文字列化し末尾の 0x00 と '?' を trim する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:276-289
- kind: payload-fidelity
- status: planned
- note: CHHub3Device.kt:277-287 = payload.size<96 → SSID copyOfRange(0,30)/PW copyOfRange(30,60)、else → SSID copyOfRange(0,32)/PW copyOfRange(32,96)、いずれも String(...).trimEnd(0.toChar(), '?'.toChar())。mechSetting=80u は SesameProtocols.kt:36。移植先 hub3.js:171-207 と 1:1 (trim は ReDoS 回避の線形ループ実装)。

### [BLE3-0114] Hub3 mechStatus(81) publish = ネットワーク状態 bit ベクタ (WM2 と同 layout)
- surface: core
- backend: ble
- command: `parseNetworkStatus / parseHub3Publish`
- branch: -
- assert: Hub3 の MECH_STATUS(81) は payload[0] のネットワーク状態 bit フラグ (ロック機構状態ではない) で、WM2 NETWORK_STATUS(6) と同一 bit layout の共有 parser で解析する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:291-301; packages/core/src/ble/protocol.js:807-826
- kind: payload-fidelity
- status: planned
- note: P3-16 共有化。kt:291-301 は mechStatus case (isAp=&2 … isIOTConnecting=payload[0]<0 → CHWifiModule2NetWorkStatus)。protocol.js の parseNetworkStatus (807 開始・return 本体 813-820・関数末 826) が同一 bit 配置 (bit7 を b&0x80 で判定し Kotlin signed byte<0 と等価)。

### [BLE3-0115] Hub3 PUB_KEY_SESAME(102) publish = 23B チャンク・生16B UUID・status!=0 のみ
- surface: core
- backend: ble
- command: `parseSesameKeys (hub3) / parseHub3Publish`
- branch: status-nonzero | status-zero-skip
- assert: PUB_KEY_SESAME(102) を 23B チャンク分割し、chunk[22]!=0 のみ chunk[0..15] を生 UUID バイト (hex→UUID) として返す。index は全エントリ採番 (forEachIndexed)。WM2 の base64 経路とは別
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:303-318; packages/core/src/ble/hub3.js:222-244
- kind: payload-fidelity
- status: planned
- note: kt:303-318 は PUB_KEY case (divideArray(23) kt:306, forEachIndexed kt:307, lock_status=it[22] kt:308, status!=0 ガード kt:309, ss5_id=sliceArray(0,15) kt:310, noHashtoUUID kt:311)。impl hub3.js parseSesameKeys は index を全エントリで採番し lockStatus===0 を skip・先頭16B を生 UUID 化 (wm2.js の base64 経路と分離)。

### [BLE3-0116] Hub3 MOVE_TO(84) publish = OTA 進捗 1B
- surface: core
- backend: ble
- command: `parseHub3Publish (otaProgress)`
- branch: -
- assert: MOVE_TO(84) publish を payload.first() の OTA 進捗 1B として {kind:'otaProgress', progress} に正規化
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:320-322; packages/core/src/ble/hub3.js:283-285
- kind: payload-fidelity
- status: planned
- note: kt:320-322 は moveTo case → onOTAProgress(this, payload.first())。moveTo=84u (SesameProtocols.kt:32-53)。impl hub3.js は case ITEM.MOVE_TO で {kind:'otaProgress', progress: buf.length>0 ? buf[0] : 0} を返す (空 payload を 0 にフォールバックする点が SDK の first() より防御的)。

### [BLE3-0117] Hub3 parseHub3Publish の itemCode ディスパッチ網羅と unknown fallback
- surface: core
- backend: ble
- command: `parseHub3Publish`
- branch: known-codes | unknown
- assert: parseHub3Publish が MECH_SETTING(80)/MECH_STATUS(81)/PUB_KEY_SESAME(102)/MOVE_TO(84)/SSID_NOTIFY(133)/SSID_FIRST(132)/SSID_LAST(134) を正しい kind に振り分け、NETWORK_TYPE(209) は @experimental 別経路で {kind:'networkType'} に、未対応は {kind:'unknown'}
- ref: packages/core/src/ble/hub3.js:272-301; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:272-338
- kind: payload-fidelity
- status: planned
- note: ディスパッチ網羅契約の一次ソースは impl parseHub3Publish (hub3.js:272-301)。SDK の when ブロック (kt:275-336: mechSetting80/mechStatus81/PUB_KEY102/moveTo84/SSID_FIRST132/SSID_LAST134/SSID_NOTIFY133+else) に 209 case は無く、impl は 209 を UNVERIFIED_ITEM_CODES 経由の @experimental 別 case として扱う (hub3.js:288-290, P3-14)。SSID_FIRST/LAST は SDK 側 no-op (kt:324-325) だが impl は {kind:'ssidMarker'} を返す差分あり。

### [BLE3-0118] Hub3 networkType(209) は SDK 非由来の @experimental 経路 (UNVERIFIED)
- surface: core, serve, sdk
- backend: ble
- command: `ble.hub3.networkType / Hub3Commands.networkType`
- branch: unverified
- assert: itemCode 209 は SesameItemCode に存在せず (enum は 208 で終端)、CHHub3Device に送受信ハンドラも無い。networkType 系は UNVERIFIED_ITEM_CODES を参照する @experimental で biz3 web ブリッジからの推定
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:52; references_web/src/components/MobileWifiModule.js:219-235
- kind: contract-existence
- status: waived: itemCode 209 は一次ソース非存在・実機 BLE 往復でしか存在確認できない @experimental 経路 (§9 V6)
- note: SesameProtocols.kt:52 が SesameItemCode enum の末尾行で HUB3_ITEM_CODE_RELAY_SWITCH(208u) で終端 (enum span kt:32-53)、209 は不在。CHHub3Device.kt の onGattSesamePublish when (kt:272-338) にも 209 case 無し。MobileWifiModule.js:219-235 は requestNetworkType bridge が onNetworkType で {isWifiConnected,isLTEConnected} を返す挙動を示す。impl hub3.js は Hub3Commands.networkType を UNVERIFIED.HUB3_ITEM_CODE_NETWORK_TYPE 経由に隔離 (hub3.js:36-37,367-368)。

### [BLE3-0119] Hub3 parseNetworkType payload = [isWifiConnected 1B][isLTEConnected 1B] (推定)
- surface: core
- backend: ble
- command: `parseNetworkType`
- branch: valid | short-payload
- assert: NETWORK_TYPE(209) payload[0]==1→isWifiConnected / payload[1]==1→isLTEConnected と推定解析し、2B 未満は ble.hub3NetworkTypeShort で throw
- ref: references_web/src/components/MobileWifiModule.js:219-235; packages/core/src/ble/hub3.js:152-159
- kind: error-path
- status: planned
- note: @experimental バイト配置の一次ソース無し。impl parseNetworkType (hub3.js:152-159) は buf.length<2 で t('ble.hub3NetworkTypeShort') を throw (i18n キー実在: packages/core/src/i18n/ble.js:79,252)、>=2B で {isWifiConnected: buf[0]===1, isLTEConnected: buf[1]===1}。bridge の 2 boolean 形は MobileWifiModule.js:219-235 が支持するが [wifi 1B][lte 1B] のバイト順は一次ソース無しの推定 (short-payload ガード自体はローカル検証可のため planned 維持)。

## wifi-shared

WM2/Hub3 を抽象する wifiViewOf / collectWifiScan とファサード relay・session 必須検証。

### [BLE3-0120] collectWifiScan: publish 収集・SSID 重複統合・Hub3 SSID_LAST 早期確定/WM2 打ち切り
- surface: core, serve, cli
- backend: ble
- command: `collectWifiScan / ble.wifi.scan`
- branch: hub3-last-marker | wm2-timeout
- assert: scanWifiSSID 送信後 {kind:'scanWifiSSID'} publish を収集し同一 SSID は rssi を更新 (重複行なし)。Hub3 は SSID_LAST(134) マーカーで早期確定、WM2 は終了通知が無いため collectMs で打ち切る
- ref: packages/core/src/ble/rpc-helpers.js:129-162; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHHub3Device.kt:325
- kind: option-branch
- status: planned
- note: collectWifiScan は rpc-helpers.js:129(decl)-162(close)。147=found.set(SSID dedup/rssi 更新)、148-149=SSID_LAST マーカーで finish() 早期確定、152=setTimeout(finish,collectMs) で WM2 打ち切り。CHHub3Device.kt:325 = HUB3_ITEM_CODE_SSID_LAST.value->{}。

### [BLE3-0121] collectWifiScan: scanWifiSSID ack 失敗は収集を打ち切って伝搬
- surface: core, serve, cli
- backend: ble
- command: `collectWifiScan`
- branch: ack-error
- assert: scanWifiSSID() の ack が reject (BleResultError 等) のとき収集を打ち切り、購読を外して error を伝搬する
- ref: packages/core/src/ble/rpc-helpers.js:154-160
- kind: error-path
- status: planned
- note: 実体は 154(Promise.resolve(view.scanWifiSSID()).catch)〜159(reject(err))。154 で ack を待ち、done ガード後 clearTimeout+off()(購読解除)+reject(err) を実施。

### [BLE3-0122] wifiViewOf: model 能力で WM2/Hub3 を判別し非対応は bad_params
- surface: core, serve, cli
- backend: ble
- command: `wifiViewOf`
- branch: wm2 | hub3 | unsupported
- assert: wifiProvisioning→ble.wifi(companyId)、hubProvisioning→ble.hub3()、どちらでもない model は serve.bleWifiNotSupported で bad_params (op を捏造して実機に送らない)
- ref: packages/core/src/ble/rpc-helpers.js:112-117
- kind: option-branch
- status: planned
- note: wifiViewOf は 112(decl)-117(close)。114=caps.wifiProvisioning→{type:'wm2',ble.wifi({companyId})}、115=caps.hubProvisioning→{type:'hub3',ble.hub3()}、116=throw RpcError(serve.bleWifiNotSupported, BAD_PARAMS)。op 送信前に分岐するため捏造送信なし。

### [BLE3-0123] WifiModule2/Hub3Commands が session publish を正規化中継し dispose で外す
- surface: core
- backend: ble
- command: `WifiModule2.onPublish/dispose / Hub3Commands.onPublish/dispose`
- branch: relay | dispose-idempotent
- assert: session の生 publish を parseWM2Publish/parseHub3Publish で正規化して購読者に中継し、dispose で session 中継を外し購読者集合をクリアする (購読者の例外は他に波及しない)
- ref: packages/core/src/ble/wm2.js:368-393; packages/core/src/ble/hub3.js:311-328
- kind: idempotency
- status: planned
- note: WM2 constructor が session.onPublish→parseWM2Publish 中継 (L378-382), onPublish (L390), dispose は _off() 呼び後 null 化 + _publishListeners.clear() (L393)。Hub3 も同型: 中継 (L317-321), onPublish (L325), dispose (L328)。購読者の例外は for ループ内 try/catch で隔離 (wm2.js:381 / hub3.js:320)。dispose は _off の null ガードで再呼び出し冪等。

### [BLE3-0124] WifiModule2/Hub3Commands は session 無しで構築 throw
- surface: core
- backend: ble
- command: `new WifiModule2 / new Hub3Commands`
- branch: no-session
- assert: session を渡さず構築すると WifiModule2 は ble.wm2SessionRequired、Hub3Commands は ble.hub3SessionRequired で throw する
- ref: packages/core/src/ble/wm2.js:368-369; packages/core/src/ble/hub3.js:311-312
- kind: error-path
- status: planned
- note: wm2.js:369 が `if (!session) throw new Error(t("ble.wm2SessionRequired"))`、hub3.js:312 が同形で ble.hub3SessionRequired。i18n キーは i18n/ble.js:73,78(en)/246,251(ja) に実在。両ファサードは OS3 GATT 前提 (backend ble)。

## card/passcode write

生体機の NFC カード/キーパッドパスコードの追加・削除・移動・改名のバイト列。card と passcode は同一レイアウトで itemCode のみ差異 (定数名 CARD_*/KB_*)。

### [BLE3-0125] cardAdd payload = [F0][00][idLen] ++ id.padEnd(16) ++ [nameLen] ++ name.padEnd(16)
- surface: core, serve, sdk
- backend: ble
- command: `ble.biometric.cardAdd / cardAddData`
- branch: -
- assert: cardAddData(id, hexName) のバイト列が CHCardCapableImpl.cardAdd の SesameOS3Payload(SSM_OS3_CARD_ADD=140, [0xF0][0x00][id.size]++id.padEnd(16,0x00)++[name.size]++name.toByteArray().padEnd(16,0x00)) と完全一致する (固定ヘッダ CARD_DATA_USED=0xF0 / CARD_TYPE_CLOUD_BASE=0x00、idLen/nameLen=実バイト長、name は UTF-8、16B 右ゼロパディング)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/card/CHCardCapableImpl.kt:83; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/utils/DataExtention.kt:94; packages/core/src/ble/biometric.js:374; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:40
- kind: payload-fidelity
- status: planned
- note: CHCardCapableImpl.kt cardAdd override は :83、payload byteArrayOf(0xF0)++byteArrayOf(0x00)++id.size++id.padEnd(16)++name.size++name.toByteArray().padEnd(16) は :87。DataExtention.kt padEnd は :94 def / :95 (size>=length return this 切らない) / :96 右ゼロ詰め。SesameProtocols.kt:40 に SSM_OS3_CARD_ADD(140u)。biometric.js cardAddData は :374-383、padEnd(buf,size,0x00) は :91、CARD_DATA_USED=0xf0/:39・TYPE_CLOUD_BASE=0x00/:40 と一致。name>16B 時 nameLen は実長だが枠は伸びる点も再現。

### [BLE3-0126] passcodeAdd payload = [F0][00][idLen] ++ id.padEnd(16) ++ [nameLen] ++ name.padEnd(16) (KB_* 定数)
- surface: core, serve, sdk
- backend: ble
- command: `ble.biometric.passcodeAdd / passcodeAddData`
- branch: -
- assert: passcodeAddData(id, hexName) のバイト列が CHPassCodeCapableImpl.keyBoardPassCodeAdd の SesameOS3Payload(SSM_OS3_PASSCODE_ADD=138, [0xF0/*KB_DATA_USED*/][0x00/*KB_TYPE_CLOUD*/][id.size]++id.padEnd(16,0x00)++[name.size]++name.padEnd(16,0x00)) と完全一致する (card と同一レイアウト、定数名のみ KB_*)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/passcode/CHPassCodeCapableImpl.kt:39-48; packages/core/src/ble/biometric.js:462-471; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:40; packages/core/src/itemcodes.js:120
- kind: payload-fidelity
- status: planned
- note: PASSCODE_ADD=138 は SesameProtocols.kt:40。card/passcode で同一の固定ヘッダ・16B 枠を共有 (定数名は CARD_DATA_USED vs KB_DATA_USED で同値 0xF0; JS は両者を共有定数 CARD_DATA_USED=0xf0/TYPE_CLOUD_BASE=0x00 biometric.js:39-40 で表現)。itemcodes.js:120 (PASSCODE_ADD:138)。

### [BLE3-0127] cardDelete payload = cardID(hex→bytes)、itemCode CARD_DELETE=108
- surface: core, serve, sdk
- backend: ble
- command: `ble.biometric.cardDelete / cardDeleteData`
- branch: -
- assert: cardDeleteData(cardID) が cardID.hexStringToByteArray() のみ (ヘッダ無し) で、BiometricCommands.cardDelete が itemCode SSM_OS3_CARD_DELETE=108 で送る — CHCardCapableImpl.cardDelete の SesameOS3Payload(108, cardID.hexStringToByteArray()) と一致する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/card/CHCardCapableImpl.kt:60-70; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/utils/DataExtention.kt:58-59; packages/core/src/ble/biometric.js:390; packages/core/src/ble/biometric.js:997; packages/core/src/itemcodes.js:90
- kind: payload-fidelity
- status: planned
- note: CardDelete:108 itemcodes.js:90, dispatch biometric.js:997。DELETE 送信は id 生バイトのみ。受信 publish の DELETE は [type][idLen][id..] と別レイアウト (parseTouchCard biometric.js:135-137 参照、別候補)。hexStringToByteArray は 2 文字/byte (DataExtention.kt:58-59)。

### [BLE3-0128] passcodeDelete payload = id(hex→bytes)、itemCode PASSCODE_DELETE=124
- surface: core, serve, sdk
- backend: ble
- command: `ble.biometric.passcodeDelete / passcodeDeleteData`
- branch: -
- assert: passcodeDeleteData(keyBoardPassCodeID) が id の hexStringToByteArray() のみで、itemCode SSM_OS3_PASSCODE_DELETE=124 で送る — CHPassCodeCapableImpl.keyBoardPassCodeDelete の SesameOS3Payload(124, id.hexStringToByteArray()) と一致する (Kotlin の deviceId 第2引数は payload に乗らない)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/passcode/CHPassCodeCapableImpl.kt:113-117; packages/core/src/ble/biometric.js:478; packages/core/src/ble/biometric.js:1030; packages/core/src/itemcodes.js:113
- kind: payload-fidelity
- status: planned
- note: Kotlin keyBoardPassCodeDelete(keyBoardPassCodeID, deviceId) の deviceId は送信バイトに含まれない (CHPassCodeCapableImpl.kt:114 は keyBoardPassCodeID.hexStringToByteArray() のみ) — kit が deviceId を取らないことの正当性。dispatch biometric.js:1030, PASSCODE_DELETE:124 itemcodes.js:113。

### [BLE3-0129] cardMove payload = [idLen] ++ id(hex→bytes) ++ touchProUUID(UTF-8)
- surface: core, serve, sdk
- backend: ble
- command: `ble.biometric.cardMove / cardMoveData`
- branch: -
- assert: cardMoveData(cardId, touchProUUID) が [id.size(1B)] ++ id.hexStringToByteArray() ++ touchProUUID.toByteArray()(UTF-8) で、itemCode SSM_OS3_CARD_MOVE=141 — CHCardCapableImpl.cardMove と一致する (idLen は hex→byte 後の長さ、UUID は UTF-8 文字列でハイフン込みのまま)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/card/CHCardCapableImpl.kt:72-81; packages/core/src/ble/biometric.js:397-400; packages/core/src/itemcodes.js:99; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:40
- kind: payload-fidelity
- status: planned
- note: CARD_MOVE=141 (SesameProtocols.kt:40, itemcodes.js:99)。touchProUUID は toByteArray()=UTF-8 で raw 文字列 (ハイフン保持) — uuidToBytes 化しない点が罠。

### [BLE3-0130] passcodeMove payload = [idLen] ++ id(hex→bytes) ++ touchProUUID(UTF-8)
- surface: core, serve, sdk
- backend: ble
- command: `ble.biometric.passcodeMove / passcodeMoveData`
- branch: -
- assert: passcodeMoveData(cardId, touchProUUID) が [id.size] ++ id(hex→bytes) ++ touchProUUID(UTF-8) で、itemCode SSM_OS3_PASSCODE_MOVE=142 — CHPassCodeCapableImpl.keyBoardPassCodeMove と一致する (card.move と同一アルゴリズム)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/passcode/CHPassCodeCapableImpl.kt:119-128; packages/core/src/ble/biometric.js:485-488; packages/core/src/itemcodes.js:121; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:40
- kind: payload-fidelity
- status: planned
- note: PASSCODE_MOVE=142 (SesameProtocols.kt:40, itemcodes.js:121)。引数名は cardId だが passcode id。

### [BLE3-0131] cardChange payload = [idLen] ++ id(hex→bytes) ++ hexName(chunked(2) 畳み込み)
- surface: core, serve, sdk
- backend: ble
- command: `ble.biometric.cardChange / cardChangeData`
- branch: -
- assert: cardChangeData(ID, hexName) が [id.size] ++ id(hex→bytes) ++ hexName を 2 文字ずつ byte 化したもので、itemCode SSM_OS3_CARD_CHANGE=107 — CHCardCapableImpl.cardChange の hexName.chunked(2).map{it.toInt(16).toByte()} と一致する (新方式: name=16B UUID を hex で渡す)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/card/CHCardCapableImpl.kt:157-167; packages/core/src/ble/biometric.js:409-412; packages/core/src/ble/biometric.js:120-126; packages/core/src/itemcodes.js:89; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:37
- kind: payload-fidelity
- status: planned
- note: CARD_CHANGE=107 (SesameProtocols.kt:37, itemcodes.js:89)。Kotlin の chunked(2)/toByte() は CHCardCapableImpl.kt:162。hexNameToBytes(biometric.js:120-126) が Kotlin chunked(2) 同様、奇数長末尾 1 文字も独立 byte 化する (loop i<len, slice(i,i+2))。cardChangeValue (CHCardCapableImpl.kt:169-178, newID は UTF-8) とは別レイアウト。

### [BLE3-0132] passcodeChange payload = [idLen] ++ id(hex→bytes) ++ hexName(chunked(2) 畳み込み)
- surface: core, serve, sdk
- backend: ble
- command: `ble.biometric.passcodeChange / passcodeChangeData`
- branch: -
- assert: passcodeChangeData(ID, hexName) が [id.size] ++ id(hex→bytes) ++ hexName(2文字/byte) で、itemCode SSM_OS3_PASSCODE_CHANGE=123 — CHPassCodeCapableImpl.keyBoardPassCodeChange と一致する (card.change と同一アルゴリズム)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/passcode/CHPassCodeCapableImpl.kt:130-137; packages/core/src/ble/biometric.js:495-498; packages/core/src/itemcodes.js:112; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:39
- kind: payload-fidelity
- status: planned
- note: PASSCODE_CHANGE=123 (SesameProtocols.kt:39, itemcodes.js:112)。chunked(2)/toByte() は CHPassCodeCapableImpl.kt:132。

### [BLE3-0133] cardChangeValue payload = [idLen] ++ id(hex→bytes) ++ newID(UTF-8) (CHANGE と別物)
- surface: core, serve, sdk
- backend: ble
- command: `ble.biometric.cardChangeValue / cardChangeValueData`
- branch: -
- assert: cardChangeValueData(ID, newID) が [id.size] ++ id(hex→bytes) ++ newID.toByteArray()(UTF-8) で、itemCode SSM_OS3_CARD_CHANGE_VALUE=139 — CHCardCapableImpl.cardChangeValue と一致する (newID は hex 畳み込みでなく UTF-8 そのまま — cardChange の hexName 畳み込みとの差異が罠)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/card/CHCardCapableImpl.kt:169-178; packages/core/src/ble/biometric.js:420-423; packages/core/src/itemcodes.js:97
- kind: payload-fidelity
- status: planned
- note: cardChangeValue (SDK 173) は newID.toByteArray()=UTF-8、cardChange (SDK 162) は hexName.chunked(2)…toInt(16)=hex 畳み込み — 差異確認。CARD_CHANGE_VALUE=139 (SesameProtocols.kt:40)。passcode 側に対応コマンドは無い (CHPassCodeCapableImpl 全読し changeValue 不在を確認) — card 専用。

### [BLE3-0134] cardChange (hex畳み込み) と cardChangeValue (UTF-8) の name エンコード非対称
- surface: core
- backend: ble
- command: `cardChangeData / cardChangeValueData`
- branch: change=hexName畳み込み | changeValue=newID UTF-8
- assert: cardChangeData は第2引数を hexNameToBytes (2文字/byte 畳み込み) で byte 化し、cardChangeValueData は newID.toByteArray()(UTF-8) でそのまま byte 化する — 同じ name 位置でも CHANGE(107)=hex畳み込み / CHANGE_VALUE(139)=UTF-8 という Kotlin の差異を固定する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/card/CHCardCapableImpl.kt:162; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/card/CHCardCapableImpl.kt:173; packages/core/src/ble/biometric.js:411; packages/core/src/ble/biometric.js:422
- kind: payload-fidelity
- status: planned
- note: Kotlin cardChange は hexName.chunked(2).map{toInt(16)} (kt:162)、cardChangeValue は newID.toByteArray() (kt:173)。混同すると壊れる二重トラップ。

### [BLE3-0135] cardModeSet payload = [mode 1B]、itemCode CARD_MODE_SET=114
- surface: core, serve, sdk
- backend: ble
- command: `ble.biometric.cardModeSet / cardModeSetData`
- branch: -
- assert: cardModeSetData(mode) が [mode & 0xff] の 1B で、cardModeSet が itemCode SSM_OS3_CARD_MODE_SET=114 で送る — CHCardCapableImpl.cardModeSet の SesameOS3Payload(114, byteArrayOf(mode)) と一致する (応答後デバイスが CARD_FIRST/NOTIFY/LAST を push)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/card/CHCardCapableImpl.kt:49-58; packages/core/src/ble/biometric.js:362; packages/core/src/ble/biometric.js:990; packages/core/src/itemcodes.js:96
- kind: payload-fidelity
- status: planned
- note: CARD_MODE_SET=114 (SesameProtocols.kt:37; itemcodes.js:96)。result:'ack' (BIOMETRIC_RPC_OPS biometric.js:1438)。CLI に専用 modeSet サブコマンドは無い (write は ble invoke 経由) ため surface に cli を含めず正しい。

### [BLE3-0136] passcodeModeSet payload = [mode 1B]、itemCode PASSCODE_MODE_SET=130
- surface: core, serve, sdk
- backend: ble
- command: `ble.biometric.passcodeModeSet / passcodeModeSetData`
- branch: -
- assert: passcodeModeSetData(mode) が [mode & 0xff] の 1B で、itemCode SSM_OS3_PASSCODE_MODE_SET=130 で送る — CHPassCodeCapableImpl.keyBoardPassCodeModeSet の SesameOS3Payload(130, byteArrayOf(mode)) と一致する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/passcode/CHPassCodeCapableImpl.kt:33-37; packages/core/src/ble/biometric.js:451; packages/core/src/ble/biometric.js:1023; packages/core/src/itemcodes.js:119
- kind: payload-fidelity
- status: planned
- note: PASSCODE_MODE_SET=130 (SesameProtocols.kt:39; itemcodes.js:119)。biometric.js:1023 passcodeModeSet→_req(ITEM.PASSCODE_MODE_SET,...) 確認。CLI 専用 modeSet 無しのため surface に cli 不含で正しい。

### [BLE3-0137] cardModeGet 空 payload 送信・応答 payload[0]=mode、itemCode CARD_MODE_GET=113
- surface: core, serve, sdk, cli
- backend: ble
- command: `sesame ble mode <device> card / ble.biometric.cardModeGet`
- branch: -
- assert: cardModeGetData() が空 (byteArrayOf()) で itemCode SSM_OS3_CARD_MODE_GET=113 を送り、cardModeGet() が応答 res.payload[0] を mode byte として返す — CHCardCapableImpl.cardModeGet (返り値 res.payload[0]) と一致する。result:'raw' で SDK へ返る
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/card/CHCardCapableImpl.kt:38-47; packages/core/src/ble/biometric.js:364; packages/core/src/ble/biometric.js:991; packages/core/src/ble/biometric.js:1439; packages/kit/src/cli/ble.js:100
- kind: payload-fidelity
- status: planned
- note: CARD_MODE_GET=113 (SesameProtocols.kt:37; itemcodes.js:95)。CLI 経路は cmdBiometricMode→BIO_MODE.card='cardModeGet' (cli/ble.js:100; mode サブコマンド定義 cli/ble.js:170)。result:'raw' (BIOMETRIC_RPC_OPS biometric.js:1439)。

### [BLE3-0138] passcodeModeGet 空 payload・応答 payload[0]=mode、itemCode PASSCODE_MODE_GET=129
- surface: core, serve, sdk, cli
- backend: ble
- command: `sesame ble mode <device> passcode / ble.biometric.passcodeModeGet`
- branch: -
- assert: passcodeModeGetData() が空で itemCode SSM_OS3_PASSCODE_MODE_GET=129 を送り、passcodeModeGet() が res.payload[0] を返す — CHPassCodeCapableImpl.keyBoardPassCodeModeGet と一致する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/passcode/CHPassCodeCapableImpl.kt:27-31; packages/core/src/ble/biometric.js:452; packages/core/src/ble/biometric.js:1024; packages/kit/src/cli/ble.js:101
- kind: payload-fidelity
- status: planned
- note: PASSCODE_MODE_GET=129 (SesameProtocols.kt:39; itemcodes.js:118)。CLI: BIO_MODE.passcode='passcodeModeGet' (cli/ble.js:101)。result:'raw' (BIOMETRIC_RPC_OPS biometric.js:1449)。

### [BLE3-0139] cardGet 空 payload 送信、itemCode CARD_GET=109 (一覧 publish のトリガ)
- surface: core, serve, sdk, cli
- backend: ble
- command: `sesame ble cards <device> / ble.biometric.cardGet`
- branch: -
- assert: cardGetData() が空 (byteArrayOf()) で itemCode SSM_OS3_CARD_GET=109 を送る — CHCardCapableImpl.sendNfcCardsDataGetCmd の SesameOS3Payload(SSM_OS3_CARD_GET, byteArrayOf()) と一致する (実データは CARD_FIRST/NOTIFY×N/LAST publish で届く)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/card/CHCardCapableImpl.kt:29-36; packages/core/src/ble/biometric.js:365; packages/core/src/ble/biometric.js:993; packages/core/src/itemcodes.js:91
- kind: payload-fidelity
- status: planned
- note: CARD_GET=109 (SesameProtocols.kt:37; itemcodes.js:91)。serve は bioListEntry('card') で override (serve/entries/ble.js:261) し collectBiometricList で publish 収集。CLI cards サブコマンドは cmdBiometricList 経由 (cli/ble.js:159,164)。

### [BLE3-0140] passcodeGet 空 payload 送信、itemCode PASSCODE_GET=125 (一覧 publish のトリガ)
- surface: core, serve, sdk, cli
- backend: ble
- command: `sesame ble passcodes <device> / ble.biometric.passcodeGet`
- branch: -
- assert: passcodeGetData() が空で itemCode SSM_OS3_PASSCODE_GET=125 を送る — CHPassCodeCapableImpl.sendKeyBoardPassCodeDataGetCmd の SesameOS3Payload(SSM_OS3_PASSCODE_GET, byteArrayOf()) と一致する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/passcode/CHPassCodeCapableImpl.kt:139-141; packages/core/src/ble/biometric.js:453; packages/core/src/ble/biometric.js:1026; packages/core/src/itemcodes.js:114
- kind: payload-fidelity
- status: planned
- note: PASSCODE_GET=125 (SesameProtocols.kt:39; itemcodes.js:114)。serve bioListEntry('passcode') (serve/entries/ble.js:262)。CLI passcodes サブコマンドは cmdBiometricList 経由 (cli/ble.js:159,164)。

### [BLE3-0141] cardAdd の id 引数 Buffer 復元 ({type:'Buffer'}/{$buffer}) → 16B 枠
- surface: serve, sdk
- backend: ble
- command: `ble.biometric.cardAdd`
- branch: id={type:'Buffer',data} | id={$buffer:base64}
- assert: RPC param id (type:'object') が rpc-helpers.reviveJsonArg で {type:'Buffer',data:[]} / {$buffer} から Buffer に復元され、cardAddData が padEnd(16) で 16B 枠に詰める。prototype 汚染キー (__proto__/prototype/constructor) は RpcError で拒否される — BIOMETRIC_RPC_OPS['biometric.cardAdd'].params[0] (id:object) と reviveJsonArg の契約が一致する
- ref: packages/core/src/ble/rpc-helpers.js:26-43; packages/core/src/ble/biometric.js:374-382; packages/core/src/ble/biometric.js:1441; packages/kit/src/serve/registry.js:219-251
- kind: payload-fidelity
- status: planned
- note: 関数名は reviveJsonArg (rpc-helpers.js:26)。prototype 汚染拒否は rpc-helpers.js:37-38 (RpcError BAD_PARAMS)。padEnd(16) は cardAddData (biometric.js:374-382)、RPC op 宣言は biometric.js:1441。passcodeAdd の id (biometric.js:1451) / setRadarSensitivity の payload (biometric.js:1472) も同 object→Buffer 復元経路。registry.js:226 が type:'object' に BLE_SCHEMA_BY_TYPE.object を割当て、:241 で位置引数化。

### [BLE3-0142] card/passcode batchAdd 209B 分割・各パケット [dataIndex LE2B][dataSize LE2B][chunk]、StpItemCode 182/184
- surface: core
- backend: ble
- command: `BiometricCommands.cardBatchAdd / passcodeBatchAdd / batchAddPacket`
- branch: single-packet | multi-packet(4s delay)
- assert: _batchAdd が 209B (MAX_PAYLOAD_SIZE) ずつ分割し、各パケット data = dataIndex.toReverseBytes()(LE 2B) ++ dataSize.toReverseBytes()(LE 2B) ++ chunk を card=StpItemCode.STP_ITEM_CODE_CARDS_ADD=182 / passcode=STP_ITEM_CODE_PASSCODES_ADD=184 で送る — CHCardCapableImpl.cardBatchAdd / CHPassCodeCapableImpl.keyBoardPassCodeBatchAdd と一致する (SesameItemCode 182 でなく StpItemCode 182 を使う点が罠)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/card/CHCardCapableImpl.kt:94-155; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/passcode/CHPassCodeCapableImpl.kt:50-111; packages/core/src/ble/biometric.js:1122-1135; packages/core/src/itemcodes.js:256
- kind: payload-fidelity
- status: planned
- note: STP_ITEM_CODE_CARDS_ADD=182 / PASSCODES_ADD=184 (StpItemCode, itemcodes.js:256/258; SesameProtocols.kt:66 internal enum class StpItemCode) — SesameItemCode 182(itemcodes.js:74)/183 と数値・名前とも衝突する別 enum (itemcodes.js:70-79 注記)。MAX_BATCH_PAYLOAD=209 / BATCH_PACKET_DELAY_MS=4000 (biometric.js:34,36)。card/passcode 共通 _batchAdd 実体 (biometric.js:1122)、cmdItCode のみ差異。RPC 非公開 (progress コールバック+4s sleep 故、biometric.js:1414)。

### [BLE3-0143] batchAdd の dataIndex/dataSize が Short.toReverseBytes() (LE) と一致 (符号付き Short 上限)
- surface: core
- backend: ble
- command: `batchAddPacket / shortToReverseBytesLE`
- branch: size<=32767 | size>32767(Short overflow)
- assert: shortToReverseBytesLE(value) が Kotlin Short.toReverseBytes() (ByteBuffer.putShort → [buf[1],buf[0]] = LE) と一致する。dataSize/dataIndex を Kotlin は Short (符号付き 16bit) で扱うため 32768B 以上で負値オーバーフローする — kit の writeUInt16LE (0..65535) との差異を境界として固定
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/utils/DataExtention.kt:108-112; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/card/CHCardCapableImpl.kt:97-98; packages/core/src/ble/biometric.js:104-108; packages/core/src/ble/biometric.js:617-628
- kind: payload-fidelity
- status: planned
- note: Kotlin id.size.toShort() (CHCardCapableImpl.kt:97) は 32768 以上で負。32767 以下では writeUInt16LE と完全一致。LE バイト順 ([low,high], DataExtention.kt:108-112) の一致が主境界、overflow 域は note 扱い (実用上 209*N で到達は稀)。packet 構築は batchAddPacket (biometric.js:617-628) が shortToReverseBytesLE を dataIndex/dataSize へ適用。

## card/passcode publish

card/passcode の publish パース (NOTIFY 複数レコード連結・DELETE 非対称・CHANGE・MODE_SET)。

### [BLE3-0144] CARD_NOTIFY 複数レコード連結を recordSize ずつ前進して parse
- surface: core
- backend: ble
- command: `handleBiometricPublish / parseTouchCard`
- branch: single-record | multi-record-concat
- assert: CARD_NOTIFY(110) payload を parseTouchCard で [cardType 1B][idLen 1B][id idLen B][nameLen 1B][name nameLen B] と解釈し、recordSize=1+1+idLen+1+nameLen ずつ drop して do-while 巡回する — CHCardEventHandlers SSM_OS3_CARD_NOTIFY の cardDataSize 計算・cards.drop(cardDataSize) ループと一致する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/card/CHCardEventHandlers.kt:22-34; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/parseData/CHSesameBiometricParseData.kt:10-17; packages/core/src/ble/biometric.js:144-170; packages/core/src/ble/biometric.js:744-760
- kind: payload-fidelity
- status: planned
- note: CHSesameTouchCard の cardID=sliceArray(2..idLength+1) (inclusive) = JS subarray(2, idLen+2) (exclusive) で同範囲 (CHSesameBiometricParseData.kt:13 / biometric.js:164)。delegate=onCardReceive(cardID,cardName,cardType)。

### [BLE3-0145] PASSCODE_NOTIFY 複数レコード連結 parse (card と同型)
- surface: core
- backend: ble
- command: `handleBiometricPublish / parseTouchCard`
- branch: single-record | multi-record-concat
- assert: PASSCODE_NOTIFY(126) payload を CHSesameTouchCard 同形で parse し recordSize ずつ巡回、各レコードを onKeyBoardReceive(cardID,cardName,cardType) へ写像する — CHPassCodeEventHandlers SSM_OS3_PASSCODE_NOTIFY ループと一致する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/passcode/CHPassCodeEventHandlers.kt:22-34; packages/core/src/ble/biometric.js:803-819; packages/core/src/itemcodes.js:115
- kind: payload-fidelity
- status: planned
- note: passcode の NOTIFY は CHSesameTouchCard を再利用 (専用 parse 無し)。delegate コールバック名は onKeyBoardReceive (passcode=keyBoard 命名)。

### [BLE3-0146] CARD_DELETE publish parse = [_][_][idLen][id..]、送信 DELETE と非対称
- surface: core
- backend: ble
- command: `handleBiometricPublish`
- branch: -
- assert: CARD_DELETE(108) publish 受信で payload[2]=idLen、cardID=payload[3..idLen+2] を hex 化して onCardDelete(cardID) へ渡す — CHCardEventHandlers SSM_OS3_CARD_DELETE (payload.sliceArray(3..cardIDLen+2)) と一致する (送信側 cardDeleteData は id 生バイトのみでヘッダが付かない非対称性が罠)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/card/CHCardEventHandlers.kt:48-55; packages/core/src/ble/biometric.js:768-774
- kind: payload-fidelity
- status: planned
- note: Kotlin sliceArray(3..cardIDLen+2) (CHCardEventHandlers.kt:51) は inclusive 末尾 = idLen バイト = JS subarray(3, 3+idLen)。送信 cardDeleteData (biometric.js:390 = hexToBytes(cardID) のヘッダ無し生バイト) との非対称を固定。

### [BLE3-0147] PASSCODE_DELETE publish parse = [_][_][idLen][id..]
- surface: core
- backend: ble
- command: `handleBiometricPublish`
- branch: -
- assert: PASSCODE_DELETE(124) publish で payload[2]=idLen、pwdID=payload[3..idLen+2] を hex 化して onKeyBoardDelete(pwdID) へ渡す — CHPassCodeEventHandlers SSM_OS3_PASSCODE_DELETE と一致する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/passcode/CHPassCodeEventHandlers.kt:48-55; packages/core/src/ble/biometric.js:827-833
- kind: payload-fidelity
- status: planned
- note: card.delete-publish と同型 (CHPassCodeEventHandlers.kt:51 = payload.sliceArray(3..pwdIDLen+2); passcode 命名 onKeyBoardDelete)。

### [BLE3-0148] CARD_CHANGE publish parse → onCardChanged(cardID,cardName,cardType)
- surface: core
- backend: ble
- command: `handleBiometricPublish / parseTouchCard`
- branch: -
- assert: CARD_CHANGE(107) publish を CHSesameTouchCard 同形 (parseTouchCard) で 1 レコード解釈し onCardChanged(cardID,cardName,cardType) へ渡す — CHCardEventHandlers SSM_OS3_CARD_CHANGE と一致する (NOTIFY と違いループ無しで単一レコード)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/card/CHCardEventHandlers.kt:17-21; packages/core/src/ble/biometric.js:761-765
- kind: payload-fidelity
- status: planned
- note: CHANGE/MODE_SET 受信は単発。MODE_SET(114) publish は payload[0]=mode を onCardModeChanged へ (別途 mode 値域)。

### [BLE3-0149] CARD_MODE_SET publish → onCardModeChanged(payload[0])
- surface: core
- backend: ble
- command: `handleBiometricPublish`
- branch: -
- assert: CARD_MODE_SET(114) publish 受信で payload[0] を mode byte として onCardModeChanged(mode) へ渡す — CHCardEventHandlers SSM_OS3_CARD_MODE_SET (delegate.onCardModeChanged(device, payload.payload[0])) と一致する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/card/CHCardEventHandlers.kt:43-47; packages/core/src/ble/biometric.js:766-767
- kind: payload-fidelity
- status: planned
- note: passcode 側は PASSCODE_MODE_SET(130) publish → onKeyBoardModeChange (CHPassCodeEventHandlers.kt:43-47, biometric.js:825-826) で同型。

## face

Touch Pro/Face の顔認証 capability。mode set/get・一覧・change・delete の送信と publish 写像。

### [BLE3-0150] faceModeSet → SSM_OS3_FACE_MODE_SET(161) + [mode 1B]
- surface: core
- backend: ble
- command: `biometric.faceModeSet / BiometricCommands.faceModeSet`
- branch: -
- assert: faceModeSet が itemCode 161 に data=[mode&0xff] の 1B を載せ、ack {resultCode,payload} をそのまま返す (SDK byteArrayOf(mode))
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/face/CHFaceCapableImpl.kt:22-23; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:44; packages/core/src/ble/biometric.js:503; packages/core/src/ble/biometric.js:1043
- kind: payload-fidelity
- status: planned
- note: faceModeSetData(mode)=Buffer.from([mode&0xff])。itemcodes.js:143 FACE_MODE_SET=161。BIOMETRIC_RPC_OPS result:'ack' (biometric.js:1457)。

### [BLE3-0151] faceModeGet → SSM_OS3_FACE_MODE_GET(160) 空 data、応答 payload[0]=mode
- surface: core
- backend: ble
- command: `biometric.faceModeGet / BiometricCommands.faceModeGet`
- branch: empty-payload-error | ok
- assert: faceModeGet が itemCode 160 に空 data を送り、応答 payload[0] を mode byte として返す。応答 payload が空なら 'faceModeGet data error' を throw (raw 結果)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/face/CHFaceCapableImpl.kt:29-37; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:44; packages/core/src/ble/biometric.js:504; packages/core/src/ble/biometric.js:1044-1048
- kind: option-branch
- status: planned
- note: result:'raw' (BIOMETRIC_RPC_OPS faceModeGet, biometric.js:1458)。Kotlin の empty-payload 失敗分岐は CHFaceCapableImpl.kt:35 (Result.failure Data Error)、関数全体 29-37。itemcodes.js:142 FACE_MODE_GET=160。

### [BLE3-0152] faceListGet → SSM_OS3_FACE_GET(156) 空 data、FACE_FIRST/NOTIFY/LAST を誘発
- surface: core
- backend: ble
- command: `biometric.faceListGet / BiometricCommands.faceListGet`
- branch: -
- assert: faceListGet が itemCode 156 に空 data を送り ack を返す (実データは FACE_FIRST(159)/NOTIFY(157)/LAST(158) publish で届く)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/face/CHFaceCapableImpl.kt:39-42; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:43-44; packages/core/src/ble/biometric.js:505; packages/core/src/ble/biometric.js:1050
- kind: payload-fidelity
- status: planned
- note: faceGetData()=Buffer.alloc(0)。itemcodes.js:138-141 FACE_GET=156/NOTIFY=157/LAST=158/FIRST=159。BIOMETRIC_RPC_OPS result:'ack' (biometric.js:1459)。

### [BLE3-0153] faceChange → SSM_OS3_FACE_CHANGE(154) + [idLen][id(hex→bytes)][name(hex畳み)]
- surface: core
- backend: ble
- command: `biometric.faceChange / BiometricCommands.faceChange`
- branch: -
- assert: faceChange が itemCode 154 に [id.size 1B] ++ id(hexStringToByteArray) ++ name.chunked(2){toInt(16)} を連結したバイト列を送る
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/face/CHFaceCapableImpl.kt:45-49; packages/core/src/ble/biometric.js:512-515; packages/core/src/ble/biometric.js:1052
- kind: payload-fidelity
- status: planned
- note: itemCode 154 確認 (itemcodes.js:136 / SesameProtocols.kt:43)。hexNameToBytes は Kotlin chunked(2) と同挙動 (奇数長末尾1文字も byte 化, biometric.js:120-126)。CHFaceCapableImpl.kt の faceChange はメソッド本体 45-49、payload 構築は :46。

### [BLE3-0154] faceDelete → SSM_OS3_FACE_DELETE(155) + [faceID.toInt(16) 単一 byte]
- surface: core
- backend: ble
- command: `biometric.faceDelete / BiometricCommands.faceDelete`
- branch: -
- assert: faceDelete が itemCode 155 に byteArrayOf(faceID.toInt(16).toByte()) の 1B のみを送る (card/finger と異なり id 全体でなく単一 byte)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/face/CHFaceCapableImpl.kt:51-55; packages/core/src/ble/biometric.js:521; packages/core/src/ble/biometric.js:1054
- kind: payload-fidelity
- status: planned
- note: itemCode 155 確認 (itemcodes.js:137 / SesameProtocols.kt:43)。faceDelete メソッド本体 51-55、payload 構築 :52 (byteArrayOf(faceID.toInt(16).toByte()))。kit は parseInt(faceID,16)&0xff の単一 byte で一致 (biometric.js:521)。

### [BLE3-0155] FACE_NOTIFY(157) publish → parseTouchFace → onFaceReceive
- surface: core
- backend: ble
- command: `handleBiometricPublish / CHSesameTouchFace`
- branch: -
- assert: itemCode 157 publish が CHSesameTouchFace レイアウト ([type 1B][idLen 1B][id idLen][nameLen 1B][nameUUID nameLen]) で parse され onFaceReceive(device, {type,id,nameUUID}) へ写像する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/parseData/CHSesameBiometricParseData.kt:19-36; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/face/CHFaceEventHandlers.kt:21-24; packages/core/src/ble/biometric.js:181-202; packages/core/src/ble/biometric.js:840-841
- kind: payload-fidelity
- status: planned
- note: itemCode 157 確認 (itemcodes.js:139)。CHFaceEventHandlers.kt の FACE_NOTIFY 分岐は 21-24。CHSesameTouchFace は class 19-57・parse コンストラクタ 28-36。dispatch は device 先頭 (call=fn(device,...args), biometric.js:736)。nameUUID は SDK noHashtoUUID 整形 (parseData:34) を kit は hex 据置 (biometric.js:200, 消費側整形)。

### [BLE3-0156] FACE_CHANGE(154) publish → parseTouchFace → onFaceChanged
- surface: core
- backend: ble
- command: `handleBiometricPublish`
- branch: -
- assert: itemCode 154 publish が parseTouchFace され onFaceChanged(device, face) へ届く (CHFaceEventHandlers cmdItCode 154 分岐)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/face/CHFaceEventHandlers.kt:17-20; packages/core/src/ble/biometric.js:842-843
- kind: payload-fidelity
- status: planned
- note: FACE_CHANGE publish 分岐は CHFaceEventHandlers.kt:17-20。kit biometric.js:842-843 が parseTouchFace(payload)→onFaceChanged。device 先頭結線 (call, :736)。

### [BLE3-0157] FACE_FIRST(159)/FACE_LAST(158)/FACE_MODE_SET(161) publish → start/end/modeChanged
- surface: core
- backend: ble
- command: `handleBiometricPublish`
- branch: first | last | mode-set
- assert: itemCode 159→onFaceReceiveStart、158→onFaceReceiveEnd、161→onFaceModeChanged(payload[0]) へ写像する (FACE_MODE_SET publish は ack エコー)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/face/CHFaceEventHandlers.kt:25-37; packages/core/src/ble/biometric.js:836-845
- kind: option-branch
- status: planned
- note: FACE_LAST=158/FACE_FIRST=159/FACE_MODE_SET=161 (itemcodes.js:140-143)。CHFaceEventHandlers.kt: FACE_FIRST 25-28, FACE_LAST 29-32, FACE_MODE_SET 33-37。kit: FACE_FIRST 836-837, FACE_LAST 838-839, FACE_MODE_SET 844-845。

### [BLE3-0158] FACE_DELETE(155) publish は delegate 無し・handled=true
- surface: core
- backend: ble
- command: `handleBiometricPublish`
- branch: -
- assert: itemCode 155 publish は delegate コールバックを呼ばず handled=true (return true) になる (SDK は FACE_DELETE 分岐で何もしないが消費する)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/face/CHFaceEventHandlers.kt:38-40; packages/core/src/ble/biometric.js:846-848
- kind: option-branch
- status: planned
- note: CHFaceEventHandlers.kt の FACE_DELETE 分岐は 38-40 (case 38 / return true 39 / 閉じ 40)。kit biometric.js:846-848 は delegate 呼び出し無しで return true。

### [BLE3-0159] FACE_MODE_DELETE_NOTIFY(192) publish → onFaceDeleted(faceID, ok=payload[1]==0)
- surface: core
- backend: ble
- command: `handleBiometricPublish`
- branch: len>=2 | len<2-skip
- assert: itemCode 192 publish が payload[0]=faceID, payload[1]==0x00 を成功として onFaceDeleted(device,faceID,ok) へ写像する。payload<2B なら dispatch せず handled=true
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/face/CHFaceEventHandlers.kt:41-48; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:50; packages/core/src/ble/biometric.js:849-852
- kind: option-branch
- status: planned
- note: itemCode 192 確認 (SesameProtocols.kt:50 SSM_OS3_FACE_MODE_DELETE_NOTIFY(192u) / itemcodes.js:144)。CHFaceEventHandlers.kt の分岐は 41-48 (size>=2 ガード 42-46 + 範囲外でも return true は :47)。kit biometric.js:849-852 は if(payload.length>=2) のみ dispatch・常に return true。SDK は faceID=payload[0].toByte()/isSuccess=payload[1]==0.toByte() で一致。

## palm

Touch Pro AI の手のひら認証 capability。palmChange は受信専用で送信 API 不在。

### [BLE3-0160] palmModeSet → SSM_OS3_PALM_MODE_SET(169) + [mode 1B]
- surface: core
- backend: ble
- command: `biometric.palmModeSet / BiometricCommands.palmModeSet`
- branch: -
- assert: palmModeSet が itemCode 169 に data=[mode&0xff] を載せ ack を返す (SDK byteArrayOf(mode))
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/palm/CHPalmCapableImpl.kt:19-23; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:46; packages/core/src/ble/biometric.js:526; packages/core/src/ble/biometric.js:1058
- kind: payload-fidelity
- status: planned
- note: SesameProtocols.kt:46 で SSM_OS3_PALM_MODE_SET(169u)、CHPalmCapableImpl.kt:20 が byteArrayOf(mode) を送出。JS palmModeSetData(mode)=Buffer.from([mode&0xff])。

### [BLE3-0161] palmModeGet → SSM_OS3_PALM_MODE_GET(168) 空 data、応答 payload[0]=mode
- surface: core
- backend: ble
- command: `biometric.palmModeGet / BiometricCommands.palmModeGet`
- branch: empty-payload-error | ok
- assert: palmModeGet が itemCode 168 に空 data を送り payload[0] を mode として返す。応答 payload が空なら 'palmModeGet data error' を throw
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/palm/CHPalmCapableImpl.kt:26-34; packages/core/src/ble/biometric.js:527; packages/core/src/ble/biometric.js:1059-1063
- kind: option-branch
- status: planned
- note: result:'raw'。空判定の throw は CHPalmCapableImpl.kt:32、fn 全体 26-34。SDK 側 throw 文言は 'Data Error: ...'、JS 側は 'palmModeGet data error' (biometric.js:1061) で意味的に一致。

### [BLE3-0162] palmListGet → SSM_OS3_PALM_GET(164) 空 data、PALM_FIRST/NOTIFY/LAST 誘発
- surface: core
- backend: ble
- command: `biometric.palmListGet / BiometricCommands.palmListGet`
- branch: -
- assert: palmListGet が itemCode 164 に空 data を送り ack を返す (実データは PALM_FIRST(167)/NOTIFY(165)/LAST(166) publish)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/palm/CHPalmCapableImpl.kt:36-40; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:45-46; packages/core/src/ble/biometric.js:528; packages/core/src/ble/biometric.js:1065
- kind: payload-fidelity
- status: planned
- note: CHPalmCapableImpl.kt:37 が SSM_OS3_PALM_GET に byteArrayOf() (空) を送出。SesameProtocols.kt:45-46 に PALM_GET(164)/NOTIFY(165)/LAST(166)/FIRST(167)。JS palmGetData()=Buffer.alloc(0)。

### [BLE3-0163] palmDelete → SSM_OS3_PALM_DELETE(163) + [palmID.toInt(16) 単一 byte]
- surface: core
- backend: ble
- command: `biometric.palmDelete / BiometricCommands.palmDelete`
- branch: -
- assert: palmDelete が itemCode 163 に byteArrayOf(palmID.toInt(16).toByte()) の 1B のみを送る (face と同型・単一 byte)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/palm/CHPalmCapableImpl.kt:42-46; packages/core/src/ble/biometric.js:534; packages/core/src/ble/biometric.js:1067
- kind: payload-fidelity
- status: planned
- note: CHPalmCapableImpl.kt:43 が byteArrayOf(palmID.toInt(16).toByte())、SSM_OS3_PALM_DELETE=163 (SesameProtocols.kt:45)。JS palmDeleteData(palmID)=Buffer.from([parseInt(palmID,16)&0xff])。

### [BLE3-0164] palmChange は SDK に送信実装が無く biometric ビュー/RPC OPS に存在しない
- surface: core, serve
- backend: ble
- command: `BIO_VIEW_METHODS.palm / BIOMETRIC_RPC_OPS`
- branch: -
- assert: PALM_CHANGE(162) は受信専用 (CHPalmEventHandlers onPalmChanged) で送信メソッドが SDK に無いため、palm ビューメソッド集合・BIOMETRIC_RPC_OPS に palmChange が存在しない (op 捏造禁止)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/palm/CHPalmCapableImpl.kt:19-46; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/palm/CHPalmEventHandlers.kt:16-19; packages/core/src/ble/index.js:309-314; packages/core/src/ble/biometric.js:1463-1467
- kind: contract-existence
- status: planned
- note: CHPalmCapableImpl の送信メソッドは palmModeSet/palmModeGet/palmListGet/palmDelete の 4 つのみ (19-46)、palmChange 送信は不在。PALM_CHANGE は CHPalmEventHandlers.kt:16-19 が受信→onPalmChanged のみ。index.js:314 の palm 集合・biometric.js:1463-1467 の OPS どちらにも palmChange 無し。

### [BLE3-0165] PALM_NOTIFY(165)/PALM_CHANGE(162) publish → parseTouchFace → onPalmReceive/onPalmChanged
- surface: core
- backend: ble
- command: `handleBiometricPublish`
- branch: notify | change
- assert: itemCode 165 publish→onPalmReceive(parseTouchFace)、162 publish→onPalmChanged(parseTouchFace) (face と同じ CHSesameTouchFace 解釈)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/palm/CHPalmEventHandlers.kt:16-27; packages/core/src/ble/biometric.js:859-862
- kind: payload-fidelity
- status: planned
- note: PALM_CHANGE case=16-19、PALM_NOTIFY case=24-27。SDK 両者とも CHSesameTouchFace(payload.payload)、JS は parseTouchFace(payload) (biometric.js:181 定義) で対応。

### [BLE3-0166] PALM_FIRST(167)/PALM_LAST(166)/PALM_MODE_SET(169) publish → start/end/modeChanged
- surface: core
- backend: ble
- command: `handleBiometricPublish`
- branch: first | last | mode-set
- assert: itemCode 167→onPalmReceiveStart、166→onPalmReceiveEnd、169→onPalmModeChanged(payload[0]) へ写像する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/palm/CHPalmEventHandlers.kt:20-35; packages/core/src/ble/biometric.js:855-864
- kind: option-branch
- status: planned
- note: FIRST case=20-23、LAST case=28-31、MODE_SET case=32-35。MODE_SET は payload.payload[0] を onPalmModeChanged へ (kt:33)、JS は payload[0] (biometric.js:864)。

### [BLE3-0167] PALM_MODE_DELETE_NOTIFY(193) publish → onPalmDeleted(palmID, ok=payload[1]==0)
- surface: core
- backend: ble
- command: `handleBiometricPublish`
- branch: len>=2 | len<2-skip
- assert: itemCode 193 publish が payload[0]=palmID, payload[1]==0x00 を成功として onPalmDeleted へ写像する。payload<2B は dispatch せず handled=true
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/palm/CHPalmEventHandlers.kt:36-42; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:50; packages/core/src/ble/biometric.js:865-868
- kind: option-branch
- status: planned
- note: 36-42 (size<2 で dispatch せず return true=handled の境界=kt:41-42 を assert が要求)。SesameProtocols.kt:50 が PALM_MODE_DELETE_NOTIFY(193) を定義。

## fingerprint

Bike3 (fingerprint kind) の指紋 capability。delete は id 全体 (face/palm の単一 byte と異なる)。

### [BLE3-0168] fingerPrintModeSet → SSM_OS3_FINGERPRINT_MODE_SET(122) + [mode 1B]
- surface: core
- backend: ble
- command: `fingerPrint.fingerPrintModeSet / BiometricCommands.fingerPrintModeSet`
- branch: -
- assert: fingerPrintModeSet が itemCode 122 に data=[mode&0xff] を載せ ack を返す (SDK byteArrayOf(mode))
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/fingerPrint/CHFingerPrintCapableImpl.kt:31-39; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:38; packages/core/src/ble/biometric.js:428; packages/core/src/ble/biometric.js:1012
- kind: payload-fidelity
- status: planned
- note: ack を返すのは result.invoke(...CHEmpty) = kt:37-38。SesameProtocols.kt:38 が MODE_SET(122)。command 名前空間 fingerPrint.* は registry biometric.js:1486 と一致。

### [BLE3-0169] fingerPrintModeGet → SSM_OS3_FINGERPRINT_MODE_GET(121) 空 data、応答 payload[0]=mode
- surface: core
- backend: ble
- command: `fingerPrint.fingerPrintModeGet / BiometricCommands.fingerPrintModeGet`
- branch: -
- assert: fingerPrintModeGet が itemCode 121 に空 data を送り payload[0] を mode byte として返す (raw 結果)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/fingerPrint/CHFingerPrintCapableImpl.kt:20-28; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:38; packages/core/src/ble/biometric.js:429; packages/core/src/ble/biometric.js:1013
- kind: payload-fidelity
- status: planned
- note: payload[0] を返すのは kt:27 res.payload[0]。SesameProtocols.kt:38 が MODE_GET(121)。result:'raw' は registry biometric.js:1487。face/palm DELETE_NOTIFY の payload.length>=2 ガードと違い biometric.js:1013 の r.payload[0] は空 payload ガード無し (undefined になりうる)。

### [BLE3-0170] fingerPrints → SSM_OS3_FINGERPRINT_GET(117) 空 data、FIRST/NOTIFY/LAST 誘発
- surface: core
- backend: ble
- command: `fingerPrint.fingerPrints / BiometricCommands.fingerPrints`
- branch: -
- assert: fingerPrints が itemCode 117 に空 data を送り ack を返す (実データは FINGERPRINT_FIRST(120)/NOTIFY(118)/LAST(119) publish)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/fingerPrint/CHFingerPrintCapableImpl.kt:53-62; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:38; packages/core/src/ble/biometric.js:430; packages/core/src/ble/biometric.js:1015
- kind: payload-fidelity
- status: planned
- note: ack を返すのは result.invoke(...CHEmpty) kt:60。SesameProtocols.kt:38 が GET(117)/NOTIFY(118)/LAST(119)/FIRST(120) を定義。

### [BLE3-0171] fingerPrintDelete → SSM_OS3_FINGERPRINT_DELETE(116) + id(hex→bytes 全体)
- surface: core
- backend: ble
- command: `fingerPrint.fingerPrintDelete / BiometricCommands.fingerPrintDelete`
- branch: -
- assert: fingerPrintDelete が itemCode 116 に fingerPrintID.hexStringToByteArray() の全バイト列を送る (face/palm の単一 byte とは異なる)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/fingerPrint/CHFingerPrintCapableImpl.kt:42-46; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:38; packages/core/src/ble/biometric.js:436; packages/core/src/ble/biometric.js:1017
- kind: payload-fidelity
- status: planned
- note: kt:45 DELETE.value, kt:46 fingerPrintID.hexStringToByteArray() 全バイト。SesameProtocols.kt:38 が DELETE(116)。core biometric.js:436 fingerPrintDeleteData = hexToBytes(id) 全体で一致。

### [BLE3-0172] fingerPrintChange → SSM_OS3_FINGERPRINT_CHANGE(115) + [idLen][id(hex→bytes)][hexName畳み]
- surface: core
- backend: ble
- command: `fingerPrint.fingerPrintChange / BiometricCommands.fingerPrintChange`
- branch: -
- assert: fingerPrintChange が itemCode 115 に [id.size 1B] ++ id(hexStringToByteArray) ++ hexName.chunked(2){toInt(16)} を送る (SDK fingerPrintsChange と1:1、公開名は fingerPrintChange)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/fingerPrint/CHFingerPrintCapableImpl.kt:64-68; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:38; packages/core/src/ble/biometric.js:443-446; packages/core/src/ble/biometric.js:1019
- kind: payload-fidelity
- status: planned
- note: kt:64 fun fingerPrintsChange, kt:68 byteArrayOf(id.size) + id + hexName.chunked(2){toInt(16).toByte}。SDK 名は fingerPrintsChange、core 公開名 fingerPrintChange(biometric.js:1019)。SesameProtocols.kt:38 が CHANGE(115)。

### [BLE3-0173] FINGERPRINT_NOTIFY(118) publish → CHSesameTouchCard 単一レコード → onFingerPrintReceive
- surface: core
- backend: ble
- command: `handleBiometricPublish`
- branch: -
- assert: itemCode 118 publish が CHSesameTouchCard で 1 レコードのみ parse され onFingerPrintReceive(device, cardID, cardName, cardType) へ届く (card と違いループ無し)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/fingerPrint/CHFingerPrintEventHandlers.kt:30-34; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/parseData/CHSesameBiometricParseData.kt:10-17; packages/core/src/ble/biometric.js:781-786
- kind: payload-fidelity
- status: planned
- note: kt:30 NOTIFY case, kt:31 CHSesameTouchCard 単一生成, kt:32 onFingerPrintReceive, kt:33 return true (ループ非実施を assert する境界)。parseData kt:10-17 CHSesameTouchCard は単一レコードのみ parse。core biometric.js:781-786 が parseTouchCard 1回で一致。

### [BLE3-0174] FINGERPRINT_DELETE(116) publish → payload 全体 hex → onFingerDelete
- surface: core
- backend: ble
- command: `handleBiometricPublish`
- branch: -
- assert: itemCode 116 publish が payload.toHexString() 全体を onFingerDelete へ渡す (card/passcode の DELETE が payload[3..idLen+2] を切るのと異なる分岐)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/fingerPrint/CHFingerPrintEventHandlers.kt:40-43; packages/core/src/ble/biometric.js:794-796
- kind: payload-fidelity
- status: planned
- note: Kotlin DELETE case は 40-43 (case 40 / onFingerDelete(payload.toHexString()) 42)。card/passcode DELETE が payload[3..idLen+2] を切るのと対照 (biometric.js:827-833)。JS 794-796 が bytesToHex(payload) 全体を渡す。

### [BLE3-0175] FINGERPRINT_CHANGE(115)/FIRST(120)/LAST(119)/MODE_SET(122) publish 分岐
- surface: core
- backend: ble
- command: `handleBiometricPublish`
- branch: change | first | last | mode-set
- assert: 115→onFingerPrintChanged(card の cardID/cardName/cardType)、120→onFingerPrintReceiveStart、119→onFingerPrintReceiveEnd、122→onFingerModeChange(payload[0]) へ写像する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/fingerPrint/CHFingerPrintEventHandlers.kt:16-38; packages/core/src/ble/biometric.js:777-793
- kind: option-branch
- status: planned
- note: kt CHANGE 17-21 / FIRST 22-25 / LAST 26-29 / MODE_SET 35-38 (onFingerModeChange(payload.payload[0]) は kt:37)。115→onFingerPrintChanged は card 3 フィールド展開 (card.cardID/cardName/cardType)。

## remoteNano

Remote Nano の triggerDelay 設定と TRIGGER_DELAYTIME publish。isRemote ゲート分岐。

### [BLE3-0176] setTriggerDelayTime → REMOTE_NANO_SET_TRIGGER_DELAYTIME(190) + [time UByte 1B]
- surface: core
- backend: ble
- command: `remoteNano.setTriggerDelayTime / BiometricCommands.setTriggerDelay`
- branch: -
- assert: setTriggerDelayTime が itemCode 190 に byteArrayOf(time.toByte()) の 1B を載せ ack を返す (SDK CHRemoteNanoCapableImpl)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/remoteNano/CHRemoteNanoCapableImpl.kt:19-28; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:49; packages/core/src/ble/biometric.js:543-548; packages/core/src/ble/biometric.js:1079
- kind: payload-fidelity
- status: planned
- note: SesameProtocols.kt:49 に REMOTE_NANO_ITEM_CODE_SET_TRIGGER_DELAYTIME(190u)。CHRemoteNanoCapableImpl.kt setTriggerDelayTime 本体 19-28 (byteArrayOf(time.toByte()) は 23)。JS 1079 が ITEM.REMOTE_NANO_SET_TRIGGER_DELAYTIME へ remoteNanoTriggerDelayData(time) を載せ ack を返す。

### [BLE3-0177] setTriggerDelayTime の UByte 範囲外 (>255 / <0 / 非整数) は rejected promise
- surface: core
- backend: ble
- command: `BiometricCommands.setTriggerDelay`
- branch: in-range | out-of-range-reject
- assert: time が 0..255 の整数でない場合 setTriggerDelay は同期 throw でなく rejected promise になり request を発行しない (UByte 型制約の再現、ワイヤに不正値を出さない)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/remoteNano/CHRemoteNanoCapableImpl.kt:19; packages/core/src/ble/biometric.js:543-548; packages/core/src/ble/biometric.js:1077-1079
- kind: error-path
- status: planned
- note: SDK 引数型 time: UByte (kt:19) が 0..255 を保証。JS は remoteNanoTriggerDelayData (543-548) が Number.isInteger/0..255 で throw、setTriggerDelay が async (1079) のため throw は rejected promise 化し _req を発行しない。

### [BLE3-0178] TRIGGER_DELAYTIME(191) publish → fromData(LE 先頭1B) → onTriggerDelaySecondReceived
- surface: core
- backend: ble
- command: `handleBiometricPublish / CHRemoteNanoTriggerSettings.fromData`
- branch: -
- assert: itemCode 191 publish の先頭 1B を LE で triggerDelaySecond(0..255) として parse し onTriggerDelaySecondReceived(device,{triggerDelaySecond}) へ写像する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/parseData/CHSesameBiometricParseData.kt:59-74; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/remoteNano/CHRemoteNanoEventHandler.kt:15-21; packages/core/src/ble/biometric.js:213-216; packages/core/src/ble/biometric.js:871-882
- kind: payload-fidelity
- status: planned
- note: fromData は ByteBuffer LITTLE_ENDIAN で get().toUByte() (kt 63-72、data class 59-74)。EventHandler 15-21 が onTriggerDelaySecondReceived へ流す。JS parseRemoteNanoTrigger 213-216 + dispatch 871-882。

### [BLE3-0179] TRIGGER_DELAYTIME(191) dispatch は isRemote() ゲートで分岐 (BLEP-09)
- surface: core
- backend: ble
- command: `handleBiometricPublish / BiometricCommands(model)`
- branch: isRemote-true-dispatch | isRemote-false-suppress | model-unknown-dispatch
- assert: 191 publish は isRemote===false (機種確定で非Remote) のとき onTriggerDelaySecondReceived を黙殺し handled=true。isRemote=true/null は dispatch する (SDK device.isRemote() ガード)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/remoteNano/CHRemoteNanoEventHandler.kt:15-21; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesameBiometricDevice.kt:67-69; packages/core/src/ble/biometric.js:876-882; packages/core/src/ble/biometric.js:1145-1148
- kind: option-branch
- status: planned
- note: EventHandler 17 if(device.isRemote()) ガード、handled は 21 で機種非依存に true。isRemote() は deviceType==REMOTE (kt:67-69)。JS 878 'if(isRemote===false) return true'、registerDelegate 1145-1148 が this._isRemote(=capabilitiesForModel(model).isRemote, constructor 959-967)を opts で伝搬。

### [BLE3-0180] setTriggerDelayTime の ack 契約 (RemoteNanoView が ack をそのまま返す)
- surface: core, serve, sdk
- backend: ble
- command: `remoteNano.setTriggerDelayTime`
- branch: -
- assert: RemoteNanoView.setTriggerDelayTime が BiometricCommands.setTriggerDelay へ委譲し request の ack {resultCode,payload} を返す (result:'ack' RPC 契約で bleCommandAck が封筒を組めること、ack を捨てない)
- ref: packages/core/src/ble/index.js:588-609; packages/core/src/ble/biometric.js:1079; packages/core/src/ble/biometric.js:1505-1509
- kind: contract-existence
- status: planned
- note: get remoteNano()(index.js:588-609) が setTriggerDelayTime:(time)=>c.setTriggerDelay(time)(602)。setTriggerDelay(biometric.js:1079) は this._req(...) の ack {resultCode,payload} を await せず直接 return。REMOTE_NANO_RPC_OPS setTriggerDelayTime result:'ack'(1506)。

## radar

レーダー感度設定と publish。connect capability (remoteNano ではない)。

### [BLE3-0181] setRadarSensitivity → SSM_OS3_RADAR_PARAM_SET(200) に raw payload を無加工
- surface: core
- backend: ble
- command: `BiometricCommands.setRadarSensitivity`
- branch: -
- assert: setRadarSensitivity が itemCode 200 に payload Buffer を一切加工せず載せる (SDK は payload[1] をログするだけで構造に触れない)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/connect/CHDeviceConnectCapableImpl.kt:89-94; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:50; packages/core/src/ble/biometric.js:558-560; packages/core/src/ble/biometric.js:1089
- kind: payload-fidelity
- status: planned
- note: setRadarSensitivity は connect capability (CHDeviceConnectCapable.kt:10 宣言 / CHDeviceConnectCapableImpl.kt:89 実装)。SesameProtocols.kt:50 に SSM_OS3_RADAR_PARAM_SET(200u)、kt:90 が payload[1] のみログ、JS radarSensitivityData 558-560 が Buffer.from(payload) 無加工、setRadarSensitivity 1089。

### [BLE3-0182] RADAR_PARAM_PUBLISH(201) publish → 生 payload → onRadarReceive
- surface: core
- backend: ble
- command: `handleBiometricPublish`
- branch: -
- assert: itemCode 201 publish の payload を加工せず onRadarReceive(device, payload) へ渡す
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesameBiometricDeviceImpl.kt:176-178; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:50; packages/core/src/ble/biometric.js:885-888
- kind: payload-fidelity
- status: planned
- note: dispatch case は 176-178 (177=handled, 178=handleRadar 呼び出し)。210-212=handleRadar 本体 onRadarReceive(this,payload)。SesameProtocols.kt:50 に SSM_OS3_RADAR_PARAM_PUBLISH(201u)。

## connector

子鍵 (sesame) の insert/remove。OS2/OS3 で payload レイアウトが分岐。

### [BLE3-0183] insertSesame OS3 子鍵 → ADD_SESAME(101) + UUID(16B)++secretKey(16B)
- surface: core
- backend: ble
- command: `remoteNano.insertSesame / biometric.insertSesame / BiometricCommands.insertSesame`
- branch: os3-no-pubkey
- assert: sesame2PublicKey 未指定時、insertSesame が itemCode 101 に noDashUUID(16B hexToBytes) ++ secretKey(16B) を連結して送る (CHSesameOS3 分岐)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/connect/CHDeviceConnectCapableImpl.kt:26-35; packages/core/src/ble/biometric.js:577-587; packages/core/src/ble/biometric.js:1097-1099
- kind: option-branch
- status: planned
- note: OS3 分岐 (if sesame is CHSesameOS3) は 26-35、ADD_SESAME 連結 noDashUUIDDATA+ssmSecKa は 33。JS:581 が no-pubkey 分岐 Buffer.concat([uuid,sec])。

### [BLE3-0184] insertSesame OS2 子鍵 → ADD_SESAME(101) + b64(UUID)(22B)++pubKey(64B)++secretKey(16B)
- surface: core
- backend: ble
- command: `remoteNano.insertSesame / biometric.insertSesame`
- branch: os2-with-pubkey
- assert: sesame2PublicKey 指定時、insertSesame が base64(UUID16).replace('=','')(22B utf8) ++ sesame2PublicKey(64B) ++ secretKey(16B) の順で連結して送る (else 分岐 allKey 連結順)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/connect/CHDeviceConnectCapableImpl.kt:36-48; packages/core/src/ble/biometric.js:583-587
- kind: option-branch
- status: planned
- note: else (OS2) 分岐は 36-48、allKey=ssmIRData+ssmPKData+ssmSecKa は 44。JS:585-586 が b64k(utf8)++pub++sec を Buffer.concat。

### [BLE3-0185] insertSesame の secretKey 16B / pubKey 64B 必須検証
- surface: core
- backend: ble
- command: `BiometricCommands.insertSesame / insertSesameData`
- branch: bad-secret-len | bad-pubkey-len | bad-uuid
- assert: secretKey が 16B/32hex でない、または sesame2PublicKey が 64B/128hex でない、deviceUUID が 16B hex/UUID でない場合 throw して不正バイト列を送らない
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/connect/CHDeviceConnectCapableImpl.kt:29-44; packages/core/src/ble/biometric.js:577-587; packages/core/src/ble/biometric.js:66-72
- kind: error-path
- status: planned
- note: kt:29-44 は消費フィールド形 (deviceUUID@29, secretKey@31/43, sesame2PublicKey@42)。明示的な長さ throw は SDK 側に無く kit 追加のハードニング: JS:580 (secretKey!=16B), 584 (pubKey!=64B), 66-72 uuidToBytes (UUID!=32hex)。

### [BLE3-0186] removeSesame keyType 分岐 → REMOVE_SESAME(103) payload (OS2=b64 / OS3=UUID16)
- surface: core
- backend: ble
- command: `remoteNano.removeSesame / biometric.removeSesame / BiometricCommands.removeSesame`
- branch: keyType-0x04-os2 | keyType-0x05-os3-default
- assert: keyType=0x04 (ss4) は base64(UUID16).replace('=','')(utf8) を、それ以外 (0x05/ss5 既定) は UUID16 raw bytes を itemCode 103 に送る (firstKey による分岐の写像)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/connect/CHDeviceConnectCapableImpl.kt:72-86; packages/core/src/ble/biometric.js:597-603; packages/core/src/ble/biometric.js:1108-1110
- kind: option-branch
- status: planned
- note: firstKey 分岐は 72-86 (72=if 0x04→b64 REMOVE@77, 80=else→raw UUID REMOVE@83)。JS:599-602 が keyType 0x04→b64(utf8) / 既定 0x05→raw uuid。

## pubkey

PUB_KEY_SESAME publish の 23B チャンク parse (SS5/SS2 子鍵束) と空きスロット判定。

### [BLE3-0187] PUB_KEY_SESAME(102) publish → 23B 分割 → SS5/SS2 子鍵束 parse
- surface: core
- backend: ble
- command: `handleBiometricPublish / parsePubKeySesame`
- branch: ss5-it21==0 | ss2-it21!=0 | empty-slot | corrupt-skip
- assert: 102 publish を divideArray(23) で 23B チャンクに分割し、it[21]==0→SS5(id=it[0..15] hex, value=[0x05,it[22]])、it[21]!=0→SS2(base64decode(it[0..21]+'==') が16Bなら id, value=[0x04,it[22]])、lockStatus=it[22]==0 はスキップ
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesameBiometricDeviceImpl.kt:220-255; packages/core/src/ble/biometric.js:292-348; packages/core/src/ble/biometric.js:899-905
- kind: payload-fidelity
- status: planned
- note: kt:220-255 handlePubKeySesame 全体 (223=divideArray(23), 238-241=SS5, 243-246=SS2, 236-237=lockStatus!=0 ガード)。kt は noHashtoUUID で UUID 整形するが kit は hex 据置 (JS:303)。SS2 復号長!=16 は壊れスロットとしてスキップ (kt catch@247-249 + JS 長さガード@317)。

### [BLE3-0188] PUB_KEY_SESAME 空きスロット判定の OpenSensor 分岐 (>1 vs >=1, BLEP-11)
- surface: core
- backend: ble
- command: `parsePubKeySesame / BiometricCommands(model)`
- branch: openSensor->1 | default>=1
- assert: 全ゼロチャンク数による hasEmptySlot 判定が OpenSensor/OpenSensor2 系では >1、それ以外は >=1 になり slotFull=!hasEmptySlot を返す。isOpenSensor は capabilitiesForModel(model) から確定する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesameBiometricDeviceImpl.kt:225-233; packages/core/src/ble/biometric.js:325-327; packages/core/src/ble/devicemodel.js:292-305
- kind: option-branch
- status: planned
- note: hasEmptySlot 分岐は 226-231 (227=OpenSensor 判定, 228=>1, 230=any=>=1), 233=setSlotFull(!hasEmptySlot)。JS:326 が三項で >1/>0 を切替。capabilitiesForModel から確定 (devicemodel.js:292-305, 304: isOpenSensor=!!entry.openSensor)。biometric.js:965 は呼び出し。

## biometric-mechstatus

生体 MECH_STATUS と補助 publish (battery/unsupport/txPower)。

### [BLE3-0189] MECH_STATUS(81) publish (生体) → CHSesameTouchProMechStatus pass-through
- surface: core
- backend: ble
- command: `handleBiometricPublish / parseBiometricMechStatus`
- branch: -
- assert: 81 publish を生体 mechStatus として raw 保持し position/target=0, isInLockRange=false(→isInUnlockRange=true), isStop/isCritical=null を返す (CHSesameProtocolMechStatus 既定値、ロックの 7B/3B レイアウトと別物・parseMechStatus を使わない)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/parseData/CHSesameBiometricParseData.kt:76; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesameBiometricDeviceImpl.kt:166-169; packages/core/src/ble/biometric.js:245-260; packages/core/src/ble/biometric.js:890-896
- kind: payload-fidelity
- status: planned
- note: kt:76 CHSesameTouchProMechStatus(data) は CHSesameProtocolMechStatus(CHDeivceProtocols.kt:334-351) の既定値を一切 override せず raw のみ保持。kt:214-217 handleMechStatus が代入。batteryRaw は reportBatteryData(先頭2B LE, kt:216) 参考値。

### [BLE3-0190] BATTERY_VOLTAGE(202)/SESAME_UNSUPPORT(204)/BLE_TX_POWER(206) publish 補助分岐
- surface: core
- backend: ble
- command: `handleBiometricPublish`
- branch: battery | unsupport | txPower
- assert: 202→onBatteryVoltageReceived(payload hex)、204→onSupportChanged(false)、206→onBleTxPowerReceive(payload[0] 符号付き Int8) へ写像する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesameBiometricDeviceImpl.kt:185-197; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:51-52; packages/core/src/ble/biometric.js:907-927
- kind: option-branch
- status: planned
- note: kt:185-187 は SDK では reportBatteryData(payload.toHexString()) でサーバ post だが kit は hex 化して delegate 素通し(biometric.js:909-912)。kt:194-197 bleTxPower=payload[0] は Kotlin Byte=符号付き1B→readInt8。SesameProtocols.kt:51-52 で 202/204/206 確定。

## parse-error

biometric parse の truncated 入力で throw (Kotlin AIOOBE 写像)。

### [BLE3-0191] parseTouchFace/parseTouchCard の truncated 入力で throw (AIOOBE 写像)
- surface: core
- backend: ble
- command: `parseTouchFace / parseTouchCard / handleBiometricPublish (NOTIFY)`
- branch: short-buf | idLength-overflow | nameLength-overflow
- assert: buf<2B / idLength+2>=len / nameIndex+1+nameLength>len の入力で throw し、CARD_NOTIFY/PASSCODE_NOTIFY ループは catch で break する — SDK の CHSesameTouchFace/Card コンストラクタ AIOOBE 脱出と同じセマンティクスになる
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/parseData/CHSesameBiometricParseData.kt:10-36; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/card/CHCardEventHandlers.kt:22-34; packages/core/src/ble/biometric.js:144-202; packages/core/src/ble/biometric.js:748-758
- kind: error-path
- status: planned
- note: kt:10-17 CHSesameTouchCard / kt:28-36 CHSesameTouchFace(data) は data[1]/data[nameIndex]/sliceArray へ無検証直接アクセスで AIOOBE。biometric.js:154-158/189-193 の3条件と1:1。Kotlin はゼロ埋め/末尾端数の最終レコードでも AIOOBE を throw して自然脱出、JS は明示 throw→catch break で再現 (biometric.js:755,814)。recordSize<=0 || >rest.length でも break (biometric.js:753)。

## capability-gate

機種能力 (bioCaps/remote/fingerprint) によるゲッタ限定ビューと非対応機種の明示エラー。op 捏造禁止。

### [BLE3-0192] bioCapsForModel: face/palm/finger 集合が DeviceProfiles と 1:1
- surface: core
- backend: local
- command: `bioCapsForModel / BIO_PROFILES`
- branch: face | face_ai | face_pro | face_pro_ai | touch | touch_pro | none
- assert: 各機種 (sesame_face=FACE{card,finger,palm,face}, sesame_face_ai=FACE_AI{palm,face}, face_pro=全部, face_pro_ai={passcode,palm,face}, touch={card,finger}, touch_pro={card,finger,passcode}) の bioCaps が DeviceProfiles と完全一致する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesameBiometricDevice.kt:44-57; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/base/CHDeivceProtocols.kt:77-216; packages/core/src/ble/devicemodel.js:150-226; packages/core/src/ble/devicemodel.js:239-242
- kind: option-branch
- status: planned
- note: CHDeivceProtocols 77-216 が全 biometric deviceFactory→DeviceProfiles 割当を網羅 (SESAME_TOUCH/TOUCH_PRO の deviceFactory kt:83-95 含む)。DeviceProfiles 集合内容は kt:45-56 と devicemodel.js BIO_PROFILES が完全一致。

### [BLE3-0193] biometric ゲッタの bioCaps 限定ビュー: 集合外メソッドは存在しない
- surface: core
- backend: ble
- command: `SesameBle#biometric / BIO_VIEW_METHODS`
- branch: in-caps-present | out-of-caps-absent
- assert: biometric ゲッタが bioCaps 集合内 capability のメソッドだけを bind し、集合外 (例 face_ai で cardAdd) は undefined になる (DeviceProfiles の機種別部分集合を再現、op 捏造禁止)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesameBiometricDevice.kt:44-57; packages/core/src/ble/index.js:300-315; packages/core/src/ble/index.js:512-554
- kind: option-branch
- status: planned
- note: BIO_VIEW_METHODS(index.js:300-315) の capability→メソッド表を、biometric ゲッタ(512-555) の loop(533-535)が caps.has(capName) で集合内のみ bind。face_ai は palm/face のみ→card 系メソッドは view に追加されず undefined。

### [BLE3-0194] remoteNano/biometric ゲッタは非対応機種で明示エラー (op 捏造禁止)
- surface: core
- backend: ble
- command: `SesameBle#remoteNano / SesameBle#biometric`
- branch: remote-ok | non-remote-error | biometric-ok | non-biometric-error
- assert: remoteNano ゲッタは remote/remote_nano 以外で ble.remoteNanoNotSupported、biometric ゲッタは bioCaps 空 (remote/open_sensor) や非 biometric kind で ble.biometricNotSupported/biometricNoCaps を throw する
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/base/CHDeivceProtocols.kt:81; packages/core/src/ble/index.js:512-526; packages/core/src/ble/index.js:588-609
- kind: error-path
- status: planned
- note: CHDeivceProtocols.kt:81/112/118/172 は OpenSensor/Remote/RemoteNano/OpenSensor2 の deviceFactory setOf()(空 capability)。index.js:513-518 biometricNotSupported, 521-526 biometricNoCaps, 589-594 remoteNanoNotSupported。i18n キー4種は i18n/ble.js:8-9,86-87 に実在。

### [BLE3-0195] remote/remote_nano は biometric ゲッタで明示エラー (bioCaps 空集合 P3-15)
- surface: core
- backend: ble
- command: `SesameBle#biometric (remote 系)`
- branch: -
- assert: remote/remote_nano は BIOMETRIC kind だが bioCaps=NONE(空集合) のため biometric ゲッタは biometricNoCaps を throw し、connector 操作は remoteNano ゲッタ経由のみになる (setOf() 生成の写像)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/base/CHDeivceProtocols.kt:112; packages/core/src/ble/devicemodel.js:204-205; packages/core/src/ble/index.js:512-526
- kind: error-path
- status: planned
- note: CHDeivceProtocols.kt:112(Remote)/118(RemoteNano) 共に CHSesameBiometricDeviceImpl(BiometricDeviceType.REMOTE, setOf())。devicemodel.js:204-205 が remote/remote_nano を kind:BIOMETRIC + bioCaps:BIO_PROFILES.NONE で写像。get biometric()(index.js:512-526) は bioCaps.length===0 で ble.biometricNoCaps を throw(521-526)。

### [BLE3-0196] fingerPrint ゲッタは Bike3 (fingerprint kind) のみ露出・他機種は明示エラー
- surface: core
- backend: ble
- command: `SesameBle#fingerPrint`
- branch: bike3-ok | non-bike3-error
- assert: fingerPrint ゲッタは caps.fingerprint=true (Bike3) のときだけ指紋サブセット (fingerPrints/Delete/Change/ModeGet/ModeSet/registerDelegate) を返し、それ以外は ble.fingerPrintNotSupported を throw
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesameBike3Device.kt:20-24; packages/core/src/ble/devicemodel.js:86; packages/core/src/ble/index.js:628-650
- kind: error-path
- status: planned
- note: CHSesameBike3Device.kt:20-24 (CHSesameBike3Device : CHSesameBike2Device(), CHFingerPrintCapable by fingerPrintCapability = Bike2解錠+指紋のみ)。devicemodel.js:86 BIKE3 fingerprint:true / index.js:629-633 fingerPrintNotSupported, 641-648 指紋サブセット bind。

## biometric-contract

biometric/fingerprint/remoteNano の RPC OPS params 順序・allowlist・ack 封筒の存在/面パリティ。

### [BLE3-0197] BIOMETRIC_RPC_OPS の params 順序 = ファサード位置引数順 (wire 崩れ防止)
- surface: serve, sdk, core
- backend: ble
- command: `ble.biometric.cardMove / cardChange / passcodeMove / passcodeChange`
- branch: -
- assert: BIOMETRIC_RPC_OPS の各 op の params 配列順が BiometricCommands メソッドの位置引数順 (cardMove(cardId,touchProUUID) / cardChange(ID,hexName) / cardChangeValue(ID,newID) / passcodeMove(cardId,touchProUUID) 等) と完全一致する。bleOpEntries が named→位置写像する際に順序がずれるとワイヤバイト列が壊れる
- ref: packages/core/src/ble/biometric.js:1436-1473; packages/core/src/ble/biometric.js:998-1034; packages/kit/src/serve/registry.js:241; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/card/CHCardCapableImpl.kt:72-178
- kind: contract-existence
- status: planned
- note: registry.js:241 args=specParams.map(p=>params[p.name]) が位置引数へ写像。RPC op の cardMove(cardId,touchProUUID):1443 / cardChange(ID,hexName):1444 / cardChangeValue(ID,newID):1445 / passcodeMove:1453 がファサード biometric.js:999/1001/1003/1032 と一致。順序トラップは biometric.js:1403-1404 のコメントが明示する最重要不変条件。SDK 側の位置引数順は CHCardCapableImpl.kt:72(cardMove),158(cardChange),169(cardChangeValue)。

### [BLE3-0198] card/passcode CRUD op が BIOMETRIC_RPC_OPS / allowlist に 1:1 で存在 (面パリティ)
- surface: serve, sdk, core
- backend: ble
- command: `ble.biometric.card* / ble.biometric.passcode*`
- branch: -
- assert: BiometricCommands の card/passcode 送信メソッド (cardModeSet/cardGet/cardAdd/cardDelete/cardMove/cardChange/cardChangeValue/passcodeModeSet/passcodeGet/passcodeAdd/passcodeDelete/passcodeMove/passcodeChange) が BIOMETRIC_RPC_OPS に対応 op を持ち、第1セグメント 'biometric' が BLE_RPC_ALLOWLIST に掲載される (RPC/SDK へ 1:1 露出) — rpc-allowlist テストの prototype 公開面−除外集合==allowlist と整合する
- ref: packages/core/src/ble/biometric.js:1436-1473; packages/core/src/ble/index.js:140-153; packages/core/src/ble/index.js:279; packages/core/tests/ble/rpc-allowlist.test.js:7; packages/core/tests/ble/rpc-allowlist.test.js:44
- kind: surface-parity
- status: planned
- note: BLE_RPC_ALLOWLIST に 'biometric' 掲載 (index.js:153)。BLE_RPC_OPS に ...BIOMETRIC_RPC_OPS spread (index.js:279)。RPC 非公開は cardBatchAdd/passcodeBatchAdd/registerDelegate/onEnroll/palmChange (biometric.js:1410-1418)。prototype 公開面−除外集合==allowlist の逆方向テストは rpc-allowlist.test.js:7 (P4-3) が文書化、代表 op 網羅は :44。

### [BLE3-0199] BIOMETRIC/FINGERPRINT/REMOTE_NANO_RPC_OPS の params 順序 = ファサード位置引数順
- surface: serve, sdk
- backend: ble
- command: `BIOMETRIC_RPC_OPS / FINGERPRINT_RPC_OPS / REMOTE_NANO_RPC_OPS`
- branch: -
- assert: 各 op の params 配列の順序・名前・required が BiometricCommands メソッドの位置引数と一致する (named→位置写像でワイヤバイト列が壊れないこと)。faceChange(ID,name)/faceDelete(faceID)/palmDelete(palmID)/fingerPrintChange(ID,hexName)/setTriggerDelayTime(time) 等
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/face/CHFaceCapableImpl.kt:45-52; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/palm/CHPalmCapableImpl.kt:42; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/fingerPrint/CHFingerPrintCapableImpl.kt:64; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/sesameBiometric/capability/remoteNano/CHRemoteNanoCapableImpl.kt:19-28; packages/core/src/ble/biometric.js:1052-1067; packages/core/src/ble/biometric.js:1436-1510
- kind: contract-existence
- status: planned
- note: faceChange/faceDelete(CHFaceCapableImpl.kt:45,51)・palmDelete(CHPalmCapableImpl.kt:42)・fingerPrintsChange(CHFingerPrintCapableImpl.kt:64)・setTriggerDelayTime(CHRemoteNanoCapableImpl.kt:19) と biometric.js BiometricCommands faceChange(ID,name):1052/faceDelete(faceID):1054/palmDelete(palmID):1067/fingerPrintChange(ID,hexName):1019/setTriggerDelay(time):1079 の位置引数が *_RPC_OPS の params 順序と一致。

### [BLE3-0200] BLE_RPC_ALLOWLIST に biometric/fingerPrint/remoteNano 第1セグメントが掲載
- surface: serve
- backend: ble
- command: `ble.invoke / BLE_RPC_ALLOWLIST`
- branch: allowed | not-allowed-rejected
- assert: ble.invoke の fail-closed allowlist 第1セグメントに 'biometric','fingerPrint','remoteNano' が存在し、非掲載 op (例 unknown) は invokePath で bad_params 拒否される
- ref: packages/core/src/ble/index.js:140-154; packages/kit/src/serve/entries/ble.js:133-146; packages/core/src/ble/rpc-helpers.js:62-74
- kind: contract-existence
- status: planned
- note: BLE_RPC_ALLOWLIST(index.js:140-154) 行153 に 'biometric','fingerPrint','remoteNano'。ble.invoke(entries/ble.js:145) が invokePath(ble, op, args, BLE_RPC_ALLOWLIST) を呼ぶ。非掲載拒否の本体は rpc-helpers.js:72-74 (allowlist.includes(parts[0]) 偽で RpcError BAD_PARAMS)。

### [BLE3-0201] ble.biometric.faceDelete/palmDelete 等の serve 生成ハンドラが ack 封筒を組む
- surface: serve, sdk, core
- backend: ble
- command: `ble.biometric.* / bleOpEntries / bleCommandAck`
- branch: -
- assert: bleOpEntries が BIOMETRIC_RPC_OPS から生成する ble.biometric.<op> が core の ack {resultCode,payload} を bleCommandAck で {resultCode,resultName} 封筒へ写像し、core/serve/sdk で同一結果になる
- ref: packages/core/src/ble/biometric.js:980-984; packages/core/src/ble/biometric.js:1436-1473; packages/kit/src/serve/registry.js:219-245; packages/kit/src/serve/registry.js:314-318; packages/core/src/ble/rpc-helpers.js:170-171
- kind: surface-parity
- status: planned
- note: 送信系が ack をそのまま返す契約コメント(biometric.js:980-984)、BIOMETRIC_RPC_OPS(1436-1473)、bleOpEntries(registry.js:219-250) の ack 写像は line 244 bleCommandAck(r)。BLE_RPC_OPS=…BIOMETRIC_RPC_OPS(index.js:279) を registry.js:314-318 が feed。bleCommandAck の実体 {resultCode,resultName:resultName(resultCode)} は rpc-helpers.js:170-171。

### [BLE3-0202] ble.invoke 経由の biometric.card*/passcode* は allowlist 第1セグメントで fail-closed
- surface: serve, cli
- backend: ble
- command: `ble.invoke op=biometric.cardAdd / sesame ble invoke <device> biometric.cardAdd`
- branch: allowlisted('biometric') | not-allowlisted(reject)
- assert: invokePath が op パス第1セグメントを BLE_RPC_ALLOWLIST で照合し、'biometric' は通すが非掲載セグメントは getter 実行前に拒否する (fail-closed)。allowlist 未指定は全拒否 — rpc-helpers.invokePath の allowlist.includes(parts[0]) ガードと一致する
- ref: packages/core/src/ble/rpc-helpers.js:62-74; packages/core/src/ble/index.js:140-154; packages/kit/src/serve/entries/ble.js:143-145; packages/kit/src/cli/ble.js:512-524
- kind: error-path
- status: planned
- note: fail-closed (P4-2/ARCH-14)。getter は機種ガードで throw しうるが、allowlist 判定はプロパティ解決前に行うため副作用なく拒否 (rpc-helpers.js:70-72)。serve(ble.js:145) と cli(ble.js:524) は同一 invokePath+BLE_RPC_ALLOWLIST を共有。'biometric' は index.js:153 に掲載。

## list-collect

生体一覧 (cards/passcodes/faces/palms/fingers) の publish 収集 (FIRST→NOTIFY×N→END) を END/timeout で確定。

### [BLE3-0203] collectBiometricList: cardGet/passcodeGet 後 FIRST→NOTIFY×N→END 収集を END/timeout で確定
- surface: core, serve, cli, sdk
- backend: ble
- command: `sesame ble cards|passcodes <device> / ble.biometric.cardGet|passcodeGet`
- branch: end-received | timeout
- assert: collectBiometricList(cmds, BIO_LIST.card|passcode, ms) が registerDelegate で onCardReceiveStart/Receive/ReceiveEnd (passcode は onKeyBoardReceiveStart/Receive/ReceiveEnd) を結線→getter 発火→NOTIFY 各件を {id,name(UTF-8),type} に整形して records へ、END 受信または timeout で resolve する。BIO_LIST の getter/start/recv/end 名がファサードと一致する
- ref: packages/core/src/ble/biometric.js:1323-1329; packages/core/src/ble/biometric.js:1366-1395; packages/kit/src/serve/entries/ble.js:261-262; packages/kit/src/cli/ble.js:355-368
- kind: payload-fidelity
- status: planned
- note: card/passcode は single 無し (false) で (id,name,type) 整形 (biometric.js:1386-1387)。passcode の delegate 名は onKeyBoardReceiveStart/Receive/ReceiveEnd (BIO_LIST passcode 行 biometric.js:1325)。serve bioListEntry('card'|'passcode') (ble.js:261-262)・CLI cmdBiometricList (cli/ble.js:355, collect 呼出 :368) が同 collect を共有。

### [BLE3-0204] biometric list collectMs 既定 (serve 8000ms / CLI 既定) の option 分岐
- surface: serve, cli
- backend: ble
- command: `ble.biometric.cardGet (collectMs param) / sesame ble cards --collect-ms`
- branch: collectMs-given | collectMs-default
- assert: serve bioListEntry の collectMs が number 指定なら採用、未指定で 8000ms を既定とする (ble.js:103)。timeout 駆動で空 records でも resolve する (FIRST/END が来ない機種でハングしない)
- ref: packages/kit/src/serve/entries/ble.js:99-108; packages/core/src/ble/biometric.js:1391-1393
- kind: option-branch
- status: planned
- note: 8000 既定は ble.js:103 (`const collectMs = ... ? params.collectMs : 8_000`)、collectMs param 宣言は :99。timeout=setTimeout(finish, ms) で END 非到達でも確定 (biometric.js:1391)。Promise.resolve(getter()).catch で getter reject も握りつぶし publish/timeout を待つ (biometric.js:1393)。

### [BLE3-0205] list 整形 bioNameToText: name バイト→UTF-8 + 末尾NUL除去 (16B padding 由来)
- surface: core, cli
- backend: ble
- command: `collectBiometricList (card/passcode record name)`
- branch: string-name | buffer-name(NUL-padded)
- assert: collectBiometricList が NOTIFY の name バイト列を bioNameToText で UTF-8 化し、cardAdd の 16B padEnd 由来の末尾 0x00 を線形ループで除去する (ReDoS 回避で正規表現非使用) — record.name が表示名として一致する
- ref: packages/core/src/ble/biometric.js:1337-1347; packages/core/src/ble/biometric.js:1386-1387
- kind: payload-fidelity
- status: planned
- note: cardAddData は name を 16B 右ゼロパディング (biometric.js:381) するため NOTIFY 名に NUL 詰めが残りうる。local-contract 寄りだが add payload との往復対称性を担保。NUL strip は biometric.js:1344。

## idempotency

registerDelegate の購読/解除と多重 publish の冪等ディスパッチ。

### [BLE3-0206] registerDelegate の unsubscribe / 多重 publish の冪等ディスパッチ
- surface: core
- backend: ble
- command: `BiometricCommands.registerDelegate / handleBiometricPublish`
- branch: subscribe | unsubscribe | unknown-itemcode
- assert: registerDelegate が session.onPublish へ handleBiometricPublish を結線し unsubscribe を返す (onPublish 無しは no-op)。未対応 itemCode は false を返し副作用なし (再送/重複 publish でも delegate は itemCode で一意分岐)
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesameBiometricDeviceImpl.kt:165-198; packages/core/src/ble/biometric.js:725-738; packages/core/src/ble/biometric.js:929-932
- kind: idempotency
- status: planned
- note: kt:165-198 onGattSesamePublish の when(cmdItCode) 分岐 (handled フラグ), js:1145-1149 registerDelegate(onPublish 無し→()=>{}), js:929-932 default→false。

## surface-parity

cli/serve/sdk/core 横断の biometric/wifi 操作面パリティと fail-closed allowlist。

### [BLE3-0207] CLI faces/palms/fingers <device> 一覧収集が publish (FIRST/NOTIFY/LAST) を集約
- surface: cli, serve, core
- backend: ble
- command: `sesame ble faces|palms|fingers <device> / collectBiometricList / ble.biometric.faceListGet`
- branch: face-single | palm-single | finger-multi | timeout
- assert: collectBiometricList が BIO_LIST spec (faceListGet/palmListGet/fingerPrints + onFace/Palm/FingerReceiveStart/recv/End) で GET→publish 収集し END/timeout で確定する。CLI と serve の bioListEntry が同一実装 (collectBiometricList) を共用する
- ref: packages/core/src/ble/biometric.js:1323-1395; packages/kit/src/cli/ble.js:156-168; packages/kit/src/cli/ble.js:351-368; packages/kit/src/serve/entries/ble.js:261-265
- kind: surface-parity
- status: planned
- note: BIO_LIST(biometric.js:1323-1329) の face/palm single:true・finger は onFingerPrintReceive*。collectBiometricList(1366-1395) が registerDelegate→getter→END/timeout 駆動。CLI 登録(cli/ble.js:156-165)・収集 cmdBiometricList(355-368) が collectBiometricList(368) 呼出、serve bioListEntry(entries/ble.js:87-109,261-265) も collectBiometricList(106) を共用。

### [BLE3-0208] finger 一覧は Bike3 で fingerPrint ビュー、生体機種で biometric ビューを選ぶ
- surface: cli, serve
- backend: ble
- command: `biometricView / biometricViewOf (finger 判別)`
- branch: bike3-fingerPrint | biometric-view
- assert: type='finger' かつ caps.fingerprint && !caps.biometric (Bike3) では fingerPrint ビュー、それ以外の生体機種では biometric ビューから fingerPrints を呼ぶ。CLI と serve で同一判別ロジック
- ref: packages/kit/src/cli/ble.js:806-823; packages/kit/src/serve/entries/ble.js:78-83
- kind: surface-parity
- status: planned
- note: biometricView(cli/ble.js:814-823) と biometricViewOf(entries/ble.js:78-83) が共に type==='finger' && caps.fingerprint && !caps.biometric → ble.fingerPrint、else → ble.biometric の同一判別。

### [BLE3-0209] serve ble.invoke: BLE_RPC_ALLOWLIST 非掲載 op を fail-closed で拒否
- surface: serve
- backend: ble
- command: `ble.invoke / invokePath`
- branch: allowlist掲載op | 非掲載(bad_params) | secretKey欠落(need)
- assert: ble.invoke はドット区切り op パスを BLE_RPC_ALLOWLIST で照合し、非掲載 (connect/close/register/onStatus 等のライフサイクル系) を fail-closed で拒否する (ARCH-14 の fail-open 解消, P4-2)
- ref: packages/kit/src/serve/entries/ble.js:133; packages/core/src/ble/index.js:140
- kind: contract-existence
- status: planned
- note: ble.js:133 'ble.invoke' handler は need(params,['op','secretKey']) 後 invokePath(ble, op, args, BLE_RPC_ALLOWLIST)。index.js:140 BLE_RPC_ALLOWLIST(:140-154) に connect/close/register/onStatus は不掲載(:134-138 コメントで明記)、invokePath は非掲載パスを bad_params で拒否(:128)。

### [BLE3-0210] serve ble.scan: 鍵不要の近接列挙 (listNearby → scrubDiscovery)
- surface: serve
- backend: ble
- command: `ble.scan`
- branch: includeUnknown有 | 無(未知機種除外)
- assert: ble.scan は secretKey 不要で listNearbyDevices を呼び、{deviceUUID,model,kind,productType,isRegistered,rssi,...} を scrubDiscovery して返す (ble.register が要求する deviceUUID を消費者が自己解決可能に)。CHBleManager.kt:129-141 の onScanResult→chDeviceMap.getOrPut(deviceID)→productModel dedup と一致
- ref: packages/kit/src/serve/entries/ble.js:116; packages/core/src/ble/transport.js:542; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/CHBleManager.kt:129
- kind: contract-existence
- status: planned
- note: chDeviceMap は CHBleManager.kt:111 (宣言)・129-141 (onScanResult の getOrPut(deviceID)→productModel) に実在。

### [BLE3-0211] serve ble.register: ECDH 登録を registerOnce 経由で実行
- surface: serve
- backend: ble
- command: `ble.register`
- branch: deviceUUID必須(need) | model透過 | registerTransport解決
- assert: ble.register は deviceUUID 必須で registerOnce を呼び、model→能力テーブル透過・registerTransport を resolveRegisterTransport で解決する。OS3 BLE 登録結果 {deviceUUID,secretKey,productType,serverSecret} を返す (P-256 ECDH ハンドシェイク経由)
- ref: packages/kit/src/serve/entries/ble.js:266; packages/core/src/ble/index.js:1134; packages/core/src/ble/session.js:402
- kind: contract-existence
- status: planned
- note: resolveRegisterTransport は serve/entries/ble.js:10 で @sesame-kit/core/devices から import・ble.js:291 で解決。返り値 shape は session.js:402 / index.js:909、ECDH は session.js:339-381。

### [BLE3-0212] serve ble.position: lockPosition/unlockPosition 0 を欠落扱いしない検証
- surface: serve
- backend: ble
- command: `ble.position`
- branch: 両指定(送出) | undefined/null(invalid_params)
- assert: ble.position は 0 を有効角度として扱い undefined/null だけを INVALID_PARAMS で弾いてから configureLockPosition を呼ぶ (need() の 0 欠落扱いを回避)
- ref: packages/kit/src/serve/entries/ble.js:174; packages/kit/src/serve/entries/ble.js:184
- kind: error-path
- status: planned
- note: ble.js:184-188 が undefined/null 明示チェック (RpcError INVALID_PARAMS)、:190 で configureLockPosition(lockPosition, unlockPosition) を呼ぶ。0 は need() を通さず通過する。

### [BLE3-0213] ble.wifi.* は model 必須 (WM2/Hub3 判別・GATT 差のため)
- surface: serve
- backend: ble
- command: `ble.wifi.scan / setSsid / setPassword / connect`
- branch: missing-model
- assert: ble.wifi.* ハンドラが need(params,['model']) を強制し、model 欠落で bad_params (WM2 は専用 GATT のため model 不明では接続不能)
- ref: packages/kit/src/serve/entries/ble.js:193-260
- kind: error-path
- status: planned
- note: scan(L202)/setSsid(L218)/setPassword(L234)/connect(L249) すべて need(params,['model']) を呼ぶ。params に bleTargetParamsModelRequired (L55) を展開。

### [BLE3-0214] ble.wifi.setSsid/setPassword の ack 封筒が core/serve/sdk で同一
- surface: core, serve, sdk
- backend: ble
- command: `ble.wifi.setSsid / ble.wifi.setPassword`
- branch: -
- assert: setWifiSSID/setWifiPassword の応答が bleCommandAck で {resultCode, resultName} に正規化され、core/serve/sdk で同じ封筒になる (生 Buffer は契約に載せない)
- ref: packages/kit/src/serve/entries/ble.js:209-239; packages/core/src/ble/rpc-helpers.js:170-172
- kind: surface-parity
- status: planned
- note: serve setSsid(L221)/setPassword(L237) が bleCommandAck(await view.setWifi*) を返す。bleCommandAck (rpc-helpers.js:170-172) は {resultCode, resultName: resultName(resultCode)} のみ。result 宣言も '{ resultCode, resultName }' (L216/L232)。

## generated-ops

BLE_RPC_OPS の自動生成展開 (typed RPC/SDK/openrpc/grpc) と allowlist 整合。

### [BLE3-0215] BLE_RPC_OPS 自動生成: ble.<op> が typed RPC/SDK/openrpc に 1:1 展開
- surface: serve, sdk
- backend: ble
- command: `BLE_RPC_OPS / OS3_TOPLEVEL_RPC_OPS`
- branch: -
- assert: BLE_RPC_OPS (SCRIPT/BIOMETRIC/FINGERPRINT/REMOTE_NANO/WM2/HUB3/OS3_TOPLEVEL の集約) の各 op が registry→openrpc/proto/SDK へ型付きで生成され、params 順=ファサードメソッドの位置引数順になる (SURF-08 段階3)。SCRIPT_RPC_OPS の script.getCurrentScript(result:'raw')/script.getScriptNameList(params:[],result:'raw') の raw 結果 op も具体名で展開対象に含む (集約名止まりにしない)
- ref: packages/core/src/ble/index.js:277; packages/core/src/ble/index.js:187; packages/core/src/ble/bot2.js:215
- kind: contract-existence
- status: planned
- note: 全 experimental。index.js:277 = BLE_RPC_OPS (Object.freeze 集約)、:187 = OS3_TOPLEVEL_RPC_OPS、bot2.js:215 = SCRIPT_RPC_OPS 実体 (script.getCurrentScript/getScriptNameList が result:'raw')。WM2/HUB3 が BLE3-0217 で個別 ref を持つのと対称に SCRIPT も実体 ref を明示。関連テストは packages/kit/tests/ble/wifi-hub3-rpc-generated.test.js。

### [BLE3-0216] BLE_RPC_ALLOWLIST 全名が SesameBle ファサードに実在
- surface: core, serve
- backend: ble
- command: `BLE_RPC_ALLOWLIST / OS2_BLE_RPC_ALLOWLIST`
- branch: OS3 allowlist | OS2 allowlist
- assert: allowlist の各第1セグメント名が SesameBle/SesameOS2Ble の公開メソッド/ゲッタとして実在し、connect/close/register/onStatus 等のライフサイクル系は意図的に非掲載 (二重connect/再登録を invoke 経由で許さない)
- ref: packages/core/src/ble/index.js:140; packages/core/src/ble/index.js:161
- kind: contract-existence
- status: planned
- note: index.js:140 = BLE_RPC_ALLOWLIST、:161 = OS2_BLE_RPC_ALLOWLIST。biometric/fingerPrint/remoteNano/script(getter)・wifi/hub3/lock/unlock/configureLockPosition/updateFirmware/resetWifiModule2 等が facade に実在 (index.js:512-940)。関連テストは packages/core/tests/ble/rpc-allowlist.test.js。

### [BLE3-0217] WM2_RPC_OPS/HUB3_RPC_OPS が registry に展開され専用ハンドラと衝突しない
- surface: serve, sdk
- backend: ble
- command: `ble.wifi.insertSesames / ble.wifi.removeSesame / ble.wifi.reset / ble.hub3.*`
- branch: generated-ops
- assert: WM2_RPC_OPS (insertSesames/removeSesame/reset) と HUB3_RPC_OPS (scanWifiSSID/setWifiSSID/setWifiPassword/removeSesame/networkType) が型付き RPC に展開され、専用 ble.wifi.scan/setSsid/setPassword/connect と重複しない
- ref: packages/core/src/ble/wm2.js:504-515; packages/core/src/ble/hub3.js:390-410; packages/core/src/ble/index.js:282-283
- kind: contract-existence
- status: planned
- note: WM2_RPC_OPS=wm2.js:504-515 (insertSesames/removeSesame/reset)、HUB3_RPC_OPS=hub3.js:390-410 (scanWifiSSID/setWifiSSID/setWifiPassword/removeSesame/networkType)。展開の根拠 index.js:282-283 (...WM2_RPC_OPS, ...HUB3_RPC_OPS を BLE_RPC_OPS に合成; registry.js:314 が bleOpEntries で ble.<op> 化)。衝突なしは op 名が別(ble.hub3.scanWifiSSID vs 専用 ble.wifi.scan、後者は entries/ble.js:193- で wifiViewOf/collectWifiScan 経由の別定義)。

### [BLE3-0218] ble.wifi.*/ble.hub3.* が全 framing (openrpc/grpc) に存在
- surface: serve, sdk
- backend: ble
- command: `ble.wifi.scan / ble.wifi.setSsid / ble.wifi.connect / ble.hub3.networkType`
- branch: openrpc | grpc
- assert: ble.wifi.* と ble.hub3.* の各 op が openrpc.json と grpc-methods.generated.json の両 framing に method として存在する (serve/sdk 露出の存在性)
- ref: schema/openrpc.json:11524; packages/kit/src/serve/grpc-methods.generated.json:1974
- kind: contract-existence
- status: planned
- note: grpc の ble.wifi.scan は 1974 行に実在(method:'ble.wifi.scan')。openrpc.json:11524=name:'ble.wifi.scan' と同一 method を両 framing で指す。補足: ble.hub3.networkType も openrpc:7343 / grpc:1292 に両在を確認。

## cli-wifi

CLI ble wifi <device> <action> の語彙・分岐・異常系・--company-id。

### [BLE3-0219] CLI ble wifi <device> <action> の action 語彙と分岐
- surface: cli
- backend: ble
- command: `sesame ble wifi <device> <action> [value]`
- branch: scan | ssid | password | connect
- assert: WIFI_ACTIONS=[scan,ssid,password,connect] のみ受理し、scan は collectWifiScan で SSID 一覧、ssid/password は setWifi*、connect は connectWifi を呼ぶ (kind は wifiViewOf で自動判別)
- ref: packages/kit/src/cli/ble.js:622-676; packages/core/src/ble/rpc-helpers.js:112-117
- kind: option-branch
- status: planned
- note: WIFI_ACTIONS (L623), cmdWifi (L634-676)。scan→collectWifiScan(L660), ssid→setWifiSSID(L669), password→setWifiPassword(L670), connect→connectWifi(L671)。kind 判別の wifiViewOf (rpc-helpers.js:112-117)。

### [BLE3-0220] CLI ble wifi の異常系 (不明 action/値欠落/非対応機種/Hub3 connect)
- surface: cli
- backend: ble
- command: `sesame ble wifi`
- branch: bad-action | value-required | not-supported | hub3-connect
- assert: 不明 action は終了2、ssid/password の値欠落は終了2、wifiProvisioning/hubProvisioning 非対応 model は終了2、Hub3 への connect は connectWm2Only で終了2
- ref: packages/kit/src/cli/ble.js:634-655
- kind: error-path
- status: planned
- note: badAction ctx.die(...,2) L636, valueRequired L640, notSupported (!wifiProvisioning && !hubProvisioning) L648, connect+!wifiProvisioning→connectWm2Only L653。全て exit 2。

### [BLE3-0221] CLI ble wifi --company-id オプションが connect verification の company を上書き
- surface: cli
- backend: ble
- command: `sesame ble wifi <device> connect --company-id`
- branch: default | override
- assert: --company-id 未指定時は WM2_API_GATEWAY_CLIENT_ID 既定、指定時はそれを wifiViewOf 経由で connectWifi の verification company に使う
- ref: packages/kit/src/cli/ble.js:240; packages/kit/src/cli/ble.js:657; packages/core/src/ble/rpc-helpers.js:112-117
- kind: option-branch
- status: planned
- note: --company-id <id> オプション定義 (cli/ble.js:240)。L657 wifiViewOf(dev,{companyId:options.companyId})。未指定時は wifiViewOf (rpc-helpers.js:114) が companyId ?? WM2_API_GATEWAY_CLIENT_ID を WifiModule2 へ注入し connectWifi (wm2.js:420-423) が _companyId を verification company に使う。

## i18n

WM2/Hub3 Wi-Fi メッセージの en/ja カタログ完全性。

### [BLE3-0222] WM2/Hub3 Wi-Fi メッセージの en/ja カタログ完全性
- surface: core, cli
- backend: local
- command: `i18n (ble.wm2*/ble.hub3*/ble.cli.wifi*)`
- branch: en | ja
- assert: ble.wm2SsidRequired/wm2PasswordString/wm2CompanyIdRequired/wm2DeviceUUIDRequired/wm2SesameKeyRequired/wm2SesameKeyTagRequired/wm2SessionRequired/hub3SessionRequired/hub3NetworkTypeShort と ble.cli.wifi.* が en/ja 両ロケールで欠落なく定義されている
- ref: packages/core/src/i18n/ble.js:66-79; packages/core/src/i18n/ble.js:163-171; packages/core/src/i18n/ble.js:239-253; packages/core/src/i18n/ble.js:336-344
- kind: i18n
- status: planned
- note: en: wm2/hub3 (66-79), cli.wifi.* (163-171); ja: wm2/hub3 (239-253), cli.wifi.* (336-344) の4区間。en/ja 両ロケールの当該キー群が欠落なく定義されることを出典が支持する。

## script

Bot2/Bike2 の click script (RUN_SCRIPT/EDIT_SCRIPT/SCRIPT_SELECT) のバイト列・索引境界・直列化レイアウト。

### [BLE3-0223] script.click(index) は RUN_SCRIPT_0(170)+index、index 省略は click(89) を historyTagBLE で送る
- surface: core, cli, serve, sdk
- backend: ble
- command: `ble script-run <device> <index> / ble.script.click / Bot2Commands.click`
- branch: index 指定 (0..9) | index 省略 (=plain click 89)
- assert: clickItemCode(index) が index!=null で BOT2_ITEM_CODE_RUN_SCRIPT_0(170)+index、index==null で CLICK(89) を返し、payload は常に historyTagBLE(tag) (最低 [0x00,0x0E] 2B)。SDK の itemCode 選択・payload と一致
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesameBot2Device.kt:73-97; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:36; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:47; packages/core/src/ble/bot2.js:63-69; packages/core/src/ble/protocol.js:358-363
- kind: payload-fidelity
- status: planned
- note: 旧実装は未注入時 空 payload を送り SDK と乖離 (P1-10)。bot2.test.js:149 で観点あり。CLICK(89) は SesameProtocols.kt:36、RUN_SCRIPT_0(170)..RUN_SCRIPT_9(179) は同 enum の :47。historyTagBLE の最低 [0x00,0x0E] 2B 生成は protocol.js:358-363 が裏付け (SDK kt:91-93 sesame2KeyData.historyTagBLE と 1:1)。

### [BLE3-0224] clickItemCode は index>9 / 非 UByte を range エラーにする
- surface: core, cli
- backend: ble
- command: `ble script-run <device> <index> / Bot2Commands.click`
- branch: index>9 | 負数/非整数 | index==9 (上限)
- assert: clickItemCode(index) が index 0..9 のみ許し、10 以上や非 UByte で ble.bot2ScriptIndexRange を throw する (RUN_SCRIPT_0..9 の 10 本に対応)。CLI parseScriptIndex も 0..9 で exit 2
- ref: packages/core/src/ble/bot2.js:31-32; packages/core/src/ble/bot2.js:63-69; packages/kit/src/cli/ble.js:457-461; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:47
- kind: option-branch
- status: planned
- note: bot2.js:32 MAX_SCRIPT_INDEX=9、:65-66 が `!isUByte(index)||index>9` で ble.bot2ScriptIndexRange throw。CLI parseScriptIndex (ble.js:457-461) は 0..9 範囲外で ctx.die(...,2)。SesameProtocols.kt:47 に RUN_SCRIPT_0(170)..RUN_SCRIPT_9(179) の 10 本実在。i18n キー bot2ScriptIndexRange は i18n/ble.js:88,261 に実在。

### [BLE3-0225] selectScript(index) は SCRIPT_SELECT(94) に [index 1B] を送る
- surface: core, cli, serve, sdk
- backend: ble
- command: `ble script-select <device> <index> / ble.script.selectScript / Bot2Commands.selectScript`
- branch: -
- assert: selectScript が item=SCRIPT_SELECT(94)、data=byteArrayOf(index.toByte()) (1B) を送る。SDK selectScript と itemCode/payload 1:1
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesameBot2Device.kt:112-121; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:36; packages/core/src/ble/bot2.js:276-279
- kind: payload-fidelity
- status: planned
- note: SDK kt:116 が SesameOS3Payload(SCRIPT_SELECT.value, byteArrayOf(index.toByte()))。bot2.js:278 が session.request(ITEM.SCRIPT_SELECT, Buffer.from([index]))。SCRIPT_SELECT(94u) は SesameProtocols.kt:36、itemcodes.js:50 SCRIPT_SELECT:94 と一致。

### [BLE3-0226] sendClickScript(index,script) は EDIT_SCRIPT(181) に [index 1B]+scriptBytes を送る
- surface: core, cli, serve, sdk
- backend: ble
- command: `ble script-write <device> <index> --json / ble.script.sendClickScript / Bot2Commands.sendClickScript`
- branch: script=構造体 (scriptToBytes) | script=生バイト列 Buffer
- assert: sendClickScript が item=BOT2_ITEM_CODE_EDIT_SCRIPT(181)、data=byteArrayOf(index)+script を送る。SDK sendClickScript の sendData = byteArrayOf(index.toByte())+script と 1:1
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesameBot2Device.kt:99-110; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:48; packages/core/src/ble/bot2.js:261-268
- kind: payload-fidelity
- status: planned
- note: SDK kt:103-105 sendData = byteArrayOf(index.toByte())+script → SesameOS3Payload(EDIT_SCRIPT.value, sendData)。bot2.js:266-267 data = Buffer.concat([[index], scriptBytes]) → request(ITEM.BOT2_ITEM_CODE_EDIT_SCRIPT, data)。EDIT_SCRIPT(181u) は SesameProtocols.kt:48、itemcodes.js:66 と一致。

### [BLE3-0227] scriptToBytes は [nameLen 1B][name 領域 20B][actionLen 1B][action,time...] で直列化する
- surface: core
- backend: ble
- command: `Bot2Commands.sendClickScript / scriptToBytes`
- branch: actions 0 個 | actions n 個
- assert: scriptToBytes(event) が nameLength → name+0x00 埋め (常に 20B) → actionLength → 各 Bot2Action(action,time 2B) の順で出す。actionLength が byte 21 に来る。SDK CHSesamebot2Event.toByteArray() と 1:1 (nameData = name + ByteArray(20-size))
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesameBot2.kt:71-81; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesameBot2.kt:33-35; packages/core/src/ble/bot2.js:95-116; packages/core/src/ble/bot2.js:76-80
- kind: payload-fidelity
- status: planned
- note: SDK toByteArray (kt:71-81) は nameLength(idx0) ++ nameData(name+ByteArray(20-size)=常に20B, idx1-20) ++ actionLength(idx21) ++ Bot2Action.toByteArray(kt:33-35 action,time 2B)。bot2.js:110-115 が同順、bot2.test.js:63 が buf[21]===actionLength を検証 (byte21 裏付け)。

### [BLE3-0228] scriptToBytes は name>20B / 不正 action / 不正 time を明示エラーにする
- surface: core
- backend: ble
- command: `Bot2Commands.sendClickScript / scriptToBytes / bot2ActionToBytes`
- branch: name>20B | action 範囲外 | time 範囲外 | actions 非配列
- assert: name 20B 超で ble.bot2ScriptNameLen、action が BOT_ACTION_TYPE(0..3) 外で ble.bot2BadAction、time が非 UByte で ble.bot2BadActionTime を throw。SDK は ByteArray(20-size) で暗黙クラッシュするところを安全側で明示エラー化 (値域は同じ ≤20B)
- ref: packages/core/src/ble/bot2.js:95-104; packages/core/src/ble/bot2.js:76-80; packages/core/src/ble/bot2.js:40-45; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesameBot2.kt:74; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesameBot2.kt:11-20
- kind: error-path
- status: planned
- note: bot2.js:101 が name.length>20 で ble.bot2ScriptNameLen、:77 が BOT_ACTION_VALUES.has 外で ble.bot2BadAction、:78 が !isUByte(time) で ble.bot2BadActionTime。BOT_ACTION_TYPE(0..3) は bot2.js:40-45。SDK kt:74 `name + ByteArray(20-name.size)` は name.size>20 で NegativeArraySizeException (暗黙クラッシュ)、BotActionType enum は kt:11-20。i18n キー bot2ScriptNameLen/bot2BadAction/bot2BadActionTime は i18n/ble.js:94,90,91 に実在。

## 監査追補 v2 (dual-audit)

デュアル監査で回復した script 読み取り系 op・session 購読契約・publish 駆動キャッシュ・面パリティ/i18n の境界。作成時 API 障害で初版から取りこぼした候補を含む。

### [BLE3-0229] getCurrentScript / parseCurrentScript (SCRIPT_CURRENT=95): 送信 payload と受信直列化
- surface: core, cli, serve, sdk
- backend: ble
- command: `ble script <device> --index / ble.script.getCurrentScript / Bot2Commands.getCurrentScript / parseCurrentScript`
- branch: index 指定([index 1B]) | index 省略(空 payload) | actionLength==0(actions=null) | nameLength<1(null) | parse 失敗(bot2ScriptParseFailed throw)
- assert: getCurrentScript(index) が item=SCRIPT_CURRENT(95)、payload=index!=null なら [index 1B] 否なら空 を送り、応答を parseCurrentScript で [nameLength 1B][name 領域 20B][actionLength=byte21][action,time 2B...] と直列化解釈する (nameLength<1→null, actionLength==0→actions=null, parse 失敗→ble.bot2ScriptParseFailed throw)。CHSesameBot2Device.kt:123-144 getCurrentScript + CHSesamebot2Event.fromByteArray (CHSesameBot2.kt:47-68) と 1:1 一致
- ref: packages/core/src/ble/bot2.js:288; packages/core/src/ble/bot2.js:132; packages/core/src/ble/bot2.js:219; packages/core/src/itemcodes.js:51; packages/kit/src/cli/ble.js:421; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesameBot2Device.kt:123; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesameBot2.kt:47
- kind: payload-fidelity
- status: planned
- note: getCurrentScript(bot2.js:288) は index 有無で [index]/空 を送り parseCurrentScript(bot2.js:132) で応答解析、null は ble.bot2ScriptParseFailed で throw。公開 op script.getCurrentScript は SCRIPT_RPC_OPS(bot2.js:219, result:'raw')、CLI cmdScript(cli/ble.js:421) が dev.script.getCurrentScript(index)。受信 parse の罠 (actionLength が byte21、name 領域は常に 20B) を送信 scriptToBytes(BLE3-0227) と対称に固定。テスト bot2.test.js:78-103/207-225 (ID タグ無し) も観点あり → covered 昇格時に [ID] 付与。作成時 API 障害で初版が取りこぼした候補。

### [BLE3-0230] getScriptNameList / parseScriptNameList (SCRIPT_NAME_LIST=96): 空 payload と受信直列化+scripts キャッシュ
- surface: core, cli, serve, sdk
- backend: ble
- command: `ble script <device> / ble.script.getScriptNameList / Bot2Commands.getScriptNameList / parseScriptNameList`
- branch: curIdx<eventLength(正常, scripts キャッシュ更新) | curIdx>=eventLength(null=parse 失敗) | parse 失敗(bot2ScriptParseFailed throw)
- assert: getScriptNameList() が item=SCRIPT_NAME_LIST(96)、空 payload を送り、応答を parseScriptNameList で [curIdx 1B][eventLength 1B] ++ [nameLength=max(buf[cursor],1) 1B][name 領域 20B]×eventLength と解釈し、成功時 this.scripts キャッシュを更新する (curIdx>=eventLength→null, parse 失敗→ble.bot2ScriptParseFailed throw)。CHSesameBot2Device.kt:146-193 (scripts=status@178) getScriptNameList + CHSesamebot2Status.fromByteArray (CHSesameBot2.kt:93-109) と 1:1 一致
- ref: packages/core/src/ble/bot2.js:311; packages/core/src/ble/bot2.js:174; packages/core/src/ble/bot2.js:220; packages/core/src/itemcodes.js:52; packages/kit/src/cli/ble.js:420; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesameBot2Device.kt:146; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesameBot2.kt:93
- kind: payload-fidelity
- status: planned
- note: getScriptNameList(bot2.js:311) は空 data で送り parseScriptNameList(bot2.js:174) で {curIdx,eventLength,events} を解析し成功時 this.scripts を更新、null は ble.bot2ScriptParseFailed で throw。公開 op script.getScriptNameList は SCRIPT_RPC_OPS(bot2.js:220, params:[], result:'raw')、CLI cmdScript(cli/ble.js:420) が dev.script.getScriptNameList()。SDK の inFlight マージ (CHSesameBot2Device.kt:153-162) は kit が省く設計 (毎回送信)。テスト bot2.test.js:105-139/226-244 (ID タグ無し) も観点あり → covered 昇格時に [ID] 付与。作成時 API 障害で初版が取りこぼした候補。

### [BLE3-0231] script ゲッタの能力ゲート: Bot2/Bot3 のみ露出・他機種は bot2NotSupported
- surface: core
- backend: ble
- command: `SesameBle#script`
- branch: caps.script=true(Bot2/Bot3 で Bot2Commands 露出) | false(bot2NotSupported throw)
- assert: script ゲッタが capabilitiesForModel(model).script=true (Bot2/Bot3) のときだけ Bot2Commands を返し、それ以外 (ロック/Bike/biometric/Hub3/WM2/未知) では ble.bot2NotSupported を label 付きで throw する (wifi/hub3/fingerPrint/remoteNano ゲッタゲートと対称、op 捏造禁止)
- ref: packages/core/src/ble/index.js:669; packages/core/src/ble/devicemodel.js:84; packages/core/src/ble/devicemodel.js:308; packages/core/src/i18n/ble.js:85
- kind: error-path
- status: planned
- note: get script()(index.js:669-678) は !this._caps.script で badRequest('ble.bot2NotSupported',{label,modelSuffix}) を throw し Bot2/Bot3 でのみ Bot2Commands を生成。devicemodel.js:84 が BOT2 に script:true、:308 が capabilitiesForModel に script フラグ出力。i18n ble.bot2NotSupported は ble.js:85(en),258(ja) 実在。biometric/remoteNano(BLE3-0194)/fingerPrint(BLE3-0196) ゲッタゲートと同型の漏れを補完。テスト bot2.test.js:246-256 (ID タグ無し) 在り → covered 昇格時に [ID] 付与。

### [BLE3-0232] mechSetting(80)/opsSetting(92) publish のキャッシュ更新 (_lastMechSetting/_lastOpsSetting)
- surface: core
- backend: ble
- command: `SesameBleSession._onPacket (item 80/92 publish) / lastMechSetting / lastOpsSetting`
- branch: MECH_SETTING(80) publish→_lastMechSetting 更新 | OPS_CONTROL(92) publish→_lastOpsSetting 更新 | parse 失敗→無視
- assert: item=80/92 の publish 受信時に parseMechSetting/parseOpsSetting でキャッシュ (_lastMechSetting/_lastOpsSetting) を更新し、parse 失敗は握りつぶす (CHSesame5Device.kt:220-227 handleDevicePublish の mechSetting=CHSesame5MechSettings/opsSetting=CHSesame5OpsSettings 局所代入と一致)
- ref: packages/core/src/ble/session.js:785; packages/core/src/ble/session.js:788; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os3/CHSesame5Device.kt:220
- kind: payload-fidelity
- status: planned
- note: session.js:785-790 が OP.PUBLISH 経路で itemCode===MECH_SETTING→_lastMechSetting=parseMechSetting(body)、OPS_CONTROL→_lastOpsSetting=parseOpsSetting(body) を try/catch 更新。BLE3-0062(parseMechSetting)/0063(parseOpsSetting) は parser のみ、BLE3-0050(waived) は autolock 書き込み時の autoLockSecond 更新のみで、publish 駆動の読み取り側キャッシュ更新分岐 (CHSesame5Device.kt:220-227) は別境界。lastMechSetting/lastOpsSetting は BLE_RPC_ALLOWLIST(index.js:144) 公開 getter。

### [BLE3-0233] status() / onStatus(): mechStatus publish 購読-タイムアウト契約
- surface: core
- backend: ble
- command: `SesameBle.status / SesameBle.onStatus / SesameBleSession.onStatus`
- branch: status: 次の mechStatus publish で resolve | timeout(STATUS_WAIT_MS) | onStatus: 各 mechStatus を購読
- assert: status({timeoutMs}) は onStatus を 1 回限り購読し、最初の mechStatus(81) publish で off()+resolve(parsed status)、STATUS_WAIT_MS(4000) 経過で reject する。onStatus(fn) は session の _statusListeners へ fn を結線し unsubscribe を返す (再送 publish でも 1 リスナ 1 回ずつ呼ぶ)
- ref: packages/core/src/ble/index.js:978; packages/core/src/ble/index.js:838; packages/core/src/ble/index.js:293; packages/core/src/ble/session.js:781
- kind: idempotency
- status: planned
- note: index.js:838 onStatus(fn)→session.onStatus(fn)、index.js:978-984 status() が onStatus を購読し clearTimeout+off()+resolve、STATUS_WAIT_MS(index.js:293=4000) timeout (timeoutError(t('ble.mechStatusTimeout')))。session.js:781 が item81 publish 時 _statusListeners を 1 件ずつ呼ぶ。status 読み自体は LOCK 寄りだが、BLE session の購読 API (onStatus/_statusListeners/STATUS_WAIT_MS) は BLE3 固有の session-establish 境界 (BLE3-0049(waived) は toggle 内で間接参照するのみ)。

### [BLE3-0234] ble.script.getCurrentScript/getScriptNameList の RPC/CLI/SDK 露出 (result:'raw') 面パリティ
- surface: core, cli, serve, sdk
- backend: ble
- command: `ble.script.getCurrentScript / ble.script.getScriptNameList / sesame ble script <device>`
- branch: raw 結果 | CLI 一覧出力
- assert: script.getCurrentScript/getScriptNameList が result:'raw' で typed RPC/SDK/openrpc に展開され、CLI 'ble script' が getScriptNameList+getCurrentScript を集約出力する (core/serve/sdk/cli で同一パース結果。ack 封筒でなく raw 写像)
- ref: packages/core/src/ble/bot2.js:215; packages/core/src/ble/index.js:278; packages/kit/src/cli/ble.js:176; packages/kit/src/cli/ble.js:408
- kind: surface-parity
- status: planned
- note: SCRIPT_RPC_OPS(bot2.js:215-221) は script.getCurrentScript(result:'raw')・getScriptNameList(result:'raw') を宣言し、index.js:278 で ...SCRIPT_RPC_OPS が BLE_RPC_OPS に合成・index.js:153 で 'script' が BLE_RPC_ALLOWLIST 掲載。CLI cli/ble.js:176-179 'ble script <device>'(cmdScript:408) が getScriptNameList+getCurrentScript を JSON/人間可読で出力。getCurrentScript/getScriptNameList は ack 封筒でなくパース結果を返す経路 (bleOpEntries の raw 写像) のため BLE3-0215(generated-ops 集約) とは別に個別 surface-parity が必要 (参考 BLE3-0207 CLI list 収集の面パリティ)。

### [BLE3-0235] i18n: ble.bot2*/ble.cli.script* スクリプト系カタログの en/ja 完全性
- surface: core, cli
- backend: local
- command: `i18n (ble.bot2*/ble.cli.script*)`
- branch: en | ja
- assert: ble.bot2NotSupported/bot2BadIndex/bot2BadAction/bot2BadActionTime/bot2BadScript/bot2BadScriptName/bot2ScriptNameLen/bot2ScriptParseFailed/bot2ScriptIndexRange と ble.cli.script.*/scriptRun.*/scriptSelect.*/scriptWrite.* が en/ja 両ロケールで欠落なく定義されている
- ref: packages/core/src/i18n/ble.js:85; packages/core/src/i18n/ble.js:129; packages/core/src/i18n/ble.js:258; packages/core/src/i18n/ble.js:302
- kind: i18n
- status: planned
- note: BLE3-0222 は ble.wm2*/hub3*/cli.wifi.* の en/ja 完全性のみを assert する。script 機能には別系統の en/ja カタログ (ble.bot2*: i18n/ble.js:85-95 en/258-268 ja、ble.cli.script.*/scriptRun.*/scriptSelect.*/scriptWrite.*: 129-142 en/302-315 ja) が存在し、その両ロケール欠落なしを固定する i18n エントリが無かった。BLE3-0223..0228 はメッセージ throw を assert するが en/ja 両ロケールのカタログ完全性は i18n kind で別途固定する。


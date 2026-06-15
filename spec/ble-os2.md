<!-- spec-domain: ble-os2 | prefix: BLE2 | tests: packages/core/tests/ble, packages/kit/tests/cli, packages/kit/tests/serve, packages/kit/tests/ble -->

# BLE OS2 直結 spec (BLE2)

OS2 デバイス直結(autolock/disableAutolock/getAutolock/history/versionTag/updateSetting/reset/configureLockPosition/register/invoke)と OS2 セッション/プロトコルを Android SesameSDK(OS2)に照らして監査する。lock 動詞は lock.md(LOCK)へ。

## os2-handshake

OS2 login ハンドシェイク(SYNC opCode の PLAINTEXT login、app ECDH 64B 鍵、サーバ署名 sessionAuth、必須鍵素材ガード、token 4B 検証)を Android SesameSDK CHSesame2Device に照らして固定する。

### [BLE2-0001] OS2 login は SYNC opCode で PLAINTEXT 送信 (_sendPlain)
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession._sendLogin / _sendPlain`
- branch: -
- assert: login フレームは buildSendFrame(OP.SYNC=0x05, ITEM.LOGIN=2, data) を DeviceSegmentType.plain で送る (SDK SSM2OpCode.sync / SesameItemCode.login / plain と一致)
- ref: packages/core/src/ble/os2/session.js:680-684; packages/core/src/ble/os2/session.js:498-501; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:254-255
- kind: wire-fidelity
- status: planned
- note: 検証済み: SSM2OpCode.sync=0x05 (SesameProtocols.kt:57) / SesameItemCode.login=2u (SesameProtocols.kt:34) / OP.SYNC=0x05 (ble/protocol.js:36) / ITEM.LOGIN=2 (itemcodes.js:13) / SEG.PLAINTEXT=1 (ble/protocol.js:46) 全一致。ref を :254 から :254-255 へ拡張: opCode/item は :254、DeviceSegmentType.plain は :255 にあるため両方を含めた。

### [BLE2-0002] OS2 app ECDH 公開鍵は 65B uncompressed の prefix 0x04 を剥がした 64B raw
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession._appPubK64`
- branch: -
- assert: Node getPublicKey()(65B,先頭0x04) から 64B raw を取り出し、SDK EccKey.getPubK() の prefix 無し 64B 契約と一致する (65B/0x04 以外は明示 throw)
- ref: packages/core/src/ble/os2/session.js:363-369; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:236
- kind: wire-fidelity
- status: planned
- note: 検証済み: session.js:363-369 は length!==65 || [0]!==0x04 で throw し subarray(1) で 64B を返す。CHSesame2Device.kt:236 `EccKey.getPubK().hexStringToByteArray()` は prefix 剥がしなしで signPayload(238)/loginPayload(252) にそのまま連結 → SDK 契約は 64B raw であることを支持。

### [BLE2-0003] サーバ認証 login (signLogin) は sessionAuth をローカル計算せずサーバ署名を使う
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession.connect({signLogin}) / _loginViaServer`
- branch: needAuthFromServer | local-auth
- assert: signLogin 指定時は signPayload(userIdx++appPubKey64++sessionToken) の hex を渡してサーバ署名 sessionAuth を取得し loginPayload に使う (SDK isNeedAuthFromServer=true: sessionAuth=token、:240-242)。ローカル CMAC は呼ばない
- ref: packages/core/src/ble/os2/session.js:642-673; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:240-243; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:521-530
- kind: payload-fidelity
- status: planned
- note: 検証済み: session.js:642-646 は signLogin 経路で computeSessionAuth を呼ばず signPayload=keyIndex++appPubK64++sessionToken を _loginViaServer に渡す。CHSesame2Device.kt:240-243 が isNeedAuthFromServer 分岐 (true→token、false→AesCmac)。:521-530 が register 後 isNeedAuthFromServer 経路で signGuestKey(signPayload) → login(it.data)。全 ref 行番号正確。

### [BLE2-0004] サーバ署名 sessionAuth が 4B 未満なら login を reject
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession._loginViaServer`
- branch: server-auth-short-sig
- assert: signLogin の戻りが 4B 未満のとき loginPayload(sessionAuth[0:4]) を組めないため _loginWaiter を明示 reject する (sliceArray(0..3) の前提を守る防御)
- ref: packages/core/src/ble/os2/session.js:667-671; packages/core/src/ble/os2/protocol.js:148; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:252
- kind: error-path
- status: planned
- note: 検証済み: session.js:668-670 で auth.length<4 → _loginWaiter を reject。protocol.js:148 `if (auth.length < 4) throw` (loginPayload の subarray(0,4) 前提)。CHSesame2Device.kt:252 `sessionAuth!!.sliceArray(0..3)` が 4B 必須を示す。全 ref 正確。

### [BLE2-0005] connect() は secretKey も signLogin も無ければ reject
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession.connect`
- branch: no-secretKey-no-signLogin
- assert: 登録済み login は secretKey 必須、無い場合は signLogin が無ければ即 reject する (CMAC 鍵・サーバ署名のどちらも無いと sessionAuth を組めない)
- ref: packages/core/src/ble/os2/session.js:186-189; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:233-243
- kind: error-path
- status: planned
- note: 検証済み: session.js:187-189 `if (!this._secretKey && typeof signLogin !== "function") reject`。CHSesame2Device.kt:233 secretKey 取得 / :240-243 sessionAuth は token か AesCmac(secret) のいずれか — 両方欠落で sessionAuth 不能を支持。行番号正確。

### [BLE2-0006] connect() は ssmPublicKey(64B) 無しなら reject (OS2 ECDH 必須)
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession.connect`
- branch: missing-ssmPublicKey
- assert: OS2 login は sesame2PublicKey との ECDH を要するため ssmPublicKey 未指定で即 reject する (SDK は sesame2KeyData.sesame2PublicKey を ecdh の相手にする)
- ref: packages/core/src/ble/os2/session.js:190; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:235-246
- kind: error-path
- status: planned
- note: 検証済み: session.js:190 `if (!this._ssmPublicKey) reject(... required for OS2 login)`。CHSesame2Device.kt:235 ssmPublicKeyBytes 取得 → :246 `EccKey.ecdh(ssmPublicKeyBytes)` が ECDH 相手であることを示す。行番号正確。

### [BLE2-0007] keyIndex (userIdx) 空文字列は明示エラー、既定は "0000"(2B)
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession constructor (keyIndex)`
- branch: empty-keyIndex | default-0000
- assert: keyIndex は登録済みデバイスの "0000"=2B が既定で、空(0B)は loginPayload が 2B 短くなり実機パースとずれるため throw する (SDK 永続値 keyIndex="0000")
- ref: packages/core/src/ble/os2/session.js:99-106; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:466; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:234
- kind: error-path
- status: planned
- note: 修正: ref CHSesame2Device.kt:465 → :466。CHDevice コンストラクタ (462-469) で line 465 は `null`、keyIndex="0000" は line 466。:234 `keyIndex.hexStringToByteArray()` (login で userIdx として使用) は正確。session.js:103-106 で空 keyIndex を throw、既定 Buffer.from("0000","hex")=2B も確認。

### [BLE2-0008] initial token が 4B 以外なら login/ready を reject (FW プロトコル違反)
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession._handleInitial`
- branch: empty-token | non-4B-token | valid-4B
- assert: initial publish の mSesameToken が 0B または 4B 以外のとき _loginWaiter/_readyWaiter を明示 reject する (実 FW は常に 4B、sessionToken 8B = mAppToken4 ++ mSesameToken4 前提を守る)
- ref: packages/core/src/ble/os2/session.js:587-609; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:519
- kind: error-path
- status: planned
- note: 確認済: session.js:593-598 が empty-token reject、:599-609 が non-4B reject。CHSesame2Device.kt:519 `mSesameToken = receivePayload.payload` は切り詰め/検証なし — kit は明示 reject する逸脱で正しい。

## os2-cipher

OS2 CCM 暗号(13B nonce=counter5B++token8B、4B tag、aes-128-ccm、暗復号別カウンタの方向マーカ、復号失敗時の counter 進行、コンストラクタ長検証)を SesameOS2BleCipher に照らして固定する。

### [BLE2-0009] OS2 CCM nonce = counter5B ++ sessionToken8B (13B)
- surface: core
- backend: local
- command: `cipher.__test__.os2Nonce / SesameOS2BleCipher`
- branch: -
- assert: nonce は counter(5B LE) ++ sessionToken(8B) = 13B で、SDK の encryptCounter.toEncryCounter() + sessionToken と一致する (OS3 の count8B++0x00++token4 とは別)
- ref: packages/core/src/ble/os2/cipher.js:54-64; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/base/SesameOS2BleCipher.kt:13; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/base/SesameOS2BleCipher.kt:23
- kind: crypto-vector
- status: planned
- note: 確認済: cipher.js:62-64 os2Nonce = concat(toCounterBytes(5B), sessionToken8B)。Kotlin:13 `encryptCounter.toEncryCounter() + sessionToken`、:23 `decryptCounter.toDecryCounter() + sessionToken`。

### [BLE2-0010] encrypt counter は 0x80_00000000 を OR、decrypt counter は 0x7f_ffffffff を AND
- surface: core
- backend: local
- command: `cipher.__test__.toCounterBytes`
- branch: encrypt | decrypt
- assert: counter 5B LE 生成で encrypt は最上位ビット(bit39)を立て decrypt は落とす方向マーカが SDK toEncryCounter/toDecryCounter (or 0x8000000000 / and 0x7fffffffff) と一致する
- ref: packages/core/src/ble/os2/cipher.js:31-52; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/base/SesameOS2BleCipher.kt:36-59
- kind: crypto-vector
- status: planned
- note: 確認済: cipher.js:32 ENCRYPT_FLAG=0x80<<32、:34 DECRYPT_MASK=0x7fffffffff、:44-52 toCounterBytes が LE 5B 切り出し。Kotlin:39 `or 0x8000000000` (toEncryCounter 36-47)、:52 `and 0x7fffffffff` (toDecryCounter 49-59)。

### [BLE2-0011] OS2 CCM tag=4B / AAD=0x00 / aes-128-ccm
- surface: core
- backend: local
- command: `SesameOS2BleCipher.encrypt/decrypt`
- branch: -
- assert: 暗号は AES/CCM/NoPadding 相当 (aes-128-ccm)、tag 長 32bit=4B (GCMParameterSpec(32)), AAD=byteArrayOf(0) で、ciphertext++tag(4B) のフォーマットが SDK と一致する
- ref: packages/core/src/ble/os2/cipher.js:25-28; packages/core/src/ble/os2/cipher.js:104-136; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/base/SesameOS2BleCipher.kt:12-18
- kind: crypto-vector
- status: planned
- note: 確認済: cipher.js:26 OS2_CCM_TAG_LEN=4、:28 OS2_CCM_AAD=[0x00]、:107-110 encrypt(getAuthTag 4B append)、:132-135 decrypt(setAuthTag)。Kotlin:12 getInstance("AES/CCM/NoPadding")、:16 GCMParameterSpec(32,nonce)、:18 updateAAD(byteArrayOf(0))。

### [BLE2-0012] decrypt は doFinal の前に counter を進める (reset-session 整合)
- surface: core
- backend: ble-os2
- command: `SesameOS2BleCipher.decrypt / SesameOS2BleSession._onPacket`
- branch: decrypt-fail-skip | decrypt-ok
- assert: 復号失敗時もこの1フレームだけ捨て decCount は進める (SDK decryptCounter=inc() and Long.MAX_VALUE を doFinal 前に実行) ことで取りこぼし後も後続フレームと counter 整合する
- ref: packages/core/src/ble/os2/cipher.js:121-136; packages/core/src/ble/os2/session.js:533-545; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/base/SesameOS2BleCipher.kt:22-33
- kind: error-path
- status: planned
- note: 確認済: cipher.js:129 `this._decCount += 1n` は doFinal(:135) の前。session.js:536-542 が decrypt 失敗時に return でこの 1 フレームのみ破棄。Kotlin:26 `decryptCounter = decryptCounter.inc() and Long.MAX_VALUE` は doFinal(:32) の前。

### [BLE2-0013] encrypt/decrypt counter は独立に進む (送受信別カウンタ)
- surface: core
- backend: local
- command: `SesameOS2BleCipher (encryptCounter/decryptCounter)`
- branch: -
- assert: 1 セッション 1 インスタンスで encCount と decCount が独立 0 起点・別々に ++ される (SDK encryptCounter/decryptCounter が別フィールド) ことを連続 encrypt/decrypt で確認する
- ref: packages/core/src/ble/os2/cipher.js:89-96; packages/core/src/ble/os2/cipher.js:106; packages/core/src/ble/os2/cipher.js:129; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/base/SesameOS2BleCipher.kt:8-9
- kind: crypto-vector
- status: planned
- note: 確認済: cipher.js:89-90 _encCount=0n/_decCount=0n、:94-96 getter、:106 _encCount+=1n (encrypt)、:129 _decCount+=1n (decrypt) は別フィールド。Kotlin:8 `var encryptCounter: Long = 0`、:9 `var decryptCounter: Long = 0`。

### [BLE2-0014] sessionToken が 8B 以外なら cipher コンストラクタが throw
- surface: core
- backend: local
- command: `SesameOS2BleCipher constructor`
- branch: bad-token-len | bad-key-len
- assert: sessionKey!=16B / sessionToken!=8B はコンストラクタで throw する (CCM nonce 上限 13B = counter5B+token8B の制約; SDK は無検証だが nonce 制約上 token<=8B が必要)
- ref: packages/core/src/ble/os2/cipher.js:80-91; packages/core/src/ble/os2/protocol.js:163-170
- kind: error-path
- status: planned
- note: 確認済: cipher.js:81-83 sessionKey!=16B throw、:84-86 sessionToken!=8B throw。protocol.js:163-170 が「SesameOS2BleCipher.kt:7 はコンストラクタ無検証だが nonce 上限 13B = counter5B++token の制約上 token<=8B が必要、4B+4B=8B が正準形」と本 assert の根拠を明文化。kit 独自のローカル堅牢化 (SDK 逸脱) で正しい。

## os2-frame

OS2 のフレーム構造(送信は opCode を含む [opCode,itemCode]++data、受信 response は item 先頭 3B ヘッダ、publish は item 先頭 1B ヘッダ)を SSM2Payload/SSM2ResponsePayload/SSM3PublishPayload に照らして固定する。

### [BLE2-0015] 送信フレームは [opCode, itemCode] ++ data (OS2 は opCode を含む)
- surface: core
- backend: ble-os2
- command: `protocol.buildSendFrame`
- branch: -
- assert: OS2 送信フレームは先頭に opCode を含み [opCode, itemCode] ++ data となる (SDK SSM2Payload.toDataWithHeader = byteArrayOf(opCode.value, itemCode.value.toByte()) + data)。OS3 (item++data) との最大差分
- ref: packages/core/src/ble/os2/protocol.js:219-221; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/base/CHSesameOS2.kt:29-31
- kind: wire-fidelity
- status: planned

### [BLE2-0016] 受信 response は itemCode 先頭の 3B ヘッダ (item,op,result)
- surface: core
- backend: ble-os2
- command: `protocol.parseRecvFrame`
- branch: response | publish | other
- assert: notifyOpCode==7(response) は body=[cmdItCode,cmdOPCode,cmdResultCode,...payload] と分解 (SDK SSM2ResponsePayload, itemCode が先頭・opCode が後で送信順と逆)。短すぎは throw
- ref: packages/core/src/ble/os2/protocol.js:239-255; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:15-19
- kind: wire-fidelity
- status: planned

### [BLE2-0017] 受信 publish は itemCode 先頭の 1B ヘッダ
- surface: core
- backend: ble-os2
- command: `protocol.parseRecvFrame (publish)`
- branch: publish
- assert: notifyOpCode==8(publish) は body=[cmdItCode,...payload] と分解する (SDK SSM3PublishPayload: cmdItCode=data[0]、payload=data.drop(1))
- ref: packages/core/src/ble/os2/protocol.js:256-259; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:5-8
- kind: wire-fidelity
- status: planned

### [BLE2-0018] OP/SSM2OpCode の数値定数が SDK と一致 (create=1..publish=8)
- surface: core
- backend: local
- command: `protocol.OP`
- branch: -
- assert: OP の create=0x01/read=0x02/update=0x03/delete=0x04/sync=0x05/async=0x06/response=0x07/publish=0x08 が SDK SSM2OpCode 列挙値と一致する
- ref: packages/core/src/ble/protocol.js:34-36; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:55-57
- kind: wire-fidelity
- status: planned

## os2-itemcode

OS2 の itemCode 数値(login/initial/IRER/timePhone/mechStatus 等)と OS2 固有の時刻同期 itemCode (timePhone=16) を SesameItemCode に照らして固定する。

### [BLE2-0019] OS2 itemCode 値が SesameItemCode と一致 (login/initial/IRER/timePhone 等)
- surface: core
- backend: local
- command: `itemcodes.js (ITEM)`
- branch: -
- assert: registration=1/login=2/history=4/versionTag=5/enableDFU=7/autolock=11/initial=14/IRER=15/timePhone=16/mechSetting=80/mechStatus=81/lock=82/unlock=83/click=89 が SDK SesameItemCode と一致する
- ref: packages/core/src/itemcodes.js:12-41; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/SesameProtocols.kt:34-36
- kind: wire-fidelity
- status: planned
- note: 行番号修正: 1-20 範囲は SesameProtocols.kt:34、mechSetting(80)..click(89) は :36 にあるため SDK ref を 34-36 へ拡張 (旧 :34 のみでは 80-89 を支持せず)

### [BLE2-0020] OS2 時刻同期は TIME(8) ではなく timePhone(16)
- surface: core
- backend: ble-os2
- command: `protocol.timePhoneData / _maybeSyncTime`
- branch: -
- assert: login 後の時刻同期コマンドは SesameItemCode.timePhone(16) を使い TIME(8) と混同しない (SDK CHSesame2Device.kt:263 が timePhone を使用)。kit は buildSendFrame(OP.UPDATE, ITEM.TIMEPHONE, timePhoneData()) を送る
- ref: packages/core/src/itemcodes.js:27; packages/core/src/ble/os2/session.js:746-779; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:263
- kind: wire-fidelity
- status: planned
- note: ref 置換: 旧 protocol.js:42-47 は TIMEPHONE 定数の doc コメントのみで command (_maybeSyncTime) 実体を含まず。実送信箇所 session.js:746-779 (752/778 が buildSendFrame(OP.UPDATE, ITEM.TIMEPHONE, timePhoneData())) へ差し替え。timePhoneData 実体は protocol.js:683-685

## os2-register

OS2 工場出荷デバイスの登録(IRER 読み出し、registerKey/ownerKey/sessionKey CMAC 連鎖、REGISTRATION payload、login publish 完了、ecdhSecret と secretKey の区別、工場出荷ガード、registerServer 正規化、単一 ECDH 鍵、localServerAuth アダプタ)を CHSesame2Device に照らして固定する。

### [BLE2-0021] register IRER 読み出しは PLAINTEXT、ER = payload.drop(16)
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession.register (IRER step)`
- branch: -
- assert: READ IRER(15) を PLAINTEXT 送信し応答 payload の先頭16Bを捨てた残り(drop(16))を ER として hex 化する (SDK IRRes.payload.drop(16)、plain 送信)。payload<16B は throw
- ref: packages/core/src/ble/os2/session.js:284-287; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:412-418
- kind: payload-fidelity
- status: planned

### [BLE2-0022] register 鍵束 = registerKey/ownerKey/sessionKey の CMAC 連鎖
- surface: core
- backend: ble-os2
- command: `protocol.deriveRegisterKeys`
- branch: -
- assert: sessionToken=serverToken++mSesameToken、registerKey=CMAC(pre16,sessionToken)、ownerKey=CMAC(registerKey,"owner_key")、sessionKey=CMAC(registerKey,sessionToken) が SDK と一致する
- ref: packages/core/src/ble/os2/protocol.js:176-187; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:451-454
- kind: crypto-vector
- status: planned
- note: 検証済: protocol.js:182 stoken=concat(srv,ssm), :183 registerKey=aesCmac(pre,stoken), :184 ownerKey=aesCmac(registerKey,"owner_key"), :185 sessionKey=aesCmac(registerKey,stoken) が SDK :451-454 と 1:1 一致

### [BLE2-0023] REGISTRATION payload = sig1[0:4] ++ appPubKey64 ++ serverToken
- surface: core
- backend: ble-os2
- command: `protocol.registrationData / register CREATE step`
- branch: -
- assert: CREATE REGISTRATION(1) の平文 data が sig1.sliceArray(0..3) ++ appPubKey(64B) ++ serverToken で、SDK の payload = sig1 + appPubKey + serverToken と一致し plain 送信する
- ref: packages/core/src/ble/os2/protocol.js:199-206; packages/core/src/ble/os2/session.js:330-331; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:447-458
- kind: payload-fidelity
- status: planned
- note: SDK ref を :447-449→:447-458 に拡張: assert の「plain 送信」根拠は :458 sendEncryptCommand(cmd, DeviceSegmentType.plain) にあり、:447-449 (payload/cmd 構築) のみでは不足。session.js:330-331 は registrationData→_sendPlain(buildSendFrame(CREATE,REGISTRATION,payload)) で一致

### [BLE2-0024] register 完了は login publish で通知され ownerKey が secretKey になる
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession.register (return) / _handleLoginPublish`
- branch: -
- assert: 登録完了は response でなく login publish で来る。戻り値 secretKey は ownerKey.toHexString()、keyIndex="0000" で SDK の永続化フィールド (CHDevice(...,"0000",ownerKey,...)) と一致する
- ref: packages/core/src/ble/os2/session.js:343-356; packages/core/src/ble/os2/session.js:702-718; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:462-469; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:508-517
- kind: payload-fidelity
- status: planned
- note: session.js ref を :332-356→:343-356 に修正: secretKey/keyIndex の戻り値定義は return ブロック :343-356 (:347 secretKey=ownerKeyHex, :348 keyIndex="0000")。:702-718 _handleLoginPublish が登録完了を login publish (_registerWaiter resolve) で処理。SDK :462-469 CHDevice(...,"0000",ownerKey.toHexString(),...), :508-517 onGattSesamePublish(login) と一致

### [BLE2-0025] register 戻り ecdhSecret(pre16) は login 鍵ではない (secretKey と別物)
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession.register (ecdhSecret field)`
- branch: -
- assert: 戻り値 ecdhSecret は ECDH pre16 hex (登録中間値) で、次回 login の CMAC 鍵は ownerKey である。pre16 を secretKey に渡すと invalidSig になる回帰を防ぐ
- ref: packages/core/src/ble/os2/session.js:312-316; packages/core/src/ble/os2/session.js:343-352; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:453; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:243
- kind: payload-fidelity
- status: planned
- note: 検証済: session.js:315 ownerKeyHex / :316 ecdhSecretHex=pre16.hex, :352 ecdhSecret 返却。SDK :453 ownerKey=AesCmac(registerKey,owner_key) が永続鍵、:243 login の sessionAuth=AesCmac(secret=ownerKey,signPayload) — login CMAC 鍵は ownerKey であり pre16 ではない、を裏付ける

### [BLE2-0026] register は secretKey 付きセッションでは拒否 (工場出荷必須)
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession.register`
- branch: has-secretKey | no-deviceUUID | no-registerServer
- assert: register() は secretKey 付き構築で reject、deviceUUID 必須、registerServer コールバック必須 (SDK register は ReadyToRegister 以外で BUSY を返す前提に対応)
- ref: packages/core/src/ble/os2/session.js:251-255; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:407-410
- kind: error-path
- status: planned
- note: 検証済: session.js:252 _secretKey→reject(factory device), :253 deviceUUID 必須, :254 registerServer 必須 (:255 busy は branch 外)。SDK :407-410 if(deviceStatus!=ReadyToRegister) BUSY を JS の factory-device 前提に写像。3 branch は assert と整合

### [BLE2-0027] register registerServer 戻りは base64 既定で sig1/st/pubkey を Buffer 化
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession.register (toBuf normalization)`
- branch: string-base64 | buffer | uint8array
- assert: registerServer の sig1/serverToken(st)/sesamePublicKey(pubkey) は SDK 同様 base64decodeByteArray 相当で正規化し、Buffer/Uint8Array はそのまま、文字列は base64 と解釈する
- ref: packages/core/src/ble/os2/session.js:303-307; packages/core/src/ble/os2/session.js:817-823; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:440-443
- kind: payload-fidelity
- status: planned
- note: 検証済: session.js:305-307 toBuf(sig1/st/pubkey,"base64"), :817-823 toBuf(Buffer→そのまま/Uint8Array→Buffer.from/string→base64)。SDK :440-443 sig1/st/pubkey.base64decodeByteArray() と一致

### [BLE2-0028] register の app ECDH 鍵は IRER 後に生成しハンドシェイク全体で共有
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession.register (_regKeyPair)`
- branch: -
- assert: register は app ECDH 鍵ペアを 1 つ生成し appPubK64 を registerServer へ渡しつつ ECDH(sesamePublicKey) と REGISTRATION payload の双方で同一鍵を使う (login の EccKey.getPubK 単一鍵契約に対応)
- ref: packages/core/src/ble/os2/session.js:289-310; packages/core/src/ble/os2/session.js:330; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:436-447
- kind: payload-fidelity
- status: planned
- note: 確認済: kit は _regKeyPair=createECDH/generateKeys を 1 回 (L290-291)、appPubK64 を registerServer へ (L299-302)、ecdhSecretPre16(_regKeyPair,sesamePublicKey)=L310、payload=registrationData(sig1,appPubK64,serverToken)=L330。Kotlin 原典: appPubKey=EccKey.getPubK() L441、ecdhSecret=EccKey.ecdh(sesamePublicKey) L445、payload=sig1+appPubKey+serverToken L447 — 同一 EccKey 単一鍵。login 側も EccKey.getPubK() L236/EccKey.ecdh L246 で同一。範囲 436-447 妥当

### [BLE2-0029] localServerAuth register は makeLocalRegisterServer を充てる (UNVERIFIED)
- surface: core
- backend: ble-os2
- command: `SesameOS2Ble (localServerAuth) / makeLocalRegisterServer`
- branch: explicit-registerServer | localServerAuth
- assert: registerServer 明示が最優先、未指定かつ localServerAuth=true でローカル getRegisterKey アダプタ (makeLocalRegisterServer) を自動生成する。getRegisterKey は UNVERIFIED PORT
- ref: packages/core/src/ble/os2/index.js:87-91; packages/core/src/crypto.js:761-792
- kind: contract-existence
- status: planned
- note: 確認済: os2/index.js L90-91 で this._registerServer = registerServer || (localServerAuth ? makeLocalRegisterServer() : null) — 明示優先のフォールバック。ref 修正: 旧 crypto.js:453-471 は UNVERIFIED-PORT 説明コメントヘッダ (deriveRegisterPriKey/getRegisterKey/SERVER_AUTH_PUBKEY 前置き) であり export 本体ではない → makeLocalRegisterServer 関数本体 crypto.js:761-792 へ差し替え。本エントリのスコープは os2/index.js:90-91 フォールバック配線の contract-existence のみ (L90-91 でローカル検証可のため status=planned 維持)。getRegisterKey アルゴリズム KAT (sig1/SERVER_AUTH_PUBKEY) は crypto.md(CRY) が正典 ([[CRY-0029]]/[[CRY-0030]]) で本エントリの被覆外。実サーバ往復は実クラウド登録でしか最終検証不能

## os2-loginresp

login response payload の解釈(systemTime LE u32、fwVersion 符号付き Byte、mech_setting/mech_status スライス、Sesame2/Bot の mechSetting レイアウト)を SSM2LoginResponsePayload に照らして固定する。

### [BLE2-0030] login response systemTime は LE u32 (toBigLong 由来)
- surface: core
- backend: ble-os2
- command: `protocol.parseLoginResponse (systemTime)`
- branch: -
- assert: payload[0:4] を little-endian u32 として読む (SDK toBigLong=reversedArray().toHexString() の hex parse と等価)。旧 readUInt32BE の逆読みで時刻差判定が常発火する誤りを防ぐ
- ref: packages/core/src/ble/os2/protocol.js:641-647; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:627; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/utils/DataExtention.kt:69-71
- kind: payload-fidelity
- status: planned
- note: 確認済: kit :647 readUInt32LE(0)。SDK :627 var systemTime=...toBigLong()。DataExtention :69-71 toBigLong=reversedArray()+hex parse=LE と等価

### [BLE2-0031] login response fwVersion は符号付き Byte で読む
- surface: core
- backend: ble-os2
- command: `protocol.parseLoginResponse (fwVersion)`
- branch: -
- assert: payload[4] を readInt8 (符号付き -128..127) で読む。SDK の var fw_version=loginPayload[4] (Kotlin Byte=signed) と一致し、fw_version>=1 ガードの signed 比較を再現する
- ref: packages/core/src/ble/os2/protocol.js:654; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:628; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:262
- kind: payload-fidelity
- status: planned
- note: 確認済: kit :654 readInt8(4)。SDK :628 var fw_version=loginPayload[4] (Kotlin Byte=signed)、:262 if(loginResponse.fw_version >= 1) signed 比較

### [BLE2-0032] login response の mech_setting=[8:20] / mech_status=[20:28] スライス
- surface: core
- backend: ble-os2
- command: `protocol.parseLoginResponse (slices)`
- branch: -
- assert: mech_setting_t=payload[8..19](12B)、mech_status_t=payload[20..27](8B)、historyCnt=payload[6] のスライス位置が SDK SSM2LoginResponsePayload と一致する (>=28B 未満は throw)
- ref: packages/core/src/ble/os2/protocol.js:641-668; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:627-633
- kind: payload-fidelity
- status: planned
- note: 確認済: kit :656 subarray(8,20), :657 subarray(20,28), :655 payload[6], :642-643 >=28B throw。SDK :630 sliceArray(8..19), :631 sliceArray(20..27), :629 loginPayload[6]

### [BLE2-0033] mechSetting Sesame2 は度数換算 + isConfigured=(lock!=unlock)
- surface: core
- backend: ble-os2
- command: `protocol.parseMechSettingSesame2`
- branch: configured | noSettings
- assert: lockPosition/unlockPosition=trunc(raw*360/1024)、isConfigured=(lock!=unlock) が SDK CHSesame2MechSettings と一致する (lock==unlock は NoSettings 状態)
- ref: packages/core/src/ble/os2/protocol.js:571-588; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesame2.kt:24-28; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:268
- kind: payload-fidelity
- status: planned
- note: 確認済: kit :575-578 readInt16LE+os2RawToDeg(trunc(raw*360/1024) at :556-558), :584 isConfigured=lock!==unlock。SDK CHSesame2.kt:25-27 (lockPosition/unlockPosition deg, isConfigured)。raw は signed LE (bytesToShort DataExtention :99-102)。CHSesame2Device.kt:268 NoSettings 判定

### [BLE2-0034] mechSetting Bot は 7 フィールド符号付き Byte
- surface: core
- backend: ble-os2
- command: `protocol.parseMechSettingBot`
- branch: -
- assert: mech_setting_t[0..6] を userPrefDir/lockSec/unlockSec/clickLockSec/clickHoldSec/clickUnlockSec/buttonMode の符号付き 1B(readInt8) として読み、SDK CHSesameBotMechSettings と一致する
- ref: packages/core/src/ble/os2/protocol.js:599-613; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesameBot.kt:17; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesameBikeDevice.kt:520
- kind: payload-fidelity
- status: planned
- note: 確認済: kit :605-611 readInt8(0..6) 7 フィールド。SDK CHSesameBot.kt:17 data class (7×Byte=signed)。CHSesameBikeDevice.kt:520 が mech_setting_t[0..6] を 7 引数で構築

## os2-mechstatus

mechStatus(mech_status_t)の解釈を機種別(os2lock=Sesame2/3/4、os2bot=Bot1、os2bike=Bike1)に分け、フィールド配置・state 判定・isStop 由来・度数併記・自動履歴読み出しの意図的逸脱を CHSesame2/CHSesameBot/CHSesameBike に照らして固定する。

### [BLE2-0035] mechStatus retCode=data[6] / flags=data[7] の順 (Sesame2/3/4)
- surface: core
- backend: ble-os2
- command: `protocol.parseMechStatus (os2lock)`
- branch: os2lock
- assert: 8B mech_status_t で battery=[0:2]LE, target=[2:4]i16LE, position=[4:6]i16LE, retCode=data[6], flags=data[7] とし、isInLockRange=flags&2/isInUnlockRange=flags&4/isBatteryCritical=flags&32 が SDK CHSesame2MechStatus と一致する (retCode と flags の順を逆にしない)
- ref: packages/core/src/ble/os2/protocol.js:488-499; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesame2.kt:30-39
- kind: payload-fidelity
- status: planned
- note: 検証済: protocol.js:492 batteryRaw=readUInt16LE(0), :493 target=readInt16LE(2), :494 position=readInt16LE(4), :495 retCode=buf[6], :496 flags=buf[7], :497-499 flags&2/&4/&32。SDK CHSesame2MechStatus :32 position(data[4,5]) :33 target(data[2,3]) :34 retCode=data[6] :36 flags=data[7] :37-39 flags and 2/4/32, :43 battery=data[0,1]。SDK ref を :30-40→:30-39 に修正 (line40 は isStop=null で assert 対象外、:30-39 が retCode/flags/range/battery-critical を厳密に内包)。注: protocol.js のインラインコメントが SDK 行番号を 1 行ずれて引用 (:35/:37-40 と記載・実際は :34/:36-39) しているがコード挙動・候補 ref 範囲は正

### [BLE2-0036] mechStatus target==-32768(Short.MIN_VALUE) は null
- surface: core
- backend: ble-os2
- command: `protocol.parseMechStatus (target)`
- branch: target-minvalue | target-set
- assert: target が Short.MIN_VALUE(-32768) のとき null として公開する (SDK CHSesame2.kt:33: ==-32768 ? null)。targetDeg も null になる
- ref: packages/core/src/ble/os2/protocol.js:493; packages/core/src/ble/os2/protocol.js:534-536; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesame2.kt:33
- kind: payload-fidelity
- status: planned
- note: 確認済: protocol.js:493 target=readInt16LE(2); :534 target===-32768?null:target; :536 targetDeg も同条件で null。SDK CHSesame2.kt:33 = target が bytesToShort(data[2],data[3])==-32768 で null。

### [BLE2-0037] mechStatus state 3 値判定 (locked/unlocked/moved) os2lock
- surface: core
- backend: ble-os2
- command: `protocol.parseMechStatus (state, os2lock)`
- branch: locked | unlocked | moved
- assert: isInLockRange→locked、isInUnlockRange→unlocked、どちらでもない→moved の3値判定が SDK (CHSesame2Device.kt:551 lock/unlock/else=Moved) と一致する
- ref: packages/core/src/ble/os2/protocol.js:505-508; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:551; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesameBikeDevice.kt:299
- kind: payload-fidelity
- status: planned
- note: 修正: assert は CHSesame2Device.kt:551 を引くが ref 配列に欠落していたため追加。os2lock(既定) の3値 state の一次出典は CHSesame2Device.kt:551 (NoSettings 分岐を除けば isInLockRange→Locked / isInUnlockRange→Unlocked / else→Moved)。Bike(:299)も同形3値で補強。protocol.js:506-508 で isBot 以外は MOVED 可。

### [BLE2-0038] mechStatus kind=os2lock の isStop は null (Sesame2/3/4)
- surface: core
- backend: ble-os2
- command: `protocol.parseMechStatus (isStop, os2lock)`
- branch: os2lock
- assert: 既定(os2lock)では isStop=null を返す (SDK CHSesame2.kt:40 が明示的に null。flags bit0 のロック意味論は一次資料なし)
- ref: packages/core/src/ble/os2/protocol.js:519-524; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesame2.kt:40
- kind: payload-fidelity
- status: planned
- note: 確認済: CHSesame2.kt:40 = `override var isStop: Boolean? = null`。protocol.js:524 で isBot/isBike 以外は null。

### [BLE2-0039] mechStatus kind=os2bot は state 2値 + motorStatus 由来 isStop
- surface: core
- backend: ble-os2
- command: `protocol.parseMechStatus (os2bot)`
- branch: os2bot
- assert: Bot1 は state が2値 (isInLockRange→locked else→unlocked、moved 無し)、isStop=motorStatus 0(noPower)/2(hold)→true・1(forward)/3(backward)→false が SDK CHSesameBotDevice.kt の when 上書きと一致する
- ref: packages/core/src/ble/os2/protocol.js:502-524; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesameBotDevice.kt:286-293; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesameBotDevice.kt:303; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesameBotDevice.kt:334-344
- kind: payload-fidelity
- status: planned
- note: 確認済+補強: state2値の出典は CHSesameBotDevice.kt:303 (login経路) と :346 (mechStatus経路) の `if(isInLockRange) Locked else Unlocked`。isStop の when は login経路 :286-293 と mechStatus経路 :334-344。mechStatus publish 経路の when(:334-344)を ref に追加。いずれも else→false (protocol.js:521 では 0/2→true、それ以外→false で一致)。

### [BLE2-0040] mechStatus kind=os2bike は isStop=flags bit0 由来
- surface: core
- backend: ble-os2
- command: `protocol.parseMechStatus (os2bike)`
- branch: os2bike
- assert: Bike1 は CHSesameBotMechStatus を流用し isStop=(flags and 1 == 0) が SDK CHSesameBot.kt:28 と一致する (Bike は Bot 形式の mechStatus を使う)
- ref: packages/core/src/ble/os2/protocol.js:510-524; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesameBot.kt:28; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesameBikeDevice.kt:296
- kind: payload-fidelity
- status: planned
- note: 確認済: CHSesameBot.kt:28 = `isStop: Boolean? = (flags and 1 == 0)`。CHSesameBikeDevice.kt:296 = `mechStatus = CHSesameBotMechStatus(receivePayload.payload)` で Bike が Bot の mechStatus クラスを流用。Bike は isStop を when で上書きしないため flags bit0 由来が生きる (Bot とは異なる)。protocol.js:523 と一致。

### [BLE2-0041] session が model から mechStatus kind を選ぶ (ssmbot_1/bike_1/既定)
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession._onPacket (MECH_STATUS) / _handleLoginResponse`
- branch: ssmbot_1 | bike_1 | other
- assert: model==ssmbot_1→os2bot、bike_1→os2bike、その他→os2lock の kind が publish/login 両経路で一致して parseMechStatus へ渡る
- ref: packages/core/src/ble/os2/session.js:556-564; packages/core/src/ble/os2/session.js:690-695; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesameBotDevice.kt:333; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesameBikeDevice.kt:296; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:544
- kind: payload-fidelity
- status: planned
- note: 修正: 旧 SDK ref CHSesame2.kt:40 は isStop=null の出典であり kind 選択を支持しない (未確認: 行40は別意味)。置換 — model→mechStatus クラス(=kind)の対応を確立する一次出典に差し替え: Bot=CHSesameBotDevice.kt:333 (CHSesameBotMechStatus), Bike=CHSesameBikeDevice.kt:296 (CHSesameBotMechStatus), Sesame2/3/4=CHSesame2Device.kt:544 (CHSesame2MechStatus)。session.js:561-563(publish)/:692-694(login) で model→kind 分岐を確認。

### [BLE2-0042] mechStatus position/target は raw と度数(*Deg)を併記する
- surface: core
- backend: ble-os2
- command: `protocol.parseMechStatus (positionDeg/targetDeg)`
- branch: -
- assert: raw エンコーダ値を維持しつつ positionDeg/targetDeg = trunc(raw*360/1024) を併記し、SDK の (raw.toInt()*360/1024).toShort() と一致する (Int 除算は0方向切り捨て)
- ref: packages/core/src/ble/os2/protocol.js:536-537; packages/core/src/ble/os2/protocol.js:556-558; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesame2.kt:32-33
- kind: payload-fidelity
- status: planned
- note: 確認済: CHSesame2.kt:32 position=(bytesToShort(data[4],data[5]).toInt()*360/1024).toShort(); :33 target も同式。protocol.js:536 targetDeg/:537 positionDeg が os2RawToDeg を呼び、:556-558 os2RawToDeg= Math.trunc((raw*360)/1024)。Kotlin Int 除算の 0 方向切り捨てを Math.trunc で一致。raw(:534 target/:535 position)も併記。

### [BLE2-0043] mechStatus は自動履歴読み出しを行わない (意図的逸脱)
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession._onPacket (MECH_STATUS publish)`
- branch: retCode!=0 | target==MIN_VALUE
- assert: SDK は mechStatus publish で retCode!=0 / target==Short.MIN_VALUE のとき readHistoryCommand を自動発行するが、kit は自動履歴読み出しを実装せず history() 手動呼び出しに委ねる (意図的逸脱)
- ref: packages/core/src/ble/os2/session.js:556-575; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:543-549
- kind: contract-existence
- status: planned
- note: 意図的逸脱 (P3-26/R2:BLE2-17)。SDK の自動 POST は非移植。確認済: session.js:556-575 が MECH_STATUS publish ハンドラ全体 (逸脱コメントは 566-574)。SDK の readHistoryCommand 二分岐 (retCode!=0=545-547, target==MIN_VALUE=548-549) を 543-549 で精確に囲む

## os2-timesync

login/register 後の timePhone 時刻同期(秒値 LE 4B、register 無条件送信、Sesame2/3/4 の abs+fw ガード、Bot/Bike の signed timeError ガード)を機種別の送信条件に照らして固定する。

### [BLE2-0044] timePhone data は秒値の LE 4B (ms/1000)
- surface: core
- backend: ble-os2
- command: `protocol.timePhoneData`
- branch: -
- assert: timePhone data は currentTimeMillis を 1000 で割った秒値の下位32bit LE 4B (SDK toUInt32ByteArray=ms/1000 を LE)。ms をそのまま使わない
- ref: packages/core/src/ble/os2/protocol.js:683-685; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/utils/DataExtention.kt:138-147; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:263
- kind: payload-fidelity
- status: planned
- note: 確認済: kit :684 registrationTimestampBytes へ委譲 (ble/protocol.js:627-634 tmp=floor(ms)/1000n → LE 4B)。SDK DataExtention :140 tmp=this/1000 → :146 reversedArray (LE)。CHSesame2Device.kt:263 timePhone 送信

### [BLE2-0045] timePhone 送信条件: register 完了は無条件送信
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession._maybeSyncTime (register)`
- branch: route=register
- assert: 登録完了 login publish 時は機種・fw・時刻差に関わらず timePhone を無条件送信する (SDK CHSesame2Device.kt:511 / CHSesameBotDevice.kt:280)
- ref: packages/core/src/ble/os2/session.js:750-755; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:511; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesameBotDevice.kt:280
- kind: option-branch
- status: planned
- note: 確認済: session.js:751-755 が register 無条件送信。CHSesame2Device.kt:511 onGattSesamePublish の sendEncryptCommand(timePhone) (login.value 内、ガード無し)、CHSesameBotDevice.kt:280 同形を 1:1 で支持。

### [BLE2-0046] timePhone 送信条件: Sesame2/3/4 は abs(timeError)>3 かつ fw>=1
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession._maybeSyncTime (sesame2)`
- branch: abs>3-fw>=1 | fw<1-skip | within3
- assert: login-response 経路の Sesame2/3/4 は abs(nowSec-systemTime)>3 かつ fw_version>=1 のときのみ timePhone を送る (SDK CHSesame2Device.kt:261-264 の abs+fw ガード)
- ref: packages/core/src/ble/os2/session.js:771-780; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:261-264
- kind: option-branch
- status: planned
- note: 確認済: session.js:773-780 が abs(timeError)>3 → fw<1 skip → 送信。CHSesame2Device.kt:261 if(abs(timeError)>3) / 262 if(fw_version>=1) / 263 sendEncryptCommand(timePhone) と一致。

### [BLE2-0047] timePhone 送信条件: Bot/Bike は timeError>3 のみ (abs/fw ガード無し)
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession._maybeSyncTime (bot/bike)`
- branch: ssmbot_1/bike_1: timeError>3 | <=3
- assert: login-response 経路の Bot/Bike は nowSec-systemTime>3 (abs なし fw ガードなし、signed 減算) のみで timePhone を送る (SDK CHSesameBotDevice.kt:464 / CHSesameBikeDevice.kt:355)
- ref: packages/core/src/ble/os2/session.js:761-769; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesameBotDevice.kt:462-466; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesameBikeDevice.kt:352-357
- kind: option-branch
- status: planned
- note: 確認済: session.js:763-768 が model ssmbot_1/bike_1 で timeError>3 のみ (abs/fw 無し)。CHSesameBotDevice.kt:462 timeError=currentTimestamp.minus(systemTime) / 464 if(timeError>3) / 466 send。CHSesameBikeDevice.kt:352/355/357 同形を支持。

## os2-commands

OS2 デバイスコマンド(lock/unlock/click の async + createHistag、autolock/getAutolock/disableAutolock)のフレーム・payload 形を CHSesame2Device/CHDBModel に照らして固定する。

### [BLE2-0048] lock/unlock/click は OP.async + createHistag 22B 固定
- surface: core
- backend: ble-os2
- command: `SesameOS2Ble.lock/unlock/click`
- branch: lock | unlock | click
- assert: OS2 lock/unlock/click の OP.async + createHistag 22B 境界は lock.md(LOCK) が正典 — [[LOCK-0067]]/[[LOCK-0068]]/[[LOCK-0069]] を参照
- ref: local-contract
- kind: payload-fidelity
- status: waived: 重複（正典 [[LOCK-0067]]/[[LOCK-0068]]/[[LOCK-0069]]）
- note: lock 動詞 (lock/unlock/click) の BLE payload/itemCode/createHistag は lock.md(LOCK) が正典。本境界は LOCK-0067 (lock OP.ASYNC item=82)/LOCK-0068 (unlock item=83)/LOCK-0069 (click item=89) と完全重複のため waive。ble-os2.md は OS2 session/protocol 汎用面のみを保持する。

### [BLE2-0049] createHistag は tag を 21B に切り詰め常に 22B (tag null は全 0)
- surface: core
- backend: local
- command: `protocol.createHistag`
- branch: tag | null-tag | over-21B
- assert: OS2 createHistag の [size:1B]++take(21)++0埋め=22B (tag null は全 0) / 非 byte 入力 reject は lock.md(LOCK) が正典 — [[LOCK-0070]]/[[LOCK-0071]] を参照
- ref: local-contract
- kind: payload-fidelity
- status: waived: 重複（正典 [[LOCK-0070]]/[[LOCK-0071]]）
- note: createHistag は lock 動詞の history-tag builder で lock.md(LOCK) が正典。22B レイアウトは LOCK-0070、非 byte 入力 reject は LOCK-0071 と完全重複 (assert/ref 同一) のため waive。

### [BLE2-0050] autolock data = 2B LE 秒数 ++ createHistag(tag) = 24B (0=無効)
- surface: core
- backend: ble-os2
- command: `SesameOS2Ble.autolock/disableAutolock / protocol.autolockData`
- branch: enable | disable(0) | out-of-range
- assert: OS2 autolock(11) OP.update 2B LE 秒数 ++ createHistag=24B / disableAutolock=autolock(0) / 範囲外 throw は lock.md(LOCK) が正典 — [[LOCK-0073]]/[[LOCK-0074]]/[[LOCK-0075]] を参照
- ref: local-contract
- kind: payload-fidelity
- status: waived: 重複（正典 [[LOCK-0073]]/[[LOCK-0074]]/[[LOCK-0075]]）
- note: autolock は lock 動詞で lock.md(LOCK) が正典。24B payload は LOCK-0073、範囲/非整数 reject は LOCK-0074、disableAutolock=autolock(0) は LOCK-0075 と完全重複 (3 分岐すべて) のため waive。

### [BLE2-0051] getAutolock は応答 payload を LE で整数化
- surface: core
- backend: ble-os2
- command: `SesameOS2Ble.getAutolock`
- branch: <=6B | >6B-zero-high | >6B-nonzero-high
- assert: OS2 getAutolock (OP.READ item=11) 応答 payload の LE 整数化 (reversedArray hex parse 等価) は lock.md(LOCK) が正典 — [[LOCK-0076]] を参照
- ref: local-contract
- kind: payload-fidelity
- status: waived: 重複（正典 [[LOCK-0076]]）
- note: autolock の read/update は lock.md(LOCK) の OS2 autolock 節に集約。getAutolock LE デコードは LOCK-0076 と完全重複 (assert/ref 実質同一) のため waive。

## os2-session

OS2 セッションのライフサイクル(未 login reject と resultCode 封筒、fire-and-forget write、切断時の pending fail-fast、transport.connect 失敗の孤児 Promise 抑制、セッション使い捨て、login publish 完了経路)を固定する。

### [BLE2-0052] request は未 login で reject、resultCode!=0 は BleResultError
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession.request / _resolvePending`
- branch: not-logged-in | resultCode=0 | resultCode!=0
- assert: request は _loggedIn 偽で即 reject。応答 resultCode==0 は {resultCode,payload} で resolve、!=0 は BleResultError(resultName) で reject する (SDK 同様 0 以外を失敗扱い)
- ref: packages/core/src/ble/os2/session.js:443-456; packages/core/src/ble/os2/session.js:795-806
- kind: error-path
- status: planned

### [BLE2-0053] write reject は fail-fast せず disconnect 通知経路で握りつぶす
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession._writeSeg / _sendPlain / _sendCipher`
- branch: write-throws | write-rejects-promise
- assert: transport.write の同期 throw / Promise reject は _writeSeg が握りつぶし unhandledRejection を出さず、pending は応答 timeout か onDisconnect で表面化する (fire-and-forget, OS3 と等価)
- ref: packages/core/src/ble/os2/session.js:488-508
- kind: error-path
- status: planned

### [BLE2-0054] transport 切断で pending/待機者を全て fail-fast
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession._handleTransportDisconnect / _failAllPending`
- branch: link-lost | active-disconnect
- assert: リンク断 (onDisconnect) で pending request と login/ready/register 待機者を即 reject + timer clear しフラグを倒す。能動 disconnect() は transport.disconnect も呼ぶ (timeout 宙づり防止)
- ref: packages/core/src/ble/os2/session.js:390-431
- kind: error-path
- status: planned

### [BLE2-0055] connect()/register() の transport.connect 失敗で孤児 Promise を抑制
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession.connect / register (P1-1)`
- branch: transport-connect-fail
- assert: _connectTransport() 失敗時に loginWaiter/readyWaiter を即 clear し孤児 loginPromise/readyPromise に no-op catch を付け unhandledRejection を出さずに throw する
- ref: packages/core/src/ble/os2/session.js:200-210; packages/core/src/ble/os2/session.js:267-277
- kind: error-path
- status: planned

### [BLE2-0056] セッション再利用 (busy) は明示 reject (使い捨て)
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession.connect/register (_isBusy)`
- branch: already-logged-in | waiter-pending
- assert: loggedIn/readyToRegister または待機者がある状態で connect()/register() を再呼び出しすると reject する (新インスタンス構築を要求。SDK register の BUSY ガードに対応)
- ref: packages/core/src/ble/os2/session.js:159-162; packages/core/src/ble/os2/session.js:191; packages/core/src/ble/os2/session.js:255; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:407-409
- kind: error-path
- status: planned

### [BLE2-0057] login response は publish 経路でも完了できる (register-publish 主・login-publish は kit 防御拡張)
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession._handleLoginPublish`
- branch: register-publish | login-publish | login-response
- assert: login publish 受信時、registerWaiter があれば登録完了として resolve する (SDK の Bot/Bike は登録完了を login publish で通知: onGattSesamePublish cmdItCode==login)。registerWaiter が無く loginWaiter がある場合も login 完了として resolve する
- ref: packages/core/src/ble/os2/session.js:702-726; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesameBotDevice.kt:270-305
- kind: option-branch
- status: planned
- note: 未確認: SDK の通常 login 応答 (Bot login:455-457 / Bike login:347) は sendEncrypt/PlainCommand の response 経路 (cmdItCode==login && resultCode==success) で来る。onGattSesamePublish の login 分岐 (Bot:273-305) は登録完了通知のみで、login-publish 分岐は kit 独自の防御実装 (session.js:721-725)。assert を register-publish 主体に補正

## os2-facade

SesameOS2Ble ファサード(transport 必須・login 鍵素材ガード、connect 失敗時の disconnect 再 throw、status の cache/publish 待ち)を固定する。

### [BLE2-0058] SesameOS2Ble は transport 必須・login 鍵素材ガード
- surface: core
- backend: ble-os2
- command: `SesameOS2Ble constructor`
- branch: no-transport | login-no-secretKey | register-mode
- assert: transport 未指定は throw。registerMode/secretKey/needAuthFromServer のいずれも無い login は secretKey 必須エラー。registerMode 時は secretKey を session へ渡さない
- ref: packages/core/src/ble/os2/index.js:66-95
- kind: error-path
- status: planned

### [BLE2-0059] connect() 失敗時はセッションを disconnect してから再 throw
- surface: core
- backend: ble-os2
- command: `SesameOS2Ble.connect`
- branch: needAuthFromServer | normal
- assert: connect() は失敗時に session.disconnect().catch を呼んでから throw し、リーク無しで再接続可能にする。needAuthFromServer は signLogin コールバック必須
- ref: packages/core/src/ble/os2/index.js:116-129
- kind: error-path
- status: planned
- note: 確認済: connect() は try/catch で session.connect() を包み、catch で await this._session.disconnect().catch(()=>{}) の後 throw err (os2/index.js:124-127)。needAuthFromServer 時の signLogin 必須 throw は :119。

### [BLE2-0060] status() は lastStatus 即返し、無ければ publish 待ち (timeout)
- surface: core
- backend: ble-os2
- command: `SesameOS2Ble.status`
- branch: cached | wait-publish | timeout
- assert: status() は lastStatus があれば即 resolve、無ければ onStatus 購読で mechStatus publish を待ち STATUS_WAIT_MS で reject する
- ref: packages/core/src/ble/os2/index.js:36; packages/core/src/ble/os2/index.js:240-246
- kind: contract-existence
- status: planned
- note: 確認済: lastStatus あれば Promise.resolve 即返し (:241)、無ければ onStatus 購読+setTimeout で reject('could not receive mechStatus (timeout)') (:242-245)。STATUS_WAIT_MS=4000 の定義位置 :36 を ref に追加。

## os2-cli

CLI ble os2-invoke/os2-register(allowlist 照合・fail-closed、keyIndex/ssmPublicKey 解決順、registerOnce 出力)と文言の i18n 完全性を固定する。

### [BLE2-0061] CLI ble os2-invoke は op を OS2 allowlist 照合で実行
- surface: cli
- backend: ble-os2
- command: `sesame ble os2-invoke <device> <op> [--args]`
- branch: allowed-op | denied-op | needSsmPublicKey
- assert: os2-invoke は invokePath(dev, op, args, OS2_BLE_RPC_ALLOWLIST) でドット op を実行し、非掲載 op は fail-closed。ssmPublicKey が config/フラグに無ければ needSsmPublicKey で die
- ref: packages/kit/src/cli/ble.js:208-221; packages/kit/src/cli/ble.js:539-571; packages/core/src/ble/index.js:161-172; packages/core/src/ble/rpc-helpers.js:62-75
- kind: surface-parity
- status: planned
- note: 確認済: cmdOS2Invoke は ssmPublicKey 欠如時 ble.cli.os2Invoke.needSsmPublicKey で die(2) (:546-549)、invokePath(dev, op, args, OS2_BLE_RPC_ALLOWLIST) (:566)。OS2_BLE_RPC_ALLOWLIST 定義 index.js:161-172。fail-closed 本体(非掲載第1セグメント拒否)は invokePath 実体 rpc-helpers.js:62-75 のため ref 追加。末尾行 572 は閉じ括弧のみのため 571 に修正。

### [BLE2-0062] CLI os2-invoke の keyIndex/ssmPublicKey 解決順 (フラグ>config)
- surface: cli
- backend: ble-os2
- command: `sesame ble os2-invoke (--key-index / --ssm-public-key)`
- branch: flag | config | default-0000
- assert: resolveBleEntry が ssmPublicKey/keyIndex を 明示フラグ>config 保存値 の優先で解決し、keyIndex 省略時は session 既定 "0000" に倒れる (userIdx 解決)
- ref: packages/kit/src/cli/ble.js:215-218; packages/kit/src/cli/ble.js:795-797; packages/kit/src/cli/ble.js:561-562; packages/core/src/ble/os2/session.js:99-103
- kind: surface-parity
- status: planned
- note: 未確認→修正: 元 ref 543-566 は cmdOS2Invoke で resolveBleEntry を呼ぶだけで優先順位本体を含まない。明示フラグ>config の解決は resolveBleEntry の :796(ssmPublicKey = options.ssmPublicKey||rec?.ssmPublicKey||null)/:797(keyIndex 同形)。フラグ宣言は :215-218(--secret/--model/--key-index/--ssm-public-key)に絞り込み。keyIndex 省略→既定 '0000' は cmdOS2Invoke の keyIndex: entry.keyIndex ?? undefined (:561-562) → session.js:99-103 (keyIndex==null で Buffer.from('0000','hex'))。'0000' 永続値の出典は CHSesame2Device.kt:462-469 (確認済)。

### [BLE2-0063] CLI ble os2-register は registerOnce で鍵素材を出力
- surface: cli
- backend: ble-os2
- command: `sesame ble os2-register <deviceUUID>`
- branch: localServerAuth-default | --no-local-server-auth | --ak
- assert: os2-register は SesameOS2Ble.registerOnce を localServerAuth 既定 true で呼び、secretKey/ownerKey/sesamePublicKey と保存ヒントを出力する (--no-local-server-auth / --ak で経路変更)
- ref: packages/kit/src/cli/ble.js:145-154; packages/kit/src/cli/ble.js:316-347
- kind: surface-parity
- status: planned
- note: 確認済: command 定義は :145-154 (.command 行 :146、--no-local-server-auth :153、--ak :152、.action :154) のため起点を 145 に微修正。cmdOS2Register は registerOnce({localServerAuth: options.localServerAuth !== false, ak:...}) (:331,:333) を呼び secretKey/ownerKey/sesamePublicKey + saveHint を出力 (:337-345)。

### [BLE2-0064] CLI os2-invoke/os2-register の文言は i18n キー (en/ja)
- surface: cli
- backend: ble-os2
- command: `sesame ble os2-invoke / os2-register (i18n)`
- branch: en | ja
- assert: os2Invoke/os2Register の desc・needSsmPublicKey・done・saveHint・opt 文言が t() キーで en/ja の双方に存在し欠落しない
- ref: packages/kit/src/cli/ble.js:146-154; packages/kit/src/cli/ble.js:212-221; packages/kit/src/cli/ble.js:335-346
- kind: i18n
- status: planned
- note: 確認済: cli/ble.js で os2-register desc/opts=L147-153、os2-invoke desc/opts=L213-220、os2Register.done=L336/saveHint=L341。全キーが core/src/i18n/ble.js に en (os2Register.desc/opt.ak/opt.noLocalServerAuth/done/saveHint=L114-118、os2Invoke.desc/opt.keyIndex/opt.ssmPublicKey/needSsmPublicKey=L149-152) と ja (L287-291, L322-325) 双方に存在。欠落なし

## os2-serve

serve RPC エントリ(ble.os2.invoke/ble.os2.register の必須パラメータ・allowlist・registerOnce 委譲)と OS2 公開 op 集合・allowlist 整合を固定する。

### [BLE2-0065] serve ble.os2.invoke は secretKey/keyIndex/ssmPublicKey 必須 + allowlist
- surface: serve
- backend: ble-os2
- command: `ble.os2.invoke`
- branch: missing-required | allowed-op | denied-op
- assert: ble.os2.invoke RPC は op/secretKey/keyIndex/ssmPublicKey を need() で必須にし、invokePath を OS2_BLE_RPC_ALLOWLIST で照合する (CLI os2-invoke と対称、fail-closed)
- ref: packages/kit/src/serve/entries/ble.js:299-333; packages/core/src/ble/index.js:161-172; packages/core/src/ble/rpc-helpers.js:62-75
- kind: surface-parity
- status: planned
- note: 確認済: params で op/secretKey/keyIndex/ssmPublicKey required:true (:302,:306-308)、need(params,['op','secretKey','keyIndex','ssmPublicKey']) (:315)、invokePath(ble, params.op, params.args, OS2_BLE_RPC_ALLOWLIST) (:331)。fail-closed 本体は rpc-helpers.js:62-75 のため ref 追加。

### [BLE2-0066] serve ble.os2.register は deviceUUID 必須・registerOnce 委譲
- surface: serve
- backend: ble-os2
- command: `ble.os2.register`
- branch: deviceUUID | productType-default | localServerAuth | ak
- assert: ble.os2.register は deviceUUID 必須、productType 既定=model、localServerAuth 既定 true、ak は reviveJsonArg で revive して registerOnce へ委譲する (CLI os2-register と対称)
- ref: packages/kit/src/serve/entries/ble.js:334-365
- kind: surface-parity
- status: planned
- note: 確認済: deviceUUID required:true (:337) + need(params,['deviceUUID']) (:348)、productType: params.productType ?? params.model ?? undefined (:359)、localServerAuth: params.localServerAuth !== false (:360)、ak: reviveJsonArg(params.ak) (:362)、registerOnce へ委譲 (:355)。

### [BLE2-0067] OS2 RPC 公開面 (OS2_BLE_RPC_OPS) の op 集合と型付きスキーマ
- surface: serve, sdk
- backend: ble-os2
- command: `OS2_BLE_RPC_OPS (autolock/disableAutolock/getAutolock/history/versionTag/updateSetting/reset/configureLockPosition)`
- branch: -
- assert: OS2_TOPLEVEL_RPC_OPS が autolock/disableAutolock/getAutolock/history/versionTag/updateSetting/reset/configureLockPosition の params 順序・result(ack/raw) を SDK メソッド引数と一致させ、status は typed spec 保留で非掲載とする
- ref: packages/core/src/ble/index.js:230-291
- kind: surface-parity
- status: planned
- note: 確認済: OS2_TOPLEVEL_RPC_OPS は L230 定義、8 op (autolock L233/disableAutolock L239/getAutolock L242/history L246/versionTag L249/updateSetting L253/reset L260/configureLockPosition L265) すべて存在し params 順序・result(ack/raw) は各 JSDoc の CHSesame2Device.kt 行注記と一致。export OS2_BLE_RPC_OPS=L291。範囲 230-291 妥当

### [BLE2-0068] OS2 allowlist と TOPLEVEL_OPS の整合 (status は allowlist のみ)
- surface: serve, core
- backend: ble-os2
- command: `OS2_BLE_RPC_ALLOWLIST vs OS2_TOPLEVEL_RPC_OPS`
- branch: status-allowlisted-not-typed
- assert: status/lastStatus/loginInfo/isConnected/model/lock/unlock/click/toggle は OS2_BLE_RPC_ALLOWLIST に載るが OS2_TOPLEVEL_RPC_OPS には載せない (status は raw op として os2-invoke 経由でのみアクセス、OS3 と同方針)
- ref: packages/core/src/ble/index.js:161-172; packages/core/src/ble/index.js:219-227
- kind: surface-parity
- status: planned
- note: 確認済: ALLOWLIST L161-172 に lock/unlock/click/toggle(L163)・status/lastStatus/loginInfo/isConnected/model(L167) 掲載。status 除外方針 JSDoc は L219-227 (P4-5/R2:SURF-31、OS3 と同方針を L227 で明記)。OS2_TOPLEVEL_RPC_OPS(L230-269) に status/lock 等は不在。整合

## os2-sdk

生成 SDK(ts/py)への ble.os2.invoke/ble.os2.register 型付き露出を固定する。

### [BLE2-0069] SDK 生成クライアントに ble.os2.invoke/ble.os2.register が露出
- surface: sdk
- backend: ble-os2
- command: `sdk: ble.os2.invoke / ble.os2.register`
- branch: ts | py
- assert: serve registry の ble.os2.invoke/ble.os2.register が ts/py 生成 SDK に型付きで露出し、params (op/secretKey/keyIndex/ssmPublicKey/deviceUUID...) のスキーマが serve エントリと一致する
- ref: packages/kit/src/serve/entries/ble.js:299-365
- kind: contract-existence
- status: planned
- note: 確認済: ble.os2.invoke=L299 (params op/args/deviceUUID/address/secretKey/keyIndex/ssmPublicKey/model/scanTimeoutMs/debug, L302-311)、ble.os2.register=L334 (deviceUUID/address/model/productType/scanTimeoutMs/debug/localServerAuth/ak, L337-344)。bleEntries() は registry.js が集約し OpenRPC/proto/SDK へ展開。assert の params 集合は両エントリの和で実在と一致

## os2-i18n

OS2 セッションの切断/リンク断メッセージが OS3 と共有の i18n キーで en/ja 解決されることを固定する。

### [BLE2-0070] OS2 切断/リンク断メッセージは i18n キー経由
- surface: core
- backend: ble-os2
- command: `SesameOS2BleSession (t('ble.linkLost') / t('ble.disconnected'))`
- branch: linkLost | disconnected
- assert: リンク断は t('ble.linkLost')、能動 disconnect は t('ble.disconnected') を reject 理由に使い、OS3 session と同じ i18n キーを共有する (en/ja で解決)
- ref: packages/core/src/ble/os2/session.js:422-431
- kind: i18n
- status: planned
- note: 確認済: _handleTransportDisconnect は _failAllPending(new Error(t('ble.linkLost'))) L424、disconnect() は _failAllPending(new Error(t('ble.disconnected'))) L429。両キーは i18n/ble.js に en (L43 disconnected/L44 linkLost) と ja (L216 disconnected/L217 linkLost) 双方存在。OS3 共有キーで解決可

## 監査追補 v2 (dual-audit)

dual-audit consensus/onlyB の missing-* で回復した境界 (作成時 API 障害で取りこぼした OS2 method の wire/payload 境界)。lock 動詞は lock.md(LOCK) が正典のため本節は OS2 固有の非 lock 境界のみ。

### [BLE2-0071] versionTag() 応答 payload[4:16] 12B latin1 スライス境界
- surface: core
- backend: ble-os2
- command: `SesameOS2Ble.versionTag`
- branch: -
- assert: versionTag() は OP.READ item=VERSION_TAG(5) を空 data で送り、応答 payload の subarray(4,16)(12B) を latin1/ASCII 文字列として返す (SDK getVersionTag: SSM2OpCode.read, versionTag, String(res.payload.sliceArray(4..15)) と一致)
- ref: packages/core/src/ble/os2/index.js:230-233; packages/core/src/itemcodes.js:16; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:129-134
- kind: payload-fidelity
- status: planned
- note: VERSION_TAG=5 (itemcodes.js:16) は BLE2-0019 に列挙済みだが、メソッド応答の payload[4:16] スライス境界 (12B) は未被覆。SDK CHSesame2Device.kt:131 SSM2Payload(read, versionTag, byteArrayOf()) / :132 String(res.payload.sliceArray(4..15)) と 1:1。OS3 getVersionTag は ble-os3.md の別境界 (item/op/スライス独立) で重複起票ではない。

### [BLE2-0072] updateFirmware()/enableDfuData (OP.UPDATE item=ENABLE_DFU(7) data='01' 1B 暗号経路)
- surface: core
- backend: ble-os2
- command: `SesameOS2Ble.updateFirmware / protocol.enableDfuData`
- branch: registered(encrypted) | factory(plain, facade-out-of-scope)
- assert: updateFirmware() は OP.UPDATE item=ENABLE_DFU(7) に enableDfuData()=[0x01](1B) を暗号化経路で送る (SDK updateFirmware isRegistered=true 経路: SSM2OpCode.update, enableDFU, '01'.hexStringToByteArray() を sendEncryptCommand、CHSesame2Device.kt:584)。開始コマンド送信のみで本体 OTA 転送は対象外
- ref: packages/core/src/ble/os2/index.js:319-321; packages/core/src/ble/os2/protocol.js:413-415; packages/core/src/itemcodes.js:18; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:580-595
- kind: payload-fidelity
- status: planned
- note: ENABLE_DFU=7 (itemcodes.js:18) は BLE2-0019 に列挙済みだが updateFirmware/enableDFU の送信 payload は未被覆。kit は SDK の isRegistered=true (login 済み) 暗号経路のみ移植 (index.js:312-313 JSDoc が未登録 plain 経路 :592 を対象外と明記)。lock.md/auth.md/crypto.md に DFU 概念なし。

### [BLE2-0073] updateFirmware は allowlist 掲載だが TOPLEVEL_RPC_OPS 非掲載 (allowlist-only)
- surface: serve, core, cli
- backend: ble-os2
- command: `OS2_BLE_RPC_ALLOWLIST vs OS2_TOPLEVEL_RPC_OPS (updateFirmware)`
- branch: allowlist-reachable | not-in-toplevel-rpc-ops
- assert: updateFirmware は OS2_BLE_RPC_ALLOWLIST に載るが (ble.os2.invoke / CLI os2-invoke 経由で到達可)、OS2_TOPLEVEL_RPC_OPS には typed spec 保留で載せない (status と同方針、raw op としてのみアクセス可)。BLE2-0068 の allowlist-only 集合を updateFirmware で補完する
- ref: packages/core/src/ble/index.js:161-172; packages/core/src/ble/index.js:230-269; packages/kit/src/serve/entries/ble.js:299-333
- kind: surface-parity
- status: planned
- note: BLE2-0068 の同方針 (status 等は allowlist のみで typed 非掲載) に updateFirmware が漏れていた補完。OS2_BLE_RPC_ALLOWLIST(index.js:171) に updateFirmware 掲載、OS2_TOPLEVEL_RPC_OPS(index.js:230-269) は 8 op のみで updateFirmware 不在。relatedSpecId=[[BLE2-0068]]。serve/entries/ble.js の ble.updateFirmware は OS3 用で OS2 専用 serve entry は無い。

### [BLE2-0074] configureLockPosition の 12B payload (tick=deg*1024/360, ±150 range Short wrap) ++ createHistag(null)=34B
- surface: core
- backend: ble-os2
- command: `SesameOS2Ble.configureLockPosition / protocol.lockPositionConfiguration / protocol.lockPositionData`
- branch: tick-convert | plus-minus-150-range | Short-wrap
- assert: configureLockPosition(lockDeg,unlockDeg) は OP.UPDATE item=mechSetting(80) に lockPositionConfiguration を送る: tick=toShort(trunc(deg*1024/360))、range=±150 (16bit wrap) で lock++unlock++lockMin++lockMax++unlockMin++unlockMax の 6×LE Short(2B)=12B を組み、createHistag(null)(22B) を連結し 34B にする (SDK CHSesameLockPositionConfiguration.toPayload、range=150 と一致)
- ref: packages/core/src/ble/os2/protocol.js:314-347; packages/core/src/ble/os2/index.js:292-294; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:556-558; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:635-645
- kind: payload-fidelity
- status: planned
- note: configureLockPosition は intro 行 5 で in-scope。BLE2-0048/0049 は lock/unlock/click の createHistag 22B、BLE2-0050 は autolock 24B を扱うが 12B tick/range レイアウトは未被覆。lock.md(LOCK) は lock/unlock/toggle/click/autolock 動詞のみ正典で configureLockPosition はスコープ外。OS3 BLE3-0051 は data=4B (lockTarget LE2B++unlockTarget LE2B) で別レイアウト=重複起票ではない。

### [BLE2-0075] updateSetting (Bot1) botMechSettingData 12B (7×signed Byte ++ 5B 予約0) ++ createHistag(tag)=34B
- surface: core
- backend: ble-os2
- command: `SesameOS2Ble.updateSetting / protocol.botMechSettingData / protocol.botUpdateSettingData`
- branch: Bot1-only | 7-signed-bytes ++ 5B-reserved-0 | tag
- assert: updateSetting(setting,tag) (Bot1 専用) は OP.UPDATE item=mechSetting(80) に botMechSettingData=[userPrefDir,lockSec,unlockSec,clickLockSec,clickHoldSec,clickUnlockSec,buttonMode] の 7×符号付き 1B ++ 5B 予約 0 = 12B を組み、createHistag(tag)(22B) を連結し 34B にする (SDK CHSesameBotMechSettings.data() + createHistag、CHSesameBotDevice.kt:418-422 と一致)
- ref: packages/core/src/ble/os2/protocol.js:368-393; packages/core/src/ble/os2/index.js:305-307; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesameBotDevice.kt:418-422; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/open/devices/CHSesameBot.kt:17
- kind: payload-fidelity
- status: planned
- note: BLE2-0034 (parseMechSettingBot) は login-response の READ/decode 側境界、本件は updateSetting の WRITE/encode 側 (botMechSettingData の 12B レイアウト+5B 予約) で別境界。Bot1 専用。relatedSpecId=[[BLE2-0034]]。

### [BLE2-0076] reset() の wire 境界 (OP.DELETE item=registration(1) 空 data / 成功時 disconnect=dropKey 相当)
- surface: core
- backend: ble-os2
- command: `SesameOS2Ble.reset`
- branch: success(resultCode=0) -> disconnect | fail -> no-disconnect
- assert: reset() は OP.DELETE item=REGISTRATION(1) を空 data で送り、resultCode==0 のとき session.disconnect() を呼ぶ (dropKey 相当)。非 0 は disconnect せず res を返す (SDK reset: SSM2OpCode.delete, registration, byteArrayOf()、success→dropKey、CHSesame2Device.kt:570-578 と一致)
- ref: packages/core/src/ble/os2/index.js:275-282; packages/core/src/itemcodes.js:12; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:570-578
- kind: payload-fidelity
- status: planned
- note: REGISTRATION=1 (itemcodes.js:12)。reset は BLE2-0067 の RPC op 列挙にあるのみで wire 境界 (delete/registration/空 payload + 成功時 disconnect) は未被覆。kit は永続鍵ストアを持たないため dropKey 相当=disconnect (index.js:271-273 JSDoc)。OS3 対称エントリは ble-os3.md (RESET_WM2+dropKey)。lock.md スコープ外。【人間裁定要: OS3 対称 ID は BLE3-0064 (item=Reset(104)) と BLE3-0093 (RESET_WM2+dropKey) のどちらか — OS2 wire 境界 (delete/registration=1, success→disconnect) 自体は両 OS3 とも一致するが cross-ref の OS3 ID 食い違いは未裁定。】

### [BLE2-0077] history() 手動読み出し payload (item=history(4) / ack byte 0x01|0x00)
- surface: core
- backend: ble-os2
- command: `SesameOS2Ble.history`
- branch: ack=true(0x01) | ack=false(0x00)
- assert: history({ack=true}) は OP.READ item=history(4) に 1B [ack?0x01:0x00] を送り raw payload を返す。ack 既定 true (読み出し後デバイス側削除)。SDK readHistoryCommand は isInternetAvailable() で 0x01/0x00 を切替 (CHSesame2Device.kt:606-612)
- ref: packages/core/src/ble/os2/index.js:262-265; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:602-612
- kind: payload-fidelity
- status: planned
- note: history itemcode=4 は BLE2-0019 に列挙済み、BLE2-0043 は自動履歴読み出しの意図的非実装 (逸脱) を扱うが、手動 history() 送信境界 (ack byte 0x01/0x00 payload) は未被覆。kit は SDK の isInternetAvailable() 分岐を ack フラグで明示化。relatedSpecId=[[BLE2-0043]]。

### [BLE2-0078] local CMAC login の sessionAuth 組み立て + loginPayload byte レイアウト
- surface: core
- backend: ble-os2
- command: `protocol.sessionAuth (computeSessionAuth) / protocol.loginPayload`
- branch: local-auth(secretKey) | server-auth(see BLE2-0003)
- assert: ローカル認証 login (isNeedAuthFromServer=false) は sessionAuth=AES-128-CMAC(secretKey, userIdx++appPubKey64++sessionToken8) を計算し、loginPayload=userIdx++appPubKey64++mAppToken4++sessionAuth[0:4] を組む (SDK CHSesame2Device.kt:238-243 sessionAuth + :252 loginPayload と一致)
- ref: packages/core/src/ble/os2/protocol.js:116-127; packages/core/src/ble/os2/protocol.js:141-150; packages/core/src/ble/os2/session.js:650-651; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:238-243; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/ble/os2/CHSesame2Device.kt:252
- kind: payload-fidelity
- status: planned
- note: session.js:650-651 (非 signLogin = local-auth、既定/共通経路) が computeSessionAuth→_sendLogin。BLE2-0003 はサーバ署名経路 (local CMAC 非呼び出し)、BLE2-0004 は >=4B reject のみを扱い、local-auth の signPayload 組み立てと loginPayload 4 分割 byte レイアウトは未被覆。CMAC プリミティブ KAT は crypto.md(CRY) [[CRY-0001]] が正典で、本件は OS2 固有の wire 組み立て (ble-os2.md canon)。relatedSpecId=[[BLE2-0003]]。

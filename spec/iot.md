<!-- spec-domain: iot | prefix: IOT | tests: packages/core/tests/iot, packages/kit/tests/cli, packages/kit/tests/serve -->

# IoT/Hub3 操作 spec (IOT)

iot.* (sendIotCmd/await・Hub3 LED/relay・sesame 追加削除・firmware・wifi ssid 消去・Matter) を biz3 web (useIotCtrl/useOperateIoT) に照らして監査する。

## sendIotCmd フレーム

クラウドへ出す `biz3OperateIoT` フレームの封筒形・op 既定/上書き・必須検証を biz3 web (useOperateIoT.sendCmd / useIotCtrl) に照らして固定する。

### [IOT-0001] sendIotCmd 送信フレーム封筒 {action:'biz3OperateIoT', topic, payload, op}
- surface: core
- backend: cloud
- command: `iot.sendIotCmd`
- branch: op-default-'cmd' | op-override
- assert: client.send へ渡すフレームのキー集合が {action:'biz3OperateIoT', topic, payload, op} で、op 省略時は既定 'cmd'・明示指定時はその値が乗る。companyID/apiKeyId/connectionId を付けない (connectionId はクラウド自動付与)
- ref: references_web/src/hooks/useOperateIoT.js:54-61; references_web/src/api/useIotCtrl.js:129-132; packages/core/src/iot.js:44; packages/core/src/iot.js:195-199; packages/core/src/vendor/biz3/constants/messageConstants.js:15
- kind: wire-fidelity
- status: planned
- note: action は ACTION_TYPES.BIZ3_OPERATE_IOT='biz3OperateIoT' (messageConstants.js:15)。vendor sendCmd={action, ...cmd}・connectionId クラウド自動付与 (useIotCtrl.js:129-132)。op 既定/上書きは iot.js:195-199。

### [IOT-0002] sendIotCmd 必須検証 (topic/payload 欠落で badRequest)
- surface: core
- backend: local
- command: `iot.sendIotCmd`
- branch: no-topic | no-payload
- assert: topic 欠落で iot.err.topicRequired、payload 欠落で iot.err.payloadRequiredBase64 の badRequest を投げ送信しない (vendor は検証なしだが鍵/宛先取り違え防止の安全側逸脱)
- ref: packages/core/src/iot.js:196-197; packages/core/src/i18n/iot.js:90-91
- kind: error-path
- status: planned

## buildIotTopic

topic 文字列 `wm2{末尾セグメント大文字}cmd` の生成規則を App 正準 (CHAPIClientBiz.updateRelay) に照らして固定する。vendor web は uppercase しないが App 方式 (絶対準拠) を採る。

### [IOT-0003] buildIotTopic = wm2{末尾セグメント大文字}cmd
- surface: core
- backend: cloud
- command: `iot.buildIotTopic`
- branch: hub3Id-given | hub3-omitted-deviceId-fallback
- assert: topic は `wm2${hub3_id.split('-').pop()}cmd` (末尾セグメント=UUID末尾12hex)。vendor sendCommandToHub3WithConnectionId と一致しつつ末尾セグメントを toUpperCase する (App substringAfterLast('-').uppercase() が正準)
- ref: references_web/src/api/useIotCtrl.js:112-116; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClientBiz.kt:230-235; packages/core/src/iot.js:141-146
- kind: wire-fidelity
- status: planned
- note: P3-4: vendor web (useIotCtrl.js:115-116) は無変換だが App(正準)は uppercase (CHAPIClientBiz.kt:235)。uppercase 正規化の境界は IOT-0004 で別途検証。

### [IOT-0004] buildIotTopic 末尾セグメント uppercase 正規化 (App方式への意図的逸脱)
- surface: core
- backend: cloud
- command: `iot.buildIotTopic`
- branch: lower-input | upper-input | mixed
- assert: 小文字/混在入力でも末尾セグメントが toUpperCase されてから topic に埋まる。App CHAPIClientBiz.kt:235 `wm2${...uppercase()}cmd` が正準ワイヤ形で vendor web (無変換) からの意図的逸脱
- ref: packages/core/src/iot.js:143-145; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClientBiz.kt:230-235; references_web/src/api/useIotCtrl.js:112-116
- kind: wire-fidelity
- status: planned
- note: ローカル DB は鍵 lowercase 保存 (CHDeviceManager.kt:130-133 deviceUUID.lowercase()) のため送信時 uppercase が境界。

### [IOT-0005] buildIotTopic は hub3Id 必須 (空は badRequest)
- surface: core
- backend: local
- command: `iot.buildIotTopic`
- branch: empty | undefined
- assert: hub3Id 未指定で iot.err.hub3IdRequiredTopic を投げる (vendor useIotCtrl.js:112-114 は hub3_id=device_id 代入で fallback するが本体は topic 構築時に明示必須とする local-contract)
- ref: packages/core/src/iot.js:142; references_web/src/api/useIotCtrl.js:112-114; packages/core/src/i18n/iot.js:86
- kind: error-path
- status: planned
- note: i18n キー iot.err.hub3IdRequiredTopic は i18n/iot.js:86(en)/186(ja) に実在。

## buildIotPayload

payload バイト列 sign(4B)++cmd(1B)++device_id(UTF8)++extra の連結順・各部の生成規則を vendor useIotCtrl + App CHAPIClientBiz に照らして固定する。

### [IOT-0006] buildIotPayload 連結順 sign(4B)++cmd(1B)++deviceId(UTF8)(++extra)
- surface: core
- backend: cloud
- command: `iot.buildIotPayload`
- branch: no-extra | with-extra
- assert: payloadArray = signArray(4B) ++ cmdArray(1B) ++ didArray(UTF8) ++ extra を base64 化したものが vendor の offset 手動連結 (useIotCtrl.js:142-151,222) と一致。App updateRelay (CHAPIClientBiz.kt:221-229) も同連結順
- ref: references_web/src/api/useIotCtrl.js:142-151; references_web/src/api/useIotCtrl.js:222; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClientBiz.kt:221-229; packages/core/src/iot.js:160-181
- kind: wire-fidelity
- status: planned

### [IOT-0007] buildIotPayload device_id は UTF8 36バイト (hex デコードしない)
- surface: core
- backend: cloud
- command: `iot.buildIotPayload`
- branch: -
- assert: deviceId をハイフン込み36文字 UUID として TextEncoder で UTF8 化し36バイトで入れる (hex デコードや短縮をしない)。payload 全長は 4+1+36(+extra)。App も toByteArray(Charsets.UTF_8) (CHAPIClientBiz.kt:217)
- ref: references_web/src/api/useIotCtrl.js:127; references_web/src/utils/biz3utils.js:240-243; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClientBiz.kt:216-217; packages/core/src/iot.js:170-175
- kind: wire-fidelity
- status: planned
- note: vendor stringToUint8Array=TextEncoder (biz3utils.js:240-243)。core は deviceIdUpper(170)→stringToUint8Array(175)。

### [IOT-0008] buildIotPayload device_id を toUpperCase 正規化してから UTF8 化
- surface: core
- backend: cloud
- command: `iot.buildIotPayload`
- branch: lower-input | upper-input
- assert: 小文字 deviceId 入力でも payload には大文字 UUID の UTF8 バイトが入る。App CHAPIClientBiz.kt:216 `hub3.deviceId?.uppercase()`/cmdSesame :168 `ss2.deviceId.uppercase()` が正準ワイヤ形 (vendor web useIotCtrl.js:127 は無変換=意図的逸脱)
- ref: packages/core/src/iot.js:165-175; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClientBiz.kt:216-217; references_web/src/api/useIotCtrl.js:127
- kind: wire-fidelity
- status: planned
- note: P3-4。core uppercase 化は iot.js:170-175 (deviceIdUpper/didArray)、コメント根拠 165-169。ローカル DB lowercase 保存 (CHDeviceManager.kt:130-133) が逸脱の根拠。

### [IOT-0009] buildIotPayload cmd 下位8bit のみ採用 (cmd & 0xff)
- surface: core
- backend: cloud
- command: `iot.buildIotPayload`
- branch: within-8bit | over-8bit-0x15C→0x5C
- assert: cmdArray[0] = cmd の下位8bit のみに丸める (0x15C→0x5C)。vendor は new Uint8Array(1); cmdArray[0]=cmd で暗黙 truncate (useIotCtrl.js:123-124)、App も payloadBytes[offset]=cmd.toByte() (CHAPIClientBiz.kt:225)。core は cmd & 0xff で明示化
- ref: references_web/src/api/useIotCtrl.js:123-124; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClientBiz.kt:225; packages/core/src/iot.js:174
- kind: wire-fidelity
- status: planned

### [IOT-0010] buildIotPayload 必須欠落検証 (cmd/deviceId/secretKey)
- surface: core
- backend: local
- command: `iot.buildIotPayload`
- branch: no-cmd | no-deviceId | no-secretKey
- assert: cmd 非 number で iot.err.cmdRequired、deviceId 空で iot.err.deviceIdRequired、secretKey 空で iot.err.secretKeyRequiredCmac の badRequest (vendor useIotCtrl.js は検証なし＝純ローカル追加バリデーション)
- ref: packages/core/src/iot.js:161-163; packages/core/src/i18n/iot.js:87-89
- kind: error-path
- status: planned

### [IOT-0011] sign = cmacTime(secretKey) の 8hex を 4B 復元して先頭連結
- surface: core
- backend: cloud
- command: `iot.buildIotPayload`
- branch: -
- assert: sign = cmacTime(対象 device の secretKey) が返す 8hex を hexStringToUint8Array で 4 バイトに戻し payload 先頭に置く。vendor Cmac.cmacTime + hexStringToUint8Array(sign) と一致
- ref: references_web/src/api/useIotCtrl.js:120-121; references_web/src/utils/Cmac.js:139; references_web/src/utils/Cmac.js:142-150; packages/core/src/iot.js:172-173; packages/core/src/crypto.js:55
- kind: crypto-vector
- status: planned
- note: 署名鍵は対象 device の secretKey (32hex)。Cmac.js:139 aesCmac の .substring(0,8)=8hex / :142-150 cmacTime 関数 (時刻3B CMAC、:150 が関数閉じ)。旧 ref 範囲 139-149 は cmacTime の閉じ括弧 (:150) を外していたため substring 行 (:139) と cmacTime 本体 (:142-150) を別アンカーで明示。cmacTime ベクタ本体は crypto ドメイン管轄、ここは「secretKey を鍵に取り 4B 先頭連結」の境界。

## hex ヘルパ

hexStringToUint8Array の null/undefined・偶奇長・非hex の扱いを vendor biz3utils と core 安全側逸脱に照らして固定する。

### [IOT-0012] hexStringToUint8Array: null/undefined→空・偶数hex変換・奇数長/非hex→throw
- surface: core
- backend: local
- command: `iot.__internal.hexStringToUint8Array`
- branch: valid-even | null-undefined | odd-length | non-hex
- assert: iot ラッパ固有の境界のみ固定する: (1) null/undefined は Uint8Array(0) を返す (hexToBuf は非 string を throw するため iot 側の意図的逸脱)、(2) hexToBuf の throw (奇数長/非hex) を iot.err.invalidHexString badRequest に再ラップする。偶数長変換と奇数長/非hex 判定そのものは crypto.js hexToBuf (CRY-0015 管轄) へ委譲し、ここでは再被覆しない
- ref: references_web/src/utils/biz3utils.js:221-235; packages/core/src/iot.js:61-68; packages/core/src/crypto.js:89-104; packages/core/src/i18n/iot.js:85
- kind: error-path
- status: planned
- note: core は hexToBuf 委譲 (iot.js:64)、奇数長/非hex の明示 throw 本体は crypto.js:89-104 ([[CRY-0015]] が正典)。iot 固有は null/undefined→空 (iot.js:62) と i18n 再ラップ (iot.js:65-66)。vendor (biz3utils.js:221-235) は null/undefined→plain []・非hex を parseInt が 0 化するが core は CRY-0015 経由で安全側 throw。意図的逸脱は iot.js:55-57 コメント。

## 応答購読 / 相関

subscribeIotResponse の購読キー・sendIotCmdAwait の race 防止・device 照合・timeout を vendor iotReceive(op→callback) と transport recv キーに照らして固定する。

### [IOT-0013] subscribeIotResponse 購読キー biz3OperateIoT:<数値cmdCode>
- surface: core
- backend: cloud
- command: `iot.subscribeIotResponse`
- branch: -
- assert: 購読キーは `${action}:${cmd}` (= biz3OperateIoT:92 等) で transport の recv キー `${msg.action}:${msg.op||''}` と一致 (応答 message.op は数値 cmdCode の echo で文字列化される)。vendor iotReceive は op をキーに callback dispatch
- ref: references_web/src/hooks/useOperateIoT.js:6-43; references_web/src/hooks/useIotCallbackRegistry.js:11-13; packages/core/src/iot.js:211-213; packages/core/src/transport.js:527
- kind: wire-fidelity
- status: planned
- note: useOperateIoT.js:8/19 op=message.op→getIotCallbacks(op)。transport.js:527 受信側 `${msg.action}:${msg.op||""}` で数値 op 文字列化一致。例 LED_DUTY=92。

### [IOT-0014] sendIotCmdAwait: 購読確立後に送信し op 一致 push を1件で解決 (race防止)
- surface: core
- backend: cloud
- command: `iot.sendIotCmdAwait`
- branch: resolve-first-match
- assert: subscribe を先に張ってから sendIotCmd し (応答 push 取りこぼし防止)、op 一致 push 1 件で resolve・unsub。応答ディスパッチは vendor iotReceive(op→callback) と同じキー
- ref: references_web/src/hooks/useOperateIoT.js:6-19; references_web/src/hooks/useOperateIoT.js:54-61; packages/core/src/iot.js:235-255
- kind: idempotency
- status: planned
- note: vendor はコールバックレジストリ方式 (registerIotCallback→sendCmd)。subscribe-before-send は core 独自の堅牢化 (iot.js:242 subscribe→253 sendIotCmd)。

### [IOT-0015] sendIotCmdAwait: device 照合は msg.UUID || msg.touch_id
- surface: core
- backend: cloud
- command: `iot.sendIotCmdAwait`
- branch: deviceId-given | deviceId-omitted | mismatch-ignored
- assert: deviceId 指定時は normalizeUuid(msg.UUID || msg.touch_id) を照合し不一致 push を無視。省略時は normalizeUuid('')→falsy で照合スキップ=最初の op 一致 push を採用。vendor uuid=message.UUID||message.touch_id と一致
- ref: references_web/src/hooks/useOperateIoT.js:9-18; packages/core/src/iot.js:242-251; packages/core/src/crypto.js:153-155
- kind: wire-fidelity
- status: planned
- note: crypto.js:153-155 normalizeUuid は非 string で '' を返すため deviceId 省略=照合スキップ。

### [IOT-0016] sendIotCmdAwait: timeout で timeoutError reject + unsubscribe (既定10s)
- surface: core
- backend: cloud
- command: `iot.sendIotCmdAwait`
- branch: default-timeout | custom-timeout
- assert: timeoutMs 経過 (既定 DEFAULT_TIMEOUT_MS=10_000) で unsub してから iot.err.cmdTimeout{cmd,topic} の timeoutError を reject。vendor 本体は timeout を持たず UI 層に分散 (MobileWifiModule.js:89-91 setTimeout 10000 でフラグ解除のみ)
- ref: packages/core/src/iot.js:235-241; packages/core/src/iot.js:45; references_web/src/components/MobileWifiModule.js:89-91; packages/core/src/i18n/iot.js:92
- kind: error-path
- status: planned

### [IOT-0017] sendIotCmdAwait 並行呼び出しの応答相関 (同一 op 複数待ち)
- surface: core
- backend: cloud
- command: `iot.sendIotCmdAwait`
- branch: single | concurrent-same-op
- assert: subscribe(`biz3OperateIoT:<cmd>`) の fan-out で応答を受け、相関は deviceId 照合 (msg.UUID||touch_id) のみ。pending FIFO は request() 専用でこの経路に無く、deviceId 指定時のみ不一致 push を破棄して取り違えを防ぐ
- ref: packages/core/src/iot.js:235-255; packages/core/src/transport.js:537-542
- kind: idempotency
- status: planned
- note: transport.js:537-542 subscribers Set の fan-out。FIFO 相関 (transport.js:526-533) は request 専用。モック transport で検証可。

## LED Duty (cmd=92)

setHub3LedDuty (HUB3_ITEM_CODE_LED_DUTY) の extra=[op,duty]・set/get op 値・必須範囲検証・応答 ledDuty を vendor MobileWifiModule に照らして固定する。

### [IOT-0018] setHub3LedDuty (cmd=92) extra=[op(1B),duty(1B)]・set=0x01/get=0x02
- surface: core, cli
- backend: cloud
- command: `iot.setHub3LedDuty` / `sesame iot led [duty]`
- branch: set-0x01 | get-0x02
- assert: cmd=HUB3_ITEM_CODE_LED_DUTY(92)、extra=[op(1B),duty(1B)]、op set=0x01/get=0x02、get でも duty バイトを送る (vendor getLEDBrightness は duty:100 ダミー)。応答 data.ledDuty を返す
- ref: references_web/src/api/useIotCtrl.js:163-190; references_web/src/constants/gConfig.js:13-16; references_web/src/components/MobileWifiModule.js:155-172; packages/kit/src/cli/iot.js:89-107; packages/core/src/iot.js:281-286
- kind: wire-fidelity
- status: planned
- note: vendor iotPayloadArray[0]=op(:181)/[1]=duty(:182)。op 値は gConfig hub3LedDutyOp{set:0x01,get:0x02} / CLI op=isGet?0x02:0x01 (cli/iot.js:106)。cmd=92 cmdCode.js:61。応答抽出 iot.js:286 {ledDuty:msg?.data?.ledDuty}。

### [IOT-0019] setHub3LedDuty op/duty 必須・範囲検証 (0..255)
- surface: core
- backend: local
- command: `iot.setHub3LedDuty`
- branch: missing | out-of-range
- assert: op/duty いずれか undefined で iot.err.opDutyRequired、0..255 外で iot.err.opDutyRange の badRequest。vendor は console.error+return の暗黙無送信を core は throw に格上げ
- ref: references_web/src/api/useIotCtrl.js:169-178; packages/core/src/iot.js:277-280; packages/core/src/i18n/iot.js:93-94
- kind: error-path
- status: planned

## Relay (cmd=208)

hub3RelaySwitch (HUB3_ITEM_CODE_RELAY_SWITCH) の extra=[op] 既定0x01・fire-and-forget・op範囲検証・App との payload 長差異を固定する。

### [IOT-0020] hub3RelaySwitch (cmd=208) extra=[op] 既定0x01・fire-and-forget
- surface: core
- backend: cloud
- command: `iot.hub3RelaySwitch`
- branch: op-default-0x01 | op-explicit
- assert: cmd=HUB3_ITEM_CODE_RELAY_SWITCH(208)、extra=[op(1B)] 既定0x01、応答待たず sendIotCmd。vendor は op!==undefined?op:0x01、専用 registerIotCallback 無し
- ref: references_web/src/api/useIotCtrl.js:192-213; references_web/src/components/biz/device/VIotSwitch.js:61-66; packages/core/src/iot.js:306-314
- kind: wire-fidelity
- status: planned
- note: vendor op 既定 useIotCtrl.js:196、iotPayloadArray[0]=op :204。cmd=208 cmdCode.js:90。core op=0x01 既定(307)/cmd=208(309)/extra=[op](311)/fire-and-forget(313)。

### [IOT-0021] hub3RelaySwitch: relay payload は web基準(op 1B)で App の 2B 予約とは異なる
- surface: core
- backend: cloud
- command: `iot.hub3RelaySwitch`
- branch: -
- assert: core/web は extra=op 1B で payloadArray 末尾に1バイトのみ付与。App updateRelay は ByteArray(sign+1+deviceId+2) で末尾2B 確保 (うち1Bのみ書込) という差異を境界として固定する
- ref: references_web/src/api/useIotCtrl.js:204-211; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClientBiz.kt:221-233; packages/core/src/iot.js:311
- kind: wire-fidelity
- status: planned
- note: App 2B確保は CHAPIClientBiz.kt:221 ByteArray(...+2)、op 書込 :228 `payloadBytes[offset] = op` (末尾1Bのみ=最終1Bは0)。:233 `sendMap["op"]="cmd"` はフレーム op フィールドで別概念 (旧 note の :233 は誤記)。web は useIotCtrl.js:204 Uint8Array(1)。実機受理形 (2B末尾0 を Hub3 が受理するか) は要検証。

### [IOT-0022] hub3RelaySwitch op 範囲検証 (0..255)
- surface: core
- backend: local
- command: `iot.hub3RelaySwitch`
- branch: out-of-range
- assert: op<0 || op>255 で iot.err.opRange の badRequest。vendor は console.error+return の暗黙無送信
- ref: references_web/src/api/useIotCtrl.js:198-202; packages/core/src/iot.js:308; packages/core/src/i18n/iot.js:95
- kind: error-path
- status: planned

## sesame 追加/削除 (cmd=101/103)

addSesameToHub3 / removeSesameFromHub3 (SSM3_ITEM_ADD/REMOVE_SESAME) の extra packing 順・device_id=親Hub3・productType/matter 写像・必須検証を vendor handleSesameItemOperation に照らして固定する。

### [IOT-0023] buildSesameItemExtra 連結順 sesameId(16)+secret(16)+nameLen(1)+name+pt(1)+matter(1)
- surface: core
- backend: cloud
- command: `iot.addSesameToHub3` / `iot.removeSesameFromHub3`
- branch: nickname | empty-nickname
- assert: extra = sesameId(ハイフン除去hex16B) ++ ssmSecKa(hex16B) ++ nickNameLen(1B) ++ nickNameUTF8 ++ productType(1B) ++ matterProductType(1B) が vendor handleSesameItemOperation の offset 連結順と一致
- ref: references_web/src/api/useIotCtrl.js:53-107; packages/core/src/iot.js:324-360
- kind: wire-fidelity
- status: planned
- note: vendor offset 連結 useIotCtrl.js:89-99、core concatBytes 引数順 iot.js:352-359。sesameId は normalizeUuid+hex(326-327)、ssmSecKa hex(330)。buildIotPayload の device_id(UTF8 大文字 36B) とは別、鍵2点のみ hex 16B。

### [IOT-0024] addSesameToHub3 (cmd=101) device_id=親Hub3 UUID・応答 data.ssks
- surface: core
- backend: cloud
- command: `iot.addSesameToHub3`
- branch: -
- assert: cmd=SSM3_ITEM_ADD_SESAME(101)、payload の device_id は親 Hub3 UUID (sesameId ではない)・topic も Hub3。応答 message.data.ssks を返す。vendor performSesameOperation: device_id=currentDevice.deviceUUID, callback が data.ssks 読む
- ref: references_web/src/components/MobileBindDevice.js:70-92; references_web/src/api/useIotCtrl.js:159-161; packages/core/src/iot.js:378-414
- kind: wire-fidelity
- status: planned
- note: cmd 101 cmdCode.js:62。MobileBindDevice.js:72 device_id=親Hub3, :87 data.ssks。core deviceId:hub3Id(412)/ssks 返却(414)。

### [IOT-0025] removeSesameFromHub3 (cmd=103) は ADD と完全同形 packing
- surface: core
- backend: cloud
- command: `iot.removeSesameFromHub3`
- branch: -
- assert: cmd=SSM3_ITEM_REMOVE_SESAME(103) のみ差し替え、extra/topic/device_id は ADD と同一 (vendor SSM3_ITEM_REMOVE_SESAME が handleSesameItemOperation を共用)
- ref: references_web/src/api/useIotCtrl.js:155-158; references_web/src/components/MobileBindDevice.js:100-102; packages/core/src/iot.js:391-414
- kind: wire-fidelity
- status: planned
- note: cmd 103 cmdCode.js:64。core removeSesameFromHub3(391-394)→共通 sesameItemOp(401-415)→buildSesameItemExtra(324-360) を ADD と共用。

### [IOT-0026] sesame-item nickName: UTF8・nameLen 1B・空は0・255超で throw
- surface: core
- backend: local
- command: `iot.__internal.buildSesameItemExtra`
- branch: normal | empty | too-long
- assert: nickName を UTF8 化し直前に長さ1Bを置く。空文字は nameLen=0、UTF8 長 255超は iot.err.nicknameTooLong (vendor も throw)
- ref: references_web/src/api/useIotCtrl.js:61-70; packages/core/src/iot.js:333-338
- kind: payload-fidelity
- status: planned
- note: vendor >255 throw useIotCtrl.js:67-68/61 nickName||''。core nickName||''(333)/UTF8(334)/>255 badRequest(335-337)/nickNameLen 1B(338)。

### [IOT-0027] sesame-item productType/matterProductType の deviceModel 逆引き写像
- surface: core
- backend: local
- command: `iot.__internal.getProductTypeFromModelName` / `iot.__internal.getMatterProductTypeFromModelName`
- branch: known-model | matter-map-miss | unknown-model
- assert: productType は modelNameByProductType 逆引き、matter は MATTER_PRODUCT_TYPE_MAP (5→0,17→1,13→255)。pt29 は両者コメントアウトで undefined。未知 model は iot.err.unknownModel で throw (vendor は null→0 黙送)、matter map 外は 0 フォールバック (vendor は undefined 黙送)
- ref: references_web/src/utils/biz3utils.js:53-101; packages/core/src/iot.js:85-109; packages/core/src/iot.js:343-350
- kind: payload-fidelity
- status: planned
- note: vendor map 5→0(biz3utils.js:69),17→1(80),13→255(76),29 コメントアウト(92)。core MATTER_PRODUCT_TYPE_MAP(92-97 29欠落)/逆引き(85-88)/unknownModel throw(343-346)/matter ??0 フォールバック(348-350)。matter-map-miss の ??0 は意図的逸脱。

### [IOT-0028] 未知 deviceModel は productType=0 を黙送せず badRequest
- surface: core
- backend: local
- command: `iot.__internal.buildSesameItemExtra`
- branch: unknown-model
- assert: 未知 model (productType=null) で iot.err.unknownModel を投げる (意図的安全側逸脱: vendor は Uint8Array([null]) が 0 化けして送る)
- ref: references_web/src/api/useIotCtrl.js:67-73; packages/core/src/iot.js:343-346; packages/core/src/i18n/iot.js:97
- kind: error-path
- status: planned

### [IOT-0029] add/rm-sesame 必須欠落検証 (hub3Id/sesameId/ssmSecKa/deviceModel)
- surface: core
- backend: local
- command: `iot.addSesameToHub3` / `iot.removeSesameFromHub3`
- branch: no-hub3 | no-sesame | no-ssmSec | no-model
- assert: 各必須欠落で iot.err.{hub3IdRequired,sesameIdRequired,ssmSecKaRequired,deviceModelRequired} の badRequest (鍵取り違え防止の安全側バリデーション)
- ref: packages/core/src/iot.js:403-406; packages/core/src/i18n/iot.js:98-101
- kind: error-path
- status: planned
- note: sesameItemOp 内 4連 throw (hub3IdRequired 403/sesameIdRequired 404/ssmSecKaRequired 405/deviceModelRequired 406)。i18n en 98-101 / ja 198-201。

## firmware (cmd=0x03)

startFirmwareUpdate (ssmOSUpdate) の payload=sign+cmd+device_id・hub3Id フォールバック・progress 複数回 push を vendor handleOSUpdate / UpgradeFirmware に照らして固定する。

### [IOT-0030] startFirmwareUpdate (cmd=0x03) payload=sign+cmd+device_id のみ・hub3Id フォールバック
- surface: core
- backend: cloud
- command: `iot.startFirmwareUpdate`
- branch: hub3-given | hub3-omitted-wifi
- assert: cmd=ssmOSUpdate(0x03)、iotPayload 無し→extra 無しで payload=[sign,cmd,device_id] のみ。hub3Id 省略時 topic は deviceId から構築 (buildIotTopic(hub3Id || deviceId))。vendor handleOSUpdate: hub3_id=isWifiModel?self:Hub3DeviceUUID
- ref: references_web/src/api/useIotCtrl.js:110-153; references_web/src/components/biz/device/UpgradeFirmware.js:98-104; packages/core/src/iot.js:435-454
- kind: wire-fidelity
- status: planned
- note: vendor handleOSUpdate は iotPayload 既定 {} のため switch 不実行→extra 無し (useIotCtrl.js:153)。hub3_id 分岐 UpgradeFirmware.js:101 (isWifiModel?deviceUUID:Hub3DeviceUUID)。core フォールバック iot.js:438。

### [IOT-0031] startFirmwareUpdate progress 複数回 push (versionTag で完了)・unsubscribe を返す
- surface: core
- backend: cloud
- command: `iot.startFirmwareUpdate`
- branch: progress | complete | onProgress-omitted
- assert: onProgress が data{progress,versionTag,UUID} を複数回受信し versionTag 観測で完了扱い。戻り値 unsubscribe で購読解除。vendor ssmOSUpdate callback: versionTag あれば完了/無ければ setUpdateProgress(progress)
- ref: references_web/src/components/biz/device/UpgradeFirmware.js:105-120; packages/core/src/iot.js:441-454
- kind: idempotency
- status: planned
- note: vendor UpgradeFirmware.js:107-118 が {progress,versionTag='',UUID=''}=data 分解。core は onProgress 有時のみ subscribeIotResponse 登録し unsub 返却(453)。

## wifi ssid 消去 (cmd=210)

clearHub3WifiSsid (HUB3_ITEM_CODE_CLEAR_WIFI_SSID) の extra 無し fire-and-forget を vendor handleClearWiFiSSID に照らして固定する。

### [IOT-0032] clearHub3WifiSsid (cmd=210) 追加バイト無し・fire-and-forget
- surface: core
- backend: cloud
- command: `iot.clearHub3WifiSsid`
- branch: -
- assert: cmd=HUB3_ITEM_CODE_CLEAR_WIFI_SSID(210)、extra 無しで payload=[sign,cmd,device_id] のみ、応答待たず send。vendor case は break のみ・呼出側 iotPayload:{} で switch 不実行
- ref: references_web/src/api/useIotCtrl.js:214-215; references_web/src/components/MobileWifiModule.js:146-153; packages/core/src/iot.js:466-471
- kind: wire-fidelity
- status: planned
- note: cmd=210 cmdCode.js:91。vendor case break のみ(useIotCtrl.js:214-215)+iotPayload:{}(MobileWifiModule.js:151)で二重に追加バイト無し。core extra 無し buildIotPayload+sendIotCmd(fire-and-forget)。

## Matter (cmd=137/153)

getMatterPairingCode (HUB3_MATTER_PAIRING_CODE) / openMatterPairingWindow (HUB3_MATTER_PAIRING_WINDOW) の応答整形を vendor handleOpenMatter に照らして固定する。

### [IOT-0033] getMatterPairingCode (cmd=137) extra 無し・応答 qrCode/manualCode
- surface: core
- backend: cloud
- command: `iot.getMatterPairingCode`
- branch: -
- assert: cmd=HUB3_MATTER_PAIRING_CODE(137)、extra 無しで payload=[sign,cmd,device_id]、応答 message.data.{qrCode,manualCode} を返す。vendor registerIotCallback(137) の {manualCode,qrCode}=data と一致
- ref: references_web/src/components/MobileWifiModule.js:82-96; packages/core/src/iot.js:484-491
- kind: wire-fidelity
- status: planned
- note: cmd=137 cmdCode.js:73 (STP_ITEM_CODE_PASSCODE_CHANGE_VALUE と重複定義 cmdCode.js:73,80)。vendor MobileWifiModule.js:95-96 {qrCode,manualCode}=data。

### [IOT-0034] openMatterPairingWindow (cmd=153) 応答 statusCode (===0 成功)
- surface: core
- backend: cloud
- command: `iot.openMatterPairingWindow`
- branch: status-0 | status-nonzero | status-absent
- assert: cmd=HUB3_MATTER_PAIRING_WINDOW(153)、extra 無し、応答 message.data.statusCode を返す (statusCode===0 で成功)。vendor registerIotCallback(153) の data.statusCode===0 判定と一致
- ref: references_web/src/components/MobileWifiModule.js:97-126; packages/core/src/iot.js:501-508
- kind: wire-fidelity
- status: planned
- note: cmd=153 cmdCode.js:75。vendor MobileWifiModule.js:102-108 statusCode===0 で QR 表示/else 失敗 snackbar。

## cmdCode 定数同期

core/vendor cmdCode と references_web cmdCode の数値一致を固定する (Hub3 文脈の cmdCode 重複定義の曖昧性も含む)。

### [IOT-0035] vendor cmdCode 定数の数値同期 (92/101/103/137/153/208/210/0x03)
- surface: core
- backend: local
- command: `vendor/biz3/constants/cmdCode`
- branch: -
- assert: core/src/vendor/biz3/constants/cmdCode.js が references_web の cmdCode と数値一致 (HUB3_ITEM_CODE_LED_DUTY=92, SSM3_ITEM_ADD/REMOVE=101/103, MATTER_PAIRING_CODE/WINDOW=137/153, RELAY=208, CLEAR_WIFI=210, ssmOSUpdate=0x03)
- ref: references_web/src/constants/cmdCode.js:46-92; packages/core/src/vendor/biz3/constants/cmdCode.js:46-92
- kind: contract-existence
- status: planned
- note: 値一致: ssmOSUpdate=0x03(:47), LED_DUTY=92(:61), ADD=101(:62), REMOVE=103(:64), MATTER_CODE=137(:73), MATTER_WINDOW=153(:75), RELAY=208(:90), CLEAR_WIFI=210(:91)。137 は STP_ITEM_CODE_PASSCODE_CHANGE_VALUE と重複(cmdCode.js:73,80)。

## namespace / serve 公開

NAMESPACE_OPS allowlist の op 集合と serve registry/proto/生成 param による自動公開・requireAuth 強制を固定する。

### [IOT-0036] iot NAMESPACE_OPS allowlist (hub.iot.* に出す 10 op)
- surface: core
- backend: local
- command: `iot.NAMESPACE_OPS`
- branch: -
- assert: namespace に出るのは sendIotCmd/sendIotCmdAwait/setHub3LedDuty/hub3RelaySwitch/addSesameToHub3/removeSesameFromHub3/startFirmwareUpdate/clearHub3WifiSsid/getMatterPairingCode/openMatterPairingWindow の10個。buildIotTopic/buildIotPayload/subscribeIotResponse/__internal は出さない (client 非取得 or 購読プリミティブ)
- ref: packages/core/src/iot.js:530-536; packages/kit/src/serve/registry.js:288-303
- kind: contract-existence
- status: planned
- note: 除外理由は iot.js:520-529 JSDoc に明記。registry.js:288-303 が mod.NAMESPACE_OPS を読み hub.iot.<op> 登録。

### [IOT-0037] serve registry が iot.* 10 op を自動公開し requireAuth を強制
- surface: serve
- backend: cloud
- command: `iot.*` (JSON-RPC method 'iot.<op>')
- branch: unauth | authed
- assert: NAMESPACE_OPS を ns.op 登録し requireAuth 後 hub[ns][op](p) へ委譲する汎用 serve 公開機構は [[SRV-0040]] が正典。requireAuth の分岐は [[SRV-0042]]、iot の公開 op 許可リストは [[IOT-0036]] が保持
- ref: local-contract
- kind: contract-existence
- status: waived: 重複（正典 [[SRV-0040]]）
- note: 正典: 機構=serve-framing SRV-0040 / requireAuth 分岐=SRV-0042 / iot allowlist=IOT-0036。registry.js:288-305 は namespace 非依存の単一ループで iot 固有分岐は無く、本エントリ独自の境界が無いため waive。iot.* の proto/rpc-params/SDK 1:1 は IOT-0038/0039/0040/0041/0042 が保持。

### [IOT-0038] iot.* op の rpc-params/grpc メソッド生成が NAMESPACE_OPS と 1:1
- surface: serve
- backend: cloud
- command: `rpc-params.generated.json` / `grpc-methods.generated.json`
- branch: -
- assert: 生成 param/grpc メソッドが NAMESPACE_OPS の 10 op と 1:1 で、各 param 名/required が iot.js の JSDoc 型 (例 setHub3LedDuty: op/duty required, hub3Id/timeoutMs optional) と一致する
- ref: packages/kit/src/serve/rpc-params.generated.json:1519-1906; packages/kit/src/serve/grpc-methods.generated.json:524-599; packages/core/src/iot.js:530-536
- kind: contract-existence
- status: planned
- note: rpc-params iot.* 10 op 連続 (1519〜1906)。grpc-methods 524-599。setHub3LedDuty rpc-params 1587-1636 (op 1614/duty 1622 required, hub3Id 1605/timeoutMs 1628 optional)。

## SDK 契約

proto の Iot* RPC 10 件と TS/Python SDK の iot.* メソッド署名が NAMESPACE_OPS と 1:1・required/optional 一致を固定する。

### [IOT-0039] proto に iot RPC 10 メソッドが 1:1 で存在
- surface: sdk
- backend: cloud
- command: `IotSendIotCmd / IotSendIotCmdAwait / IotSetHub3LedDuty / IotHub3RelaySwitch / IotAddSesameToHub3 / IotRemoveSesameFromHub3 / IotStartFirmwareUpdate / IotClearHub3WifiSsid / IotGetMatterPairingCode / IotOpenMatterPairingWindow`
- branch: -
- assert: sesame.proto の Iot* RPC が NAMESPACE_OPS の10 op と 1:1 で対応 (subscribeIotResponse は除外)
- ref: packages/kit/src/serve/sesame.proto:125-143; packages/core/src/iot.js:530-536
- kind: contract-existence
- status: planned
- note: proto Iot* RPC 125-143 (10件、:144 comment/:145 PresetirSendIR)。subscribeIotResponse 除外は iot.js:525-528。

### [IOT-0040] proto Iot*Request のフィールド形と required/optional が core 引数と一致
- surface: sdk
- backend: cloud
- command: `IotSendIotCmd / IotSendIotCmdAwait / IotSetHub3LedDuty / IotAddSesameToHub3 / IotStartFirmwareUpdate`
- branch: required-vs-optional
- assert: IotSendIotCmdRequest={topic,payload,opt op}、IotSendIotCmdAwaitRequest={topic,payload,cmd,opt deviceId,opt timeoutMs}、LedDuty は op/duty 必須・hub3Id/timeoutMs optional、AddSesame は hub3Id/secretKey/sesameId/ssmSecKa/deviceModel 必須・nickName/timeoutMs optional、FirmwareUpdate は hub3Id optional が core 引数形と一致
- ref: packages/kit/src/serve/sesame.proto:702-750; packages/core/src/iot.js:195; packages/core/src/iot.js:235; packages/core/src/iot.js:275-280; packages/core/src/iot.js:401-406; packages/core/src/iot.js:435-439
- kind: contract-existence
- status: planned
- note: proto Cmd 702-705/Await 707-713/LedDuty 714-721/AddSesame 728-736/FirmwareUpdate 746-750。core 署名 sendIotCmd=195, sendIotCmdAwait=235, LedDuty 275-280, AddSesame 401-406, FirmwareUpdate 435-439。

### [IOT-0041] TS SDK の iot.* 10 メソッド署名が rpc-params と一致
- surface: sdk
- backend: cloud
- command: `SesameClient.iot.*` (ts)
- branch: -
- assert: ts SDK に iot 10 op が生成され、各 params 型 (例 addSesameToHub3: hub3Id/secretKey/sesameId/ssmSecKa/deviceModel required, nickName/timeoutMs optional) が rpc-params と一致し iot.<op> を _call する
- ref: packages/kit/sdk/ts/sesame-client.ts:440-458; packages/kit/src/serve/rpc-params.generated.json:1519-1906
- kind: contract-existence
- status: planned
- note: ts iot ブロック 438-459、10 op 440-458。addSesameToHub3 例は rpc-params 1671-1728 で一致。

### [IOT-0042] Python SDK の iot.* 10 メソッド署名が rpc-params と一致
- surface: sdk
- backend: cloud
- command: `SesameClient.iot.*` (py)
- branch: -
- assert: python SDK に iot 10 op が生成され、required/optional (例 setHub3LedDuty: op/duty 必須, hub3Id/timeoutMs=None) が rpc-params と一致し _omit_none で None を除いて iot.<op> を _call する
- ref: packages/kit/sdk/python/sesame_client.py:854-896; packages/kit/src/serve/rpc-params.generated.json:1587-1636
- kind: contract-existence
- status: planned
- note: class _Iot 854-896 (addSesameToHub3 858..startFirmwareUpdate 894, _omit_none def 109)。rpc-params 1587-1636 が setHub3LedDuty を厳密包含。

## CLI led

`sesame iot led` の set/get 分岐・duty 検証 (exit2)・--json 封筒を固定する。

### [IOT-0043] sesame iot led set/get 分岐と duty 写像
- surface: cli
- backend: cloud
- command: `sesame iot led [duty] [--get]`
- branch: set | --get
- assert: --get 無しは op=0x01(set) で duty 必須、--get は op=0x02 で duty 既定0(ダミー)。setHub3LedDuty へ {deviceId,secretKey,hub3Id,op,duty} を写像し hub.iot 経由で呼ぶ
- ref: packages/kit/src/cli/iot.js:78-115; packages/core/src/iot.js:275-287
- kind: option-branch
- status: planned
- note: CLI op=isGet?0x02:0x01(:106), get 時 dutyNum=0(:91), 写像 :102-109。

### [IOT-0044] sesame iot led 引数/範囲検証 (exit 2)
- surface: cli
- backend: local
- command: `sesame iot led [duty]`
- branch: set-no-duty | out-of-range
- assert: set で duty 未指定は iot.led.needDuty で die(...,2)、整数0..255 外は iot.led.dutyRange で die(...,2)
- ref: packages/kit/src/cli/iot.js:91-99
- kind: error-path
- status: planned
- note: needDuty die(...,2) :92-94, dutyRange die(...,2) :96-98 (Number.isInteger && 0..255)。

### [IOT-0045] sesame iot led --json 封筒
- surface: cli
- backend: cloud
- command: `sesame iot led --json`
- branch: set-json | get-json
- assert: --json 出力が {ok:true, op:'set'|'get', duty, ledDuty} 封筒。set 時 duty 同梱・get 時 duty undefined。human 分岐は iot.led.get/set メッセージ
- ref: packages/kit/src/cli/iot.js:110-113; packages/core/src/i18n/iot.js:50-51
- kind: surface-parity
- status: planned

## CLI relay

`sesame iot relay <state>` の state 検証 (exit2)・fire-and-forget 封筒を固定する。

### [IOT-0046] sesame iot relay <state> 検証と送信
- surface: cli
- backend: cloud
- command: `sesame iot relay <toggle|on>`
- branch: toggle | on | invalid
- assert: state は toggle/on のみ許可 (それ以外 iot.relay.badState で die 2)、op=0x01 固定で hub3RelaySwitch を fire-and-forget
- ref: packages/kit/src/cli/iot.js:117-138; packages/core/src/iot.js:306-314
- kind: option-branch
- status: planned
- note: state 検証 die(...,2) cli/iot.js:126-128, op:0x01 固定 :133。core op=0x01 既定(307)/fire-and-forget(313)。

### [IOT-0047] sesame iot relay --json 封筒 (fire-and-forget 注記)
- surface: cli
- backend: cloud
- command: `sesame iot relay --json`
- branch: -
- assert: --json が {ok:true, sent:true, state, op:0x01, note:'fire-and-forget (応答未確認)'} を返す (送信成功≠受理)
- ref: packages/kit/src/cli/iot.js:134-136
- kind: surface-parity
- status: planned

## CLI firmware

`sesame iot firmware-update` の --wait 待機・versionTag 早期終了・text/json 出力差を固定する。

### [IOT-0048] sesame iot firmware-update --wait progress 集約と versionTag 早期終了
- surface: cli
- backend: cloud
- command: `sesame iot firmware-update [--wait <sec>]`
- branch: text-stream | json-batched | versionTag-early-exit | timeout
- assert: --wait 既定120s。text は progress を逐次出力、--json は events を溜め最後にまとめて {ok,completed,events}。versionTag 観測で早期終了、無ければ waitSec まで
- ref: packages/kit/src/cli/iot.js:140-180; packages/kit/src/cli/iot.js:511-528
- kind: option-branch
- status: planned
- note: --wait 既定 '120'(145), text 逐次 console.log(163-168), json events 集約(153,178), versionTag 早期終了は waitForCompletion(518-528) が events.some(versionTag) で resolve。

## CLI wifi-clear

`sesame iot wifi-clear` の fire-and-forget 封筒を固定する。

### [IOT-0049] sesame iot wifi-clear fire-and-forget
- surface: cli
- backend: cloud
- command: `sesame iot wifi-clear`
- branch: -
- assert: clearHub3WifiSsid を呼び {ok:true,sent:true,note:'fire-and-forget (応答未確認)'} 封筒。応答待たない
- ref: packages/kit/src/cli/iot.js:182-196; packages/core/src/iot.js:466-471
- kind: surface-parity
- status: planned

## CLI matter

`sesame iot matter-code` の応答整形と `sesame iot matter-open` の statusCode 三値判定を固定する。

### [IOT-0050] sesame iot matter-code 応答整形
- surface: cli
- backend: cloud
- command: `sesame iot matter-code`
- branch: -
- assert: getMatterPairingCode を await し {ok:true, qrCode, manualCode} 封筒。data 欠落時 '(none)' 表示
- ref: packages/kit/src/cli/iot.js:198-215; packages/core/src/iot.js:484-491
- kind: surface-parity
- status: planned
- note: '(none)' フォールバック cli/iot.js:211-212、封筒 :213。

### [IOT-0051] sesame iot matter-open statusCode 三値判定
- surface: cli
- backend: cloud
- command: `sesame iot matter-open`
- branch: status-0 | status-nonzero | status-absent
- assert: statusCode===0 で成功、非0 で失敗、statusCode 欠落は '不明' (ok:null) として失敗と断定しない。封筒 {ok: hasStatus?okStatus:null, statusCode}。human は unknownStatus/ok/failed に区別
- ref: packages/kit/src/cli/iot.js:217-241; packages/core/src/iot.js:501-508; packages/core/src/i18n/iot.js:62-64
- kind: option-branch
- status: planned
- note: hasStatus=statusCode!=null / okStatus=statusCode===0 / ok:hasStatus?okStatus:null (cli/iot.js:231-239)。

## CLI sesame-item

`sesame iot add-sesame` / `rm-sesame` の必須5項目 missing 検証 (exit2, 対話補完なし)・ssks 封筒を固定する。

### [IOT-0052] sesame iot add/rm-sesame 明示必須 (対話補完なし)・exit2
- surface: cli
- backend: cloud
- command: `sesame iot add-sesame` / `sesame iot rm-sesame`
- branch: add | remove | missing-required
- assert: hub3/secret/sesame/ssm-sec/model 欠落は集約して iot.sesame.missing で die(...,2) (鍵取り違え防止で対話補完しない)。揃えば add→addSesameToHub3 / remove→removeSesameFromHub3 を呼ぶ
- ref: packages/kit/src/cli/iot.js:474-508; packages/core/src/iot.js:378-394
- kind: error-path
- status: planned
- note: missing 集約 die(...,2) cli/iot.js:485-495, mode 別呼出 :500-502。

### [IOT-0053] sesame iot add/rm-sesame --json 封筒 (ssks 含む)
- surface: cli
- backend: cloud
- command: `sesame iot add-sesame` / `sesame iot rm-sesame`
- branch: ssks-present | undefined
- assert: --json は {ok:true, mode, sesameId, hub3Id, ssks} 封筒。human は iot.sesame.ok + ssks (res.ssks!==undefined のときのみ)
- ref: packages/kit/src/cli/iot.js:504-507; packages/core/src/i18n/iot.js:65-66
- kind: surface-parity
- status: planned

## CLI raw

`sesame iot raw` の payload 正規化 (hex→base64)・必須/--wait 依存検証 (exit2)・await/fire-and-forget 分岐を固定する。

### [IOT-0054] sesame iot raw payload 正規化 (hex→base64 / 透過)
- surface: cli
- backend: cloud
- command: `sesame iot raw --topic --payload`
- branch: hex-payload | passthrough-payload
- assert: 偶数長 hex は Buffer.from(hex).toString('base64') で base64 化、それ以外は透過 (既に base64 等)。vendor frame の payload は base64 (useIotCtrl.js:222 Buffer.from(payloadArray).toString('base64'))
- ref: packages/kit/src/cli/iot.js:326-331; references_web/src/api/useIotCtrl.js:222-224
- kind: option-branch
- status: planned
- note: normalizeRawPayload の base64 化機構 (cli/iot.js:326-331) が vendor frame payload=base64 (useIotCtrl.js:222) と一致。

### [IOT-0055] sesame iot raw 必須/--wait 依存検証 (exit 2)
- surface: cli
- backend: local
- command: `sesame iot raw`
- branch: no-topic | no-payload | wait-without-cmd
- assert: --topic 欠落 iot.raw.topicRequired、--payload 欠落 iot.raw.payloadRequired、--wait 指定で --cmd 非整数は iot.raw.cmdRequired をすべて接続前に die(...,2) (sendIotCmd/Await は呼ばれない)
- ref: packages/kit/src/cli/iot.js:285-294
- kind: error-path
- status: planned
- note: topic/payload 欠落 die(...,2) :287-288, --wait && (!cmd || !Number.isInteger) die(...,2) :291-293、いずれも :295 withHub 前。

### [IOT-0056] sesame iot raw --wait/--cmd で await・無しで fire-and-forget
- surface: cli
- backend: cloud
- command: `sesame iot raw [--wait --cmd <n>]`
- branch: await | fire-and-forget
- assert: --wait 時 sendIotCmdAwait({topic,payload,cmd,deviceId,timeoutMs}) で応答1件を {ok,awaited:true,cmd,topic,response}、無しは sendIotCmd で {ok,awaited:false,topic,note}
- ref: packages/kit/src/cli/iot.js:295-314; packages/core/src/iot.js:235-255
- kind: option-branch
- status: planned
- note: await 経路 cli/iot.js:298-307, fire-and-forget :310-313。

## CLI resolveTarget

led/relay/firmware-update/wifi-clear/matter-* 共通の --device/--secret/--hub3 補完優先順位 (exit2) を固定する。

### [IOT-0057] iot resolveTarget: --device/--secret/--hub3 補完優先順位
- surface: cli
- backend: cloud
- command: `sesame iot led/relay/firmware-update/wifi-clear/matter-*` (共通 resolveTarget)
- branch: explicit | listDevices | config-fallback | single-auto | interactive | non-interactive-die
- assert: 明示指定優先→hub.listDevices()→config(locks/hub3s)。1件自動採用、複数は対話 selectFromList、非対話複数は die(...,2)。secretKey 不足で needSecret は die(...,2)。hub3s は secretKey を持たない
- ref: packages/kit/src/cli/iot.js:350-466
- kind: option-branch
- status: planned
- note: 明示優先 :355-357, listDevices :363, secret 補完 :369-376, config fallback :383-389, 1件自動 :392-394, 対話/非対話 die :395-409, secret 未解決 die2 :412-414, hub3s secretKey:undefined :429-432。

## 面横断 / i18n

iot op の core/serve/sdk/cli 横断同一封筒・i18n カタログ完全性を固定する。

### [IOT-0058] iot op が core/serve/sdk/cli で同一封筒・同一 wire になる
- surface: core, serve, sdk, cli
- backend: cloud
- command: `iot.setHub3LedDuty` / `iot.hub3RelaySwitch` / `iot.sendIotCmd`
- branch: core | serve-jsonrpc | sdk-grpc | cli
- assert: 同一 op を core 直呼び/serve JSON-RPC/sdk gRPC/cli で叩いたとき、params 写像・送出フレーム ({action:'biz3OperateIoT',topic,payload,op:'cmd'})・応答抽出が同一になる (NAMESPACE_OPS 単一真実源由来)
- ref: packages/core/src/iot.js:44; packages/core/src/iot.js:195-199; packages/core/src/iot.js:530-536; packages/kit/src/serve/registry.js:287-305; packages/kit/sdk/ts/sesame-client.ts:440-458; packages/kit/src/cli/iot.js:78-112
- kind: surface-parity
- status: planned
- note: iot.js:530-536 NAMESPACE_OPS 単一真実源、registry.js:287-305 が hub[ns][op](p) へ写像。

### [IOT-0059] iot.err.* / iot.* CLI メッセージの en/ja カタログ完全性
- surface: core, cli
- backend: local
- command: `i18n iot カタログ`
- branch: en | ja
- assert: iot.err.* と iot.<cmd>.* の全キーが en/ja 両方に存在し欠落が無い (cmdTimeout/unknownModel 等の {cmd}{topic}{model} プレースホルダ含む)
- ref: packages/core/src/i18n/iot.js:85-101; packages/core/src/i18n/iot.js:185-201
- kind: i18n
- status: planned
- note: ja の iot.err.* 末尾は 201 まで (hub3IdRequired/sesameIdRequired/ssmSecKaRequired/deviceModelRequired 198-201 を含む)。

## 実機往復 (E2E)

実 Hub3/実クラウド IoT でしか検証できない送受往復・応答 callback 無し op の応答構造を waived として記録する。

### [IOT-0060] 実機 Hub3 への iot cmd 実送信と応答往復
- surface: core
- backend: cloud
- command: `iot.setHub3LedDuty` / `iot.getMatterPairingCode` (代表)
- branch: -
- assert: 実 Hub3/実クラウド IoT が payload を受理し op=cmdCode echo の応答 push を返すこと (フレーム形は IOT-0006/0013 でローカル固定済み、実往復は機材必須)
- ref: references_web/src/api/useIotCtrl.js:110-228; packages/core/src/iot.js:235-255
- kind: wire-fidelity
- status: waived: 実機 Hub3 + 実クラウド IoT 往復でしか検証不能 (CI 不可)
- note: 送信側 useIotCtrl.js:110-228、応答待ち sendIotCmdAwait iot.js:235-255。op=cmdCode echo の購読キーは IOT-0013。

### [IOT-0061] relay/wifi-clear の応答 push 構造 (専用callback無し)
- surface: core
- backend: cloud
- command: `iot.hub3RelaySwitch` / `iot.clearHub3WifiSsid`
- branch: -
- assert: RELAY(208)/CLEAR_WIFI(210) は vendor web に応答 callback 登録が無く push 構造が未確認。fire-and-forget が正しい契約か実機で確認する境界
- ref: references_web/src/api/useIotCtrl.js:192-215; packages/core/src/iot.js:306-314; packages/core/src/iot.js:466-471
- kind: wire-fidelity
- status: waived: vendor に応答 callback 無く実機でしか応答有無/構造を確認できない
- note: RELAY=208/CLEAR_WIFI=210 (cmdCode.js:90-91) は send のみで registerIotCallback 登録が全 references_web に皆無 (LED/MATTER/ssmOSUpdate は登録有り)。両 fire-and-forget は iot.js:313/470。

## 監査追補 v2 (dual-audit)

### [IOT-0062] iot.* 10 op が openrpc.json に NAMESPACE_OPS と 1:1・result-schema 上流被覆
- surface: sdk, serve
- backend: cloud
- command: `iot.* (schema/openrpc.json method 'iot.<op>')`
- branch: -
- assert: schema/openrpc.json に iot.* 10 op (sendIotCmd〜openMatterPairingWindow) が NAMESPACE_OPS と 1:1 で method として存在し、各 method の params 名/required/schema が core 引数形 (例 setHub3LedDuty: deviceId/secretKey/op/duty required, hub3Id/timeoutMs optional) と一致する。openrpc.json は gen-sdk-ts/gen-sdk-py の上流 (result-schemas.js:1-8) であり SDK 契約の正準源
- ref: schema/openrpc.json:2251; schema/openrpc.json:2345; schema/openrpc.json:2722; packages/kit/src/serve/result-schemas.js:4; packages/core/src/iot.js:530
- kind: contract-existence
- status: planned
- note: grep '"iot.' = 10 (行 2251 sendIotCmd 〜 2722 openMatterPairingWindow)。result-schemas.js:1-8 が openrpc.json→gen-sdk-ts/py の単一上流かつ CI ドリフトゲートと明記。DEV-0045 (devices.md) と同形 (openrpc/proto/grpc-methods/registry 1:1) に揃える。proto/rpc-params/SDK の iot 1:1 は IOT-0038〜0042、面横断同一封筒は [[IOT-0058]]。

### [IOT-0063] startFirmwareUpdate は serve/sdk 経由で progress/versionTag を観測できない (実質 fire-and-forget・負事実)
- surface: serve, sdk
- backend: cloud
- command: `iot.startFirmwareUpdate` (JSON-RPC / gRPC IotStartFirmwareUpdate)
- branch: serve-jsonrpc-no-progress | sdk-grpc-no-progress
- assert: serve registry の汎用ループは hub.iot.startFirmwareUpdate({deviceId,hub3Id,secretKey}) を onProgress 無しで呼ぶため core (iot.js:441-442 `if(onProgress)` false) が購読せず DFU トリガを fire-and-forget 送出し no-op unsub 関数 (undefined/{} にシリアライズ) を返す。serve/sdk 呼出側は progress push も versionTag 完了も受け取れず core/cli の onProgress ([[IOT-0031]]) と非対称。progress 観測は core/cli 経由が必須という負事実を固定する
- ref: packages/core/src/iot.js:435-454; packages/kit/src/serve/registry.js:288-305; packages/kit/src/serve/rpc-params.generated.json:1787-1812; packages/kit/sdk/ts/sesame-client.ts:458; packages/kit/sdk/python/sesame_client.py:894-896; packages/kit/src/serve/sesame.proto:746-750
- kind: surface-parity
- status: planned
- note: rpc-params/proto/ts/py はいずれも deviceId/hub3Id/secretKey のみで onProgress を持たない (1787-1812 / 746-750 / ts:458 / py:894-896)。serve/registry-helpers に iot.startFirmwareUpdate の特例分岐は無し。実装疑い: serve 越し progress が意図仕様ならサーバストリーム橋渡しが必要だが現状は黙って劣化。[[IOT-0058]] の面横断 op 列に firmware は非掲載 (LED/relay/sendIotCmd のみ)。

<!-- spec-domain: ir | prefix: IR | tests: packages/core/tests/ir, packages/core/tests/presetir, packages/kit/tests/cli -->

# 赤外線リモコン spec (IR)

ir.* (送信/学習/mode/リモコン・キー CRUD/検索/match/Matter) と presetir.* (sendIR/emitAir/emitButton) を biz3 web (useRemoteCtrl/learn) に照らして監査する。

## ir.send

学習リモコンのキー送信 (sendIR) の wire フレーム・命名トラップ・operation 分岐・キー解決と必須/拒否のエラー経路を固定する。

### [IR-0001] ir.send → sendIR WS フレームのキー集合・op が vendor と一致
- surface: core, serve, sdk, cli
- backend: cloud
- command: `hub.send` / ir.send
- branch: -
- assert: sendIR 送信フレームが {action:'biz3IRRemote', op:'sendIR', deviceId, command, operation, irType, companyID, irDeviceUUID} で、キー集合・順序が vendor sendIR と一致する (transport.js が hook の frame を 1:1 移植)
- ref: packages/core/src/transport.js:726-743; references_web/src/api/useRemoteCtrl.js:460-484
- kind: wire-fidelity
- status: planned
- note: ACTION 値 biz3IRRemote: references_web/src/constants/messageConstants.js:20 (packages/core/src/vendor/biz3/constants/messageConstants.js:20 と同値)。frame キー順序は transport.js:727-736 = useRemoteCtrl.js:467-476 と 1:1 一致を確認

### [IR-0002] ir.send の command/irDeviceUUID 写像 (remoteId→irDeviceUUID, command→command)
- surface: core
- backend: cloud
- command: `hub.send` / sendIR
- branch: -
- assert: vendor sendIR(deviceId, remoteId, command, operation, irType) の remoteId が frame.irDeviceUUID に、command が frame.command に写像される (フィールド名トラップ: remoteId は irDeviceUUID 名で送る)
- ref: references_web/src/api/useRemoteCtrl.js:461-476; packages/core/src/transport.js:735
- kind: wire-fidelity
- status: planned
- note: vendor :475 で irDeviceUUID:remoteId、:471 で command:command を確認。transport.js:731(command)/:735(irDeviceUUID) が対応

### [IR-0003] ir.send operation 分岐 (learnEmit=自己学習 / remoteEmit=プリセット)
- surface: core
- backend: cloud
- command: `hub.send` / sendIRDirect
- branch: operation=learnEmit | operation=remoteEmit | operation=undefined(irOperation未設定)
- assert: name-based 経路は remote.irOperation をそのまま frame.operation に乗せ (config に irOperation が無ければ operation は undefined になりうる)、direct 経路 (sendIRDirect) のみ operation='learnEmit' 既定で保護される。値ありの場合は vendor の learnEmit(learn/index.js:320)・remoteEmit(remote-air/index.js:370) と同じ値域になる
- ref: packages/core/src/client.js:395; packages/core/src/client.js:1389-1398; packages/core/src/transport.js:726-736; references_web/src/pages/personal/devices/wifi-module/ir/learn/index.js:320; references_web/src/pages/personal/devices/wifi-module/ir/remote-air/index.js:370
- kind: option-branch
- status: planned
- note: learn/index.js:320 は第4引数 'learnEmit'、remote-air/index.js:370 は 'remoteEmit' を確認。client.js:1389/1396 (direct) は default 'learnEmit'。client.js:395 (name-based) は remote.irOperation を渡し、transport.js:732 が fallback 無しで frame.operation=params.operation を乗せるため irOperation 未設定時は operation:undefined が wire に乗る (name-based のみ既定無し・非対称)。実装疑い: name-based send で irOperation 未設定時に operation:undefined を送ると vendor 値域 (learnEmit/remoteEmit) を外れる — config sync が irOperation を必ず埋める不変条件は spec 未定義。direct 経路の存在/シグネチャは [[IR-0122]] が固定

### [IR-0004] ir.send name-based の key 解決分岐 (UUID 直指定 vs config キー名解決)
- surface: core, cli, serve, sdk
- backend: cloud
- command: `hub.send` / ir.send
- branch: keyOrUUID=UUID形式 | keyOrUUID=キー名(config解決)
- assert: keyOrUUID が UUID_RE に一致すればそのまま command、不一致なら remote.keys[keyOrUUID] から keyUUID を引いて command にする (resolveRemote 経由)
- ref: packages/core/src/client.js:379-397
- kind: option-branch
- status: planned
- note: UUID_RE 定義 client.js:109、判定 :384、config キー解決 remote.keys?.[keyOrUUID] :385、remote 解決 resolveRemote :383 を確認

### [IR-0005] ir.send 必須 key 欠落で BAD_REQUEST
- surface: core, serve, cli
- backend: cloud
- command: `hub.send` / ir.send
- branch: key欠落
- assert: keyOrUUID が空なら badRequest('domain.client.keyRequired') を投げる (serve は need(['key'])・CLI は引数必須)
- ref: packages/core/src/client.js:382; packages/kit/src/serve/entries/ir.js:20; packages/core/src/i18n/domain.js:11
- kind: error-path
- status: planned
- note: client.js:382 badRequest('domain.client.keyRequired')、serve/entries/ir.js:20 need(params,['key'])、domain.js:11 en キー定義を確認

### [IR-0006] ir.send 未知キー名で BAD_REQUEST (利用可能キー列挙)
- surface: core
- backend: cloud
- command: `hub.send`
- branch: 未知キー名
- assert: config に存在しないキー名を渡すと badRequest('domain.client.unknownKey', {key, avail}) で利用可能キー一覧付きエラーになる
- ref: packages/core/src/client.js:385-389; packages/core/src/i18n/domain.js:12
- kind: error-path
- status: planned
- note: client.js:386-388 で avail=Object.keys(remote.keys) を組み立て badRequest('domain.client.unknownKey',{key,avail})、domain.js:12 en キー定義を確認

### [IR-0007] ir.send サーバ success:false で REJECTED
- surface: core
- backend: cloud
- command: sendIR
- branch: resp.success=false
- assert: 上流が success:false を返したら rejected('domain.transport.sendIRFailed', {detail}) を投げる (P5-1 方針1: 上流明示拒否=REJECTED)
- ref: packages/core/src/transport.js:738-741; packages/core/src/i18n/domain.js:106
- kind: error-path
- status: planned
- note: transport.js:738 if(!resp.success)→:740 throw rejected(t('domain.transport.sendIRFailed',{detail}))、domain.js:106 en キー定義を確認

### [IR-0008] ir.send 契約存在 (proto IrSend / registry ir.send / SDK)
- surface: serve, sdk
- backend: cloud
- command: IrSend / ir.send
- branch: -
- assert: registry ir.send (params remote?:string, key:string) が proto IrSendRequest (remote optional=1, key=2) と SDK 生成に 1:1 で存在し、署名が一致する
- ref: packages/kit/src/serve/entries/ir.js:16-21; packages/kit/src/serve/sesame.proto:349; packages/kit/src/serve/sesame.proto:1647-1650
- kind: contract-existence
- status: planned
- note: 全 refs 実在・行番号一致で確認。registry(ir.js:16-21 ir.send: remote required:false / key required:true)↔proto rpc IrSend:349↔message IrSendRequest:1647-1650(optional string remote=1; string key=2)が 1:1。SDK は proto から生成(packages/kit/sdk)で派生のため proto を出典とする。

### [IR-0009] ir.send 全 framing で同一封筒 (surface-parity)
- surface: serve, sdk, cli, core
- backend: cloud
- command: ir.send / hub.send
- branch: ndjson | http-ws | grpc | core直
- assert: 同一 remote/key 入力に対し core/serve(全 framing)/sdk/cli が同じ sendIR 応答封筒 (ok/result) を返す
- ref: packages/kit/src/serve/entries/ir.js:16-21; packages/core/src/client.js:379-398
- kind: surface-parity
- status: planned
- note: refs 実在・行番号一致。serve handler(ir.js:20)も cli(cli/remote.js:43, cli/session.js:168)も同一 core メソッド hub.send(client.js:379-398)へ委譲し、封筒は単一 sendIR 経路に収束 → 全 framing パリティの構造的根拠あり。

## ir.listKeys

リモコンのキー一覧取得 (getIRCodes) の wire フレーム・命名トラップ (hub3DeviceId)・応答パース・serve direct 経路の必須ペア検証を固定する。

### [IR-0010] ir.listKeys → getIRCodes WS フレーム (hub3DeviceId 命名トラップ)
- surface: core, serve, sdk, cli
- backend: cloud
- command: `hub.listKeys` / ir.listKeys
- branch: -
- assert: getIRCodes 送信フレームが {action:'biz3IRRemote', op:'getIRCodes', hub3DeviceId, remoteId, companyID} で、Hub3 UUID が deviceId ではなく hub3DeviceId、リモコンが remoteId として送られる (vendor 意図的命名差)
- ref: packages/core/src/transport.js:755-769; references_web/src/api/useRemoteCtrl.js:815-835
- kind: wire-fidelity
- status: planned
- note: refs 実在・一致。transport.js:756-762 が frame {action:ACTION_TYPES.BIZ3_IR_REMOTE, op:'getIRCodes', hub3DeviceId:params.deviceId, remoteId:params.irDeviceUUID, companyID}。BIZ3_IR_REMOTE='biz3IRRemote'(messageConstants.js:20)。web getIRCodes(815-835)が同形 message を送信し命名差を裏付け(transport.js:748-749 コメントで明示)。

### [IR-0011] ir.listKeys 応答パース (resp.data 配列 / 空配列既定)
- surface: core
- backend: cloud
- command: getIRCodes
- branch: data有 | data欠落
- assert: 応答の resp.data をキー配列として返し、欠落時は [] を返す (vendor getIRCodes 応答 message.data 1:1)
- ref: packages/core/src/transport.js:768; references_web/src/api/useRemoteCtrl.js:165-167
- kind: wire-fidelity
- status: planned
- note: refs 実在・一致。transport.js:768 = `return (resp.data || [])`。web 側 165-167 が getIRCodes 応答を message.data として扱う(case 'getIRCodes')→ data フィールド命名 1:1。

### [IR-0012] ir.listKeys serve direct 経路の必須ペア検証 (hub3DeviceId+irDeviceUUID 両方必須)
- surface: serve
- backend: cloud
- command: ir.listKeys
- branch: remote名解決 | direct(両指定) | direct片方のみ→error
- assert: hub3DeviceId か irDeviceUUID の片方だけ指定すると need(['hub3DeviceId','irDeviceUUID']) で bad_params、両方指定で getIRCodesDirect に直行、無指定は listKeys(remote名解決) に分岐する
- ref: packages/kit/src/serve/entries/ir.js:32-40; packages/core/src/client.js:1406-1413
- kind: option-branch
- status: planned
- note: refs 実在・一致。ir.js:34-39 が分岐を実装(片方指定→need(['hub3DeviceId','irDeviceUUID'])→bad_params; 両指定→getIRCodesDirect; 無指定→hub.listKeys)。need は bad_params に写像(registry-helpers.js:28-32)。client.js:1406-1413 = getIRCodesDirect 本体。

### [IR-0013] ir.listKeys サーバ success:false で REJECTED
- surface: core
- backend: cloud
- command: getIRCodes
- branch: resp.success=false
- assert: 上流が success:false を返したら rejected('domain.transport.getIRCodesFailed', {detail}) を投げる
- ref: packages/core/src/transport.js:764-766; packages/core/src/i18n/domain.js:107
- kind: error-path
- status: planned
- note: refs 実在・一致。transport.js:764-766 = `if(!resp.success) throw rejected(t('domain.transport.getIRCodesFailed',{detail:...}))`。domain.js:107 にキー定義(en)。

### [IR-0014] ir.listKeys 契約存在 (proto IrListKeys / registry / SDK)
- surface: serve, sdk
- backend: cloud
- command: IrListKeys / ir.listKeys
- branch: -
- assert: registry ir.listKeys (remote?, hub3DeviceId?, irDeviceUUID?) が proto IrListKeysRequest (全 optional 1-3) と SDK 生成に 1:1 で存在する
- ref: packages/kit/src/serve/entries/ir.js:22-41; packages/kit/src/serve/sesame.proto:351; packages/kit/src/serve/sesame.proto:1651-1655
- kind: contract-existence
- status: planned
- note: 全 refs 実在・行番号一致。registry(ir.js:22-41: remote/hub3DeviceId/irDeviceUUID 全 required:false)↔proto rpc IrListKeys:351↔message IrListKeysRequest:1651-1655(optional remote=1, hub3DeviceId=2, irDeviceUUID=3)が 1:1。SDK は proto から生成で派生。

## ir.learn

学習フロー (REGISTER→capture→CONTROL→addIRCode) の合成・命名・波形抽出・ノイズ閾値・timeout/空波形のエラー・モード復帰冪等・CLI 引数/出力・契約存在を固定する。

### [IR-0015] ir.learn 学習シーケンス順序 (REGISTER→subscribe→capture→unsubscribe→CONTROL→addIRCode)
- surface: core
- backend: cloud
- command: `hub.learnIR` / learnIRKey
- branch: -
- assert: learnIRKey が setIRMode(REGISTER)→subscribeIRData→波形受信→unsubscribe→setIRMode(CONTROL)→addIRCode の順で実行する。vendor のプリミティブ (setIRMode/subscribeIRData/addIRCode) を kit 側で逐次合成した composite であり、vendor learn/index.js は React hook で同じ部品を非逐次に使う
- ref: packages/core/src/ir.js:507-563; references_web/src/pages/personal/devices/wifi-module/ir/learn/index.js:153-167; references_web/src/pages/personal/devices/wifi-module/ir/learn/index.js:216-251; references_web/src/pages/personal/devices/wifi-module/ir/learn/index.js:456-468
- kind: wire-fidelity
- status: planned
- note: 修正: 元 assert の『vendor learn/index.js のフロー 1:1』は未確認: vendor は単一逐次関数を持たず、subscribeIRDataChanges を mount 時に張り (index.js:460)、setMode で REGISTER/CONTROL を別途切替 (153-167)、addIRCode はデータ callback 内 (231)、その後 exitLearnMode=CONTROL (243)。vendor の学習フローに明示 unsubscribe は無く cleanup は setMode(CONTROL) (467) のみ。よって kit の逐次 unsubscribe は意図的逸脱。setIRMode(REGISTER) を含む setMode 定義 (153-167) と mount/cleanup (456-468) を ref に追加し、assert を composite と明記して修正

### [IR-0016] ir.learn の addIRCode フレーム (irCode 形 keyUUID/name/uuid/deviceId/data)
- surface: core
- backend: cloud
- command: learnIRKey / addIRCode
- branch: -
- assert: addIRCode 送信フレームが {action, op:'addIRCode', irCode:{keyUUID, name, uuid:remoteId, deviceId:hub3DeviceId, data:波形}, companyID} で、irCode のフィールド集合が vendor の newIrCode と一致する
- ref: packages/core/src/ir.js:553-561; packages/core/src/ir.js:300-305; references_web/src/pages/personal/devices/wifi-module/ir/learn/index.js:222-228; references_web/src/api/useRemoteCtrl.js:842-861
- kind: wire-fidelity
- status: planned
- note: 確認: core:553-561 が {keyUUID,name,uuid:remoteId,deviceId:hub3DeviceId,data} を構築、core:300-305 が op:'addIRCode' フレーム化。vendor newIrCode (learn/index.js:222-228) は {keyUUID,name,uuid,deviceId,data} で集合一致。useRemoteCtrl.js:842-861 (addIRCode 送信) は irCode を透過。行番号修正: 221-228→222-228 (newIrCode 本体は 222 開始)

### [IR-0017] ir.learn keyUUID はクライアント発番 (サーバ応答 keyUUID を使わない)
- surface: core
- backend: cloud
- command: learnIRKey
- branch: -
- assert: keyUUID は generateUUID() でクライアント発番され、send の command に使われる。サーバ応答の keyUUID は採用しない (vendor learn/index.js:223 と同様)
- ref: packages/core/src/ir.js:553-556; references_web/src/pages/personal/devices/wifi-module/ir/learn/index.js:223
- kind: wire-fidelity
- status: planned
- note: 確認: core:553 keyUUID=generateUUID()、戻り値 keyUUID を呼出元が command に使用 (504-505 JSDoc)。vendor learn/index.js:223 keyUUID:biz3utils.generateUUID() で発番、サーバ応答 keyUUID 不採用。一致

### [IR-0018] ir.learn subscribeIRData トピック (hub3/{deviceId}/ir/learned/data)
- surface: core
- backend: cloud
- command: subscribeIRData
- branch: -
- assert: subscribeIRData ack フレームの topic が `hub3/${deviceId}/ir/learned/data` で vendor の topic 文字列と一致する
- ref: packages/core/src/ir.js:59; packages/core/src/ir.js:380-389; references_web/src/api/useRemoteCtrl.js:697-720
- kind: wire-fidelity
- status: planned
- note: 確認: core:59 dataTopic=`hub3/${deviceId}/ir/learned/data`、core:381-388 が同 topic を ackFrame に設定。vendor useRemoteCtrl.js:699 topic=`hub3/${deviceId}/ir/learned/data`、703-709 で同フレーム送信。文字列一致

### [IR-0019] ir.learn 波形抽出パス (msg.data.data)
- surface: core
- backend: cloud
- command: learnIRKey / subscribeIRDataRsp
- branch: -
- assert: subscribeIRDataRsp の波形を msg.data.data から取り出す (vendor learn/index.js:219,227 の response.data.data と同一パス)
- ref: packages/core/src/ir.js:530; references_web/src/pages/personal/devices/wifi-module/ir/learn/index.js:219-227
- kind: wire-fidelity
- status: planned
- note: 確認: core:530 const data=msg?.data?.data。vendor learn/index.js:219 response.data.data.length (size ログ)、227 data:response.data.data。同一パス

### [IR-0020] ir.learn ノイズ波形フィルタ (length<=50 は待機継続)
- surface: core
- backend: cloud
- command: learnIRKey
- branch: 波形length<=50(ノイズ) | length>50(採用)
- assert: 受信波形 length<=50 はノイズ扱いで採用せず timeout まで待機継続する (vendor remote-match/index.js:142-149 と同基準)
- ref: packages/core/src/ir.js:539-543; references_web/src/pages/personal/devices/wifi-module/ir/remote-match/index.js:142-149
- kind: option-branch
- status: planned
- note: 確認: core:541 if(data.length<=50) return (待機継続、to タイマー走行継続 539-543 コメント)。vendor remote-match/index.js:142 `!response.data.data || response.data.data.length <= 50` → 143 'learning data is empty, continue waiting...' で 144-148 再 REGISTER 待機。同基準 (<=50)

### [IR-0021] ir.learn timeout でタイムアウトエラー (既定60s)
- surface: core, serve, cli
- backend: cloud
- command: `hub.learnIR` / learnIRKey
- branch: timeoutMs未指定(既定60000) | timeoutMs指定
- assert: ボタン押下待ちが timeoutMs (既定 LEARN_DEFAULT_TIMEOUT_MS=60000) を超えると timeoutError('domain.ir.learnTimeout') を投げ、finally で必ず CONTROL 復帰する
- ref: packages/core/src/ir.js:48-49; packages/core/src/ir.js:508; packages/core/src/ir.js:521-522; packages/core/src/ir.js:546-551; packages/core/src/i18n/domain.js:61
- kind: error-path
- status: planned
- note: 確認: core:49 LEARN_DEFAULT_TIMEOUT_MS=60_000、508 timeoutMs=p.timeoutMs??LEARN_DEFAULT_TIMEOUT_MS、522 setTimeout(()=>reject(timeoutError(t('domain.ir.learnTimeout'))),timeoutMs)、546-551 finally で sub.unsubscribe()+setIRMode(CONTROL)。i18n domain.js:61 'domain.ir.learnTimeout' 定義済 (ja 176 も同)。全 ref 支持

### [IR-0022] ir.learn 空波形で誤保存防止エラー (vendor 逸脱の意図的明示失敗)
- surface: core
- backend: cloud
- command: learnIRKey
- branch: data==null/length0 | success===false
- assert: 波形が null/空なら rejected('domain.ir.learnEmptyWaveform')、msg.success===false なら rejected('domain.ir.learnFailed', {detail}) を投げて壊れたキー保存を防ぐ
- ref: packages/core/src/ir.js:524-538; packages/core/src/i18n/domain.js:62-63; references_web/src/pages/personal/devices/wifi-module/ir/learn/index.js:217-249
- kind: error-path
- status: planned
- note: 確認済: ir.js:525 が `msg?.success === false`→learnFailed(527)、534-538 が data==null||length===0→learnEmptyWaveform。domain.js:62=learnFailed,63=learnEmptyWaveform。biz3 learn/index.js:218 `if(response.success)`/219 `response.data.data`/245-249 失敗else に忠実移植。意図的逸脱コメントは ir.js:531-541 にあり

### [IR-0023] ir.learn finally で CONTROL 復帰 (例外時も確実にモードを戻す)
- surface: core
- backend: cloud
- command: learnIRKey
- branch: 成功時 | 例外/timeout時
- assert: learnIRKey の finally で必ず sub.unsubscribe() と setIRMode(CONTROL) を実行する (例外でも REGISTER に残さない)
- ref: packages/core/src/ir.js:546-551
- kind: idempotency
- status: planned
- note: 確認済: 546 `} finally {`、547 `sub.unsubscribe()`、548-550 setIRMode(MODE.CONTROL) を try/catch で実行、551 `}`。波形待ち Promise(521-545) が reject/timeout しても finally で確実に復帰

### [IR-0024] ir.learn onPrompt コールバック (学習モード突入後に1回呼ぶ)
- surface: core, cli
- backend: cloud
- command: `hub.learnIR` / learnIRKey
- branch: onPrompt有 | 無
- assert: REGISTER 突入後・波形待ち前に onPrompt() が呼ばれ、CLI は cli.pointRemote をstderr に出す (ユーザにボタン押下を促す)
- ref: packages/core/src/ir.js:520; packages/kit/src/cli/ir.js:37-39; packages/kit/src/i18n/cli.js:146
- kind: option-branch
- status: planned
- note: 確認済: ir.js:510-511 で REGISTER+subscribe 後、520 `if(p.onPrompt) try{p.onPrompt()}` を波形待ち Promise(521)の直前で実行。cli/ir.js:38 `onPrompt: ()=>console.error(t('cli.pointRemote'))`(stderr)。cli.js:146 pointRemote 文言存在

### [IR-0025] ir.learn CLI keyname 必須検証 (exit code 2)
- surface: cli
- backend: cloud
- command: `sesame ir learn [remote] [keyname]`
- branch: keyname引数 | 対話prompt | 欠落→exit2
- assert: keyName が未指定かつ対話不可なら die(cli.keynameRequired, 2) で終了コード 2、対話可なら promptText で補完する
- ref: packages/kit/src/cli/ir.js:31-34; packages/kit/src/i18n/cli.js:144
- kind: error-path
- status: planned
- note: 確認済: cli/ir.js:31-33 `if(!keyName && canPrompt(program)) keyName=await promptText(t('cli.learnKeyName'))`、34 `if(!keyName) die(t('cli.keynameRequired'),2)`。errors.js:49 `die(msg,code)` 第2引数=exit code。cli.js:144 keynameRequired 存在。commander配線は cli/ir.js:324-326

### [IR-0026] ir.learn CLI --json 出力封筒
- surface: cli
- backend: cloud
- command: `sesame ir learn`
- branch: --json | 人間可読
- assert: --json 時は {ok:true, key, keyUUID, captured, saved} 形 JSON、非 --json 時は cli.okLearned / keyUuid / irData の人間可読出力になる
- ref: packages/kit/src/cli/ir.js:42-49; packages/kit/src/i18n/cli.js:147-149
- kind: option-branch
- status: planned
- note: 確認済: cli/ir.js:42-49 out(opts.json, 人間可読fn, {ok:true,key:keyName,...result})。result={keyUUID,captured,saved}(ir.js:562)を spread → JSON 封筒 {ok,key,keyUUID,captured,saved}。人間可読は 43 okLearned/44 keyUuid/47 irData。cli.js:147-149 に該当文言 3 件

### [IR-0027] ir.learn config 反映 (キー名→keyUUID を ConfigStore に書く)
- surface: core
- backend: local, cloud
- command: `hub.learnIR`
- branch: configStore有 | 無
- assert: 学習成功後 configStore があれば remote.keys[keyName]=keyUUID を updateRemoteKeys で永続化する (以後 send でキー名解決可能になる)
- ref: packages/core/src/client.js:759-765
- kind: idempotency
- status: planned
- note: 確認済: client.js:760 keyUUID=result.keyUUID、761 `if(keyUUID && this._configStore)`、762 `cur=remote.keys||{}`、763 `cur[keyName]=keyUUID`、764 `this._configStore.updateRemoteKeys(rName,cur)`。クライアント発番 keyUUID(ir.js:553)を local config へ永続化するため backend=local+cloud は妥当

### [IR-0028] ir.learn 契約存在 (proto IrLearn / registry / SDK)
- surface: serve, sdk
- backend: cloud
- command: IrLearn / ir.learn
- branch: -
- assert: registry ir.learn (remote:string, key:string, timeoutMs?:number) が proto IrLearnRequest (remote=1, key=2, optional double timeoutMs=3) と SDK 生成に 1:1 で存在する
- ref: packages/kit/src/serve/entries/ir.js:42-51; packages/kit/src/serve/sesame.proto:353; packages/kit/src/serve/sesame.proto:1656-1660
- kind: contract-existence
- status: planned
- note: 確認済: entries/ir.js:42-51 'ir.learn' params=[remote(req,S),key(req,S),timeoutMs(opt,N)] result='{keyUUID,captured,saved}'。proto:353 `rpc IrLearn(IrLearnRequest)`。proto:1656-1660 message IrLearnRequest{string remote=1; string key=2; optional double timeoutMs=3;} と 1:1 一致

## ir.getMode

現在の IR mode 取得 (getIRMode) の wire・値域 (CONTROL=0/REGISTER=1) 解釈・hub3 単一解決・拒否エラー・契約/CLI 出力を固定する。

### [IR-0029] ir.getMode → getIRMode WS フレーム
- surface: core, serve, sdk, cli
- backend: cloud
- command: `hub.getIRMode` / ir.getMode
- branch: -
- assert: getIRMode 送信フレームが {action:'biz3IRRemote', op:'getIRMode', deviceId, companyID} で vendor と一致し、resp.data を返す
- ref: packages/core/src/ir.js:353-358; references_web/src/api/useRemoteCtrl.js:611-630
- kind: wire-fidelity
- status: planned
- note: 確認済: ACTION=ACTION_TYPES.BIZ3_IR_REMOTE='biz3IRRemote' (ir.js:47), vendor useRemoteCtrl.js:616-621 のフレームと 1:1。ir.js:357 が resp.data を返す。

### [IR-0030] ir.getMode mode 値域 (CONTROL=0 / REGISTER=1) の解釈
- surface: core
- backend: cloud
- command: getIRMode
- branch: data.ir_mode | data.mode | data=number
- assert: 応答 mode が data.ir_mode / data.mode / 数値 data いずれの形でも CONTROL=0/REGISTER(LEARN)=1 として解釈できる (vendor learn/index.js:175-186 の読み分け)
- ref: packages/core/src/ir.js:51-54; references_web/src/pages/personal/devices/wifi-module/ir/learn/index.js:175-186
- kind: wire-fidelity
- status: planned
- note: 確認済: core MODE={CONTROL:0,REGISTER:1} (ir.js:51-54)。vendor の enum 定義は learn/index.js:88-91 {CONTROL:0,LEARN:1} (core の REGISTER=vendor の LEARN)。引用の :175-186 は getCurrentIRMode が response.data.ir_mode||response.data.mode、または数値 response.data を読み分けて mode===IR_MODE.LEARN(=1) を判定する箇所で、assert の『3 形の読み分け』を直接支持する。

### [IR-0031] ir.getMode hub3 名省略時の単一解決分岐
- surface: core, serve, cli
- backend: cloud
- command: `hub.getIRMode` / ir.getMode
- branch: hub3名指定 | 省略(単一自動) | 省略(複数→error)
- assert: hub3 名省略時、config に Hub3 が 1 台なら自動選択、複数/0 台なら badRequest('domain.client.noHub3Specified')
- ref: packages/core/src/client.js:894-897; packages/core/src/client.js:931-938; packages/core/src/i18n/domain.js:19
- kind: option-branch
- status: planned
- note: 確認済: getIRMode(hub3Name) が _resolveHub3(hub3Name) を呼ぶ (client.js:896)。_resolveHub3 (931-942) は chosen=name||(names.length===1?names[0]:null)、!chosen で badRequest('domain.client.noHub3Specified') (938)。domain.js:19 にキー実在。

### [IR-0032] ir.getMode サーバ拒否で assertSuccess (strict) エラー
- surface: core
- backend: cloud
- command: getIRMode
- branch: resp.success=false
- assert: 応答が success:false なら assertSuccess(resp, 'getIRMode', {strict:true}) がエラーを投げる
- ref: packages/core/src/ir.js:356
- kind: error-path
- status: planned
- note: 確認済: ir.js:356 が assertSuccess(resp, 'getIRMode', { strict: true })。

### [IR-0033] ir.getMode 契約存在 + CLI --json 出力
- surface: serve, sdk, cli
- backend: cloud
- command: IrGetMode / ir.getMode / sesame ir mode get
- branch: --json | 人間可読
- assert: registry ir.getMode (hub3?:string) が proto IrGetModeRequest (optional hub3=1) と SDK に 1:1 で存在し、CLI は --json で {mode} を、非 json で cli.mode を出す
- ref: packages/kit/src/serve/entries/ir.js:96-101; packages/kit/src/serve/sesame.proto:369; packages/kit/src/serve/sesame.proto:1689-1691; packages/kit/sdk/ts/sesame-client.ts:471; packages/kit/sdk/python/sesame_client.py:919-921; packages/kit/src/cli/ir.js:58-63
- kind: contract-existence
- status: planned
- note: 修正: assert が『SDK に 1:1 で存在』と主張するが元 refs は SDK 出典を欠いていた。生成 SDK の実在出典を追加 — TS sesame-client.ts:471 getMode({hub3?}) → _call('ir.getMode'), Python sesame_client.py:919-921 getMode(*,hub3=None) → _call('ir.getMode')。registry entries/ir.js:96-101 (params hub3 required:false, result:'mode')、proto:369 rpc IrGetMode、proto:1689-1691 IrGetModeRequest{optional string hub3=1}、CLI cmdIRModeGet (ir.js:58-63) は out(opts.json, ()=>console.log(t('cli.mode',{mode})), {mode}) で json={mode}/非 json=cli.mode をいずれも確認済。

## ir.setMode

IR mode 設定 (setIRMode) の wire・CLI mode 値域検証・serve 必須・拒否・出力封筒・契約存在を固定する。

### [IR-0034] ir.setMode → setIRMode WS フレーム
- surface: core, serve, sdk, cli
- backend: cloud
- command: `hub.setIRMode` / ir.setMode
- branch: mode=0(CONTROL) | mode=1(REGISTER)
- assert: setIRMode 送信フレームが {action:'biz3IRRemote', op:'setIRMode', deviceId, mode, companyID} で vendor と一致し、mode に 0/1 がそのまま乗る
- ref: packages/core/src/ir.js:365-370; references_web/src/api/useRemoteCtrl.js:638-658
- kind: wire-fidelity
- status: planned
- note: 確認済: ir.js:366 frame={action:ACTION,op:'setIRMode',deviceId,mode,companyID} が vendor useRemoteCtrl.js:643-649 {action,op:'setIRMode',deviceId,mode,companyID} と 1:1。mode は変換なくそのまま乗る。

### [IR-0035] ir.setMode CLI mode 値域検証 (0/1 以外で exit 2, CONTROL/REGISTER ラベル)
- surface: cli
- backend: cloud
- command: `sesame ir mode set <mode> [hub3]`
- branch: mode=0 | mode=1 | mode∉{0,1}→exit2
- assert: Number(mode) が 0/1 以外なら die(cli.modeMustBe, 2) で終了コード 2、有効なら setIRMode に渡し出力で 0→CONTROL / 1→REGISTER ラベルを付与する
- ref: packages/kit/src/cli/ir.js:71-78; packages/kit/src/i18n/cli.js:151
- kind: error-path
- status: planned
- note: 確認済: cmdIRModeSet (cli/ir.js:71-78) は m=Number(mode); if(![0,1].includes(m)) die(t('cli.modeMustBe'),2) (73); 有効時 hub.setIRMode(hub3Name,m); ラベルは m===0?CONTROL:REGISTER (76)。i18n/cli.js:151 'cli.modeMustBe':'mode must be 0 (CONTROL) or 1 (REGISTER)'。command 文字列は CLI 登録 (ir.js:330) の 'set <mode> [hub3]' と一致。(2 候補マージ: CLI mode 値域検証 + ir mode set validation は同一 surface/command/branch/assert)

### [IR-0036] ir.setMode serve mode 必須検証
- surface: serve
- backend: cloud
- command: ir.setMode
- branch: mode欠落→bad_params
- assert: ir.setMode は need(['mode']) で mode 欠落時 bad_params を返す (hub3 は optional)
- ref: packages/kit/src/serve/entries/ir.js:102-107; packages/kit/src/serve/registry-helpers.js:32-38
- kind: error-path
- status: planned
- note: 確認済: entries/ir.js:106 handler が requireAuth(daemon)→need(params,['mode'])→hub.setIRMode(params.hub3??null, params.mode)。params.hub3 は optional schema(L104)。need (registry-helpers.js:32-38) は欠落キーで RpcError(INVALID_PARAMS, kind=BAD_PARAMS) を throw。

### [IR-0037] ir.setMode サーバ拒否で assertSuccess (strict) エラー
- surface: core
- backend: cloud
- command: setIRMode
- branch: resp.success=false
- assert: 応答が success:false なら assertSuccess(resp, 'setIRMode', {strict:true}) がエラーを投げる
- ref: packages/core/src/ir.js:365-370
- kind: error-path
- status: planned
- note: 確認済: core/ir.js の setIRMode は L365-370。assertSuccess(resp,'setIRMode',{strict:true}) は L368。ref を単行 :368 から関数全体 :365-370 に拡張 (frame 構築〜assertSuccess の境界を含める)。

### [IR-0038] ir.setMode CLI --json 出力封筒 (mode + label)
- surface: cli
- backend: cloud
- command: `sesame ir mode set`
- branch: --json | 人間可読
- assert: --json 時は {ok:true, mode} 形、非 json 時は cli.okMode に CONTROL/REGISTER ラベルを付けて出力する
- ref: packages/kit/src/cli/ir.js:71-78; packages/kit/src/i18n/cli.js:152
- kind: option-branch
- status: planned
- note: 確認済: cmdIRModeSet (cli/ir.js:71-78) は out(opts.json, ()=>console.log(t('cli.okMode',{mode:m,label:m===0?'CONTROL':'REGISTER'})), {ok:true, mode:m})。i18n/cli.js:152 'cli.okMode'='OK: mode={mode} ({label})'。

### [IR-0039] ir.setMode 契約存在 (proto IrSetMode / registry / SDK)
- surface: serve, sdk
- backend: cloud
- command: IrSetMode / ir.setMode
- branch: -
- assert: registry ir.setMode (hub3?:string, mode:number) が proto IrSetModeRequest (optional hub3=1, double mode=2) と SDK に 1:1 で存在する
- ref: packages/kit/src/serve/entries/ir.js:102-107; packages/kit/src/serve/sesame.proto:371; packages/kit/src/serve/sesame.proto:1692-1695; packages/kit/sdk/ts/sesame-client.ts:489
- kind: contract-existence
- status: planned
- note: 確認済かつ SDK ref 補完: registry entries/ir.js:102-107 (hub3 optional S, mode required N)。proto:371 rpc IrSetMode (IrSetModeRequest), proto:1692-1695 IrSetModeRequest {optional string hub3=1; double mode=2}。TS SDK (sdk/ts/sesame-client.ts:489 setMode:(params:{hub3?:string;mode:number})=>this._call('ir.setMode',params))。Python SDK (sdk/python/sesame_client.py:955-957 def setMode(*,hub3=None,mode:float)) も同形で 1:1 確認済。grpc-methods.generated.json:1812-1818 が IrSetMode→ir.setMode/optionalScalars:['hub3'] を束ねる。

## ir.mode (cross-cutting)

ir.* 全体の認証ガード・学習モード復帰の冪等・deviceId フィルタ・i18n 網羅を固定する。

### [IR-0040] ir.* subscribe 系の require-auth (全 ir.* が requireAuth)
- surface: serve
- backend: cloud
- command: ir.send / ir.listKeys / ir.learn / ir.getMode / ir.setMode
- branch: 未認証
- assert: 全 ir.* handler が requireAuth(daemon) を先頭で呼び、未ログイン状態では認証エラー封筒を返す
- ref: packages/kit/src/serve/entries/ir.js:20; packages/kit/src/serve/entries/ir.js:33; packages/kit/src/serve/entries/ir.js:50; packages/kit/src/serve/entries/ir.js:100; packages/kit/src/serve/entries/ir.js:106; packages/kit/src/serve/registry-helpers.js:55-62
- kind: error-path
- status: planned
- note: 確認済: entries/ir.js 内の全 14 handler が requireAuth(daemon) を先頭で呼ぶ (grep: requireAuth(daemon) 14件 = handler 14件)。引用 5 行 (L20 ir.send / L33 ir.listKeys / L50 ir.learn / L100 ir.getMode / L106 ir.setMode) は代表抜粋で、addRemote/deleteRemote/rename/match/addRemoteToMatter 等残り 9 件も同様。requireAuth (registry-helpers.js:55-62) は authState==='expired' で NOT_AUTHENTICATED、!hub.connected で CONNECTION_LOST を throw。

### [IR-0041] ir learn/onIRLearned のモード復帰冪等 (CONTROL 復帰の二重防止)
- surface: core
- backend: cloud
- command: `hub.onIRLearned`
- branch: 明示cleanup | close()自動cleanup
- assert: onIRLearned の cleanup は cleaned フラグで二重実行を防ぎ、unsubscribe + setIRMode(CONTROL) を best-effort で一度だけ行う (close() からも安全に呼べる)
- ref: packages/core/src/client.js:1510-1536
- kind: idempotency
- status: planned
- note: 確認済: client.js:1510 async onIRLearned。L1522 let cleaned=false; L1523-1532 cleanup=async()=>{ if(cleaned)return; cleaned=true; this._pendingCleanups.delete(cleanup); off(); sub.unsubscribe(); try{ await setIRMode(CONTROL) }catch{} }。L1534 _pendingCleanups.add(cleanup) で close() 自動経路に登録。cleaned フラグで二重実行防止・setIRMode(CONTROL) を try/catch best-effort・一度だけ、全て一致。

### [IR-0042] IR mode/data subscribe の deviceId フィルタ (他デバイス push 無視)
- surface: core
- backend: cloud
- command: subscribeIRData / subscribeIRMode
- branch: 自デバイスpush | 他デバイスpush
- assert: subscribeIRDataRsp/subscribeIRModeRsp の msg.deviceId を normalizeUuid 比較し、対象外 deviceId の push はリスナに配らない (独自追加フィルタ; vendor は全配布)
- ref: packages/core/src/ir.js:397-403; packages/core/src/ir.js:437-443; references_web/src/api/useRemoteCtrl.js:306-333
- kind: option-branch
- status: planned
- note: 確認済: core/ir.js:397-403 (subscribeIRData) は normalDeviceId=normalizeUuid(deviceId); subscribe('biz3IRRemote:subscribeIRDataRsp', msg=>{ if(msg?.deviceId && normalizeUuid(msg.deviceId)!==normalDeviceId) return; ...})。L437-443 (subscribeIRMode) は normalDeviceIdMode で同一パターン。vendor useRemoteCtrl.js:306-333 (handleIRModeSubscriptionResponse / handleIRDataSubscriptionResponse) は subscriptions.forEach で全購読者へ無条件配布しデバイスフィルタを持たない → '独自追加フィルタ; vendor は全配布' を裏付け。

### [IR-0043] IR slice i18n キー網羅 (en/ja で learn/mode/send 文言が揃う)
- surface: cli, core
- backend: local
- command: ir learn / mode / send 文言
- branch: en | ja
- assert: cli.* (learnKeyName/keynameRequired/switchingLearnMode/pointRemote/okLearned/mode/modeMustBe/okMode) と domain.ir.* (subscribeIRDataFailed/subscribeIRModeFailed/learnTimeout/learnFailed/learnEmptyWaveform/addIRRemoteDeviceUUIDRequired)・domain.transport.sendIRFailed/getIRCodesFailed が en/ja 両カタログに欠落なく存在する
- ref: packages/kit/src/i18n/cli.js:142-152; packages/core/src/i18n/domain.js:59-64; packages/core/src/i18n/domain.js:106-107
- kind: i18n
- status: planned
- note: 確認済: en cli.* 142/144/145/146/147/150/151/152, ja 563/565/566/567/568/571/572/573; domain.ir.* en 59-64 (subscribeIRDataFailed:59/subscribeIRModeFailed:60 を含む) / ja 174-179; sendIRFailed/getIRCodesFailed en 106-107 / ja 221-222。subscribe 系 error-path は [[IR-0125]] が固定

## listRemotes

リモコン一覧取得 (getRemoteList) の wire・ページング既定・応答正規化・CLI irType/出力封筒を固定する。

### [IR-0044] getRemoteList wire frame (action/op/type/companyID/pagination) が vendor と 1:1
- surface: core, serve, sdk, cli
- backend: cloud
- command: listIRRemotes / ir.listRemotes / sesame ir remote-list
- branch: -
- assert: getRemoteList の送信フレームが {action:'biz3IRRemote', op:'getRemoteList', type, companyID, pagination:{page,pageSize}} のキー集合・op 値で vendor getRemoteList と一致する
- ref: references_web/src/api/useRemoteCtrl.js:361-370; references_web/src/constants/messageConstants.js:20; packages/core/src/ir.js:82-88
- kind: wire-fidelity
- status: planned
- note: ACTION = ACTION_TYPES.BIZ3_IR_REMOTE = 'biz3IRRemote' (messageConstants.js:20)。serve 配線 packages/kit/src/serve/entries/ir.js:52,57、sdk openrpc.json:10215 で確認

### [IR-0045] getRemoteList の page/pageSize 既定値 (1 / 200)
- surface: core
- backend: cloud
- command: listIRRemotes / ir.getRemoteList
- branch: page 指定あり | page 省略(=1) | pageSize 省略(=200)
- assert: pagination.page 省略時 1、pageSize 省略時 200 がフレームに乗る (vendor の defaultPageSize=200, getRemoteList page=1 既定と一致)
- ref: references_web/src/api/useRemoteCtrl.js:21; references_web/src/api/useRemoteCtrl.js:349-350; packages/core/src/ir.js:87
- kind: option-branch
- status: planned
- note: 確認済: vendor defaultPageSize=200 (line 21), getRemoteList(type,page=1,pageSize=defaultPageSize) (349-350); core p.page??1 / p.pageSize??200 (ir.js:87)

### [IR-0046] getRemoteList 応答の {list, pagination} 取り出し (message.data.data / message.data.pagination)
- surface: core, serve
- backend: cloud
- command: listIRRemotes / ir.listRemotes
- branch: data あり | data 欠落(=[]) | pagination 欠落(=null)
- assert: 応答の一覧本体を resp.data.data から、ページングを resp.data.pagination から取り出し、欠落時 [] / null にフォールバックする (vendor handleRemoteResponse の読み方と一致)
- ref: references_web/src/api/useRemoteCtrl.js:44-46; packages/core/src/ir.js:95-96
- kind: payload-fidelity
- status: planned
- note: 確認済: vendor responseData=message.data||{}, list=responseData.data||[], paginationInfo=responseData.pagination||{} (44-46); core d.data??[] / d.pagination??null (ir.js:95-96)

### [IR-0047] remote-list --json 出力封筒 ({count, remotes, pagination})
- surface: cli
- backend: cloud
- command: `sesame ir remote-list <irType> --json`
- branch: --json あり | テキスト
- assert: --json 時に {count, remotes, pagination} を出力し、テキスト時は alias||name と irDeviceUUID||uuid を列挙する
- ref: packages/kit/src/cli/ir.js:140-148
- kind: option-branch
- status: planned
- note: 確認済: out(opts.json, テキスト時 r.alias||r.name||"(no name)" / r.irDeviceUUID||r.uuid (line 145), json 封筒 {count, remotes:list, pagination} (line 147))

## searchRemotes

プリセット検索 (searchRemoteList) の wire・固定ページング・応答 list 取り出し・searchTerm 必須・出力封筒を固定する。

### [IR-0048] searchRemoteList wire frame (op/type/companyID/searchTerm/pagination 1000)
- surface: core, serve, sdk, cli
- backend: cloud
- command: searchPresetIRRemotes / ir.searchRemotes / sesame ir search
- branch: -
- assert: searchRemoteList フレームが {action,op:'searchRemoteList',type,companyID,searchTerm,pagination:{page:1,pageSize:1000}} で vendor と一致 (ページング固定値含む)
- ref: references_web/src/api/useRemoteCtrl.js:404-414; packages/core/src/ir.js:108-115
- kind: wire-fidelity
- status: planned
- note: 確認済: vendor page=1/pageSize=1000 固定 (410-413), 引数に露出しない; core pagination:{page:1,pageSize:1000} (ir.js:114)。serve ir.searchRemotes packages/kit/src/serve/entries/ir.js:59,64、sdk openrpc.json:10254、cli `ir search <irType> <term>` (cli/ir.js:340) で確認

### [IR-0049] searchRemoteList 応答 list 取り出し (message.data.data)
- surface: core
- backend: cloud
- command: searchPresetIRRemotes / ir.searchRemoteList
- branch: data あり | data 欠落(=[])
- assert: 検索応答の一覧を resp.data.data から取り出し欠落時 [] にする (vendor searchResponseData.data の読み方と一致)
- ref: references_web/src/api/useRemoteCtrl.js:60-61; packages/core/src/ir.js:119-120
- kind: payload-fidelity
- status: planned
- note: 行番号修正: vendor の data 取り出しは 60-61 (62 は console.log)、kit の取り出しは 119-120 (118 はコメント)。両者一致を確認。

### [IR-0050] search の searchTerm 必須検証 (欠落で exit 2)
- surface: cli, serve
- backend: cloud, local
- command: `sesame ir search <irType> <term>` / ir.searchRemotes
- branch: term あり | term 欠落
- assert: searchTerm 欠落時 CLI は die(exit 2, cli.searchTermRequired)、serve は need() で INVALID_PARAMS/bad_params を返す
- ref: packages/kit/src/cli/ir.js:161; packages/kit/src/serve/entries/ir.js:64; packages/kit/src/serve/registry-helpers.js:32-38
- kind: error-path
- status: planned
- note: cli:161 = if(!term) die(...,2); serve:64 = need(params,["type","searchTerm"]); registry-helpers:32-38 = need() が RPC.INVALID_PARAMS/KIND.BAD_PARAMS を throw。全て確認。

### [IR-0051] search --json 出力封筒 ({count, results})
- surface: cli
- backend: cloud
- command: `sesame ir search --json`
- branch: --json あり | テキスト
- assert: --json 時 {count, results}、テキスト時 brandName||name / modelName||model / uuid を列挙する
- ref: packages/kit/src/cli/ir.js:166-171
- kind: option-branch
- status: planned
- note: 行番号修正 164-172→166-171: out() 封筒+テキスト分岐の実体。166=out(), 167-170=テキスト列挙(brandName||name/modelName||model/uuid), 171=}, {count, results}。確認。

## addRemote

リモコン追加 (addIRRemote) の wire・remote オブジェクト形・uuid 補完・deviceUUID 必須・上限ロジック・CLI 入力契約を固定する。

### [IR-0052] addIRRemote wire frame (op/remote/companyID)
- surface: core, serve, sdk, cli
- backend: cloud
- command: addIRRemoteServer / ir.addRemote / sesame ir remote-add
- branch: -
- assert: addIRRemote フレームが {action,op:'addIRRemote',remote,companyID} のキー集合で vendor addIRRemote と一致する
- ref: references_web/src/api/useRemoteCtrl.js:534-539; packages/core/src/ir.js:195
- kind: wire-fidelity
- status: planned
- note: vendor useRemoteCtrl.js:534-539 の message = {action, op:'addIRRemote', remote, companyID} と kit ir.js:195 frame のキー集合一致を確認。

### [IR-0053] addIRRemote の remote オブジェクト形 (uuid/model/state/alias/code/type/deviceUUID/keys)
- surface: core
- backend: cloud
- command: addIRRemoteServer / ir.addIRRemote
- branch: self-learn(learn/index.js) | preset(remote-air/non-air)
- assert: 送信 remote のフィールド集合が vendor remoteToSave (uuid/model/state/alias/code/type/deviceUUID/keys) と一致する (旧 hub3DeviceId/name/irOperation は存在しない)
- ref: references_web/src/pages/personal/devices/wifi-module/ir/learn/index.js:261-270; references_web/src/pages/personal/devices/wifi-module/ir/remote-air/index.js:512-521; references_web/src/pages/personal/devices/wifi-module/ir/remote-non-air/index.js:264-273
- kind: wire-fidelity
- status: planned
- note: 3 経路全ての remoteToSave リテラル (uuid/model/state/alias/code/type/deviceUUID/keys) を実在確認。行範囲一致 (learn:261-270, air:512-521, non-air:264-273)。

### [IR-0054] addIRRemote の uuid 自動補完 (省略時 generateUUID)
- surface: core
- backend: cloud, local
- command: ir.addIRRemote
- branch: uuid 指定 | uuid 省略(=generateUUID)
- assert: remote.uuid 省略時にクライアント発番 UUID を補完してから送信する (vendor は biz3utils.generateUUID() で発番)
- ref: references_web/src/pages/personal/devices/wifi-module/ir/learn/index.js:262; packages/core/src/ir.js:192-194
- kind: option-branch
- status: planned
- note: learn:262 = uuid: biz3utils.generateUUID(); kit ir.js:192-194 = remote.uuid ? remote : {...remote, uuid: generateUUID()}。確認。

### [IR-0055] addIRRemote deviceUUID 欠落で badRequest
- surface: core
- backend: cloud, local
- command: ir.addIRRemote
- branch: deviceUUID あり | deviceUUID 欠落
- assert: remote.deviceUUID 欠落時 badRequest('domain.ir.addIRRemoteDeviceUUIDRequired') をスローする (kit 独自の明示拒否、vendor は呼び出し元前提)
- ref: packages/core/src/ir.js:188; packages/core/src/i18n/domain.js:64
- kind: error-path
- status: planned
- note: ir.js:188 = if(!remote.deviceUUID) throw badRequest('domain.ir.addIRRemoteDeviceUUIDRequired'); i18n domain.js:64 = 当該キー定義 (en)。vendor はガード無し (remoteToSave 構築時に deviceUUID:hub3DeviceId を常時付加)。kit 独自逸脱として正当。確認。

### [IR-0056] canAddMoreRemote 上限ロジック (self-learn 無制限 / preset 4種 3個未満)
- surface: core
- backend: cloud, local
- command: ir.canAddMoreRemote
- branch: type=0xFE00(無制限) | preset 件数<3 | preset 件数>=3
- assert: type=0xFE00 は true、preset 4種(0x8000/0x2000/0xe000/0xc000)の既存件数が 3 未満なら true / 3以上なら false (vendor canAddMoreRemote と一致)
- ref: references_web/src/api/useRemoteCtrl.js:226-253; packages/core/src/ir.js:139-152
- kind: payload-fidelity
- status: planned
- note: 検証済: vendor 0xfe00 早期 return は useRemoteCtrl.js:228-231、preset 4種カウントは :239-243、return counts<3 は :252。kit ir.js:139-152 が同ロジックを type/remoteList の純関数で 1:1 移植

### [IR-0057] addIRRemoteServer の送信前上限チェック (currentRemoteList 指定時のみ)
- surface: core
- backend: cloud, local
- command: addIRRemoteServer
- branch: currentRemoteList 指定+超過(reject) | 指定+余裕(送信) | 省略(チェックskip)
- assert: currentRemoteList 指定時 canAddMoreRemote false なら badRequest('domain.ir.presetRemoteLimit')、省略時はチェックせず送信する (vendor は addIRRemote が送信前に canAddMoreRemote を通す)
- ref: references_web/src/api/useRemoteCtrl.js:525-531; packages/core/src/client.js:811-817; packages/core/src/i18n/domain.js:65
- kind: error-path
- status: planned
- note: 検証済: vendor addIRRemote の if(!canAddMoreRemote(...)) ガードは :525-531。kit client.js:811-816 が if(currentRemoteList!==undefined) でのみ ir.canAddMoreRemote を通し false で badRequest('domain.ir.presetRemoteLimit') (key は domain.js:65)。サーバ側 enforcement は参照に無い (client-side のみ)

### [IR-0058] ir remote-add --json の入力契約 (vendor remote オブジェクト形) と stdin/file 読込
- surface: cli
- backend: cloud, local
- command: `sesame ir remote-add --json <file|->`
- branch: ファイル | stdin(-) | --json欠如 | 非object/配列 | 不正JSON | TTYでstdin
- assert: --json 欠如で die(cli.irRemoteAddJsonRequired)、'-' で非TTY stdin/ファイル読込(TTY は die(cli.jsonStdinNotTty)/読込失敗 die(cli.jsonFileReadFailed))、JSON parse 失敗で die(cli.invalidJsonValue)、配列/非object で die(cli.irRemoteAddNotObject)、いずれも exit 2。投入形は {uuid,model,state,alias,code,type,deviceUUID,keys} (learn/index.js:261-270)
- ref: packages/kit/src/cli/ir.js:201-254; packages/kit/src/i18n/cli.js:345-346; packages/kit/src/i18n/cli.js:357-358; references_web/src/pages/personal/devices/wifi-module/ir/learn/index.js:261-270
- kind: error-path
- status: planned
- note: 検証済 (3 候補マージ: remote-add --json 入力検証 + remote-add --json '-' stdin + remote-add input contract は同一 surface/command の上位集合)。readJsonSource (ir.js:201-214): src==='-' で isTTY→die(cli.jsonStdinNotTty,2)、非TTY は stdin chunks 連結、else readFileSync、catch→die(cli.jsonFileReadFailed,2)。cmdIRRemoteAddServer (239-254): --json 欠如 die(240,cli.irRemoteAddJsonRequired)、parse 失敗 die(244-245,cli.invalidJsonValue)、非object/配列 die(246-248,cli.irRemoteAddNotObject)、全て exit 2。i18n キーは cli.js:6/345-346/357-358 に実在。投入形は web learn/index.js:261-270 と 1:1。

## deleteRemote

リモコン削除 (deleteIRRemote) の wire・命名 (hub3DeviceId/uuid)・remote 名解決を固定する。

### [IR-0059] deleteIRRemote wire frame (op/hub3DeviceId/uuid/companyID)
- surface: core, serve, sdk, cli
- backend: cloud
- command: deleteIRRemoteServer / ir.deleteRemote / sesame ir remote-rm
- branch: -
- assert: deleteIRRemote フレームが {action,op:'deleteIRRemote',hub3DeviceId,uuid,companyID} のキー名・op 値で vendor deleteIRRemote と一致する (Hub3=hub3DeviceId, リモコン=uuid)
- ref: references_web/src/api/useRemoteCtrl.js:560-566; packages/core/src/ir.js:206-210
- kind: wire-fidelity
- status: planned
- note: 検証済: vendor message {op:'deleteIRRemote',hub3DeviceId,uuid,companyID} は :560-566。kit deleteIRRemote frame は ir.js:207 で同一キー名・op 値。surface 4面: serve/sdk は ir.deleteRemote (serve/entries/ir.js:72, sdk ts:469/py:917)、cli は remote-rm (cli/ir.js:358)。

### [IR-0060] deleteIRRemoteServer の remote 名解決 (config→hub3DeviceId/irDeviceUUID)
- surface: core
- backend: cloud, local
- command: deleteIRRemoteServer
- branch: remote 名指定 | 既定(単一) | 解決失敗
- assert: resolveRemote で hub3.deviceId と remote.irDeviceUUID を引いてフレームの hub3DeviceId/uuid に写像する。未解決は badRequest
- ref: packages/core/src/client.js:821-829; packages/core/src/config.js:526-536
- kind: option-branch
- status: planned
- note: 検証済: deleteIRRemoteServer (client.js:821-829) は resolveRemote→hub3.deviceId を hub3DeviceId、remote.irDeviceUUID を uuid へ写像。resolveRemote (config.js:526-536) は resolveByName 失敗または hub3 欠落で badRequest。

## renameRemote

リモコン改名 (updateRemoteAlias) の wire・命名トラップ (deviceId)・alias 必須を固定する。

### [IR-0061] updateRemoteAlias wire frame (op/deviceId/uuid/alias/companyID)
- surface: core, serve, sdk, cli
- backend: cloud
- command: renameIRRemote / ir.renameRemote / sesame ir remote-rename
- branch: -
- assert: updateRemoteAlias フレームが {action,op:'updateRemoteAlias',deviceId,uuid,alias,companyID} で vendor modifyIRRemote と一致する (命名トラップ: Hub3 はここだけ deviceId)
- ref: references_web/src/api/useRemoteCtrl.js:588-594; packages/core/src/ir.js:219-226
- kind: wire-fidelity
- status: planned
- note: 検証済: vendor modifyIRRemote の message {op:'updateRemoteAlias',deviceId:hub3DeviceId,uuid,alias,companyID} は :588-594。kit updateRemoteAlias frame (ir.js:219-226) が deviceId:hub3DeviceId で同一 (deleteIRRemote は hub3DeviceId だが updateRemoteAlias は deviceId)。surface 4面: serve/sdk ir.renameRemote (serve/entries/ir.js:78, sdk ts:483/py:945)、cli remote-rename (cli/ir.js:360)

### [IR-0062] remote-rename の alias 必須検証 (欠落で exit 2)
- surface: cli, serve
- backend: cloud, local
- command: `sesame ir remote-rename <alias> [name]` / ir.renameRemote
- branch: alias あり | alias 欠落
- assert: alias 欠落時 CLI は die(cli.aliasRequired, exit 2)、serve は need(['remote','alias']) で RpcError(INVALID_PARAMS) を投げる
- ref: packages/kit/src/cli/ir.js:310; packages/kit/src/serve/entries/ir.js:82; packages/kit/src/serve/registry-helpers.js:32-35
- kind: error-path
- status: planned
- note: 検証済: cli/ir.js:310 = die(t('cli.aliasRequired'),2) 一致; serve/entries/ir.js:82 = need(['remote','alias']); registry-helpers.js:35 で need() は RpcError code=INVALID_PARAMS を投げる。i18n cli.aliasRequired は cli.js:165/586 に存在。

## deleteKey

キー削除 (deleteIRCode) の wire・key 名解決+config 同期除去・確認プロンプト/--yes を固定する。

### [IR-0063] deleteIRCode wire frame (op/hub3DeviceId/remoteId/keyUUID/companyID)
- surface: core, serve, sdk, cli
- backend: cloud
- command: deleteIRKey / ir.deleteKey / sesame ir key rm
- branch: -
- assert: deleteIRCode フレームが {action,op:'deleteIRCode',hub3DeviceId,remoteId,keyUUID,companyID} のキー名・op で vendor deleteIRCode と一致する
- ref: references_web/src/api/useRemoteCtrl.js:907-914; packages/core/src/ir.js:332-340
- kind: wire-fidelity
- status: planned
- note: 行修正: vendor message オブジェクトは 907-914 (906 は companyID 代入行)。op:'deleteIRCode'@909, hub3DeviceId@910, remoteId@911, keyUUID@912, companyID@913。core ir.js:332-340 (op@335, keys@336-339) と 1:1 一致。

### [IR-0064] deleteIRKey の key 名→keyUUID 解決 と config 同期除去
- surface: core
- backend: cloud, local
- command: deleteIRKey
- branch: key 名で解決 | keyUUID 直指定 | config 反映あり/なし
- assert: remote.keys[keyName] があればその keyUUID を送り、削除成功時 config の keys から当該キーを除去する (直 keyUUID 指定はそのまま送る)
- ref: packages/core/src/client.js:850-865
- kind: idempotency
- status: planned
- note: 検証済: client.js:853 で keyUUID=remote.keys?.[keyOrUUID]||keyOrUUID 解決, 854-859 で deleteIRCode 送信, 861-864 で config 除去 (remote.keys?.[keyOrUUID] ガード)。ir.deleteIRCode の assertSuccess(strict) が失敗時 throw するため config 除去到達=成功時のみ。

### [IR-0065] key rm の確認プロンプトと --yes (非対話で --yes 必須)
- surface: cli
- backend: cloud, local
- command: `sesame ir key rm [remote] [key]`
- branch: 対話=confirm(No=cancel) | 対話=confirm(Yes) | 非対話+--yes | 非対話+--yes無し(exit 2) | key 欠落(exit 2)
- assert: 対話時は confirm (否定でキャンセル)、非対話かつ --yes 無しは die(cli.nonInteractiveYesForce, exit 2)、key 未解決は die(cli.keyRequiredShort, exit 2)
- ref: packages/kit/src/cli/ir.js:86-105; packages/kit/src/i18n/cli.js:144
- kind: error-path
- status: planned
- note: 検証済 (2 候補マージ: key rm 確認プロンプトと --yes + ir key rm confirm は同一 surface/command の重複)。cmdIRKeyRm (cli/ir.js:86-105): key 未解決 die(cli.keyRequiredShort,2) (92)、canPrompt 時 confirmPrompt(defaultYes:false) 否定でキャンセル (94-96)、非対話 && !options.yes で die(cli.nonInteractiveYesForce,2) (97-98)。i18n keyRequiredShort/nonInteractiveYesForce 実在。'rm' 登録 (--yes option 付き) は ir.js:333-335。

## renameKey

キー改名 (updateIRCode) の wire・newName 必須+config rename 同期を固定する。

### [IR-0066] updateIRCode wire frame (op/hub3DeviceId/remoteId/keyUUID/name/companyID)
- surface: core, serve, sdk, cli
- backend: cloud
- command: renameIRKey / ir.renameKey / sesame ir key rename
- branch: -
- assert: updateIRCode フレームが {action,op:'updateIRCode',hub3DeviceId,remoteId,keyUUID,name,companyID} のキー名・op で vendor updateIRCode と一致する (フィールド名は keyUUID, name)
- ref: references_web/src/api/useRemoteCtrl.js:876-884; packages/core/src/ir.js:312-321
- kind: wire-fidelity
- status: planned
- note: 検証済: vendor message 876-884 (op@878, hub3DeviceId@879, remoteId@880, keyUUID:keyId@881, name@882, companyID@883)。core ir.js:312-321 (op@315, keyUUID@318, name@319) と 1:1。vendor は引数 keyId を keyUUID フィールドへ写像。

### [IR-0067] renameKey の newName 必須検証 と config rename 同期
- surface: core, cli, serve
- backend: cloud, local
- command: renameIRKey / ir.renameKey / sesame ir key rename
- branch: newName あり | newName 欠落 | config 反映
- assert: newName 欠落時 CLI die(cli.newNameRequiredKey, exit 2)/serve need(['remote','key','newName']) で拒否、成功時 config keys を旧名削除→新名で再登録する
- ref: packages/kit/src/cli/ir.js:120-122; packages/core/src/client.js:884-889; packages/kit/src/serve/entries/ir.js:94
- kind: error-path
- status: planned
- note: 検証済: cli/ir.js:122 newNameRequiredKey die(exit 2); client.js:884-889 で config rename (delete next[old]@886, next[newName]=keyUUID@887, updateRemoteKeys@888); serve/entries/ir.js:94 need(['remote','key','newName'])。i18n newNameRequiredKey 存在。

## matchRemote

プリセット照合 (matchRemote) の wire・irWaveLength 算出・brandName 省略時キー除外・応答 matches 取り出し・irData 必須・ノイズ閾値整合を固定する。

### [IR-0068] matchRemote wire frame (op/irData/irWaveLength/irType/brandName?/companyID)
- surface: core, serve, sdk, cli
- backend: cloud
- command: matchIRRemote / ir.matchRemote / sesame ir match
- branch: brandName 指定 | brandName 未指定 (キー省略)
- assert: matchRemote フレームが {action,op:'matchRemote',irData,irWaveLength:irData.length/2,irType,companyID} で irWaveLength は length/2 算出; brandName は指定時のみ含め vendor の brandName:model と一致 (未指定は空文字でなくキー省略=意図的 1:1 逸脱)
- ref: references_web/src/api/useRemoteCtrl.js:789-797; packages/core/src/ir.js:464-476; packages/kit/src/serve/entries/ir.js:108-116
- kind: wire-fidelity
- status: planned
- note: 行/assert 修正: vendor (useRemoteCtrl.js:789-797, op@791, irWaveLength:irData.length/2@793, brandName:model@795) は brandName を常に値付きで送るが、core ir.js:470-472 は brandName undefined 時にキー自体を省く意図的逸脱 (コメント明記)。serve entries/ir.js:113 でも brandName required:false。assert を brandName 条件付き含有へ精緻化。core range を 464-476 へ拡張 (関数頭+条件 spread を含む)。

### [IR-0069] matchRemote の brandName 省略時キー除外 (vendor 逸脱: P3-10)
- surface: core
- backend: cloud
- command: ir.matchRemote
- branch: brandName 指定 | brandName 未指定(キー省略)
- assert: brandName 未指定時はキー自体を省く。vendor は常に brandName:model を値ありで送るため、これは意図的逸脱として記録する境界
- ref: references_web/src/api/useRemoteCtrl.js:795; packages/core/src/ir.js:465-473
- kind: wire-fidelity
- status: planned
- note: vendor (useRemoteCtrl.js:795 = `brandName: model`) は remote.model を常に渡す。kit は ir.js:473 の条件付きスプレッド `...(brandName !== undefined && {brandName})` で undefined 時キー省略する逸脱。検証済み。

### [IR-0070] matchRemote 応答の matches 取り出し (response.data.matches)
- surface: core
- backend: cloud
- command: ir.matchRemote
- branch: matches あり | data/matches 欠落(=[])
- assert: 照合候補を resp.data.matches から配列で取り出し、欠落時 [] にする (vendor は matchResponse.data.matches を読む)
- ref: references_web/src/pages/personal/devices/wifi-module/ir/remote-match/index.js:158; packages/core/src/ir.js:478-479
- kind: payload-fidelity
- status: planned
- note: vendor remote-match/index.js:158 = `parseMatchResults(matchResponse.data.matches, ...)`。kit ir.js:479 = `(resp.data ?? {}).matches || []`。一致を確認。

### [IR-0071] match の irData 必須検証と irType 解決
- surface: cli, serve
- backend: cloud, local
- command: `sesame ir match <irType> <irData>` / ir.matchRemote
- branch: irData あり | irData 欠落 | irType 不正
- assert: irData 欠落時 CLI die(cli.irDataRequired, exit 2)/serve need(['irData','irType'])、irType は parseIrType で解決し不正は exit 2
- ref: packages/kit/src/cli/ir.js:182-185; packages/kit/src/serve/entries/ir.js:116
- kind: error-path
- status: planned
- note: cli/ir.js:184 parseIrType catch→die(...,2)、185 `if(!irData) die(cli.irDataRequired,2)`。serve/entries/ir.js:116 `need(params,['irData','irType'])`。両出典で確認。

### [IR-0072] match で送る irData の波形ノイズ閾値整合 (length<=50 はノイズ)
- surface: core
- backend: cloud
- command: ir.matchRemote / learnIRKey
- branch: length<=50(ノイズ) | length>50(有効)
- assert: learnIRKey の波形採否閾値 (length<=50 はノイズ扱いで待機継続) が vendor remote-match の matchRemote 直前ゲートと同一値であること。kit では閾値は learnIRKey 内にあり matchRemote の wire 前段ではない点が vendor と配置が異なる
- ref: references_web/src/pages/personal/devices/wifi-module/ir/remote-match/index.js:142-149; packages/core/src/ir.js:539-541
- kind: payload-fidelity
- status: planned
- note: vendor remote-match/index.js:142-149 は `length<=50` で `continue waiting` し、158 で matchRemote を呼ぶ(=ゲート直後に照合)。kit の `length<=50` 判定は ir.js:541 の learnIRKey 内のみで、kit の matchRemote(ir.js:464) / CLI match(cli/ir.js:187) は irData を素通しし閾値ゲートを持たない。検証する境界は閾値定数 50 の整合であり、元 assert の「matchRemote へ渡す前段」という配置主張は kit 実装と不一致のため文言修正。

## addRemoteToMatter

Matter ペアリング (addRemoteToMatter) の wire 9 キー・CLI 6 必須オプション検証を固定する。

### [IR-0073] addRemoteToMatter wire frame (9 キー 1:1)
- surface: core, serve, sdk, cli
- backend: cloud
- command: addRemoteToMatter / ir.addRemoteToMatter / sesame ir remote-add-matter
- branch: -
- assert: addRemoteToMatter フレームが {action,op,hub3DeviceId,irDeviceType,cmdOn,cmdOff,irDeviceUUID,irDeviceName,companyID} で vendor と一致する (irDeviceType=irRemote.type, irDeviceUUID=irRemote.uuid, irDeviceName=irRemote.alias)
- ref: references_web/src/api/useRemoteCtrl.js:936-946; packages/core/src/ir.js:275-285
- kind: wire-fidelity
- status: planned
- note: experimental 実機未検証。vendor useRemoteCtrl.js:936-946 と kit ir.js:275-285 のフレームは action/op + 7 ペイロードフィールド (計 9 キー) が 1:1。元タイトルの「7 フィールド」は action/op を除く 7 ペイロードを指すが誤解を避け「9 キー」に修正。sdk 面は grpc-methods.generated.json:1827 `ir.addRemoteToMatter` で確認。

### [IR-0074] remote-add-matter 必須オプション検証 (6 個) と型変換
- surface: cli
- backend: cloud, local
- command: `sesame ir remote-add-matter`
- branch: 全指定 | 一部欠落(列挙して exit 2) | ir-device-type 非数値
- assert: --hub3-device-id/--ir-device-type/--cmd-on/--cmd-off/--ir-device-uuid/--ir-device-name のいずれか欠落・型不正で die(cli.irRemoteAddMatterMissing, exit 2)、irDeviceType は Number 変換、--ir-device-uuid→irDeviceUUID へ写像
- ref: packages/kit/src/cli/ir.js:264-288
- kind: error-path
- status: planned
- note: 検証済 (2 候補マージ: 必須オプション検証 + remote-add-matter validation は同一 surface/command の重複)。cmdIRRemoteAddMatter (264-288): commander の irDeviceUuid を vendor irDeviceUUID へ写像 (271)、irDeviceType は Number 化し NaN も missing 扱い (268,277)、6 オプションの欠落/NaN を missing[] へ集約 (276-281)、die(cli.irRemoteAddMatterMissing,2) (282)。

## irType

学習リモコンの type 値 (0xFE00) と UI メニュー (0xFEFF) のトラップ・IR_TYPE 正準値を固定する。

### [IR-0075] IR_TYPE wire 値の正準 (ac/tv/light/fan/learn) と学習 0xFE00 トラップ
- surface: core
- backend: cloud, local
- command: parseIrType / IR_TYPE / DEFAULT_IR_TYPE
- branch: preset(メニュー値=実type) | learn(メニュー0xFEFF≠実type0xFE00)
- assert: IR_TYPE = {ac:0xC000,tv:0x2000,light:0xE000,fan:0x8000,learn:0xFE00} で、学習リモコンの実 type は 0xFE00 (UI メニュー 0xFEFF ではない) と一致する
- ref: references_web/src/pages/personal/devices/wifi-module/ir/learn/index.js:137-142; references_web/src/pages/personal/devices/wifi-module/ir/ir-type-list/index.js:46; references_web/src/api/useRemoteCtrl.js:228; packages/core/src/crypto.js:250-274
- kind: payload-fidelity
- status: planned
- note: learn/index.js:142 の既定学習リモコン `type:0xfe00` と useRemoteCtrl.js:228 `remoteDevice.type === 0xfe00`(自己学習判定)が実 type=0xFE00 を裏付け。assert の「UI メニュー 0xFEFF」部分は元 refs では未確認だったため ir-type-list/index.js:46 `type:0xfeff`(learn メニュー識別子)を追加。crypto.js range を 250-274 に拡張し 0xFEFF≠0xFE00 のトラップ根拠コメント(250-256)+ IR_TYPE 定義(261-267)+ DEFAULT_IR_TYPE(274) を包含。全値検証済み。

### [IR-0076] ir remote-list/search/match の irType パースとエイリアス/異常系
- surface: cli
- backend: cloud
- command: `sesame ir remote-list/search/match <irType>`
- branch: エイリアス文字列 | 数値/0x表記 | 未知
- assert: parseIrType がエイリアス(ac/tv/light/fan/learn)・10進・0x表記を受理、未知は throw→die(2)。learn 既定 0xFE00、UI メニュー 0xFEFF と実 type の非対称を取り違えない
- ref: packages/kit/src/cli/ir.js:134-193; packages/core/src/crypto.js:250-289
- kind: option-branch
- status: planned
- note: 検証済 (2 候補マージ: remote-list irType 引数解決 + CLI parseIrType は同一 surface/command 群の重複)。parseIrType (crypto.js:281-289) は IR_TYPE エイリアス (285)・Number(key) で 10進/0x表記 (286-287) を受理、未知は throw (289)。CLI 3 経路 cmdIRRemoteListServer/Search/Match (134-193) が catch→die(2) (137,160,184)。IR_TYPE.learn=0xfe00 (266)・DEFAULT_IR_TYPE=0xFE00 (274)・0xFEFF 非対称コメント (253-256) を含めるため crypto ref を 250-289 へ統合。

## surface-parity (cross-cutting)

IR CRUD/検索/照合の serve registry・生成 SDK 露出と未認証拒否の一律封筒を固定する。

### [IR-0077] IR CRUD/検索/照合の serve registry 露出 (ir.* メソッド存在・1:1)
- surface: serve
- backend: cloud
- command: ir.listRemotes / ir.searchRemotes / ir.addRemote / ir.deleteRemote / ir.renameRemote / ir.deleteKey / ir.renameKey / ir.matchRemote / ir.addRemoteToMatter
- branch: -
- assert: registry に 9 メソッドが登録され、各 params の required/schema が core の対応シグネチャに一致する (requireAuth/need ガード込み)
- ref: packages/kit/src/serve/entries/ir.js:52-143; packages/kit/src/serve/registry.js:340
- kind: contract-existence
- status: planned
- note: 確認済: ir.js:52(ir.listRemotes)〜:143(ir.addRemoteToMatter 閉じ)に 9 メソッド実在。registry.js:340 で irEntries() を reg.set。各 handler は requireAuth(daemon)+need(params,[...]) を通す

### [IR-0078] IR CRUD/検索/照合の生成 SDK 露出 (ts/py メソッド・引数型 1:1)
- surface: sdk
- backend: cloud
- command: listRemotes / searchRemotes / addRemote / deleteRemote / renameRemote / deleteKey / renameKey / matchRemote / addRemoteToMatter
- branch: ts | py
- assert: 生成 ts/py SDK の ir.* メソッドと引数型 (type:number, searchTerm:string, remote:object, key/newName 等) が registry params と一致する
- ref: packages/kit/sdk/ts/sesame-client.ts:463-485; packages/kit/sdk/python/sesame_client.py:903-949
- kind: contract-existence
- status: planned
- note: py 行修正: 旧 931-949 は addRemote(903)/addRemoteToMatter(907)/deleteKey(911)/deleteRemote(915) を含まず 9 メソッドを覆えていなかった→903-949 に拡張 (addRemote〜searchRemotes が 9 メソッド全包含)。ts:463-485 は addRemote(463)〜searchRemotes(485) で 9 メソッド全包含・確認済

### [IR-0079] 未認証時のクラウド op 拒否 (requireAuth) 一律封筒
- surface: serve
- backend: cloud
- command: ir.listRemotes / ir.addRemote / ir.matchRemote (全 ir.* CRUD)
- branch: 認証済み | 未認証
- assert: 未認証で ir.* CRUD/検索/照合を呼ぶと requireAuth が共通エラー封筒で拒否する (全メソッド一律)
- ref: packages/kit/src/serve/entries/ir.js:57; packages/kit/src/serve/registry-helpers.js:55-62
- kind: error-path
- status: planned
- note: 確認済: ir.js の全 14 handler が requireAuth(daemon) を先頭で呼ぶ (要求の 3 メソッド含む全 ir.* 一律)。requireAuth 本体の行を修正: 旧 51-54 は JSDoc のみ→55-62 が authState==='expired'→RpcError(kind=NOT_AUTHENTICATED) / !connected→CONNECTION_LOST の実拒否ロジック

## error-path (cross-cutting)

全 IR op のサーバ拒否 (success:false) の rejected 写像を固定する。

### [IR-0080] サーバ拒否 (success:false) の rejected 写像 (strict assertSuccess)
- surface: core, serve
- backend: cloud
- command: ir.getRemoteList / searchRemoteList / addIRRemote / deleteIRRemote / updateRemoteAlias / deleteIRCode / updateIRCode / matchRemote
- branch: success:true | success:false | success 欠落(strict で失敗)
- assert: 全 IR op が assertSuccess(strict:true) を通し、success≠true 時 SesameError(code=rejected, retryable=false, upstreamCode 保持) を投げる (serve は kind=rejected へ)
- ref: packages/core/src/util.js:34-43; packages/core/src/ir.js:90; packages/core/src/ir.js:117; packages/core/src/jsonrpc.js:212
- kind: error-path
- status: planned
- note: 確認済: util.js:34-43 で strict 時 !resp?.success が SesameError(code=ERR.REJECTED, retryable:false, data.upstreamCode=resp?.code) を throw。ir.js の全 13 op が {strict:true} (getRemoteList:90 / searchRemoteList:117 が代表 ref で正確)。serve 写像の出典として jsonrpc.js:212 [ERR.REJECTED]→{kind:KIND.REJECTED} を追加

## presetir.sendIR

プリセット直送 (sendIR) の wire・irDeviceUUID 空文字既定・deviceId/hub3DeviceId エイリアス・必須検証・strict 応答・timeout を固定する。

### [IR-0081] sendIR フレームのキー集合と op/operation 値が biz3 useRemoteCtrl.sendIR と一致
- surface: core
- backend: cloud
- command: presetir.sendIR
- branch: -
- assert: 送信フレームが {action:'biz3IRRemote', op:'sendIR', deviceId, command, operation:'remoteEmit', irType, companyID, irDeviceUUID} のキー集合・既定値 operation='remoteEmit' を持ち vendor と1:1
- ref: packages/core/src/presetir.js:535-544; references_web/src/api/useRemoteCtrl.js:467-476
- kind: wire-fidelity
- status: planned
- note: vendor は引数 remoteId を irDeviceUUID にマップする (useRemoteCtrl.js:475)。確認済: presetir.js frame は 535-544 (旧 535-545 は次行 const resp を含む→544 へ短縮)。vendor の operation 既定値はコード上は引数だが、呼び出し元 remote-air:370/remote-non-air:156 が常に 'remoteEmit' を渡すため presetir の operation??'remoteEmit' 既定と1:1。action='biz3IRRemote' は messageConstants.js:20 で両側一致

### [IR-0082] irDeviceUUID 未指定時は空文字 '' を送る (未保存プリセット)
- surface: core
- backend: cloud
- command: presetir.sendIR
- branch: irDeviceUUID未指定 | 指定あり
- assert: p.irDeviceUUID 省略時フレームの irDeviceUUID は '' (vendor remote.uuid || '')、指定時はその値がそのまま入る
- ref: packages/core/src/presetir.js:543; references_web/src/pages/personal/devices/wifi-module/ir/remote-air/index.js:369; references_web/src/pages/personal/devices/wifi-module/ir/remote-non-air/index.js:155
- kind: payload-fidelity
- status: planned
- note: 確認済: presetir.js:543 = `irDeviceUUID: p.irDeviceUUID ?? "",`。vendor remote-air:369 / remote-non-air:155 = `let remoteId = remote.uuid || '';` を sendIR の remoteId 引数に渡し→useRemoteCtrl:475 で irDeviceUUID に乗せる

### [IR-0083] deviceId / hub3DeviceId エイリアス解決 (deviceId 優先)
- surface: core
- backend: cloud
- command: presetir.sendIR
- branch: deviceIdのみ | hub3DeviceIdのみ | 両方
- assert: deviceId 無ければ hub3DeviceId にフォールバックし、ワイヤには常に deviceId として送る。両方指定時は deviceId 優先
- ref: packages/core/src/presetir.js:529-538
- kind: option-branch
- status: planned
- note: ir.listKeys 等との命名統一のための alias (P4-10)。確認済: presetir.js:529 = `const deviceId = p?.deviceId ?? p?.hub3DeviceId;` (deviceId 優先・hub3DeviceId フォールバック)、:530 で両方欠落時 badRequest、:538 で frame.deviceId にその正準値を送出

### [IR-0084] sendIR 必須欠如 (deviceId/command/irType/companyID) は badRequest
- surface: core
- backend: cloud
- command: presetir.sendIR
- branch: deviceId欠如 | command欠如 | irType欠如 | companyID欠如
- assert: 各必須欠如時に presetir.err.* (deviceIdRequired/commandRequired/irTypeRequired/companyIdRequired) を投げ、irType==null は 0 と区別される (== null 判定)
- ref: packages/core/src/presetir.js:530-533
- kind: error-path
- status: planned
- note: 検証済: 530=deviceId(529でhub3DeviceIdへフォールバック後),531=command,532=`p.irType==null`(0は通過),533=companyID。i18nキーは packages/core/src/i18n/presetir.js / types/i18n/presetir.d.ts:33-36 に実在。badRequest は util.js:54。

### [IR-0085] sendIR 応答パースは success===true を strict 要求 (失敗時 throw)
- surface: core
- backend: cloud
- command: presetir.sendIR
- branch: success=true | success=false
- assert: assertSuccess(resp,'sendIR',{strict:true}) で success===true のみ成功扱い、それ以外は throw。vendor handleRemoteResponse は op==='sendIR' を message.success で判定
- ref: packages/core/src/presetir.js:547; references_web/src/api/useRemoteCtrl.js:65-80
- kind: error-path
- status: planned
- note: 検証済: presetir.js:547=`assertSuccess(resp,"sendIR",{strict:true})`。util.js:35 で strict は `!resp?.success`(success欠落でも失敗)。vendor useRemoteCtrl.js:65 `case 'sendIR':`→66 `if(message.success)`(switch(op)分岐後 success のみ判定、op一致の独立re-checkは無し)。元assertの「op==='sendIR'&&success のみ」を実装に合わせ簡略化。

### [IR-0086] sendIR の既定 timeout は 10s、timeoutMs で上書き
- surface: core
- backend: cloud
- command: presetir.sendIR
- branch: timeoutMs未指定 | 指定あり
- assert: client.request の第2引数が p.timeoutMs ?? DEFAULT_TIMEOUT_MS(10000) で渡る
- ref: packages/core/src/presetir.js:38; packages/core/src/presetir.js:545
- kind: option-branch
- status: planned
- note: 検証済: presetir.js:38=`const DEFAULT_TIMEOUT_MS = 10_000;`、545=`client.request(frame, p.timeoutMs ?? DEFAULT_TIMEOUT_MS)`。local-contract: vendor sendIR(useRemoteCtrl.js:460-484)は handleSendMessage→sendMessage(338-340)の fire-and-forget で timeout 概念が無く、これは本ツール固有の境界。

## HXDCommandProcessor

エアコン/非エアコン 16byte コマンドの配置・checksum・encode/parse・既定値が biz3 HXDCommandProcessor とバイト一致することを固定する。

### [IR-0087] buildAirCommand の 16byte 配置・checksum が biz3 と1bit一致
- surface: core
- backend: local
- command: HXDCommandProcessor.buildAirCommand
- branch: -
- assert: [0x30,0x01,codeHi,codeLo,temp,fan,wind,autoWind,power,key,mode,table0+1,0,0,0xff,checksum] の配置と checksum=先頭15byte総和&0xff が vendor と一致
- ref: packages/core/src/presetir.js:83-98; references_web/src/pages/personal/devices/wifi-module/ir/utils/HXDCommandProcessor.js:17-34
- kind: payload-fidelity
- status: planned
- note: 検証済: core 83-98 と vendor 17-34 が console.log を除き完全一致。buf[0,1]=prefix[0x30,0x01],buf[2,3]=codeHi/Lo,buf[4..10]=temp/fan/wind/autoWind/power/key/mode,buf[11]=(table[0]+1)&0xff=1,buf[12,13]=0,buf[14]=0xff(length-2),buf[15]=checksum=slice(0,-1)総和&0xff。配置・checksum一致確認。

### [IR-0088] buildNonAirCommand の 16byte 配置・checksum が biz3 と一致
- surface: core
- backend: local
- command: HXDCommandProcessor.buildNonAirCommand
- branch: -
- assert: prefix [0x30,0x00], buf[9]=key, buf[14]=0xff, checksum=先頭15byte総和&0xff が vendor と一致 (air と異なり buf[4..8],buf[10] は 0)
- ref: packages/core/src/presetir.js:106-114; references_web/src/pages/personal/devices/wifi-module/ir/utils/HXDCommandProcessor.js:36-47
- kind: payload-fidelity
- status: planned
- note: 検証済: core 106-114 と vendor 36-47 が一致。buildKeyData が buf[4..10] を 0 で埋め、buf[9]=key のみ上書きするため buf[4..8],buf[10] は 0 のまま、buf[14]=0xff(length-2),checksum=slice(0,-1)総和&0xff。

### [IR-0089] buildKeyData の骨格 (prefix2+code2+0x7+indexTable3+終端2=16byte) が一致
- surface: core
- backend: local
- command: HXDCommandProcessor.buildKeyData
- branch: -
- assert: code を decimalToTwoHexInts でビッグエンディアン2byte化し、indexTable[0]=(table[0]+1)&0xff、終端 0xff,0 を置く配置が vendor と一致
- ref: packages/core/src/presetir.js:124-146; references_web/src/pages/personal/devices/wifi-module/ir/utils/HXDCommandProcessor.js:49-71
- kind: payload-fidelity
- status: planned
- note: 検証済: core 124-146 と vendor 49-71 が一致。prefix2(push)+decimalToTwoHexInts(code)2+Array(7).fill(0)+indexTable3(indexTable[0]=(table[0]+1)&0xff)+終端push(0xff,0)=16byte。

### [IR-0090] decimalToTwoHexInts / toHexString / hexStringToByteArray が vendor と一致
- surface: core
- backend: local
- command: HXDCommandProcessor.decimalToTwoHexInts / toHexString / hexStringToByteArray
- branch: -
- assert: 16bit分割 [floor(n/256), n%256]、HEX は大文字2桁0埋め区切り無し、parse は2文字ずつ。toHexString と hexStringToByteArray は相互逆
- ref: packages/core/src/presetir.js:154-183; references_web/src/pages/personal/devices/wifi-module/ir/utils/HXDCommandProcessor.js:73-77,124-134
- kind: payload-fidelity
- status: planned
- note: 検証済: decimalToTwoHexInts core 154-158/vendor 73-77=[floor(n/256),n%256]。toHexString core 167-169/vendor 132-134=`padStart(2,'0').toUpperCase().join('')`。hexStringToByteArray core 177-183/vendor 124-130=`i+=2;substr(i,2)`。相互逆を確認。

### [IR-0091] parseAirCommand の前提検証 (length>=22, bytes>=11, prefix 0x30,0x01) と byte 抽出位置
- surface: core
- backend: local
- command: HXDCommandProcessor.parseAirCommand
- branch: 正常 | length<22 | bytes<11/prefix不一致
- assert: length<22 で null、hex→bytes 後 bytes.length<11 か bytes[0]!==0x30||bytes[1]!==0x01 で null、正常時 temperature=b[4],fanSpeed=b[5],windDirection=b[6],autoWindDirection=b[7],power=b[8],key=b[9],mode=b[10]
- ref: packages/core/src/presetir.js:192-205; references_web/src/pages/personal/devices/wifi-module/ir/utils/HXDCommandProcessor.js:84-117
- kind: payload-fidelity
- status: planned
- note: 確認済: impl(193,195)/vendor(86,95) とも length<22 と bytes.length<11||prefix不一致 の二段ガード。元 assert は bytes.length<11 ガードを欠いていたため補完

### [IR-0092] constructor 既定値 (power/temp/fan/wind/autoWind/mode/key/code/prefix) が biz3 と一致
- surface: core
- backend: local
- command: HXDCommandProcessor (constructor)
- branch: -
- assert: power=0,temperature=25,fanSpeed=1,windDirection=2,autoWindDirection=1,mode=2,key=1,code=0,AirPrefixCode=[0x30,0x01],commonPrefixCode=[0x30,0x00] が vendor 既定と一致
- ref: packages/core/src/presetir.js:62-75; references_web/src/pages/personal/devices/wifi-module/ir/utils/HXDCommandProcessor.js:3-15
- kind: payload-fidelity
- status: planned
- note: 確認済: impl(64-74)/vendor(4-14) 全フィールド一致

## HXDParametersSwapper

機種別キーマップ (air/light/tv/fan)・index↔value 変換・dispatch・UI state 写像が biz3 HXDParametersSwapper と一致することを固定する。

### [IR-0093] getAirKey keyMap と default フォールバック (UI type トラップ) が vendor と一致
- surface: core
- backend: local
- command: HXDParametersSwapper.getAirKey
- branch: keyMap一致 | UI type名 | undefined
- assert: MODE=0x02/FAN_SPEED=0x03/WIND_DIRECTION=0x04/AUTO_WIND_DIRECTION=0x05/TEMP_CONTROL_ADD=0x06/TEMP_CONTROL_REDUCE=0x07/POWER_STATUS_*=0x01、未知(POWER_ON/TEMP_ADD/AUTO_SWING/undefined)は default 0x01
- ref: packages/core/src/presetir.js:242-254; references_web/src/pages/personal/devices/wifi-module/ir/utils/HXDParametersSwapper.js:4-17
- kind: payload-fidelity
- status: planned
- note: 確認済: keyMap 値 impl(244-251)/vendor(6-13) 一致。biz3 既知トラップ: airControlItems(remote-air:238-302) の item.type(POWER_ON/POWER_OFF/TEMP_ADD/TEMP_REDUCE/AUTO_SWING) は keyMap に無いキー名で default 0x01 に落ちる(remote-air:122 で getAirKey(keyType) 呼出)。本実装は読み替えず移植

### [IR-0094] mode/fanSpeed/windDirection の index↔value 変換と default が vendor と一致
- surface: core
- backend: local
- command: HXDParametersSwapper.getModeValue / getFanSpeedValue / getWindDirectionValue / getModeIndex / getFanSpeedIndex / getWindDirectionIndex
- branch: 既知index | 未知index(default)
- assert: value側 mode/fan default=0x01・windDirection default=0x02、index側 default=0、各マップ ({0:0x01,...}) が vendor と一致
- ref: packages/core/src/presetir.js:260-308; references_web/src/pages/personal/devices/wifi-module/ir/utils/HXDParametersSwapper.js:34-94
- kind: payload-fidelity
- status: planned
- note: 確認済: 6 メソッド impl(260-308)/vendor(34-94) 一致。windDirection の value default が 0x02(中) で他(0x01)と非対称な点が要点(vendor:93)

### [IR-0095] getLightKey/getTVKey/getFanKey の keyMap 値が biz3 と全項目一致
- surface: core
- backend: local
- command: HXDParametersSwapper.getLightKey / getTVKey / getFanKey
- branch: light | tv | fan
- assert: Light(POWER_STATUS_ON=0x01,POWER_STATUS_OFF=0x02,MODE=0x05,BRIGHTNESS_UP/DOWN=0x03/0x04,COLOR_TEMP_UP/DOWN=0x09/0x0a)・TV(15項目)・Fan(8項目)の全 keyMap 値と default 0x01 が vendor と一致
- ref: packages/core/src/presetir.js:334-388; references_web/src/pages/personal/devices/wifi-module/ir/utils/HXDParametersSwapper.js:114-162
- kind: payload-fidelity
- status: planned
- note: 確認済: Light impl(336-342)/vendor(116-122)、TV 15 項目 impl(352-367)/vendor(130-144)、Fan 8 項目 impl(378-385)/vendor(152-159) 一致。元 assert の Light キー名 POWER_ON/OFF を実キー名 POWER_STATUS_ON/OFF に修正

### [IR-0096] getKeyByDeviceType の irType 分岐と未知 default が vendor と一致
- surface: core
- backend: local
- command: HXDParametersSwapper.getKeyByDeviceType
- branch: 0xc000air | 0xe000light | 0x2000tv | 0x8000fan | 未知default
- assert: irType 0xc000→getAirKey,0xe000→getLightKey,0x2000→getTVKey,0x8000→getFanKey、未知は 0x01 (vendor は console.warn、CLI 版は warn 省略で値は同一)
- ref: packages/core/src/presetir.js:398-411; references_web/src/pages/personal/devices/wifi-module/ir/utils/HXDParametersSwapper.js:166-180
- kind: payload-fidelity
- status: planned
- note: 確認済: switch 分岐 impl(399-410)/vendor(167-179) 一致。未知 default で vendor は console.warn(177)、impl は warn 省略(値 0x01 は同一)

### [IR-0097] convertToUIState の HXD→UI 写像が vendor と一致
- surface: core
- backend: local
- command: HXDParametersSwapper.convertToUIState
- branch: 正常 | null入力
- assert: power=(b===0x01)、autoSwing=(autoWindDirection===0x01)、mode/fanSpeed/windDirection は *Index 変換、null は null を返す
- ref: packages/core/src/presetir.js:318-328; references_web/src/pages/personal/devices/wifi-module/ir/utils/HXDParametersSwapper.js:221-242
- kind: payload-fidelity
- status: planned
- note: 確認済: 写像 impl(319-327)/vendor(222-234)、null入力ガード impl(319)/vendor(222-224) 一致

## presetir builders

HEX ビルダ (buildAirCommandHex/buildNonAirCommandHex) の setter チェーン順序・既定値と state 復元が vendor buildCommand と一致することを固定する。

### [IR-0098] buildAirCommandHex の setter チェーン順序・既定値が biz3 buildCommand と一致
- surface: core
- backend: local
- command: buildAirCommandHex
- branch: code のみ | フル指定
- assert: getAirKey(keyType)→setKey/setCode/setPower(bool?0x01:0x00)/setTemperature(??25)/setModel(getModeValue(mode??0))/setFanSpeed(??0)/setWindDirection(??1)/setAutoWindDirection(autoSwing?0x01:0x00) のフローと出力 HEX が vendor buildCommand と一致
- ref: packages/core/src/presetir.js:437-452; references_web/src/pages/personal/devices/wifi-module/ir/remote-air/index.js:117-138
- kind: payload-fidelity
- status: planned
- note: 確認済: core 441-450 と vendor 123-132 の setter 順序完全一致。windDirection 既定が CLI 層 index 1 なのは getWindDirectionValue(1)=0x02 (presetir.js:306) と整合、かつ HXDCommandProcessor 既定 windDirection=0x02 (presetir.js:67) とも整合

### [IR-0099] buildNonAirCommandHex の getKeyByDeviceType→setKey→setCode→buildNonAirCommand フローが一致
- surface: core
- backend: local
- command: buildNonAirCommandHex
- branch: tv | light | fan
- assert: key=getKeyByDeviceType(irType,buttonType) を setKey し setCode(code) して buildNonAirCommand→toHexString、出力 HEX が vendor remote-non-air buildCommand と一致
- ref: packages/core/src/presetir.js:484-490; references_web/src/pages/personal/devices/wifi-module/ir/remote-non-air/index.js:113-124
- kind: payload-fidelity
- status: planned
- note: 確認済: core 487-489 と vendor 117-118 が getKeyByDeviceType(remote.type,item.type)→setKey→setCode(code)→buildNonAirCommand→toHexString で一致

### [IR-0100] restoreAirState は parseAirCommand→convertToUIState、空/不正は null
- surface: core
- backend: local
- command: restoreAirState
- branch: 有効HEX | 空/null | 不正HEX
- assert: stateHex から parseAirCommand→convertToUIState で UI state を返し、空/null/不正は null (vendor restoreStateFromRemote は remote.uuid/state 不在・parse 失敗で復元せず既定のまま)
- ref: packages/core/src/presetir.js:466-471; references_web/src/pages/personal/devices/wifi-module/ir/remote-air/index.js:564-589
- kind: payload-fidelity
- status: planned
- note: 行番号修正: vendor restoreStateFromRemote は 564-589 (元 564-581 は本体途中で閉じない)。null 経路: 空/null は presetir.js:467、parse 失敗は parseAirCommand 193/195、convert null は 319。vendor null ガードは 566(uuid/state)・573(parse 失敗)

## presetir compose

emitAir/emitButton の複合フロー (state→sendIR→save) と save-after-emit の冪等・updateRemoteState wire を固定する。

### [IR-0101] emitAir は state生成→sendIR(irType=AIR)→成功後state保存 の複合フローが vendor と一致
- surface: core
- backend: cloud
- command: presetir.emitAir
- branch: savedStateあり復元 | savedStateなし
- assert: savedState を復元し明示指定 (?? で未指定=null/undefined のみ復元値を採用) を載せ buildAirCommandHex→sendIR を irType=IR_TYPE.AIR(0xc000) で発射、戻り値 {command,response,stateSaved}
- ref: packages/core/src/presetir.js:592-618; references_web/src/pages/personal/devices/wifi-module/ir/remote-air/index.js:108-113,356-385
- kind: contract-existence
- status: planned
- note: 確認済: core emitAir 592-618。復元は 594-603 (?? は null/undefined 両方で復元値採用、assert を正確化)、IR_TYPE.AIR=0xc000 は 47/608、戻り値 617。vendor 108-113 が restoreStateFromRemote、356-385 が build→sendIR→save

### [IR-0102] emitButton は command生成→sendIR(渡された irType)→成功後state保存 の複合フローが一致
- surface: core
- backend: cloud
- command: presetir.emitButton
- branch: irDeviceUUIDあり保存 | なし
- assert: buildNonAirCommandHex(irType,code,buttonType)→sendIR(同 irType)→saveRemoteStateAfterEmit、戻り値 {command,response,stateSaved}
- ref: packages/core/src/presetir.js:632-650; references_web/src/pages/personal/devices/wifi-module/ir/remote-non-air/index.js:140-166
- kind: contract-existence
- status: planned
- note: 確認済: core emitButton 632-650 (build 633、sendIR 同 irType 638-645、save 646-648、戻り値 649)。vendor は buildCommand 140→sendIR(remote.type) 156→updateRemoteState 159-166

### [IR-0103] saveRemoteStateAfterEmit: irDeviceUUID 無ければ保存せず、失敗は throw せず stateSaved:false
- surface: core
- backend: cloud
- command: presetir.emitAir / presetir.emitButton (saveRemoteStateAfterEmit)
- branch: uuidなし | uuidあり成功 | uuidあり保存失敗
- assert: irDeviceUUID 空は {saved:false} で updateRemoteState を呼ばない、保存失敗は console.error 相当で握りつぶし発射は成功扱い (vendor remote-air:380-382 の else-branch console.error)
- ref: packages/core/src/presetir.js:563-572; references_web/src/pages/personal/devices/wifi-module/ir/remote-air/index.js:371-385
- kind: idempotency
- status: planned
- note: 確認済: core 564 が uuid 空ガード、566 が updateRemoteState、568-570 が catch で throw せず {saved:false,error}。assert 内引用を修正: 失敗握りつぶしの console.error は 376-378 ではなく else-branch 380-382 (381 が console.error('update device state failed'))。uuid ガードは vendor 376 / remoteId 369

### [IR-0104] saveRemoteStateAfterEmit が呼ぶ updateRemoteState フレームのキー名 (deviceId/uuid/state)
- surface: core
- backend: cloud
- command: ir.updateRemoteState (via presetir save)
- branch: -
- assert: フレームが {op:'updateRemoteState', deviceId:hub3DeviceId, uuid, state, companyID} で、hub3DeviceId が **deviceId** キーで送られる (vendor 命名: useRemoteCtrl.js:501)
- ref: packages/core/src/ir.js:246-258; packages/core/src/presetir.js:566; references_web/src/api/useRemoteCtrl.js:493-514
- kind: wire-fidelity
- status: planned
- note: 確認済: ir.js updateRemoteState 246-258 が frame {op:'updateRemoteState', deviceId:hub3DeviceId(250), uuid, state, companyID}。presetir.js:566 が hub3DeviceId:deviceId で呼ぶ。vendor useRemoteCtrl.js:493-514、501 が deviceId:hub3DeviceId で完全一致

## presetir constants/namespace

presetir IR_TYPE 実値と NAMESPACE_OPS の露出範囲 (純ビルダ非露出) を固定する。

### [IR-0105] presetir IR_TYPE 実値 (AIR0xc000/FAN0x8000/LIGHT0xe000/TV0x2000) が確定値と一致
- surface: core
- backend: local
- command: presetir.IR_TYPE
- branch: -
- assert: AIR=0xc000,FAN=0x8000,LIGHT=0xe000,TV=0x2000 が remote.type 実値、学習用 0xFE00/UI メニュー 0xFEFF はここに含めない
- ref: packages/core/src/presetir.js:45-50; packages/core/src/crypto.js:250-267
- kind: contract-existence
- status: planned
- note: 検証済: presetir.js:45-50 で AIR=0xc000/FAN=0x8000/LIGHT=0xe000/TV=0x2000 を freeze。crypto.js:261-267 で同4値+learn=0xfe00、:250-256 で 0xFE00(実type)≠0xFEFF(UIメニュー)を明記。vendor references_web/.../ir/remote-match/index.js:58-61 と ir-type-list/index.js:22-49 で 4値+learn 0xfeff を裏付け。crypto ref を IR_TYPE freeze 終端(267行)まで拡張。

### [IR-0106] presetir NAMESPACE_OPS は [sendIR,emitAir,emitButton] のみ露出 (純ビルダ非露出)
- surface: sdk, core
- backend: cloud
- command: hub.presetir.*
- branch: -
- assert: _bindNs は NAMESPACE_OPS の3 op だけを露出し、HXDCommandProcessor/Swapper/buildAirCommandHex/buildNonAirCommandHex は namespace に出さない (ws 第1引数注入で壊れるため)
- ref: packages/core/src/presetir.js:659; packages/core/src/client.js:333-368
- kind: surface-parity
- status: planned
- note: 検証済: presetir.js:659 NAMESPACE_OPS=[sendIR,emitAir,emitButton]。client.js:341-343 が mod.NAMESPACE_OPS allowlist を優先採用、:350 で fn(ws,{...}) と ws を第1引数注入、:368 presetir getter。presetir.js:652-658 が純ビルダ/class 非露出の根拠を明記。

## CLI preset-ir

preset-ir air/button/send のオプション写像・解決優先順・異常系/終了コード・device 解決・--json 出力を固定する。

### [IR-0107] preset-ir air のオプション写像と --remote/--device/--code 解決優先順
- surface: cli
- backend: cloud
- command: `sesame preset-ir air`
- branch: --remote解決 | --device明示 | 対話選択 | 明示優先
- assert: deviceId=opts.device||config.deviceId||resolveDeviceId、code=opts.code??config.code、--power/--temp/--mode/--fan/--wind/--swing が指定時のみ params に載り、config.state が savedState に渡る
- ref: packages/kit/src/cli/presetir.js:122-173; packages/kit/src/cli/presetir.js:94-110
- kind: option-branch
- status: planned
- note: 検証済: :139 deviceId=opts.device||fromConfig.deviceId||resolveDeviceId、:141 code=opts.code??fromConfig.code、:156 config.state→params.savedState、:157-162 power/temp/mode/fan/wind/swing を指定時のみ載せる。resolveFromConfigRemote は :94-110。

### [IR-0108] preset-ir air の code 未解決/--code 非数値の異常系と終了コード
- surface: cli
- backend: cloud
- command: `sesame preset-ir air`
- branch: code未解決 | --code非数値 | remote code未保存
- assert: code 解決不能で die(codeRequired,2)、toInt が非数値を throw(notANumber)→run catch で die(1)、config remote.code==null で die(remoteNoCode,2)
- ref: packages/kit/src/cli/presetir.js:142-145,43-50,98-102
- kind: error-path
- status: planned
- note: 検証済: :142-145 code==null→die(codeRequired,2)、:43-50 toInt が非数値で notANumber を throw、cli.js:264-280 catch→runtimeExitCode(errors.js:96-105 で一般Error→EXIT.RUNTIME=1)、:98-102 r.code==null→die(remoteNoCode,2)。i18n キーは i18n/presetir.js に全て実在。EXIT.RUNTIME=1/USAGE=2 (errors.js:18)。

### [IR-0109] preset-ir button の必須 (--button/--irtype) 検証と config からの irType 解決
- surface: cli
- backend: cloud
- command: `sesame preset-ir button`
- branch: --irtype明示 | config由来 | --button欠如 | irType欠如
- assert: irType=opts.irtype??config.irType、欠如で die(irtypeRequired,2)、--button 欠如で die(buttonRequired,2)、emitButton に buttonType/code/irType/irDeviceUUID を渡す
- ref: packages/kit/src/cli/presetir.js:177-221
- kind: option-branch
- status: planned
- note: 検証済: :197 irType=opts.irtype??fromConfig.irType、:198-201 irType==null→die(irtypeRequired,2)、:202-205 !button→die(buttonRequired,2)、:208-214 emitButton に deviceId/code/irType/buttonType と irDeviceUUID(存在時)を渡す。

### [IR-0110] preset-ir send は code 不要・--command/--irtype 必須、resolveRemote 直引き
- surface: cli
- backend: cloud
- command: `sesame preset-ir send`
- branch: --remote由来 | --command欠如 | irType欠如
- assert: send は手動 command 前提で resolveFromConfigRemote(code必須)を使わず resolveRemote 直引きで deviceId/irType/irDeviceUUID を取り、--command 欠如 die(commandOptRequired,2)・irType 欠如 die(irtypeRequired,2)
- ref: packages/kit/src/cli/presetir.js:224-266
- kind: option-branch
- status: planned
- note: 検証済: :233-244 コメント通り resolveFromConfigRemote を使わず hub.resolveRemote 直引きで hub3.deviceId/remote.irType/remote.irDeviceUUID を取得、:247-250 !command→die(commandOptRequired,2)、:251-255 irType==null→die(irtypeRequired,2)。

### [IR-0111] resolveDeviceId: 非対話で --device 必須、Hub3 0件は die(1)、対話は selectFromList
- surface: cli
- backend: cloud
- command: `sesame preset-ir air/button/send` (resolveDeviceId)
- branch: device指定 | 非対話未指定 | Hub3なし | 対話選択
- assert: device 指定はそのまま、非対話未指定で die(deviceRequiredNonInteractive,2)、Hub3 0件で die(noHub3Found,1)、対話時 isHub3Model フィルタ後 selectFromList
- ref: packages/kit/src/cli/presetir.js:61-81
- kind: error-path
- status: planned
- note: 検証済: :62 device 指定はそのまま return、:63-66 !canPrompt→die(deviceRequiredNonInteractive,2)、:68-74 isHub3Model フィルタ後 0件→die(noHub3Found,1)、:75-80 selectFromList で picked.deviceUUID。i18n キー実在。

### [IR-0112] preset-ir air/button/send の --json 出力形が機械可読オブジェクト
- surface: cli
- backend: cloud
- command: `sesame preset-ir air/button/send --json`
- branch: --json | human
- assert: --json 時 air/button は {ok,deviceId,command,response}、send は {ok,deviceId,command,irType,response} を出す。非 json は air/button が OK 行+command 行、send は OK 行のみ (command 行なし)
- ref: packages/kit/src/cli/presetir.js:169-172,216-219,262-264; packages/core/src/i18n/presetir.js:23-26
- kind: option-branch
- status: planned
- note: 行番号確認済。非 json の出力差を厳密化: send は presetir.out.sent (OK行) のみで command 行を出さない (presetir.js:262-264)。air/button のみ presetir.out.command を併出 (169-172,216-219)

## presetir serve/parity

presetir.* の serve registry 自動生成と ir.send/presetir.send の面分離・learn 特別扱い・listKeys/match/CRUD/pagination の serve 写像を固定する。

### [IR-0113] presetir.sendIR/emitAir/emitButton が NAMESPACE_OPS から自動生成され daemon に露出
- surface: serve
- backend: cloud
- command: presetir.sendIR / presetir.emitAir / presetir.emitButton (RPC)
- branch: -
- assert: registry が NS_MODULES(presetir) の NAMESPACE_OPS をループして hub[ns][op](params) ハンドラを自動生成 (requireAuth 経由)。companyID は hub._bindNs が config/account 由来 _companyID から注入する
- ref: packages/kit/src/serve/registry.js:97,288-305; packages/kit/src/serve/rpc-params.generated.json:1907,1974,2081; packages/core/src/presetir.js:659; packages/core/src/client.js:333-350,368
- kind: surface-parity
- status: planned
- note: 未確認: registry.js:340 は irEntries() 登録行で presetir 自動生成と無関係。自動生成は NS_MODULES ループ (288-305, NS_MODULES 定義は 97, ハンドラは 302)。companyID 注入は daemon でなく hub._bindNs(client.js:350 fn(ws,{companyID,subUUID,...params}))、companyID は _companyID(236-237)→applyLoginUser で account 反映。NAMESPACE_OPS=[sendIR,emitAir,emitButton] は presetir.js:659

### [IR-0114] ir.send(学習key送信) と presetir.send(直 HEX) の面分離が両方公開
- surface: serve, cli
- backend: cloud
- command: ir.send / presetir.sendIR
- branch: ir.send(remote+key) | presetir.send(command+irType)
- assert: ir.send は {remote,key} で hub.send → remote.keys からキー名/UUID を command に解決し sendIR(operation=remote.irOperation) で発射 (学習リモコン)。presetir.sendIR は生成済み command+irType を直送 (プリセット)。両 RPC が registry に共存し用途が混ざらない
- ref: packages/kit/src/serve/entries/ir.js:16-21; packages/kit/src/cli/presetir.js:256-261; packages/core/src/client.js:379-398
- kind: surface-parity
- status: planned
- note: 行番号確認済。hub.send(client.js:379-398) が key→command 解決 (learnEmit/remoteEmit) する点を補強。presetir.sendIR は command 直送 (presetir.js:525-549 sendIR)

### [IR-0115] ir.learn は requireAuth + Hub3 グローバル mode を伴う daemon 特別扱い
- surface: serve
- backend: cloud
- command: ir.learn (RPC)
- branch: -
- assert: ir.learn は requireAuth/need([remote,key]) を通し hub.learnIR を呼ぶ。hub.learnIR→learnIRKey が setIRMode(REGISTER)→subscribeIRData→波形受信→setIRMode(CONTROL)→addIRCode を実行。IR learn は Hub3 グローバル mode を握る危険 op として daemon 委譲扱い
- ref: packages/kit/src/serve/entries/ir.js:42-51; packages/kit/src/serve/registry.js:7; packages/core/src/ir.js:507-563; packages/core/src/client.js:747-767
- kind: contract-existence
- status: planned
- note: 未確認: 元 ir.js:487-549 は 487 が JSDoc 途中。複合フローの実体は learnIRKey(507-563): REGISTER(510)→subscribeIRData(511)→CONTROL(549)→addIRCode(561)。hub.learnIR ラッパは client.js:747-767 で learnIRKey を呼ぶ。registry.js:7 の危険 op 委譲コメントは支持

### [IR-0116] ir.listKeys の direct 経路 (hub3DeviceId+irDeviceUUID 両指定) と config 解決の二分岐
- surface: serve
- backend: cloud
- command: ir.listKeys (RPC)
- branch: config解決(remote) | direct(両指定) | 片方のみ(エラー)
- assert: hub3DeviceId/irDeviceUUID どちらか有れば need([両方]) を強制し getIRCodesDirect、なければ listKeys(remote)。片方だけ指定は need() が明示エラー
- ref: packages/kit/src/serve/entries/ir.js:22-41; packages/core/src/client.js:407,1406
- kind: option-branch
- status: planned
- note: 行番号確認済。hub.listKeys(client.js:407) / getIRCodesDirect(client.js:1406) の実在を補強

### [IR-0117] ir.matchRemote の必須 (irData/irType) と任意 brandName のフレーム写像
- surface: serve, cli
- backend: cloud
- command: ir.matchRemote / sesame ir match
- branch: brandNameあり | なし
- assert: need([irData,irType]) 後 hub.matchIRRemote({irData,irType,brandName}) を呼び、vendor matchRemote は irWaveLength=irData.length/2 を付与する (brandName 未指定はキー省略)
- ref: packages/kit/src/serve/entries/ir.js:108-117; packages/core/src/ir.js:464-475; references_web/src/api/useRemoteCtrl.js:785-806
- kind: wire-fidelity
- status: planned
- note: irWaveLength=irData.length/2 行は core/src/ir.js:471 のため範囲を 464-469→464-475 に拡張。vendor は useRemoteCtrl.js:793 で同式。matchIRRemote は client.js:911

### [IR-0118] ir.addRemoteToMatter のフィールド (irDeviceType/cmdOn/cmdOff/irDeviceUUID/irDeviceName) が vendor と1:1
- surface: serve, cli
- backend: cloud
- command: ir.addRemoteToMatter / sesame ir remote-add-matter
- branch: -
- assert: フレームが {op:'addRemoteToMatter', hub3DeviceId, irDeviceType, cmdOn, cmdOff, irDeviceUUID, irDeviceName, companyID}、vendor は irRemote.type/uuid/alias を irDeviceType/irDeviceUUID/irDeviceName に写像
- ref: packages/core/src/ir.js:274-287; packages/kit/src/serve/entries/ir.js:120-143; references_web/src/api/useRemoteCtrl.js:933-955
- kind: wire-fidelity
- status: planned
- note: 全行番号確認済。core ir.js:274-287 フレーム / serve entry 120-143 (6 必須 param) / vendor 933-955 (type→irDeviceType@940, uuid→irDeviceUUID@943, alias→irDeviceName@944) が 1:1。実機 Matter ペアリング往復は静的検証外なので waived 不要 — フレーム形のみ検証

### [IR-0119] listIRRemotes/searchPresetIRRemotes が {list,pagination} 形で応答を読む
- surface: serve, cli
- backend: cloud
- command: ir.listRemotes / ir.searchRemotes / sesame ir remote-list / sesame ir search
- branch: list | search
- assert: vendor 応答 {data:{data:[...],pagination:{...}}} を {list,pagination} に正規化、search の pageSize=1000・list の既定 pageSize=200 が vendor と一致
- ref: packages/kit/src/serve/entries/ir.js:52-65; packages/core/src/ir.js:81-121; references_web/src/api/useRemoteCtrl.js:21,43-63,349-414
- kind: payload-fidelity
- status: planned
- note: 検証済: 正規化 list/pagination は core ir.js:96,120、既定 pageSize=200 は core ir.js:87 + vendor defaultPageSize=200 (useRemoteCtrl.js:21)、search pageSize=1000 は core ir.js:114 / vendor useRemoteCtrl.js:412。元 ref の send 範囲 360-414 は line21(default定義)と getRemoteList send 開始(349)を取りこぼしていたため 21,349 を補い、実装側 core ir.js を追加。

## presetir i18n / sdk manifest

presetir CLI/エラーの i18n キー網羅と生成 SDK の presetir 引数形が core シグネチャと一致することを固定する。

### [IR-0120] presetir CLI/エラーの i18n キーが全 locale に存在し fallback しない
- surface: cli, core
- backend: cloud
- command: preset-ir / ir コマンド群 (i18n)
- branch: ja | en
- assert: presetir.cmd.*/opt.*/out.*/err.*/prompt.* と cli.descIr*/cli.ok* の各キーが全 locale に存在し欠落で key 文字列が漏れない
- ref: packages/core/src/i18n/presetir.js:1-88; packages/kit/src/i18n/cli.js:329-348,750-769; packages/kit/src/cli/presetir.js:117-264; packages/kit/src/cli/ir.js:322-362
- kind: i18n
- status: planned
- note: 検証済: presetir 定義は core i18n/presetir.js で en/ja 対称(全 cmd/opt/out/err/prompt キー両 locale 在: 4-43 / 47-86)。cli.* 定義は kit i18n/cli.js (registerCatalog 経由) で、ir.js が使う cli.descIr*/cli.ok* 等 58 キーが en/ja とも欠落 0 (node 実測)。元 ref は消費側 presetir.js:117-264 のみで定義側カタログ未参照だったため、定義源 i18n/presetir.js と i18n/cli.js を追加(完全性の出典)。

### [IR-0121] 生成 SDK (ts/py) の presetir 引数形が core 関数シグネチャと一致
- surface: sdk
- backend: cloud
- command: presetir.sendIR / emitAir / emitButton (generated SDK)
- branch: ts | py
- assert: rpc-params.generated の presetir.* 引数 (required/型) が core 関数シグネチャと一致 — sendIR は deviceId/hub3DeviceId 各任意・command/irType 必須、emitAir は deviceId/code 必須、emitButton は deviceId/code/irType/buttonType 必須
- ref: packages/kit/src/serve/rpc-params.generated.json:1907,1974,2081; packages/core/src/presetir.js:525-549,584-618,625-650
- kind: surface-parity
- status: planned
- note: 検証済: rpc-params.generated.json:1907=presetir.sendIR(deviceId/hub3DeviceId required:false, command/irType required:true), :1974=emitAir(deviceId/code required:true, companyID required:false=daemon注入), :2081=emitButton(deviceId/code/irType/buttonType required:true)。core presetir.js:530-532 で sendIR が deviceId(deviceId??hub3DeviceId)/command/irType を runtime 必須化、emitAir/emitButton の required は JSDoc シグネチャ(584-589/625-629)由来で deviceId/code 等は非?型。core 行 ref を関数シグネチャ全体を覆うよう 592→584-618, 632→625-650 に補正。

## 監査追補 v2 (dual-audit)

dual-audit (B2 split) で抽出した IR ドメイン固有の欠落・精緻化所見を固定する。

### [IR-0122] sendIRDirect は config バイパスの直 IR 発射 core public メソッド (getIRCodesDirect と対称)
- surface: core
- backend: cloud
- command: sendIRDirect
- branch: -
- assert: sendIRDirect が {hub3DeviceId, irDeviceUUID, irType, command, operation?(既定 learnEmit)} を受け、config 解決を介さず transport.sendIR へ {deviceId:hub3DeviceId, irDeviceUUID, irType, command, operation, companyID} を写像する config バイパス公開メソッドとして存在する (getIRCodesDirect=listKeys 直経路と対称)
- ref: packages/core/src/client.js:1389-1399; packages/core/types/client.d.ts:713; packages/kit/src/serve/entries/ir.js:37
- kind: contract-existence
- status: planned
- note: client.js:1389 が async sendIRDirect({hub3DeviceId,irDeviceUUID,irType,command,operation='learnEmit'})、:1391-1398 で sendIR(ws,{deviceId:hub3DeviceId,...,operation,companyID})。types/client.d.ts:713 に型出力。serve/cli/sdk ラッパが無い core 専用メソッドで、対の getIRCodesDirect ([[IR-0012]]/[[IR-0116]] が固定) は serve 露出するため非対称。operation 既定 'learnEmit' は name-based 経路 ([[IR-0003]]) に既定が無い点と対比される

### [IR-0123] ir match の --json|text 出力封筒 ({count, matches} / foundMatchingRemotes 行 + 各候補列挙)
- surface: cli
- backend: cloud
- command: `sesame ir match <irType> <irData> --json`
- branch: --json | text
- assert: --json 時は {count, matches} 封筒を出力し、非 json 時は cli.foundMatchingRemotes 行の後に各候補を JSON.stringify で列挙する ([[IR-0047]] remote-list / [[IR-0051]] search の出力封筒と完全に並行)
- ref: packages/kit/src/cli/ir.js:186-192; packages/kit/src/i18n/cli.js:163
- kind: option-branch
- status: planned
- note: cmdIRRemoteMatch (cli/ir.js:186-192) は out(opts.json, テキスト時 console.log(cli.foundMatchingRemotes{count}) の後 for(m of matches) console.log(JSON.stringify(m)), {count:matches.length, matches})。i18n キー cli.foundMatchingRemotes は cli.js:163(en)/584(ja) に実在。[[IR-0070]] は core の resp.data.matches 抽出、[[IR-0071]] は irData 必須検証のみで CLI 出力分岐は未固定だった

### [IR-0124] subscribeIRMode の wire frame (op/topic hub3/{deviceId}/ir/mode/deviceId/companyID)
- surface: core
- backend: cloud
- command: subscribeIRMode
- branch: -
- assert: subscribeIRMode ack フレームが {action:'biz3IRRemote', op:'subscribeIRMode', topic:`hub3/${deviceId}/ir/mode`, deviceId, companyID} で vendor の topic 文字列・キー集合と一致する (modeTopic は ir/learned/data ではなく ir/mode)
- ref: packages/core/src/ir.js:57; packages/core/src/ir.js:425-431; references_web/src/api/useRemoteCtrl.js:665-690
- kind: wire-fidelity
- status: planned
- note: ir.js:425-431 で subscribeIRMode が export され ack frame {action:ACTION, op:'subscribeIRMode', topic:modeTopic(deviceId), deviceId, companyID} を送る。modeTopic は ir.js:57 = `hub3/${deviceId}/ir/mode`。vendor useRemoteCtrl.js:667 topic=`hub3/${deviceId}/ir/mode`。[[IR-0018]] が subscribeIRData の topic (ir/learned/data) を、[[IR-0042]] が両 subscribe の deviceId フィルタを固定するが mode topic 文字列は別文字列で独立検証境界

### [IR-0125] subscribeIRData/subscribeIRMode の ack 失敗 (!ack.success) → rejected(upstreamCode 付き)
- surface: core
- backend: cloud
- command: subscribeIRData / subscribeIRMode
- branch: ack.success=true | ack.success=false
- assert: subscribe ack が success:false の場合 rejected('domain.ir.subscribeIRDataFailed' / 'domain.ir.subscribeIRModeFailed', {detail}) を upstreamCode=ack.code 付きで投げ、subscribe が確立できないまま波形待ちに入るのを防ぐ
- ref: packages/core/src/ir.js:389-390; packages/core/src/ir.js:430-431; packages/core/src/i18n/domain.js:59-60; packages/core/src/i18n/domain.js:174-175
- kind: error-path
- status: planned
- note: ir.js:390 `if(!ack.success) throw rejected(t('domain.ir.subscribeIRDataFailed',{detail}), {upstreamCode: ack?.code ?? null})`、ir.js:431 が subscribeIRMode で同パターン (subscribeIRModeFailed)。i18n キーは domain.js:59-60(en)/174-175(ja) に実在。assertSuccess(strict) ([[IR-0080]]) 経由ではなく独自の if(!ack.success) throw 経路で upstreamCode を明示渡しする点が他 error-path と異なる。learnIRKey/onIRLearned が subscribeIRData を呼ぶため subscribeIRDataFailed は実運用パス。i18n 完全性は [[IR-0043]] が網羅

### [IR-0126] unsubscribeIRData/unsubscribeIRMode の fire-and-forget send フレーム
- surface: core
- backend: cloud
- command: unsubscribeIRData / unsubscribeIRMode
- branch: -
- assert: unsubscribe 時 client.send({action, op:'unsubscribeIRData'|'unsubscribeIRMode', topic, deviceId, companyID}) を fire-and-forget (request ではなく send) で発行し、キー集合が vendor と一致する。request にすると 10s ブロックするため send 固定 (Review H-5)
- ref: packages/core/src/ir.js:411-414; packages/core/src/ir.js:450-452; references_web/src/api/useRemoteCtrl.js:726-748; references_web/src/api/useRemoteCtrl.js:754-776
- kind: wire-fidelity
- status: planned
- note: ir.js:413 `client.send({action:ACTION, op:'unsubscribeIRData', topic, deviceId, companyID})`、ir.js:451 が unsubscribeIRMode で同形。コメント ir.js:411 が『request にすると 10s block』を明示 (send 選択の意図的逸脱・テスト価値あり)。vendor unsubscribeIRMode frame は useRemoteCtrl.js:738-744、unsubscribeIRData は 766-772。subscribe 側の topic/frame ([[IR-0018]])・冪等 ([[IR-0041]]) と対をなす teardown 境界

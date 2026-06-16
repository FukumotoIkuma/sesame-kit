<!-- spec-domain: devices | prefix: DEV | tests: packages/core/tests/devices, packages/core/tests/client, packages/kit/tests/cli -->

# デバイス管理 spec (DEV)

devices.* / device.* / firmware.list のクラウド管理操作 (一覧/追加/並べ替え/通知/履歴/電池/改名/削除) を biz3 web (useManageDevice) に照らして監査する。

## devices.list

会社デバイス一覧 (getCompanyDevice / PubedCompanyDevice) のページ蓄積 wire と、機密を含む dump 出力のパーミッションを固定する。

### [DEV-0001] devices.list → hub.listDevices (getCompanyDevice / PubedCompanyDevice 集約)
- surface: core, serve, sdk, cli
- backend: cloud
- command: `sesame devices` / devices.list
- branch: single-page | multi-page-accumulate
- assert: client.listDevices() が {action:'biz3ManageDevice', op:'getCompanyDevice', companyID} を送り、PubedCompanyDevice の page 単位 push (data={totalPage,data:{list,page}}) を page===1 全置換・page>1 追記・totalPage===page 完了で集約する形が vendor と一致する
- ref: references_web/src/api/useManageDevice.js:218-226; references_web/src/api/useManageDevice.js:36-56; packages/core/src/client.js:476-503; packages/kit/src/serve/entries/device.js:26-30
- kind: wire-fidelity
- status: covered
- note: action 値は vendor references_web/src/constants/messageConstants.js:4 'biz3ManageDevice'。client.js:476-503 に sendFrame(getCompanyDevice)・errorAction・onMessage の page 集約 (L494-501) を含む。PubedCompanyDevice の蓄積ロジックは getUserDevices (PubedUserDevice) と同型 (devices.js:77-108)。

### [DEV-0002] devices dump の devices.json を 0600 (親 0700) で書く
- surface: cli
- backend: local
- command: `sesame devices`
- branch: -
- assert: listDevices 結果 (secretKey 含む) を writeSecretJson で devices.json に 0600 (親 0700) で書く (旧実装の mode 無指定 0644 ではない)
- ref: packages/kit/src/cli/device.js:31-49; packages/core/src/secure-fs.js:43-64
- kind: error-path
- status: covered
- note: writeSecretJson は secure-fs.js:62-64、実モード設定の writeSecretFile は 43-55。device.js:34-35 で writeSecretJson(paths.devices,{devices:list}) を呼びコメントで 0600/親0700・旧 0644 を明記。

## devices.userList

ユーザデバイス一覧 (getUserDevice / PubedUserDevice) のページ蓄積 wire と、終端・即時エラー・partial 戻り shape の分岐を固定する。

### [DEV-0003] devices.userList → getUserDevices (getUserDevice / PubedUserDevice 集約)
- surface: core, serve, sdk, cli
- backend: cloud
- command: `sesame device user-ls` / devices.userList
- branch: single-page | multi-page-accumulate
- assert: getUserDevices が sendFrame {action:'biz3ManageDevice', op:'getUserDevice'} を送り (companyID 無し)、PubedUserDevice push の page===1 全置換 / page>1 追記 / totalPage===page 完了で配列に集約する形が vendor と一致する
- ref: references_web/src/api/useManageDevice.js:210-216; references_web/src/api/useManageDevice.js:38-55; packages/core/src/devices.js:77-108
- kind: wire-fidelity
- status: covered
- note: getUserDevices フレーム (L212 message={action, op:'getUserDevice'}, companyID 無し)、PubedUserDevice page 蓄積 (L43-47 page===1 全置換/else 追記)、core 1:1 (L85 sendFrame, L102 蓄積)。

### [DEV-0004] getUserDevices: totalPage 非数値は単一 chunk として即完了
- surface: core
- backend: cloud
- command: devices.getUserDevices
- branch: totalPage-missing | totalPage>=page
- assert: msg.data.totalPage が number でない応答を単一 chunk とみなし finish() する分岐が、vendor の totalPage===page 完了契約と齟齬なく終端する (取りこぼし無し)
- ref: references_web/src/api/useManageDevice.js:48-55; packages/core/src/devices.js:99-105
- kind: wire-fidelity
- status: covered

### [DEV-0005] getUserDevices: 同 action success:false 即時エラーで timeout を待たず失敗 (errorAction)
- surface: core
- backend: cloud
- command: devices.getUserDevices
- branch: errorAction-immediate-fail | timeout
- assert: 要求 op(getUserDevice)と同 action の {success:false,message} 即応で、timeout を待たず message を含む rejected で失敗確定する (vendor !message.success 判定相当)
- ref: references_web/src/api/useManageDevice.js:27-34; packages/core/src/devices.js:88-90; packages/core/src/util.js:172-185
- kind: error-path
- status: covered
- note: reject 即時化の実装は subscribeChunks errorAction 経路 (util.js:172-185 finish(rejected(detail:msg.message)))。vendor は React handler で snackbar 表示のみのため judgement の負の類比 (一方向)。

### [DEV-0006] getUserDevices: partialOnTimeout=true は {partial,list} shape で部分蓄積を resolve
- surface: core
- backend: cloud
- command: devices.getUserDevices
- branch: partialOnTimeout=false-array | partialOnTimeout=true-object
- assert: partialOnTimeout=true 指定時、timeout で reject せず {partial:true,list} を、完走時は {partial:false,list} を返し、既定(false)は配列戻り (意図的逸脱 §0.1 の shape 切替契約)
- ref: references_web/src/api/useManageDevice.js:38-55; packages/core/src/devices.js:58-94; packages/core/src/util.js:124-155
- kind: option-branch
- status: covered
- note: vendor は UI 蓄積で逐次反映。kit のオプトイン拡張 (local-contract 寄りだが源は vendor 蓄積パターン)。timeout 時の partial:true 合成は util.js:147-152、完走時の {partial:false,list} は devices.js:94 result()。

## devices.add

デバイス追加 (op:add, QR 由来 items 素通し) の wire と、引数/上限エラーを面別に固定する。

### [DEV-0007] devices.add → addDevices (op:add, items 素通し, companyID)
- surface: core, serve, sdk, cli
- backend: cloud
- command: `sesame device add [json]` / devices.add
- branch: single-json-coerced-to-array | array
- assert: request が {action:'biz3ManageDevice', op:'add', items, companyID} で、items(QR 由来キー配列)を整形せず素通しする形が vendor addSesameDevicesToBiz3 と一致する
- ref: references_web/src/api/useManageDevice.js:256-268; packages/core/src/devices.js:181-190; packages/core/src/client.js:1116-1119; packages/kit/src/serve/entries/device.js:38-43
- kind: wire-fidelity
- status: covered
- note: vendor 258-263 と devices.js:185 のキー順 {action,op:'add',items,companyID} 一致。client.addDevices(1116-1119) が companyID 注入し core へ委譲。single-json→array 強制は CLI cmdDeviceAdd (device.js:137)。

### [DEV-0008] addDevices: items 非配列は badRequest / 'Limit Exceeded' は rejected 伝搬
- surface: core, serve, cli
- backend: cloud
- command: `sesame device add [json]` / devices.add
- branch: items-not-array → bad_request | server success:false 'Limit Exceeded' → rejected
- assert: items が配列でなければ badRequest(domain.devices.itemsArray) を投げ、サーバの {success:false,message:'Limit Exceeded'} は assertSuccess(strict) が message を含む rejected で throw して呼び出し側へ伝搬する
- ref: references_web/src/api/useManageDevice.js:27-34; packages/core/src/devices.js:182-188; packages/core/src/util.js:34-44
- kind: error-path
- status: covered
- note: devices.js:182 が itemsArray badRequest、:188 が assertSuccess(strict)。util.js:34-44 で strict=!resp.success → SesameError(code=rejected, detail=resp.message)。vendor 28-30 が 'Limit Exceeded' を識別 (Snackbar 表示のみ、kit は明示失敗)。

### [DEV-0009] device add の引数バリデーションと終了コード (CLI)
- surface: cli
- backend: local
- command: `sesame device add [json]`
- branch: json欠落 | 不正JSON | 単体→配列ラップ
- assert: json 欠落で exit 2 (deviceAddJsonRequired)、JSON.parse 失敗で exit 2 (invalidJsonItems)、非配列入力は [items] へラップして渡す
- ref: packages/kit/src/cli/device.js:131-143
- kind: error-path
- status: covered
- note: L132 !json→die(...,2) deviceAddJsonRequired, L135-136 JSON.parse catch→die(...,2) invalidJsonItems, L137 !Array.isArray→[items] ラップ。i18n キー cli.deviceAddJsonRequired/cli.invalidJsonItems は i18n/cli.js:365-366,786-787 に実在。

### [DEV-0010] devices.add の必須パラメータ検証 (serve)
- surface: serve
- backend: cloud
- command: devices.add
- branch: items欠落
- assert: items 欠落時に need(params,['items']) が INVALID_PARAMS/BAD_PARAMS の RpcError 封筒を返す
- ref: packages/kit/src/serve/entries/device.js:38-43; packages/kit/src/serve/registry-helpers.js:32-38
- kind: error-path
- status: covered
- note: device.js:42 handler が need(params,['items']) を呼ぶ。need は registry-helpers.js:32-38 — 欠落/null/'' で RpcError(code:RPC.INVALID_PARAMS, kind:KIND.BAD_PARAMS) を throw。

## devices.reorder

並べ替え (op:reorderDevices, rank=0-index 採番) の wire と、コピー採番・CLI 並べ替え分岐を固定する。

### [DEV-0011] devices.reorder → reorderDevices (op:reorderDevices, rank=0-index 採番)
- surface: core, serve, sdk, cli
- backend: cloud
- command: `sesame device reorder <uuids...>` / devices.reorder
- branch: -
- assert: 各 item に rank=0-index を付与(先頭ほど大きい負値)してから {action,op:'reorderDevices',items,companyID} を送り、応答は resp.data(並び替え後一覧)を返す形が vendor reorderDevice と一致する
- ref: references_web/src/api/useManageDevice.js:270-285; references_web/src/api/useManageDevice.js:80-81; packages/core/src/devices.js:202-213
- kind: wire-fidelity
- status: covered
- note: vendor 272-274 が item.rank=0-index、275-280 が {action,op:'reorderDevices',items,companyID}。devices.js:205 採番・:208 同形フレーム・:212 resp.data 返却。応答 data の根拠 useManageDevice.js:80-81 setCompanyDevices(message.data) も一致。

### [DEV-0012] reorderDevices: rank 採番はコピーに付与し呼び出し側 items を破壊しない / 非配列は badRequest
- surface: core
- backend: cloud
- command: devices.reorderDevices
- branch: items-not-array → bad_request | rank-on-copy
- assert: rank 採番が {...item,rank} のコピー生成で行われ(vendor の in-place 変異とは異なる意図的逸脱 §0.1)、入力 items が破壊されない。items 非配列は badRequest
- ref: references_web/src/api/useManageDevice.js:272-274; packages/core/src/devices.js:203-205
- kind: wire-fidelity
- status: covered
- note: vendor 272-274 は item.rank=0-index の in-place 変異。kit devices.js:205 は items.map((item,i)=>({...item,rank:0-i})) でコピーに付与する逸脱。:203 で非配列 badRequest。実装疑い: devices.js:204 のコメントは『rank 採番は vendor と同じ in-place』と書くがコード(:205)はコピー写像で矛盾。テスト実装時にこの紛らわしいコメントを拾う (コメント修正は別タスク)。

### [DEV-0013] device reorder CLI の全件並べ替え・未知UUID分岐
- surface: cli
- backend: cloud
- command: `sesame device reorder <uuids...>`
- branch: uuids空 → exit 2 | 未知UUID → exit 2 | 指定先頭+残りを現順で末尾
- assert: uuids 空で exit 2 (deviceReorderUuidsRequired)、指定 UUID を normalizeUuid で照合し未知なら exit 2 (deviceReorderUnknownUuid)、指定を先頭・未指定を現在順で末尾に並べて hub.reorderDevices へ渡す
- ref: packages/kit/src/cli/device.js:153-171
- kind: option-branch
- status: covered
- note: 空チェック L154 cli.deviceReorderUuidsRequired、unknown は L161 deviceReorderUnknownUuid、prepend+remainder L159-164、hub.reorderDevices(ordered) L165。

## devices.notifyStatus

通知一覧取得 (op:notifyList) の wire を固定する。

### [DEV-0014] devices.notifyStatus → getNotifyStatus (op:notifyList, companyID+pushToken+items)
- surface: core, serve, sdk, cli
- backend: cloud
- command: `sesame device notify [uuid]` (一覧) / devices.notifyStatus
- branch: all-devices | single-uuid-filtered
- assert: request が {action:'biz3ManageDevice',companyID,pushToken,items,op:'notifyList'} のキー集合・順で送られ、応答は resp.data を返す形が vendor getDevicesNotifyStatus と一致する。items 非配列は badRequest。CLI は uuid 指定で items を当該 1 台に絞る/無指定で全 listDevices を {deviceUUID,deviceModel} に写像する
- ref: references_web/src/api/useManageDevice.js:287-302; packages/core/src/devices.js:223-232; packages/kit/src/cli/device.js:196-203
- kind: wire-fidelity
- status: covered
- note: vendor 291-297 と devices.js:227 のキー順一致。:224 非配列 badRequest、:231 resp.data 返却。CLI target filter L197-200 + map {deviceUUID,deviceModel} L201 + getDevicesNotifyStatus L202。

## devices.notifyManage

通知 ON/OFF (op:notifyManage, enablePush 1/0 正規化) の wire と、必須/排他オプション検証を固定する。

### [DEV-0015] devices.notifyManage → switchNotify (op:notifyManage, enablePush 1/0 正規化)
- surface: core, serve, sdk, cli
- backend: cloud
- command: `sesame device notify [uuid] --on|--off` / devices.notifyManage
- branch: enablePush boolean→1/0 | numeric-passthrough
- assert: request の {action,companyID,enablePush,deviceUUID,pushToken,op:'notifyManage'} のキー集合・順が vendor switchDeviceNotify と一致する。enablePush の boolean→1/0 正規化(数値はそのまま)は kit 側の意図的追加で vendor は raw 素通し
- ref: references_web/src/api/useManageDevice.js:304-320; packages/core/src/devices.js:241-257; packages/kit/src/serve/entries/device.js:59-75
- kind: wire-fidelity
- status: covered
- note: vendor 308-315 のキー順 {action,companyID,enablePush,deviceUUID,pushToken,op:'notifyManage'} は devices.js:245-252 と一致するが、vendor は enablePush を raw で乗せる(正規化なし)。1/0 正規化は kit devices.js:248 のみの逸脱。:242 deviceUUID 必須 badRequest。

### [DEV-0016] device notify の必須/排他オプション検証 (CLI + serve)
- surface: cli, serve
- backend: cloud
- command: `sesame device notify` / devices.notifyManage
- branch: --token欠落 → exit 2 | --on と --off 同時 → exit 2 | enablePush 欠落(serve)
- assert: CLI は --token 欠落で exit 2 (pushTokenRequired)・--on と --off 同時指定で exit 2 (notifyOnOffExclusive)、serve は enablePush undefined/null で missingParam の BAD_PARAMS RpcError
- ref: packages/kit/src/cli/device.js:181-194; packages/kit/src/serve/entries/device.js:59-75
- kind: error-path
- status: covered
- note: CLI pushTokenRequired L182、notifyOnOffExclusive L183、serve enablePush undefined/null→BAD_PARAMS RpcError L70-72 (notifyManage entry L59-75)。

## devices.switchRecharge

充電池切替 (op:switchRecharge, companyID 非搭載, isRechargeBattery 1/0) の wire と XOR 検証を固定する。

### [DEV-0017] devices.switchRecharge → switchRechargeableBattery (op:switchRecharge, companyID 無し, 1/0)
- surface: core, serve, sdk, cli
- backend: cloud
- command: `sesame device recharge [uuid] --on|--off` / devices.switchRecharge
- branch: on→1 | off→0 | deviceUUID-missing → bad_request
- assert: request が {action:'biz3ManageDevice',deviceUUID,isRechargeBattery:1|0,op:'switchRecharge'} で companyID を**含まない**点(他 op との非対称)が vendor switchRechargebleBattery と一致する。deviceUUID 必須、isRechargeBattery を 1/0 に正規化する
- ref: references_web/src/api/useManageDevice.js:360-372; packages/core/src/devices.js:266-275; packages/kit/src/serve/entries/device.js:76-90
- kind: wire-fidelity
- status: covered
- note: vendor 関数名は switchRechargebleBattery(タイポ)。frame は 362-367 で companyID 不在 (isRechargeBattery?1:0 L365)。core devices.js:270 が companyID 無し・1|0 正規化。core は deviceUUID 欠落→badRequest(devices.js:267)。

### [DEV-0018] device recharge の --on/--off 必須・排他検証 (XOR)
- surface: cli, serve
- backend: cloud
- command: `sesame device recharge [uuid] --on|--off` / devices.switchRecharge
- branch: neither-or-both → exit 2 | --on → 1 | --off → 0 | isRechargeBattery欠落(serve)
- assert: CLI は !!on===!!off (両方/両方なし)を die(...,2) で拒否 (rechargeOnOffRequired)、--on で isRechargeBattery=true・--off で false を switchRechargeableBattery へ渡す。serve は isRechargeBattery undefined/null で missingParam の BAD_PARAMS RpcError
- ref: packages/kit/src/cli/device.js:213-223; packages/kit/src/serve/entries/device.js:76-91
- kind: option-branch
- status: covered
- note: CLI !!on===!!off→rechargeOnOffRequired exit2 L214、L218 isRechargeBattery=!!options.on、L219 hub.switchRechargeableBattery。serve isRechargeBattery undefined/null→BAD_PARAMS RpcError L86-88。

## device.rename

改名 (op:updateName, obj ネスト + subUUID 同送) の wire と CLI 対話を固定する。

### [DEV-0019] device.rename → updateDeviceName (op:updateName, obj ネスト + subUUID 同送)
- surface: core, serve, sdk, cli
- backend: cloud
- command: `sesame device rename [uuid] [name]` / device.rename
- branch: -
- assert: request が {action:'biz3ManageDevice', obj:{subUUID,deviceUUID,deviceName}, op:'updateName'} の obj ネスト形で送られ (フラットでない)、subUUID は connect() で idToken から取得した値を載せる (未取得は NOT_CONNECTED)
- ref: references_web/src/api/useManageDevice.js:239-254; packages/core/src/devices.js:137-148; packages/core/src/client.js:1086-1091
- kind: wire-fidelity
- status: covered
- note: vendor frame L241-249 (obj{subUUID,deviceUUID,deviceName}, op:'updateName')、core updateDeviceName frame L141-143、client renameDevice subUUID=this._subUUID + NOT_CONNECTED throw L1089。

### [DEV-0020] device rename CLI の対話/必須名検証
- surface: cli
- backend: cloud
- command: `sesame device rename [uuid] [name]`
- branch: uuid欠落→pick | name欠落→対話prompt | name欠落+非対話 → exit 2
- assert: uuid 未指定は pickDeviceUUID 経由で解決し未解決なら exit 2、name 未指定かつ対話なら promptText で入力を求め、得られなければ exit 2 (newNameRequiredDevice)
- ref: packages/kit/src/cli/device.js:91-100
- kind: option-branch
- status: covered
- note: cmdDeviceRename で uuid→pickDeviceUUID→!uuid die(deviceUuidRequired,2) (93-94)、!newName && canPrompt→promptText (95)、!newName die(newNameRequiredDevice,2) (96)。i18n cli.newNameRequiredDevice 実在 (kit/src/i18n/cli.js:173,594)。

## device.delete

削除 (op:del, items=[{deviceUUID,subUUID}]) の wire と CLI 確認ガードを固定する。

### [DEV-0021] device.delete → deleteDevices (op:del, items=[{deviceUUID,subUUID}])
- surface: core, serve, sdk, cli
- backend: cloud
- command: `sesame device rm [uuid]` / device.delete
- branch: subUUID-available | subUUID-missing → NOT_CONNECTED
- assert: request が {action:'biz3ManageDevice',op:'del',companyID,items} で、items 各要素が {deviceUUID,subUUID} 形 (subUUID 常時同送) である点が vendor removeSesameDevices の items 正準形と一致する。subUUID(connect() で idToken から取得)が未取得なら NOT_CONNECTED(retryable) を throw し送信しない (rename DEV-0019 と同形・client.js:1104)
- ref: references_web/src/api/useManageDevice.js:228-237; references_web/src/components/MobileRemoveDevice.js:58-64; packages/core/src/devices.js:159-166; packages/core/src/client.js:1100-1109
- kind: wire-fidelity
- status: covered
- note: useManageDevice.js:232 が {action,op:'del',companyID,items} を素通し、devices.js:161 が同形。{deviceUUID,subUUID} 正準形は呼び出し側 (MobileRemoveDevice.js:59-64 / client.js:1107) が組み立てる。subUUID 未取得は NOT_CONNECTED throw (client.js:1104)。

### [DEV-0022] device rm の確認/--yes ガードと終了コード
- surface: cli
- backend: cloud
- command: `sesame device rm [uuid] --yes`
- branch: 対話確認 | 非対話 --yes | 非対話 --yes なし → exit 2
- assert: 対話なら confirm(defaultYes:false) で No なら中止 (cancelled)、非対話で --yes なしは exit 2 (nonInteractiveNeedsYes)、--yes ありは確認なしで削除
- ref: packages/kit/src/cli/device.js:107-121
- kind: option-branch
- status: covered
- note: cmdDeviceRm で canPrompt→confirmPrompt(...,{defaultYes:false}) No なら console.error(cancelled) return (111-114)、else !options.yes die(nonInteractiveNeedsYes,2) (115-116)、それ以外は hub.deleteDevice (118)。i18n cli.cancelled / cli.nonInteractiveNeedsYes 実在 (cli.js:135-136,556-557)。

## device.status

単機ステータス取得 (op:getDeviceStatus, data[0] 抽出) の wire と UUID 解決フォールバックを固定する。

### [DEV-0023] getDeviceStatus → op:getDeviceStatus、応答 data[0] のみ採用 (strict)
- surface: core, serve, cli
- backend: cloud
- command: `sesame device status [uuid]` / getDeviceStatus
- branch: data.length>0 → data[0] | empty → null
- assert: request {action:'biz3ManageDevice',op:'getDeviceStatus',deviceUUID} を送り、assertSuccess(strict) 後に応答配列の先頭要素のみ (空なら null) を返す形が vendor の setDeviceStatus(data[0]?:null) と一致する
- ref: references_web/src/api/useManageDevice.js:374-385; references_web/src/api/useManageDevice.js:83-85; packages/core/src/devices.js:123-130
- kind: wire-fidelity
- status: covered
- note: serve 公開は lock.status エントリ (entries/lock.js:110-113 hub.getDeviceStatus, result-schemas.js:103 nullable(DEVICE))、CLI は status op (cli/lock-ops.js:223-224)。'device.status' という名のメソッドは存在しない。

### [DEV-0024] status/history/battery の UUID 解決フォールバック分岐
- surface: cli
- backend: cloud
- command: `sesame device status` / history / battery [uuid]
- branch: uuid指定 | 1台auto-pick | 複数+対話選択 | 複数+非対話 → exit 2
- assert: pickDeviceUUID が uuid 指定で即返し、未指定は listUserDevices→listDevices で候補化、候補 0 は exit 2、1 台は auto-pick、複数+非対話は UUID 要求で exit 2、複数+対話は選択する
- ref: packages/kit/src/cli/pickers.js:65-86; packages/kit/src/cli/device.js:75-83
- kind: option-branch
- status: covered
- note: pickers.js:66 current即返し / 69-72 listUserDevices→listDevices / 74 候補0 die exit2 / 76 1台auto-pick / 77-82 複数+非対話 multipleDevicesNeedUuid exit2 / 83-85 複数+対話 selectFromList。device.js:77-78 status が pickDeviceUUID 呼出+UUID無し die exit2。

## device.history

履歴 (action:biz3GetDeviceHistory, op:getHistory, list[{deviceUUID,lastKey}]) の wire と、自動ページング・非表示化・serve 正規化・CLI 分岐を固定する。

### [DEV-0025] device.history → getDeviceHistory (action:biz3GetDeviceHistory, op:getHistory, list 配列)
- surface: core, serve, sdk, cli
- backend: cloud
- command: `sesame history [deviceUUID]` / device.history
- branch: lastKey-null-first-page | lastKey-set-next-page
- assert: request が {action:'biz3GetDeviceHistory',op:'getHistory',companyID,list,pageSize} で、list が [{deviceUUID,lastKey}] のオブジェクト配列(裸文字列でない)である点が vendor getDeviceHistory と一致し、応答 resp.data を返す
- ref: references_web/src/api/useManageGroup.js:279-294; references_web/src/components/DeviceHistory.js:36-48; packages/core/src/devices.js:338-345; packages/kit/src/serve/entries/device.js:115-132
- kind: wire-fidelity
- status: covered
- note: DeviceHistory.js:37 が getDeviceHistory([{deviceUUID,lastKey}],...) を送る(オブジェクト配列)、resp.data 消費は :38。core getDeviceHistory frame {action:ACT_HISTORY='biz3GetDeviceHistory',op:'getHistory',companyID,list,pageSize} (devices.js:340)。

### [DEV-0026] getAllDeviceHistory: 全ページ自動取得 (res.length===pageSize 継続, lastKey=末尾 timestamp)
- surface: core, cli
- backend: cloud
- command: `sesame history [uuid] --all` / getAllDeviceHistory
- branch: continue(len===pageSize) | terminate(len<pageSize) | timestamp-missing-break | maxPages-cap
- assert: 継続条件が vendor fetchAllHistory と 1:1 (res.length>0 && res.length===pageSize で次ページ、lastKey=末尾 record.timestamp)、pageSize 既定 100。maxPages は無限ループ防止の意図的逸脱
- ref: references_web/src/components/DeviceHistory.js:50-78; packages/core/src/devices.js:360-380; packages/core/src/client.js:1194-1202
- kind: wire-fidelity
- status: covered
- note: DeviceHistory.js:64 res.length>0 && res.length===pageSize(継続)、:56 pageSize=100、:65 末尾 timestamp。core 継続 !(res.length>0 && res.length===pageSize) break (375)、maxPages=1000 安全弁。serve/openrpc/sdk 非露出のため surface に serve 無しは正 (ギャップは [[DEV-0046]])。

### [DEV-0027] device.history → serve 経由 lastKey falsy→null 正規化 (proto3 既定 0)
- surface: serve
- backend: cloud
- command: device.history
- branch: lastKey 未指定(=0) | lastKey 指定
- assert: gRPC proto3 で未指定数値が 0 で届くため lastKey falsy を null (初回ページ) に正規化して getDeviceHistory へ渡す (0 は有効な timestamp ではない)
- ref: packages/kit/src/serve/entries/device.js:115-133
- kind: option-branch
- status: covered
- note: device.history ハンドラ。コメントで proto3 未指定=0 を明記 (128-130)、getDeviceHistory([{deviceUUID:params.deviceUUID, lastKey: params.lastKey || null}], params.pageSize) で falsy→null 正規化 (131)。

### [DEV-0028] history --all と --last-key の相互排他 / timestamp 検証 (CLI)
- surface: cli
- backend: cloud
- command: `sesame history [uuid] --all | --last-key | --delete | --page-size`
- branch: --all+--last-key → exit 2 | --delete-NaN → exit 2 | --last-key-NaN → exit 2
- assert: CLI が --all と --last-key 併用、--delete/--last-key の非数値を die(...,2) で終了コード 2 にし、--all は getAllDeviceHistory(pageSize??100) へ、通常は getDeviceHistory([{deviceUUID,lastKey}]) へ分岐する
- ref: packages/kit/src/cli/device.js:230-264; references_web/src/components/DeviceHistory.js:50-78
- kind: option-branch
- status: covered
- note: cmdHistory。240=--delete NaN die(...,2)、249=--all+--last-key 排他 die(...,2)、250=getAllDeviceHistory(deviceUUID,{pageSize:pageSize??100})、259=--last-key NaN die(...,2)、261=getDeviceHistory([{deviceUUID,lastKey}],pageSize)。i18n historyAllLastKeyExclusive/historyLastKeyInvalid 実在 (cli.js:393-394,814-815)。

### [DEV-0029] device.hideHistory → makeHistoryInvisible (op:makeInvisible, フラット deviceUUID+timestamp)
- surface: core, serve, sdk, cli
- backend: cloud
- command: `sesame history [uuid] --delete <ts>` / device.hideHistory
- branch: -
- assert: request が {action:'biz3GetDeviceHistory',op:'makeInvisible',deviceUUID,timestamp} のフラット形(obj/companyID/list 無し)で、assertSuccess は非 strict(success===false のみ拒否)である点が vendor makeInvisibleHistory と一致する
- ref: references_web/src/api/useManageGroup.js:296-308; packages/core/src/devices.js:388-395; packages/core/src/util.js:34-43
- kind: wire-fidelity
- status: covered
- note: useManageGroup.js:296-308 makeInvisibleHistory は {action,deviceUUID,timestamp,op:'makeInvisible'} フラット。core devices.js:393 assertSuccess(resp,...) は strict 未指定=非 strict(util.js:34 既定 strict=false → success===false のみ拒否)。

### [DEV-0030] history --delete の timestamp 数値検証 (CLI)
- surface: cli
- backend: local
- command: `sesame history [uuid] --delete <ts>`
- branch: --delete 非数値 → exit 2
- assert: --delete の値が非有限数なら exit 2 (historyTimestampInvalid)、有効なら hideDeviceHistory を呼んで早期 return する
- ref: packages/kit/src/cli/device.js:238-244
- kind: error-path
- status: covered
- note: Number(options.delete)→!Number.isFinite で die(...,2) historyTimestampInvalid、有効なら hub.hideDeviceHistory({deviceUUID,timestamp}) 後 return (243)。

## device.battery

電池履歴 (action:biz3GetDeviceBatteryRecord, op:batch-get) の wire と、非 strict 応答・カーソル往復・非表示化・CLI 分岐・機種フィルタを固定する。

### [DEV-0031] device.battery → getBatteryRecord (action:biz3GetDeviceBatteryRecord, op:batch-get)
- surface: core, serve, sdk, cli
- backend: cloud
- command: `sesame battery [deviceUUID]` / device.battery
- branch: lastEvaluatedKey-null-latest | lastEvaluatedKey-set-next-page
- assert: request が {action:'biz3GetDeviceBatteryRecord',op:'batch-get',deviceUUID,lastEvaluatedKey,pageSize} で、応答 {records,lastEvaluatedKey} を返す形 (空応答時の既定 {records:[],lastEvaluatedKey:null}) が vendor getBatteryRecord と一致する
- ref: references_web/src/components/MobileBatteryChart.js:59-68; references_web/src/components/MobileBatteryChart.js:40-50; packages/core/src/devices.js:406-417; packages/kit/src/serve/entries/device.js:134-147
- kind: wire-fidelity
- status: covered
- note: MobileBatteryChart.js:59-68 getBatteryRecord frame、:41-49 data.records/data.lastEvaluatedKey 消費。serve result '{records,lastEvaluatedKey}'(device.js:142)。vendor pageSize は isFromApp?50:100 (MobileBatteryChart.js:64)、kit 既定 100。app=50 分岐は実装していない逸脱。

### [DEV-0032] getBatteryRecord: assertSuccess 非 strict (success 省略の正常応答を例外化しない)
- surface: core
- backend: cloud
- command: device.getBatteryRecord
- branch: success-absent-ok | success===false-reject
- assert: vendor (getBatteryRecordCallback) は success を見ず data.records を読むため、assertSuccess を非 strict にして success フィールドを省略する正常応答を例外化しない(success===false のみ拒否)、data 欠落時は {records:[],lastEvaluatedKey:null} を返す
- ref: references_web/src/components/MobileBatteryChart.js:38-55; packages/core/src/devices.js:411-417; packages/core/src/util.js:34-43
- kind: error-path
- status: covered
- note: MobileBatteryChart.js:38-55 getBatteryRecordCallback は success 未参照で message.data.records を読む。core devices.js:415 assertSuccess(resp,...) は strict 未指定=非 strict(util.js:35 failed=!resp||resp.success===false)。実応答での success フィールド有無は未確認 (REFACTORING_PLAN §9 V9)。

### [DEV-0033] device.battery → serve lastEvaluatedKey (object カーソル) 往復
- surface: serve
- backend: cloud
- command: device.battery
- branch: lastEvaluatedKey 指定 | 無指定
- assert: 応答 lastEvaluatedKey を次回 params.lastEvaluatedKey にそのまま渡せる (旧契約の片道 'returns but cannot pass' を解消、未指定は null)
- ref: references_web/src/components/MobileBatteryChart.js:40-50; packages/kit/src/serve/entries/device.js:134-146
- kind: option-branch
- status: covered
- note: serve device.battery は param lastEvaluatedKey(141,schema:O) を受け、handler(145) で getDeviceBattery(...,{lastEvaluatedKey: params.lastEvaluatedKey ?? null}) に渡す。result '{ records, lastEvaluatedKey }'。

### [DEV-0034] battery --last-key JSON パース必須 / --delete 検証 (CLI)
- surface: cli
- backend: local
- command: `sesame battery [uuid] --last-key <json> | --delete <ts> | --page-size`
- branch: --last-key-invalid-JSON → exit 2 | --delete-NaN → exit 2 | default pageSize=100
- assert: --last-key は JSON.parse して opaque DynamoDB カーソルとして渡し失敗は die(...,2) (batteryLastKeyInvalid)。--delete の非数値も exit 2 (batteryTimestampInvalid)。pageSize 既定 100 で getDeviceBattery へ渡る
- ref: packages/kit/src/cli/device.js:271-306; references_web/src/components/MobileBatteryChart.js:59-68
- kind: option-branch
- status: covered
- note: cmdBattery。281=--delete NaN die(...,2)、286=pageSize 既定 100、292-293=--last-key JSON.parse 失敗 die(...,2)、295=getDeviceBattery(deviceUUID,{pageSize,lastEvaluatedKey})。MobileBatteryChart.js:59-68 が lastEvaluatedKey をそのまま送る(opaque カーソル, 50 で setLastKey)を支持。

### [DEV-0035] device.hideBattery → makeBatteryRecordInvisible (op:makeInvisible, timestamp_second キー)
- surface: core, serve, sdk, cli
- backend: cloud
- command: `sesame battery [uuid] --delete <ts>` / device.hideBattery
- branch: -
- assert: request が {action:'biz3GetDeviceBatteryRecord',op:'makeInvisible',deviceUUID,timestamp_second} で、引数 timestampSecond を wire キー timestamp_second(スネーク)へ写像する点が vendor makeInvisibleRecord と一致する
- ref: references_web/src/components/MobileBatteryChart.js:70-79; packages/core/src/devices.js:425-432; packages/kit/src/serve/entries/device.js:156-162
- kind: wire-fidelity
- status: covered
- note: MobileBatteryChart.js:70-79 makeInvisibleRecord frame {action,deviceUUID,timestamp_second,op:'makeInvisible'}。core devices.js:427 が timestampSecond→timestamp_second 写像。serve device.hideBattery(device.js:156-162) は timestampSecond 必須。

### [DEV-0036] battery の UUID 解決時 model フィルタ (電池搭載機のみ)
- surface: cli
- backend: cloud
- command: `sesame battery [uuid]`
- branch: sesame_/wm_/ssmbot_/bot_/bike_ 前置 | その他除外
- assert: battery の pickDeviceUUID は deviceModel が ^(sesame_|wm_|ssmbot_|bot_|bike_) にマッチする機種のみを候補にフィルタする (history はフィルタ無し)
- ref: packages/kit/src/cli/device.js:271-277; packages/kit/src/cli/pickers.js:73-76
- kind: option-branch
- status: covered
- note: device.js:273-276 cmdBattery が filter:(d)=>/^(sesame_|wm_|ssmbot_|bot_|bike_)/.test(d.deviceModel||'') を渡す。pickers.js:73 で filter 適用・76 で 1 台 auto-pick。history (cmdHistory:235) は filter 無しで pickDeviceUUID を呼ぶ。

## firmware.list

ファームウェア一覧 (action:biz3ListFirmware, op フィールド無し) の wire と success:false 失敗化を固定する。

### [DEV-0037] firmware.list → listFirmware (action:biz3ListFirmware, op フィールド無し)
- surface: core, serve, sdk, cli
- backend: cloud
- command: `sesame firmware` / firmware.list
- branch: data-array | empty
- assert: sendFrame が {action:'biz3ListFirmware'}(op フィールドを持たない)で、単発 push (`biz3ListFirmware:`) の msg.data 配列を返す形が vendor getDownloadFireware と一致する
- ref: references_web/src/api/useDeveloper.js:37-42; references_web/src/api/useDeveloper.js:22-25; packages/core/src/devices.js:441-465
- kind: wire-fidelity
- status: covered
- note: useDeveloper.js:38-41 getDownloadFireware は {action:ACTION_TYPES.BIZ3_LIST_FIRMWARE} のみ(op 無し)を sendMessage。messageConstants.js:17 BIZ3_LIST_FIRMWARE='biz3ListFirmware'。devices.js:446 sendFrame:{action:ACT_FIRMWARE}, :451 key=`${ACT_FIRMWARE}:`, :461 data=msg?.data||[]。serve 面は device.js:179-183 firmware.list が hub.listFirmware() を呼ぶ。

### [DEV-0038] listFirmware: success:false 即時エラーを空配列成功に化けさせない
- surface: core
- backend: cloud
- command: device.listFirmware
- branch: success===false → rejected | data-array-success
- assert: push に msg.success===false が含まれる場合、空配列の成功でなく rejected(upstreamCode 添付)で finish する(vendor は素通しだが kit は明示失敗にする意図的逸脱)
- ref: references_web/src/api/useDeveloper.js:18-31; packages/core/src/devices.js:454-461
- kind: error-path
- status: covered
- note: useDeveloper.js:18-31 handleAPIInfoResponse は success を一切見ず message.data を素通し(:24 setFirmwares(message.data))。devices.js:456-459 msg?.success===false → finish(rejected(...,{upstreamCode:msg?.code??null})), :461 でのみ data 採用。util.js:67- rejected は code=rejected,retryable=false。

## webapi.invoke

WebAPI 透過呼び出し (action:biz3InvokeWebAPIs, op=func, body 常時送信) の wire と、非 strict 応答・履歴クエリの lg 数値 ID を固定する。

### [DEV-0039] webapi.invoke → invokeWebAPI (action:biz3InvokeWebAPIs, op=func, body 常時送信)
- surface: core, serve, sdk, cli
- backend: cloud
- command: `sesame webapi <func>` / webapi.invoke
- branch: query-present-spread | query-undefined-omitted | body-default-{}
- assert: invokeWebAPI の wire ({action:'biz3InvokeWebAPIs',op:func,apiKeyId,[query],body??{}}・query 条件脱落)。重複につき [[WEB-0001]] を正典 (body 常時 [[WEB-0002]]・query 条件脱落 [[WEB-0003]])
- ref: local-contract
- kind: wire-fidelity
- status: waived: 重複（正典 [[WEB-0001]]）
- note: 正典 spec/webapi.md WEB-0001(frame)/WEB-0002(body 常時送信)/WEB-0003(query 条件脱落) が同一 ref(devices.js:481-500, useDeveloper.js:45-58)で先取り済み。biz3InvokeWebAPIs は webapi ドメインが WEB-0001..0034 で全面所有。devices.md は WS biz3ManageDevice/GetDeviceHistory/Battery/ListFirmware 系に限定。

### [DEV-0040] invokeWebAPI: assertSuccess 非 strict (応答素通し契約)
- surface: core
- backend: cloud
- command: device.invokeWebAPI
- branch: success-absent-ok | success===false-reject
- assert: invokeWebAPI の非strict assertSuccess (success 欠落 OK / success===false reject)。重複につき [[WEB-0004]] を正典 ([[WEB-0005]] が success===false reject)
- ref: local-contract
- kind: error-path
- status: waived: 重複（正典 [[WEB-0004]]）
- note: 正典 spec/webapi.md WEB-0004(success 欠落 OK)/WEB-0005(success:false reject) が同一 ref(devices.js:494-498, useDeveloper.js:18-31)で先取り済み。webapi ドメインが assertSuccess 非strict 契約を所有。実応答での success 有無は未確認 (REFACTORING_PLAN §9 V9)。

## webapi.deviceHistory

WebAPI 履歴クエリ (func='webapi_history_get', lg=5 数値 ID) の wire を固定する。

### [DEV-0041] webapiDeviceHistory: query lg=5 数値 ID 既定 (旧 'ja' 文字列バグ修正)
- surface: core, serve
- backend: cloud
- command: webapi.deviceHistory / webapiDeviceHistory
- branch: default lg=5 | override
- assert: webapiDeviceHistory の lg=5 数値 ID 既定 (func='webapi_history_get')。重複につき [[WEB-0008]] を正典
- ref: local-contract
- kind: wire-fidelity
- status: waived: 重複（正典 [[WEB-0008]]）
- note: 正典 spec/webapi.md WEB-0008(lg=5 数値既定) が同一 ref(devices.js:524-530, useDeveloper.js:67-81)で先取り済み。webapi ドメインが webapi_history_get クエリ契約を所有。

## subscribe.deviceUpdate

デバイス state push (pubDeviceStateChange) の購読 action/op 非対称と再接続再送を固定する。

### [DEV-0042] client.onLockStateChangeDevice: UUID 単機購読 frame + model 有無分岐 + normalizeUuid フィルタ + 再接続再送
- surface: core, sdk
- backend: cloud
- command: client.onLockStateChangeDevice / onDeviceUpdate
- branch: model-known-{deviceUUID,deviceModel} | model-unknown-{deviceUUID} | incoming!==target-skip | reconnect-resend
- assert: onLockStateChangeDevice が UUID 単機に対し {action:'biz3ManageDevice',op:'subscribeDevicesUpdate',items:[item],companyID} を送り (model 不明なら item={deviceUUID} のみ・既知なら {deviceUUID,deviceModel})、biz3TriggerLocker:pubDeviceStateChange push を normalizeUuid(data.deviceUUID)===target でフィルタし、onReconnect で frame を再送する形が vendor subscribeDevices(items 写像) と整合する
- ref: references_web/src/api/useManageDevice.js:325-331; references_web/src/api/useManageDevice.js:341-344; references_web/src/api/useIotCtrl.js:20-22; packages/core/src/client.js:1451-1478
- kind: wire-fidelity
- status: covered
- note: client.js:1451-1478 onLockStateChangeDevice は (a) 単機 items=[{deviceUUID(,deviceModel)}] の subscribeDevicesUpdate frame 送信 (1456-1465)、(b) normalizeUuid 一致フィルタ (1473-1474 `if (incoming !== target) return`)、(c) onReconnect 再送 (1467) を持つ。core 共通の subscribeDevicesUpdate frame と push key biz3TriggerLocker:pubDeviceStateChange の非対称自体は events.md [[EVT-0010]] (frame) / [[EVT-0012]] (push key) が正典のため本エントリでは扱わず、client.js 常駐の per-device primitive (単機 frame/model 有無分岐/フィルタ/再送) のみを索引化する。lock.md LOCK-0017..0020 は lock.js の trigger aux 購読 (自前 subscribe frame を送らない) で別物。frame 未送ローカル購読の push 0 負の事実は [[DEV-0050]]。

### [DEV-0043] subscribeDevicesUpdate: 再接続時 sendFrame 再送 (購読状態は接続単位)
- surface: core
- backend: cloud
- command: devices.subscribeDevicesUpdate
- branch: initial-send | reconnect-resend
- assert: サーバ購読状態が接続単位のため、再接続後に sendFrame() を再送できる形を露出する点が vendor onConnectionIdChange→getCompanyDevices→subscribeDevices と整合する。unsubscribeDevicesUpdate op は biz3 に存在せず close 後も上流 push は止まらない
- ref: references_web/src/api/useManageDevice.js:336-358; packages/core/src/devices.js:296-307
- kind: idempotency
- status: covered
- note: useManageDevice.js:336-350 subscribeDevices(devices) → subscribeDevicesUpdate(deviceInfos), :352-358 WebSocketManager.onConnectionIdChange(()=>getCompanyDevices()) — 再接続検知で getCompanyDevices() 再取得しその完了(:51 subscribeDevices)を経て購読を再送する vendor 連鎖を網羅。devices.js:296-298 接続単位購読注記, :299-301 sendFrame() 定義, :302 初回送信, :306 return で露出。unsubscribe 不在は devices.js:288-289 コメント裏付け。

## subscribe.deviceListChanged

デバイス増減 push (pubUserDeviceChange) のローカル購読 (専用 subscribe op 無し) を固定する。

### [DEV-0044] subscribeUserDeviceChange: pubUserDeviceChange push 購読 (専用 subscribe op 無し)
- surface: core, serve
- backend: cloud
- command: devices.subscribeUserDeviceChange / event.deviceListChanged
- branch: -
- assert: pubUserDeviceChange ローカル購読 (専用 subscribe op 無し) の購読キー/ローカル購読の事実。重複につき [[EVT-0015]] を正典 ([[EVT-0016]] も SUBSCRIBABLE/STATE 非配送を所有)
- ref: local-contract
- kind: idempotency
- status: waived: 重複（正典 [[EVT-0015]]）
- note: 正典 spec/events.md EVT-0015 (deviceListChanged = pubUserDeviceChange 源・専用 subscribe op 無くローカル購読のみ) / EVT-0016 (SUBSCRIBABLE_TOPICS 含むが STATE_TOPICS 非配送) が同一 wire・同一 ref(devices.js:325-329, useIotCtrl.js:12,20-25, registry.js)で先取り済み。検証可能な購読 key/ローカル購読の事実は EVT が所有。無購読接続に届くかは実機未検証 (§9 V14)。

## surface-parity

deviceEntriesPre 14 メソッドの面横断存在 (openrpc/proto/grpc-methods/registry)・封筒パリティ・stable 区分・履歴 --all のギャップを固定する。

### [DEV-0045] deviceEntriesPre 14 メソッドの openrpc↔proto↔grpc-methods↔registry 1:1 存在
- surface: serve, sdk
- backend: local
- command: devices.* / device.* / firmware.list
- branch: -
- assert: deviceEntriesPre の 14 メソッド (devices.list/userList/add/reorder/notifyStatus/notifyManage/switchRecharge, device.history/battery/hideHistory/hideBattery/rename/delete, firmware.list) が openrpc.json・sesame.proto・grpc-methods.generated.json・registry に 1:1 で存在し署名が一致する
- ref: packages/kit/src/serve/entries/device.js:24-185; schema/openrpc.json:9233-9776; packages/kit/src/serve/sesame.proto:297-327
- kind: contract-existence
- status: covered
- note: deviceEntriesPre(entries/device.js:24-185) は計16キーだが enumerate 対象は access.registerCards/Passcodes を除く 14。openrpc=9233-9776, proto=297-327 (DevicesList…FirmwareList; AccessRegister* 311-313 を内包), grpc-methods=1573-1666。registry.js:337 が deviceEntriesPre() を reg へ展開。sdk 露出は grpc-methods.generated.json:1573 (devices.list) で確認。

### [DEV-0046] devices/device の cli↔core↔serve↔sdk 同一封筒パリティ (DEVICE 形)
- surface: cli, core, serve, sdk
- backend: cloud
- command: devices.list / device.history / device.battery 他
- branch: -
- assert: 同一操作が cli (--json 封筒)・core 直接・serve (全 framing)・sdk で同じ result を返し、result-schemas の DEVICE 形 (deviceUUID/deviceName/deviceModel/secretKey/keyLevel/rank/stateInfo) と整合する
- ref: packages/kit/src/serve/result-schemas.js:38-102; packages/kit/src/cli/device.js:31-67; packages/core/src/client.js:470-504
- kind: surface-parity
- status: covered
- note: DEVICE 形=result-schemas.js:39-42 (required=[deviceUUID])、devices.list=arr(DEVICE) 同86。cli cmdDevices/cmdDeviceUserLs=cli/device.js:31-67。core listDevices=client.js:470-503。

### [DEV-0047] devices/device メソッドの stable/experimental 区分
- surface: serve, sdk
- backend: local
- command: devices.list / device.history / device.battery / devices.add 他
- branch: stable(app-core) | experimental
- assert: devices.list・device.history・device.battery のみ STABLE_METHODS に app-core で掲載、それ以外の devices.*/device.*/firmware.list は experimental に分類される (stabilityOf が一致)
- ref: packages/kit/src/serve/stability.js:19-66
- kind: contract-existence
- status: covered
- note: STABLE_METHODS=stability.js:19-33 (device 系は devices.list/device.history/device.battery=28-30 のみ 'app-core'; 他は不掲載)。stabilityOf=57-59 (掲載=stable, 他=experimental)。

### [DEV-0048] history --all が serve/openrpc/sdk に未露出のギャップ
- surface: cli, serve, sdk
- backend: cloud
- command: `sesame history --all` / device.allHistory(欠如)
- branch: -
- assert: getAllDeviceHistory (history --all) は CLI/core のみで device.history の自動ページング相当の契約メソッドが serve/openrpc/sdk に存在しないことを surface 母集合上のギャップとして記録する
- ref: packages/core/src/client.js:1194-1202; packages/kit/src/serve/entries/device.js:115-133
- kind: surface-parity
- status: covered
- note: core getAllDeviceHistory=client.js:1194-1202, CLI --all=cli/device.js:386 (option) +246-250 (hub.getAllDeviceHistory 呼出)。serve は単ページ device.history=entries/device.js:115-133 のみ。allHistory/getAllDeviceHistory は openrpc.json・sesame.proto・grpc-methods.generated.json に皆無 (grep 不一致)。意図的か要確認。対は [[DEV-0026]]。

## 監査追補 v2 (dual-audit)

dual-audit (consensus/onlyA/onlyB/conflicts) で追補された境界。新規索引 (missing-*)・対称化・重複裁定を集約する。

### [DEV-0049] listDevices(getCompanyDevice): 同 action success:false 即時エラーで timeout を待たず失敗 (errorAction・DEV-0005 と対称)
- surface: core, serve, sdk, cli
- backend: cloud
- command: devices.list / hub.listDevices
- branch: errorAction-immediate-fail | timeout | multi-page-accumulate
- assert: company 一覧 listDevices(getCompanyDevice) で、要求 op(getCompanyDevice)と同 action(biz3ManageDevice)の {success:false,message} 即応が timeout を待たず message を含む rejected で失敗確定する (DEV-0005 の getUserDevice 側と同形・client.js:489 errorAction)。getUserDevices の DEV-0005 と対称の error-path を固定する。
- ref: packages/core/src/client.js:487-489; packages/core/src/client.js:487-503; packages/core/src/util.js:172-185; references_web/src/api/useManageDevice.js:27-34
- kind: error-path
- status: covered
- note: client.js:487-489 errorAction=BIZ3_MANAGE_DEVICE は user 側 devices.js:88-90 と同形だが DEV-0001 の assert は wire+page 集約のみで immediate-fail を含まない。同型の getUserDevices には DEV-0005 がある非対称を解消。util.js:177-184 で success:false→finish(rejected)。getUserDevices errorAction の op 相関絞りは [[DEV-0052]]。

### [DEV-0050] pubDeviceStateChange は subscribeDevicesUpdate frame を送った接続にのみ届く (frame 未送のローカル購読は push 0・負の事実)
- surface: core
- backend: cloud
- command: client.onLockStateChangeDevice / devices.subscribeDevicesUpdate
- branch: frame-sent-receives-push | local-only-receives-nothing
- assert: pubDeviceStateChange はサーバ接続単位で subscribeDevicesUpdate frame を送った接続にのみ push されるため、ローカル subscribe だけ (frame 未送信) では state push が 1 件も来ない negative fact を固定する (旧 onLockStateChange バグの回帰防止)
- ref: references_web/src/api/useManageDevice.js:48-51; references_web/src/api/useManageDevice.js:336-350; packages/core/src/client.js:1436-1444
- kind: wire-fidelity
- status: covered
- note: client.js:1436-1444 P3-4 ドキュメンテーションブロックが『pubDeviceStateChange は subscribeDevicesUpdate frame を送った接続にのみ push される…旧実装はローカル購読だけでサーバへ frame を送っておらずイベントが永遠に来なかった』と明記。DEV-0043 は再接続再送 (接続単位) を扱うが frame 未送接続では push 0 という負の事実は assert していない。per-device frame 送信 primitive は [[DEV-0042]]。

### [DEV-0051] client.subscribeDeviceUpdates (deprecated alias) → onDeviceUpdate 同一委譲
- surface: core, sdk
- backend: cloud
- command: client.subscribeDeviceUpdates / client.onDeviceUpdate
- branch: -
- assert: 後方互換の subscribeDeviceUpdates(deviceInfos, onUpdate) が onDeviceUpdate(deviceInfos, onUpdate) へ委譲し内部実装が同一である (on* イベント命名統一の旧 API パリティ)
- ref: packages/core/src/client.js:1160-1167; packages/core/src/client.js:1550-1556
- kind: surface-parity
- status: covered
- note: client.js:1165-1167 subscribeDeviceUpdates は `return this.onDeviceUpdate(deviceInfos, onUpdate)` の deprecated alias (@deprecated JSDoc + 委譲)。client.js:1550 onDeviceUpdate が devices.subscribeDevicesUpdate を呼ぶ実体。deprecated だが公開 API のため alias 同一性の固定は回帰防止に有効。

### [DEV-0052] getUserDevices errorAction: 別 op の success:false を無視し同 op のみ reject (op 相関絞り・意図的 vendor 逸脱)
- surface: core
- backend: cloud
- command: devices.getUserDevices / devices.list
- branch: same-op-success:false-reject | other-op-success:false-ignored
- assert: errorAction 経路は受信 success:false フレームの op が要求 op(getUserDevice/getCompanyDevice)と一致する場合のみ reject し、同 action でも別 op(del/updateName/add)の success:false は無視して一覧取得を誤 reject しない (vendor の action 単位判定からの意図的逸脱 §0.1。util.js:180 ownOp 絞り)。op 欠落フレームは従来どおり拾う。
- ref: packages/core/src/util.js:172-185; packages/core/src/devices.js:88-90; references_web/src/api/useManageDevice.js:27-34
- kind: error-path
- status: covered
- note: util.js:180 `if (ownOp !== null && msg.op !== undefined && msg.op !== ownOp) return;` が op 相関で絞る (P3-3)。vendor(useManageDevice.js:27-34)は action レベルでのみ判定し並行 RPC の別 op 失敗で誤 reject する形だが kit は op で絞る意図的逸脱。DEV-0005 の同 op success:false reject を負の分岐側から補完する。company list 側は [[DEV-0049]]。

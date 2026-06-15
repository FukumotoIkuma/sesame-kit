<!-- spec-domain: config | prefix: CFG | tests: packages/core/tests/config, packages/kit/tests/cli -->

# 設定/同期 spec (CFG)

config.sync*(サーバ取り込み)とローカル定義管理(locks/remote/hub3 の config CRUD・name 解決)を監査する。サーバ同期は biz3 web、ローカルは config 契約。

## config.sync source (取り込み元)

### [CFG-0001] 取り込み元 getDevices=listDevices: getCompanyDevice→PubedCompanyDevice 全ページ集約
- surface: core
- backend: cloud
- command: `hub.listDevices (getCompanyDevice)`
- branch: page===1 全置換 | page>1 追記 | totalPage===page 完了
- assert: listDevices()(getCompanyDevice→PubedCompanyDevice 全ページ集約)の source-fetch wire。重複につき [[DEV-0001]] を正典。
- ref: local-contract
- kind: wire-fidelity
- status: waived: 重複（正典 [[DEV-0001]]）
- note: 正典 = spec/devices.md [DEV-0001] (client.js:476-503・useManageDevice.js:218-226,36-56 を ref に持ち surface:core,serve,sdk,cli と広い)。getCompanyDevice の source-fetch wire (送信 frame + PubedCompanyDevice page 集約 page===1 全置換/page>1 追記/totalPage===page 完了) は devices ドメインが所有。config が固有に持つべきは取り込み元→config への変換境界 (CFG-0003 以降の accept 条件) のみ。ID は欠番にせず保持。

### [CFG-0002] listDevices: 同 action の success:false 即時エラーで timeout を待たず失敗確定
- surface: core
- backend: cloud
- command: `hub.listDevices (getCompanyDevice)`
- branch: success:false
- assert: listDevices の同 action(BIZ3_MANAGE_DEVICE) success:false 即時失敗 (errorAction, timeout を待たず確定)。重複につき [[DEV-0005]] を正典。
- ref: local-contract
- kind: error-path
- status: waived: 重複（正典 [[DEV-0005]]）
- note: 正典 = spec/devices.md [DEV-0005] (getUserDevices の同 action success:false 即時失敗 errorAction を同 vendor ref useManageDevice.js:27-34 で固定済み)。getCompanyDevice 側の errorAction (client.js:489) は spec/devices.md [DEV-0001] (client.js:476-503) が所有する listDevices 契約の一部。両者は subscribeChunks の errorAction という同一機構を別 op で叩いているだけで config 固有の境界ではない。ID は欠番にせず保持。

## config.sync locks

### [CFG-0003] syncLocksFromDevices: getCompanyDevice 応答からロックのみ取り込む accept 条件
- surface: core
- backend: cloud
- command: `hub.syncLocksFromDevices` / `ConfigStore.syncLocksFromDevices`
- branch: accept=isLockModel && deviceUUID && secretKey
- assert: listDevices()(getCompanyDevice→PubedCompanyDevice) 応答のうち isLockModel(deviceModel) かつ deviceUUID/secretKey を持つ要素のみ devices{} に取り込み、Hub3/認証機/その他は無視する (取り込み元→config 変換境界)。
- ref: packages/core/src/config.js:744; packages/core/src/config.js:746; packages/core/src/client.js:528; references_web/src/api/useManageDevice.js:115; references_web/src/utils/gUtils.js:296
- kind: wire-fidelity
- status: planned
- note: accept=(d)=>isLockModel(d.deviceModel)&&!!d.deviceUUID&&!!d.secretKey (config.js:746)。client.js:528-532 が listDevices()→configStore.syncLocksFromDevices に委譲。vendor は filteredSsmDevices=companyDevices.filter(isLockModel) (useManageDevice.js:115-117) で isLockModel 判定は gUtils.js:296-298。全 ref 行番号確認済。

### [CFG-0004] isLockModel ホワイトリストが biz3 lockModelDevices と完全一致
- surface: core
- backend: cloud
- command: `ConfigStore.syncLocksFromDevices`
- branch: LOCK_MODELS set vs lockModelDevices array
- assert: LOCK_MODELS(sesame_2/4/5/5_pro/5_us/bot_2/bot_3/ssmbot_1/sesame_6/6_pro/6_pro_slidingdoor/BLE_Connector_1/bike_2/bike_3) が gUtils.lockModelDevices と要素一致し、sesame_face*/ssm_touch* (認証機) と hub_3 を取り込まないこと。
- ref: packages/core/src/config.js:930; packages/core/src/config.js:942; references_web/src/utils/gUtils.js:279; references_web/src/utils/gUtils.js:261
- kind: wire-fidelity
- status: planned
- note: LOCK_MODELS (config.js:930-935) は gUtils.lockModelDevices (gUtils.js:279-294) と要素一致を確認: sesameDeviceModel 定数で ble_connector→'BLE_Connector_1', ssm_bike2→'bike_2', ssm_bike3→'bike_3' (sesameDeviceModel.js:9/14/35) も文字列値一致。認証機 (isSesameAccessControlDevice gUtils.js:261-277) は別カテゴリで取り込まない。prefix マッチ廃止の回帰点。

### [CFG-0005] secretKey/deviceUUID 欠落デバイスは accept で弾く (error-path 相当の欠損入力)
- surface: core
- backend: cloud
- command: `ConfigStore.syncLocksFromDevices`
- branch: missing secretKey | missing deviceUUID
- assert: deviceModel がロックでも secretKey または deviceUUID が無い device は取り込まず added/updated に出さない (鍵なし=ローカル操作不能のため除外)。
- ref: packages/core/src/config.js:746; packages/core/src/config.js:692
- kind: error-path
- status: planned
- note: 純ローカルの取捨判定 (vendor 側には secretKey 必須の filter 相当なし=意図的逸脱)。既存 test syncFromDevices.test.js:71 (it 宣言) / :77 (expect r.added length 0) でカバー、status planned 統一。accept は config.js:746、ループ本体は config.js:692-693 (!accept(d)→continue)。

### [CFG-0006] 初回取り込みで default.lock を最初の added 名に設定 (onFirstAdd)
- surface: core
- backend: cloud
- command: `ConfigStore.syncLocksFromDevices`
- branch: default.lock 未設定 | 設定済み
- assert: default.lock が未設定のとき onFirstAdd が最初に追加されたロック名を default.lock に設定し、設定済みなら上書きしない。
- ref: packages/core/src/config.js:749; packages/core/src/config.js:716
- kind: wire-fidelity
- status: planned
- note: 純ローカル既定値ロジック (local-contract 寄り)。onFirstAdd コールバック (config.js:749-752: if(!data.default.lock) data.default.lock=name) は _syncDevices 内の追加時 (config.js:716: if(onFirstAdd) onFirstAdd(name)) から呼ばれる。test syncFromDevices.test.js:80-85 でカバー。行番号確認済。

### [CFG-0007] syncLocksFromDevices --prune: server 不在ロックの除去 (lock category 限定)
- surface: core
- backend: cloud
- command: `ConfigStore.syncLocksFromDevices`
- branch: prune=true
- assert: prune=true 時、effectiveCategory==='lock' かつ今回の応答 seen に無い deviceUUID の device を削除し removed に積む。hub3/remote view の device は消さない (view 跨ぎ削除防止)。
- ref: packages/core/src/config.js:720; packages/core/src/config.js:725; packages/core/src/config.js:744
- kind: wire-fidelity
- status: planned
- note: prune 判定は accept(model 依存) ではなく effectiveCategory (config.js:725: if(effectiveCategory(r)!==category) continue)。prune ブロックは config.js:720-731、syncLocksFromDevices は category:'lock' を渡す (config.js:744-747)。手動追加 (model 未指定) のロックも対称に prune。行番号確認済。

### [CFG-0008] prune で削除されたロックが default.lock だった場合 null に戻す
- surface: core
- backend: cloud
- command: `ConfigStore.syncLocksFromDevices`
- branch: prune=true & removed==default.lock
- assert: prune で削除された device 名が default.lock と一致する場合、default.lock を null へリセットする (dangling default 防止)。
- ref: packages/core/src/config.js:728; packages/core/src/config.js:729
- kind: wire-fidelity
- status: planned
- note: local-contract。config.js:728 (delete cfg.devices[name]) 直後の config.js:729 (if(cfg.default.lock===name) cfg.default.lock=null) で実装。default.remote は同経路で触らない (lock 専用)。行番号確認済。

### [CFG-0009] prune は category で対象選定するため手動追加 (model 未指定) ロックも除去対象
- surface: core
- backend: cloud
- command: `ConfigStore.syncLocksFromDevices`
- branch: prune=true & rec.deviceModel==null
- assert: categoryForModel(null)==='lock' のため model 未指定の手動ロックも effectiveCategory==='lock' に入り、応答に無ければ prune で除去される (accept 非対称の補正)。
- ref: packages/core/src/config.js:965; packages/core/src/config.js:980; packages/core/src/config.js:725
- kind: wire-fidelity
- status: planned
- note: categoryForModel (config.js:965) は model==null で 'lock' を返す (config.js:968)。effectiveCategory (config.js:980-981) が category||categoryForModel で解決し、prune 比較 (config.js:725) に使われる。行番号確認済。

## config.sync common (_syncDevices)

### [CFG-0010] added/updated/removed の決定: deviceUUID 突合 (ハイフン正規化) で既存判定
- surface: core
- backend: cloud
- command: `ConfigStore._syncDevices`
- branch: 既存 entry あり | 無し
- assert: incoming device の deviceUUID を normalizeUuid して既存 devices レコードの deviceUUID と突合し、一致すれば updated 候補・不一致なら新規 added とする。ハイフン有無/大小だけの差は同一デバイスとみなす。
- ref: packages/core/src/config.js:697; packages/core/src/config.js:714; packages/core/src/crypto.js:153
- kind: idempotency
- status: planned
- note: normalizeUuid は crypto.js から import (config.js:24)。突合本体は config.js:698 (normalizeUuid(r.deviceUUID)===normalizeUuid(d.deviceUUID))。normalizeUuid 定義は crypto.js:153 (dash 除去+小文字化) — 旧 ref crypto.js:1 は未確認: 該当行はファイル冒頭コメントで定義不在のため 153 へ置換。

### [CFG-0011] 更新判定は canonicalize 正準形比較でキー順差の誤検知を防ぐ (冪等)
- surface: core
- backend: cloud
- command: `ConfigStore._syncDevices`
- branch: canonicalize(merged)!==canonicalize(existing)
- assert: 既存 device 更新時、サーバ応答 rec へ LOCAL_ONLY_KEYS を引き継いだ merged を canonicalize して existing と比較し、差があるときだけ updated に積む。値同一でキー順だけ違う場合は updated に出さない (二重 sync 冪等)。
- ref: packages/core/src/config.js:704; packages/core/src/config.js:707; packages/core/src/config.js:990
- kind: idempotency
- status: planned
- note: config.js:704 merged={...rec}, 707 canonicalize 比較, 990 canonicalize 定義 (キー再帰ソート) — 全行支持。

### [CFG-0012] 更新は応答を真実としフィールド総入替、LOCAL_ONLY_KEYS だけ温存
- surface: core
- backend: cloud
- command: `ConfigStore._syncDevices`
- branch: merged={...rec}+LOCAL_ONLY_KEYS
- assert: 更新時 merged はサーバ rec で丸ごと置換し (サーバ側で消えたフィールドは追従削除)、category/ssmPublicKey/keyIndex (LOCAL_ONLY_KEYS) のみ既存値を引き継ぐ。
- ref: packages/core/src/config.js:704; packages/core/src/config.js:705; packages/core/src/config.js:176
- kind: payload-fidelity
- status: planned
- note: LOCAL_ONLY_KEYS=['category','ssmPublicKey','keyIndex'] (config.js:176 で実値確認)。705 が existing[k] を merged へ引き継ぐループ — 支持。

### [CFG-0013] sync 更新でローカル注釈 (category/ssmPublicKey/keyIndex) を引き継ぐ
- surface: core
- backend: cloud
- command: `ConfigStore._syncDevices`
- branch: サーバ応答に注釈無し
- assert: 既存 device 更新時に LOCAL_ONLY_KEYS (category/ssmPublicKey/keyIndex) を existing から merged に引き継ぐ。サーバ応答に無い OS2 鍵素材を sync で消さない (BLE login 用ローカル保存鍵)。
- ref: packages/core/src/config.js:171; packages/core/src/config.js:705
- kind: idempotency
- status: planned
- note: 確認済: LOCAL_ONLY_KEYS 定義は config.js:176 (注釈ブロック 171-176)。引き継ぎ本体は _syncDevices 更新分岐内 config.js:705 (for(k of LOCAL_ONLY_KEYS) ... merged[k]=existing[k])。残存検証テストは os2-key-fields.test.js:93 の it('sync 更新 ... ローカル注釈として残る')。元 note の :94 は同テスト内 const store 行で 1 行ズレ。

### [CFG-0014] sanitizeDeviceRecord: stateInfo を除いた device 全フィールドを保存
- surface: core
- backend: cloud
- command: `ConfigStore._syncDevices` / `sanitizeDeviceRecord`
- branch: stateInfo 除外
- assert: 取り込む device record は stateInfo (IR remoteList 等の巨大ネスト) だけを除外し、残りのフィールド (deviceUUID/deviceModel/deviceName/secretKey 等) は取捨せず丸ごと config に保存する。型ごとの cherry-pick (hub3 で model/secretKey 取りこぼし→lock5 化バグ) を構造的に防ぐ。
- ref: packages/core/src/config.js:695; packages/core/src/config.js:1005
- kind: payload-fidelity
- status: planned
- note: config.js:695 が rec=sanitizeDeviceRecord(d) 呼び出し、1005-1009 が定義 (const {stateInfo, ...rest}=d; return {...rest}) で stateInfo のみ rest 分解除去 — 支持。

### [CFG-0015] 名前衝突時の uniqueName 採番 (name, name-2, name-3)
- surface: core
- backend: cloud
- command: `ConfigStore._syncDevices` / `uniqueName` / `baseName`
- branch: baseName 衝突なし | 衝突あり(連番付与)
- assert: 新規 added の config キーは baseName(deviceName||deviceUUID をスラグ化) を基に、既存キーと衝突する場合 name-2/name-3… でユニーク化する。baseName は trim/空白→_/小文字 (空なら 'device')。
- ref: packages/core/src/config.js:714; packages/core/src/config.js:1017; packages/core/src/config.js:1029
- kind: idempotency
- status: planned
- note: config.js:714 uniqueName(cfg.devices, baseName(...)) 呼び出し、1017-1021 baseName 定義 ((displayName||uuid||'device').trim().replace(/\s+/g,'_').toLowerCase())、1029-1034 uniqueName 定義 (`${base}-${i}` 採番, i=2 開始) — 全行支持。

### [CFG-0016] sync 結果が config ファイルに永続化される (save 呼び出し)
- surface: core
- backend: cloud
- command: `ConfigStore._syncDevices`
- branch: -
- assert: _syncDevices 末尾で this.save() を呼び、added/updated/removed の変更がファイルへ書き込まれ再読込後も残る。
- ref: packages/core/src/config.js:734; packages/core/src/config.js:686
- kind: idempotency
- status: planned
- note: config.js:686 const cfg=this.load() (取り込み開始), 734 this.save() (末尾) — load()→mutate→save() の取り込みトランザクション境界。支持。

## config.sync hub3

### [CFG-0017] syncHub3sFromDevices: hub_3 / hub_3_lte のみ accept
- surface: core
- backend: cloud
- command: `hub.syncHub3sFromDevices` / `ConfigStore.syncHub3sFromDevices`
- branch: accept=isHub3Model && deviceUUID
- assert: deviceModel が hub_3 または hub_3_lte で deviceUUID を持つ device のみ hub3 view (category='hub3') に取り込み、secretKey は不要とする。
- ref: packages/core/src/config.js:762; packages/core/src/config.js:764; packages/core/src/config.js:951; packages/core/src/client.js:540
- kind: wire-fidelity
- status: planned
- note: config.js:762 ConfigStore.syncHub3sFromDevices, 764 accept=(d)=>isHub3Model(d.deviceModel)&&!!d.deviceUUID (secretKey 不問), 951 isHub3Model (===hub_3 || ===hub_3_lte), client.js:540 async syncHub3sFromDevices (listDevices→store 委譲) — 全行支持。

### [CFG-0018] syncHub3sFromDevices --prune: remotes が参照中の hub3 は pruneProtect で残す
- surface: core
- backend: cloud
- command: `ConfigStore.syncHub3sFromDevices`
- branch: prune=true & remotes[*].hub3===name
- assert: prune=true でも、いずれかの remotes レコードが hub3===name を参照している場合 pruneProtect が true を返し、その hub3 は削除しない (参照整合性保護)。
- ref: packages/core/src/config.js:767; packages/core/src/config.js:768; packages/core/src/config.js:727
- kind: option-branch
- status: planned
- note: local-contract (config 内整合)。predicate 本体は 768 (remotes.some(r=>r.hub3===name))、適用は _syncDevices の prune ループ 727。prune オプションの分岐挙動なので kind=option-branch (wire は跨がない)。

### [CFG-0019] hub3 add (cli) は devices から Hub3 を選択 (UUID 手打ち排除)
- surface: cli
- backend: cloud
- command: `sesame hub3 add`
- branch: 0件(exit 2) | 1件自動 | 複数選択
- assert: listDevices を deviceModel hub_3/hub_3_lte で filter し、0件は die(hub3NotFoundInDevices, 2)、1件は自動、複数は selectFromList。name は TTY なら prompt、非TTY は deviceName slug 既定。
- ref: packages/kit/src/cli/remote.js:250; packages/kit/src/cli/remote.js:255; packages/kit/src/cli/remote.js:261
- kind: option-branch
- status: planned
- note: 確認済: cmdHub3Add listDevices->filter deviceModel hub_3/hub_3_lte(remote.js:253-254)、0件 die(cli.hub3NotFoundInDevices,2)(255)、1件自動(256-257)、複数 selectFromList(258-259)、name canPrompt時 promptText 非TTYは deviceName slug 既定(261-264)。i18n hub3NotFoundInDevices 実在(cli.js:113,534)。

### [CFG-0020] hub3 ls: 未初期化 exit 2 / hub3 view shape
- surface: cli
- backend: local
- command: `sesame hub3 ls`
- branch: 未初期化(exit 2) | 空 | 一覧 | --json
- assert: configStore.exists() false なら die(configNotInitialized, 2)。表示は name+deviceId(+name 注記)。--json は {hub3s} で hub3View shape (deviceId/name/model/secretKey)。
- ref: packages/kit/src/cli/remote.js:231; packages/core/src/config.js:200
- kind: option-branch
- status: planned
- note: 確認済: cmdHub3Ls !exists()->die(cli.configNotInitialized,2)(remote.js:233)、空時 noHub3(238)、name+deviceId+(name!=n 注記)(241)、--json {hub3s}(243)、hub3View shape deviceId/name/model/secretKey(config.js:200-202)。

### [CFG-0021] addHub3 必須検証 + category:'hub3' で hub3 view 投影
- surface: core
- backend: local
- command: `ConfigStore.addHub3`
- branch: name欠落 | deviceId欠落 | 正常
- assert: addHub3 が name/deviceId 欠落で badRequest (hub3NameRequired/hub3DeviceIdRequired)。devices{} に {deviceUUID, deviceName, deviceModel:model||'hub_3', secretKey:null, category:'hub3'} を格納し hub3View に投影。
- ref: packages/core/src/config.js:542; packages/core/src/config.js:546; packages/core/src/config.js:200
- kind: error-path
- status: planned
- note: 確認済: addHub3 name欠落->badRequest(domain.config.hub3NameRequired)(config.js:544)、deviceId欠落->hub3DeviceIdRequired(545)、devices[name]={deviceUUID,deviceName:hub3.name||name,deviceModel:hub3.model||'hub_3',secretKey:hub3.secretKey||null,category:'hub3'}(546-552)、hub3View shape(200-202)。i18n キー domain.js:30-31 実在。

### [CFG-0022] CLI hub3 sync-from-devices: --prune オプション露出
- surface: cli
- backend: cloud
- command: `sesame hub3 sync-from-devices [--prune]`
- branch: --prune
- assert: hub3 sync-from-devices が --prune を受け hub.syncHub3sFromDevices({prune}) を呼び printSyncResult(json,'hub3',r) を出力すること。
- ref: packages/kit/src/cli/remote.js:275; packages/kit/src/cli/remote.js:330
- kind: surface-parity
- status: planned
- note: 全ref実在確認: cmdHub3SyncFromDevices=remote.js:275 (syncHub3sFromDevices=277, printSyncResult(...,'hub3',r)=278)、command 登録+--prune=remote.js:330-332。

## config.sync remotes (from devices)

### [CFG-0023] syncRemotesFromDevices: 各 Hub3 の stateInfo.remoteList を展開して取り込む
- surface: core
- backend: cloud
- command: `hub.syncRemotesFromDevices` / `ConfigStore.syncRemotesFromDevices`
- branch: isHub3Model & hub3 登録済み
- assert: getCompanyDevice 応答の hub_3/hub_3_lte 各 device の stateInfo.remoteList を {uuid/irDeviceUUID, type/irType, code, state, alias/name} として展開し remotes{} に取り込む。stateInfo 本体は config に残さず remote へ分解する境界。
- ref: packages/core/src/config.js:782; packages/core/src/config.js:798; packages/core/src/config.js:800-804; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/dto/IrRemote.kt:5-15
- kind: wire-fidelity
- status: planned
- note: remoteList 要素形は IrRemote.kt:5-15 (model/alias/uuid/state/type/code/keys/direction/haveSave)。フィールド分解は config.js:800-804(uuid/type/alias) + 808-809(code/state)。

### [CFG-0024] syncRemotesFromDevices: hub3 未登録の Hub3 配下リモコンはスキップ
- surface: core
- backend: cloud
- command: `ConfigStore.syncRemotesFromDevices`
- branch: hub3ByUuid に無い deviceUUID
- assert: remote の親 Hub3 が config.hub3s に未登録 (hub3ByUuid 逆引き不一致) の場合、その Hub3 のリモコンは取り込まずスキップする (先に syncHub3sFromDevices が必要)。
- ref: packages/core/src/config.js:790-791; packages/core/src/config.js:796; packages/core/src/config.js:797
- kind: error-path
- status: planned
- note: 逆引き Map は cfg.hub3s を h.deviceId で索引 (790-791)。796 で deviceUUID 突合、797 で未登録なら continue。

### [CFG-0025] syncRemotesFromDevices: irDeviceUUID 突合で冪等 (uuid|irDeviceUUID 両受け)
- surface: core
- backend: cloud
- command: `ConfigStore.syncRemotesFromDevices`
- branch: 既存 remote あり | 無し
- assert: remoteList 要素の uuid||irDeviceUUID を normalizeUuid して既存 remotes と突合し、一致時は更新候補・不一致時のみ added にする。再 sync で重複追加しない。uuid 欠落要素は continue でスキップ。
- ref: packages/core/src/config.js:801; packages/core/src/config.js:802; packages/core/src/config.js:811-814; packages/core/src/config.js:829
- kind: idempotency
- status: planned
- note: 突合の normalizeUuid 比較は 812 (find 述語)、一致時は 814 で更新分岐、不一致時は 829 で uniqueName→added。uuid 欠落 continue は 802。

### [CFG-0026] syncRemotesFromDevices: irType/alias/hub3/code/state/irOperation の差分を updated に反映
- surface: core
- backend: cloud
- command: `ConfigStore.syncRemotesFromDevices`
- branch: 既存 remote の各フィールド変更
- assert: 既存 remote について irType(有限値時)/alias(非空時)/hub3/code(非null時)/state(非null時)/irOperation のいずれかがサーバ値と異なる場合のみ更新し existingName を updated に積む (サーバ側が真実、部分追従)。
- ref: packages/core/src/config.js:817; packages/core/src/config.js:818-822; packages/core/src/config.js:824; packages/core/src/config.js:825
- kind: wire-fidelity
- status: planned
- note: フィールド別ガード: irType=Number.isFinite(817), alias=非空(818), hub3(819), code!=null(821), state!=null(822), irOperation=deriveIrOperation 差分(823-824), changed 時 825 で updated.push。getCompanyDevice 応答を真実として吸収する境界のため kind=wire-fidelity (BLE バイト列ではないので payload-fidelity から修正)。

### [CFG-0027] syncRemotesFromDevices: irOperation 導出 (0xFE00=learnEmit, 他=remoteEmit)
- surface: core
- backend: cloud
- command: `ConfigStore.syncRemotesFromDevices` / `deriveIrOperation`
- branch: irType===0xfe00 | その他プリセット
- assert: 取り込む remote の irOperation は deriveIrOperation(irType) で導出し、実 type 0xFE00 (自己学習) のみ learnEmit、0xC000/0x2000/0xE000/0x8000 等プリセットは remoteEmit となること (旧 learnEmit 固定の回帰防止)。
- ref: packages/core/src/config.js:837; packages/core/src/config.js:921-923; references_web/src/pages/personal/devices/wifi-module/ir/remote-air/index.js:370; references_web/src/pages/personal/devices/wifi-module/ir/remote-non-air/index.js:156
- kind: wire-fidelity
- status: planned
- note: vendor は preset を sendIR(hub3DeviceId, remoteId, cmd, 'remoteEmit', remote.type, ...) で送る (remote-air:370 / remote-non-air:156)。deriveIrOperation は config.js:921-923 (irType===0xfe00 のみ learnEmit)。プリセット enum 0xC000/0x2000/0xE000/0x8000・learn 0xFE00 は crypto.js:261-266。

### [CFG-0028] syncRemotesFromDevices: code/state 欠落は捏造せず null 保存、irType 欠落は DEFAULT_IR_TYPE
- surface: core
- backend: cloud
- command: `ConfigStore.syncRemotesFromDevices`
- branch: code==null / state 非文字列 / irType 非有限
- assert: 新規 remote で code が null なら null・state が文字列でなければ null を保存し (捏造しない)、irType が非有限 (Number 変換不可) のとき effType=DEFAULT_IR_TYPE を採用すること。
- ref: packages/core/src/config.js:808; packages/core/src/config.js:809; packages/core/src/config.js:830; packages/core/src/crypto.js:274
- kind: wire-fidelity
- status: planned
- note: 未確認: crypto.js:1 は import ヘッダで DEFAULT_IR_TYPE 定義ではない → 定義行 crypto.js:274 (export const DEFAULT_IR_TYPE = IR_TYPE.learn // 0xFE00) に置換。code=null/state 非文字列の null 保存は 808-809、effType フォールバックは 830。getCompanyDevice 応答の欠落を捏造せず保つ境界のため kind=wire-fidelity (payload-fidelity から修正)。

### [CFG-0029] syncRemotesFromDevices: 初回 added で default.remote を設定
- surface: core
- backend: cloud
- command: `ConfigStore.syncRemotesFromDevices`
- branch: default.remote 未設定
- assert: default.remote が未設定のとき最初に追加したリモコン名を default.remote に設定する。
- ref: packages/core/src/config.js:843
- kind: wire-fidelity
- status: planned
- note: local-contract。config.js:843 `if (!cfg.default.remote) cfg.default.remote = name;` を確認 (added 経路のみ; 既存 remote 更新側 814-826 では設定しない)。

### [CFG-0030] hub.syncRemotesFromDevices: hub3 自動登録→remote 展開を1呼び出しで束ねる
- surface: core
- backend: cloud
- command: `hub.syncRemotesFromDevices`
- branch: -
- assert: client 層 syncRemotesFromDevices は listDevices() を一度引いて syncHub3sFromDevices→syncRemotesFromDevices の順に同一リストへ適用し、{hub3:{added,updated,removed}, remotes:{added,updated}} を返す (先 hub3 登録の前提を内部で満たす)。
- ref: packages/core/src/client.js:556; packages/core/src/client.js:559; packages/core/src/client.js:560; packages/core/src/client.js:562
- kind: contract-existence
- status: planned
- note: client.js:559 listDevices() 1回→560 syncHub3sFromDevices(list)→561 syncRemotesFromDevices(list)→562 return {hub3, remotes}。戻り値 shape は JSDoc 551-554 と一致。順序証拠の 560 を refs に追加。

### [CFG-0031] CLI remote sync-from-devices: remotes 取り込み後に各 remote の鍵を best-effort sync
- surface: cli
- backend: cloud
- command: `sesame remote sync-from-devices`
- branch: added/updated remote ごとに syncRemoteKeys
- assert: remote sync-from-devices が hub.syncRemotesFromDevices() の remotes を取り込み、追加/更新された各 remote 名 ([...remotes.added, ...remotes.updated]) について syncRemoteKeys を best-effort (失敗無視) で呼んでから printSyncResult(json,'remote',remotes) を出力すること。
- ref: packages/kit/src/cli/remote.js:213; packages/kit/src/cli/remote.js:216; packages/kit/src/cli/remote.js:219
- kind: surface-parity
- status: planned
- note: branch/assert 修正: コードは added だけでなく [...remotes.added, ...remotes.updated] を反復 (remote.js:218)。syncRemoteKeys best-effort=remote.js:219 (try/catch)、syncRemotesFromDevices=remote.js:216、printSyncResult=remote.js:221。

## config.sync remotes-from-server (代替経路)

### [CFG-0032] syncRemotesFromServer: getRemoteList 応答を hub3Name 配下に取り込む (代替経路)
- surface: core
- backend: cloud
- command: `hub.syncRemotesFromServer` / `ConfigStore.syncRemotesFromServer`
- branch: irDeviceUUID|uuid 両受け
- assert: listIRRemotes(irType) の list を irDeviceUUID||uuid で取り込み、type/alias/code/state を保存。irOperation は明示値 > deriveIrOperation(effType)。listIRRemotes の {list,pagination} のうち list 本体のみ config へ渡す境界。
- ref: packages/core/src/config.js:859; packages/core/src/config.js:868; packages/core/src/config.js:897; packages/core/src/client.js:600; packages/core/src/client.js:604
- kind: wire-fidelity
- status: planned
- note: config.js:868 `r.irDeviceUUID || r.uuid`、897 `r.irOperation || deriveIrOperation(effType)`、type/alias/code/state は 870-874 抽出→892-900 保存。client.js:604 `const { list } = await this.listIRRemotes(irType)` で list 本体のみ委譲を確認。

### [CFG-0033] syncRemotesFromServer: hub3 未登録なら badRequest で拒否
- surface: core
- backend: cloud
- command: `ConfigStore.syncRemotesFromServer`
- branch: cfg.hub3s[hub3Name] 不在
- assert: 指定 hub3Name が config.hub3s に存在しない場合、取り込まず badRequest('domain.config.hub3NotRegisteredSyncFirst') を throw する。
- ref: packages/core/src/config.js:861; packages/core/src/config.js:862
- kind: error-path
- status: planned
- note: config.js:861 `if (!cfg.hub3s[hub3Name])` → 862 throw badRequest('domain.config.hub3NotRegisteredSyncFirst', {hub3})。エラーキーは i18n/domain.js:44,159 に実在。

### [CFG-0034] syncRemotesFromServer: 既存 remote の irType/alias/code/state 更新を反映
- surface: core
- backend: cloud
- command: `ConfigStore.syncRemotesFromServer`
- branch: 既存 remote あり
- assert: irDeviceUUID 突合で既存 remote が見つかれば irType(有限)/alias(非空)/code(非null)/state(非null) の差分のみ更新し updated に積む (冪等)。
- ref: packages/core/src/config.js:876; packages/core/src/config.js:882; packages/core/src/config.js:885; packages/core/src/config.js:886
- kind: idempotency
- status: planned
- note: config.js:876 normalizeUuid 突合 find、882-885 で irType(Number.isFinite)/alias(truthy)/code(!=null)/state(!=null) の差分のみ更新、886 changed 時のみ updated へ push。code/state 更新行 885 を refs に追加 (882 は irType のみで assert の code/state を支えないため)。

### [CFG-0035] CLI remote sync-from-server <hub3> <irType>: 必須引数と irType 数値検証
- surface: cli
- backend: cloud
- command: `sesame remote sync-from-server <hub3> <irType>`
- branch: irType 非有限/<=0 → exit 2
- assert: remote sync-from-server が hub3/irType を位置必須引数とし、irType が非有限 (!Number.isFinite) または <=0 のとき die(exit 2)、正なら hub.syncRemotesFromServer(hub3, irType) を呼ぶこと。
- ref: packages/kit/src/cli/remote.js:196; packages/kit/src/cli/remote.js:198; packages/kit/src/cli/remote.js:321
- kind: error-path
- status: planned
- note: 全ref実在確認: cmdRemoteSyncFromServer=remote.js:196、検証 die(...,2)=remote.js:198 (!Number.isFinite(irType)||irType<=0)、syncRemotesFromServer=remote.js:200、command 登録 <hub3> <irType>=remote.js:321。branch を 'irType 非有限/<=0' に文言整合。

## config.sync candidates (read-only)

### [CFG-0036] listRemotesFromDevices: 登録せず Hub3 配下リモコン候補をフラット列挙 (読み取り専用)
- surface: core
- backend: cloud
- command: `hub.listRemotesFromDevices`
- branch: hub_3/hub_3_lte のみ
- assert: listDevices() の hub_3/hub_3_lte 各 device の stateInfo.remoteList から {hub3DeviceUUID, hub3Name, uuid, type, alias} を生成し、config へ書き込まず一覧だけ返す (uuid 欠落要素はスキップ)。
- ref: packages/core/src/client.js:570; packages/core/src/client.js:576; packages/core/src/client.js:580; packages/core/src/client.js:581
- kind: contract-existence
- status: planned
- note: client.js:570 method、576 `d.deviceModel !== 'hub_3' && !== 'hub_3_lte'` 直書き判定、580 `if (!uuid) continue` (欠落スキップ)、581 out.push({hub3DeviceUUID,hub3Name,uuid,type,alias})。uuid スキップ証拠の 580 を refs に追加。model 判定がここだけ直書きで isHub3Model 未使用 — 一致は等価だが分岐重複。

### [CFG-0037] CLI remote add: listRemoteCandidates 候補から対話的に取り込む経路
- surface: cli
- backend: cloud
- command: `sesame remote add`
- branch: 0件(exit 2) | 1件自動 | 複数選択 | 親hub3未解決(exit 2) | chosen.type が learn(0xFE00) | preset(≠0xFE00)
- assert: remote add が先に hub.syncHub3sFromDevices() で hub3 名を確保し hub.listRemotesFromDevices() の候補から選択させ (0件 die(remotesNotFound,2)・chosen.hub3DeviceUUID を config 上 hub3 名へ逆引き不在で die,2)、addRemote 後に syncRemoteKeys を自動実行する。addRemote へ渡す irOperation は chosen.type に応じて deriveIrOperation(chosen.type) で導出すべき (0xFE00=learnEmit / プリセット 0xC000 等=remoteEmit) であり、send() は remote.irOperation をそのまま sendIR の operation に渡す (client.js:395) ため preset を learnEmit で発射すると誤動作する (vendor はプリセットを 'remoteEmit' で送る: remote-air:370 / remote-non-air:156)。
- ref: packages/kit/src/cli/remote.js:124; packages/kit/src/cli/remote.js:128; packages/kit/src/cli/remote.js:129; packages/kit/src/cli/remote.js:153; packages/kit/src/cli/remote.js:157; packages/core/src/client.js:395; references_web/src/pages/personal/devices/wifi-module/ir/remote-air/index.js:370; references_web/src/pages/personal/devices/wifi-module/ir/remote-non-air/index.js:156
- kind: wire-fidelity
- status: planned
- note: cmdRemoteAdd:124-162。syncHub3sFromDevices:128 / listRemotesFromDevices:129 / die(remotesNotFound,2):130 / hub3 逆引き不在 die(remoteParentHub3NotFound,2):138-142 / 末尾 syncRemoteKeys(name):157 を確認。chosen.hub3DeviceUUID は client.js:582 で供給。CFG-0027 が syncRemotesFromDevices で deriveIrOperation により修正した P3-8 バグ (config.js:837) と整合させる正典は deriveIrOperation(chosen.type)。実装疑い: remote.js:153 が irOperation:'learnEmit' を chosen.type に関わらず無条件ハードコードしており、プリセットリモコン (0xC000 エアコン等) を選んでも learnEmit 経路で発射され誤動作する。CFG-0027/CFG-0039 (deriveIrOperation 契約) と vendor remoteEmit (remote-air:370) に乖離。対話 add 経路を deriveIrOperation(chosen.type) へ是正すべき(別タスクで修正)。

## remote add / set-default / ls (core+cli)

### [CFG-0038] addRemote: name/hub3 必須 + 親 hub3 未登録で BAD_REQUEST
- surface: core
- backend: local
- command: `ConfigStore.addRemote`
- branch: name欠落 | hub3欠落 | hub3未登録 | 正常
- assert: addRemote が name/hub3 欠落で badRequest(remoteNameRequired/remoteHub3Required)、cfg.hub3s[hub3] 不在で badRequest(hub3NotRegisteredAddFirst)。irType は Number 化、irOperation 未指定は deriveIrOperation で導出、初回は default.remote 自動設定。
- ref: packages/core/src/config.js:562; packages/core/src/config.js:572; packages/core/src/config.js:581
- kind: error-path
- status: planned
- note: 確認済: config.js:564-568 で name→remoteNameRequired/hub3→remoteHub3Required/未登録→hub3NotRegisteredAddFirst、572 Number化、574 deriveIrOperation 導出、581 default.remote 自動。i18n キーは domain.js:32-34 に実在。

### [CFG-0039] irOperation 導出: 0xFE00 のみ learnEmit、他は remoteEmit
- surface: core
- backend: local
- command: `ConfigStore.addRemote` / `deriveIrOperation`
- branch: irType=0xFE00(自己学習) | プリセット(0xC000等)
- assert: deriveIrOperation(irType) が 0xfe00 のとき 'learnEmit'、それ以外は 'remoteEmit' を返す。IrRemote の type/code 概念 (code=0:学習) と整合。
- ref: packages/core/src/config.js:921-923; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/dto/IrRemote.kt:5-15
- kind: option-branch
- status: planned
- note: 確認済: config.js:921-923 が `irType === 0xfe00 ? 'learnEmit' : 'remoteEmit'`。IrRemote.kt:11(type)/12(code, 既定-1, 0:学習) が概念裏付け。

### [CFG-0040] setDefaultRemote: 未知名は BAD_REQUEST
- surface: cli, core
- backend: local
- command: `sesame remote set-default <name>` / `ConfigStore.setDefaultRemote`
- branch: 既知名 | 未知名
- assert: setDefaultRemote が cfg.remotes[name] 不在で badRequest(unknownRemoteName)。存在時のみ default.remote 更新。
- ref: packages/core/src/config.js:586-591; packages/kit/src/cli/remote.js:169-173
- kind: error-path
- status: planned
- note: 確認済: config.js:588 不在→badRequest(unknownRemoteName) (i18n domain.js:35), 589-590 存在時のみ更新+save。CLI remote.js:169-173 が configStore.setDefaultRemote 委譲。

### [CFG-0041] remote ls: 未初期化 exit 2 / keys 件数表示
- surface: cli
- backend: local
- command: `sesame remote ls`
- branch: 未初期化(exit 2) | 空 | 一覧 | --json
- assert: configStore.exists() false なら die(configNotInitialized, 2)。各 remote の hub3/irDeviceUUID/keys 件数/alias を表示。--json は {default, remotes} 封筒。
- ref: packages/kit/src/cli/remote.js:101-118
- kind: option-branch
- status: planned
- note: 確認済: remote.js:103 die(configNotInitialized,2), 109 空→noRemotes, 110-115 hub3/IR/keys件数/alias 表示, 117 --json {default, remotes} 封筒。

### [CFG-0042] resolveRemote: 親 hub3 view 不在で BAD_REQUEST
- surface: core
- backend: local
- command: `ConfigStore.resolveRemote`
- branch: hub3 view あり | hub3 view 欠落
- assert: resolveRemote が remote.hub3 に対応する cfg.hub3s[hub3Name] 不在で badRequest(remoteRefMissingHub3)。解決自体は resolveByName + REMOTE_RESOLVE_ERRORS。
- ref: packages/core/src/config.js:526-536; packages/core/src/resolve.js:58-61
- kind: error-path
- status: planned
- note: refs 検証済 (config.js:531-533 が cfg.hub3s[hub3Name] 不在で remoteRefMissingHub3 を throw、528-529 が resolveByName+REMOTE_RESOLVE_ERRORS)。

## locks add (cli+core)

### [CFG-0043] locks add 非対話: 必須フラグ欠落で usage エラー (exit 2)
- surface: cli
- backend: local
- command: `sesame locks add`
- branch: --name欠落 | --uuid欠落 | --secret欠落 (非TTY)
- assert: 非対話 (canPrompt false) で name/uuid/secret のいずれか未指定なら die(flagRequiredNonInteractive, 2)。ask() の優先順位は 明示フラグ > --from-url 由来 > prompt(TTY) > die(必須)。
- ref: packages/kit/src/cli/locks.js:110-116; packages/kit/src/cli/locks.js:117-124
- kind: error-path
- status: planned
- note: ask ヘルパ (110-116) が優先順位を実装し required=true 経路で die(...,2) (114)。name/uuid/secret の 3 必須チェックは 117-124。元 ref の :82-84 は関数入口で assert を支えないため精密化。

### [CFG-0044] locks add: deviceUUID 形式不正で usage エラー (exit 2)
- surface: cli
- backend: local
- command: `sesame locks add --uuid`
- branch: 32hex | ハイフン UUID | 不正
- assert: isDeviceUuidLike が 32hex または 8-4-4-4-12 ハイフン UUID のみ受理し、不正値は die(invalidDeviceUuid, 2)。addLock へ進まない。
- ref: packages/kit/src/cli/locks.js:25-28; packages/kit/src/cli/locks.js:119-121
- kind: error-path
- status: planned

### [CFG-0045] locks add: secretKey は 32hex 必須、不正で usage エラー (exit 2)
- surface: cli
- backend: local
- command: `sesame locks add --secret`
- branch: 32hex正 | 不正
- assert: isSecretKeyLike が ^[0-9a-f]{32}$ のみ受理し、不正は die(invalidSecretKey, 2)。
- ref: packages/kit/src/cli/locks.js:34-36; packages/kit/src/cli/locks.js:122-124
- kind: error-path
- status: planned

### [CFG-0046] locks add --model が biz3 lockModelDevices ホワイトリスト以外で拒否 (exit 2)
- surface: cli, core
- backend: local
- command: `sesame locks add --model` / `isLockModel`
- branch: 許可 model | 未指定(null許容) | 不許可
- assert: 指定 model が isLockModel を通らないと die(invalidLockModel, 2)。LOCK_MODELS が gUtils.lockModelDevices (sesame_2/4/5/5_pro/5_us/bot_2/bot_3/ssmbot_1/sesame_6/6_pro/6_pro_slidingdoor/BLE_Connector_1/bike_2/bike_3) と集合一致する。
- ref: packages/kit/src/cli/locks.js:125-126; packages/core/src/config.js:930-944; references_web/src/utils/gUtils.js:279-294; references_web/src/constants/sesameDeviceModel.js:2-38
- kind: contract-existence
- status: planned
- note: 旧 prefix マッチの誤判定 (face/touch/wm_2/bike_1/BLE_Connector) を全件照合で固定。gUtils ref を array 本体 (279-294) に修正 (旧 279-298 は isLockModel 296-298 を含み集合一致の出典から外れる)。bike_1 は sesameDeviceModel.js:6 に存在するが lockModelDevices に含まない (確認済)。

### [CFG-0047] locks add --ssm-public-key は 128hex 必須 (OS2 鍵素材)
- surface: cli, core
- backend: local
- command: `sesame locks add --ssm-public-key` / `ConfigStore.addLock`
- branch: 128hex正 | 不正 | 未指定(キー省略)
- assert: CLI と addLock の双方で ssmPublicKey が ^[0-9a-f]{128}$ のみ受理 (不正は CLI exit 2 / core badRequest)。受理時は lowercase 正規化して保存、未指定ならキー自体を作らない。
- ref: packages/kit/src/cli/locks.js:130-131; packages/core/src/config.js:635-637; packages/core/src/config.js:648
- kind: error-path
- status: planned
- note: os2-key-fields.test.js:76 が core 側 (badRequest /ssmPublicKey/) を確認。config.js:648 が ssmPublicKey 受理時の lowercase 正規化 + 未指定時のキー省略 (spread)。CLI exit 2 と二重防御は planned。

### [CFG-0048] locks add --key-index は 4hex 必須 (OS2 keyIndex)
- surface: cli, core
- backend: local
- command: `sesame locks add --key-index` / `ConfigStore.addLock`
- branch: 4hex正 | 不正 | 未指定(既定 0000 相当だがキー省略)
- assert: keyIndex が ^[0-9a-f]{4}$ のみ受理。受理時は lowercase で保存、未指定ならキーを作らない (OS3 lock の shape を汚さない)。
- ref: packages/kit/src/cli/locks.js:132-133; packages/core/src/config.js:638-640; packages/core/src/config.js:648-649
- kind: error-path
- status: planned
- note: 確認済: locks.js:132-133 が --key-index の ^[0-9a-f]{4}$ 検証 (exit 2)、config.js:638-640 が addLock 側の同検証、config.js:648-649 が keyIndex/ssmPublicKey を lowercase かつ条件付きスプレッドで保存 (未指定はキー省略)。

### [CFG-0049] locks add --from-url が共有 URL を解析して uuid/secret/model/name を補完
- surface: cli, core
- backend: local
- command: `sesame locks add --from-url` / `parseShareKeyUrl`
- branch: owner/manager(l=0/1) | 解析失敗(exit 2)
- assert: --from-url 由来値 (deviceUUID/secretKey/deviceModel/deviceName) が明示フラグの下・prompt の上の優先で穴埋めされる。parseShareKeyUrl 失敗時は die(shareUrlParseFailed, 2)。OS3 レイアウトは productType(1B)+secretKey(16B)+pubkey(4B)+keyIndex(2B)+deviceUUID(残り16B)。
- ref: packages/kit/src/cli/locks.js:90-99; packages/kit/src/cli/locks.js:110-125; packages/core/src/sharekey.js:131-143; references_web/src/utils/biz3utils.js:119-124
- kind: payload-fidelity
- status: planned
- note: 修正: sharekey ref を JSDoc 行 (109-112) からバイトレイアウト解析本体 (131-143) へ。OS3 では pubkey が 4B (data.slice(17,21))、deviceUUID は残り全部 = 16B (biz3utils.js:181-183 と 1:1)。ask の優先順位は locks.js:110-116。candidate のレイアウト記述 'pubkey' を OS3 実値 4B に明記。

### [CFG-0050] locks add --from-url ゲスト共有 (l=2) は sk 位置が guestKeyId
- surface: cli, core
- backend: local
- command: `sesame locks add --from-url` / `parseShareKeyUrl`
- branch: l=2(guest)
- assert: keyLevel=2 の共有 URL では secretKey 位置に guestKeyId が入る (biz3utils generateInviteGuestQRCodeByInfo の sk 位置)。parseShareKeyUrl はその値をそのまま secretKey として返し、CLI の 32hex 検証を通る。
- ref: packages/kit/src/cli/locks.js:88-89; references_web/src/utils/biz3utils.js:121
- kind: payload-fidelity
- status: planned
- note: 確認済: biz3utils.js:121 `secretKey = guestInfo.guestKeyId || deviceKey.secretKey`。CLI コメント locks.js:88-89。REFACTORING_PLAN §9 V15 系: guest 鍵 sentinel は実機鍵ストア往復が必要。解析境界のみ検証。

### [CFG-0051] addLock 必須検証: name/deviceUUID/secretKey 欠落で BAD_REQUEST
- surface: core, serve
- backend: local
- command: `ConfigStore.addLock`
- branch: name欠落 | deviceUUID欠落 | secretKey欠落
- assert: addLock が name/deviceUUID/secretKey のいずれか欠落で badRequest (domain.config.lockNameRequired/lockDeviceUUIDRequired/lockSecretKeyRequired) を投げる。code=bad_request は serve 経由で error.data.kind=bad_params に写像。
- ref: packages/core/src/config.js:628-632; packages/core/src/errors.js:12-14
- kind: error-path
- status: planned
- note: 修正: bad_params 写像の出典を util.js:1 (単なるコメントヘッダで非支持) から errors.js:12-14 (BAD_REQUEST→error.data.kind=bad_params を明文化) へ置換。i18n キーは実装どおり domain.config.* で修飾 (config/src/i18n/domain.js:38-40)。badRequest は config.js:628-632 で使用。

### [CFG-0052] addLock は model 未指定でも category:'lock' で view に出す
- surface: core
- backend: local
- command: `ConfigStore.addLock`
- branch: model指定 | model未指定(null)
- assert: 明示 addLock は category:'lock' を記録し、deviceModel が null/未知でも _reproject の effectiveCategory→lock で locks view に投影される (categoryForModel(null)→lock と整合)。
- ref: packages/core/src/config.js:641-651; packages/core/src/config.js:444-446; packages/core/src/config.js:965-982
- kind: option-branch
- status: planned
- note: 確認済: config.js:646 が category:'lock' を明示記録、644 が deviceModel:lock.model||null。投影本体は _reproject の config.js:444-446 (effectiveCategory→lock なら lockView)。categoryForModel(null)→'lock' は config.js:968。candidate の 'kindForModel(null)→lock5' は categoryForModel/kindForModel の言い換え。投影行 444-446 を ref に追補。

### [CFG-0053] addLock 初回登録は default.lock に自動設定
- surface: core
- backend: local
- command: `ConfigStore.addLock`
- branch: default 未設定(初回) | 既設定
- assert: default.lock が未設定のとき addLock した name を default.lock に設定する。既設定なら変えない。
- ref: packages/core/src/config.js:651
- kind: idempotency
- status: planned
- note: 修正: config.js:651 `if (!cfg.default.lock) cfg.default.lock = name;` の単一行が境界。652 は this.save() なので範囲を 651 に縮約。

### [CFG-0054] addLock の lock view 投影 shape (deviceUUID/secretKey/model/alias[+ssmPublicKey/keyIndex])
- surface: core
- backend: local
- command: `ConfigStore.addLock` / `load`
- branch: OS3(鍵素材無し) | OS2(鍵素材あり)
- assert: lockView が {deviceUUID, secretKey, model:deviceModel||null, alias:deviceName||null} を返し、ssmPublicKey/keyIndex は保存済みのときだけキーを増やす (旧 shape 読み手に undefined キーを足さない)。
- ref: packages/core/src/config.js:183-193
- kind: contract-existence
- status: planned

### [CFG-0055] locks add --push が個人鍵ストア PUT /device へ CHUserKey を同期
- surface: cli, core
- backend: cloud
- command: `sesame locks add --push` / `putKey` / `makeKeyStoreTransport`
- branch: --push成功 | --push失敗(警告継続) | --push無し
- assert: --push でローカル登録後に putKey(transport, CHUserKey) を呼ぶ。body は {deviceUUID,deviceModel,keyIndex,secretKey,sesame2PublicKey,deviceName,keyLevel} 形 (CHUserKey.kt:36-47)、PUT /device に appidentifyid ヘッダ付き (CHAPIClient.kt:29-33)。同期失敗はローカル成功に影響させず警告。
- ref: packages/kit/src/cli/locks.js:145-168; packages/core/src/devices.js:828-834; packages/core/src/devices.js:738-763; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClient.kt:29-33; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/dto/CHUserKey.kt:36-47
- kind: wire-fidelity
- status: waived: 実機 API Gateway 受理が必要 (@experimental REFACTORING_PLAN §9 V15)
- note: 確認済: locks.js:145-168 が --push 経路 (putKey 呼出+失敗時 warnLockPushFailed で継続)、devices.js:828-834 が PUT /device (body=key)、738-763 が makeKeyStoreTransport (appidentifyid 解決)。CHAPIClient.kt:29-33 が PUT /device + appidentifyid header、CHUserKey.kt:36-47 が data class CHUserKey (deviceUUID..keyLevel フィールド)。PUT /device の受理は実クラウド往復でしか確認不能。

### [CFG-0056] locks add --push の keyLevel が固定 2 (app は device 実 level)
- surface: cli
- backend: cloud
- command: `sesame locks add --push` / `putKey`
- branch: keyLevel固定
- assert: sesame-kit は CHUserKey.keyLevel を 2 固定で送るが (locks.js:158)、app は cheyKeyToUserKey(device.getKey(), device.getLevel(), …) で device の実 level を送る (CHUserKey.kt:10-21 の第3引数→keyLevel)。device.getLevel() は SharedPreferences 'l'+deviceId 既定 -1 (utils.kt:244-246)、新規登録時は setLevel(0) で owner=0 (ScanNewDeviceFG.kt:169-173)、server 受信時は userKey.keyLevel を l<id> へ保存 (CHDeviceViewModel.kt:154)。固定 2 が owner 相当か (app の owner=0 と異なる) を境界として記録。
- ref: packages/kit/src/cli/locks.js:151-160; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/devices/ScanNewDeviceFG.kt:169-173; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/dto/CHUserKey.kt:10-21; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/devices/ssm2/utils.kt:244-246; _sesame_sdk_ref/app/src/main/java/co/candyhouse/app/tabs/devices/model/CHDeviceViewModel.kt:154
- kind: payload-fidelity
- status: waived: 実機鍵ストアでの level セマンティクス検証が必要 (§9 V15)
- note: app は getLevel() 既定 -1、新規登録 owner は setLevel(0) (ScanNewDeviceFG.kt:169)。固定 2 の妥当性は実機受理依存。修正: 当初 ref の ScanQRcodeFG.kt:342-348 は QR 受領 (level は呼出側既定 -1) で register-time owner=0 を示さないため、setLevel(0)+putKey を持つ ScanNewDeviceFG.kt:169-173 へ置換。CHDeviceViewModel.kt:154 は register 路ではなく server 受信→SharedPreferences l<id> 保存路 (assert を該当に限定)。

## locks rm / set-default / ls

### [CFG-0057] locks rm 非対話は --yes 必須 (無いと exit 2)
- surface: cli
- backend: local
- command: `sesame locks rm <name>`
- branch: TTY確認 | 非対話--yes | 非対話--yes無し(exit 2)
- assert: canPrompt 時は confirm prompt (既定 No, defaultYes:false)、非対話で --yes 無しは die(nonInteractiveNeedsYes, 2)。確認後のみ removeLock を呼ぶ。
- ref: packages/kit/src/cli/locks.js:191-207; packages/kit/src/cli/locks.js:288-290
- kind: error-path
- status: planned
- note: secretKey 喪失は devices 再取得が必要なため破壊的確認。当初 ref 191-206 を 191-207 に補正 (191=fn署名, removeLock 呼出=205, out=206)。

### [CFG-0058] removeLock: 未知名は BAD_REQUEST / default は null へ
- surface: core
- backend: local
- command: `ConfigStore.removeLock`
- branch: 既知名 | 未知名(BAD_REQUEST) | default だった名前
- assert: removeLock が未知名 (cfg.locks[name] 不在) で badRequest(unknownLockName)。devices{} から削除し (真実)、削除名が default.lock なら null に戻す。view は save()→_reproject で更新。
- ref: packages/core/src/config.js:663-670
- kind: error-path
- status: planned

### [CFG-0059] setDefaultLock: 未知名は BAD_REQUEST
- surface: cli, core
- backend: local
- command: `sesame locks set-default <name>` / `ConfigStore.setDefaultLock`
- branch: 既知名 | 未知名
- assert: setDefaultLock が cfg.locks[name] 不在で badRequest(unknownLockName)。存在時のみ default.lock を更新。
- ref: packages/core/src/config.js:656-661; packages/kit/src/cli/locks.js:180-184
- kind: error-path
- status: planned

### [CFG-0060] locks ls: 未初期化は exit 2 / --json は redact
- surface: cli
- backend: local
- command: `sesame locks ls`
- branch: 未初期化(exit 2) | 空 | 一覧 | --json
- assert: configStore.exists() false なら die(configNotInitialized, 2)。--json では redactConfig({default, locks}) で secretKey をマスク (ctx.js:74-85 の deep walk)。default は '*' マーカで表示。
- ref: packages/kit/src/cli/locks.js:42-57; packages/kit/src/cli/ctx.js:74-85
- kind: option-branch
- status: planned
- note: redact 実体は packages/kit/src/cli/ctx.js:74-85 (secretKey→mask)、exit 実体は errors.js:49-53。

## locks sync-from-devices (面横断)

### [CFG-0061] syncLocksFromDevices (面横断): accept は isLockModel && deviceUUID && secretKey
- surface: cli, serve, core
- backend: cloud
- command: `sesame locks sync-from-devices` / `config.syncLocks` / `syncLocksFromDevices`
- branch: --prune | prune無し
- assert: syncLocksFromDevices が isLockModel(deviceModel) かつ deviceUUID/secretKey を持つ device のみ取り込み、{added,updated,removed} を返す。サーバ応答を真実にフィールド丸ごと置換 (category 等 LOCAL_ONLY_KEYS は引継ぎ)。--prune は effectiveCategory==lock の device だけを seen 差分で削除。
- ref: packages/core/src/config.js:744-754; packages/core/src/config.js:685-736; packages/kit/src/cli/locks.js:213-218; packages/kit/src/serve/entries/config.js:20-28
- kind: option-branch
- status: planned
- note: syncFromDevices.test.js が core を広くカバー。serve/cli 面と prune 対称性は planned。prune 判定は accept(model依存) でなく effectiveCategory (config.js:724-731)。

### [CFG-0062] CLI locks sync-from-devices: --prune オプションと printSyncResult 出力
- surface: cli
- backend: cloud
- command: `sesame locks sync-from-devices [--prune]`
- branch: --prune
- assert: locks sync-from-devices が --prune を受け hub.syncLocksFromDevices({prune}) を呼び printSyncResult(json,'lock',r) で added/updated/removed を整形出力すること。
- ref: packages/kit/src/cli/locks.js:213; packages/kit/src/cli/locks.js:293; packages/kit/src/cli/pickers.js:94
- kind: surface-parity
- status: planned
- note: 全ref実在確認: cmdLockSyncFromDevices=locks.js:213 (syncLocksFromDevices=215, printSyncResult=216)、command 登録+--prune=locks.js:293-295、printSyncResult 定義 (added/updated/removed)=pickers.js:94。

### [CFG-0063] locks sync-from-account が GET /device/list から未登録鍵のみ追加
- surface: cli, core
- backend: cloud
- command: `sesame locks sync-from-account` / `getDevicesList`
- branch: 既存スキップ | 新規追加 | 取得失敗(exit 1)
- assert: getDevicesList(transport) が GET /device/list (appidentifyid ヘッダ) を叩き CHUserKey[] を返す。deviceUUID 一致の既存 lock はスキップ、未登録のみ addLock。取得失敗は die(syncFromAccountFailed, 1)。
- ref: packages/kit/src/cli/locks.js:230-264; packages/core/src/devices.js:807-813; _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/CHAPIClient.kt:36-39
- kind: wire-fidelity
- status: waived: 実機 API Gateway 受理が必要 (@experimental §9 V15)
- note: GET /device/list の応答受理は実クラウド依存。マージ分岐(既存スキップ)はローカルで検証可能だが本項は wire 全体。確認済: cmdLockSyncFromAccount exists()->exit2(locks.js:232)・getDevicesList(238)・catch die(syncFromAccountFailed,1)(240)・既存スキップ(248-249)・addLock(251)、getDevicesList GET /device/list -> CHUserKey[](devices.js:807-813)、CHAPIClient.kt:36-39 が getDevicesList(path=/device/list,method=GET) に @Parameter(appidentifyid,header) を宣言。

## name 解決

### [CFG-0064] resolveLock 解決順序: 明示 > default > 単一fallback
- surface: core
- backend: local
- command: `ConfigStore.resolveLock` / `resolveByName`
- branch: 明示name | default | 単一fallback | 未指定+複数(noneSpecified) | 未知名(unknown)
- assert: resolveByName が name||defaultName||(1件のみならそれ) で chosen を決め、解決不能は LOCK_RESOLVE_ERRORS.noneSpecified、未知名は unknown を投げる (いずれも SesameError BAD_REQUEST)。
- ref: packages/core/src/resolve.js:31-39; packages/core/src/resolve.js:49-52; packages/core/src/config.js:613-618
- kind: option-branch
- status: planned
- note: resolve.test.js が純関数を広くカバー。各分岐の SesameError code は covered 候補。refs 検証済 (resolve.js:34 が name||defaultName||単一fallback の chosen、35/37 が noneSpecified/unknown throw、config.js:613-618 が LOCK_RESOLVE_ERRORS 経由)。

### [CFG-0065] resolve 失敗が serve で bad_params に写像 (plain Error が internal に潰れない)
- surface: serve, core
- backend: local
- command: `resolveLock` / `resolveRemote` (serve 経由)
- branch: 未知名 | 未指定
- assert: ConfigStore の resolve 失敗が SesameError(BAD_REQUEST) であり、serve framing (errorFromThrow→SESAME_TO_RPC) で error.data.kind=bad_params になる (P5-4/P5-5 で旧 plain Error の internal 潰れを解消)。
- ref: packages/core/src/resolve.js:49-61; packages/core/src/jsonrpc.js:209-213; packages/core/src/jsonrpc.js:281-286
- kind: surface-parity
- status: planned
- note: resolve.test.js:59-93 が ConfigStore 経由 resolve の code=bad_request を確認。serve framing の写像は jsonrpc.js:213 (SESAME_TO_RPC: BAD_REQUEST→{kind:BAD_PARAMS,code:INVALID_PARAMS}) と jsonrpc.js:281-286 (errorFromThrow の SesameError 分岐) が正準源。未確認だった旧 ref(resolve.js:1-9 の rationale コメントのみ)では framing 写像の半分を支えないため jsonrpc.js の実写像へ置換。serve↔kind 往復テストは planned。

## config init / show / path

### [CFG-0066] init → 空スケルトンを 0700 dir + 0600 file で生成 (新規 true)
- surface: cli, core
- backend: local
- command: `sesame init` / `ConfigStore.init`
- branch: 新規作成 | 既存あり(no-op)
- assert: init() がファイル不在時のみ emptyConfig を save() して true を返し、既存時は触らず false。dir は 0700 (ensureSecureDir/SECRET_DIR_MODE) / config.json は 0600 (SECRET_FILE_MODE 経由 writeSecretJson) で書かれる。
- ref: packages/core/src/config.js:507-516; packages/core/src/secure-fs.js:21; packages/core/src/secure-fs.js:43-64; packages/kit/src/cli/config-cmd.js:21-44
- kind: option-branch
- status: planned
- note: init:507-516 (existsSync で false:508, save():514, return true:515)。0600=SECRET_FILE_MODE:21 を writeSecretFile:47 が適用、ラッパ writeSecretJson:62-64。0700=SECRET_DIR_MODE:23 を ensureSecureDir:30-34 / config-cmd.js cmdInit:23 が適用。既存 ConfigStore.test.js:216 が 0600 を確認。新規 true / 既存 false の分岐境界は planned。旧 ref に SECRET_FILE_MODE 定義行(21)を追補。

### [CFG-0067] init --lang en が uiLang/lang を config に焼き込む
- surface: cli, core
- backend: local
- command: `sesame --lang en init` / `ConfigStore.init`
- branch: --lang指定 | フラグ無し(既定 lang=ja)
- assert: langFlag 指定時 init({uiLang,lang}) が data.uiLang と data.lang を同一ロケールに設定して永続化する。無指定なら emptyConfig 既定 (lang:'ja', uiLang 未設定) のまま。
- ref: packages/core/src/config.js:507-516; packages/kit/src/cli/config-cmd.js:21-25; packages/kit/src/cli/config-cmd.js:91-94
- kind: option-branch
- status: planned
- note: init overrides 適用: uiLang:510 / lang:513。config-cmd.js cmdInit:21-25 が langFlag?{uiLang,lang}:{} を渡し、registerInitCommand:91-94 が deps.getLangFlag() (cli.js run() の CLI_LANG_FLAG) を action 時に注入する配線も確認。

### [CFG-0068] config show が secretKey をツリー全体でマスクして出力
- surface: cli
- backend: local
- command: `sesame config` / `sesame config show`
- branch: 初期化済み | 未初期化(notInitialized) | --json
- assert: cmdConfigShow が redactConfig(cfg) を通し全 secretKey を mask() する。未初期化時は config:null / tokens 未署名時は notSignedIn。--json では {configDir, config, tokens} 封筒で同じ redaction を適用。
- ref: packages/kit/src/cli/config-cmd.js:60-83; packages/kit/src/cli/ctx.js:74-85
- kind: option-branch
- status: planned
- note: 生鍵は sesame devices 側でのみ露出 (ctx.js:69 コメント)。show は常にマスク。redactConfig 本体は ctx.js:74-85 (clone+walk で secretKey を再帰マスク)。

### [CFG-0069] config path が解決済み設定ディレクトリの絶対パスのみを出力
- surface: cli, core
- backend: local
- command: `sesame config path` / `configPaths`
- branch: --config-dir | SESAME_KIT_HOME | XDG_CONFIG_HOME | 既定 ~/.config/sesame-kit
- assert: cmdConfigPath が paths.dir を出力。resolveConfigDir の優先順位 (override > SESAME_KIT_HOME > XDG_CONFIG_HOME/sesame-kit > ~/.config/sesame-kit) が移植元規約と一致する。
- ref: packages/kit/src/cli/config-cmd.js:51-54; packages/core/src/paths.js:62-69; packages/core/src/paths.js:86-97
- kind: option-branch
- status: planned
- note: 純ローカル契約 (XDG 慣習)。env 各段の分岐は別途検証。resolveConfigDir:64-68 が 4 段の優先順位、configPaths:86-97 が paths.dir を組む。

## 永続/排他 (0600 / lost-update / lock)

### [CFG-0070] save() は config.json を 0600 / 親 0700 でアトミック書き込み
- surface: core
- backend: local
- command: `ConfigStore.save` / `writeSecretJson`
- branch: -
- assert: save() が withFileLock 内で writeSecretJson を呼び、temp→rename で 0600 ファイル・0700 親ディレクトリにする。secretKey 平文を含むため tokens.json 同等の保護。
- ref: packages/core/src/config.js:474-494; packages/core/src/secure-fs.js:30-64
- kind: contract-existence
- status: planned
- note: ConfigStore.test.js:216 が 0600 を確認済み。refs 検証済 (config.js:475 withFileLock / 493 writeSecretJson、secure-fs.js:43-55 writeSecretFile が temp→renameSync の atomic+SECRET_FILE_MODE 0600、30-34 ensureSecureDir が 0700、62-64 writeSecretJson)。

### [CFG-0071] save() round-trip と末尾改行付き pretty JSON / 親ディレクトリ再帰作成
- surface: core
- backend: local
- command: `ConfigStore.save`
- branch: -
- assert: writeSecretJson が JSON.stringify(obj,null,2)+'\n' を書き、親ディレクトリを recursive 作成。load→save→load で値が保たれる。
- ref: packages/core/src/secure-fs.js:62-64; packages/core/src/config.js:452-497
- kind: contract-existence
- status: planned
- note: refs 検証済 (secure-fs.js:63 が JSON.stringify(obj,null,2)+"\n"、ensureSecureDir→mkdirSync{recursive:true} 経由で親再帰作成、config.js:452-497 が save 全体)。ConfigStore.test.js:207-213 が末尾改行+2space indent、:200-204 が深い親ディレクトリ作成を確認。

### [CFG-0072] save() は派生 view 以外の未知キーを保持する (ダウングレード安全)
- surface: core
- backend: local
- command: `ConfigStore.save`
- branch: 既知キー | 未知キー(新版書込) | 派生view(locks/hub3s)
- assert: save() が DERIVED_KEYS (locks/hub3s) だけを除外し、それ以外は未知キーも含め全て書く (旧 PERSISTED_KEYS ホワイトリスト廃止)。新版が書いたキーを旧版 save が黙って消さない。
- ref: packages/core/src/config.js:457-467; packages/core/src/config.js:160-169
- kind: idempotency
- status: planned
- note: refs 検証済 (config.js:464-466 が DERIVED_KEYS のみ continue で除外し v!==undefined の全キーを incoming へ、160-169 が PERSISTED_KEYS 廃止方針と DERIVED_KEYS=['locks','hub3s'] の定義)。

### [CFG-0073] save() のプロセス間 lost-update 防止 (devices/remotes キー単位 union)
- surface: core
- backend: local
- command: `ConfigStore.save` / `mergeConfigData`
- branch: ディスク追加エントリ温存 | 意図的削除は復活させない | スカラは incoming 優先 | 破損 JSON は incoming で回復
- assert: save() が withFileLock 内でディスク再読込→mergeConfigData→アトミック書込。devices/remotes はキー union (他プロセス追加を温存)、baselineKeys に在り incoming に無いキーは意図的削除として除外、スカラは incoming 優先、破損 JSON は merge 放棄して上書き回復。
- ref: packages/core/src/config.js:336-370; packages/core/src/config.js:468-494; packages/core/src/config.js:431-437
- kind: idempotency
- status: planned
- note: lost-update.test.js が広くカバー (削除復活防止 109-135 等)。4 分岐全件は planned。refs 検証済 (config.js:347-370 mergeConfigData の union/baseline 除外/スカラ incoming 優先、490-493 catch→incoming で破損回復+writeSecretJson、475-494 withFileLock 内の再読込→merge、431-437 _recordBaseline)。

### [CFG-0074] withFileLock advisory lock の取得/解放/stale 奪取
- surface: core
- backend: local
- command: `withFileLock`
- branch: 取得成功 | EEXIST 待機 | stale(mtime/pid死) 奪取 | timeout(throw) | ino 不一致は解放スキップ
- assert: O_EXCL('wx') で <path>.lock を原子取得し、保持中に ino を記録、解放は ino 一致時のみ unlink (二重保持防止)。stale (mtime>10s または kill(pid,0)=ESRCH) は rename 方式で奪取、timeout で domain.securefs.lockTimeout を throw。
- ref: packages/core/src/secure-fs.js:186-276; packages/core/src/secure-fs.js:137-172
- kind: idempotency
- status: planned
- note: config/lost-update.test.js:148 が stale 回収を確認。ino 照合/timeout は planned。LOCK_STALE_MS=10_000 (secure-fs.js:103) が 10s 閾値の出典。

## schema migration / normalize / category

### [CFG-0075] v1→v2 移行: トップレベル locks/hub3s を devices{} へ取り込む
- surface: core
- backend: local
- command: `migrateConfig` / `migrateV1toV2`
- branch: schemaVersion 無し(v1) | 既 v2 | 新版(ダウングレード)
- assert: schemaVersion 無し config を v1 とみなし、legacy locks/hub3s を devices{} に変換 (category 注記、model/alias→deviceModel/deviceName 吸収) して locks/hub3s を削除。schemaVersion>=現行はそのまま (新版数を巻き戻さない)。
- ref: packages/core/src/config.js:219-284; packages/core/src/config.js:140
- kind: option-branch
- status: planned
- note: schema-migration.test.js が core をカバー。ダウングレード安全 (v>=SCHEMA_VERSION はそのまま) は migrateConfig:281-282 が出典。

### [CFG-0076] normalizeConfig: 既定穴埋め + devices→locks/hub3s 再投影 + LEGACY_WS_URL 強制
- surface: core
- backend: local
- command: `ConfigStore.load` / `normalizeConfig`
- branch: default 欠落補完 | /production→/public 強制 | view 再投影
- assert: normalizeConfig が emptyConfig 既定で穴埋めし、default.remote/lock を null 正規化、wsUrl が LEGACY (/production) なら DEFAULT (/public) へ強制、devices から effectiveCategory で locks/hub3s を再投影する。
- ref: packages/core/src/config.js:296-312; packages/core/src/config.js:126-130; references_web/src/env_config.js:2
- kind: option-branch
- status: planned
- note: ConfigStore.test.js:107 が /production→/public を確認。env_config.js:2 が公式 /public の正の証拠。

### [CFG-0077] load() は /production を物理的に消去 (禁止エンドポイント焼き付け防止)
- surface: core
- backend: local
- command: `ConfigStore.load`
- branch: /production 検出→save | 読み取り専用環境(in-memory のみ)
- assert: load() が raw.wsUrl===LEGACY_WS_URL のとき forced=true とし、normalize で /public へ置換後に save() でファイルからも消す。読み取り専用環境では save 失敗を握り潰し in-memory のみ。
- ref: packages/core/src/config.js:403-424
- kind: option-branch
- status: planned
- note: ConfigStore.test.js:107 が /production の物理消去 (onDisk not toContain /production) と save 握り潰しを確認。

### [CFG-0078] effectiveCategory: 明示 category 優先、無ければ model 導出 (null→lock)
- surface: core
- backend: local
- command: `effectiveCategory` / `categoryForModel`
- branch: 明示 category | hub3 model | lock model | model=null(lock) | 未知 model(null=非表示)
- assert: effectiveCategory が rec.category を真実とし、無ければ categoryForModel で導出。hub_3/hub_3_lte→hub3、lockModelDevices→lock、null→lock、その他(Touch/Face/Sensor)→null (どの view にも出さない)。
- ref: packages/core/src/config.js:965-982; references_web/src/utils/gUtils.js:261-298
- kind: option-branch
- status: planned
- note: face/touch を lock 誤分類しないことが境界 (gUtils isSesameAccessControlDevice:261-277 が lockModelDevices:279-294 と別カテゴリ)。

## serve config.* (RPC 面)

### [CFG-0079] serve config.syncLocks: prune オプション露出と {added,updated,removed} 返却
- surface: serve
- backend: cloud
- command: `config.syncLocks`
- branch: prune param (optional bool)
- assert: serve registry の config.syncLocks が prune(optional boolean) を受け hub.syncLocksFromDevices({prune:!!params.prune}) に委譲し {added,updated,removed} を返すこと。CLI/core と同分岐が RPC でも露出する。
- ref: packages/kit/src/serve/entries/config.js:20; packages/kit/src/serve/entries/config.js:26
- kind: surface-parity
- status: planned
- note: 確認済: config.js:20 "config.syncLocks" キー / :22 prune schema B / :26 hub.syncLocksFromDevices({ prune: !!params.prune }) / :23 result。

### [CFG-0080] serve config.syncHub3s: prune オプション露出
- surface: serve
- backend: cloud
- command: `config.syncHub3s`
- branch: prune param (optional bool)
- assert: config.syncHub3s が prune(optional bool) を受け hub.syncHub3sFromDevices({prune}) に委譲し {added,updated,removed} を返す。
- ref: packages/kit/src/serve/entries/config.js:29; packages/kit/src/serve/entries/config.js:35
- kind: surface-parity
- status: planned
- note: 確認済: config.js:29 "config.syncHub3s" キー / :35 hub.syncHub3sFromDevices({ prune: !!params.prune })。

### [CFG-0081] serve config.syncRemotes: パラメータなしで hub3+remotes の複合結果を返す
- surface: serve
- backend: cloud
- command: `config.syncRemotes`
- branch: params=[]
- assert: config.syncRemotes が params 無しで hub.syncRemotesFromDevices() に委譲し {hub3:{added,updated,removed}, remotes:{added,updated}} を返すこと。
- ref: packages/kit/src/serve/entries/config.js:38; packages/kit/src/serve/entries/config.js:44
- kind: surface-parity
- status: planned
- note: 確認済: config.js:38 "config.syncRemotes" キー / :40 params:[] / :41 result / :44 hub.syncRemotesFromDevices()。

### [CFG-0082] serve config.syncRemotesFromServer: hub3+irType を need() で必須検証
- surface: serve
- backend: cloud
- command: `config.syncRemotesFromServer`
- branch: hub3/irType 欠落 → bad_params
- assert: config.syncRemotesFromServer が hub3(string,required)/irType(number,required) を need() で必須検証し、欠落時 BAD_PARAMS(INVALID_PARAMS) を投げ、揃えば hub.syncRemotesFromServer(hub3, Number(irType)) に委譲すること。
- ref: packages/kit/src/serve/entries/config.js:59; packages/kit/src/serve/entries/config.js:68; packages/kit/src/serve/registry-helpers.js:32
- kind: error-path
- status: planned
- note: 確認済: config.js:59 キー / :62-63 hub3:S/irType:N required:true / :68 need(params,["hub3","irType"]) / :69 hub.syncRemotesFromServer(params.hub3, Number(params.irType)) / registry-helpers.js:32 need() 宣言、:35 が code:RPC.INVALID_PARAMS, kind:KIND.BAD_PARAMS を投げる (jsonrpc.js:127 INVALID_PARAMS=-32602, :171 BAD_PARAMS="bad_params")。

### [CFG-0083] serve config.listRemoteCandidates: ConfigStore 不要・読み取り専用露出
- surface: serve
- backend: cloud
- command: `config.listRemoteCandidates`
- branch: requireAuth のみ (requireConfigStore なし)
- assert: config.listRemoteCandidates が requireAuth のみで (config 非書込みのため requireConfigStore を呼ばず) hub.listRemotesFromDevices() に委譲し Array<{hub3DeviceUUID,hub3Name,uuid,type,alias}> を返すこと。
- ref: packages/kit/src/serve/entries/config.js:75; packages/kit/src/serve/entries/config.js:81
- kind: surface-parity
- status: planned
- note: 確認済: config.js:75 キー / :80 requireAuth(daemon) のみ (requireConfigStore 呼び出し無し) / :81 hub.listRemotesFromDevices() / :78 result Array<{hub3DeviceUUID,hub3Name,uuid,type,alias}>。

### [CFG-0084] serve sync 系: ConfigStore 無し構成は bad_params で明示拒否 (書込み系のみ)
- surface: serve
- backend: cloud
- command: `config.syncLocks` / `config.syncHub3s` / `config.syncRemotes` / `config.syncRemoteKeys` / `config.syncRemotesFromServer`
- branch: configStore 無し
- assert: 書込み系 config.sync* (listRemoteCandidates 除く) は requireConfigStore(hub, op) で ConfigStore 不在を BAD_PARAMS で拒否し、hub 側の plain Error が internal に潰れるのを防ぐこと。
- ref: packages/kit/src/serve/entries/config.js:25; packages/kit/src/serve/registry-helpers.js:71; packages/core/src/client.js:516
- kind: error-path
- status: planned
- note: 確認済: config.js:25 requireConfigStore(hub,"config.syncLocks") (syncHub3s:34/syncRemotes:43/syncRemoteKeys:52/syncRemotesFromServer:67 も同様、listRemoteCandidates:80 のみ非呼び出し) / registry-helpers.js:71-75 requireConfigStore が RPC.INVALID_PARAMS+KIND.BAD_PARAMS を throw / client.js:516-521 _requireConfigStore は plain Error を throw (フォールバック)。

### [CFG-0085] serve sync 系: 未認証 daemon は requireAuth で NOT_AUTHENTICATED
- surface: serve
- backend: cloud
- command: `config.syncLocks` / `config.syncHub3s` / `config.syncRemotes` / `config.syncRemoteKeys` / `config.syncRemotesFromServer` / `config.listRemoteCandidates`
- branch: 未認証
- assert: 全 config.sync*/listRemoteCandidates ハンドラが先頭で requireAuth(daemon) を呼び、daemon.authState==='expired' (保存トークン無し=未認証) のとき NOT_AUTHENTICATED を投げて core (hub.sync*) 到達前に拒否すること (認証は Android アプリ方式トークン前提)。
- ref: packages/kit/src/serve/entries/config.js:25; packages/kit/src/serve/registry-helpers.js:55
- kind: error-path
- status: planned
- note: requireAuth は authState==='expired' のみ NOT_AUTHENTICATED。保存トークンはあるがクラウド未接続 (authState==='degraded' で hub.connected=false) のときは CONNECTION_LOST を投げる (registry-helpers.js:59-61)。'未認証' は前者を指す。

### [CFG-0086] config.* メソッドが registry/openrpc/proto/SDK に 1:1 存在
- surface: serve, sdk
- backend: local
- command: `config.syncLocks` / `config.syncHub3s` / `config.syncRemotes` / `config.syncRemoteKeys` / `config.syncRemotesFromServer` / `config.listRemoteCandidates`
- branch: -
- assert: config 名前空間の 6 メソッドが grpc-methods.generated.json / openrpc / sesame.proto / 生成 ts・py クライアントに 1:1 で存在し、param 名・必須性 (syncRemotesFromServer の hub3/irType 必須等) が registry 宣言と一致する。
- ref: packages/kit/src/serve/entries/config.js:14-85; packages/kit/src/serve/grpc-methods.generated.json:1670-1705
- kind: contract-existence
- status: planned
- note: openrpc-contract.test.js / sdk-ts-contract.test.js / sdk-py-contract.test.js が契約一致を検証。6 メソッドを openrpc.json:9790-9904・sesame.proto:329-339・ts:386-396・py:750-772 で各 1:1 実在確認。hub3/irType required=true を openrpc.json:9877-9886 で確認。

## SDK gen マニフェスト

### [CFG-0087] SDK gen: config.sync* / listRemoteCandidates が grpc-methods マニフェストに存在
- surface: sdk
- backend: cloud
- command: `ConfigSyncLocks` / `ConfigSyncHub3s` / `ConfigSyncRemotes` / `ConfigSyncRemoteKeys` / `ConfigSyncRemotesFromServer` / `ConfigListRemoteCandidates`
- branch: -
- assert: 生成 SDK マニフェスト (grpc-methods.generated.json) に config.syncLocks/syncHub3s/syncRemotes/syncRemoteKeys/syncRemotesFromServer/listRemoteCandidates が method 名つきで登録され、生成 client の generic call() で到達可能なこと。
- ref: packages/kit/src/serve/grpc-methods.generated.json:1671; packages/kit/src/serve/grpc-methods.generated.json:1702; packages/kit/clients/python/sesame_client.py:140; packages/kit/clients/js/sesame-client.d.ts:93
- kind: contract-existence
- status: planned
- note: command に ConfigSyncRemoteKeys を補完 (assert の6メソッドと整合、method 行は grpc-methods.generated.json:1690)。python call() は sesame_client.py:140、js call() は sesame-client.d.ts:93 の generic ディスパッチで全 method に到達可。

### [CFG-0088] SDK gen: syncLocks/syncHub3s の prune が optionalScalars、syncRemotesFromServer の必須は欠落
- surface: sdk
- backend: cloud
- command: `ConfigSyncLocks` / `ConfigSyncHub3s` / `ConfigSyncRemotesFromServer`
- branch: optionalScalars: prune | syncRemotesFromServer optionalScalars=[]
- assert: grpc gen で ConfigSyncLocks/ConfigSyncHub3s が optionalScalars:['prune'] を持つ一方、ConfigSyncRemotesFromServer は optionalScalars:[] かつ必須 (hub3/irType) を表現しておらず serve の need() 必須検証と乖離する (surface-parity ギャップ)。
- ref: packages/kit/src/serve/grpc-methods.generated.json:1674; packages/kit/src/serve/grpc-methods.generated.json:1699; packages/kit/src/serve/entries/config.js:68
- kind: surface-parity
- status: planned
- note: 行番号修正: SyncLocks の optionalScalars 'prune' は :1674、SyncRemotesFromServer の optionalScalars:[] は :1699。実必須は serve need() (config.js:68) のみが強制 → gen マニフェストは required を表現せず SDK 利用者は実行時 bad_params で初めて知る。

## surface parity / i18n

### [CFG-0089] sync 同操作が cli/serve/core で同結果封筒 {added,updated,removed}
- surface: cli, serve, core
- backend: cloud
- command: `locks sync-from-devices` / `config.syncLocks` / `syncLocksFromDevices`
- branch: cli --json | serve RPC | core 直呼び
- assert: 同一 sync 操作が core (configStore メソッド) / serve (config.* handler) / cli (printSyncResult/--json) で同じ {added,updated,removed} 形を返す。hub→configStore→core の委譲が取捨選択せず丸ごと届く。
- ref: packages/core/src/client.js:528-544; packages/kit/src/serve/entries/config.js:20-46; packages/kit/src/cli/locks.js:213-218; packages/kit/src/cli/pickers.js:94-103
- kind: surface-parity
- status: planned
- note: 確認済: client.js:528-533 syncLocksFromDevices→configStore.syncLocksFromDevices で {added,updated,removed} 返却。serve config.js:24-27 が hub へ委譲、result 宣言 '{ added, updated, removed }'。cli locks.js:215-216→pickers.js printSyncResult(94) が同 shape を JSON {ok,kind,...r} で出力。pickers.js 出典を追加。

### [CFG-0090] CLI sync 系 --json: printSyncResult が {ok,kind,added,updated,removed} を出力
- surface: cli
- backend: cloud
- command: `sesame locks/hub3/remote sync-from-* --json`
- branch: --json
- assert: --json 時 printSyncResult が {ok:true, kind, ...r} (r={added,updated,removed}) を JSON 出力し、非 json 時は +N/~N/-N の人間可読サマリ (cli.okSync) を出すこと。
- ref: packages/kit/src/cli/pickers.js:94; packages/kit/src/cli/pickers.js:102
- kind: option-branch
- status: planned
- note: printSyncResult:94-103。+N/~N/-N 整形:98-100、JSON ペイロード {ok:true,kind,...r}:102。callers=locks:216(lock)/remote:221(remote)/remote:278(hub3)。remote sync-from-devices の r は {added,updated} のみで removed 欠落しうるが lock/hub3 は removed 含む(契約形は維持)。

### [CFG-0091] i18n: sync 系 serve サマリ/説明と CLI okSync メッセージのキー存在
- surface: serve, cli
- backend: cloud
- command: `config.syncLocks` / `config.listRemoteCandidates` / `cli.okSync`
- branch: -
- assert: serve.sum.configSyncLocks/configSyncHub3s/configSyncRemotes/configSyncRemotesFromServer/configListRemoteCandidates と cli.okSync/syncNoChange の i18n キーが en/ja 双方に定義され、printSyncResult が cli.okSync/syncNoChange を参照すること。
- ref: packages/kit/src/i18n/serve.js:136; packages/kit/src/i18n/serve.js:145; packages/kit/src/cli/pickers.js:101
- kind: i18n
- status: planned
- note: 修正: 旧 ref serve.js:144/400 は鍵定義でなくコメント行だった。実 key 行=configSyncLocks:136(en)/392(ja), configSyncHub3s:137/393, configSyncRemotes:138/394, configSyncRemotesFromServer:141/397, configListRemoteCandidates:145/401。pickers.js:101 が cli.okSync 参照、fallback で cli.syncNoChange 参照。cli.okSync:139/560, cli.syncNoChange:138/559 を確認。

### [CFG-0092] config ドメインの error i18n キーが en/ja 両カタログに完全存在
- surface: core, cli
- backend: local
- command: `domain.config.*` / `cli.*` (config/locks/remote)
- branch: en | ja
- assert: badRequest('domain.config.*') (lockNameRequired/lockDeviceUUIDRequired/lockSecretKeyRequired 等) と CLI の t('cli.*') (configNotInitialized, invalidLockModel 等) が en/ja カタログに欠落なく対応する (i18n 完全性)。
- ref: packages/core/src/config.js:630-632; packages/core/src/i18n/domain.js:25; packages/kit/src/i18n/cli.js:99
- kind: i18n
- status: planned
- note: 修正: 元 ref のパスが誤り。domain.js/jsonrpc.js は packages/core/src/i18n/ 配下で kit には存在しない。config.js:378 は new Error(t('domain.config.configPathRequired')) であり badRequest ではないため、assert が挙げる badRequest('domain.config.*') の実出典 config.js:630-632 (lockNameRequired/lockDeviceUUIDRequired/lockSecretKeyRequired) に置換。en/ja 完全性: domain.config.* は core/tests/i18n.test.js の 'i18n core catalog completeness (P5-2)' (1) en/ja キー集合一致 が検証。cli.* (configNotInitialized=cli.js:99/520, invalidLockModel=cli.js:129/550) は kit i18n-catalog.test.js が網羅検証。

## client sync* エラー経路

### [CFG-0093] client sync*: ConfigStore 無しで直利用すると requiresConfigStore で throw
- surface: core
- backend: cloud
- command: `hub.syncLocksFromDevices` / `syncHub3sFromDevices` / `syncRemotesFromDevices` / `syncRemotesFromServer`
- branch: _configStore 未設定
- assert: 接続済みかつ ConfigStore 無しで構築された SesameHub3 で sync*FromDevices を呼ぶと _requireConfigStore が new Error(t('domain.client.requiresConfigStore',{op})) で throw すること (registry 外フォールバック)。
- ref: packages/core/src/client.js:516; packages/core/src/client.js:519; packages/core/src/client.js:530
- kind: error-path
- status: planned
- note: _requireConfigStore 定義:516-521、throw:519。i18n キー domain.client.requiresConfigStore は domain.js:15(en)/130(ja) に存在。各 sync は _ensureConnected() を先に呼ぶ(530/542/558/602)ため、未接続時は先に NOT_CONNECTED が出る点に注意([[CFG-0094]] 参照)。SesameError ではなく素の Error である点も確認。

### [CFG-0094] client sync*: 未接続 (_ws なし) は NOT_CONNECTED(retryable) で拒否
- surface: core
- backend: cloud
- command: `hub.syncLocksFromDevices` / `syncHub3sFromDevices` / `syncRemotesFromDevices` / `syncRemotesFromServer`
- branch: 未接続
- assert: WS 未接続状態で sync*FromDevices を呼ぶと _ensureConnected が SesameError(NOT_CONNECTED, retryable:true) を投げ、_requireConfigStore/listDevices 送信前に失敗すること。
- ref: packages/core/src/client.js:310; packages/core/src/client.js:529
- kind: error-path
- status: planned
- note: _ensureConnected 本体:306-312、実 throw:310 (code:ERR.NOT_CONNECTED, retryable:true)。syncLocksFromDevices は _ensureConnected():529 を listDevices():531 より先に呼ぶ。i18n domain.client.notConnected は domain.js:10/125 に存在。

## 監査追補 v2 (dual-audit)

### [CFG-0095] updateRemoteKeys: 未知 remote 名は BAD_REQUEST / 既知は keys 総入替+save
- surface: core
- backend: local
- command: `ConfigStore.updateRemoteKeys`
- branch: 既知 remote (keys 置換+save) | 未知 remote (BAD_REQUEST)
- assert: updateRemoteKeys(name, keys) が cfg.remotes[name] 不在で badRequest('domain.config.unknownRemoteName') を throw し、存在時のみ r.keys=keys で総置換して save() する。client.send/learn が learn 後にキーを書き戻す唯一の config 永続点だが、ConfigStore メソッド自体の検証契約は config ドメインが所有すべき。setDefaultRemote (CFG-0040)/setDefaultLock (CFG-0059) は config spec に存在するため抜けは非対称。
- ref: packages/core/src/config.js:597; packages/core/src/config.js:600; packages/core/src/config.js:601; packages/core/src/i18n/domain.js:35
- kind: error-path
- status: planned
- note: config.js:597-603 が public メソッド updateRemoteKeys を定義: 600 `if (!r) throw badRequest('domain.config.unknownRemoteName', {name})`、601 `r.keys=keys` 総入替、602 `this.save()`。i18n キー domain.config.unknownRemoteName は domain.js:35(en) に実在 ([[CFG-0040]] と共有キー)。ir.md:310/794 は client 側 write-back caller (client.js:760-764, 884-889) を索引するのみで ConfigStore メソッドの未知名検証分岐は固定していない。addLock/addRemote/removeLock/setDefault* (CFG-0038/0040/0051/0058/0059) が索引される中、同列の mutator updateRemoteKeys のみ未索引だった非対称を補う。

### [CFG-0096] syncRemotesFromServer: 既存 remote 更新が irOperation を再導出しない (devices 経路 CFG-0026 と非対称・stale)
- surface: core
- backend: cloud
- command: `ConfigStore.syncRemotesFromServer`
- branch: 既存 remote の irType が learn(0xFE00)↔preset 間で変化時 irOperation 追従なし
- assert: syncRemotesFromServer の既存 remote 更新分岐 (config.js:879-888) は irType/alias/code/state のみ追従するが、本来は irType 変化時に deriveIrOperation で irOperation も再導出すべき。syncRemotesFromDevices の更新分岐 (config.js:823-824) は deriveIrOperation で irOperation を追従させ added 経路 (config.js:897) も導出するため、server 既存更新だけが非対称。irType が 0xFE00↔プリセット間で変わっても irOperation が古い値のまま残ると hub.send()/sendIR の operation が irType と不整合になり learnEmit/remoteEmit を誤選択しうる。
- ref: packages/core/src/config.js:879; packages/core/src/config.js:882; packages/core/src/config.js:885; packages/core/src/config.js:823; packages/core/src/config.js:824; packages/core/src/config.js:897
- kind: wire-fidelity
- status: planned
- note: config.js:882-885 が irType(882)/alias(883)/code(884)/state(885) のみ changed 判定し irOperation を一切触らない。対して syncRemotesFromDevices は 823-824 で `const op=deriveIrOperation(...); if (rm.irOperation!==op){...}` で追従、added 経路は 897 で導出。[[CFG-0034]] (server 既存更新) / [[CFG-0026]] (devices 既存更新) との面内非対称。実装疑い: server 経路の既存 remote 更新が irOperation を再導出しないため irType 変化後に operation が stale 化し send 誤動作しうる。devices 経路 (823-824) と挙動を揃えるべき(別タスクで修正)。

### [CFG-0097] remote/hub3 の直接削除経路が core/cli ともに不在 (lock のみ削除 surface が非対称)
- surface: core, cli
- backend: local
- command: `ConfigStore.removeRemote / ConfigStore.removeHub3 / sesame remote rm / sesame hub3 rm`
- branch: lock は removeLock+locks rm あり | remote/hub3 は prune 経由のみ
- assert: config の削除 surface が非対称である: ConfigStore.removeLock + CLI `locks rm` (CFG-0057/0058) は存在するが、remote と hub3 には直接削除 (removeRemote/removeHub3 メソッドも remote rm/hub3 rm CLI も) が一切無く、sync --prune の副作用でしか除去できない。手動 addRemote/addHub3 (CFG-0021/0038) で登録したエントリを sync を介さず削除する正規経路が無いことを negative fact として固定する。
- ref: packages/core/src/config.js:663; packages/kit/src/cli/remote.js:305; packages/kit/src/cli/remote.js:325
- kind: contract-existence
- status: planned
- note: config.js 全体に removeRemote/removeHub3 は存在しない (removeLock のみ config.js:663-)。registerRemoteCommands (remote.js:305) は remote 配下 ls/add/set-default/sync-keys/sync-from-devices/sync-from-server のみ、hub3 配下 (remote.js:325) は ls/add/sync-from-devices のみで rm 登録が無い。一方 lock は removeLock(config.js:663) + locks rm を持ち CFG-0057/0058 で索引済み。prune (CFG-0007/0018) は server 不在時のみ除去で手動登録エントリの意図的削除には使えない。removeRemote/removeHub3 を実装するか削除非対称を意図的逸脱として固定するかは別タスクの判断。

### [CFG-0098] syncRemotes*: IrRemote.model (品牌/brand) を取り込まず捨てる (payload 取りこぼし negative-fact)
- surface: core
- backend: cloud
- command: `ConfigStore.syncRemotesFromDevices / syncRemotesFromServer`
- branch: remoteList 要素の model 取り込み有無
- assert: stateInfo.remoteList / getRemoteList の各要素は IrRemote.kt の model(品牌名称=メーカー/ブランド名) を持つが、RemoteEntry typedef と syncRemotesFromDevices/syncRemotesFromServer は uuid/type/code/state/alias のみ抽出し model を保存しない。model(brand) を黙って捨てる点を負の fact として固定する (send 操作は irType+code で成立し brand 不要のため意図的逸脱)。
- ref: _sesame_sdk_ref/sesame-sdk/src/main/java/co/candyhouse/sesame/server/dto/IrRemote.kt:6; packages/core/src/config.js:800; packages/core/src/config.js:831
- kind: payload-fidelity
- status: planned
- note: IrRemote.kt:6 が `var model: String?, // 品牌名称`。RemoteEntry typedef (config.js:69-78) に model フィールド無し。syncRemotesFromDevices 抽出 (config.js:800-) は irDeviceUUID/irType/alias/code/state のみで model を読まず保存 (config.js:831-) でも入れない。syncRemotesFromServer も同様。[[CFG-0023]]/[[CFG-0032]] (stateInfo 分解境界) が uuid/type/alias/code/state とだけ列挙し model 取りこぼしを索引していなかった非対称を補う。model は表示・将来の remoteEmit code 解決に使いうるが send 操作には必須でないため severity=low の意図的逸脱として明示。

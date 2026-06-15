<!-- spec-domain: events | prefix: EVT | tests: packages/kit/tests/serve -->

# イベント購読 spec (EVT)

events.subscribe/unsubscribe (serve デーモンのストリーミング) と再接続時の再購読・接続別リース・WS フレームを監査する。

## events.subscribe

events.subscribe の topics enum 契約・正規化・ephemeral 拒否・未知 topic 拒否を固定する。

### [EVT-0001] events.subscribe topics param が SUBSCRIBABLE_TOPICS enum を要求する
- surface: serve, sdk
- backend: cloud
- command: events.subscribe
- branch: -
- assert: events.subscribe の topics param schema が array<items.enum = [lockState,deviceUpdate,deviceListChanged]> で、registry の SUBSCRIBABLE_TOPICS から導出される
- ref: packages/kit/src/serve/entries/events.js:16-23; packages/kit/src/serve/registry.js:265-267; packages/kit/src/serve/registry.js:346; packages/kit/src/serve/registry.js:409; packages/kit/sdk/ts/sesame-client.ts:86-87; packages/kit/tests/serve/phase4-surfaces.test.js:445-456
- kind: contract-existence
- status: planned
- note: x-event-topics (registry.js:409) の単一真実源。SDK 型 union (sesame-client.ts:87 = lockState|deviceUpdate|deviceListChanged) / Literal[] もここから導出。test phase4-surfaces.test.js:455 が enum === SUBSCRIBABLE_TOPICS を全件照合

### [EVT-0002] events.subscribe が daemon.subscribe へ正規化済み topics を渡し subscribed を返す
- surface: serve
- backend: cloud
- command: events.subscribe / daemon.subscribe
- branch: -
- assert: handler が asTopicList で topics を文字列配列化し daemon.subscribe(conn, topics) を呼ぶ。結果封筒が {subscribed: string[]} (接続の購読 Set 全体)
- ref: packages/kit/src/serve/entries/events.js:25-34; packages/kit/src/serve/registry-helpers.js:46-49; packages/kit/src/serve/daemon.js:275-281
- kind: contract-existence
- status: planned
- note: daemon.js:278-280 が set.add 後に [...set] 全体を返すことを確認 (追加分のみではなく接続の購読集合全体)

### [EVT-0003] events.subscribe を ephemeral 接続で呼ぶと INVALID_REQUEST/bad_params
- surface: serve, sdk
- backend: cloud
- command: events.subscribe
- branch: ephemeral-conn (HTTP POST /rpc・gRPC unary)
- assert: conn.ephemeral=true の接続では eventsNeedPersistent エラー (code=INVALID_REQUEST, kind=BAD_PARAMS) を投げ、購読を張らない
- ref: packages/kit/src/serve/entries/events.js:26-29; packages/kit/src/serve/framing/http.js:130-133; packages/kit/src/serve/framing/grpc.js:141-142
- kind: error-path
- status: planned
- note: http.js:132 / grpc.js:142 で conn に ephemeral:true を付与 (POST /rpc・gRPC unary は短命接続)。events.js:26-28 が即 RpcError(INVALID_REQUEST, BAD_PARAMS) を throw し handler を打ち切る

### [EVT-0004] events.subscribe の未知 topic は INVALID_PARAMS で拒否
- surface: serve, sdk
- backend: cloud
- command: events.subscribe
- branch: unknown-topic
- assert: TOPICS に無い topic を含むと unknownTopics エラー (code=INVALID_PARAMS, kind=BAD_PARAMS) を投げ、悪い topic 名を列挙する。黙殺しない
- ref: packages/kit/src/serve/entries/events.js:30-32; packages/kit/tests/serve/clients-js.test.js:99-105
- kind: error-path
- status: planned
- note: events.js:31-32 が bad = topics.filter(!TOPICS.includes) を bad.join(',') で列挙し throw。test clients-js.test.js:99-105 (WS/HTTP) が bogus_topic で kind=bad_params reject を確認

## events.unsubscribe

events.unsubscribe の対称 enum schema と、未登録接続に対する冪等寛容を固定する。

### [EVT-0005] events.unsubscribe が daemon.unsubscribe を呼び残存 subscribed を返す
- surface: serve
- backend: cloud
- command: events.unsubscribe / daemon.unsubscribe
- branch: -
- assert: handler が asTopicList 正規化後 daemon.unsubscribe(conn, topics) を呼び、{subscribed: 残りの topic[]} を返す。subscribe と対称な enum schema を持つ
- ref: packages/kit/src/serve/entries/events.js:36-44; packages/kit/src/serve/daemon.js:288-294; packages/kit/tests/serve/phase4-surfaces.test.js:458-459
- kind: contract-existence
- status: planned
- note: events.js:39 が subscribe と同一 enum schema を付与。daemon.js:291-293 が set.delete 後 [...set] (残存) を返す。test phase4-surfaces.test.js:458 が unsubscribe の enum schema を検証

### [EVT-0006] events.unsubscribe は未登録接続でも空 subscribed を返す (寛容)
- surface: serve
- backend: cloud
- command: events.unsubscribe / daemon.unsubscribe
- branch: conn-not-registered
- assert: _subs に無い conn では throw せず {subscribed: []} を返す (subscribe は INTERNAL を投げるのと非対称: unsub は冪等寛容)
- ref: packages/kit/src/serve/daemon.js:288-294; packages/kit/src/serve/daemon.js:275-281
- kind: idempotency
- status: planned
- note: unsubscribe (daemon.js:289-290) は set 不在で {subscribed:[]}。対比として subscribe (daemon.js:277) は同条件で RpcError(KIND.INTERNAL, connNotRegistered) を throw — 非対称を確認

## 購読リース (daemon)

接続単位の購読リース所有・hub 接続待ち遅延張り・最後の購読者離脱時 teardown を固定する。

### [EVT-0007] 購読リースは接続単位 Map<Connection,Set<topic>> で daemon が一元所有
- surface: serve
- backend: cloud
- command: daemon.subscribe / daemon.unsubscribe
- branch: -
- assert: 購読は接続ごとの Set<topic> として保持され、subscribe で add / unsubscribe で delete し、removeConnection で破棄される (hub への購読は 1 本だけ張り fan-out する)
- ref: packages/kit/src/serve/daemon.js:94-95; packages/kit/src/serve/daemon.js:177-190; packages/kit/src/serve/daemon.js:275-294; packages/kit/src/serve/daemon.js:361-368
- kind: contract-existence
- status: planned
- note: _subs=Map<Connection,Set<string>> (daemon.js:95)、addConnection で new Set (178)・removeConnection で delete (188)。_fanout (361-367) は STATE_TOPICS を 1 本の hub 購読から各 conn へ fan-out。元 ref 93-99 は 94-95 (Map 宣言) へ精緻化。一元所有/teardown 機構は [[SRV-0047]] と実装行で重なるが、購読リースのライフサイクル所有は EVT が owner のため保持

### [EVT-0008] subscribe は hub 未接続なら subscribe frame を遅延し接続時に張る
- surface: serve
- backend: cloud
- command: daemon.subscribe / _ensureStateSub
- branch: hub-disconnected | hub-connected
- assert: hub.connected=false の間は _ensureStateSub が早期 return し onDeviceUpdate を呼ばず、接続復帰 (_connectLoop が _ensureStateSub を呼ぶ / onReconnect→_reestablishStateSub) 後に張る。購読自体 (_subs の topic) は記録される
- ref: packages/kit/src/serve/daemon.js:301-325; packages/kit/src/serve/daemon.js:122-154; packages/kit/src/serve/daemon.js:114-120
- kind: option-branch
- status: planned
- note: daemon.js:303 が if(!this.hub.connected) return。onReconnect の wiring は start() の 116-118 (_reestablishStateSub)、再接続後の張り直しは 327-336。元 ref の 301-325/122-154 は実在・支持。onReconnect 経路を明示するため 114-120 を追加。hub 未接続遅延張り branch は events 固有の vendor 照合価値があり [[SRV-0047]] の一元所有機構とは別観点として保持

### [EVT-0009] 最後の購読者が外れたら hub 状態購読を teardown
- surface: serve
- backend: cloud
- command: daemon.unsubscribe / removeConnection
- branch: last-subscriber-gone
- assert: _anySubscribers()=false になると _maybeTeardownStateSub が _stateUnsub / _deviceListUnsub を呼び hub への購読を解除する (リスナ leak 防止)。unsubscribe(292) と removeConnection(189) の両経路から呼ばれる
- ref: packages/kit/src/serve/daemon.js:296-299; packages/kit/src/serve/daemon.js:338-350; packages/kit/src/serve/daemon.js:187-190
- kind: idempotency
- status: planned
- note: daemon.js:296-299=_anySubscribers、338-350=_maybeTeardownStateSub。teardown を呼ぶ removeConnection(187-190) を支持として追加。assert の関数名を _maybeTeardownStateSub に明確化。teardown 機構は [[SRV-0047]] と実装行で重なるが、最後の購読者離脱時 teardown は購読ライフサイクルの EVT owner のため保持

## hub 状態購読フレーム

vendor と同形の subscribeDevicesUpdate frame と config.devices からの items 構築を固定する。

### [EVT-0010] hub 状態購読の subscribeDevicesUpdate frame が vendor と同形
- surface: serve, core
- backend: cloud
- command: daemon._ensureStateSub / onDeviceUpdate / subscribeDevicesUpdate
- branch: -
- assert: 送信 frame が {action:'biz3ManageDevice', op:'subscribeDevicesUpdate', items:[{deviceUUID,deviceModel}], companyID} で vendor useManageDevice.js subscribeDevicesUpdate/subscribeDevices と一致 (ACT_MANAGE='biz3ManageDevice')
- ref: packages/core/src/devices.js:295-307; packages/core/src/client.js:1550-1560; references_web/src/api/useManageDevice.js:322-350
- kind: wire-fidelity
- status: planned
- note: devices.js:300 が {action:ACT_MANAGE,op:'subscribeDevicesUpdate',items,companyID}、ACT_MANAGE='biz3ManageDevice'(devices.js:43)。vendor frame は useManageDevice.js:325-331、items={deviceUUID,deviceModel} の写像は 341-344。元 ref 322-346 を 322-350 へ拡張し subscribeDevices の map まで含めた

### [EVT-0011] config.devices から subscribe frame の items を構築する
- surface: serve
- backend: cloud
- command: daemon._ensureStateSub
- branch: -
- assert: _ensureStateSub が hub.config.devices を Object.values で {deviceUUID,deviceModel} の items に写像し onDeviceUpdate へ渡す (vendor は getCompanyDevices 結果を subscribeDevices で map)
- ref: packages/kit/src/serve/daemon.js:302-314; references_web/src/api/useManageDevice.js:336-350
- kind: wire-fidelity
- status: planned
- note: daemon.js:307-309 が config.devices→Object.values→{deviceUUID,deviceModel}→onDeviceUpdate。vendor subscribeDevices の map は 341-344 を含む 336-350

### [EVT-0012] state push の購読 key が biz3TriggerLocker:pubDeviceStateChange
- surface: core
- backend: cloud
- command: subscribeDevicesUpdate / transport.subscribe
- branch: -
- assert: 購読要求 op は biz3ManageDevice/subscribeDevicesUpdate だが push 受信 key は別 action 'biz3TriggerLocker:pubDeviceStateChange' (小文字 p)。push 本体は data = {deviceUUID, stateInfo} で、deviceUUID は fan-out 判定用識別子、stateInfo (wm2State 等) が配送される実 state コンテンツである。fan-out/onLockStateChangeDevice は msg をそのまま fn へ渡すため stateInfo フィールドの存在が購読契約の wire fact (client.js:1472-1474 は判定に data.deviceUUID のみ読むが stateInfo は msg ごと素通しされる)
- ref: packages/core/src/devices.js:277-307; packages/core/src/devices.js:284; packages/core/src/client.js:98; packages/core/src/client.js:1468-1475; references_web/src/api/useManageDevice.js:144-156; references_web/src/api/useIotCtrl.js:11,20-22
- kind: wire-fidelity
- status: planned
- note: client.js:98 STATE_CHANGE_KEY=biz3TriggerLocker:pubDeviceStateChange、devices.js:303 が同 key を subscribe。push body shape={deviceUUID,stateInfo} は impl 自身 devices.js:284 のコメントと vendor updateDeviceState (useManageDevice.js:144-156 が updatedDevice.stateInfo を既存へマージ) が出典。client.js:1472-1474 は判定に data.deviceUUID しか読まないが stateInfo は素通しされる。useIotCtrl 行範囲を 19-22→20-22 (case/op/data) に補正。旧 biz3ManageDevice:PubedDeviceStateChange 回帰は devices.js:285 に記録。cloud stateInfo|ble mechStatus の正規化は [[LOCK-0021]] が所有

## fan-out

単一 push 源を topic ラベル別に二重配信せず購読接続のみへ配送する fan-out を固定する。

### [EVT-0013] lockState と deviceUpdate は同一ストリームを別ラベルで配送 (二重配信しない)
- surface: serve
- backend: cloud
- command: daemon._fanout
- branch: both-topics-subscribed
- assert: 両方を購読する接続には STATE_TOPICS.find で最初に一致する 1 topic ラベルで 1 回だけ event を送る (pubDeviceStateChange は単一源)
- ref: packages/kit/src/serve/daemon.js:352-368; packages/kit/src/serve/registry.js:264-265
- kind: idempotency
- status: planned
- note: daemon.js:363 STATE_TOPICS.find→365 で makeEvent を 1 回。registry.js:265 STATE_TOPICS=['lockState','deviceUpdate'] (264 は JSDoc)。両 ref 実在・支持。_fanout 機構は [[SRV-0045]] と同一実装行で重なるが、二重配信回避の購読配送ライフサイクルは EVT owner のため保持

### [EVT-0014] _fanout は購読 topic を持つ接続だけに makeEvent 封筒を送る
- surface: serve
- backend: cloud
- command: daemon._fanout
- branch: subscriber | non-subscriber
- assert: lockState/deviceUpdate を購読していない接続には push されず (topic=undefined で skip)、購読接続には {jsonrpc:'2.0',method:'event.<topic>',params:msg} が届く
- ref: packages/kit/src/serve/daemon.js:360-368; packages/core/src/jsonrpc.js:377-379
- kind: surface-parity
- status: planned
- note: daemon.js:364 if(topic) ガードで非購読接続は skip、365 makeEvent。jsonrpc.js:377-379 makeEvent が {jsonrpc:'2.0',method:`event.${topic}`,params:payload} を返し封筒一致。元 ref 377-378 を関数末尾 379 まで含めた。全 framing fan-out 機構は [[SRV-0064]] と重なるが、購読者限定配送のライフサイクルは EVT owner のため保持

## deviceListChanged

pubUserDeviceChange 源の別ストリームとして fan-out され、購読可能だが STATE_TOPICS 非配送である境界を固定する。

### [EVT-0015] deviceListChanged は pubUserDeviceChange 源の別ストリームとして fan-out
- surface: serve, core
- backend: cloud
- command: daemon._fanoutTopic / onUserDeviceChange / subscribeUserDeviceChange
- branch: -
- assert: deviceListChanged topic は biz3TriggerLocker:pubUserDeviceChange を源とし _fanoutTopic で配送される (lockState/deviceUpdate とは別ストリーム)。専用 subscribe op は無くローカル購読のみ
- ref: packages/kit/src/serve/daemon.js:315-324; packages/kit/src/serve/daemon.js:370-380; packages/core/src/devices.js:309-329; references_web/src/api/useIotCtrl.js:12,23-25
- kind: wire-fidelity
- status: planned
- note: 確認済: daemon.onUserDeviceChange 配線(315-324)→ _fanoutTopic('deviceListChanged') (375-380)。源は devices.subscribeUserDeviceChange の subscribe key 'biz3TriggerLocker:pubUserDeviceChange' (devices.js:326)。web vendor は同 op を getCompanyDevices() で処理 (useIotCtrl.js:12,23-25)

### [EVT-0016] deviceListChanged 購読は SUBSCRIBABLE_TOPICS に含まれるが STATE_TOPICS には含まれない
- surface: serve, sdk
- backend: cloud
- command: events.subscribe
- branch: -
- assert: deviceListChanged は events.subscribe で受理される (SUBSCRIBABLE_TOPICS) が _fanout (STATE_TOPICS) では配送されず _fanoutTopic 経由でのみ届く
- ref: packages/kit/src/serve/registry.js:264-267; packages/kit/src/serve/entries/events.js:22,30-33; packages/kit/src/serve/daemon.js:361-380
- kind: option-branch
- status: planned
- note: 確認済: STATE_TOPICS=[lockState,deviceUpdate] (registry.js:265)、SUBSCRIBABLE_TOPICS=+deviceListChanged (267)。events.subscribe は TOPICS=SUBSCRIBABLE_TOPICS の enum で検証 (events.js:22,31-32)。daemon._fanout は STATE_TOPICS のみ照合 (363) ＝ deviceListChanged 非配送。entries/events.js を追加 (受理の実証はそこ)。topic 単一定義機構は [[SRV-0046]] と registry.js:264-267 を同一源参照で重なるが、topic 単一源は購読ライフサイクルの EVT owner のため保持。deviceListChanged が SUBSCRIBABLE だが STATE 非配送 (_fanoutTopic 専用) という境界は events 固有価値

## event.ready

永続接続確立時の event.ready 単発発火と、購読不可 broadcast・stable/local provenance を固定する。

### [EVT-0017] event.ready は全永続接続の確立時に 1 本だけ発火、ephemeral には送らない
- surface: serve
- backend: local
- command: daemon.addConnection
- branch: persistent | ephemeral
- assert: addConnection が非 ephemeral 接続へ makeEvent('ready',{}) を 1 本送り、ephemeral (HTTP POST/gRPC unary) には送らない
- ref: packages/kit/src/serve/daemon.js:177-184; packages/kit/tests/serve/daemon.test.js:213-223
- kind: surface-parity
- status: planned
- note: 確認済: addConnection は !conn.ephemeral のとき conn.send(makeEvent('ready',{})) を 1 回 (daemon.js:181-183)。makeEvent は {method:'event.ready', params:{}} を返す (jsonrpc.js:377-379)。test 範囲を 213-222→213-223 に修正 (closing 含む)。daemon プランビング機構 [[SRV-0044]] と同一実装行で重なるが、event.ready 発火は購読ライフサイクルの ready 観点として EVT が owner のため保持 (SRV は framing/daemon 機構分担)

### [EVT-0018] event.ready は購読不可な broadcast で x-event-topics に含めない
- surface: serve, sdk
- backend: local
- command: rpc.discover / buildOpenRpcDoc
- branch: -
- assert: x-events に event.ready を載せるが x-event-topics (購読可能集合) には含めない。SDK の購読型は x-event-topics から導出するため ready は購読対象外
- ref: packages/kit/src/serve/registry.js:401-409; packages/kit/src/serve/daemon.js:179-183
- kind: contract-existence
- status: planned
- note: 確認済: x-events に event.ready (registry.js:405)、x-event-topics=[...SUBSCRIBABLE_TOPICS] (409) で ready 不在。daemon ref を 179-181→179-183 に微修正 (ready 送信本体まで含める)

### [EVT-0019] event.ready の x-stability は stable (local provenance)
- surface: serve
- backend: local
- command: rpc.discover / eventStabilityOf
- branch: -
- assert: event.ready は local ライフサイクル通知なので x-stability=stable / x-provenance=local。lockState/deviceUpdate は app-core stable
- ref: packages/kit/src/serve/stability.js:38-42; packages/kit/src/serve/stability.js:73-83; packages/kit/tests/serve/daemon.test.js:147-154
- kind: contract-existence
- status: planned
- note: 確認済: STABLE_EVENTS で event.ready:'local'、lockState/deviceUpdate:'app-core' (stability.js:38-42)。eventStabilityOf/eventProvenanceOf (73-83) が stable/local を導出。test 範囲 37→38 に修正 (37 は JSDoc 行; STABLE_EVENTS 本体は 38 開始)。test の title は 'experimental' とあるが assertion(153-154)は stable を要求(title が stale、assert は support)

## discover (x-events)

openrpc doc の x-events 記述と stability/provenance の既定降格を固定する。

### [EVT-0020] x-events が event.lockState/deviceUpdate/deviceListChanged/ready を記述する
- surface: serve, sdk
- backend: local
- command: rpc.discover / buildOpenRpcDoc
- branch: -
- assert: openrpc doc の x-events に 4 イベントが name+description+x-stability+x-provenance 付きで載り、x-event-topics は [lockState,deviceUpdate,deviceListChanged]
- ref: packages/kit/src/serve/registry.js:384-409
- kind: contract-existence
- status: planned
- note: 確認済: event() ヘルパ (384-390) が name/description/x-stability/x-provenance を付与、x-events 4 件 (401-406)、x-event-topics=[...SUBSCRIBABLE_TOPICS]=[lockState,deviceUpdate,deviceListChanged] (409)

### [EVT-0021] events.subscribe/unsubscribe メソッド自体が stable (local provenance)
- surface: serve
- backend: local
- command: rpc.discover / stabilityOf
- branch: -
- assert: events.subscribe/unsubscribe は STABLE_METHODS に local provenance で載り x-stability=stable。topic 配送内容 (lockState/deviceUpdate) は app-core stable
- ref: packages/kit/src/serve/stability.js:31-32; packages/kit/src/serve/stability.js:38-40; packages/kit/src/serve/stability.js:57-67
- kind: contract-existence
- status: planned
- note: 検証済: stability.js:31-32 が events.subscribe/unsubscribe を local 登録、57-67 が stabilityOf/provenanceOf。lockState/deviceUpdate の app-core stable 主張は STABLE_EVENTS (stability.js:38-40) が出典のため ref 追加

### [EVT-0022] 未登録 event の x-stability は experimental に既定降格
- surface: serve
- backend: local
- command: rpc.discover / eventStabilityOf
- branch: registered | unregistered
- assert: eventStabilityOf は STABLE_EVENTS 非掲載を experimental、eventProvenanceOf は unverified に既定降格する。deviceListChanged は STABLE_EVENTS 未掲載のため experimental
- ref: packages/kit/src/serve/stability.js:37-42; packages/kit/src/serve/stability.js:69-83
- kind: contract-existence
- status: planned
- note: 検証済: STABLE_EVENTS (37-42) は event.lockState/deviceUpdate/ready のみ。registry.js:386-389 の event() は 'event.deviceListChanged' を eventStabilityOf へ渡すが未掲載 → experimental, eventProvenanceOf → 'unverified' (stability.js:73-75,81-83)

## transport.subscribe

core 層 transport の (action:op) key 購読・配送順序・例外隔離・snapshot iterate・close クリアを固定する。

### [EVT-0023] transport.subscribe は (action:op) key で永続購読し一致 msg のみ配送
- surface: core
- backend: cloud
- command: Hub3WsClient.subscribe / _onMessage / WebSocketManager.notifySubscribers
- branch: matching-action-and-op | matching-action-mismatching-op | non-matching
- assert: subscribe(key,fn) は subscribers Map<`action:op`,Set<fn>> に登録し、_onMessage が `${action}:${op||''}` 一致の msg のみ Set fan-out する (複数購読者許容)。これは vendor からの意図的堅牢化 divergence である: vendor WebSocketManager は subscribers=Map<string,Function> を action のみで keying し action あたり 1 callback で上書き、op の弁別は handler 内 (useIotCtrl: switch(action)→if(op===pubDeviceStateChange)/(op===pubUserDeviceChange)) で行う
- ref: packages/core/src/transport.js:302-319; packages/core/src/transport.js:526-547; references_web/src/websocket/WebSocketManager.ts:17; references_web/src/websocket/WebSocketManager.ts:350-365; references_web/src/api/useIotCtrl.js:11-25; packages/core/tests/transport/subscribe.test.js:46-92
- kind: wire-fidelity
- status: planned
- note: 確認済: subscribe は subscribers Map<key,Set<fn>> に登録 (transport.js:309-319)、_onMessage は key=`${msg.action}:${msg.op||''}` (527) で subscribers を照合し snapshot 配信 (537-542)。test は一致/op-mismatch/action-mismatch を分岐検証 (subscribe.test.js:46-60) + Map 削除 (85-92)。負の事実 (vendor 照合): vendor WebSocketManager.ts:17 subscribers=Map<string,Function>、:350-352 subscribe(key,callback) が set で上書き (action あたり1個)、:358-365 notifySubscribers が message.action のみで lookup。op 弁別は useIotCtrl.js:19-25 が switch(message.action===BIZ3_TRIGGER_LOCKER)→if(op===pubDeviceStateChange)/(op===pubUserDeviceChange) で in-handler。core の action:op 複合キー + Set 多重購読は vendor からの意図的堅牢化

### [EVT-0024] _onMessage は resolver → subscribers → listeners の順で配送
- surface: core
- backend: cloud
- command: Hub3WsClient._onMessage
- branch: -
- assert: FIFO pending resolver を 1 件解決後、subscribers Set を snapshot して fan-out し、最後に listeners を呼ぶ。1 メッセージで全経路へ届く
- ref: packages/core/src/transport.js:526-547; packages/core/tests/transport/subscribe.test.js:296-323
- kind: contract-existence
- status: planned
- note: 確認: src 526-533 resolver→537-542 subscribers fan-out→544-546 listeners。test 296-310 が order=[resolver,sub,listener] を、312-323 が pending と subscribe の共存配信を保証。範囲妥当。

### [EVT-0025] subscriber/listener の例外は他経路へ伝播しない
- surface: core
- backend: cloud
- command: Hub3WsClient._onMessage
- branch: handler-throws
- assert: fan-out 中に1つの fn が throw しても try/catch で握り、後続 subscriber/listener と resolver の配送は継続する
- ref: packages/core/src/transport.js:530-546; packages/core/tests/transport/subscribe.test.js:181-194
- kind: error-path
- status: planned
- note: 確認: resolver try/catch=532, subscriber try/catch=540, listener try/catch=545。test 181-194 は subscriber throw→f2/listener が呼ばれることを保証 (listener throw 隔離は別 test 239-252 にもあり)。

### [EVT-0026] 配送中の unsub/再 subscribe は snapshot iterate で当該フレームに影響しない
- surface: core
- backend: cloud
- command: Hub3WsClient._onMessage
- branch: unsub-during-fanout | subscribe-during-fanout
- assert: subscribers を [...subs] で snapshot してから iterate するため、ハンドラ内の unsub は当該フレーム配送を妨げず、後追い subscribe は当該フレームでは呼ばれない
- ref: packages/core/src/transport.js:537-542; packages/core/tests/transport/subscribe.test.js:135-179
- kind: idempotency
- status: planned
- note: 確認: src 539 で [...subs] snapshot。test 135-162 が unsub-during、164-179 が subscribe-during を両方保証。

### [EVT-0027] close は subscribers を全クリアし pending を reject
- surface: core
- backend: cloud
- command: Hub3WsClient.close
- branch: -
- assert: close() で subscribers.clear() と _rejectAllPending(closedErr) を実行し、その後の deliver は旧 subscriber に届かない (leak/誤配送防止)
- ref: packages/core/src/transport.js:240-253; packages/core/tests/transport/subscribe.test.js:326-340
- kind: contract-existence
- status: planned
- note: 確認: close() 内で _rejectAllPending=240, subscribers.clear()=252。close メソッドは 226-253。test 326-340 は subscribers.size===0 と旧 subscriber 不配信を保証 (pending reject 自体の assert は test に無いが src 240 が裏付け)。

## 再接続再購読

再接続 OPEN ゲートと daemon/library 層の subscribe frame 張り直し冪等性を固定する。

### [EVT-0028] 再接続 (2回目以降の OPEN) で onReopen が発火、初回は発火しない
- surface: core
- backend: cloud
- command: Hub3WsClient._onOpen / onReopen
- branch: initial-open | reconnect-open
- assert: _everConnected ゲートにより初回 OPEN では onReopen を呼ばず、2 回目以降の OPEN でのみ呼ぶ (購読者が subscribe frame を再送する契機)
- ref: packages/core/src/transport.js:378-401; packages/core/tests/transport/onreopen.test.js:7-21
- kind: idempotency
- status: planned
- note: 確認: src 379-380 で isReconnect=_everConnected ゲート、398-400 で isReconnect 時のみ onReopen()。test 7-21 が初回未発火→2回目1回→3回目2回を保証。

### [EVT-0029] 再接続時に daemon が subscribe frame を張り直す
- surface: serve, core
- backend: cloud
- command: daemon._reestablishStateSub / hub.onReconnect
- branch: reconnect
- assert: hub.onReconnect 経由で _reestablishStateSub が旧購読を unsub してから _ensureStateSub で再送する。再接続後に subscribeDevicesUpdate frame が再度出る (サーバは新接続を覚えていないため必須)。発火経路は transport onReopen → client.js:284 (onReopen:()=>_fireReconnect) → client.js:224-229 (_fireReconnect が _reconnectCbs 発火) → client.js:219-222 (onReconnect が _reconnectCbs.add) → daemon._reestablishStateSub。この橋が無いと daemon の再購読は発火しない
- ref: packages/kit/src/serve/daemon.js:114-120; packages/kit/src/serve/daemon.js:116-118; packages/kit/src/serve/daemon.js:327-336; packages/core/src/client.js:284; packages/core/src/client.js:219-229; packages/kit/tests/serve/reconnect-resubscribe.test.js:40-72
- kind: idempotency
- status: planned
- note: 確認: start() 116-118 で hub.onReconnect(()=>_reestablishStateSub())、_reestablishStateSub 327-336 が旧 unsub(333-334)→_ensureStateSub(335)。test 40-72 が frame count 1→3 (再接続後再送) を実 frame で保証。daemon 再確立機構は [[SRV-0048]] と同一実装行で重なるが、購読ライフサイクル (再接続張り直し) の owner は EVT のため保持。トリガ機構の差異 (負の事実): vendor=connectionId 変化 (keepalive ack 由来, WebSocketManager.ts:72-83 が response.connectionId→:105-114 onConnectionIdChange→useManageDevice.js:352-358 getCompanyDevices)、core=生 WS 再 OPEN (transport.js:378-401 が _everConnected ゲートで 2 回目以降 OPEN→onReopen→_fireReconnect→_reestablishStateSub)。core に connectionId 概念は無い (transport.js:323 コメントのみ)。connectionId 連鎖の別観点 (接続単位購読の再送可能性) は [[DEV-0043]] が所有。onReopen ゲートは [[EVT-0028]]

### [EVT-0030] 再接続時の subscribe frame 二重送信は冪等で無害
- surface: serve, core
- backend: cloud
- command: daemon._reestablishStateSub / onDeviceUpdate.sendFrame
- branch: reconnect
- assert: daemon 再登録とライブラリ層 (onDeviceUpdate の onReconnect 再送) で同一 items の subscribe frame が複数回出るが、サーバは冪等に受理し二重配信を生まない (旧 fn を必ず unsub するため)
- ref: packages/kit/src/serve/daemon.js:327-336; packages/core/src/client.js:1550-1560; packages/kit/tests/serve/reconnect-resubscribe.test.js:41-69
- kind: idempotency
- status: planned
- note: 修正: client.js 1457-1478 は onLockStateChangeDevice (同型だが別メソッド)。command/test が指す onDeviceUpdate.sendFrame は client.js:1550-1560 (sendFrame=1552, onReconnect(sendFrame)=1558)。daemon._ensureStateSub:309 が hub.onDeviceUpdate を呼ぶ。daemon 側二重 unsub 防止は 333-334。test 41-69 が frame 1→3 で冪等性を保証。

### [EVT-0031] onLockStateChangeDevice は購読 frame を送り再接続で再送する
- surface: core
- backend: cloud
- command: SesameHub3.onLockStateChangeDevice
- branch: -
- assert: 対象 deviceUUID の subscribeDevicesUpdate frame を送り、onReconnect で再送し、data.deviceUUID 一致のみ fn へ配送する。unsubscribe は frame 再送停止+ローカル購読解除のみ (biz3 に unsubscribe op 無し)
- ref: packages/core/src/client.js:1451-1478; references_web/src/websocket/WebSocketManager.ts:72-83; references_web/src/websocket/WebSocketManager.ts:105-114
- kind: wire-fidelity
- status: planned
- note: 検証済: sendSubscribeFrame (client.js:1457-1465), onReconnect 再送 (1467), data.deviceUUID 一致判定 (1472-1474), unsubscribe はローカルのみ (1443-1444,1477)。トリガ機構の差異 (負の事実): core は再送を生 WS 再 OPEN (onReopen→_fireReconnect→onReconnect) で発火するが、vendor は keepalive ack 由来の connectionId 変化 (WebSocketManager.ts:72-83 response.connectionId→:105-114 onConnectionIdChange) を契機に再送する。core に connectionId 概念は無く、再 OPEN 即時に subscribe frame を再送する点が vendor の『connectionId 確定後に再送』とトリガ機構として異なる。詳細は [[EVT-0029]]

## framing

各 framing (WS/NDJSON/SSE/gRPC) での event 配送形と背圧・認証を固定する。

### [EVT-0032] WS framing は持続接続として event をそのまま流す
- surface: serve, sdk
- backend: cloud
- command: events.subscribe (WS)
- branch: ws
- assert: WS 接続は 1 接続=持続 Connection で events.subscribe 後に event 通知が JSON でそのまま送られ、背圧 (bufferedAmount>4MB) 超過で接続を切る
- ref: packages/kit/src/serve/framing/ws.js:36-46; packages/kit/src/serve/framing/ws.js:11
- kind: surface-parity
- status: planned
- note: 検証済: send は ws.send(JSON.stringify(obj)) (ws.js:39), 背圧 bufferedAmount>MAX_BUFFERED で close (38), MAX_BUFFERED=4MB (11), addConnection で持続接続化 (43)

### [EVT-0033] stdio/socket framing は event を改行区切り JSON で配送
- surface: serve
- backend: cloud
- command: events.subscribe (stdio/UDS)
- branch: stdio | socket
- assert: makeLineConnection の send が obj を JSON+改行で書き、背圧 (queue>maxQueue) 超過の遅い購読者だけを切る (通知 lossy)。event.ready も同経路で届く
- ref: packages/kit/src/serve/framing/ndjson.js:30-50; packages/kit/src/serve/daemon.js:179-182
- kind: surface-parity
- status: planned
- note: 修正: send の JSON+改行 (ndjson.js:35) と背圧 queue>maxQueue で close (38) は ndjson:30-50 で確認。assert の『event.ready も同経路』は daemon.addConnection が同じ conn.send(makeEvent('ready',{})) を流す daemon.js:179-182 が出典のため追加

### [EVT-0034] HTTP SSE は ?topics= を事前検証し event-stream で配送
- surface: serve, sdk
- backend: cloud
- command: GET /events (SSE)
- branch: valid-topics | all-invalid-topics
- assert: GET /events?topics= の topic を daemon.topics で検証し、全不正なら 400+valid 一覧、有効分は subscribe して data: <json> で配送する。event.ready も流れる
- ref: packages/kit/src/serve/framing/http.js:148-176
- kind: surface-parity
- status: planned
- note: 検証済: reqTopics を daemon.topics で filter (http.js:150-151), 全不正で 400+valid:daemon.topics (152-156), data: <json> 配送 (167), 有効分 subscribe (171)。event.ready は addConnection (170→daemon.js:182) 経由

### [EVT-0035] SSE 購読は token を URL に載せず Authorization ヘッダで認証
- surface: sdk
- backend: cloud
- command: SesameClient.streamEvents / stream_events
- branch: -
- assert: 同梱 SDK の SSE 購読は ?topics= のみ URL に載せ token は header (Authorization: Bearer) で渡す (ログ漏洩防止)
- ref: packages/kit/tests/serve/clients-js.test.js:130-150; packages/kit/tests/serve/clients-python.test.js:48-63
- kind: wire-fidelity
- status: planned
- note: 修正: 行ズレ。js の核心アサート (sseUrl に token=/TOKEN を含まない) は 148-150 にあり 130-145 では切れていたため 130-150 に拡張。py の token 非掲載+Authorization: Bearer 検証は 61-63 にあり 48-58 では届かないため 48-63 に拡張

### [EVT-0036] gRPC Subscribe ストリームは Event{topic,json} を配送
- surface: serve, sdk
- backend: cloud
- command: Subscribe (gRPC stream)
- branch: valid-topics | unknown-topic
- assert: gRPC Subscribe {topic,json} 封筒符号化は正典 [[SRV-0049]] を参照 (イベントのフレーミング符号化は SRV owner)
- ref: local-contract
- kind: wire-fidelity
- status: waived: 重複（正典 [[SRV-0049]]）
- note: 正典=[[SRV-0049]] (封筒変換機構: gRPC Subscribe stream 形は SRV が owner)。makeEvent 封筒の method から 'event.' を剥がし topic 化・params の JSON 文字列化・Event{topic,json} stream・不正 topic INVALID_ARGUMENT (grpc.js:175-209) は SRV-0049 が同一実装行で所有。gRPC token 検証は SRV 側に同等が無く [[EVT-0037]] が保持

### [EVT-0037] gRPC Subscribe は token を metadata か SubReq.token で要求
- surface: serve
- backend: cloud
- command: Subscribe (gRPC stream)
- branch: meta-token | subreq-token | bad-token
- assert: 認証は metadata authorization か SubReq.token のいずれか。不一致なら UNAUTHENTICATED でストリームを閉じ、addConnection 前に検証して event.ready の漏れ発火を防ぐ
- ref: packages/kit/src/serve/framing/grpc.js:175-205
- kind: error-path
- status: planned
- note: 検証済: provided = call.request.token || metaToken(call) (grpc.js:176), 不一致は UNAUTHENTICATED で endStreamWithError+return (177), 不正 topic も addConnection 前に検証 (199-205 のコメントが『addConnection の前に検証: 通すと event.ready が 1 本流れる』と明示)。token 検証は addConnection(205) より前

### [EVT-0038] events.* op は gRPC unary に生成されず Subscribe ストリーム専用
- surface: serve, sdk
- backend: cloud
- command: gen-grpc-proto / events.*
- branch: -
- assert: proto 生成は events.* を unary メソッドから除外し (Subscribe ストリームで扱う)、events.subscribe/unsubscribe の typed unary RPC は存在しない
- ref: scripts/gen-grpc-proto.mjs:58; scripts/gen-grpc-proto.mjs:109-110
- kind: contract-existence
- status: planned
- note: 検証済: 58行で name.startsWith('events.') を continue で除外、109-110行で唯一のストリーム RPC `Subscribe (SubReq) returns (stream Event)` を宣言。unary は通常 op のみ

## SDK / CLI surface

生成 SDK の topic 型導出・全 event 透過と、CLI --subscribe 経路・events メソッド直呼び拒否を固定する。

### [EVT-0039] SDK の SesameEventTopic 型が x-event-topics から導出される
- surface: sdk
- backend: cloud
- command: streamEvents / stream_events
- branch: ts | py
- assert: 生成 SDK の topic 型 (TS union / Python Literal[]) が openrpc の x-event-topics と一致し drift gate 対象。streamEvents/stream_events の topics 引数を絞り込む
- ref: scripts/gen-sdk-ts.mjs:100-103,192-196; scripts/gen-sdk-py.mjs:171-173,194-195
- kind: contract-existence
- status: planned
- note: 検証済: ts:102 / py:172 が spec['x-event-topics'] を読み SesameEventTopic を生成 (schema:12318 に存在)。drift gate sdk-ts-contract.test.js:15 が generateSdk(spec) を committed と byte 比較。streamEvents(topics: SesameEventTopic[]) / stream_events(topics: list[SesameEventTopic]) で引数を絞る。注: ts:192 の JSDoc は 'from the schema's x-events' と緩く記すが実コード(ts:102)の出典は x-event-topics で assert と一致

### [EVT-0040] SDK streamEvents は ready も含めて全 event を on_event へ渡す
- surface: sdk
- backend: cloud
- command: streamEvents / stream_events
- branch: -
- assert: SDK の SSE 購読は GET /events?topics= を開き、各 data: 行を JSON.parse して onEvent に渡す。event.ready も callback に届く (CLI は ready を出力しない上位フィルタ)
- ref: scripts/gen-sdk-ts.mjs:235-271; scripts/gen-sdk-py.mjs:323-344
- kind: surface-parity
- status: planned
- note: 検証済: ts:245/py:327 が GET /events?topics= を開き、ts:268-271/py:341-344 が data: 行を JSON.parse して onEvent へ。ready フィルタは無し (全 event 透過)。CLI 側 serve.js:220 のみ topic==='ready' を読み飛ばす。両 README (sdk/ts:70-76, sdk/python:86-93) も callback が event.ready を受ける旨を明記

### [EVT-0041] CLI sesame rpc --subscribe は UDS で購読し1行JSONで出力
- surface: cli
- backend: cloud
- command: sesame rpc --subscribe <topics>
- branch: uds | --http
- assert: --subscribe は UDS 経由で client.subscribe(topics) を張り {topic,payload} を1行JSONで出し続ける。event.ready は出力せず、--http 指定時は SSE curl 案内を出し exit 2
- ref: packages/kit/src/cli/serve.js:216-231; packages/kit/src/cli/serve.js:299-309
- kind: option-branch
- status: planned
- note: 検証済: rpcSubscribe(216-231) が SesameClient.unix(socketPath).subscribe(topics) を張り、topic==='ready' を return で除外(220)、console.log(JSON.stringify({topic,payload}))(221)。--subscribe 分岐(300-309)は opts.http 時に subscribeHttpUnsupported(SSE curl 案内)を出し process.exit(2)(304-305)、それ以外は UDS の rpcSubscribe へ

### [EVT-0042] sesame rpc で events.subscribe/unsubscribe を直接メソッド指定すると拒否
- surface: cli
- backend: cloud
- command: sesame rpc events.subscribe
- branch: events-method-as-rpc
- assert: events.subscribe/unsubscribe を 1 回呼びの rpc メソッドとして渡すと rpcEventsPersistent 案内を出し exit 2 (持続接続が必要なため --subscribe を促す)
- ref: packages/kit/src/cli/serve.js:326-329
- kind: error-path
- status: planned
- note: 検証済: 326-329 で m==='events.subscribe' || m==='events.unsubscribe' のとき serve.rpcEventsPersistent を console.error し process.exit(2)

## keepalive

WS keepalive frame の action 同値と connectionId ベース生存判定を固定する。

### [EVT-0043] keepalive ack は success に依存せず connectionId 受信で生存判定
- surface: core
- backend: cloud
- command: Hub3WsClient.ping / _onMessage (biz3KeepAlive)
- branch: -
- assert: keepalive 応答は success ではなく connectionId を返す (vendor)。ack 受信自体で pong timer をクリアし生存とみなす (success 有無に非依存)
- ref: packages/core/src/transport.js:321-330; packages/core/src/transport.js:520-524; references_web/src/websocket/WebSocketManager.ts:72-83
- kind: wire-fidelity
- status: planned
- note: 検証済: ping(327-330) は応答受信(!!resp)を生存判定とし success に非依存。_onMessage(520-524) は msg.action===KEEPALIVE_ACTION で success 有無問わず pongTimer を clear。vendor WebSocketManager.ts:73 は response.connectionId を読み 81 で clearPongTimeout() — connectionId ベースで success を見ない原典と一致

### [EVT-0044] keepalive frame の action が biz3KeepAlive (vendor 同値)
- surface: core
- backend: cloud
- command: Hub3WsClient._triggerHeartbeatCheck
- branch: -
- assert: heartbeat 送信 frame が {action:'biz3KeepAlive'} で vendor ACTION_TYPES.BIZ3_KEEP_ALIVE と一致。60s 間隔 + 3s pong timeout で半開検知し能動再接続
- ref: packages/core/src/transport.js:69; packages/core/src/transport.js:644-659; references_web/src/websocket/WebSocketManager.ts:303-327
- kind: wire-fidelity
- status: planned
- note: 検証済: transport.js:69 KEEPALIVE_ACTION=ACTION_TYPES.BIZ3_KEEP_ALIVE。_triggerHeartbeatCheck(644-659) が ws.send({action:KEEPALIVE_ACTION})(650) + PONG_TIMEOUT_MS(3s,57)後に _reconnect(655-658)。間隔は KEEPALIVE_INTERVAL_MS=60000(56)。vendor 値 'biz3KeepAlive'(messageConstants.js:2), WS_HEARTBEAT_INTERVAL_MS=60000(messageConstants.js:30)。原典 WebSocketManager.ts:305 が同 action 送信・309 で 3000ms・325 で WS_HEARTBEAT_INTERVAL_MS 間隔 — 60s/3s 全一致

## provenance (実機/実クラウド限定)

実クラウド往復でしか確認できない push 配送境界を waived として記録する。

### [EVT-0045] pubUserDeviceChange が無購読接続に届くかは実機未検証
- surface: core
- backend: cloud
- command: onUserDeviceChange / subscribeUserDeviceChange
- branch: -
- assert: deviceListChanged (pubUserDeviceChange) は専用 subscribe op が無く、vendor は常時 subscribeDevicesUpdate 済みのため無購読接続にも届くかは実クラウド往復でしか確認できない
- ref: packages/core/src/devices.js:309-329; packages/core/src/client.js:1480-1493; references_web/src/api/useIotCtrl.js:23-25
- kind: wire-fidelity
- status: waived:実クラウドの push 配送経路は往復でしか検証不能
- note: 検証済: useIotCtrl.js:23-25 は pubUserDeviceChange のハンドラ登録のみ (専用 subscribe op 無し)、vendor は getCompanyDevices 後に常時 subscribeDevicesUpdate を送信 (useManageDevice.js:322-349)。境界は実クラウド往復限定のため status を planned→waived: へ修正

## 監査追補 v2 (dual-audit)

dual-audit 第二世代で検出した購読 auth ゲート不在・unsubscribe の未知 topic 寛容 (subscribe 拒否との非対称) を負の事実として固定する。

### [EVT-0046] events.subscribe/unsubscribe は requireAuth ゲートを通らず authState を問わず受理する
- surface: serve, sdk
- backend: cloud
- command: events.subscribe / events.unsubscribe
- branch: authState=ok | authState=degraded | authState=expired
- assert: events.subscribe/unsubscribe ハンドラは namespace op (registry.js:302 が requireAuth(daemon)→hub[ns][op]) と異なり requireAuth を呼ばないため、authState が expired/degraded でも RpcError(NOT_AUTHENTICATED) を投げず購読 Set を記録する。実 subscribe frame は接続確立後に _ensureStateSub が送る (未接続の間は購読 topic だけが記録される)
- ref: packages/kit/src/serve/entries/events.js:25-34; packages/kit/src/serve/entries/events.js:41-44; packages/kit/src/serve/registry.js:302; packages/kit/src/serve/registry-helpers.js:55-57; packages/kit/src/serve/daemon.js:275-281; packages/kit/src/serve/daemon.js:303
- kind: option-branch
- status: planned
- note: events.js は requireAuth を import すらせず一切呼ばない (:25-34 subscribe / :41-44 unsubscribe)。対照的に namespace op は registry.js:302 で requireAuth(daemon) を通す (registry-helpers.js:55-57 が authState='expired' で NOT_AUTHENTICATED throw)。daemon.subscribe (daemon.js:275-281) は authState を見ず set.add のみ、_ensureStateSub (daemon.js:303) は !hub.connected で早期 return するため購読は記録だけされる。EVT-0008 (遅延張り) の auth ゲート不在版。実装疑い: 未認証でも subscribe が成功する境界 (auth-gate parity 欠落)

### [EVT-0047] events.unsubscribe は未知 topic を検証せず黙って no-op する (subscribe の未知 topic 拒否と非対称)
- surface: serve, sdk
- backend: cloud
- command: events.unsubscribe / daemon.unsubscribe
- branch: unknown-topic
- assert: events.unsubscribe ハンドラは subscribe (events.js:31-32 の bad=topics.filter(!TOPICS.includes)→throw) と異なり TOPICS 検証を持たず、未知 topic を asTopicList で正規化したまま daemon.unsubscribe へ渡す。daemon.unsubscribe (daemon.js:288-294) は set.delete(未知 topic) が空振りするため throw せず {subscribed: 残存} を返す (subscribe は未知 topic で INVALID_PARAMS を投げるのと非対称)。enum schema (events.js:39) は OpenRPC 上の宣言で実行時強制はされない
- ref: packages/kit/src/serve/entries/events.js:41-44; packages/kit/src/serve/entries/events.js:30-32; packages/kit/src/serve/daemon.js:288-294
- kind: idempotency
- status: planned
- note: unsubscribe ハンドラ (events.js:41-44) には bad-filter が無い (subscribe は :30-32 で TOPICS 検証して throw)。daemon.unsubscribe (daemon.js:288-294) は set.delete(t) を回すだけで未知 topic を no-op 化。enum schema (events.js:39, [[EVT-0005]]) は schema 上の宣言で実行時検証は無い。EVT-0006 が conn-not-registered の寛容を扱うのに対し本件は unknown-topic 寛容 (subscribe [[EVT-0004]] の拒否との非対称) を固定する

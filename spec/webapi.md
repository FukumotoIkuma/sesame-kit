<!-- spec-domain: webapi | prefix: WEB | tests: packages/core/tests/client, packages/kit/tests/serve -->

# Web API パススルー spec (WEB)

webapi.* (invoke/deviceState/deviceHistory/sendCmd) の生クラウド passthrough を biz3 web (useDeveloper/useManageDevice/useIotCtrl) に照らして監査する。

## webapi.invoke (core wire)

invokeWebAPI の送出フレーム形 (action/op/apiKeyId/body/query) を vendor useDeveloper.invokeAPI に 1:1 で照合し、body 常時送信 / query 条件スプレッドの非対称を固定する。

### [WEB-0001] webapi invoke フレーム形 {action:biz3InvokeWebAPIs, op:func, apiKeyId, body, query?}
- surface: core
- backend: cloud
- command: devices.invokeWebAPI
- branch: query+body 両指定
- assert: 送出フレームが action=biz3InvokeWebAPIs / op=<func> / apiKeyId / body=<obj> / query=<obj> を持つ (vendor invokeAPI と 1:1)
- ref: packages/core/src/devices.js:481; packages/core/src/devices.js:484; packages/core/src/devices.js:490; references_web/src/api/useDeveloper.js:48; references_web/src/api/useDeveloper.js:54; packages/core/src/vendor/biz3/constants/messageConstants.js:18
- kind: wire-fidelity
- status: planned
- note: action 文字列は ACTION_TYPES.BIZ3_INVOKE_WEBAPI='biz3InvokeWebAPIs' (messageConstants.js:18)。確認: devices.js:484=action / :485 op / :486 apiKeyId / :489 query 条件スプレッド / :490 body。vendor フレームは useDeveloper.js:47-53、:54 sendMessage で送出。既存 manage-ops.test.js:351-356 が両指定をカバー済みだが本 spec は status planned。旧 refs :483 は frame 開き波括弧のみだったため :484/:490 へ修正。

### [WEB-0002] invokeWebAPI: body は未指定でも常時 {} を送る (vendor body={} デフォルト)
- surface: core
- backend: cloud
- command: devices.invokeWebAPI
- branch: body 未指定
- assert: body 引数省略時もフレームに body:{} が常時存在する (vendor useDeveloper.js:46 `body = {}` 既定引数に一致)
- ref: packages/core/src/devices.js:490; references_web/src/api/useDeveloper.js:46; references_web/src/api/useDeveloper.js:52
- kind: wire-fidelity
- status: planned
- note: devices.js:490=`body: body ?? {}` で常時送信。vendor: useDeveloper.js:46 が `body = {}` デフォルト引数、:52 が msgData.body キー (旧 ref :53 は閉じ波括弧 `};` だったため :52 へ修正)。旧実装の「body キー不在」は参照誤読による逸脱だった。manage-ops.test.js:342-348 (両未指定で body==={}) 参照。

### [WEB-0003] invokeWebAPI: query は undefined のときフレームから脱落 (条件スプレッド)
- surface: core
- backend: cloud
- command: devices.invokeWebAPI
- branch: query 未指定
- assert: query 未指定時はフレームに query キーが現れない (JSON.stringify で undefined が脱落する vendor 挙動と一致)
- ref: packages/core/src/devices.js:489; references_web/src/api/useDeveloper.js:46; references_web/src/api/useDeveloper.js:51
- kind: wire-fidelity
- status: planned
- note: devices.js:489=`...(query !== undefined && { query })`。vendor: useDeveloper.js:46 が query を分割代入 (省略時 undefined)、:51 が msgData の query キー (無条件記載だが JSON.stringify で undefined が脱落)。旧 ref :52 は body キー行だったため :51 へ修正。body(常時送信) と query(条件) の非対称が要点。manage-ops.test.js:334-339 参照。

### [WEB-0004] invokeWebAPI: success 欠落でも data を返す (非strict / vendor は success を見ない)
- surface: core
- backend: cloud
- command: devices.invokeWebAPI
- branch: 応答に success フィールド無し
- assert: 応答に success が無くても reject せず resp.data を返す (assertSuccess を strict 無指定=非strict で呼ぶ。vendor handleAPIInfoResponse は success 非参照)
- ref: packages/core/src/devices.js:498; packages/core/src/util.js:34; packages/core/src/util.js:35; references_web/src/api/useDeveloper.js:18; references_web/src/api/useDeveloper.js:31
- kind: error-path
- status: planned
- note: 検証済: devices.js:498 は assertSuccess(resp, ...) を opts 無し=strict:false で呼ぶ。util.js:34 シグネチャ {strict=false}、util.js:35 `failed = strict ? !resp?.success : !resp || resp.success===false` で success 欠落は許容。vendor useDeveloper.js:18-31 handleAPIInfoResponse は switch(message.action) のみで success 非参照。実応答の success 有無は実機未確認 (REFACTORING_PLAN §9 V9) だが非strict 緩和ロジック自体は fake で検証可。manage-ops.test.js:203-207 参照 (タグ未付与のため status=planned 維持)。

### [WEB-0005] invokeWebAPI: success:false なら reject (非strict でも明示失敗は拒否)
- surface: core
- backend: cloud
- command: devices.invokeWebAPI
- branch: 応答 success:false
- assert: 応答が success:false のとき非strict でも reject する (assertSuccess: !resp || resp.success===false)
- ref: packages/core/src/devices.js:498; packages/core/src/util.js:35; references_web/src/api/useDeveloper.js:18
- kind: error-path
- status: planned
- note: 検証済: util.js:35 非strict 分岐 `!resp || resp.success===false` が success:false を failed 判定 → util.js:37-40 で SesameError(code=rejected) throw。devices.js:498 が経路。境界 = success 欠落は許容 / success:false は拒否。manage-ops.test.js:209-212 参照 (タグ未付与のため status=planned 維持)。

## webapi.deviceState (core wire)

webapiDeviceState の op (webapi_ssm_shadow_get) と query={device_id} を vendor getIoTDeviceState に照合し、device_id 無加工 (register 系の uppercase との境界) を固定する。

### [WEB-0006] webapiDeviceState: op=webapi_ssm_shadow_get / query={device_id}
- surface: core
- backend: cloud
- command: devices.webapiDeviceState
- branch: -
- assert: op が 'webapi_ssm_shadow_get' で query={device_id:<deviceId>} を送る (vendor getIoTDeviceState と 1:1)
- ref: packages/core/src/devices.js:511; packages/core/src/devices.js:513; references_web/src/api/useDeveloper.js:9; references_web/src/api/useDeveloper.js:60; references_web/src/api/useDeveloper.js:62
- kind: wire-fidelity
- status: planned
- note: op 値は vendor API.WEBAPI_DEVICE_STATE (useDeveloper.js:9)。devices.js:511=func 文字列 / :513=query={device_id}。vendor getIoTDeviceState は useDeveloper.js:60-62 で query:{device_id} を渡す。旧 ref :509 (関数 sig) は :511 (func 値行) へ寄せた。

### [WEB-0007] webapiDeviceState: device_id は無加工で query に乗る (大文字化/正規化なし)
- surface: core
- backend: cloud
- command: devices.webapiDeviceState
- branch: -
- assert: deviceId は uppercase/normalizeUuid 等の変換を経ず query.device_id にそのまま乗る (vendor は device_id を素通し)
- ref: packages/core/src/devices.js:513; references_web/src/api/useDeveloper.js:62; packages/core/src/devices.js:886
- kind: wire-fidelity
- status: planned
- note: devices.js:513=`query: { device_id: deviceId }` (無加工)。vendor useDeveloper.js:62 も device_id を素通し。対比の境界として register 系 signGuestKey の devices.js:886=`deviceId: deviceUUID.toUpperCase()` (CHSesameOS3.kt:476) を ref 追加。webapi 経路は無加工が境界。

## webapi.deviceHistory (core wire)

webapiDeviceHistory の op (webapi_history_get) と query 既定値 (page=0/lg=5/isBiz=true) を vendor getDeviceHistory に照合し、明示値による上書き分岐を固定する。

### [WEB-0008] webapiDeviceHistory: op=webapi_history_get / query={device_id,page:0,lg:5,isBiz:true}
- surface: core
- backend: cloud
- command: devices.webapiDeviceHistory
- branch: 既定値 (page/lg/isBiz 省略)
- assert: op='webapi_history_get'、query 既定が page=0 / lg=5(数値) / isBiz=true (vendor getDeviceHistory と 1:1)
- ref: packages/core/src/devices.js:524; packages/core/src/devices.js:527; references_web/src/api/useDeveloper.js:10; references_web/src/api/useDeveloper.js:73; references_web/src/api/useDeveloper.js:74; references_web/src/api/useDeveloper.js:75
- kind: wire-fidelity
- status: planned
- note: op 値は vendor API.WEBAPI_DEVICE_HISTORY (useDeveloper.js:10)。devices.js:524 の sig 既定 `page=0,lg=5,isBiz=true`、:527 が func 文字列。vendor 既定値は useDeveloper.js:73(page:0)/:74(lg:5 数値)/:75(isBiz:true)。lg は言語コードの数値 ID(5)。旧実装の lg='ja'(文字列)は誤りで修正済み。旧 ref :71 (query 開き波括弧) を各既定値行 :73/:74/:75 へ精緻化。

### [WEB-0009] webapiDeviceHistory: page/lg/isBiz の明示値が既定を上書きして query に反映
- surface: core
- backend: cloud
- command: devices.webapiDeviceHistory
- branch: page/lg/isBiz 明示指定
- assert: page/lg/isBiz を明示すると既定(0/5/true)ではなく明示値が query に乗る
- ref: packages/core/src/devices.js:524; packages/core/src/devices.js:528
- kind: option-branch
- status: planned
- note: devices.js:524=sig のデフォルト引数 (page=0,lg=5,isBiz=true)、:528=`query: { device_id: deviceId, page, lg, isBiz }` でデフォルト引数の解決値を素通し。明示値はデフォルト引数を上書きして :528 の query に反映 (JS デフォルト引数セマンティクス=local-contract 寄りだが両行が直接支持)。既定値分岐の対 (省略=[[WEB-0008]] / 明示=本spec)。

## webapi.sendCmd (core wire)

webapiSendCmd の op (webapi_cmd_send) と body={device_id,cmd,sign,history} キー集合を vendor triggerDevice に照合し、sign/history の呼び出し側組み立て素通し・device_id 無加工を固定する。

### [WEB-0010] webapiSendCmd: op=webapi_cmd_send / body={device_id,cmd,sign,history}
- surface: core
- backend: cloud
- command: devices.webapiSendCmd
- branch: -
- assert: op='webapi_cmd_send' で body が {device_id,cmd,sign,history} の4キー(vendor triggerDevice body と同一キー集合)。sign/history は呼び出し側組み立てを素通し
- ref: packages/core/src/devices.js:537; packages/core/src/devices.js:539; packages/core/src/devices.js:541; references_web/src/api/useDeveloper.js:11; references_web/src/api/useDeveloper.js:83; references_web/src/api/useDeveloper.js:90
- kind: wire-fidelity
- status: planned
- note: vendor body:{cmd,history,sign,device_id} (useDeveloper.js:90)。JSON キー集合一致が境界 (順序は無関係)。op='webapi_cmd_send' は kit devices.js:539 で func に焼き込まれ invokeWebAPI で op へ転写 (devices.js:485)、vendor は useDeveloper.js:11 の WEBAPI_DEVICE_TRIGGER 定数。sign=Cmac.cmacTime / history=uuidBuffer は呼び出し側責務 (useDeveloper.js:86-87)。検証済: refs 全行実在・支持。op 値行 :539 を追加。

### [WEB-0011] webapiSendCmd: device_id は無加工で body に乗る
- surface: core
- backend: cloud
- command: devices.webapiSendCmd
- branch: -
- assert: deviceId は変換を経ず body.device_id にそのまま乗る (vendor triggerDevice の device_id 素通しと一致)
- ref: packages/core/src/devices.js:541; references_web/src/api/useDeveloper.js:84; references_web/src/api/useDeveloper.js:90
- kind: wire-fidelity
- status: planned
- note: 検証済: devices.js:541 `body:{ device_id: deviceId, ... }` で deviceId を無変換代入。vendor useDeveloper.js:84 で device_id を分割代入 → :90 で body.device_id へ素通し。全行支持。

## client apiKeyId 解決 / 必須 / 未接続

SesameHub3.* の apiKeyId 二段解決 (引数優先 → config フォールバック)・未解決 BAD_REQUEST・未接続 NOT_CONNECTED の防御を 4 メソッド横断で固定する。

### [WEB-0012] client.invokeWebAPI: apiKeyId は引数優先 → config.apiKeyId フォールバック
- surface: core
- backend: cloud
- command: SesameHub3.invokeWebAPI
- branch: apiKeyId 引数省略 (config から補完)
- assert: apiKeyId 省略時 config.apiKeyId を使い、明示時はそちら優先 (key = apiKeyId || this._config.apiKeyId)
- ref: packages/core/src/client.js:1300; packages/core/src/client.js:1302; packages/core/src/client.js:1305
- kind: wire-fidelity
- status: planned
- note: 検証済: client.js:1300 invokeWebAPI({...apiKeyId})、:1302 `const key = apiKeyId || this._config.apiKeyId`、:1305 devices.invokeWebAPI へ key 渡し。vendor は gStripe.apiKey.apiKeyId を常時供給 (useDeveloper.js:50)。kit は引数 or config の二段解決 (local-contract 寄り)。

### [WEB-0013] client.invokeWebAPI: apiKeyId 未解決 (引数・config 共に無) で BAD_REQUEST
- surface: core
- backend: cloud
- command: SesameHub3.invokeWebAPI
- branch: apiKeyId 引数なし & config.apiKeyId なし
- assert: apiKeyId が引数にも config にも無いとき badRequest('domain.client.apiKeyIdRequired') を throw する
- ref: packages/core/src/client.js:1302; packages/core/src/client.js:1304
- kind: error-path
- status: planned
- note: 検証済: client.js:1302 で key が両ソース falsy → undefined、:1304 `if (!key) throw badRequest('domain.client.apiKeyIdRequired')`。i18n キー実在 (domain.js:22,137)。元 ref :1303 は説明コメント (P5-1 方針1) で非load-bearing のため、解決行 :1302 + throw 行 :1304 へ置換。vendor に明示 throw は無い (apiKeyId 存在前提) が kit は必須化 (local-contract)。

### [WEB-0014] client.webapiDeviceState: apiKeyId 未解決で BAD_REQUEST
- surface: core
- backend: cloud
- command: SesameHub3.webapiDeviceState
- branch: apiKeyId 引数なし & config.apiKeyId なし
- assert: apiKeyId 未解決時 badRequest('domain.client.apiKeyIdRequired') を throw (invokeWebAPI と同一防御)
- ref: packages/core/src/client.js:1311; packages/core/src/client.js:1312
- kind: error-path
- status: planned
- note: 検証済: client.js:1311 `const key = apiKeyId || this._config.apiKeyId`、:1312 `if (!key) throw badRequest('domain.client.apiKeyIdRequired')`。invokeWebAPI ([[WEB-0013]] :1302-1304) と同一二段解決+必須防御。i18n キー実在 (domain.js:22,137)。

### [WEB-0015] client.webapiDeviceHistory: apiKeyId 未解決で BAD_REQUEST
- surface: core
- backend: cloud
- command: SesameHub3.webapiDeviceHistory
- branch: apiKeyId 引数なし & config.apiKeyId なし
- assert: apiKeyId 未解決時 badRequest('domain.client.apiKeyIdRequired') を throw
- ref: packages/core/src/client.js:1319; packages/core/src/client.js:1320
- kind: error-path
- status: planned
- note: client.js:1319 が `apiKeyId || this._config.apiKeyId`、1320 が `if (!key) throw badRequest('domain.client.apiKeyIdRequired')`。確認済み。

### [WEB-0016] client.webapiSendCmd: apiKeyId 未解決で BAD_REQUEST
- surface: core
- backend: cloud
- command: SesameHub3.webapiSendCmd
- branch: apiKeyId 引数なし & config.apiKeyId なし
- assert: apiKeyId 未解決時 badRequest('domain.client.apiKeyIdRequired') を throw
- ref: packages/core/src/client.js:1327; packages/core/src/client.js:1328
- kind: error-path
- status: planned
- note: client.js:1327 が key 解決、1328 が `if (!key) throw badRequest('domain.client.apiKeyIdRequired')`。確認済み。

### [WEB-0017] client.invokeWebAPI: 未接続で NOT_CONNECTED (retryable)
- surface: core
- backend: cloud
- command: SesameHub3.invokeWebAPI
- branch: 未 connect
- assert: connect 前に呼ぶと _ensureConnected が SesameError(NOT_CONNECTED, retryable:true) を throw する
- ref: packages/core/src/client.js:1301; packages/core/src/client.js:306; packages/core/src/client.js:310
- kind: error-path
- status: planned
- note: client.js:1301 が `const ws = this._ensureConnected()`、306-310 が _ensureConnected 本体 (310: `throw new SesameError(t('domain.client.notConnected'), { code: ERR.NOT_CONNECTED, retryable: true })`)。webapiDeviceState/History/SendCmd も各 1310/1318/1326 で同じ呼び出し。serve 経由では requireAuth が先に CONNECTION_LOST を返す (registry-helpers.js:59-61)。確認済み。

## serve registry / 委譲 / エラー写像

webapi 4 メソッドの registry 登録・hub 委譲 (params 順)・必須キー検証 (bad_params)・apiKeyId 未設定の bad_params 写像・未接続 CONNECTION_LOST を固定する。

### [WEB-0018] serve: webapi.invoke/deviceState/deviceHistory/sendCmd が registry に存在
- surface: serve
- backend: cloud
- command: registry webapiEntries
- branch: -
- assert: registry に webapi.invoke / webapi.deviceState / webapi.deviceHistory / webapi.sendCmd の4メソッドが config.* 直後に登録される
- ref: packages/kit/src/serve/entries/device.js:191; packages/kit/src/serve/entries/device.js:193; packages/kit/src/serve/registry.js:339
- kind: contract-existence
- status: planned
- note: webapiEntries() (device.js:191) が invoke@193 / deviceState@203 / deviceHistory@212 / sendCmd@233 の4件を返す。registry.js:339 が configEntries (338) 直後に webapiEntries() を reg.set。確認済み。

### [WEB-0019] serve webapi.invoke → hub.invokeWebAPI({func,query,body,apiKeyId})
- surface: serve
- backend: cloud
- command: webapi.invoke
- branch: -
- assert: handler が requireAuth → need(['func']) 後に hub.invokeWebAPI へ func/query/body/apiKeyId をそのまま委譲する
- ref: packages/kit/src/serve/entries/device.js:201; packages/kit/src/serve/registry-helpers.js:32; packages/kit/src/serve/registry-helpers.js:55
- kind: surface-parity
- status: planned
- note: device.js:201 handler が `requireAuth(daemon); need(params,['func']); return hub.invokeWebAPI({func,query,body,apiKeyId})`。need=registry-helpers.js:32、requireAuth=:55。registry-wiring.test.js:102 が params 順 [func,query,body,apiKeyId] と委譲を確認。

### [WEB-0020] serve webapi.invoke: func 欠落で bad_params (INVALID_PARAMS)
- surface: serve
- backend: cloud
- command: webapi.invoke
- branch: func 欠落
- assert: params に func が無いと need() が RpcError(INVALID_PARAMS, kind=BAD_PARAMS) を throw する
- ref: packages/kit/src/serve/entries/device.js:196; packages/kit/src/serve/entries/device.js:201; packages/kit/src/serve/registry-helpers.js:34; packages/kit/src/serve/registry-helpers.js:35
- kind: error-path
- status: planned
- note: device.js:196 が func required:true、:201 handler が need(params,['func'])。registry-helpers.js:34 が undefined/null/'' 判定、:35 が `throw new RpcError(..., { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS })`。registry-wiring.test.js:228 が空 params で throw を確認。

### [WEB-0021] serve webapi.invoke: apiKeyId 未設定 → bad_params 写像
- surface: serve
- backend: cloud
- command: webapi.invoke
- branch: apiKeyId なし & config なし
- assert: func あり apiKeyId 無しで hub 層 badRequest(code=bad_request) が errorFromThrow で kind=bad_params(INVALID_PARAMS) へ写像され internal に潰れない
- ref: packages/core/src/client.js:1304; packages/core/src/jsonrpc.js:213; packages/kit/tests/serve/serve-error-kind.test.js:124
- kind: error-path
- status: planned
- note: 修正: 元 assert は 'serve の BAD_REQUEST kind へ写像' としていたが KIND 列挙に BAD_REQUEST は無く (jsonrpc.js:169-)、SESAME_TO_RPC[ERR.BAD_REQUEST] = {kind: KIND.BAD_PARAMS('bad_params'), code: RPC.INVALID_PARAMS} (jsonrpc.js:213)。serve-error-kind.test.js:124 も期待値を KIND.BAD_PARAMS とする。出典を client.js:1304 ([[WEB-0013]] invokeWebAPI の `throw badRequest('domain.client.apiKeyIdRequired')`)・写像表 jsonrpc.js:213・テスト:124 へ置換。元参照 device.js:201 は handler 行で写像表ではないため除外。

### [WEB-0022] serve webapi.invoke: 未接続 daemon で requireAuth が CONNECTION_LOST
- surface: serve
- backend: cloud
- command: webapi.invoke
- branch: daemon 未認証/未接続
- assert: requireAuth(daemon) が hub 未接続時 RpcError(kind=CONNECTION_LOST) を投げ、ハンドラ本体に到達しない
- ref: packages/kit/src/serve/entries/device.js:201; packages/kit/src/serve/registry-helpers.js:55; packages/kit/src/serve/registry-helpers.js:60
- kind: error-path
- status: planned
- note: 確認済: device.js:201 は webapi.invoke handler 先頭で requireAuth(daemon) を呼ぶ。registry-helpers.js:55 requireAuth 定義、:59-60 で !daemon.hub.connected → kind=KIND.CONNECTION_LOST (core/jsonrpc.js:173)。4 webapi handler 全て (201/210/223/244) が先頭で requireAuth(daemon) を呼ぶ。

### [WEB-0023] serve webapi.deviceState → hub.webapiDeviceState({deviceId,apiKeyId}) / deviceId 必須
- surface: serve
- backend: cloud
- command: webapi.deviceState
- branch: deviceId 欠落
- assert: need(['deviceId']) 後 hub.webapiDeviceState へ deviceId/apiKeyId を委譲。deviceId 欠落で bad_params
- ref: packages/kit/src/serve/entries/device.js:206; packages/kit/src/serve/entries/device.js:210; packages/kit/src/serve/registry-helpers.js:35
- kind: surface-parity
- status: planned
- note: 確認済: device.js:206 deviceId(required:true,S)、:210 handler が requireAuth→need(['deviceId'])→hub.webapiDeviceState({deviceId,apiKeyId}) を委譲。registry-helpers.js:35 で need 欠落時 kind=BAD_PARAMS/code=INVALID_PARAMS を裏付け。

### [WEB-0024] serve webapi.deviceHistory → hub へ deviceId/page/lg/isBiz/apiKeyId 委譲 / deviceId 必須
- surface: serve
- backend: cloud
- command: webapi.deviceHistory
- branch: deviceId 欠落 | page/lg/isBiz 任意
- assert: need(['deviceId']) 後 hub.webapiDeviceHistory へ deviceId/page/lg/isBiz/apiKeyId を委譲。page/lg/isBiz は optional
- ref: packages/kit/src/serve/entries/device.js:215; packages/kit/src/serve/entries/device.js:223; packages/kit/src/serve/entries/device.js:224
- kind: surface-parity
- status: planned
- note: 行修正: 旧 ref :213 は summary 行で assert を支えないため置換。:215 deviceId(required:true), :216-219 page(N)/lg(N)/isBiz(B)/apiKeyId(S) は全て required:false=optional、:223 requireAuth→need(['deviceId'])、:224-230 hub.webapiDeviceHistory({deviceId,page,lg,isBiz,apiKeyId}) 委譲を確認。

### [WEB-0025] serve webapi.sendCmd → hub へ deviceId/cmd/sign/history/apiKeyId 委譲
- surface: serve
- backend: cloud
- command: webapi.sendCmd
- branch: -
- assert: need(['deviceId','cmd','sign','history']) 後 hub.webapiSendCmd へ deviceId/cmd/sign/history/apiKeyId を委譲する
- ref: packages/kit/src/serve/entries/device.js:233; packages/kit/src/serve/entries/device.js:244; packages/kit/src/serve/entries/device.js:245
- kind: surface-parity
- status: planned
- note: 確認済: device.js:233 "webapi.sendCmd" エントリ、:244 requireAuth→need(['deviceId','cmd','sign','history'])、:245-251 hub.webapiSendCmd({deviceId,cmd,sign,history,apiKeyId}) を委譲。

### [WEB-0026] serve webapi.sendCmd: deviceId/cmd/sign/history のいずれか欠落で bad_params
- surface: serve
- backend: cloud
- command: webapi.sendCmd
- branch: cmd/sign/history いずれか欠落
- assert: need(['deviceId','cmd','sign','history']) が 4 必須キーのうち欠落を bad_params で拒否し、params schema は cmd=N(number)・deviceId/sign/history/apiKeyId=S(string) 型で vendor triggerDevice の cmd(数値,既定88)・sign(Cmac 文字列)・history(uuidBuffer) の型境界と整合する
- ref: packages/kit/src/serve/entries/device.js:236; packages/kit/src/serve/entries/device.js:237; packages/kit/src/serve/entries/device.js:244; references_web/src/api/useDeveloper.js:84; references_web/src/api/useIotCtrl.js:37
- kind: error-path
- status: planned
- note: 確認済: device.js:236-240 params schema deviceId(S)/cmd(N)/sign(S)/history(S) required:true、apiKeyId(S) optional。:244 need(['deviceId','cmd','sign','history'])。欠落は registry-helpers.js:35 で kind=BAD_PARAMS/code=INVALID_PARAMS。型境界: device.js:237 cmd=N、vendor useDeveloper.js:84 triggerDevice の cmd は数値 (useIotCtrl.js:37 で既定 88)・sign=Cmac.cmacTime(文字列, useDeveloper.js:87)・history=biz3utils.uuidBuffer (useDeveloper.js:86)。cmd 数値 schema 整合はこれまで lock.md にのみ存在したため WEB-0026 へ取り込み (正典は webapi)。

## 契約 / SDK 露出 (grpc / ts / py)

生成 grpc メソッドの jsonFields/optionalScalars 整合と、ts/py SDK の webapi.* シグネチャ整合を registry params に照らして固定する。

### [WEB-0027] grpc-methods.generated: webapi 4 メソッドの jsonFields/optionalScalars 整合
- surface: serve
- backend: cloud
- command: grpc WebapiInvoke/DeviceState/DeviceHistory/SendCmd
- branch: -
- assert: WebapiInvoke の jsonFields=[query,body] / optionalScalars=[query,body,apiKeyId]、deviceHistory の optionalScalars=[page,lg,isBiz,apiKeyId] が registry params と整合する
- ref: packages/kit/src/serve/grpc-methods.generated.json:1708; packages/kit/src/serve/grpc-methods.generated.json:1712; packages/kit/src/serve/grpc-methods.generated.json:1728; packages/kit/src/serve/grpc-methods.generated.json:1736
- kind: contract-existence
- status: planned
- note: 行修正: 旧 refs は "method" 見出し行を指していたため assert が直接参照する配列行へ置換。:1708-1711 WebapiInvoke.jsonFields=[query,body]、:1712-1716 optionalScalars=[query,body,apiKeyId]、:1728-1733 WebapiDeviceHistory.optionalScalars=[page,lg,isBiz,apiKeyId]、:1736 WebapiSendCmd は device.js:196-199/214-219 params と整合。openrpc-contract.test.js / grpc.test.js で生成整合を監査。

### [WEB-0028] sdk(ts): client.webapi.{invoke,deviceState,deviceHistory,sendCmd} のシグネチャ整合
- surface: sdk
- backend: cloud
- command: SesameClient.webapi.*
- branch: -
- assert: ts SDK が webapi.invoke({func,query?,body?,apiKeyId?}) 等 4 メソッドを registry params と一致した型で _call 委譲する
- ref: packages/kit/sdk/ts/sesame-client.ts:617; packages/kit/sdk/ts/sesame-client.ts:619; packages/kit/sdk/ts/sesame-client.ts:621; packages/kit/sdk/ts/sesame-client.ts:623; packages/kit/sdk/ts/sesame-client.ts:625
- kind: surface-parity
- status: planned
- note: 確認済: sesame-client.ts:617 webapi ブロック、:619 deviceHistory({deviceId,page?,lg?,isBiz?,apiKeyId?})、:621 deviceState({deviceId,apiKeyId?})、:623 invoke({func,query?,body?,apiKeyId?})、:625 sendCmd({deviceId,cmd,sign,history,apiKeyId?}) いずれも this._call へ委譲し device.js registry params と一致。sdk-ts-contract.test.js が registry とのシグネチャ整合を検査。

### [WEB-0029] sdk(py): webapi.{invoke,deviceState,deviceHistory,sendCmd} のシグネチャ整合
- surface: sdk
- backend: cloud
- command: SesameClient.webapi.*
- branch: -
- assert: py SDK の _Webapi が invoke(func, query?, body?, apiKeyId?) / deviceState(deviceId, apiKeyId?) / deviceHistory(deviceId, page?, lg?, isBiz?, apiKeyId?) / sendCmd(deviceId, cmd, sign, history, apiKeyId?) の 4 メソッドを _omit_none で None を落として _c._call("webapi.*") へ委譲する
- ref: packages/kit/sdk/python/sesame_client.py:1221; packages/kit/sdk/python/sesame_client.py:1223; packages/kit/sdk/python/sesame_client.py:1215; packages/kit/sdk/python/sesame_client.py:1219; packages/kit/sdk/python/sesame_client.py:1227; packages/kit/sdk/python/sesame_client.py:109
- kind: surface-parity
- status: planned
- note: 修正: メソッド名は camelCase (deviceState/deviceHistory/sendCmd) が実在 (snake_case は不在)。_omit_none(sesame_client.py:109) が optional 省略時にキーをフレームから落とす点が wire 整合の核。sdk-py-contract.test.js 参照。

## cli webapi コマンド

`sesame webapi <func>` の hub 委譲・func 必須 (exit 2)・JSON パース失敗 (exit 2)・--query/--body 既定値 {}・--json 出力分岐を固定する。

### [WEB-0030] cli: `sesame webapi <func>` → hub.invokeWebAPI({func,query,body,apiKeyId})
- surface: cli
- backend: cloud
- command: sesame webapi <func>
- branch: -
- assert: webapi コマンドが func 位置引数と --query/--body(JSON)/--api-key を hub.invokeWebAPI へ委譲する
- ref: packages/kit/src/cli/device.js:324; packages/kit/src/cli/device.js:337; packages/kit/src/cli/device.js:395
- kind: surface-parity
- status: planned
- note: device.js:324 cmdWebapi 本体, :337 hub.invokeWebAPI 委譲, :395 `webapi <func>` 登録 (registerDeviceCommands)。全行確認済み。

### [WEB-0031] cli webapi: func 未指定で exit code 2 (funcRequired)
- surface: cli
- backend: cloud
- command: sesame webapi <func>
- branch: func 引数なし
- assert: func 位置引数欠落は commander.missingArgument 経由で exit 2 になる (errors.js:26 COMMANDER_USAGE_CODES → EXIT.USAGE=2 写像)。die(device.js:325) は到達不能なデッドガードで cli.funcRequired は実機で出ない
- ref: packages/kit/src/cli/device.js:395; packages/kit/src/cli/device.js:325; packages/kit/src/cli/errors.js:26; packages/kit/src/cli/errors.js:18
- kind: error-path
- status: planned
- note: device.js:395 `program.command("webapi <func>")` は <func> 必須位置引数のため func 省略時 commander が action handler (cmdWebapi=device.js:324) を呼ばず commander.missingArgument を throw。cli.js:256-280 が exitOverride を全コマンドへ伝播し commanderErrorInfo→EXIT.USAGE(2) へ写像、errors.js:23-33 COMMANDER_USAGE_CODES に 'commander.missingArgument'(:26) が含まれ exit 2 (EXIT.USAGE=2, errors.js:18)。stderr は "missing required argument 'func'"。よって device.js:325 `if (!func) die(t("cli.funcRequired"),2)` は位置引数経路では到達不能なデッドガード (死んだ防御コード)。実装疑い: 防御コードが死んでいる (任意引数 [func] 化 or 除去を実装側で判断)。終了コード 2 自体は正しい。

### [WEB-0032] cli webapi: --query/--body の不正 JSON で exit code 2
- surface: cli
- backend: cloud
- command: sesame webapi <func>
- branch: --query / --body が不正 JSON
- assert: --query/--body の JSON.parse 失敗を catch し die(t('cli.invalidJsonQueryBody'), 2) を出し終了コード 2 になる
- ref: packages/kit/src/cli/device.js:330; packages/kit/src/cli/device.js:331; packages/kit/src/cli/device.js:332; packages/kit/src/cli/device.js:334; packages/kit/src/i18n/cli.js:183
- kind: error-path
- status: planned
- note: device.js:330 try, :331 query=JSON.parse, :332 body=JSON.parse, :334 catch→die(...invalidJsonQueryBody,2)。i18n キーは cli.js:183(en)/604(ja) に実在。

### [WEB-0033] cli webapi: --query/--body 省略時は {} で hub へ渡る
- surface: cli
- backend: cloud
- command: sesame webapi <func>
- branch: --query/--body 省略
- assert: --query/--body 省略時は query={}, body={} の初期値が hub.invokeWebAPI に渡る (CLI 層既定)
- ref: packages/kit/src/cli/device.js:327; packages/kit/src/cli/device.js:329; packages/kit/src/cli/device.js:337; references_web/src/api/useDeveloper.js:46
- kind: option-branch
- status: planned
- note: device.js:327 `let query={}`, :329 `let body={}`, :337 invokeWebAPI へ。core invokeWebAPI(devices.js:490) が body=body??{} で常時送信、vendor useDeveloper.js:46 (body={} 既定)/:52 (body 送信) と最終 wire 一致。

### [WEB-0034] cli webapi: --json で応答 data を JSON 出力
- surface: cli
- backend: cloud
- command: sesame webapi <func>
- branch: --json
- assert: out(opts.json, humanFn, {data}) が --json 時に {data} を JSON 整形出力し、非 --json 時は humanFn が data を JSON.stringify(data,null,2) 出力する
- ref: packages/kit/src/cli/device.js:338; packages/kit/src/cli/ctx.js:92
- kind: option-branch
- status: planned
- note: 修正: out (ctx.js:92-95) は --json 時 jsonObj={data} を出力し、JSON.stringify(data,null,2) は非 --json の humanFn 分岐 (device.js:338)。元 assert は --json 時 data 直出力としていたが実際は {data} ラップ。

## 監査追補 v2 (dual-audit)

### [WEB-0035] invokeWebAPI: 応答相関キーは op-keyed (biz3InvokeWebAPIs:<func>) で action+op の FIFO 解決
- surface: core
- backend: cloud
- command: devices.invokeWebAPI / transport.request
- branch: 応答相関 (action+op 一致 FIFO)
- assert: invokeWebAPI のリクエスト/応答相関キーが `biz3InvokeWebAPIs:<func>` (action+op、op=func) で生成され、応答が同一 action かつ op=func を echo して初めて 1 件 FIFO 解決する (lock の biz3TriggerLocker:(空 op) と対照に webapi 系は op が必ず func で埋まる)
- ref: packages/core/src/transport.js:262; packages/core/src/transport.js:263; packages/core/src/devices.js:485; references_web/src/api/useDeveloper.js:55
- kind: idempotency
- status: planned
- note: transport.js:262-263 `request(payload){ const key = `${payload.action}:${payload.op || ""}` }`。invokeWebAPI(devices.js:481-493) は op:func (devices.js:485) を載せて request を呼ぶため key=`biz3InvokeWebAPIs:<func>`。vendor は useDeveloper.js:55 `registerCallback(BIZ3_INVOKE_WEBAPI, msgData.op, cb)` で (action,op) 二段相関 (op=func)。lock.md LOCK-0012 (biz3TriggerLocker: 空 op) と対をなす op-keyed 相関の負の対。

### [WEB-0036] cli: webapi 系の CLI 露出は `webapi <func>` 1 本のみ (deviceState/deviceHistory/sendCmd 専用サブコマンド不在)
- surface: cli
- backend: cloud
- command: sesame webapi <func>
- branch: deviceState/deviceHistory/sendCmd の CLI 不在
- assert: CLI が公開する webapi 系は汎用 `sesame webapi <func>` 1 本のみで、webapi.deviceState / deviceHistory / sendCmd に対応する専用 CLI サブコマンドは存在しない (これら 3 ラッパは serve/sdk/core 面のみ)。CLI からは func='webapi_ssm_shadow_get' 等を --query/--body 手組みで invoke 経由で叩く設計境界
- ref: packages/kit/src/cli/device.js:395; packages/kit/sdk/ts/sesame-client.ts:619; packages/kit/sdk/python/sesame_client.py:1215
- kind: surface-parity
- status: planned
- note: registerDeviceCommands (device.js:356-400) に登録される webapi 系は :395 `program.command("webapi <func>")` のみで、deviceState/deviceHistory/sendCmd サブコマンドは皆無。一方 serve は 4 メソッド (device.js:193-253)、ts/py SDK も 4 メソッド (sesame-client.ts:619-625 / sesame_client.py:1215-1227) を公開し面非対称。意図的設計だが serve/sdk 4・cli 1 の負の surface-parity を索引。

### [WEB-0037] serve: requireAuth(daemon) は authState=expired を hub 未接続より前に NOT_AUTHENTICATED で先取り
- surface: serve
- backend: cloud
- command: webapi.invoke / webapi.deviceState / webapi.deviceHistory / webapi.sendCmd
- branch: daemon authState=expired
- assert: requireAuth(daemon) は authState==='expired' のとき (hub.connected の判定より前に) RpcError(kind=NOT_AUTHENTICATED, serve.notAuthenticated) を投げ、webapi.invoke/deviceState/deviceHistory/sendCmd の各 handler 本体に到達しない (CONNECTION_LOST 枝と分岐が割れる)
- ref: packages/kit/src/serve/registry-helpers.js:56; packages/kit/src/serve/registry-helpers.js:57; packages/kit/src/serve/entries/device.js:201; packages/kit/src/serve/entries/device.js:244
- kind: error-path
- status: planned
- note: registry-helpers.js:56-57 requireAuth は authState==='expired' のとき第1段で throw RpcError(serve.notAuthenticated, {kind:NOT_AUTHENTICATED}) を評価し、:59-61 の `!daemon.hub.connected → CONNECTION_LOST` ([[WEB-0022]]) より前に分岐する。webapi 4 handler (device.js:201/210/223/244) は全て先頭で requireAuth(daemon) を呼ぶ。機構の正典は [[SRV-0042]] (registry-helpers の expired/未接続 2 枝) だが、access.md ACC-0056・auth.md AUTH-0103/0130 と同様に per-domain で expired 枝を索引 (WEB-0022 は connection_lost 枝のみ被覆)。

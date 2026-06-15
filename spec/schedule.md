<!-- spec-domain: schedule | prefix: SCH | tests: packages/core/tests/schedule, packages/kit/tests/cli -->

# スケジュール spec (SCH)

schedule.* (スケジュール一覧/取消) を biz3 web (useManageSchedule) に照らして監査する。

## getScheduleList — wire

getScheduleList の送信フレーム形と userId の無加工載せを biz3 web useManageSchedule に照らして固定する。

### [SCH-0001] getScheduleList → biz3Schedule getScheduleList フレーム (flat JSON / action,userId,op)
- surface: core
- backend: cloud
- command: `schedule.getScheduleList`
- branch: -
- assert: 送信フレームが {action:'biz3Schedule', userId:<subUUID>, op:'getScheduleList'} の3キーのみ (obj ラップ無し・companyID/apiKeyId 無し) で、移植元 useManageSchedule.js のリテラル順と一致する
- ref: references_web/src/api/useManageSchedule.js:15-19; packages/core/src/schedule.js:60-64; packages/core/src/vendor/biz3/constants/messageConstants.js:21
- kind: wire-fidelity
- status: planned
- note: action 値は vendor messageConstants BIZ3_SCHEDULE='biz3Schedule' (messageConstants.js:21) から引く。負の証拠: 兄弟 API useManageDevice.js は companyID/obj ラップを使う (useManageDevice.js:220-262) が schedule フレームには一切無い (useManageSchedule.js:15-19 で確認)

### [SCH-0002] getScheduleList userId に subUUID を無加工で載せる
- surface: core
- backend: cloud
- command: `schedule.getScheduleList`
- branch: -
- assert: frame.userId に gStripe.customerInfo.subUUID 相当の生文字列がそのまま入り、大文字化/ハイフン加工/トリム等の変換が一切行われない
- ref: references_web/src/api/useManageSchedule.js:13,17; packages/core/src/schedule.js:62
- kind: wire-fidelity
- status: planned
- note: useManageSchedule.js:13 で subUUID をそのまま取得、:17 で userId に無加工代入。schedule.js:62 も userId:subUUID で変換なし

## getScheduleList — payload

getScheduleList 応答の配列直返しと ScheduleItem フィールド形を web schedule-list UI に照らして固定する。

### [SCH-0003] getScheduleList 応答 data を配列直返し (obj ラップせず)
- surface: core
- backend: cloud
- command: `schedule.getScheduleList`
- branch: data 配列 | data 欠落/非配列
- assert: 応答 message.data が配列ならそのまま ScheduleItem[] を返し、欠落/非配列 (obj ラップ含む) なら [] を返す。移植元は message.data を直接 length/Items に詰める=data 自体が配列である前提
- ref: references_web/src/api/useManageSchedule.js:33-36; packages/core/src/schedule.js:69-70
- kind: payload-fidelity
- status: planned
- note: 移植元 useManageSchedule.js:34-35 が count=message.data.length / Items=message.data と data を配列前提で扱う。schedule.js:70 は Array.isArray ガードで欠落時 [] を返す防御を追加

### [SCH-0004] ScheduleItem フィールド形 (scheduleId/action/displayTime/deviceName)
- surface: core
- backend: cloud
- command: `schedule.getScheduleList`
- branch: -
- assert: 返却 item が scheduleId/action/displayTime/deviceName を保持し、移植元 schedule-list UI が参照するキー名と一致する (action enum lock/unlock/upgrade_firmware は表示用正規化で正式 enum は実機検証要)
- ref: references_web/src/pages/biz/schedule-list/index.js:49,77,78,92; packages/core/src/schedule.js:32-40
- kind: payload-fidelity
- status: planned
- note: キー名パリティは web UI 参照 (index.js:49=scheduleId, :77=action, :78=displayTime, :92=deviceName) と schedule.js:32-40 の ScheduleItem typedef から静的に検証可能・fixture でテスト可。ただし action のサーバ正式 enum 値 (lock/unlock/upgrade_firmware) は web の formatActionText (index.js:7-25) が表示用正規化を被せるため実クラウド往復でしか確定不可 — 当該 enum 値の網羅検証のみ E2E に委ねる

## getScheduleList — error

getScheduleList の事前検証 (subUUID 必須) とサーバ拒否 (success:false) の異常系契約を固定する。

### [SCH-0005] getScheduleList subUUID 欠落で送信せず badRequest
- surface: core
- backend: local
- command: `schedule.getScheduleList`
- branch: subUUID undefined | subUUID 空文字
- assert: subUUID が falsy なら request を一切送らずに同期的に badRequest('schedule.err.subUUIDRequired') を throw する。移植元は subUUID falsy で return (送信中止) する負の挙動と一致
- ref: references_web/src/api/useManageSchedule.js:13-14; packages/core/src/schedule.js:56-57
- kind: error-path
- status: planned
- note: i18n キー schedule.err.subUUIDRequired は packages/core/src/i18n/schedule.js:13,29 に実在。移植元 useManageSchedule.js:14 は falsy で return(送信中止)、schedule.js:57 はそれを badRequest throw に翻訳 (ネットワーク非依存=backend:local)

### [SCH-0006] getScheduleList success:false で rejected throw
- surface: core
- backend: cloud
- command: `schedule.getScheduleList`
- branch: success:false | success 欠落
- assert: 応答に success===false が明示された場合のみ rejected を throw し upstreamCode を resp.code から拾う。success フィールド非在の通常応答は data を返す (success 欠落=正常扱い)
- ref: packages/core/src/schedule.js:66-68; references_web/src/api/useManageSchedule.js:31-41
- kind: error-path
- status: planned
- note: i18n キー schedule.err.getScheduleListFailed は i18n/schedule.js:14,30 に実在。移植元 hook (useManageSchedule.js:31-41 の getScheduleList op 分岐) には success 判定が無く、カタログ独自の防御契約 (local-contract 寄り)。schedule.js:66 は success===false 明示時のみ throw、欠落時は :70 で data 返却

## getScheduleList — idempotency

getScheduleList の応答相関キー (${action}:${op}) を移植元 registerCallback の2段照合に照らして固定する。

### [SCH-0007] getScheduleList の応答相関キー ${action}:${op}
- surface: core
- backend: cloud
- command: `schedule.getScheduleList`
- branch: -
- assert: transport.request が key='biz3Schedule:getScheduleList' で FIFO 相関し、移植元 registerCallback(action, op, cb) の2段照合 (action→op) と同一キーで応答が一致する
- ref: packages/core/src/transport.js:262-263,527; references_web/src/api/useManageSchedule.js:21; references_web/src/hooks/useCallbacks.js:17-20
- kind: idempotency
- status: planned
- note: transport.js:263 が送信側 key=`${action}:${op}`、:527 が受信側 同一 key で queue.shift() の FIFO 解決 (:528-533)。移植元は useManageSchedule.js:21 で registerCallback(BIZ3_SCHEDULE, op, cb)、useCallbacks.js:19-20 が response の {action,op} で 2段照合 — 同一キー構成

## cancelSchedule — wire

cancelSchedule の送信フレーム形を biz3 web useManageSchedule に照らして固定する。

### [SCH-0008] cancelSchedule → biz3Schedule cancelSchedule フレーム (action,userId,scheduleId,op)
- surface: core
- backend: cloud
- command: `schedule.cancelSchedule`
- branch: -
- assert: 送信フレームが {action:'biz3Schedule', userId:<subUUID>, scheduleId:<scheduleId>, op:'cancelSchedule'} の4キーのみ (obj/companyID 無し) で、移植元 useManageSchedule.js のリテラル順 (action, userId, scheduleId, op) と一致する
- ref: references_web/src/api/useManageSchedule.js:54-59; packages/core/src/schedule.js:96-101
- kind: wire-fidelity
- status: planned
- note: 検証済: 両者ともフラット4キー・同順 (action,userId,scheduleId,op)。action は messageConstants.js:21 BIZ3_SCHEDULE='biz3Schedule' 由来。companyID/obj ラップは双方に無し

## cancelSchedule — payload

cancelSchedule の ack=成功 raw 返却を固定する。成功応答 data の具体構造は web に switch ケースが無く E2E 委ね。

### [SCH-0009] cancelSchedule は ack 受信=成功で raw 応答を返す
- surface: core
- backend: cloud
- command: `schedule.cancelSchedule`
- branch: success:false | それ以外 (ack)
- assert: success===false 以外は ack を成功とみなし resp をそのまま返す。移植元 hook には cancelSchedule の応答 switch ケースが無く (handleScheduleResponse は getScheduleList のみ) 完了は cb(ack)/registerCallback 受信のみで判定する
- ref: references_web/src/api/useManageSchedule.js:31-41,60-61; packages/core/src/schedule.js:102-106
- kind: payload-fidelity
- status: waived: cancelSchedule 成功応答 data の具体構造は web に switch ケースが無く (useManageSchedule.js:31-41 は getScheduleList のみ) 実クラウド往復でしか確定不能
- note: 検証済: useManageSchedule.js:31-41 の switch は 'getScheduleList' ケースのみ。60-61 は sendMessage+registerCallback(=ack 購読)。schedule.js:102-106 は request→success:false ガード→return resp の raw 返却

## cancelSchedule — error

cancelSchedule の2段事前検証 (subUUID→scheduleId 必須) とサーバ拒否 (success:false) の異常系契約を固定する。

### [SCH-0010] cancelSchedule subUUID 欠落で送信せず badRequest
- surface: core
- backend: local
- command: `schedule.cancelSchedule`
- branch: subUUID undefined | subUUID 空文字
- assert: subUUID が falsy なら request を送らず badRequest('schedule.err.subUUIDRequired') を throw する。移植元 cancelSchedule の subUUID falsy return (useManageSchedule.js:53) と一致 (送信中止)
- ref: references_web/src/api/useManageSchedule.js:52-53; packages/core/src/schedule.js:92-93
- kind: error-path
- status: planned
- note: 検証済: useManageSchedule.js:52=subUUID 読取, 53='if (!subUUID) return'。schedule.js:92=コメント, 93='if (!subUUID) throw badRequest(...)'。i18n キー schedule.err.subUUIDRequired は i18n/schedule.js:13,29 に実在

### [SCH-0011] cancelSchedule scheduleId 欠落で送信せず badRequest
- surface: core
- backend: local
- command: `schedule.cancelSchedule`
- branch: scheduleId undefined
- assert: scheduleId が falsy なら request を送らず badRequest('schedule.err.scheduleIdRequired') を throw する (subUUID 検証通過後の2段目検証)
- ref: packages/core/src/schedule.js:94; references_web/src/api/useManageSchedule.js:51,57
- kind: error-path
- status: planned
- note: 検証済: schedule.js:94='if (!scheduleId) throw badRequest("schedule.err.scheduleIdRequired")'。i18n キーは i18n/schedule.js:15,31 に実在。移植元は scheduleId を引数 (useManageSchedule.js:51) で受け frame (57) に乗せるのみで必須チェック無し=カタログ側の追加防御 (local-contract 寄り)

### [SCH-0012] cancelSchedule success:false で rejected throw
- surface: core
- backend: cloud
- command: `schedule.cancelSchedule`
- branch: success:false
- assert: 応答 success===false で rejected('schedule.err.cancelScheduleFailed') を throw し upstreamCode を resp.code から拾う (resp?.code ?? null)
- ref: packages/core/src/schedule.js:103-105
- kind: error-path
- status: planned
- note: 検証済: schedule.js:103-105='if (resp && resp.success === false) throw rejected(t("schedule.err.cancelScheduleFailed",{message:...}), {upstreamCode: resp?.code ?? null})'。rejected は util.js:74-76 で code=rejected/retryable=false。i18n キーは i18n/schedule.js:16,32 に実在

## core surface — binding/allowlist

hub.schedule namespace の op allowlist と subUUID 自動注入を core client に照らして固定する。

### [SCH-0013] NAMESPACE_OPS が getScheduleList/cancelSchedule のみを露出
- surface: core
- backend: cloud
- command: `schedule.getScheduleList` / `schedule.cancelSchedule`
- branch: -
- assert: schedule モジュールの NAMESPACE_OPS が ['getScheduleList','cancelSchedule'] のみで、_bindNs がこの allowlist だけを hub.schedule に露出し createSchedule 等を露出しない
- ref: packages/core/src/schedule.js:110; packages/core/src/client.js:341-352,356
- kind: contract-existence
- status: planned
- note: 検証済: schedule.js:110='export const NAMESPACE_OPS = ["getScheduleList", "cancelSchedule"]'。client.js:341-343 が mod.NAMESPACE_OPS を優先選択、346-351 でループ露出、356 が get schedule()。createSchedule/addSchedule は references_web/src 全体に grep ヒット無し (exit 1=負の証拠)

### [SCH-0014] hub.schedule namespace が subUUID を自動注入
- surface: core
- backend: cloud
- command: `schedule.getScheduleList` / `schedule.cancelSchedule`
- branch: subUUID 自動注入 | params で明示上書き
- assert: hub.schedule.getScheduleList() が connect 時の subUUID を既定注入し、params で渡した subUUID が優先される (companyID は schedule では未使用)
- ref: packages/core/src/client.js:333-352,356
- kind: surface-parity
- status: planned
- note: 検証済: client.js:337='const subUUID = this._subUUID', 350='out[name] = (params = {}) => fn(ws, { companyID, subUUID, ...params })' で params が末尾 spread=明示上書き優先。356 が get schedule()。schedule.js は companyID を一切参照しない (未使用)

## cli surface — schedule ls/cancel

sesame schedule ls/cancel の出力フォーマット・経路分岐・終了コードを cli 実装に照らして固定する。

### [SCH-0015] sesame schedule ls 人間出力フォーマット
- surface: cli
- backend: cloud
- command: `sesame schedule ls`
- branch: items 空 | items あり
- assert: items 空なら schedule.ls.none、ありなら schedule.ls.found(count) + 各行 'id\twhen\taction [device]' を出力し、欠落フィールドは (no-id)/(no-time)/? にフォールバックする
- ref: packages/kit/src/cli/schedule.js:25-45; packages/core/src/i18n/schedule.js:5-6
- kind: option-branch
- status: planned

### [SCH-0016] sesame schedule ls --json 封筒 {ok,count,schedules}
- surface: cli
- backend: cloud
- command: `sesame schedule ls --json`
- branch: --json
- assert: --json 時に {ok:true, count:<len>, schedules:<items>} を出力し、human 出力を抑制する。count は配列長 (非配列なら 0)
- ref: packages/kit/src/cli/schedule.js:30,43; packages/kit/src/cli/ctx.js:92-95
- kind: option-branch
- status: planned

### [SCH-0017] sesame schedule cancel 引数 scheduleId 指定経路
- surface: cli
- backend: cloud
- command: `sesame schedule cancel <scheduleId>`
- branch: scheduleId 引数あり
- assert: scheduleId 引数が与えられたら一覧取得/対話をスキップして直接 hub.schedule.cancelSchedule({scheduleId}) を呼び、schedule.cancel.ack を出力する
- ref: packages/kit/src/cli/schedule.js:48-53,73-82
- kind: option-branch
- status: planned

### [SCH-0018] sesame schedule cancel 対話選択経路 (ID 省略 + TTY)
- surface: cli
- backend: cloud
- command: `sesame schedule cancel`
- branch: ID省略+canPrompt | 空一覧 | 選択中断
- assert: ID 省略かつ canPrompt() 時に getScheduleList → selectFromList で選択させ、空一覧は ok:true/count:0 の正常メッセージ (die せず close 保証)、選択中断は schedule.cancel.aborted を stderr に出す
- ref: packages/kit/src/cli/schedule.js:52-72; packages/core/src/i18n/schedule.js:8-10
- kind: option-branch
- status: planned
- note: 空一覧で die しないのは withHub の try/finally close() を飛ばさないため (理由コメント schedule.js:56-57、close 実体 ctx.js:129-134)。未確認: 元 note の index.js:57 は packages/kit/src に index.js が存在せず誤り、正は ctx.js:129-134。

### [SCH-0019] sesame schedule cancel ID 必須 (非対話) で終了コード 2
- surface: cli
- backend: local
- command: `sesame schedule cancel`
- branch: ID省略+非対話/--json
- assert: ID 省略かつ非対話 (TTY 無し or --json) なら ctx.die(schedule.cancel.idRequired, 2) で終了コード 2 を返す
- ref: packages/kit/src/cli/schedule.js:73-76; packages/core/src/i18n/schedule.js:11
- kind: error-path
- status: planned

### [SCH-0020] sesame schedule cancel --json 封筒 {ok,scheduleId,response}
- surface: cli
- backend: cloud
- command: `sesame schedule cancel <scheduleId> --json`
- branch: --json
- assert: --json 時に {ok:true, scheduleId, response:<raw ack>} を出力し、ack=成功という本体設計を断定せず raw を埋め込む
- ref: packages/kit/src/cli/schedule.js:77-82
- kind: option-branch
- status: planned

## serve surface — registry/auth/params/framing

serve デーモンの schedule.* 自動公開・認証ガード・param 形・proto/method・framing 横断封筒を serve 実装に照らして固定する。

### [SCH-0021] serve registry が schedule.* を NAMESPACE_OPS から自動公開
- surface: serve
- backend: cloud
- command: `schedule.getScheduleList` / `schedule.cancelSchedule`
- branch: -
- assert: buildRegistry が NS_MODULES.schedule の NAMESPACE_OPS を走査し 'schedule.getScheduleList'/'schedule.cancelSchedule' を登録、ハンドラが requireAuth 後 hub.schedule[op](p) に委譲する
- ref: packages/kit/src/serve/registry.js:97,288-303; packages/core/src/schedule.js:110
- kind: contract-existence
- status: planned
- note: op 名の真実源は core/src/schedule.js:110 の NAMESPACE_OPS=["getScheduleList","cancelSchedule"]。registry.js:288-303 はこれを走査して ${ns}.${op} を登録 (handler:302 で requireAuth→hub[ns][op](p))。

### [SCH-0022] serve schedule.* の requireAuth ガード (未認証/未接続)
- surface: serve
- backend: cloud
- command: `schedule.getScheduleList` / `schedule.cancelSchedule`
- branch: authState expired | hub 未接続
- assert: NAMESPACE_OPS 自動公開ハンドラが requireAuth(daemon) を先頭で呼び、daemon.authState==='expired' で kind=NOT_AUTHENTICATED、daemon.hub.connected===false で kind=CONNECTION_LOST の RpcError を投げる
- ref: packages/kit/src/serve/registry.js:302; packages/kit/src/serve/registry-helpers.js:55-62
- kind: error-path
- status: planned
- note: 検証済: registry.js:302 の handler が requireAuth(daemon); return hub[ns][op](p)。registry-helpers.js:55-62 の requireAuth が expired→KIND.NOT_AUTHENTICATED / !hub.connected→KIND.CONNECTION_LOST を throw。KIND 定数は packages/core/src/jsonrpc.js:170,173 に実在

### [SCH-0023] serve discover の schedule param 形 (subUUID/scheduleId/timeoutMs)
- surface: serve
- backend: cloud
- command: `rpc.discover (schedule.*)`
- branch: getScheduleList | cancelSchedule
- assert: rpc-params.generated.json の schedule.getScheduleList=[subUUID?,timeoutMs?] / schedule.cancelSchedule=[subUUID?,scheduleId?,timeoutMs?] が core 関数シグネチャと一致し subUUID は daemon 自動注入注記を持つ
- ref: packages/kit/src/serve/rpc-params.generated.json:2-47; packages/core/src/schedule.js:55,91
- kind: contract-existence
- status: planned
- note: 行番号修正: cancelSchedule ブロックの閉じ ] は 47 行目 (元 2-45 は途中で切れていた)。getScheduleList は 2-20 (閉じ ] は 20 行目、:19 は内側 schema の })、cancelSchedule は 21-47。subUUID 自動注入注記は :10,:29 の desc に実在。core schedule.js:55 getScheduleList({subUUID,timeoutMs})/ :91 cancelSchedule({subUUID,scheduleId,timeoutMs}) と一致

### [SCH-0024] serve gRPC proto/method の schedule 契約
- surface: serve
- backend: cloud
- command: `ScheduleGetScheduleList` / `ScheduleCancelSchedule`
- branch: getScheduleList | cancelSchedule
- assert: sesame.proto の ScheduleGetScheduleListRequest{subUUID?,timeoutMs?} / ScheduleCancelScheduleRequest{subUUID?,scheduleId?,timeoutMs?} と grpc-methods.generated.json の method 名/optionalScalars が core param と 1:1 一致 (experimental 表記)
- ref: packages/kit/src/serve/sesame.proto:11,13,422-429; packages/kit/src/serve/grpc-methods.generated.json:7-23
- kind: contract-existence
- status: planned
- note: 検証済: proto:11,13 が rpc 宣言 (直前 :10,:12 が // experimental (unverified))、:422-425 が GetScheduleListRequest{optional string subUUID=1; optional double timeoutMs=2}、:426-429 が CancelScheduleRequest{subUUID,scheduleId,timeoutMs}。grpc-methods :7-14 ScheduleGetScheduleList(optionalScalars[subUUID,timeoutMs]) / :15-23 ScheduleCancelSchedule(optionalScalars[subUUID,scheduleId,timeoutMs]) で 1:1 一致

### [SCH-0025] serve 全 framing で schedule.* が同一封筒
- surface: serve
- backend: cloud
- command: `schedule.getScheduleList` / `schedule.cancelSchedule`
- branch: ws | ndjson | stdio | http | grpc | socket
- assert: 同一 schedule.* RPC が各 framing (ws/ndjson/stdio/http/grpc/socket) を通じて同じ JSON-RPC result 封筒を返す (framing 非依存の surface-parity)
- ref: packages/kit/src/serve/registry.js:297-303
- kind: surface-parity
- status: waived: 全 framing 横断の封筒一致は serve デーモン実起動+実クラウド応答が要るため E2E でのみ検証可能
- note: 検証済: registry.js:297-303 は全 framing が共有する単一レジストリの handler 定義 (framing 非依存)。branch の 6 framing は packages/kit/src/serve/framing/{ws,ndjson,stdio,http,grpc,socket}.js として実在。封筒一致の実証は実 daemon+実クラウド往復を要し waived が妥当

## sdk surface — ts/py メソッド

生成 SDK (ts/py) の schedule メソッド契約と py _omit_none の欠落除去を SDK 実装に照らして固定する。

### [SCH-0026] SDK ts/py の schedule メソッド契約
- surface: sdk
- backend: cloud
- command: `schedule.getScheduleList` / `schedule.cancelSchedule`
- branch: ts | py
- assert: 生成 SDK が ts schedule.getScheduleList({subUUID?,timeoutMs?})/cancelSchedule({subUUID?,scheduleId?,timeoutMs?}) と py _Schedule.getScheduleList/cancelSchedule (_omit_none) を持ち method 文字列 'schedule.<op>' で _call する
- ref: packages/kit/sdk/ts/sesame-client.ts:610-615; packages/kit/sdk/python/sesame_client.py:1196-1206,1255
- kind: contract-existence
- status: planned
- note: 検証済: ts:610-615 schedule block (cancelSchedule:612 / getScheduleList:614 が this._call('schedule.<op>', params))。py:1196-1206 _Schedule (cancelSchedule:1200-1202 / getScheduleList:1204-1206 が _call('schedule.<op>', _omit_none(...)))、:1255 self.schedule=_Schedule(self)。param 形は assert 通り

### [SCH-0027] SDK py _omit_none が未指定パラメータを送らない
- surface: sdk
- backend: cloud
- command: `schedule.getScheduleList` / `schedule.cancelSchedule`
- branch: subUUID 省略 | scheduleId 省略
- assert: py SDK が None のパラメータを _omit_none で payload から除去し、subUUID/scheduleId/timeoutMs の欠落は送出 JSON に現れない (daemon 自動注入を阻害しない)
- ref: packages/kit/sdk/python/sesame_client.py:1200-1206,109
- kind: contract-existence
- status: planned
- note: 検証済: :1200-1206 の cancelSchedule/getScheduleList が _omit_none({...}) で None を除去。_omit_none の定義実体を refs に追加 (sesame_client.py:109 def _omit_none)。これにより assert の『欠落は送出 JSON に現れない』を支える出典が完備

## surface parity — 作成 op の不在 (負の証拠)

createSchedule 等の作成系 op が全 surface・移植元に存在しないことを敵対的 grep で固定する。

### [SCH-0028] createSchedule 等の作成 op が全 surface に存在しない (負の証拠)
- surface: core, serve, sdk, cli
- backend: cloud
- command: `schedule.* (作成系の不在)`
- branch: -
- assert: NAMESPACE_OPS/registry/proto/SDK/CLI のいずれにも createSchedule/addSchedule が存在せず、移植元 references_web 全体にも grep ヒットしない (登録 op は biz3 web 由来でない)
- ref: packages/core/src/schedule.js:11-12,110; references_web/src/api/useManageSchedule.js:1-71
- kind: surface-parity
- status: planned
- note: 検証済 (敵対的 grep): packages/ + references_web/ 全体で createSchedule/addSchedule は schedule.js:10 のコメント文以外ヒット 0。schedule.js:110 NAMESPACE_OPS=['getScheduleList','cancelSchedule'] のみ。useManageSchedule.js(全71行) も getScheduleList/cancelSchedule の 2 op のみ。CLI(cli/schedule.js) も ls/cancel のみで作成サブコマンド無し。負の証拠は成立

## i18n

schedule i18n カタログの en/ja 完全性 (14キー集合一致) と AREAS 登録を i18n 実装に照らして固定する。

### [SCH-0029] schedule i18n カタログの en/ja 完全性
- surface: cli, core
- backend: local
- command: `schedule.* メッセージ`
- branch: en | ja
- assert: schedule i18n カタログの en/ja キー集合一致(14=14)・{var}一致・AREAS 登録。重複につき [[I18N-0001]] を正典
- ref: local-contract
- kind: i18n
- status: waived: 重複（正典 [[I18N-0001]]）
- note: 正典: spec/i18n.md の I18N-0001 (en/ja キー集合一致, assert に schedule を明示包含・AREAS=12 area 全件走査) / I18N-0006 ({var} プレースホルダ一致) / I18N-0008 (t() リテラル網羅)。schedule 部分集合は I18N ドメインに完全包含されるため schedule.md からは正典委譲。残る盲点 (ja 4 キーが en と同一英文=未訳: i18n/schedule.js:21/22/24/28 が en:5/6/8/12 と同値) はキー集合検証では検出不能だが、値訳出 (ja!=en) の検証は横断関心のため I18N ドメインへ value-translation 観点として委ねる (本 ID では追わない)。実装疑い: ja ロケール 4 キー未訳 (別タスクで I18N に value-translation 検証を追加)

## 監査追補 v2 (dual-audit)

dual-audit 所見 (人間裁定済) を反映した追補エントリ。

### [SCH-0030] getScheduleList/cancelSchedule の応答タイムアウト error-path (transport timeoutErr / code=TRANSPORT_TIMEOUT が素通り伝播)
- surface: core
- backend: cloud
- command: `schedule.getScheduleList` / `schedule.cancelSchedule`
- branch: 応答到達(success判定) | 応答無し(timeoutMs経過 / 既定 DEFAULT_TIMEOUT_MS=10_000)
- assert: 応答が timeoutMs (既定 DEFAULT_TIMEOUT_MS=10_000) 内に到達しない場合、transport.request の setTimeout が pending を解除し timeoutErr(code='TRANSPORT_TIMEOUT') で reject、schedule.js / client._bindNs は try/catch 無しでそのまま呼び出し元へ伝播する。subUUID/scheduleId badRequest (送信前同期 throw) や success:false (rejected) とは別の、送信後非同期の無応答異常系
- ref: packages/core/src/schedule.js:30,65,102; packages/core/src/transport.js:262-263,271-274,73,79; packages/core/src/client.js:350
- kind: error-path
- status: planned
- note: schedule.js:30 が DEFAULT_TIMEOUT_MS=10_000 を定義、:55/:91 シグネチャで {timeoutMs=DEFAULT_TIMEOUT_MS} 既定化、:65/:102 で client.request(frame, timeoutMs) に透過。transport.js:271-274 が setTimeout 満了で timeoutErr を reject、:79 で e.code=TRANSPORT_ERR.TIMEOUT (:73='TRANSPORT_TIMEOUT')。schedule.js も client.js:350 _bindNs も catch/wrap が無いため raw timeout error が公開面に伝播。移植元 useManageSchedule.js は registerCallback のみで timeout を持たない=カタログ独自の防御契約 (local-contract 寄り)。peer biz3-WS ドメインは同経路を明示固定 (spec/org.md ORG-0010, spec/access.md ACC-0006, spec/payment.md PAY-0024)。CLI 側 TIMEOUT→exit1 写像は cli.md CLI-0011 が汎用カバー済み

### [SCH-0031] cancelSchedule の応答相関キー biz3Schedule:cancelSchedule と scheduleId 非相関 (FIFO のみ・負の証拠)
- surface: core
- backend: cloud
- command: `schedule.cancelSchedule`
- branch: 単発 | 同一 op 並行2件 (FIFO 解決)
- assert: cancelSchedule の transport.request が key='biz3Schedule:cancelSchedule' で FIFO 相関し、scheduleId による相関は一切行われない (移植元 useManageSchedule.js は registerCallback(action,op,cb) と useCallbacks の {action,op} 2段照合のみで scheduleId を相関キーに含めない) ため、並行する2件の cancelSchedule は送信順に queue.shift() で解決される
- ref: packages/core/src/transport.js:262-263,527,530-531; references_web/src/api/useManageSchedule.js:54-61; references_web/src/hooks/useCallbacks.js:17-20; packages/core/src/schedule.js:96-102
- kind: idempotency
- status: planned
- note: transport.js:263 が送信側 key=`${payload.action}:${payload.op||''}`、:527 が受信側 同一 key、:530-531 が queue.shift() で FIFO 解決 (scheduleId 非参照)。移植元 useManageSchedule.js:55-58 のフレームは scheduleId を載せるが :61 registerCallback(BIZ3_SCHEDULE,'cancelSchedule',cb) は action+op のみ登録、useCallbacks.js:19-20 invokeCallbacks も response の {action,op} のみで dispatch=scheduleId 非相関。schedule.js:96-102 も scheduleId を frame 同梱のみで相関未使用。SCH-0007 は getScheduleList op に限定され cancel 側の相関キー/scheduleId 非相関の負の事実は未被覆=補完。負の証拠『scheduleId は相関に使われない』は cancel で特に重要 (同一 op 並行時の取り違えリスク)

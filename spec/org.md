<!-- spec-domain: org | prefix: ORG | tests: packages/core/tests/org, packages/kit/tests/cli -->

# 組織管理 spec (ORG)

org.* (従業員・従業員グループ・タグ・デバイスグループ・鍵共有・ゲスト QR・CS問合せ) を biz3 web (useManageEmployee/useManageGroup) に照らして監査する。

## employee.getEmployees

### [ORG-0001] getEmployees 送信フレーム {action:'biz3ManageEmployee',companyID,op:'get'} が biz3 と一致
- surface: core, serve, sdk, cli
- backend: cloud
- command: `org.getEmployees` / `sesame org employee ls`
- branch: -
- assert: client.send するフレームのキー集合と値が {action:ACTION_TYPES.BIZ3_MANAGE_EMPLOYEE, companyID, op:'get'} で、companyID はトップレベル直置き (items/obj ラップ無し) であること
- ref: references_web/src/api/useManageEmployee.js:18-22; packages/core/src/org.js:79; packages/core/src/vendor/biz3/constants/messageConstants.js:6
- kind: wire-fidelity
- status: planned
- note: WS frame = JS オブジェクト passthrough (references_web/src/websocket/WebSocketManager.ts:383 this.ws.send(JSON.stringify(message)))。全ref行番号確認済

### [ORG-0002] getEmployees は pubEmployees push を購読し page chunk を集約する
- surface: core
- backend: cloud
- command: `org.getEmployees`
- branch: page===1 全置換 | page>1 追記
- assert: 送信 op='get' に対し別 op 'pubEmployees' を subscribe し、chunk 形 {totalCount, data:{list,page}} を parse、page===1 で acc 全置換・page>1 で追記する蓄積規則が biz3 と一致
- ref: references_web/src/api/useManageEmployee.js:7; references_web/src/api/useManageEmployee.js:70-88; packages/core/src/org.js:83-87; packages/core/src/org.js:830-831
- kind: wire-fidelity
- status: planned
- note: send op と push op が異なるため request では待てず subscribe 必須。蓄積規則 (page===1 全置換 else 追記) は org.js:830-831 (appendOnly=false 枝) に実装。vendor は useManageEmployee.js:75-87

### [ORG-0003] getEmployees 完了判定: 蓄積件数 >= totalCount で resolve
- surface: core
- backend: cloud
- command: `org.getEmployees`
- branch: totalCount=0 即完了 | 複数 page
- assert: acc.length>=chunk.totalCount で finish() し {count:totalCount, list} を返す。totalCount=0 の単一 push でも即完了する
- ref: references_web/src/api/useManageEmployee.js:71-88; packages/core/src/org.js:838-840; packages/core/src/org.js:813
- kind: idempotency
- status: planned
- note: chunk 再来時の二重解決ガードは subscribeChunks 側 (util.js:136-142 done ガード)。完了判定 acc.length>=totalCount は org.js:838-840、戻り {count,list} 組立は org.js:813

### [ORG-0004] getEmployees partialOnTimeout=true は timeout で reject せず {partial:true,count,list} を返す
- surface: core, sdk
- backend: cloud
- command: `org.getEmployees`
- branch: partialOnTimeout=false(既定) reject | true partial-resolve
- assert: partialOnTimeout=true 指定時、timeout でも蓄積済み chunk を {partial:true,count,list} で resolve し、完走時は {partial:false,...} 同 shape。既定(false)は timeout で reject
- ref: references_web/src/api/useManageEmployee.js:70-88; packages/core/src/org.js:74-88; packages/core/src/org.js:807-814; packages/core/src/util.js:143-155
- kind: option-branch
- status: planned
- note: BIZ-14 オプトイン。完走時 {partial:false,count,list} の shape 組立は org.js:807-814 (result()); timeout 時 {...result(),partial:true} は util.js:147-152。参照 UI は page push のたび表示反映=部分結果が残る挙動を再現 (useManageEmployee.js:70-88)

### [ORG-0005] getEmployees: pubEmployees chunk の success:false で reject (rejected)
- surface: core, serve
- backend: cloud
- command: `org.getEmployees`
- branch: chunk success:false | action success:false (即時エラー) | 別 op の success:false→op-相関ガードで無視
- assert: push chunk の success===false で code=rejected/retryable=false の SesameError を投げる。同 action の即時 success:false 応答 (errorAction, org.js:803 で collectChunks へ errorAction:action を渡す経路) も timeout を待たず失敗確定する。さらに errorAction は op-相関ガード (util.js:180 `if (ownOp !== null && msg.op !== undefined && msg.op !== ownOp) return;`) により sendFrame.op 系列でない別 op の success:false 応答を無視し、serve 並行 RPC 環境で別 op の失敗が誤 reject を起こさないこと
- ref: references_web/src/api/useManageEmployee.js:400-404; references_web/src/api/useManageDevice.js:27-34; packages/core/src/org.js:803; packages/core/src/org.js:818-823; packages/core/src/util.js:172-186
- kind: error-path
- status: planned
- note: 未確認(修正): 旧ref useManageEmployee.js:405-412 は queryByCS の handleChunk paging 部で success:false 検査(:401)を含まず、かつ pubEmployees ではなく pubQueryByCS の枝。pubEmployees 自体(:70-88)に chunk success:false 検査は vendor に無い。chunk 単位 success:false の vendor 先例は queryByCS handleChunk :400-404(if res?.success===false)、action 単位即時エラーの先例は useManageDevice.js:27-34(if !message.success)。kit は前者を pubEmployees にも適用(org.js:818-823 → util.rejected)、後者を errorAction(util.js:172-186)として実装。dual-audit 統合: A・B が同一の共有 errorAction 境界 util.js:172-186 を org.js:803 経由で独立に未被覆と指摘 (consensus)。人間裁定で ORG-0005 拡張を採用し op-相関ガード (util.js:180, 誤 reject 防止) を assert/branch に明示。queryByCS 側 errorAction も同経路を共有 ([[ORG-0026]] 参照)

### [ORG-0006] getEmployees: companyID 欠落で bad_request
- surface: core, serve, cli
- backend: local
- command: `org.getEmployees` / `sesame org employee ls`
- branch: companyID 欠落
- assert: companyID 未指定で badRequest('org.req.companyID') (code=bad_request, retryable=false) を throw し send しない。serve は INVALID_PARAMS/kind=bad_params へ、CLI は withAccount が実 companyID を注入する
- ref: packages/core/src/org.js:75; packages/core/src/util.js:54-56; packages/core/src/jsonrpc.js:209-213; packages/kit/src/cli/org.js:46-49
- kind: error-path
- status: planned
- note: CLI は refreshAccount() で companyID を自動注入するため実質 cloud 必須は serve/core 直呼び (cli/org.js:9-17,46-49 withAccount)。serve 写像 INVALID_PARAMS/bad_params の根拠は jsonrpc.js:213 SESAME_TO_RPC[ERR.BAD_REQUEST] (旧 ref に欠落していたため追加)。i18n キー org.req.companyID は i18n/org.js:8 に実在

### [ORG-0007] getEmployees 露出パリティ (core/serve registry/sdk ts+py/cli ls)
- surface: core, serve, sdk, cli
- backend: cloud
- command: `org.getEmployees` / `sesame org employee ls`
- branch: core 直 | serve registry | sdk ts | sdk py
- assert: 同一 op が registry に 'org.getEmployees' として 1:1 で在り (NAMESPACE_OPS 自動公開 handler=hub.org.getEmployees, requireAuth gating)、ts/py SDK・grpc-methods.generated・rpc-params.generated・CLI ls の全面で同名・同 params で露出する
- ref: packages/kit/src/serve/registry.js:288-305; packages/kit/sdk/ts/sesame-client.ts:541; packages/kit/sdk/python/sesame_client.py:1061; packages/kit/src/serve/grpc-methods.generated.json:25; packages/kit/src/serve/rpc-params.generated.json:48; packages/core/src/org.js:848-859
- kind: surface-parity
- status: planned
- note: registry はハードコードではなく NS_MODULES(registry.js:97 に org 含む)を NAMESPACE_OPS(org.js:848-859) でループ自動公開し handler=hub[ns][op](p)+requireAuth(daemon)(registry.js:302)。grpc/rpc 生成物の org.getEmployees 実在を確認したため refs に追加 (旧 ref には grpc-methods/rpc-params が assert に登場しつつ欠落)

## employee.getCurrentUserInfo

### [ORG-0008] getCurrentUserInfo 送信フレーム {action,op:'currentInfo'} (companyID/items 無し)
- surface: core, serve, sdk, cli
- backend: cloud
- command: `org.getCurrentUserInfo` / `sesame org employee me`
- branch: -
- assert: フレームが {action:BIZ3_MANAGE_EMPLOYEE, op:'currentInfo'} のみで companyID/items/obj を一切含まないこと (引数なし op)
- ref: references_web/src/api/useManageEmployee.js:187-197; packages/core/src/org.js:100
- kind: wire-fidelity
- status: planned

### [ORG-0009] getCurrentUserInfo は同期応答 (currentInfo) を request で 1 件待つ
- surface: core
- backend: cloud
- command: `org.getCurrentUserInfo`
- branch: -
- assert: send op と push op が一致する currentInfo は registerCallback(action,'currentInfo') 相当 = client.request(action+op 一致を 1 件待つ) で受信し、応答本体は res.data を返す
- ref: references_web/src/api/useManageEmployee.js:187-197; references_web/src/components/MobileMeIndex.js:58-61; packages/core/src/org.js:100-102
- kind: wire-fidelity
- status: planned
- note: vendor は無条件 res.data を読む (MobileMeIndex.js:60 setCurrentUserInfo(res.data))

### [ORG-0010] getCurrentUserInfo 応答 success:false / timeout の error-path
- surface: core, serve
- backend: cloud
- command: `org.getCurrentUserInfo`
- branch: upstream success:false | timeout
- assert: assertSuccess で success===false なら SesameError(code=rejected, retryable=false) を throw。応答無しは plain client.request 経路のため transport の timeoutErr (CodedError, code=TRANSPORT_TIMEOUT) で reject されること
- ref: packages/core/src/org.js:100-102; packages/core/src/util.js:34-43; packages/core/src/transport.js:271-273; packages/core/src/transport.js:79
- kind: error-path
- status: planned
- note: 未確認(修正): 元 assert の『timeoutError(retryable=true) を throw』は支持されず。getCurrentUserInfo は subscribeChunks 経路でなく client.request 直呼びのため、core util.js:63 timeoutError(retryable=true) ではなく transport.js:79 timeoutErr(code=TRANSPORT_TIMEOUT, retryable 属性なし)で reject される。util timeoutError は org.js:799 等の集約 onTimeout のみで使用

## employee.addEmployees

### [ORG-0011] addEmployees 送信フレーム {action,items,op:'add'} (items 直置き, companyID は item 内)
- surface: core, serve, sdk, cli
- backend: cloud
- command: `org.addEmployees` / `sesame org employee add`
- branch: -
- assert: items をトップレベルに直置きし companyID は各 item 内に含めること (トップレベル companyID 無し)。item 形 {employeeEmail,employeeName,phone,department,tag:[...],companyID} が AddEmployee.js submit body と一致
- ref: references_web/src/api/useManageEmployee.js:263-274; references_web/src/components/biz/device/AddEmployee.js:63-71; packages/core/src/org.js:119
- kind: wire-fidelity
- status: planned
- note: 空 phone/department は undefined (AddEmployee.js:67-68)、tag はタグ名文字列配列 (AddEmployee.js:345-360)

### [ORG-0012] addEmployees: items 非配列で bad_request
- surface: core, serve, cli
- backend: local
- command: `org.addEmployees` / `sesame org employee add`
- branch: items 非配列 | --json 非配列
- assert: Array.isArray(items)===false で badRequest('org.req.itemsArray') を throw。CLI は --json/--friend-qr 双方未指定で exit 2、--json 非配列で org.err.jsonArray exit 2
- ref: packages/core/src/org.js:118; packages/kit/src/cli/org.js:101-108
- kind: error-path
- status: planned

### [ORG-0013] addEmployees: 'Limit Exceeded' 応答を rejected として throw
- surface: core, serve
- backend: cloud
- command: `org.addEmployees`
- branch: success:false message='Limit Exceeded' | その他 success:false
- assert: 応答 success:false (message='Limit Exceeded' プラン上限) で assertSuccess が rejected を throw し、message が封筒に伝播すること
- ref: references_web/src/api/useManageEmployee.js:89-100; packages/core/src/org.js:120
- kind: error-path
- status: planned

### [ORG-0014] CLI add --friend-qr はフレンド QR を解析し items=[{friendID,companyID}] を合成
- surface: cli
- backend: cloud
- command: `sesame org employee add --friend-qr <url>`
- branch: --friend-qr | --json | 双方未指定
- assert: --friend-qr <ssm://UI/?t=friend&friend=…> を parseFriendQrUrl で解析し items=[{friendID,companyID}] を合成する経路が AddEmployee.js sendParam (readUserQrcode→{...userInfo,companyID}) と一致。無効 URL は exit 2
- ref: references_web/src/components/biz/device/AddEmployee.js:402-406; references_web/src/utils/biz3utils.js:152-158; packages/kit/src/cli/org.js:88-100
- kind: option-branch
- status: planned
- note: 未確認(修正): 元 ref AddEmployee.js:63-71 は通常フォームの handleSubmit body であり friend-QR 経路を支持しない。実際の sendParam 合成は AddEmployee.js:402-406 (readUserQrcode コールバック内 {...userInfo, companyID} → submit([sendParam]))。userInfo.friendID は biz3utils.js:158 で friendUUID.toLowerCase()。CLI org.js:89-99 のコメントも AddEmployee.js:386-410/sendParam を参照

### [ORG-0015] CLI add は各 item へ companyID を後置補完 (有効値が勝つ)
- surface: cli
- backend: cloud
- command: `sesame org employee add --json <items>`
- branch: item に companyID あり | 空/null
- assert: items.map で {...it, companyID: it.companyID || hub.config.companyID} を後置し、item 内の空文字/null より有効な実 companyID が必ず勝つこと
- ref: packages/kit/src/cli/org.js:112; references_web/src/components/biz/device/AddEmployee.js:69-70
- kind: option-branch
- status: planned
- note: 確認済: cli/org.js:112 は `items.map((it) => ({ ...it, companyID: it.companyID || hub.config.companyID }))` で後置補完・|| で空/null を実値が上書き。AddEmployee.js:70 は per-item body に `companyID: gStripe.customerInfo.companyID` を入れる biz3 規範を裏付け (line 69=`tag: tagItems,`, 70=companyID)。

## employee.updateEmployee

### [ORG-0016] updateEmployee 送信フレーム obj:{companyID,...data} ラップ op:'update'
- surface: core, serve, sdk, cli
- backend: cloud
- command: `org.updateEmployee` / `sesame org employee update`
- branch: -
- assert: update のみ obj:{companyID,...data} でラップする (他 op の直置き/items とは異なる) 唯一のネスト差異を再現し、data は更新フィールド {Name,Value} 形が postEmployeeInfo と一致
- ref: references_web/src/api/useManageEmployee.js:169-185; packages/core/src/org.js:134-137
- kind: wire-fidelity
- status: planned
- note: 確認済: useManageEmployee.js:173-180 postEmployeeInfo が `obj:{companyID,...data}, op:'update'` を構築 (msgData range 169-185)。core/org.js:134-137 が同形を request。

### [ORG-0017] updateEmployee: companyID 欠落で bad_request
- surface: core, serve
- backend: local
- command: `org.updateEmployee`
- branch: companyID 欠落
- assert: companyID 未指定で badRequest('org.req.companyID') を throw し send しないこと
- ref: packages/core/src/org.js:133; packages/core/src/util.js:54-56
- kind: error-path
- status: planned
- note: 確認済: core/org.js:133 `if (!companyID) throw badRequest("org.req.companyID");`。util.js:54-56 badRequest が SesameError(code=BAD_REQUEST, retryable:false) を返す。

## employee.removeEmployees

### [ORG-0018] removeEmployees 送信フレーム {action,items,op:'delete'} (items 直置き)
- surface: core, serve, sdk, cli
- backend: cloud
- command: `org.removeEmployees` / `sesame org employee rm`
- branch: -
- assert: items をトップレベル直置きし op:'delete'。items は社員オブジェクト配列または [{subUUID,companyID}] (トップレベル companyID 無し) が biz3 と一致
- ref: references_web/src/api/useManageEmployee.js:199-210; packages/core/src/org.js:153
- kind: wire-fidelity
- status: planned
- note: 確認済: useManageEmployee.js:199-210 removeEmployees が `{action, items, op:'delete'}` を items 直置きで構築 (トップレベル companyID 無し)。core/org.js:153 同形 request。

### [ORG-0019] removeEmployees: items 非配列で bad_request
- surface: core, cli
- backend: local
- command: `org.removeEmployees` / `sesame org employee rm`
- branch: items 非配列 | --json 欠落/非配列
- assert: Array.isArray(items)===false で badRequest('org.req.itemsArray')。CLI は --json 欠落で exit 2、非配列で org.err.jsonArray exit 2
- ref: packages/core/src/org.js:152; packages/kit/src/cli/org.js:145-151
- kind: error-path
- status: planned
- note: 確認済: core/org.js:152 `if (!Array.isArray(items)) throw badRequest("org.req.itemsArray");`。cli/org.js:145-148 `--json` 欠落で ctx.die(...rm.need,2)、:151 非配列で ctx.die(t("org.err.jsonArray"),2)。両 exit 2 一致。

## employee.reorderEmployees

### [ORG-0020] reorderEmployees 送信フレーム {action,items,op:'order'} 各要素 {friendUUID,rank}
- surface: core, serve, sdk, cli
- backend: cloud
- command: `org.reorderEmployees` / `sesame org employee reorder`
- branch: -
- assert: op:'order' で items 直置き、各要素 {friendUUID(=社員 subUUID), rank}、rank=-index (降順負値) が MobileContacts.js reorderEmployees と一致
- ref: references_web/src/api/useManageEmployee.js:276-287; references_web/src/components/MobileContacts.js:94-98; packages/core/src/org.js:170
- kind: wire-fidelity
- status: planned
- note: 確認済: useManageEmployee.js:276-287 reorderEmployees が `{action, items, op:'order'}`。MobileContacts.js:94-98 `newData.map((item,index)=>({friendUUID:item.subUUID, rank:-index}))` で friendUUID=subUUID・rank=-index を裏付け。core/org.js:170 同形 request。handleEmployee に order case 無く応答 no-op のため ack を待つだけ (request)。

### [ORG-0021] reorderEmployees: items 非配列で bad_request
- surface: core, cli
- backend: local
- command: `org.reorderEmployees` / `sesame org employee reorder`
- branch: items 非配列 | --json 欠落/非配列
- assert: Array.isArray(items)===false で badRequest('org.req.itemsArray')。CLI は --json 欠落で exit 2、非配列で org.err.jsonArray exit 2
- ref: packages/core/src/org.js:169; packages/kit/src/cli/org.js:164-171
- kind: error-path
- status: planned
- note: 確認済: core/org.js:169 `if (!Array.isArray(items)) throw badRequest("org.req.itemsArray");`。cli/org.js:165-168 `--json` 欠落で ctx.die(...reorder.need,2)、:171 非配列で ctx.die(t("org.err.jsonArray"),2)。両 exit 2 一致。

## employee.queryByCS

### [ORG-0022] queryByCS 送信 op='queryByCS' / 購読 op='pubQueryByCS' のクロス
- surface: core, serve, sdk, cli
- backend: cloud
- command: `org.queryByCS` / `sesame org employee search`
- branch: -
- assert: 送信フレームは {action,keyword,op:'queryByCS'} だが応答は別 op 'pubQueryByCS' を subscribe して受ける (send op≠push op) こと
- ref: references_web/src/api/useManageEmployee.js:391-416; packages/core/src/org.js:194-195
- kind: wire-fidelity
- status: planned
- note: 検証済: send 'queryByCS' (useManageEmployee.js:397/414), subscribe 'pubQueryByCS' (:411,415)。org.js:194 pubOp='pubQueryByCS', :195 sendFrame {action,keyword,op:'queryByCS'}。surface 全面 OK: cli/org.js:180-184 employee search→hub.org.queryByCS、serve grpc-methods.generated.json:78 org.queryByCS、sdk ts:547/py:1073

### [ORG-0023] queryByCS は page===totalPage まで集約・常に追記 (appendOnly)
- surface: core
- backend: cloud
- command: `org.queryByCS`
- branch: page<totalPage 継続 | page===totalPage 完了
- assert: chunk 形 res.data={data:{list,page},totalPage} を parse、page===1 でも置換せず常に追記 (rowDatas=[...rowDatas,...list])、page===totalPage で完了する appendOnly 規則が biz3 と一致
- ref: references_web/src/api/useManageEmployee.js:405-412; packages/core/src/org.js:199-214; packages/core/src/org.js:826-831
- kind: idempotency
- status: planned
- note: 検証済: biz3 :407 rowDatas=[...rowDatas,...list] (page 分岐なしの常時追記), :408 page===totalPage で完了。org.js:201 appendOnly:true, :203-214 parseChunk。蓄積分岐の実体は org.js:826-831 (旧 ref :830-831 を :826-831 に拡張し pubEmployees(page===1置換) との差を含めた)。pubEmployees の置換規則とは異なる分岐。リグレッションガード対象

### [ORG-0024] queryByCS totalPage 欠落時は補完せず timeout に倒す (安全側)
- surface: core
- backend: cloud
- command: `org.queryByCS`
- branch: totalPage あり | totalPage 欠落(undefined)
- assert: parseChunk が totalPage を ?? 1 補完せず undefined のまま返し、page===totalPage が成立しないため完了せず timeout する (静かな切り詰め防止)
- ref: references_web/src/api/useManageEmployee.js:405-412; packages/core/src/org.js:209-213; packages/core/src/org.js:836-841
- kind: error-path
- status: planned
- note: 検証済: org.js:212 totalPage: top.totalPage (?? 1 なし), :209-211 安全側コメント。完了判定の実体 org.js:836-841 (typeof totalPage==='number' のときのみ page>=totalPage で finish、欠落時は timeout 待ち) を補強 ref に追加。biz3 :408 も page===totalPage 不成立時は完了しない。P3-9 安全側設計

### [ORG-0025] queryByCS partialOnTimeout=true で {partial,list} object に shape 切替
- surface: core, sdk
- backend: cloud
- command: `org.queryByCS`
- branch: partialOnTimeout=false 配列戻り | true {partial,list} object
- assert: 既定は配列 list を返すが partialOnTimeout=true 指定時は returnListOnly でも shape を {partial,list} object に揃える (subscribeChunks の spread 契約で配列を返せないため)
- ref: packages/core/src/org.js:190-198; packages/core/src/org.js:807-814; packages/core/src/util.js:147-153
- kind: option-branch
- status: planned
- note: ref 修正: shape 切替の load-bearing 実体は org.js:807-814 (result(): partialOnTimeout 時 returnListOnly でも {partial:false,list:acc} を返す) なので主出典に追加。旧 ref org.js:180-215 は queryByCS 呼出側の opt-in 部分なので :190-198 (returnListOnly:true,partialOnTimeout 受渡し) に絞った。util.js:147-153 は timeout 確定時 {...result(),partial:true} の spread (配列を spread できない=object 必須) 根拠として保持。sdk: ts:547/py:1073 が partialOnTimeout を透過

### [ORG-0026] queryByCS: keyword 欠落で bad_request / chunk success:false で reject
- surface: core, cli
- backend: local
- command: `org.queryByCS` / `sesame org employee search`
- branch: keyword 空 | chunk success:false
- assert: keyword 空文字で badRequest('org.req.keyword') を throw し send しない。pubQueryByCS chunk の success:false で rejected を throw
- ref: packages/core/src/org.js:191; references_web/src/api/useManageEmployee.js:401-404; packages/core/src/org.js:818-823
- kind: error-path
- status: planned
- note: 検証済: org.js:191 if(!keyword) throw badRequest('org.req.keyword') (send 前に return)。biz3 :401-404 chunk success===false で cb 返し中断。kit 側 chunk success:false→reject は org.js:818-823 (subscriptions onMessage finish(rejected(...)))。badRequest は純ローカル検証なので backend:local 妥当

## employee.confirmQueryByCS

### [ORG-0027] confirmQueryByCS 送信フレーム {action,email,op:'confirmQueryByCS'}
- surface: core, serve, sdk, cli
- backend: cloud
- command: `org.confirmQueryByCS` / `sesame org employee confirm`
- branch: -
- assert: フレームが {action:BIZ3_MANAGE_EMPLOYEE, email, op:'confirmQueryByCS'} で email トップレベル直置き、keyword/items を含まないこと
- ref: references_web/src/api/useManageEmployee.js:420-432; packages/core/src/org.js:229-231
- kind: wire-fidelity
- status: planned
- note: 検証済: biz3 :423-427 {action:BIZ3_MANAGE_EMPLOYEE, email, op:'confirmQueryByCS'} email 直置き・keyword/items なし。org.js:230 {action:ACT_EMPLOYEE,email,op:'confirmQueryByCS'}。surface 全面 OK: cli/org.js:202-216 employee confirm→confirmQueryByCS、serve grpc-methods.generated.json:86、sdk ts/py

### [ORG-0028] confirmQueryByCS: email 欠落で bad_request
- surface: core
- backend: local
- command: `org.confirmQueryByCS`
- branch: email 空
- assert: email 空文字で badRequest('org.req.email') を throw し send しないこと
- ref: packages/core/src/org.js:228; packages/core/src/util.js:54-56
- kind: error-path
- status: planned
- note: 検証済: org.js:228 if(!email) throw badRequest('org.req.email') (request 前)。util.js:54-56 badRequest 定義 (SesameError code=BAD_REQUEST,retryable:false)。純ローカル検証で backend:local 妥当

### [ORG-0029] CLI confirm は副作用 (成功時 signout) を対話確認でガード
- surface: cli
- backend: cloud
- command: `sesame org employee confirm <email>`
- branch: canPrompt confirm yes | no abort | --json 非対話
- assert: biz3 UI が成功時に gAuth.handleSignout() する重い副作用を踏まえ、TTY かつ非--json なら confirm を取り、no で plain log+return (close 維持)、--json は確認スキップで実行する
- ref: references_web/src/components/biz/device/CSUserSearchDialog.js:122-128; packages/kit/src/cli/org.js:206-216
- kind: option-branch
- status: planned
- note: 検証済: CSUserSearchDialog.js 122=confirmQueryByCS 呼出, 127=gAuth.handleSignout() (成功時のみ, res.success===false で return)。cli/org.js 207=canPrompt, 208-211=confirm(defaultYes:false), 214=plain log+return (die せず close 維持), 216=confirmQueryByCS。成功時 signout は CLI 側で副作用として警告対象

## employee.*

### [ORG-0030] 全 employee op の serve 認証ゲート (requireAuth) と未認証 error-path
- surface: serve
- backend: cloud
- command: `org.getEmployees` / `org.addEmployees` / `org.queryByCS` (他 8 op)
- branch: 認証済み | 未認証
- assert: registry 自動公開ハンドラが requireAuth(daemon) を通過必須とし、未認証で 8 op すべてが認証エラー封筒を返す (認証は Android アプリ方式のセッション前提)
- ref: packages/kit/src/serve/registry.js:297-303; packages/core/src/org.js:848-851
- kind: error-path
- status: planned
- note: 検証済: registry.js 302 handler=({hub,params,daemon})=>{requireAuth(daemon); return hub[ns][op](p);} が NAMESPACE_OPS 全 op に一律適用 (288-305 ループ)。requireAuth は registry-helpers.js から import (46)。org.js 848-851 が 8 employee op を含む NAMESPACE_OPS。ref を 300-303→297-303 (registry.set 起点) と 848-859→848-851 (employee 8 op 行) に絞り込み。認証フローは auth.js。本 op 群は login 済みセッションで投げる組織管理 op

### [ORG-0031] 8 employee op の contract-existence (registry/grpc-methods/rpc-params/sdk が NAMESPACE_OPS と 1:1)
- surface: serve, sdk
- backend: cloud
- command: `org.getEmployees`/`getCurrentUserInfo`/`addEmployees`/`updateEmployee`/`removeEmployees`/`reorderEmployees`/`queryByCS`/`confirmQueryByCS`
- branch: -
- assert: NAMESPACE_OPS の 8 employee op が registry・grpc-methods.generated.json・rpc-params.generated.json・ts/py SDK のすべてに過不足なく存在し、param 名 (companyID/items/data/keyword/email/timeoutMs/partialOnTimeout) が生成型と一致する
- ref: packages/core/src/org.js:848-851; packages/kit/src/serve/registry.js:288-305; packages/kit/sdk/ts/sesame-client.ts:521-575
- kind: contract-existence
- status: planned
- note: 検証済: org.js 848-851=8 employee op。registry.js 288-305 が NAMESPACE_OPS を自動公開。ts SDK 521-575 に 8 op 全存在 (addEmployees:521 … updateEmployee:575) かつ param 名一致 (getEmployees={companyID?,timeoutMs?,partialOnTimeout?}, queryByCS={keyword,timeoutMs?,partialOnTimeout?}, confirmQueryByCS={email,timeoutMs?}, addEmployees={items,timeoutMs?}, updateEmployee={companyID?,data,timeoutMs?})。生成 json は packages/kit/src/serve/grpc-methods.generated.json・rpc-params.generated.json に 8 op 全存在し rpc-params の param 名も一致 (実体パスは src/serve/ 配下; assert の論理名と整合)

### [ORG-0032] CLI employee 各サブコマンドの --json 出力封筒パリティ
- surface: cli
- backend: cloud
- command: `sesame org employee ls/me/add/update/rm/reorder/search/confirm`
- branch: --json | human
- assert: --json 指定時に ls={ok,count,employees} / me={ok,currentUser} / search={ok,count,results} / 変更系={ok,response} の固定封筒で出力し、human 出力と同一 op 結果に基づくこと (ctx.out の二経路パリティ)
- ref: packages/kit/src/cli/org.js:51-63; packages/kit/src/cli/org.js:73-76; packages/kit/src/cli/org.js:185-197
- kind: surface-parity
- status: planned
- note: 検証済: ls 63={ok:true,count,employees:list}, me 75={ok:true,currentUser:info}, search 197={ok:true,count,results:list}, 変更系 (add 116/update 175 系) ={ok:true,response:resp}。いずれも ctx.out(opts.json, humanFn, jsonEnvelope) の二経路で同一 op 結果 (list/info/resp) を共有

### [ORG-0033] action 文字列は vendor messageConstants から引き手書きしない (wire enum 一致)
- surface: core
- backend: cloud
- command: `org.*` (全 employee op)
- branch: -
- assert: ACT_EMPLOYEE が ACTION_TYPES.BIZ3_MANAGE_EMPLOYEE='biz3ManageEmployee' を vendor から解決し、8 op の全フレーム action 値がこの単一定数と一致すること
- ref: packages/core/src/vendor/biz3/constants/messageConstants.js:6; packages/core/src/org.js:43; packages/core/src/org.js:77-230
- kind: wire-fidelity
- status: planned
- note: 検証済: messageConstants.js 6=BIZ3_MANAGE_EMPLOYEE:'biz3ManageEmployee'。org.js 43=const ACT_EMPLOYEE=ACTION_TYPES.BIZ3_MANAGE_EMPLOYEE (import 39 で解決)。8 op の全 send フレームが action:ACT_EMPLOYEE を使用 (77/79 get, 100 currentInfo, 119 add, 135 update, 153 delete, 170 order, 193/195 queryByCS, 230 confirmQueryByCS)。元 ref 39-43 を定義行 43 と使用範囲 77-230 に分割し assert の '8 op 全フレーム一致' を支持

## employeeGroup

### [ORG-0034] getEmployeeGroups → {action:biz3ManageEmployeeGroup, cid, op:getGroups}
- surface: core
- backend: cloud
- command: `getEmployeeGroups`
- branch: -
- assert: 送信フレームが {action:'biz3ManageEmployeeGroup', cid:companyID, op:'getGroups'} (cid キーで companyID 直置き) で、応答 resp.data 配列をそのまま返すことが biz3 と一致する
- ref: references_web/src/api/useManageEmployee.js:28-32; references_web/src/api/useManageEmployee.js:48-49; packages/core/src/org.js:251-256
- kind: wire-fidelity
- status: planned
- note: 検証済: useManageEmployee.js 28-32=sendMessage({action:BIZ3_MANAGE_EMPLOYEE_GROUP, cid:companyID, op:'getGroups'}), 48-49=case 'getGroups': setEmployeeGroups(message.data)。org.js 252=client.request({action:ACT_EMPLOYEE_GROUP, cid:companyID, op:'getGroups'}), 256=return resp.data??[]。ref を送信本体行 (25-33→28-32) と返却本体行 (249-257→251-256) に微修正。cid キー名は employeeGroup 系規約。role 系の 'companyID' と異なる点を別候補で対比

### [ORG-0035] getEmployeeGroups companyID 未指定で badRequest
- surface: core
- backend: local
- command: `getEmployeeGroups`
- branch: no-companyID
- assert: companyID 未指定時に WS 送信せず badRequest('org.req.companyID') を throw する(必須検証)
- ref: packages/core/src/org.js:250
- kind: error-path
- status: planned
- note: 検証済: org.js 250=if(!companyID) throw badRequest('org.req.companyID') が client.request(251) より前にあり WS 送信されない。参照側は companyID 無しで return(no-op) useManageEmployee.js:26-27 → kit は明示エラー化

### [ORG-0036] addEmployeeGroup → obj:{cid,...item} ラップ op:add
- surface: core
- backend: cloud
- command: `addEmployeeGroup`
- branch: -
- assert: 送信フレームが {action:'biz3ManageEmployeeGroup', obj:{cid:companyID, ...item}, op:'add'} と一致し、応答は無条件 resp.data(追加グループ1件)を返す
- ref: references_web/src/api/useManageEmployee.js:212-228; references_web/src/api/useManageEmployee.js:51-52; packages/core/src/org.js:267-276
- kind: wire-fidelity
- status: planned
- note: 確認済: useManageEmployee.js:216-223 が obj:{cid:companyID,...item}/op:'add'。handleEmployeeGroup:51-52 (case 'add' → message.data) が無条件 data 読み。org.js:270 送信フレーム・org.js:275 戻り値と一致

### [ORG-0037] addEmployeeGroup data 欠落時 undefined(resp フォールバック無し)
- surface: core
- backend: cloud
- command: `addEmployeeGroup`
- branch: data-absent
- assert: 応答に data が無い場合 resp 全体にフォールバックせず undefined を返す(参照は無条件 message.data を読む)
- ref: references_web/src/api/useManageEmployee.js:51-52; packages/core/src/org.js:275
- kind: payload-fidelity
- status: planned
- note: 確認済: handleEmployeeGroup:52 は `[...prevState, { ...message.data }]` で message.data を無条件展開し ?? message フォールバック無し。org.js:275 `return resp.data` も同様にフォールバック無し

### [ORG-0038] updateEmployeeGroup → obj:{cid,...item} ラップ op:update
- surface: core
- backend: cloud
- command: `updateEmployeeGroup`
- branch: -
- assert: 送信フレームが {action:'biz3ManageEmployeeGroup', obj:{cid:companyID, ...item}, op:'update'} と一致(item に gid 等を内包)
- ref: references_web/src/api/useManageEmployee.js:230-246; packages/core/src/org.js:285-293
- kind: wire-fidelity
- status: planned
- note: 確認済: 参照側関数名は postEmployeeGroupInfo (:230-246) で obj:{cid:companyID,...item}/op:'update'。org.js:288 送信フレームと一致

### [ORG-0039] removeEmployeeGroups → objs(配列)+cid 直置き op:deleteGroups
- surface: core
- backend: cloud
- command: `removeEmployeeGroups`
- branch: -
- assert: 送信フレームが {action:'biz3ManageEmployeeGroup', objs:gids, cid:companyID, op:'deleteGroups'} で、objs はトップレベル配列・cid は別キー直置きであることが biz3 と一致する
- ref: references_web/src/api/useManageEmployee.js:248-261; packages/core/src/org.js:303-312
- kind: wire-fidelity
- status: planned
- note: 確認済: useManageEmployee.js:253-256 が objs:gids(トップレベル配列)+cid:companyID 別キー直置き/op:'deleteGroups'。deviceGroup の removeDeviceGroups(各要素に cid マージ, org.js:515)と構造が異なる点を別候補で対比。org.js:307 と一致

### [ORG-0040] removeEmployeeGroups gids 非配列で badRequest
- surface: core
- backend: local
- command: `removeEmployeeGroups`
- branch: gids-not-array
- assert: gids が配列でないとき WS 送信せず badRequest('org.req.gidsArray') を throw する
- ref: packages/core/src/org.js:305
- kind: error-path
- status: planned
- note: 確認済: org.js:305 `if (!Array.isArray(gids)) throw badRequest("org.req.gidsArray");` が client.request(:306)前にあり WS 送信前に弾く。参照側 removeEmployeeGroups は配列検証無し(純ローカル付加契約)

### [ORG-0041] getEmployeeGroupBindDeviceGroup → gid のみ送り cid 不送信
- surface: core
- backend: cloud
- command: `getEmployeeGroupBindDeviceGroup`
- branch: -
- assert: 送信フレームが {action:'biz3ManageEmployeeGroup', gid, op:'getBindDeviceGroup'} で cid を含めず、resp.data を直返しすることが biz3 getDeviceGroup と一致する
- ref: references_web/src/api/useManageEmployee.js:321-334; packages/core/src/org.js:321-330
- kind: wire-fidelity
- status: planned
- note: 確認済: 参照側関数名は getDeviceGroup (:321-334)。companyID を取得(:323)するが送信フレーム(:325-329)には gid と op:'getBindDeviceGroup' のみ載せ cid を含めない。kit org.js:324 も cid を送らず resp.data を返す(:329)

### [ORG-0042] getEmployeeGroupBindDeviceGroup gid 未指定で badRequest
- surface: core
- backend: local
- command: `getEmployeeGroupBindDeviceGroup`
- branch: no-gid
- assert: gid 未指定時に WS 送信せず badRequest('org.req.gid') を throw する
- ref: packages/core/src/org.js:322
- kind: error-path
- status: planned
- note: 確認済: org.js:322 `if (!gid) throw badRequest("org.req.gid");` が client.request(:323)前にあり WS 送信前に弾く(純ローカル付加契約)

### [ORG-0043] addEmployeeInGroup → cid/gid/uuids/items 全直置き op:addBindUser
- surface: core
- backend: cloud
- command: `addEmployeeInGroup`
- branch: -
- assert: 送信フレームが {action:'biz3ManageEmployeeGroup', cid:companyID, gid, uuids, items, op:'addBindUser'} で uuids と items を両方そのまま透過することが biz3 と一致する
- ref: references_web/src/api/useManageEmployee.js:336-352; packages/core/src/org.js:340-347
- kind: wire-fidelity
- status: planned
- note: removeBindUser と異なり items は絞り込まず透過する点を別候補で対比。検証済: biz3 src 343-346 / org.js frame は line 343, action 値は messageConstants.js:7 BIZ3_MANAGE_EMPLOYEE_GROUP='biz3ManageEmployeeGroup'

### [ORG-0044] removeEmployeeInGroup → items を {subUUID} のみに絞り込む op:removeBindUser
- surface: core
- backend: cloud
- command: `removeEmployeeInGroup`
- branch: -
- assert: 送信前に items を {subUUID} のみへ写像し、{action:'biz3ManageEmployeeGroup', cid, gid, uuids, items:[{subUUID}], op:'removeBindUser'} を送ることが biz3 の params=items.map(i=>({subUUID:i.subUUID})) と一致する
- ref: references_web/src/api/useManageEmployee.js:354-373; references_web/src/api/useManageEmployee.js:358-360; packages/core/src/org.js:358-369
- kind: wire-fidelity
- status: planned
- note: 検証済: biz3 358-360 が params=items.map(i=>({subUUID:i.subUUID}))、org.js:362 が同写像 / frame line 364。org.js 行範囲を 358-368→358-369 に補正(関数末尾は 369)

### [ORG-0045] removeEmployeeInGroup items 非配列で badRequest
- surface: core
- backend: local
- command: `removeEmployeeInGroup`
- branch: items-not-array
- assert: items が配列でないとき map 前に badRequest('org.req.itemsArray') を throw する
- ref: packages/core/src/org.js:360
- kind: error-path
- status: planned
- note: 検証済: org.js:360 が if(!Array.isArray(items)) throw badRequest('org.req.itemsArray')、map(line 362)より前。純ローカル契約(biz3 側に対応バリデーション無し)

### [ORG-0046] removeEmployeeGroupBindDeviceGroup → cid+...data 直置き op:removeBindDeviceGroup
- surface: core
- backend: cloud
- command: `removeEmployeeGroupBindDeviceGroup`
- branch: -
- assert: 送信フレームが {action:'biz3ManageEmployeeGroup', cid:companyID, ...data, op:'removeBindDeviceGroup'} で、op がスプレッド後に置かれ data 内 op を上書きすることが biz3 と一致する
- ref: references_web/src/api/useManageEmployee.js:375-389; packages/core/src/org.js:379-387
- kind: wire-fidelity
- status: planned
- note: action は biz3ManageEmployeeGroup(useManageEmployee 側 removeDeviceGroup, biz3 src frame line 382)。device-group 側 removeDeviceGroupBindUserGroup(org.js:588-596, ACT_DEVICE_GROUP+op:removeBindUserGroup)と action/op が逆転する点を別候補で対比

## role

### [ORG-0047] getTags → {action:biz3ManageRole, companyID, op:get}
- surface: core
- backend: cloud
- command: `getTags`
- branch: -
- assert: 送信フレームが {action:'biz3ManageRole', companyID, op:'get'} で companyID キー名が 'companyID'(cid ではない)であり、応答 resp.data 配列を返すことが biz3 と一致する
- ref: references_web/src/api/useManageEmployee.js:35-43; references_web/src/api/useManageEmployee.js:124-127; packages/core/src/org.js:401-409
- kind: wire-fidelity
- status: planned
- note: role 系のみ companyID キー(messageConstants.js:10 BIZ3_MANAGE_ROLE='biz3ManageRole')。employeeGroup/deviceGroup の cid と対比。応答消費: biz3:126 setTags(message.data) / org.js:408 resp?.data ?? []

### [ORG-0048] postTag → companyID+...data 直置き、op:post が data.op を上書き
- surface: core
- backend: cloud
- command: `postTag`
- branch: -
- assert: 送信フレームが {action:'biz3ManageRole', companyID, ...data, op:'post'} で、op:'post' が ...data の後に置かれ data 内 op を必ず上書きすることが biz3 のキー順と一致する
- ref: references_web/src/api/useManageEmployee.js:289-303; packages/core/src/org.js:419-427
- kind: wire-fidelity
- status: planned
- note: フィールド出現順(op 後置)が一次資料どおり load-bearing。検証済: biz3 297(...data)→297-298(op:'post' 後置) / org.js:422 が同順

### [ORG-0049] removeTag → companyID+...data 直置き op:delete
- surface: core
- backend: cloud
- command: `removeTag`
- branch: -
- assert: 送信フレームが {action:'biz3ManageRole', companyID, ...data, op:'delete'} で、data に tagSetting 全体({tag, access[]} を含む)を載せ op が後置されることが biz3 と一致する
- ref: references_web/src/api/useManageEmployee.js:305-319; references_web/src/components/biz/device/DataTableColumns.js:627; references_web/src/components/biz/device/DataTableColumns.js:599; packages/core/src/org.js:436-444
- kind: wire-fidelity
- status: planned
- note: data 形 {tag, access[]} は呼出側 DataTableColumns.js:627 gManageEmployee.removeTag(tagSetting,...) で確定(tagSetting は :599 tag / :581 access[] に加え isShowAdd も持ち、spread で全体が透過)。biz3 frame: useManageEmployee.js:313(...data)→313-314(op:'delete' 後置)

### [ORG-0050] getTags/postTag/removeTag companyID 未指定で badRequest
- surface: core
- backend: local
- command: `getTags` / `postTag` / `removeTag`
- branch: no-companyID
- assert: 各 role op で companyID 未指定時に WS 送信せず badRequest('org.req.companyID') を throw する
- ref: packages/core/src/org.js:402; packages/core/src/org.js:420; packages/core/src/org.js:437
- kind: error-path
- status: planned
- note: 検証済: 402(getTags)/420(postTag)/437(removeTag) いずれも client.request 前に throw。badRequest は util.js から import (org.js:40)

## deviceGroup

### [ORG-0051] getDeviceGroups → {action:biz3ManageDeviceGroup, cid, op:getGroups}
- surface: core
- backend: cloud
- command: `getDeviceGroups`
- branch: -
- assert: 送信フレームが {action:'biz3ManageDeviceGroup', cid:companyID, op:'getGroups'} で cid キー直置き、応答 resp.data 配列を返すことが biz3 と一致する
- ref: references_web/src/api/useManageGroup.js:11-19; references_web/src/api/useManageGroup.js:27-33; packages/core/src/org.js:458-466
- kind: wire-fidelity
- status: planned
- note: 検証済: biz3 web 14-18 が cid 直置き、27-33 が message.data 読取。core 461 一致。action 文字列値 'biz3ManageDeviceGroup' は messageConstants.js:11 で確認

### [ORG-0052] addDeviceGroup → obj:{name,cid,uuids} ラップ op:add
- surface: core
- backend: cloud
- command: `addDeviceGroup`
- branch: -
- assert: 送信フレームが {action:'biz3ManageDeviceGroup', obj:{name, cid:companyID, uuids}, op:'add'} と一致し、obj 内キー順(name,cid,uuids)が biz3 と一致する
- ref: references_web/src/api/useManageGroup.js:84-102; packages/core/src/org.js:476-484
- kind: wire-fidelity
- status: planned
- note: 検証済: biz3 88-92 で data={name,cid,uuids}、95 で obj:{...data}。core 479 がキー順 name,cid,uuids 一致。employeeGroup add は obj:{cid,...item}。deviceGroup add は name/uuids を明示フィールドで持つ点が差異

### [ORG-0053] addDeviceGroup uuids 既定値 [] 適用
- surface: core, cli
- backend: cloud
- command: `addDeviceGroup` / `sesame org device-group add <name>`
- branch: uuids-default | uuids-explicit
- assert: uuids 省略時に既定 [] が obj.uuids に入る(core 既定値 uuids=[]、CLI --uuids 既定 '[]')
- ref: packages/core/src/org.js:476; packages/kit/src/cli/org.js:480-486
- kind: option-branch
- status: planned
- note: 検証済: core 476 引数既定 uuids=[]。CLI 480 .option('--uuids <json>',...,'[]') 既定、483-485 で parseJson 後 Array 検証してから addDeviceGroup へ渡す

### [ORG-0054] updateDeviceGroup → obj:{cid,...item} ラップ op:update
- surface: core
- backend: cloud
- command: `updateDeviceGroup`
- branch: -
- assert: 送信フレームが {action:'biz3ManageDeviceGroup', obj:{cid:companyID, ...item}, op:'update'} と一致する(biz3 postDeviceGroupInfo)
- ref: references_web/src/api/useManageGroup.js:310-326; packages/core/src/org.js:493-501
- kind: wire-fidelity
- status: planned
- note: 検証済: biz3 postDeviceGroupInfo 314-321 が obj:{cid,...item} op:'update'。core 496 一致

### [ORG-0055] removeDeviceGroups → 各要素に cid マージした objs op:deleteGroups
- surface: core
- backend: cloud
- command: `removeDeviceGroups`
- branch: -
- assert: 送信フレームが {action:'biz3ManageDeviceGroup', objs:groupIds.map(o=>({...o,cid:companyID})), op:'deleteGroups'} で、cid を各要素にマージし(employeeGroup と異なりトップレベル cid 無し)objs 複数形で送ることが biz3 と一致する
- ref: references_web/src/api/useManageGroup.js:67-82; references_web/src/api/useManageGroup.js:71-74; packages/core/src/org.js:511-522
- kind: wire-fidelity
- status: planned
- note: 検証済: biz3 71-74 で各 obj に cid マージ、76-78 で objs 複数形・トップレベル cid 無し。core 515-517 一致。employeeGroup removeEmployeeGroups(objs:gids + トップレベル cid)との構造差異が核心

### [ORG-0056] removeDeviceGroups groupIds 非配列で badRequest
- surface: core
- backend: local
- command: `removeDeviceGroups`
- branch: groupIds-not-array
- assert: groupIds が配列でないとき map 前に badRequest('org.req.groupIdsArray') を throw する
- ref: packages/core/src/org.js:513
- kind: error-path
- status: planned
- note: 検証済: 513 で !Array.isArray(groupIds) を 515 の .map より前にガード

### [ORG-0057] addDeviceInGroup → cid/gid/uuids/items 全直置き op:addBindDevice
- surface: core
- backend: cloud
- command: `addDeviceInGroup`
- branch: -
- assert: 送信フレームが {action:'biz3ManageDeviceGroup', cid:companyID, gid, uuids, items, op:'addBindDevice'} で items を絞り込まず透過することが biz3 と一致する
- ref: references_web/src/api/useManageGroup.js:240-256; packages/core/src/org.js:532-540
- kind: wire-fidelity
- status: planned
- note: 確認済: useManageGroup.js:240-256 addDeviceInGroup は items を map せず透過 (removeDeviceInGroup:222-225 との対比)。org.js:532-540 一致。

### [ORG-0058] removeDeviceInGroup → items を {deviceUUID,secretKey} のみに絞り込む op:removeBindDevice
- surface: core
- backend: cloud
- command: `removeDeviceInGroup`
- branch: -
- assert: 送信前に items を {deviceUUID, secretKey} のみへ写像し、{action:'biz3ManageDeviceGroup', cid, gid, uuids, items:[{deviceUUID,secretKey}], op:'removeBindDevice'} を送ることが biz3 params=items.map(i=>({deviceUUID,secretKey})) と一致する
- ref: references_web/src/api/useManageGroup.js:218-238; references_web/src/api/useManageGroup.js:222-225; packages/core/src/org.js:549-559
- kind: wire-fidelity
- status: planned
- note: 確認済: map は useManageGroup.js:222-225 / org.js:553。employeeGroup removeBindUser は {subUUID} 絞り込み(useManageEmployee.js:358-360)。絞り込みキー集合の差異を対比。

### [ORG-0059] removeDeviceInGroup items 非配列で badRequest
- surface: core
- backend: local
- command: `removeDeviceInGroup`
- branch: items-not-array
- assert: items が配列でないとき map 前に badRequest('org.req.itemsArray') を throw する
- ref: packages/core/src/org.js:551
- kind: error-path
- status: planned
- note: 確認済: org.js:551 `if (!Array.isArray(items)) throw badRequest("org.req.itemsArray")` が map(:553)より前。

### [ORG-0060] getDeviceGroupBindUserGroup → gid のみ送り cid 不送信 op:getBindUserGroup
- surface: core
- backend: cloud
- command: `getDeviceGroupBindUserGroup`
- branch: -
- assert: 送信フレームが {action:'biz3ManageDeviceGroup', gid, op:'getBindUserGroup'} で cid を含めず resp.data を直返しすることが biz3 getEmployeeGroup と一致する
- ref: references_web/src/api/useManageGroup.js:189-200; packages/core/src/org.js:569-578
- kind: wire-fidelity
- status: planned
- note: 確認済: useManageGroup.js:189-200 関数名は getEmployeeGroup だが action=biz3ManageDeviceGroup・cid 不送信。org.js:569-578 一致(resp.data 直返し :577)。action が biz3ManageDeviceGroup(getBindDeviceGroup は逆に biz3ManageEmployeeGroup)を別候補で対比。

### [ORG-0061] getDeviceGroupBindUserGroup gid 未指定で badRequest
- surface: core
- backend: local
- command: `getDeviceGroupBindUserGroup`
- branch: no-gid
- assert: gid 未指定時に WS 送信せず badRequest('org.req.gid') を throw する
- ref: packages/core/src/org.js:570
- kind: error-path
- status: planned
- note: 確認済: org.js:570 `if (!gid) throw badRequest("org.req.gid")` が client.request(:571)より前。

### [ORG-0062] removeDeviceGroupBindUserGroup → cid+...data 直置き op:removeBindUserGroup
- surface: core
- backend: cloud
- command: `removeDeviceGroupBindUserGroup`
- branch: -
- assert: 送信フレームが {action:'biz3ManageDeviceGroup', cid:companyID, ...data, op:'removeBindUserGroup'} で op が後置されることが biz3 removeEmployeeGroup と一致する
- ref: references_web/src/api/useManageGroup.js:202-216; packages/core/src/org.js:588-596
- kind: wire-fidelity
- status: planned
- note: 確認済: useManageGroup.js:202-216 関数名は removeEmployeeGroup だが action=biz3ManageDeviceGroup・cid,...data,op 後置(:207-211)。org.js:588-596 一致(...data の後に op :591)。

## cross-action

### [ORG-0063] bind 系 action 逆転: bindDeviceGroup=employeeGroup action / bindUserGroup=deviceGroup action
- surface: core
- backend: cloud
- command: `getEmployeeGroupBindDeviceGroup` / `removeEmployeeGroupBindDeviceGroup` / `getDeviceGroupBindUserGroup` / `removeDeviceGroupBindUserGroup`
- branch: bind-device-group | bind-user-group
- assert: 従業員グループ⇔デバイスグループのバインド照会/解除で、(get|remove)EmployeeGroupBindDeviceGroup は action='biz3ManageEmployeeGroup'、(get|remove)DeviceGroupBindUserGroup は action='biz3ManageDeviceGroup' という参照の action 割当(操作対象の逆側名前空間)を厳密に踏襲する
- ref: references_web/src/api/useManageEmployee.js:321-334; references_web/src/api/useManageEmployee.js:375-389; references_web/src/api/useManageGroup.js:189-200; references_web/src/api/useManageGroup.js:202-216
- kind: wire-fidelity
- status: planned
- note: 確認済: useManageEmployee.js:326/381 が BIZ3_MANAGE_EMPLOYEE_GROUP(getBindDeviceGroup/removeBindDeviceGroup)、useManageGroup.js:192/207 が BIZ3_MANAGE_DEVICE_GROUP(getBindUserGroup/removeBindUserGroup)。スライス内で最も誤りやすい境界。kit org.js:321/379(ACT_EMPLOYEE_GROUP) vs :569/588(ACT_DEVICE_GROUP)。

## surface-cli

### [ORG-0064] sesame org group ls 整形出力と --json 封筒
- surface: cli
- backend: cloud
- command: `sesame org group ls`
- branch: human | --json
- assert: getEmployeeGroups の戻り配列を human では gid/name 行で、--json では {ok:true,count,groups} 封筒で出力する(出力封筒の同一性)
- ref: packages/kit/src/cli/org.js:229-247
- kind: surface-parity
- status: planned
- note: 確認済: human は g.gid/g.name (org.js:241-243)、json 封筒 {ok,count,groups} (org.js:245)

### [ORG-0065] sesame org group add 必須 --json 検証と exit 2
- surface: cli
- backend: cloud
- command: `sesame org group add`
- branch: missing-json | valid-json
- assert: --json 省略時に ctx.die(need,2) で終了コード2、有効時は addEmployeeGroup({item}) を呼び created.gid 有無で okId/ok を切替えることが CLI 契約と一致する
- ref: packages/kit/src/cli/org.js:250-269
- kind: option-branch
- status: planned
- note: 確認済: die(need,2) org.js:256、addEmployeeGroup({item}) :263、created?.gid?okId:ok :266

### [ORG-0066] sesame org group rm --json 非配列で exit 2
- surface: cli
- backend: cloud
- command: `sesame org group rm`
- branch: missing-json | not-array | array
- assert: --json 省略は die(need,2)、parse 結果が配列でなければ die('org.err.jsonArray',2)、配列なら removeEmployeeGroups({gids}) を呼ぶ
- ref: packages/kit/src/cli/org.js:291-308
- kind: error-path
- status: planned
- note: 確認済: die(need,2) :297、!Array→die(jsonArray,2) :302、removeEmployeeGroups({gids}) :303

### [ORG-0067] sesame org group add-users/rm-users の uuids/items 配列検証
- surface: cli
- backend: cloud
- command: `sesame org group add-users <gid>` / `rm-users <gid>`
- branch: add(uuids&items required) | rm(items required)
- assert: add-users は body.uuids/body.items 両方が配列でなければ die('org.err.uuidsItemsArray',2)、rm-users は body.items のみ配列必須(die org.err.itemsArray,2)という非対称検証が実装どおり
- ref: packages/kit/src/cli/org.js:324-364
- kind: option-branch
- status: planned
- note: 確認済: add-users uuids&&items チェック org.js:336-337、rm-users items のみ :358 の非対称

### [ORG-0068] sesame org device-group rm-devices secretKey 込み items 検証→絞り込み
- surface: cli, core
- backend: cloud
- command: `sesame org device-group rm-devices <gid>`
- branch: missing-json | items-not-array | valid
- assert: CLI は body.items 配列必須(die,2)で removeDeviceInGroup へ透過し、core が {deviceUUID,secretKey} へ絞り込む(CLI→core の境界一貫性)
- ref: packages/kit/src/cli/org.js:556-573; packages/core/src/org.js:549-559
- kind: surface-parity
- status: planned
- note: 確認済: CLI die(need,2):561 die(itemsArray,2):567、core removeDeviceInGroup が {deviceUUID,secretKey} へ絞込み core/org.js:553

### [ORG-0069] sesame org role ls は {tag,access[]} 前提で整形
- surface: cli
- backend: cloud
- command: `sesame org role ls`
- branch: human | --json
- assert: getTags の各要素を tag\taccess.join(',') で出力し、id/name フォールバックを持たない(role の実フィールドは {tag, access[]})ことが参照 DataTableColumns と一致する
- ref: packages/kit/src/cli/org.js:391-409; references_web/src/components/biz/device/DataTableColumns.js:560-575; references_web/src/api/useManageEmployee.js:124-127
- kind: surface-parity
- status: planned
- note: 確認済: CLI は tagSetting.tag/access.join(',') org.js:404-405 で id/name フォールバック無し。実フィールド {tag,access[]} は DataTableColumns.js:560-575 (companyRole 列定義) が一次出典。useManageEmployee.js:124-127 は role 'get'→setTags(message.data) でタグ列挙が getTags 由来であることのみ補強(フィールド名は示さない)

## surface-serve

### [ORG-0070] org.<groupOps> が NAMESPACE_OPS から自動公開され requireAuth ゲートされる
- surface: serve
- backend: cloud
- command: `org.getEmployeeGroups` / `org.addDeviceGroup` / `org.getTags` 等
- branch: authed | unauth
- assert: NAMESPACE_OPS の各 group/tag/deviceGroup op が registry に org.<op> として登録され、ハンドラが requireAuth 後に hub.org[op](params) を呼ぶ(未認証は拒否)
- ref: packages/kit/src/serve/registry.js:287-305; packages/core/src/org.js:847-859; packages/kit/src/serve/registry-helpers.js:55-61
- kind: contract-existence
- status: planned
- note: 確認済: registry.js:288-304 が NS_MODULES.NAMESPACE_OPS を反復し reg.set(`${ns}.${op}`)、ハンドラ :302 が requireAuth(daemon) 後 hub[ns][op](p)。core NAMESPACE_OPS は getEmployeeGroups/addDeviceGroup/getTags 等を含む org.js:848-859。requireAuth は expired/未接続を RpcError で拒否 registry-helpers.js:55-61

### [ORG-0071] org group/deviceGroup/tag op の rpc-params が生成表に存在
- surface: serve
- backend: cloud
- command: `org.getEmployeeGroups` / `org.addEmployeeGroup` / `org.updateEmployeeGroup` / `org.removeEmployeeGroups` / `org.getDeviceGroups` / `org.addDeviceGroup` / `org.updateDeviceGroup` / `org.removeDeviceGroups` / `org.getTags`
- branch: -
- assert: rpc-params.generated.json に各 op の param 名/required が抽出済みで存在し、OpenRPC result.schema 配線の入力になる
- ref: packages/kit/src/serve/rpc-params.generated.json:219; packages/kit/src/serve/rpc-params.generated.json:526; packages/kit/src/serve/rpc-params.generated.json:453
- kind: contract-existence
- status: planned
- note: 検証済み: 9 op 全て存在 (getEmployeeGroups:219, addEmployeeGroup:238, updateEmployeeGroup:265, removeEmployeeGroups:292, getDeviceGroups:526, addDeviceGroup:545, updateDeviceGroup:583, removeDeviceGroups:610, getTags:453)。ref 3 件目を employee-group/device-group/tag の 3 家系を張るよう :729 (org.getDeviceGroupBindUserGroup — command 外) から :453 (org.getTags) に置換。

## surface-sdk

### [ORG-0072] 生成 gRPC メソッドが org group/deviceGroup op を 1:1 で公開
- surface: sdk
- backend: cloud
- command: `OrgGetEmployeeGroups` / `OrgAddDeviceGroup` / `OrgGetDeviceGroupBindUserGroup` / `OrgRemoveDeviceGroupBindUserGroup` 等
- branch: -
- assert: grpc-methods.generated.json の各エントリ method が org.<op> と 1:1 対応し、SDK(ts/py)へ漏れなく射影される(契約存在)
- ref: packages/kit/src/serve/grpc-methods.generated.json:92; packages/kit/src/serve/grpc-methods.generated.json:205; packages/kit/src/serve/grpc-methods.generated.json:255
- kind: contract-existence
- status: planned
- note: 検証済み: 各エントリ key は org.<op> を method に持つ (OrgGetEmployeeGroups:92→org.getEmployeeGroups, OrgAddDeviceGroup:205→org.addDeviceGroup, OrgGetDeviceGroupBindUserGroup:255→org.getDeviceGroupBindUserGroup, OrgRemoveDeviceGroupBindUserGroup:262)。ref 2 件目を command 命名の OrgAddDeviceGroup(:205) に合わせ :197 (OrgGetDeviceGroups — command 外) から置換。射影先: scripts/gen-grpc-proto.mjs + packages/kit/sdk/ts/sesame-client.ts。

## surface-parity

### [ORG-0073] hub.org.* 経由で companyID 自動注入(core namespace)
- surface: core
- backend: cloud
- command: `hub.org.getEmployeeGroups` / `getDeviceGroups` / `getTags`
- branch: injected | explicit-override
- assert: _bindNs が companyID/subUUID を既定注入し、params で明示指定すればそちらが優先する(直接関数呼び出しと namespace 呼び出しで同一フレームになる)
- ref: packages/core/src/client.js:333-358
- kind: surface-parity
- status: planned
- note: 検証済み: _bindNs は 333-353、注入の核は :350 out[name]=(params={})=>fn(ws,{companyID,subUUID,...params}) (params 末尾 spread で明示値が既定を上書き)。:356-358 が get schedule/org getter で org namespace を _bindNs に束ねる。範囲 333-358 は正確。

## i18n

### [ORG-0074] org group/role/device-group カタログの en/ja 完全性
- surface: cli
- backend: local
- command: i18n `org.group.*` / `org.role.*` / `org.deviceGroup.*` / `org.err.uuidsItemsArray`
- branch: en | ja
- assert: スライスで参照する t() キー(org.group.*, org.role.*, org.deviceGroup.*, org.req.gidsArray/groupIdsArray, org.err.uuidsItemsArray)が en と ja の双方で欠落なく定義される
- ref: packages/core/src/i18n/org.js:11; packages/core/src/i18n/org.js:23; packages/core/src/i18n/org.js:257
- kind: i18n
- status: planned
- note: 検証済み: en ブロック(2-247)/ja ブロック(248-493)双方に同形キー。org.req.gidsArray(en:10/ja:256), org.req.groupIdsArray(en:11/ja:257), org.err.uuidsItemsArray(en:23/ja:269), org.group.*(en:79〜/ja:325〜), org.role.*(en:126〜/ja:372〜), org.deviceGroup.*(en:147〜/ja:393〜) 全て両言語に存在。ref 3 件目を ja 側を張る :257 (ja org.req.groupIdsArray) に置換(旧 :1 は export default 行で en/ja 双方の主張を支えない)。cli/org.js:337 で org.err.uuidsItemsArray を実使用。

## employeeDevice/shareKeys

### [ORG-0075] shareDeviceKeysToEmployees の wire: {action:biz3ManageEmployeeDevice, items, op:'add'} で companyID を送らない
- surface: core
- backend: cloud
- command: `org.shareDeviceKeysToEmployees`
- branch: -
- assert: 送信フレームが action=biz3ManageEmployeeDevice / items 直置き / op='add' で、トップレベル companyID を持たない (biz3 useManageGroup と同形)
- ref: packages/core/src/org.js:612; references_web/src/api/useManageGroup.js:106-119
- kind: wire-fidelity
- status: planned
- note: 検証済み: org.js:615 client.request({action:ACT_EMPLOYEE_DEVICE, items, op:'add'}) で companyID 不在 (ACT_EMPLOYEE_DEVICE=biz3ManageEmployeeDevice, org.js:47)。useManageGroup.js:108-114 は companyID をガードに読むが messageData={action,items,op:'add'} に含めない — 同形。既存 test: packages/core/tests/org/org.test.js:531-538 (未索引/planned のまま)。

### [ORG-0076] shareDeviceKeysToEmployees の item 構築: {...device,...user,keyLevel,startTime,endTime}・常時利用は空文字
- surface: core, cli
- backend: cloud
- command: `org.shareDeviceKeysToEmployees` / `sesame org keys share`
- branch: 一時利用(epoch秒) | 常時利用(空文字)
- assert: 各 item が device と user の spread + keyLevel(0/1/2) を持ち、startTime/endTime は一時利用(guestKeyTime==='一時利用'、UI 上は guest=keyLevel 2)時のみ epoch 秒、それ以外は '' になる呼出側契約
- ref: references_web/src/pages/biz/devices/device-share/DeviceShare.js:65-76; references_web/src/components/DeviceUserList.js:79-91
- kind: wire-fidelity
- status: planned
- note: 検証済み: DeviceShare.js:67-73 item={...device,...user,keyLevel:level, startTime/endTime: guestKeyTime==='一時利用'?Math.floor(date/1000):''}。DeviceUserList.js:78 delete param['stateInfo'] → :82 rank:0 を付与し :83-84 ...user,keyLevel を展開。assert 修正: 一時利用判定の literal gate は keyLevel==2 ではなく guestKeyTime==='一時利用' (guest=2 は UI 上の含意)。

### [ORG-0077] sesame org keys share: --json 必須・配列でないと exit 2 (error-path)
- surface: cli
- backend: cloud
- command: `sesame org keys share`
- branch: --json 欠落→die(2) | 非配列→die(2) | 正常→shareDeviceKeysToEmployees
- assert: --json 未指定で ctx.die(code=2)、parse 結果が配列でなければ org.err.jsonArray で die(2)、配列なら hub.org.shareDeviceKeysToEmployees に items を渡す
- ref: packages/kit/src/cli/org.js:647-665
- kind: error-path
- status: planned
- note: 検証済み: cli/org.js:653-654 !cmdOpts.json→ctx.die(org.keys.share.need,2)、:659 !Array.isArray(items)→ctx.die(org.err.jsonArray,2)、:660 配列なら hub.org.shareDeviceKeysToEmployees({items})。範囲 647-665 正確。

### [ORG-0078] sesame org keys share の出力封筒: human は件数メッセージ、--json は {ok,response}
- surface: cli
- backend: cloud
- command: `sesame org keys share`
- branch: human出力 | --json出力
- assert: ctx.out が human では org.keys.share.ok(n=items.length) を console.log、--json では {ok:true, response:resp} を返す
- ref: packages/kit/src/cli/org.js:660-663
- kind: surface-parity
- status: planned

## employeeDevice/groupShare

### [ORG-0079] shareDeviceGroupKeysToEmployeeGroup の wire: {action, ...item, companyID, op:'group'} (cid ではなく companyID)
- surface: core
- backend: cloud
- command: `org.shareDeviceGroupKeysToEmployeeGroup`
- branch: -
- assert: 送信フレームが action=biz3ManageEmployeeDevice / item を spread / キー名 'companyID'(cid 不可) / op='group' で biz3 と一致
- ref: packages/core/src/org.js:632-640; references_web/src/api/useManageGroup.js:121-135
- kind: wire-fidelity
- status: planned
- note: 既存: packages/core/tests/org/org.test.js:541-559。action 定数 biz3ManageEmployeeDevice は messageConstants.js:8 で確認。

### [ORG-0080] shareDeviceGroupKeysToEmployeeGroup の item 構築: keyLevel(文字列'0'/'1'/'2')・devices は dedup・startTime/endTime は keyLevel==='2' のみ
- surface: core
- backend: cloud
- command: `org.shareDeviceGroupKeysToEmployeeGroup`
- branch: keyLevel=='2'(time付与) | keyLevel!='2'(time無し)
- assert: item が {keyLevel:文字列, members, devices([...new Set] でユニーク化), mid, dids} を持ち、startTime/endTime は keyLevel==='2' のときのみ設定 (一時利用なら値、常時なら '')
- ref: references_web/src/pages/biz/devices/group-share/GroupShare.js:72-95; packages/core/src/org.js:622-640
- kind: wire-fidelity
- status: planned
- note: item 構築は web (GroupShare.submitShare:73 dedup, 78 devices, 81-89 time) で実証。CLI 側は item を組まず --json で生(プリビルド)を受けて渡すだけ (org.js:677-679) のため surface は core のみに修正(元 cli/share-group 表記を削除)。

### [ORG-0081] shareDeviceGroupKeysToEmployeeGroup companyID 必須検証 (badRequest)
- surface: core
- backend: cloud
- command: `org.shareDeviceGroupKeysToEmployeeGroup`
- branch: companyID 欠落→throw
- assert: companyID 未指定で badRequest('org.req.companyID') を throw する
- ref: packages/core/src/org.js:633
- kind: error-path
- status: planned

### [ORG-0082] sesame org keys share-group: --json 必須で欠落時 exit 2
- surface: cli
- backend: cloud
- command: `sesame org keys share-group`
- branch: --json 欠落→die(2) | 正常
- assert: --json 未指定で org.keys.shareGroup.need により die(code=2)、指定時は parse した item を hub.org.shareDeviceGroupKeysToEmployeeGroup に渡す
- ref: packages/kit/src/cli/org.js:667-684
- kind: error-path
- status: planned

## employeeDevice/employeeKeys

### [ORG-0083] getEmployeeDeviceKeys の wire: {action, subUUID, op:'get'} で companyID を送らない
- surface: core
- backend: cloud
- command: `org.getEmployeeDeviceKeys`
- branch: -
- assert: 送信フレームが action=biz3ManageEmployeeDevice / subUUID 直置き / op='get' で companyID を含まない
- ref: packages/core/src/org.js:649-655; references_web/src/api/useManageGroup.js:137-148
- kind: wire-fidelity
- status: planned
- note: 既存: packages/core/tests/org/org.test.js:561-568 (companyID 不在も assert)。

### [ORG-0084] getEmployeeDeviceKeys は resp.data を無条件パススルー (data 欠落は undefined、フォールバック無し)
- surface: core
- backend: cloud
- command: `org.getEmployeeDeviceKeys`
- branch: data あり | data 欠落→undefined
- assert: assertSuccess 後に resp.data を返し、data 欠落時は undefined (resp 全体へフォールバックしない) — EmployeeItem.js:74 が無条件 res.data.map を呼ぶ契約と一致
- ref: packages/core/src/org.js:656-657; references_web/src/pages/biz/employees/list-item/EmployeeItem.js:72-83
- kind: payload-fidelity
- status: planned
- note: 既存: packages/core/tests/org/org.test.js:571-575 (data 欠落→undefined を assert)。

### [ORG-0085] sesame org keys employee <subUUID>: 位置引数を subUUID として渡し JSON 整形出力
- surface: cli
- backend: cloud
- command: `sesame org keys employee <subUUID>`
- branch: human(JSON.stringify) | --json({ok,subUUID,keys})
- assert: 位置引数 subUUID を hub.org.getEmployeeDeviceKeys に渡し、human は JSON.stringify(data,null,2)、--json は {ok:true,subUUID,keys:data} を返す
- ref: packages/kit/src/cli/org.js:635-645
- kind: surface-parity
- status: planned
- note: 確認済: cli/org.js:636 keys.command('employee <subUUID>')、640 getEmployeeDeviceKeys({subUUID})、642 JSON.stringify(data,null,2)、643 {ok:true,subUUID,keys:data}。出力経路 ctx.out(opts.json,...)。

## employeeDevice/removeKey

### [ORG-0086] removeEmployeeDeviceKey の wire: {action, ...data, op:'del'} で companyID 無し (ゲスト/従業員 2 パターン)
- surface: core
- backend: cloud
- command: `org.removeEmployeeDeviceKey`
- branch: ゲスト削除{guestKeyId,randomTag,deviceUUID} | 従業員削除{subUUID,deviceUUID}
- assert: data を spread し op='del'・companyID 無し。ゲスト鍵は {guestKeyId,randomTag,deviceUUID}、通常は {subUUID,deviceUUID} の 2 形が biz3 と一致
- ref: packages/core/src/org.js:671-679; references_web/src/api/useManageGroup.js:150-161; references_web/src/components/DeviceUserList.js:117-132
- kind: wire-fidelity
- status: planned
- note: 確認済: core/org.js:674 {action:ACT_EMPLOYEE_DEVICE,...data,op:'del'} で companyID キー無し。web useManageGroup.js:152-156 同形、DeviceUserList.js:119-132 が 2 パターン分岐。既存: packages/core/tests/org/org.test.js:578-596 (line 679 = return を含めるため終端を 679 に修正)。

### [ORG-0087] removeEmployeeDeviceKey: data が object でないと badRequest
- surface: core
- backend: cloud
- command: `org.removeEmployeeDeviceKey`
- branch: data 非object→throw
- assert: data が null/非object のとき badRequest('org.req.data') を throw する
- ref: packages/core/src/org.js:672
- kind: error-path
- status: planned
- note: 確認済: core/org.js:672 `if (!data || typeof data !== "object") throw badRequest("org.req.data");`。

### [ORG-0088] ゲスト鍵削除の randomTag = cmacTime(device.secretKey) 自動補完 (256秒粒度・手入力不能)
- surface: cli
- backend: cloud, local
- command: `sesame org keys rm`
- branch: guestKeyId あり&randomTag 未指定→listDevices から secretKey 引いて cmacTime 補完 | randomTag 明示→上書きしない
- assert: guestKeyId ありで randomTag 未指定なら listDevices の該当 deviceUUID.secretKey から cmacTime で randomTag を生成し、明示時は listDevices を呼ばず保持する (DeviceUserList.js:117-132 と同計算)
- ref: packages/kit/src/cli/org.js:702-715; references_web/src/components/DeviceUserList.js:117-132; packages/core/src/crypto.js:55
- kind: option-branch
- status: planned
- note: 確認済: cli/org.js:702 `if (data.guestKeyId && !data.randomTag)` ガード、703 listDevices、714 data.randomTag=cmacTime(device.secretKey)。cmacTime は core/crypto.js:55 export。web DeviceUserList.js:121 `await Cmac.cmacTime(device.secretKey)` と同計算。既存: packages/kit/tests/cli/org-role-keys.test.js:82-116 ([BIZ-12] 相当)。ref 終端を 715 (補完ブロック終了) に修正。

### [ORG-0089] 従業員削除 (subUUID) は randomTag 補完経路に入らない (listDevices 不呼び)
- surface: cli
- backend: cloud
- command: `sesame org keys rm`
- branch: subUUID 経路 | guestKeyId 経路
- assert: data に guestKeyId が無い (subUUID) 場合は listDevices を呼ばず data をそのまま removeEmployeeDeviceKey へ渡す
- ref: packages/kit/src/cli/org.js:702; references_web/src/components/DeviceUserList.js:127-132
- kind: option-branch
- status: planned
- note: 確認済: cli/org.js:702 のガード条件 `data.guestKeyId && !data.randomTag` が false (subUUID) のとき 703-715 の listDevices 経路をスキップし 716 で data をそのまま渡す。web DeviceUserList.js:127-131 else 分岐 {subUUID,deviceUUID}。既存: org-role-keys.test.js:118-129。

### [ORG-0090] keys rm 補完失敗の error-path: deviceUUID 不在 / secretKey 欠落 / --json 欠落で exit 2
- surface: cli
- backend: cloud
- command: `sesame org keys rm`
- branch: --json 欠落→die(2) | device 不在→die(2) | secretKey 欠落→die(2)
- assert: --json 未指定・listDevices に deviceUUID が無い・該当 device に secretKey が無い、いずれも ctx.die(code=2) で removeEmployeeDeviceKey を呼ばない
- ref: packages/kit/src/cli/org.js:692-714
- kind: error-path
- status: planned
- note: 確認済: cli/org.js:692-694 --json 欠落 ctx.die(...,2)、706-709 deviceNotFound die(2)、710-713 noSecretKey die(2)。いずれも die 後 return し 716 の removeEmployeeDeviceKey に到達しない。既存: org-role-keys.test.js:131-152 (die ケース)。

## employeeDevice/guestTag

### [ORG-0091] updateGuestKeyTag の wire: {action, ...data, op:'updateGuestTag'}・data={deviceUUID,guestKeyId,keyName}
- surface: core
- backend: cloud
- command: `org.updateGuestKeyTag`
- branch: -
- assert: data を spread し op='updateGuestTag'、data 形は {deviceUUID,guestKeyId,keyName} (keyName が新タグ) で biz3 と一致
- ref: packages/core/src/org.js:689-697; references_web/src/api/useManageGroup.js:163-174; references_web/src/components/DeviceUserList.js:146-151
- kind: wire-fidelity
- status: planned
- note: 確認済: core/org.js:692 {action:ACT_EMPLOYEE_DEVICE,...data,op:'updateGuestTag'}。web useManageGroup.js:165-169 同形、DeviceUserList.js:146-151 が data={deviceUUID,guestKeyId,keyName:val}。既存: packages/core/tests/org/org.test.js:597-609。ref 終端を 697 (return を含む) に修正。

### [ORG-0092] updateGuestKeyTag: data 非object で badRequest / CLI --json 欠落で exit 2
- surface: core, cli
- backend: cloud
- command: `org.updateGuestKeyTag` / `sesame org keys update-guest-tag`
- branch: core: data 非object→throw | cli: --json 欠落→die(2)
- assert: core は data 非object で badRequest('org.req.data') (org.js:690)、CLI は --json 未指定で org.keys.updateGuestTag.need により die(2) (cli/org.js:730)
- ref: packages/core/src/org.js:690; packages/kit/src/cli/org.js:723-740
- kind: error-path
- status: planned
- note: 検証済: core throw=org.js:690、CLI die(2)=cli/org.js:730。i18n key=org.keys.updateGuestTag.need 実在。既存 core テスト: packages/core/tests/org/org.test.js:597-609

## employeeDevice/guestQR

### [ORG-0093] generateGuestQR の wire: deviceKey 全体を spread op:'generateGuestQR'、応答 data(guestKeyId 文字列) を返す
- surface: core
- backend: cloud
- command: `org.generateGuestQR`
- branch: -
- assert: data(currentDeviceKey 全体: deviceUUID/secretKey/sesame2PublicKey/keyIndex/deviceModel 等) を spread し op='generateGuestQR'、resp.data(guestKeyId string)を返す
- ref: packages/core/src/org.js:711-718; references_web/src/api/useManageGroup.js:176-187; references_web/src/components/MobileDeviceShareQRCode.js:55-69
- kind: wire-fidelity
- status: planned
- note: 検証済: org.js:711-718=spread+op+return resp.data。useManageGroup.js:176-187=generateGuestQRCode callback (action=BIZ3_MANAGE_EMPLOYEE_DEVICE,...data,op:'generateGuestQR')。MobileDeviceShareQRCode.js:57-69=resolve(res.data)。QR URL 画像化(generateInviteGuestQRCodeByInfo, 同ファイル:53)は本 op 対象外。既存: packages/core/tests/org/org.test.js:611-618

### [ORG-0094] generateGuestQR: success:false で throw / data 非object で badRequest
- surface: core
- backend: cloud
- command: `org.generateGuestQR`
- branch: success:false→throw | data 非object→throw
- assert: data 非object なら badRequest('org.req.data') (org.js:712)、応答 success:false なら assertSuccess が 'generateGuestQR failed: <msg>' を throw (org.js:717)
- ref: packages/core/src/org.js:712; packages/core/src/org.js:717
- kind: error-path
- status: planned
- note: 修正: 旧 assert は行→挙動が逆転 (712=data 非object チェック、717=assertSuccess=success:false→throw)。両 ref は正しく現挙動と対応するため維持し assert 文言のみ訂正。既存: packages/core/tests/org/org.test.js:619-622 (success:false→throw)

### [ORG-0095] sesame org keys generate-guest-qr: --json 必須・出力封筒 {ok,guestKeyId}
- surface: cli
- backend: cloud
- command: `sesame org keys generate-guest-qr`
- branch: --json 欠落→die(2) | human(guestKeyId 表示) | --json({ok,guestKeyId})
- assert: --json 未指定で org.keys.generateGuestQr.need により die(2) (cli/org.js:749)、指定時は generateGuestQR の返り値 guestKeyId を human(org.keys.generateGuestQr.ok)/JSON({ok:true,guestKeyId}) 双方へ出す (cli/org.js:756-758)
- ref: packages/kit/src/cli/org.js:742-760
- kind: surface-parity
- status: planned
- note: 検証済: cli/org.js:742-760=コマンド全体。die(2)=:749、guestKeyId 取得=:755、human/JSON 出力=:756-758。i18n key generateGuestQr.need/.ok 実在

## deviceEmployeeKeys/list

### [ORG-0096] getDeviceEmployeeKeys の wire: {action:biz3GetDeviceEmployeeKeys, deviceUUID, companyID, limit, op:'get'}
- surface: core
- backend: cloud
- command: `org.getDeviceEmployeeKeys`
- branch: -
- assert: action=biz3GetDeviceEmployeeKeys / deviceUUID,companyID,limit 直置き / op='get' で biz3 useManageGroup と一致
- ref: packages/core/src/org.js:738-744; references_web/src/api/useManageGroup.js:260-275
- kind: wire-fidelity
- status: planned
- note: 検証済: org.js:742=フレーム {action:ACT_DEVICE_EMP_KEYS(=biz3GetDeviceEmployeeKeys), deviceUUID, companyID, limit, op:'get'}。useManageGroup.js:264-269=同一フィールド。action 文字列値=messageConstants.js:13 'biz3GetDeviceEmployeeKeys' で一致。既存: packages/core/tests/org/org.test.js:627-642

### [ORG-0097] getDeviceEmployeeKeys は {list:resp.data, hasMore:resp.hasMore} を返す (hasMore パススルー)
- surface: core
- backend: cloud
- command: `org.getDeviceEmployeeKeys`
- branch: hasMore:true | hasMore:false | hasMore 無し→undefined
- assert: resp.data を list(欠落は [])・resp.hasMore をそのまま返す (org.js:749-752)。biz3 DeviceUserList が setHasMore(resp.hasMore)/resp.data.map の両方を消費する契約に一致 (旧 kit は hasMore を捨てていた)
- ref: packages/core/src/org.js:745-752; references_web/src/components/DeviceUserList.js:29-31
- kind: payload-fidelity
- status: planned
- note: 検証済: org.js:749-752=return {list: resp.data ?? [], hasMore: resp.hasMore}。DeviceUserList.js:29=getDeviceEmployeeKeys,:30=setHasMore(resp.hasMore),:31=resp.data.map で両フィールド消費。旧挙動の捨却は org.js:748 コメント (R2:BIZ-01) が裏付け。既存: packages/core/tests/org/org.test.js:643-657

### [ORG-0098] getDeviceEmployeeKeys limit 既定値 0 (全件) / limit=5 で非管理モード打ち切り
- surface: core, cli
- backend: cloud
- command: `org.getDeviceEmployeeKeys` / `sesame org keys device`
- branch: limit 省略→0(全件) | --limit n
- assert: limit 省略時に 0 がフレームへ入り (org.js:738 既定 limit=0)、CLI --limit は Number(v) 変換で既定 0 (cli/org.js:615)。limit=5 は非管理モード(続きは hasMore)の biz3 挙動に対応 (DeviceUserList isManageMode?0:5)
- ref: packages/core/src/org.js:738; packages/kit/src/cli/org.js:615; references_web/src/components/DeviceUserList.js:55-61
- kind: option-branch
- status: planned
- note: 検証済: org.js:738=シグネチャ limit=0 既定。cli/org.js:615=--limit (v)=>Number(v) 既定 0。DeviceUserList.js:61=getDeviceUser(deviceUUID, isManageMode ? 0 : 5) で管理=全件0/非管理=5。既存(core): packages/core/tests/org/org.test.js:658-662

### [ORG-0099] getDeviceEmployeeKeys 必須検証: deviceUUID / companyID 欠落で badRequest
- surface: core
- backend: cloud
- command: `org.getDeviceEmployeeKeys`
- branch: deviceUUID 欠落→throw | companyID 欠落→throw
- assert: deviceUUID 未指定で 'deviceUUID required'、companyID 未指定で 'companyID required' を throw
- ref: packages/core/src/org.js:739-740; packages/core/src/i18n/org.js:8,17
- kind: error-path
- status: planned
- note: 確認済: org.js:739 throw badRequest('org.req.deviceUUID')、740 'org.req.companyID'。i18n/org.js:8,17 が各 'companyID required'/'deviceUUID required' へ解決。既存テスト org.test.js:663-669 が両 throw を網羅。

### [ORG-0100] sesame org keys device <deviceUUID>: ゲスト sentinel 表示 (guestKeyId.length>0 → [guest]、keyLevel ラベル)
- surface: cli, core
- backend: cloud
- command: `sesame org keys device <deviceUUID>`
- branch: 0件→none表示 | guestKeyId 有→' [guest]' | keyLevel 0/1/2 表示 | --json({ok,count,keys})
- assert: CLI は getDeviceEmployeeKeys の戻り {list,hasMore} を分割代入し list(配列) を反復・件数化すること。各行を lv<keyLevel> + employeeName/subUUID + (guestKeyId.length>0 のとき ' [guest]') で表示、0件は org.keys.device.none、--json は {ok,count,keys:list} で hasMore を出力封筒へ透過する。{list,hasMore} オブジェクト全体を list として扱うと Array.isArray が常に false となり鍵が存在しても常に none/count:0 になる退化を避ける
- ref: packages/core/src/org.js:749-752; packages/kit/src/cli/org.js:618-631; references_web/src/components/DeviceUserList.js:29-31,33,119
- kind: option-branch
- status: planned
- note: 確認済: CLI org.js:626-629 が lv/who/guest を組み立て (628 が k.guestKeyId && String(...).length>0)、620-622 が none、631 が {ok,count,keys}。web ref 修正: guestKeyId.length>0 の sentinel 出典は DeviceUserList.js:119 (user.guestKeyId?.length>0) が正、:33 は keyLevel===2 判定。両行を併記。i18n org.js:193-194 (device.none/found) も整合。実装疑い: cli/org.js:618 が `const list = await hub.org.getDeviceEmployeeKeys(...)` で {list,hasMore}(org.js:749-752, R2:BIZ-01 で hasMore を返すよう変更) を分割代入せず list へ直接代入しているため Array.isArray(list)===false が確定し、鍵が存在しても常に org.keys.device.none・--json は keys:{list,hasMore}/count:0 を返す。DeviceUserList.js:29-31 は resp.data.map/resp.hasMore を別々に消費する正規挙動。assert は正しい挙動(分割代入+hasMore 透過)を規定。実装疑い: CLI keys device の {list,hasMore} 分割代入欠落(別タスクで修正)。dual-audit B が ORG-0097/0098 と連動して検出

## shareUrl/buildUrl

### [ORG-0101] sesame org keys share-url: level=2(guest) のみ generateGuestQR で guestKeyId を発行し secretKey 位置へ差し込む
- surface: cli
- backend: cloud, local
- command: `sesame org keys share-url`
- branch: --level 0/1(secretKey 使用・QR発行なし) | --level 2(generateGuestQR→guestKeyId)
- assert: level∈{0,1,2} 検証、level=2 のときだけ hub.org.generateGuestQR を呼んで guestKeyId を取得し buildShareKeyUrl の secretKey 位置へ入れる (0/1 は deviceKey.secretKey)
- ref: packages/kit/src/cli/org.js:765-813; packages/core/src/sharekey.js:60-106
- kind: option-branch
- status: planned
- note: 確認済: CLI org.js:809-811 が level===2 のみ generateGuestQR、813 が buildShareKeyUrl へ guestKeyId 渡し。sharekey.js ref を 60-106 へ拡張 (関数全体を含む。71 行目 `const secretKey = guestKeyId || deviceKey.secretKey` が secretKey 位置差し込みの load-bearing 行)。

### [ORG-0102] sesame org keys share-url の deviceKey 解決優先順位: --json > --device 検索 > 対話選択
- surface: cli
- backend: cloud, local
- command: `sesame org keys share-url`
- branch: --json 優先 | --device で検索(不在→die2) | 対話選択(0件→die2/キャンセル→return) | いずれも無し→die2
- assert: deviceKey は --json 最優先、無ければ --device で listDevices 検索(不在 die2)、対話可なら selectFromList、不能なら needDeviceOrJson で die2
- ref: packages/kit/src/cli/org.js:780-803
- kind: option-branch
- status: planned
- note: 確認済: 782-784 --json 優先、786-790 listDevices+--device 検索 (790 deviceNotFound die2)、791-798 canPrompt→selectFromList (792 noDevices die2 / 798 cancelled return)、799-801 needDeviceOrJson die2。行範囲そのまま正確。

### [ORG-0103] sesame org keys share-url --level 不正値で exit 2 / --qr は任意依存 qrcode-terminal 未導入を case 案内
- surface: cli
- backend: local
- command: `sesame org keys share-url`
- branch: --level∉{0,1,2}→die(2) | --qr&&qrcode-terminal 未導入→案内文 | --json 時は QR 抑止
- assert: level が 0/1/2 以外で die(2)、--qr 指定かつ非 --json で qrcode-terminal を動的 import し未導入なら qrNotInstalled 文へフォールバック
- ref: packages/kit/src/cli/org.js:775-828
- kind: error-path
- status: planned
- note: 確認済: 776-779 が level∉{0,1,2}→die(2)、818 が cmdOpts.qr && !opts.json で QR 抑止、823 動的 import、825-826 catch→qrNotInstalled フォールバック。i18n org.js:240(badLevel)/246(qrNotInstalled) 整合。

## namespace/exposure

### [ORG-0104] org スライス 7 op が NAMESPACE_OPS に列挙され serve registry が org.<op> を自動公開 (requireAuth 付き)
- surface: serve, core
- backend: cloud
- command: `org.shareDeviceKeysToEmployees` / `org.shareDeviceGroupKeysToEmployeeGroup` / `org.getEmployeeDeviceKeys` / `org.removeEmployeeDeviceKey` / `org.updateGuestKeyTag` / `org.generateGuestQR` / `org.getDeviceEmployeeKeys`
- branch: -
- assert: NAMESPACE_OPS に 7 op が全て載り、registry が `org.<op>` を summary/params/handler 付きで自動登録、handler は requireAuth(daemon) 後に hub.org[op](p) を呼ぶ
- ref: packages/core/src/org.js:856-858; packages/kit/src/serve/registry.js:287-303
- kind: contract-existence
- status: planned
- note: 確認済: NAMESPACE_OPS(配列開始 org.js:848) の 856-858 に 7 op (856 shareDeviceKeysToEmployees〜858 getDeviceEmployeeKeys)。registry.js:288-304 が NS_MODULES×NAMESPACE_OPS をループ自動登録、302 が handler で requireAuth(daemon) 後 hub[ns][op](p)。行範囲正確。

### [ORG-0105] org スライス 7 op が gRPC proto / grpc-methods.generated に 1:1 で存在 (jsonFields・optionalScalars 契約)
- surface: sdk, serve
- backend: cloud
- command: `OrgShareDeviceKeysToEmployees` / `OrgShareDeviceGroupKeysToEmployeeGroup` / `OrgGetEmployeeDeviceKeys` / `OrgRemoveEmployeeDeviceKey` / `OrgUpdateGuestKeyTag` / `OrgGenerateGuestQR` / `OrgGetDeviceEmployeeKeys`
- branch: -
- assert: proto に 7 rpc + Request message が存在し、grpc-methods.generated の jsonFields(items/item/data)・optionalScalars(companyID/subUUID/limit/timeoutMs) が param 形と一致する
- ref: packages/kit/src/serve/sesame.proto:69-81; packages/kit/src/serve/sesame.proto:564-593; packages/kit/src/serve/grpc-methods.generated.json:272-334
- kind: contract-existence
- status: planned
- note: 確認済: proto rpc 7 件 (69,71,73,75,77,79,81)、message 564-593 に 7 Request。generated json ref を 272-327→272-334 へ修正 (272 開始 OrgShareDeviceKeysToEmployees〜334 終端 OrgGetDeviceEmployeeKeys。元範囲は最終 op の optionalScalars limit=331 行を切り落としていた)。jsonFields=items/item/data(getter 2件は空)、optionalScalars に companyID/subUUID/limit/timeoutMs が全て出現し assert と整合。

### [ORG-0106] SDK 生成 params の companyID/subUUID は required:false で daemon 自動注入される (core は必須で throw)
- surface: sdk, serve, core
- backend: cloud
- command: `org.shareDeviceGroupKeysToEmployeeGroup` / `org.getEmployeeDeviceKeys` / `org.getDeviceEmployeeKeys`
- branch: params 省略→daemon 注入(_bindNs companyID/subUUID) | params 明示→そちら優先 | getEmployeeDeviceKeys subUUID 省略→呼び手自身の鍵が返る身元すり替え
- assert: rpc-params.generated は companyID/subUUID を required:false かつ 'auto-injected by the daemon ... when omitted' と注記し、client._bindNs が {companyID,subUUID,...params} を注入するため省略可。一方 core 直叩きは必須 ID 欠落で badRequest を throw する (share-group/getDeviceEmployeeKeys は companyID 欠落、getEmployeeDeviceKeys は subUUID 欠落)。さらに getEmployeeDeviceKeys の subUUID は『照会対象の社員』を指す引数 (org.js:649-650 JSDoc) だが _bindNs は呼び手自身の subUUID を既定注入する (client.js:350) ため、SDK/serve で subUUID 省略時は他社員ではなく呼び手自身の鍵が返る身元すり替えハザードが成立する。よって getEmployeeDeviceKeys では subUUID 明示必須 (省略不可) であることを第一級の assert として検証し、CLI は org keys employee <subUUID> の位置引数で常に明示するため安全であることを確認する
- ref: packages/kit/src/serve/rpc-params.generated.json:795; packages/kit/src/serve/rpc-params.generated.json:822-832; packages/core/src/client.js:333-350; packages/core/src/client.js:350; packages/core/src/org.js:633; packages/core/src/org.js:649-650; packages/core/src/org.js:740; packages/kit/src/cli/org.js:636-640
- kind: surface-parity
- status: planned
- note: ref 修正: rpc-params.generated.json は 1 オブジェクトの pretty-print (旧 :1 は開きブレース) のため対象メソッド行に再アンカー (org.shareDeviceGroupKeysToEmployeeGroup:795, getEmployeeDeviceKeys:822, getDeviceEmployeeKeys:895)。assert 修正: 旧文「companyID 欠落で badRequest」は getEmployeeDeviceKeys に不成立 — 同関数は companyID を取らず subUUID 欠落で throw(org.js:650) のため per-method の必須 ID に訂正。dual-audit B: getEmployeeDeviceKeys の身元すり替え (subUUID 省略→client.js:350 で呼び手自身を注入し自分の鍵を引く) を旧 note 末尾の埋没から branch/assert へ昇格。rpc-params.generated.json:824-832 が org.getEmployeeDeviceKeys.subUUID を required:false かつ daemon 注入と注記する点が当ハザードの根拠

## 監査追補 v2 (dual-audit)

### [ORG-0107] i18n org.keys.* / org.employee.* / org.cmd.* カタログの en/ja 完全性 (ORG-0074 未被覆の最大ファミリ)
- surface: cli
- backend: local
- command: i18n `org.keys.*` / `org.employee.*` / `org.cmd.*`
- branch: en | ja
- assert: org スライスで実使用する t() キーのうち org.keys.*(device/employee/share/shareGroup/rm/updateGuestTag/generateGuestQr/shareUrl 系: desc/opt/need/ok/hint/help/badLevel/qrNotInstalled/deviceNotFound/noDevices/selectPrompt/cancelled/needDeviceOrJson 等)・org.employee.*(ls/me/add/update/rm/reorder/search/confirm の desc/opt/need/ok/hint/none/found/prompt/aborted)・org.cmd.*(org/employee/group/role/deviceGroup/keys) が en/ja 双方で欠落なく定義されること
- ref: packages/kit/src/cli/org.js:766-833; packages/core/src/i18n/org.js:8; packages/core/src/i18n/org.js:254
- kind: i18n
- status: planned
- note: dual-audit A: ORG-0074 は command/assert を org.group.*/org.role.*/org.deviceGroup.*/org.err.uuidsItemsArray に限定し、最大ファミリ org.keys.*(84 キー実在)・org.employee.*(58 キー)・org.cmd.* を未被覆。keys 系は cli/org.js:766-833 (share-url) で help/badLevel/qrNotInstalled/needDeviceOrJson 等 user-facing 文字列が最多。ref は en ブロック先頭(i18n/org.js:8)と ja ブロック先頭(:254)を張る。ORG-0074 とは対象ファミリが排他のため別エントリ新設

### [ORG-0108] sesame org device-group add --uuids 非配列で die(exit 2, org.err.uuidsArray)
- surface: cli
- backend: local
- command: `sesame org device-group add <name> --uuids <json>`
- branch: --uuids 既定'[]' | 明示配列 | 非配列→die(2)
- assert: device-group add の --uuids を parseJson 後 Array.isArray でないとき ctx.die(t('org.err.uuidsArray'),2) で終了コード 2 とし addDeviceGroup を呼ばないこと。i18n キー org.err.uuidsArray が en/ja 双方に定義されること
- ref: packages/kit/src/cli/org.js:483-485; packages/core/src/i18n/org.js:21; packages/core/src/i18n/org.js:267
- kind: error-path
- status: planned
- note: dual-audit A: cli/org.js:485 `if (!Array.isArray(uuids)) { ctx.die(t("org.err.uuidsArray"), 2); return; }` が実在するが spec に org.err.uuidsArray を張るエントリが皆無。ORG-0053 は core 既定 uuids=[] と CLI --uuids 既定'[]'/Array 検証のみで非配列 die(2)・i18n キー org.err.uuidsArray(i18n/org.js:21 en/:267 ja) を欠く。ORG-0066/0067/0068 の jsonArray/uuidsItemsArray/itemsArray die 系と対称に専用 die 経路を 1 エントリ起票

### [ORG-0109] group/deviceGroup 9 op の companyID 必須検証 (badRequest, send 前)
- surface: core
- backend: local
- command: `addEmployeeGroup` / `updateEmployeeGroup` / `addEmployeeInGroup` / `removeEmployeeInGroup` / `removeEmployeeGroupBindDeviceGroup` / `addDeviceGroup` / `updateDeviceGroup` / `addDeviceInGroup` / `removeDeviceGroupBindUserGroup`
- branch: companyID 欠落→throw (send 前)
- assert: 上記 9 op は client.request より前に `if (!companyID) throw badRequest('org.req.companyID')` を実行し WS 送信しないこと。biz3 参照は companyID 無しで return(no-op) するが kit は明示エラー化する純ローカル付加契約
- ref: packages/core/src/org.js:268; packages/core/src/org.js:286; packages/core/src/org.js:341; packages/core/src/org.js:359; packages/core/src/org.js:380; packages/core/src/org.js:477; packages/core/src/org.js:494; packages/core/src/org.js:533; packages/core/src/org.js:589
- kind: error-path
- status: planned
- note: dual-audit B: org.js:268/286/341/359/380/477/494/533/589 が全て request 前に badRequest('org.req.companyID') を throw する load-bearing ガード。既存 companyID error-path は ORG-0006/0017/0035/0050/0081/0099 のみで、これら 9 op は wire-fidelity エントリ(ORG-0036/0038/0043/0044/0046/0052/0054/0057/0062)に在るが branch=companyID欠落 を error-path として assert していない。リグレッション検出のため一括 1 エントリ起票

### [ORG-0110] removeEmployeeGroupBindDeviceGroup の gid 必須検証 (badRequest, send 前)
- surface: core
- backend: local
- command: `removeEmployeeGroupBindDeviceGroup`
- branch: gid 欠落→throw (send 前)
- assert: removeEmployeeGroupBindDeviceGroup は client.request より前に必須 ID (gid) を検証し、欠落時は WS 送信せず badRequest('org.req.gid') を throw すること
- ref: local-contract
- kind: error-path
- status: planned
- note: dual-audit: ORG-0046 (wire-fidelity) は cid+...data 直置き/op:removeBindDeviceGroup のフレーム形のみを assert し必須 ID 検証の error-path branch を欠く。ORG-0042/0061 (各 get*Bind* の gid 必須) と対称の純ローカル付加契約。実装行の確定は別途行うため ref は local-contract

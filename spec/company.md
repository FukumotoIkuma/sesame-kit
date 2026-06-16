<!-- spec-domain: company | prefix: CO | tests: packages/core/tests/company, packages/kit/tests/cli -->

# 会社管理 spec (CO)

company.* (会社一覧/改名/追加/支払い設定取得) と companyID 優先解決を監査する。

## priorityCompany / companyID 解決

### [CO-0001] priorityCompany 非 isSesameApp 経路 (companyID 一致 company の subscriptionId 合成)
- surface: core
- backend: local
- command: `account.priorityCompany`
- branch: 非isSesameApp(一致有) | 非isSesameApp(一致無→subscriptionId undefined)
- assert: 非 isSesameApp の priorityCompany subscriptionId 合成 (companyID 一致探索)。重複につき [[AUTH-0091]] を正典
- ref: local-contract
- kind: contract-existence
- status: waived: 重複（正典 [[AUTH-0091]]）
- note: 正典 spec/auth.md AUTH-0091 が account.js:144-182 全体 (priorityCompany 3 分岐 + priorityCompanyId + 候補無し {} 逸脱) を一括所有。account.js は auth ドメイン所有 (getLoginUser=AUTH-0087/0088, refreshAccount=AUTH-0089, newTags/PAGE_NAMES/ALL_TAGS=AUTH-0090) が確立済み。契約テストは AUTH-0091 に一本化し本 ID は欠番にせず参照ポインタとして保持。

### [CO-0002] priorityCompany isSesameApp 経路 (rootUser 優先→level 最大→候補無 {})
- surface: core
- backend: local
- command: `account.priorityCompany`
- branch: companies 空→{} | isRootUser 有 | rootUser 無→level 最大 | 候補無→{}(逸脱)
- assert: isSesameApp の priorityCompany 選定 (companies 空→{}, rootUser 優先, 無ければ level 最大, 候補皆無→{} 意図的逸脱)。重複につき [[AUTH-0091]] を正典
- ref: local-contract
- kind: contract-existence
- status: waived: 重複（正典 [[AUTH-0091]]）
- note: 正典 spec/auth.md AUTH-0091 が account.js:144-182 全体 (priorityCompany 3 分岐 + 候補無し {} 逸脱) を一括所有。意図的逸脱 (候補無しで {}; account.js:152,166 vs web null.feeLevel TypeError) も AUTH-0091 が網羅。契約テストは AUTH-0091 に一本化し本 ID は欠番にせず参照ポインタとして保持。

### [CO-0003] priorityCompanyId は priorityCompany.companyID (無ければ null)
- surface: core
- backend: local
- command: `account.priorityCompanyId`
- branch: companyID 有 | 無→null
- assert: priorityCompanyId は priorityCompany?.companyID ?? null (company 系 op の既定 companyID 一次計算)。重複につき [[AUTH-0091]] を正典
- ref: local-contract
- kind: contract-existence
- status: waived: 重複（正典 [[AUTH-0091]]）
- note: 正典 spec/auth.md AUTH-0091 が account.js:144-182 全体 (priorityCompanyId 含む) を一括所有。本 ID は company op の既定 companyID 一次計算という位置づけ (kit/src/cli/company.js:22-26 が裏付け) を残すための参照ポインタ。契約テストは AUTH-0091 に一本化し欠番にしない。

## namespace 結線

### [CO-0004] NAMESPACE_OPS allowlist が 4 op 限定 (getLoginUser は account.js へ分離)
- surface: core
- backend: local
- command: `company.NAMESPACE_OPS`
- branch: -
- assert: company.js の NAMESPACE_OPS が ['getCompanies','updateCompanyName','addCompany','getPaymentConfig'] の 4 件のみで、biz3GetLoginUser (account.js) を含まない (biz3ManageCompany 4 op の境界)
- ref: packages/core/src/company.js:152; packages/core/src/account.js:47; references_web/src/api/useStripeInfo.js:156-185
- kind: contract-existence
- status: covered
- note: company.js:152 に 4 op を確認。getLoginUser は account.js:47 (BIZ3_GET_LOGIN_INFO) に分離され company.js に不在を確認。getLoginUser が account.js 側である正の証拠として account.js:47 を ref に追加。

### [CO-0005] hub.company.* が companyID/subUUID を自動注入 (params で上書き可)
- surface: core
- backend: cloud
- command: `hub.company.getPaymentConfig` / `hub.company.updateCompanyName`
- branch: 注入既定 | params で明示上書き
- assert: _bindNs が company の各 op を fn(ws,{companyID,subUUID,...params}) でラップし、companyID 既定注入・params.companyID 明示時は上書きされること (getPaymentConfig/updateCompanyName が companyID を params 経由で受ける整合)
- ref: packages/core/src/client.js:333-353; packages/core/src/client.js:360; packages/core/src/company.js:138-141
- kind: option-branch
- status: covered
- note: company の companyID は params.companyID (client.js:350 の {companyID,subUUID,...params} で params が後勝ち)。payment 系の customerId 注入とは別 (company 側は companyID 直)。ref を分割: _bindNs 本体 333-353, company getter 360。

## getCompanies

### [CO-0006] getCompanies → biz3ManageCompany get フレーム (フラット, companyID/email 無し)
- surface: core
- backend: cloud
- command: `company.getCompanies`
- branch: -
- assert: 送信フレームが {action:'biz3ManageCompany', op:'get'} のフラット形で、companyID/email/obj を一切含まない (web getCompanies と完全一致)
- ref: references_web/src/api/useStripeInfo.js:77-81; packages/core/src/company.js:52-57
- kind: wire-fidelity
- status: covered
- note: 検証: web getCompanies フレーム (useStripeInfo.js:77-80 の {action:BIZ3_MANAGE_COMPANY, op:'get'}) と core (company.js:53) が一致。obj/companyID/email 無し。company.test.js に同境界のテストは存在するが [ID] タグ未付与のため _format.md §5 上 covered 要件を満たさず planned 維持。

### [CO-0007] getCompanies 応答パース (message.data 配列をそのまま返す / 非配列は [])
- surface: core
- backend: cloud
- command: `company.getCompanies`
- branch: data=配列 | data=非配列/欠落
- assert: 応答 message.data が配列ならそのまま返し、配列でなければ [] を返す (web handleCompaniesResponse 'get' case の setCompanies(message.data) と同じく obj ラップしない)
- ref: references_web/src/api/useStripeInfo.js:161-165; packages/core/src/company.js:53-56
- kind: payload-fidelity
- status: covered
- note: 検証: 'get' case (useStripeInfo.js:163 setCompanies(message.data)) は data を配列としてそのまま設定。core (company.js:56) は Array.isArray ガードで非配列を [] に正規化 (web より堅牢、obj ラップしない点は一致)。

### [CO-0008] getCompanies 応答要素フィールド集合 (companyID/name/feeLevel/tag/isSesameApp/employeeEmail; subUUID は要素では未確認)
- surface: core
- backend: cloud
- command: `company.getCompanies`
- branch: -
- assert: 応答配列各要素が feeLevel{subscriptionId,isRootUser,level}/tag[]/isSesameApp/employeeEmail/companyID を保持し、後続 priorityCompany/updateName/getPaymentConfig の一次データとして読める形であること
- ref: references_web/src/api/useStripeInfo.js:41-71; references_web/src/api/useStripeInfo.js:277; packages/core/src/account.js:40-46
- kind: payload-fidelity
- status: covered
- note: 検証: companyID/feeLevel.subscriptionId/feeLevel.isRootUser/feeLevel.level/isSesameApp/tag[0] は priorityCompany が company 要素から読む実フィールド。employeeEmail は priorityCompany.employeeEmail(:277) で読まれ isSesameApp 時 priorityCompany=company 要素 spread のため要素フィールドとして整合。未確認: subUUID は useStripeInfo.js 内で company 要素から読まれず、常に customerInfo.subUUID (biz3GetLoginUser 応答) 由来 (layout/index.js:303 が addCompany へ渡す)。getCompanies 応答要素に subUUID が含まれる証拠は無いため assert から除外。

### [CO-0009] getCompanies success:false 拒否 → throw
- surface: core
- backend: cloud
- command: `company.getCompanies`
- branch: success:false
- assert: 応答 success:false のとき assertSuccess が 'getCompanies failed: <message>' で throw する (web は setCompanies しないだけだが lib は明示エラー化)
- ref: packages/core/src/company.js:54; packages/core/src/util.js:34-43
- kind: error-path
- status: covered
- note: 検証: company.js:54 が assertSuccess(resp,'getCompanies') を呼び、util.js:35 の lenient 判定 (resp.success===false で failed) → :37-40 で SesameError(code=rejected) を throw。文言は i18n 'domain.util.opFailed'='{op} failed: {detail}' (i18n/domain.js:110) かつ detail=resp.message のため 'getCompanies failed: <message>'。

## updateCompanyName

### [CO-0010] updateCompanyName → updateName フレーム (companyID/name を obj にネスト)
- surface: core
- backend: cloud
- command: `company.updateCompanyName`
- branch: -
- assert: 送信フレームが {action:'biz3ManageCompany', obj:{companyID,name}, op:'updateName'} で、companyID/name をトップレベルに置かず必ず obj 内に入れる (web updateCompanyName と一致)
- ref: references_web/src/api/useStripeInfo.js:293-305; packages/core/src/company.js:76-87
- kind: wire-fidelity
- status: covered
- note: 検証: web (useStripeInfo.js:296-300) はフレーム {action:BIZ3_MANAGE_COMPANY, obj:{companyID,name}, op:'updateName'} で companyID/name を obj にネスト。core (company.js:79-82) も同形。トップレベルに companyID/name を置かない点一致。

### [CO-0011] updateCompanyName 応答 data {companyID,name} を返す / 欠落時 undefined (捏造しない)
- surface: core
- backend: cloud
- command: `company.updateCompanyName`
- branch: data 有り | data 欠落
- assert: 応答 message.data === {companyID,name} をそのまま返し、data 欠落時は入力値で補完せず undefined (web も message.data をそのまま読み補完しない)
- ref: references_web/src/api/useStripeInfo.js:166-174; packages/core/src/company.js:84-86
- kind: payload-fidelity
- status: covered
- note: BIZ-10: 応答の捏造禁止。検証: web 'updateName' case (useStripeInfo.js:170-171) は message.data.companyID/message.data.name を直接読み、入力値で補完しない。core (company.js:86) は resp.data をそのまま返し欠落時 undefined。

### [CO-0012] updateCompanyName 必須検証 (companyID 必須 / name は null・undefined のみ拒否, 空文字許容)
- surface: core
- backend: cloud
- command: `company.updateCompanyName`
- branch: companyID 欠落 | name=null | name='' (許容)
- assert: companyID 欠落で badRequest('company.err.companyIDRequired'), name==null で badRequest('company.err.nameRequired'), name='' は送信許容 (web は priorityCompanyId 由来 companyID 前提・name は無検証)
- ref: packages/core/src/company.js:77-78; references_web/src/api/useStripeInfo.js:293-305
- kind: error-path
- status: covered
- note: 検証: company.js:77 (!companyID→badRequest companyIDRequired), :78 (name==null→badRequest nameRequired, 空文字は name==null が false のため通過)。i18n: company.err.companyIDRequired='companyID required', company.err.nameRequired='name required' (i18n/company.js:19-20)。web (useStripeInfo.js:295,298) は companyID=priorityCompanyId 前提で name 無検証のため、core が明示バリデーションを追加 (web の負の証拠で整合)。

## addCompany

### [CO-0013] addCompany → add フレーム (name/employeeEmail/subUUID をフラット展開, obj/companyID 無し)
- surface: core
- backend: cloud
- command: `company.addCompany`
- branch: -
- assert: 送信フレームが {action:'biz3ManageCompany', name, employeeEmail, subUUID, op:'add'} とフラットで、obj ラップ無し・companyID 無し (web addCompany 引数順 name,employeeEmail,subUUID と一致)
- ref: references_web/src/api/useStripeInfo.js:307-320; references_web/src/components/biz/layout/index.js:300-309; packages/core/src/company.js:108-119
- kind: wire-fidelity
- status: covered
- note: 検証済: useStripeInfo.js:307-320 が {action, name, employeeEmail, subUUID, op:'add'} フラット送信、layout/index.js:300-309 が gStripe.addCompany(name, customerInfo.employeeEmail, customerInfo.subUUID, cb)、core company.js:113 が {action:ACT_COMPANY, name, employeeEmail, subUUID, op:'add'} で 1:1 一致。

### [CO-0014] addCompany 引数の出所 (employeeEmail/subUUID は login customerInfo 由来)
- surface: core, cli
- backend: cloud
- command: `company.addCompany` / `sesame company add <name>`
- branch: -
- assert: CLI add が name に加え customerInfo.employeeEmail/subUUID を渡す経路で、web layout/index.js が gStripe.customerInfo.employeeEmail/subUUID を渡すのと同じ出所であること
- ref: references_web/src/components/biz/layout/index.js:300-309; packages/kit/src/cli/company.js:80-93
- kind: wire-fidelity
- status: covered
- note: 検証済: layout/index.js:302-303 が gStripe.customerInfo.employeeEmail/subUUID を渡し、cli/company.js:84-85 が withAccount 供給の customerInfo.employeeEmail/subUUID を取り 91-93 で addCompany({name, employeeEmail, subUUID}) を呼ぶ。出所一致。withAccount の customerInfo 供給契約は ctx.js:186。

### [CO-0015] addCompany 必須検証 (name/employeeEmail/subUUID すべて必須)
- surface: core
- backend: cloud
- command: `company.addCompany`
- branch: name 欠落 | employeeEmail 欠落 | subUUID 欠落
- assert: name/employeeEmail/subUUID いずれか欠落で対応 badRequest を throw (web は無検証だが lib は customerInfo 補完前提を保護)
- ref: packages/core/src/company.js:109-111; references_web/src/api/useStripeInfo.js:307-320
- kind: error-path
- status: covered
- note: 検証済: company.js:109-111 に三重ガード (nameRequired/employeeEmailRequired/subUUIDRequired)。i18n キーは i18n/company.js:20-22,42-44 に実在。web (useStripeInfo.js:307-320) は無検証で対比成立。

### [CO-0016] addCompany subUUID required の core↔SDK/proto 不一致 (core 必須 vs 生成 optional)
- surface: core, sdk, serve
- backend: cloud
- command: `company.addCompany`
- branch: subUUID 明示 | subUUID 省略(daemon 補完)
- assert: core addCompany は subUUID 欠落で throw する一方、rpc-params/proto/SDK は subUUID を required:false (daemon が account から自動注入) と宣言する境界整合 — serve 経由では補完で成立し core 直叩きでは必須、の差異を固定する
- ref: packages/core/src/company.js:111; packages/kit/src/serve/rpc-params.generated.json:984-992; packages/kit/src/serve/sesame.proto:603-608; packages/kit/sdk/ts/sesame-client.ts:375
- kind: surface-parity
- status: covered
- note: rpc-params の subUUID entry は 984-992 (name:985 / required:false:986 / desc 'auto-injected by the daemon from the logged-in account when omitted':991)。proto:606 optional string subUUID、sdk-client.ts:375 subUUID?。name/employeeEmail は rpc-params required:true・proto 非 optional。core company.js:111 は subUUID 欠落で throw。境界差異が確かに存在。

### [CO-0017] addCompany 応答 data (新規 company) を返す / 欠落時 null
- surface: core
- backend: cloud
- command: `company.addCompany`
- branch: data 有り | data 欠落
- assert: 応答 message.data (新規 company) をそのまま返し、欠落時 null (web は setCompanies(prev=>[...prev, message.data]) で push のみ、個別フィールドは未読出)
- ref: references_web/src/api/useStripeInfo.js:175-179; packages/core/src/company.js:116-118
- kind: payload-fidelity
- status: covered
- note: 検証済: useStripeInfo.js:177 case 'add' で setCompanies(prev=>[...prev, message.data]) の push のみ・個別フィールド未読出、company.js:118 が resp.data ?? null を返す。add 応答 data の個別フィールドは biz3 で読み出されておらず詳細未確認 (push のみ)。

## getPaymentConfig

### [CO-0018] getPaymentConfig → getPaymentConfig フレーム (companyID をトップレベルに置く)
- surface: core
- backend: cloud
- command: `company.getPaymentConfig`
- branch: -
- assert: 送信フレームが {action:'biz3ManageCompany', companyID:<priorityCompanyId>, op:'getPaymentConfig'} で companyID は obj ラップせずトップレベル (web getLevelConfig と一致)
- ref: references_web/src/api/useStripeInfo.js:322-334; packages/core/src/company.js:138-144
- kind: wire-fidelity
- status: covered
- note: 検証済: useStripeInfo.js:325-329 が {action, companyID:customerId, op:'getPaymentConfig'} をトップレベルで送信、company.js:141 が {action:ACT_COMPANY, companyID, op:'getPaymentConfig'} で obj ラップ無し一致。

### [CO-0019] getPaymentConfig 応答ルーティング (switch case 無し→invokeCallbacks 委譲)
- surface: core
- backend: cloud
- command: `company.getPaymentConfig`
- branch: -
- assert: getPaymentConfig は handleCompaniesResponse の switch に case が無く invokeCallbacks(message) で op 単位コールバックへ届く経路であり、lib は同 action+op 一致応答待ち (client.request) で受けて成立すること
- ref: references_web/src/api/useStripeInfo.js:156-159; references_web/src/api/useStripeInfo.js:331; packages/core/src/company.js:129-133
- kind: wire-fidelity
- status: covered
- note: 検証済: handleCompaniesResponse の switch (useStripeInfo.js:160-182) に getPaymentConfig case 無し、invokeCallbacks(message) は :159、registerCallback(action,'getPaymentConfig',cb) は :331。core company.js:129-133 (JSDoc) が同経路と client.request 同期受けを宣言、実装 :140-143 が action+op 一致応答待ち。

### [CO-0020] getPaymentConfig 応答 data 形状 {config,isYear,time,total,level,nextPrice,nextEndDate}
- surface: core
- backend: cloud
- command: `company.getPaymentConfig`
- branch: data 有り | data 欠落
- assert: 応答 data をそのまま返し (consumer は setPaymentConfig({...res.data}))、欠落時 null。consumer 既定形 {config,isYear,time,total,level} に加え nextPrice (settings/index.js:280) と nextEndDate (settings/index.js:169,171) も読み出される確定フィールドであり、core getPaymentConfig の戻り型 cast (company.js:146) も nextEndDate を含むべき
- ref: references_web/src/pages/biz/settings/index.js:60-66; references_web/src/pages/biz/settings/index.js:91-95; references_web/src/pages/biz/settings/index.js:169-174; references_web/src/pages/biz/settings/index.js:280; packages/core/src/company.js:136; packages/core/src/company.js:146
- kind: payload-fidelity
- status: covered
- note: 応答 data 内部の厳密集合は実機検証要 (waived 相当だが core 戻り形の cast 境界は静的検証可)。60-66/91-95 は nextPrice/nextEndDate を含まず、それらは :280/:169-171 で初めて読まれるため ref を追加。実装疑い: core getPaymentConfig の戻り型 cast (company.js:146 / JSDoc :136) は {config,isYear,time,total,level,nextPrice} までで nextEndDate を欠き、web が確実に読む settings/index.js:169-171 の nextEndDate を型境界が落としている。cast を nextEndDate 込みへ揃えること (別タスクで修正)。

### [CO-0021] getPaymentConfig 必須検証 (companyID 必須)
- surface: core
- backend: cloud
- command: `company.getPaymentConfig`
- branch: companyID 欠落
- assert: companyID 欠落で badRequest('companyID required') を throw (web は priorityCompanyId が null だと companyID:null で送るが lib は明示拒否)
- ref: packages/core/src/company.js:139; references_web/src/api/useStripeInfo.js:322-329
- kind: error-path
- status: covered
- note: company.js:139 は i18n key ではなくリテラル 'companyID required' を badRequest に渡す (updateName の company.err.companyIDRequired とは別経路) — assert のリテラルと一致。web 側 getLevelConfig は customerId=priorityCompanyId を null ガード無しで companyID に載せる (useStripeInfo.js:324-328)。

## CLI (sesame company)

### [CO-0022] sesame company ls 出力整形 (件数文言・owner タグ・--json 封筒)
- surface: cli
- backend: cloud
- command: `sesame company ls`
- branch: --json | human(0件) | human(1件) | human(複数) | owner タグ
- assert: human 出力で 0件は none, 1件/複数で found.one/many、--json では {ok,count,companies} 封筒を返す。owner タグは一覧の各要素 c について Array.isArray(c.tag)&&c.tag[0]==='オーナー' を個別評価する per-element 付与 (CLI 拡張)。tag[0]==='オーナー' の文字列基準は web の newTags(useStripeInfo.js:33-34) と同一だが、web の isOwner(:69-71) は priorityCompany 単一会社のみを判定する別スコープであり per-element 注記の直接移植元ではない
- ref: packages/kit/src/cli/company.js:38-58; references_web/src/api/useStripeInfo.js:33-34; references_web/src/api/useStripeInfo.js:69-71
- kind: option-branch
- status: covered
- note: cli/company.js:43-56 に none/found.one/found.many 分岐, :53 に Array.isArray(c.tag)&&c.tag[0]==='オーナー'→ownerTag を for ループ内 (49-54) で各 company に per-element 適用, :56 に {ok,count,companies} 封筒を確認。文字列基準 tag[0]==='オーナー' の根拠は newTags (useStripeInfo.js:33-34)。useStripeInfo.js:69-71 の isOwner は priorityCompany?.tag[0]==='オーナー' で優先会社 1 件のみ判定する useMemo であり一覧全要素注記の移植元ではない (scope 差: CLI=全要素 per-element / web isOwner=単一 priorityCompany)。per-element 付与は CLI 拡張。

### [CO-0023] sesame company rename <name> (companyID 自動注入・出力封筒)
- surface: cli
- backend: cloud
- command: `sesame company rename <name>`
- branch: --json | human
- assert: rename が withAccount(refreshAccount 済 companyID 注入)で updateCompanyName({name}) を呼び、human は rename.ok、--json は {ok,company} を返す (companyID は明示せず namespace 注入)
- ref: packages/kit/src/cli/company.js:60-74; packages/kit/src/cli/ctx.js:219-223
- kind: option-branch
- status: covered
- note: cli/company.js:68 で updateCompanyName({name}) を companyID 無指定で呼び (namespace 注入依存), :71 rename.ok / :72 {ok,company} 封筒を確認。withAccount→refreshAccount→companyID 注入は ctx.js:219-223。

### [CO-0024] sesame company add <name> (customerInfo 欠落で die / 出力封筒)
- surface: cli
- backend: cloud
- command: `sesame company add <name>`
- branch: customerInfo 完備 | employeeEmail/subUUID 欠落→die(1)
- assert: add が withAccount の customerInfo から employeeEmail/subUUID を取り、欠落時 ctx.die(missingCustomerInfo,1) で終了コード 1、完備時 addCompany を呼び --json は {ok,company} を返す
- ref: packages/kit/src/cli/company.js:77-99; packages/kit/src/cli/ctx.js:219-223; references_web/src/components/biz/layout/index.js:300-303
- kind: error-path
- status: covered
- note: cli/company.js:84-89 で customerInfo.employeeEmail/subUUID を取り欠落時 ctx.die(...,1) (company.js:87), 完備時 :92 addCompany, :97 {ok,company} を確認。customerInfo は ctx.js:219-223 の withAccount が refreshAccount() 戻りで供給。web の引数源 (customerInfo.employeeEmail/subUUID) を裏取りする layout/index.js:300-303 を ref 追加。

### [CO-0025] sesame company payment (config null 文言・JSON 整形)
- surface: cli
- backend: cloud
- command: `sesame company payment`
- branch: --json | human(config 有) | human(config null)
- assert: payment が getPaymentConfig() を呼び、config==null で payment.none 文言、非 null で JSON.stringify 整形、--json では {ok,paymentConfig} 封筒を返す
- ref: packages/kit/src/cli/company.js:101-117
- kind: option-branch
- status: covered
- note: 検証済 (company.js:102-117 payment command)。config==null→t('company.payment.none') (109-111)、非 null→JSON.stringify(config,null,2) (114)、out 第3引数 {ok:true,paymentConfig:config} (115)。

## serve registry / stability

### [CO-0026] serve registry が company.* 4 op を NAMESPACE_OPS から自動公開 (requireAuth 付き)
- surface: serve
- backend: cloud
- command: `company.getCompanies` / `company.updateCompanyName` / `company.addCompany` / `company.getPaymentConfig`
- branch: -
- assert: buildRegistry が NS_MODULES.company の NAMESPACE_OPS から company.<op> を登録し、各ハンドラが requireAuth 後に hub.company[op](params) へ委譲する (4 op が registry に 1:1 で存在)
- ref: packages/kit/src/serve/registry.js:97; packages/kit/src/serve/registry.js:287-305; packages/core/src/company.js:152
- kind: contract-existence
- status: covered
- note: 検証済。registry.js:97 NS_MODULES に company を含む。:287-305 のループが各 ns の NAMESPACE_OPS を反復し reg.set(`${ns}.${op}`) (297)・handler は requireAuth(daemon) 後 hub[ns][op](p) (302)。company.js:152 NAMESPACE_OPS = 4 op。

### [CO-0027] company.* は STABLE_METHODS 非掲載 = experimental 安定性
- surface: serve
- backend: cloud
- command: `company.getCompanies` / `company.getPaymentConfig`
- branch: -
- assert: stabilityOf('company.*') が 'experimental' を返す (STABLE_METHODS に company op が無い) — discover/契約面で company 系が experimental と表明されること
- ref: packages/kit/src/serve/stability.js:19-33; packages/kit/src/serve/stability.js:57-59
- kind: contract-existence
- status: covered
- note: 検証済。STABLE_METHODS は stability.js:19-33 (閉じ `};` が 33 行) で company op を一切含まない。stabilityOf は :57-59 で has(STABLE_METHODS,name) 不一致時 'experimental' を返す。

## SDK / proto parity

### [CO-0028] 生成 SDK (ts/py) に company 4 メソッドが存在し param 形が一致
- surface: sdk
- backend: cloud
- command: `company.getCompanies` / `company.updateCompanyName` / `company.addCompany` / `company.getPaymentConfig`
- branch: ts | py
- assert: ts/py SDK の _Company が 4 メソッドを持ち、param 名/必須 (addCompany: name,employeeEmail required・subUUID optional; updateCompanyName: name required・companyID optional; getPaymentConfig: companyID optional) が rpc-params と一致して company.<op> を _call すること
- ref: packages/kit/sdk/ts/sesame-client.ts:373-382; packages/kit/sdk/python/sesame_client.py:725-743; packages/kit/src/serve/rpc-params.generated.json:930-1019
- kind: surface-parity
- status: covered
- note: 検証済。ts company ブロックは 373-382 (updateCompanyName が 381、閉じ `};` が 382)。py _Company は 725-743。rpc-params: getCompanies(timeoutMs opt)・updateCompanyName(companyID opt,name req,timeoutMs opt)・addCompany(name req,employeeEmail req,subUUID opt,timeoutMs opt)・getPaymentConfig(companyID opt,timeoutMs opt) = SDK の required と一致。subUUID は daemon 自動注入のため SDK/wire 上 optional (core は required だがそれは別層)。

### [CO-0029] proto CompanyRequest メッセージの必須/optional が core 契約と一致
- surface: sdk, serve
- backend: cloud
- command: `Company* rpc (grpc framing)`
- branch: -
- assert: sesame.proto の CompanyGetCompaniesRequest(timeoutMs optional)/CompanyUpdateCompanyNameRequest(name required,companyID optional)/CompanyAddCompanyRequest(name,employeeEmail required,subUUID optional)/CompanyGetPaymentConfigRequest(companyID optional) が rpc-params 由来の必須性と一致すること
- ref: packages/kit/src/serve/sesame.proto:595-612; packages/kit/src/serve/grpc-methods.generated.json:335-365
- kind: surface-parity
- status: covered
- note: 検証済。proto:595-612 に 4 message が存在し optional マーカが assert 通り (GetCompanies timeoutMs opt / UpdateCompanyName name 必須 companyID opt / AddCompany name,employeeEmail 必須 subUUID opt / GetPaymentConfig companyID opt)。grpc-methods.generated.json:335-365 の optionalScalars が proto の optional と一致 (Company* 4 ブロック)。

## i18n カタログ

### [CO-0030] company.* カタログの ja ロケール未翻訳 (出力文言が英語のまま残る)
- surface: cli, core
- backend: local
- command: `company.ls.none` / `company.ls.found.one` / `company.rename.ok` 他
- branch: en | ja
- assert: company.js i18n の ja 側で ls.none/ls.found.one/ls.found.many/rename.ok/add.ok/err.companyIDRequired/err.nameRequired の 7 キーが en と同一英文のまま (= 未翻訳) であることを検出し、ja 翻訳の完全性ギャップを固定する
- ref: packages/core/src/i18n/company.js:24-45; packages/core/src/i18n/company.js:2-23
- kind: i18n
- status: covered
- note: 検証済 (en 2-23 / ja 24-45 差分): 未翻訳=en===ja は ls.none/ls.found.one/ls.found.many/rename.ok/add.ok/err.companyIDRequired/err.nameRequired の 7 キーのみ。翻訳済は cmd.desc/ls.desc/rename.desc/add.desc/payment.desc/ls.ownerTag/add.missingCustomerInfo/payment.none に加え err.employeeEmailRequired/err.subUUIDRequired (ja は "login ユーザの customerInfo 由来")。

### [CO-0031] company.* カタログのキー集合 en↔ja 完全一致 (欠落/孤立キー無し)
- surface: core
- backend: local
- command: `i18n company catalog`
- branch: -
- assert: company.js の en と ja が同一キー集合 (CLI が参照する全 company.* キーを両ロケールが持つ) で、片側欠落キーが無いこと
- ref: packages/core/src/i18n/company.js:1-46; packages/kit/src/cli/company.js:35-114
- kind: i18n
- status: covered
- note: 検証済: en/ja とも 17 キーで完全一致 (en-only=[], ja-only=[])。CLI 参照は kit/src/cli/company.js:35-114 の registerCompanyCommands 内 t("company.*") 呼び出し群 (35=cmd.desc … 114=payment 系) が全キーを網羅。

## 監査追補 v2 (dual-audit)

### [CO-0032] getCompanies の isFromApp 送信抑止は lib 非移植 (web は fromType=app で get を送らない負の事実)
- surface: core, cli
- backend: cloud
- command: `company.getCompanies` / `sesame company ls`
- branch: isFromApp(送信抑止) | 通常(送信)
- assert: web getCompanies は searchParams fromType==='app' のとき早期 return し biz3ManageCompany/get フレームを送らない (useStripeInfo.js:74-76)。lib/CLI は UI コンテキスト (searchParams) を持たず常に get を送る — この isFromApp 分岐を意図的に再現しない (UI 層専用ガード) 負の事実を固定する
- ref: references_web/src/api/useStripeInfo.js:18; references_web/src/api/useStripeInfo.js:73-82; packages/core/src/company.js:52-57
- kind: option-branch
- status: covered
- note: web useStripeInfo.js:74-76 に if(isFromApp){return} 早期 return (isFromApp=searchParams.get('fromType')==='app' :18)。core getCompanies (company.js:52-57) はガード無しで無条件 client.request({action,op:'get'})。CO-0006 (送信フレーム形) を補完する送信条件分岐の negative fact。kit は fromType 概念を持たないため非移植が正当。A+B consensus (A=option-branch surface=[core,cli] / B=wire-fidelity surface=[core]、指す境界は同一)。CO-0036 (login→getCompanies lifecycle 連鎖) とは別境界。

### [CO-0033] updateCompanyName/addCompany/getPaymentConfig の success:false 拒否 (assertSuccess→rejected throw)
- surface: core
- backend: cloud
- command: `company.updateCompanyName` / `company.addCompany` / `company.getPaymentConfig`
- branch: updateName success:false | add success:false | getPaymentConfig success:false
- assert: updateCompanyName(company.js:83)/addCompany(company.js:116)/getPaymentConfig(company.js:144) はいずれも assertSuccess(resp, op) を呼び、resp.success===false で SesameError(code=rejected, retryable=false, message='<op> failed: <message>') を throw する。web は handleCompaniesResponse の各 case が if(message.success) ガードのみで else 無し=success:false を黙って no-op する負の証拠であり、lib の明示エラー化を境界として固定する
- ref: packages/core/src/company.js:83; packages/core/src/company.js:116; packages/core/src/company.js:144; packages/core/src/util.js:34-41; packages/core/src/i18n/domain.js:110; references_web/src/api/useStripeInfo.js:166-179
- kind: error-path
- status: covered
- note: company.js に assertSuccess 呼び出しが 4 箇所 (:54,:83,:116,:144) あるが既存 error-path は CO-0009 (getCompanies) のみ。util.js:35-40 lenient 判定 (resp.success===false で failed) → SesameError(ERR.REJECTED)、文言は i18n 'domain.util.opFailed'='{op} failed: {detail}' (domain.js:110)。web 側 handleCompaniesResponse は updateName(:167)/add(:176) とも if(message.success) のみで else 無し=失敗時無反応 (負の事実)。getPaymentConfig は web に switch case が無く invokeCallbacks 委譲 (CO-0019) のため success:false の扱いが特に未固定。

### [CO-0034] company 4 op の応答待ちタイムアウト経路 (transport timeoutErr / TRANSPORT_TIMEOUT)
- surface: core
- backend: cloud
- command: `company.getCompanies` / `company.updateCompanyName` / `company.addCompany` / `company.getPaymentConfig`
- branch: 応答無し→timeout
- assert: company の 4 op はいずれも client.request(frame, timeoutMs=DEFAULT_TIMEOUT_MS=10_000) の直呼び (subscribeChunks 非経由) のため、応答が来ない場合 transport.js の timeoutErr (code=TRANSPORT_ERR.TIMEOUT, message=domain.transport.requestTimeout) で reject される。DEFAULT_TIMEOUT_MS=10s と timeout 経路を固定する
- ref: packages/core/src/company.js:32; packages/core/src/company.js:53; packages/core/src/transport.js:271-273; packages/core/src/transport.js:79
- kind: error-path
- status: covered
- note: company.js:32 DEFAULT_TIMEOUT_MS=10_000、各 op は client.request({...}, timeoutMs) を呼ぶ (company.js:53,79-82,112-115,140-143)。transport.js:271-273 が setTimeout で timeoutErr(domain.transport.requestTimeout) を reject、:79 timeoutErr は code=TRANSPORT_ERR.TIMEOUT。company は全 op が直呼び (subscribeChunks 非経由) で transport timeout のみ、util.timeoutError(retryable=true) は使われない点が固定価値。subscribeChunks を使う org ([[ORG-0010]]) とは timeout 機序が異なる (company の方が単純)。

### [CO-0035] updateName 応答の merge 述語 (companyID 一致 company のみ name 差替・他は不変)
- surface: core
- backend: cloud
- command: `company.updateCompanyName`
- branch: companyID 一致要素 (name 差替) | 非一致要素 (不変)
- assert: updateCompanyName 応答適用は web 同様 company.companyID===message.data.companyID の company のみ name を差し替え、それ以外の company は変更しない (useStripeInfo.js:169-171 の .map 述語)。core は単一 op として {companyID,name} を返すのみだが、一覧再構築 consumer がこの述語に従う前提を境界として固定する
- ref: references_web/src/api/useStripeInfo.js:166-174; packages/core/src/company.js:84-86
- kind: payload-fidelity
- status: covered
- note: web updateName 応答 case は setCompanies の .map で company.companyID===message.data.companyID ? {...company, name:message.data.name} : company と一致要素のみ name を差し替え他要素を不変に保つ選択的 merge (useStripeInfo.js:168-172)。CO-0011 (戻り値形 {companyID,name}/欠落時 undefined) と別境界の payload-fidelity。一致要素限定 merge を移植元 ground truth として固定。

### [CO-0036] web は login 応答直後に getCompanies を自動発火 / kit は明示呼び出しのみ (lifecycle negative fact)
- surface: core
- backend: cloud
- command: `company.getCompanies` / `account.refreshAccount`
- branch: web (login 後 auto getCompanies) | kit (明示呼び出し)
- assert: web は biz3GetLoginUser 応答時に getCompanies() を自動発火 (useStripeInfo.js:94) するが、kit の refreshAccount (client.js:446-462) は getLoginUser のみで company 一覧を自動取得せず明示呼び出しに委ねる。login と company 一覧取得の連鎖を分離した境界 (意図的非移植) を固定する
- ref: references_web/src/api/useStripeInfo.js:85-95; packages/core/src/client.js:446-462; packages/kit/src/cli/company.js:42
- kind: option-branch
- status: covered
- note: web は biz3GetLoginUser 応答ハンドラ末尾で getCompanies() を自動連鎖 (useStripeInfo.js:94, ハンドラ :85-95)。kit は refreshAccount() が getLoginUser のみを呼び companies を自動取得せず (client.js:446-462)、会社一覧は CLI/利用者が hub.company.getCompanies() を明示呼び出し (cli/company.js:42)。CLI は withAccount(refreshAccount)→getCompanies を別個に呼ぶ設計。lifecycle negative fact。CO-0032 (isFromApp 送信抑止) とは異なる lifecycle 連鎖境界。

### [CO-0037] getPaymentConfig の必須検証はリテラル 'companyID required' (updateName の i18n key と別経路)
- surface: core
- backend: cloud
- command: `company.getPaymentConfig` / `company.updateCompanyName`
- branch: getPaymentConfig (literal 'companyID required') | updateCompanyName (i18n key company.err.companyIDRequired)
- assert: companyID 必須エラーの生成経路が op 間で不統一 (getPaymentConfig=リテラル company.js:139 / updateCompanyName=i18n key company.js:77)。両者の出力文言は i18n/company.js:19 (='companyID required') 経由で同一になるが、経路差を境界として固定し i18n 統一時の退行検出索引にする
- ref: packages/core/src/company.js:139; packages/core/src/company.js:77; packages/core/src/i18n/company.js:19
- kind: error-path
- status: covered
- note: getPaymentConfig は companyID 欠落で badRequest('companyID required') とリテラル文字列 (company.js:139)、updateCompanyName は i18n key badRequest('company.err.companyIDRequired') (company.js:77)。i18n catalog にも company.err.companyIDRequired='companyID required' があり (i18n/company.js:19) 結果文言は一致するが片方は key・片方はリテラルの内部 inconsistency。CO-0021/CO-0012 を横断する key/literal 不一致の固定で、将来の i18n 経路統一 (技術的負債) の退行検出索引。

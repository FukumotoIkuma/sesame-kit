<!-- spec-domain: payment | prefix: PAY | tests: packages/core/tests/payment, packages/kit/tests/cli -->

# 決済 spec (PAY)

payment.* (支払い方法/ClientSecret/既定変更/削除/レベル更新/Dev API 情報) を biz3 web (useStripeInfo/useDeveloper) に照らして監査する。

## getPaymentMethods

### [PAY-0001] getPaymentMethods → biz3ManagePayment/getPaymentMethods フレーム形
- surface: core
- backend: cloud
- command: `payment.getPaymentMethods`
- branch: customerId 指定 | companyID フォールバック
- assert: 送信フレームが {action:'biz3ManagePayment', customerId, op:'getPaymentMethods'} で、customerId=params.customerId||companyID、応答 data 配列をそのまま返す (vendor getCardList と 1:1)
- ref: references_web/src/api/useStripeInfo.js:100-109; packages/core/src/payment.js:37-44
- kind: wire-fidelity
- status: covered
- note: vendor は priorityCompanyId を customerId に入れる(:101)。kit は customerIdOf() で同等。検証: useStripeInfo.js getCardList=100-109、payment.js getPaymentMethods=37-44、共に確認済み

## getClientSecret

### [PAY-0002] getClientSecret → biz3ManagePayment/getClientSecret フレーム形と data 戻り
- surface: core
- backend: cloud
- command: `payment.getClientSecret`
- branch: -
- assert: 送信フレームが {action:'biz3ManagePayment', customerId, op:'getClientSecret'} (defaultPaymentMethod等の余分キー無し) で、応答 data(SetupIntent client secret 文字列)を返し、欠落時は null
- ref: references_web/src/api/useStripeInfo.js:221-235; packages/core/src/payment.js:56-63
- kind: wire-fidelity
- status: covered
- note: 検証: useStripeInfo.js getClientSecret=221-235 (msgData は customerId,op のみ:226-230)、payment.js getClientSecret=56-63、resp.data??null=62。一致確認

## changeDefaultPayment

### [PAY-0003] changeDefaultPayment → defaultPaymentMethod を含むフレーム形
- surface: core
- backend: cloud
- command: `payment.changeDefaultPayment`
- branch: -
- assert: 送信フレームが {action:'biz3ManagePayment', customerId, defaultPaymentMethod, op:'changeDefaultPayment'} でキー集合・順が vendor changeDefaultPay と一致する
- ref: references_web/src/api/useStripeInfo.js:237-250; packages/core/src/payment.js:79-92
- kind: wire-fidelity
- status: covered
- note: 検証: vendor changeDefaultPay msgData キー順=action,customerId,defaultPaymentMethod,op(:241-245)。kit frame=action,customerId,defaultPaymentMethod,op(:85)。挿入順一致確認

### [PAY-0004] changeDefaultPayment が応答 reqContext を破棄せず返す (vendor 消費キー保持)
- surface: core
- backend: cloud
- command: `payment.changeDefaultPayment`
- branch: reqContext あり | reqContext なし
- assert: 戻り値が {data, reqContext} 形で、vendor が読む message.reqContext.defaultPaymentMethod が呼び出し側に到達する(reqContext を data に潰さない)
- ref: references_web/src/api/useStripeInfo.js:123-135; packages/core/src/payment.js:84-91
- kind: payload-fidelity
- status: covered
- note: P3-8。応答実体は reqContext 側(data は通常 null)。検証: vendor 応答ハンドラ=123-135 で message.reqContext.defaultPaymentMethod を読む(:124,:129)。kit は return {data, reqContext}(:91)。既存 changeDefaultPayment-reqContext.test.js が同観点(実在確認)

## removePayment

### [PAY-0005] removePayment → paymentId+customerId を含むフレーム形
- surface: core
- backend: cloud
- command: `payment.removePayment`
- branch: -
- assert: 送信フレームが {action:'biz3ManagePayment', customerId, paymentId, op:'removePayment'} で、応答 data(更新後カード一覧 or null)を返す。vendor delCard と op/キー集合が一致
- ref: references_web/src/api/useStripeInfo.js:252-264; packages/core/src/payment.js:104-112
- kind: wire-fidelity
- status: covered
- note: vendor は removePayment 応答 data を setCardList で一覧置換(:137-139)。戻りが配列であることの根拠。検証: delCard=252-264(キー集合={action,paymentId,customerId,op})、payment.js removePayment=104-112、キー集合一致(挿入順は vendor=paymentId,customerId / kit=customerId,paymentId で異なるが assert はキー集合主張なので維持)

## payUpdateLevel

### [PAY-0006] payUpdateLevel → subId/isUpgrade/level/isCancel/customerId のフレーム形
- surface: core
- backend: cloud
- command: `payment.payUpdateLevel`
- branch: subId あり
- assert: 送信フレームが {action:'biz3ManagePayment', subId, isUpgrade, level, isCancel, customerId, op:'payUpdateLevel'} でキー集合・enum が vendor updateLevel と一致(level は数値、isCancel 既定 false)
- ref: references_web/src/api/useStripeInfo.js:200-219; packages/core/src/payment.js:129-146
- kind: wire-fidelity
- status: covered
- note: 検証: vendor updateLevel=200-219(msgData キー=action,subId,isUpgrade,level,isCancel,customerId,op:206-214)、payment.js payUpdateLevel=129-146。キー集合一致。注意: 挿入順は vendor が subId 先頭、kit は subId を条件付きで末尾追加(:142)のため byte 順は不一致だが assert はキー集合・enum 主張なので保持

### [PAY-0007] payUpdateLevel が subscriptionId 未定義時に subId キーを省く (Free 会社初回 upgrade)
- surface: core
- backend: cloud
- command: `payment.payUpdateLevel`
- branch: subId 欠落(Free 会社) | subId 指定
- assert: subscriptionId/subId が無いとフレームに subId キー自体が現れない (vendor の undefined は JSON.stringify で落ちる挙動の 1:1)。あれば含む
- ref: references_web/src/api/useStripeInfo.js:200-205; references_web/src/api/useStripeInfo.js:41-47; references_web/src/websocket/WebSocketManager.ts:383; packages/core/src/payment.js:135-142
- kind: wire-fidelity
- status: covered
- note: P3-4/BIZ-02。subscriptionId は priorityCompany(:46 target?.feeLevel?.subscriptionId, target 未一致で undefined)で undefined になり得る。検証で出典補強: vendor msgData は subId キーを常に持つ(:208 subId:subId)が、送信は WebSocketManager.sendMessage→this.ws.send(JSON.stringify(message))(:383)で undefined キーが直列化時に脱落する=assert の「JSON.stringify で落ちる」機序の実証。WebSocketManager.ts:383 を ref 追加。kit は if(subId!=null)frame.subId=subId(:142)で同挙動を再現。既存 payment.test.js が同観点(実在確認)

### [PAY-0008] payUpdateLevel の level は encoded biz3 level (planIndex*2+yearlyBit) として透過送信
- surface: core
- backend: cloud
- command: `payment.payUpdateLevel`
- branch: level=number | level=string(coerced)
- assert: level を planIndex に縮約せず encoded biz3 level として送るが、core は frame.level=Number(level) で string 入力を JSON number へ正規化する(入力寛容化)一方、vendor updateLevel は引数 level を変換せず raw 送出する。wire 上の値型は core の number と vendor の number(CLI 経路は toInt 済)で一致するが、core を直接 string で呼ぶ経路では core が JSON number・vendor が string を載せる非対称(kit 側のみ正規化)が境界
- ref: references_web/src/api/useStripeInfo.js:210; references_web/src/api/useStripeInfo.js:201; packages/core/src/payment.js:140; packages/core/src/payment.js:137; packages/kit/src/cli/payment.js:135
- kind: wire-fidelity
- status: covered
- note: 訂正(dual-audit 一致): 旧 assert の「変換せず透過」は誤り。Number() は実変換(string→JSON number)で vendor の raw 送出(useStripeInfo.js:210, Number() 呼び出し無し)と非対称。CLI は toInt で number 化(cli/payment.js:135)するため kit 経路は常に number。encoded level の根拠は CLI inferIsUpgrade の current*2<Number(level) 比較(packages/kit/src/cli/payment.js:56)

## getDevApiInfo

### [PAY-0009] getDevApiInfo → customerId+email を含むフレーム形
- surface: core
- backend: cloud
- command: `payment.getDevApiInfo`
- branch: -
- assert: 送信フレームが {action:'biz3ManagePayment', customerId, email, op:'getDevApiInfo'} で、応答 data({apiKeyValue,apiKeyId,usedCount})を返す。vendor getDevApiInfo と op/キー集合が一致
- ref: references_web/src/api/useStripeInfo.js:273-291; references_web/src/api/useStripeInfo.js:117-119; packages/core/src/payment.js:158-168
- kind: wire-fidelity
- status: covered
- note: 送信フレーム形は useStripeInfo.js:279-284。応答キー集合 {apiKeyValue,apiKeyId,usedCount} は handlePaymentResponse の getDevApiInfo case の分割代入(useStripeInfo.js:118)が出典(送信レンジ単独では応答形を支持しないため追加)

### [PAY-0010] getDevApiInfo の update キーは要求時のみフレームに付与
- surface: core
- backend: cloud
- command: `payment.getDevApiInfo`
- branch: update=null/undefined 省略 | update=true 付与
- assert: update が null/undefined のとき update キーがフレームに現れず、明示時のみ {...,update:bool} が付く (vendor の isUpdate!==null スプレッドの 1:1)
- ref: references_web/src/api/useStripeInfo.js:285-287; packages/core/src/payment.js:159-165
- kind: wire-fidelity
- status: covered
- note: vendor は isUpdate!==null のときのみ {...msgData, update:isUpdate} とスプレッド(useStripeInfo.js:285-287)。core は update!==null&&update!==undefined で frame.update を付与(payment.js:165)。既存 payment.test.js 'getDevApiInfo omits update unless requested'(packages/core/tests/payment/payment.test.js:92)が同観点

### [PAY-0011] getDevApiInfo の応答 apiKeyId が webapi 呼び出し連携の入力になる契約
- surface: core
- backend: cloud
- command: `payment.getDevApiInfo`
- branch: -
- assert: getDevApiInfo 応答 data.apiKeyId が後続 biz3InvokeWebAPIs フレームの apiKeyId として消費される(devApi→webapi 連携の境界)。data.apiKeyId フィールド名が vendor setApiKey と一致
- ref: references_web/src/api/useStripeInfo.js:116-120; references_web/src/api/useDeveloper.js:45-58; packages/core/src/payment.js:156-168
- kind: contract-existence
- status: covered
- note: vendor は getDevApiInfo 応答 data から apiKeyId を取り出し setApiKey({...,apiKeyId,...})(useStripeInfo.js:118-119)。それが useDeveloper.invokeAPI で apiKeyId: gStripe.apiKey.apiKeyId として WEBAPI フレームに載る(useDeveloper.js:50)。getDevApiInfo の戻り key 名がここに直結

## customerId-default

### [PAY-0012] customerIdOf フォールバック (customerId 優先, companyID 既定)
- surface: core
- backend: cloud
- command: `getPaymentMethods / getClientSecret / changeDefaultPayment / removePayment / payUpdateLevel / getDevApiInfo`
- branch: customerId 指定 | companyID のみ | 両欠落
- assert: customerId が無ければ companyID をフレームの customerId に使う。両欠落は customerIdRequired エラー。vendor は priorityCompany.companyID を customerId に入れる方針と整合
- ref: packages/core/src/payment.js:22-25; references_web/src/api/useStripeInfo.js:204; references_web/src/api/useStripeInfo.js:239
- kind: option-branch
- status: covered
- note: core customerIdOf は params.customerId||params.companyID(payment.js:24)。vendor は priorityCompany.companyID を customerId に入れる(updateLevel:useStripeInfo.js:204, changeDefaultPay:239)。両欠落は payment.err.customerIdRequired(各 op の if(!customerId) throw)

## validation

### [PAY-0013] 全 op の必須引数バリデーション (customerId / 各 op 固有) と bad_request 写像
- surface: core
- backend: local
- command: `getPaymentMethods / getClientSecret / changeDefaultPayment / removePayment / payUpdateLevel / getDevApiInfo`
- branch: customerId 欠落 | defaultPaymentMethod 欠落 | paymentId 欠落 | level 欠落/NaN | isUpgrade 非boolean | email 欠落
- assert: 各必須欠落で badRequest(SesameError code=bad_request, retryable=false) を投げ、i18n キー(payment.err.*)で文言化される。送信は行われない
- ref: packages/core/src/payment.js:40-138; packages/core/src/util.js:54-56; packages/core/src/i18n/payment.js:28-34
- kind: error-path
- status: covered
- note: customerIdRequired(payment.js:40)〜levelRequired/NaN(:137)/isUpgradeRequired(:138)/emailRequired(:162) の各分岐は client.request 前に throw。i18n キーは payment.err.customerIdRequired..emailRequired(i18n/payment.js:28-34)。既存 payment.test.js 'validates required params'(packages/core/tests/payment/payment.test.js:111)が一部カバー。levelRequired/NaN と isUpgradeRequired の分岐が追加観点

### [PAY-0014] 上流 success:false で rejected (retryable=false, upstreamCode 保持)
- surface: core
- backend: cloud
- command: `getPaymentMethods / getClientSecret / changeDefaultPayment / removePayment / payUpdateLevel / getDevApiInfo`
- branch: success:false | success 欠落(lenient 成功)
- assert: 応答 success===false で assertSuccess が SesameError(code=rejected, retryable=false, data.upstreamCode=resp.code) を投げる。success 欠落の data 応答は成功扱い(lenient)
- ref: packages/core/src/util.js:34-43; references_web/src/api/useStripeInfo.js:117; references_web/src/api/useStripeInfo.js:141-143
- kind: error-path
- status: covered
- note: lenient 判定 failed=!resp||resp.success===false(util.js:35)→success 欠落の data 応答は成功扱い。vendor は getDevApiInfo/payUpdateLevel で !message.success 早期 return(useStripeInfo.js:117,141-143)で success:false を失敗扱いする挙動の根拠

### [PAY-0015] vendor は customerId をガードしないが kit は必須化する境界差の明示
- surface: core
- backend: cloud
- command: `changeDefaultPayment / removePayment`
- branch: customerId 欠落
- assert: vendor changeDefaultPay/delCard は customerId(=priorityCompany.companyID)未設定でも送信し得るが、kit は customerId 欠落を bad_request で弾く(fail-closed 強化)。フレーム形自体は一致
- ref: references_web/src/api/useStripeInfo.js:237-264; packages/core/src/payment.js:81-83; packages/core/src/payment.js:106-108
- kind: error-path
- status: covered
- note: 確認済: vendor changeDefaultPay(237-250)/delCard(252-264) は customerId=priorityCompany.companyID を読むのみで if(!customerId) return が無い(getClientSecret:225/getDevApiInfo:276 と対照的に欠落)。kit は core/payment.js:82(changeDefaultPayment)・107(removePayment) で if(!customerId) throw badRequest。フレーム形は vendor(241-245)と core(85){action,customerId,defaultPaymentMethod,op} で一致。負の証拠の追加バリデーションは意図的な厳格化

## serve-exposure

### [PAY-0016] payment 6 op が registry に自動公開され NAMESPACE_OPS と 1:1
- surface: serve
- backend: cloud
- command: `payment.getPaymentMethods / payment.getClientSecret / payment.changeDefaultPayment / payment.removePayment / payment.payUpdateLevel / payment.getDevApiInfo`
- branch: -
- assert: buildRegistry が NS_MODULES.payment.NAMESPACE_OPS の 6 op を payment.<op> として登録し、ハンドラが requireAuth 後 hub.payment[op](params) を呼ぶ。欠落・余剰メソッドが無い
- ref: packages/kit/src/serve/registry.js:287-305; packages/core/src/payment.js:171-178; packages/kit/src/serve/registry.js:97-101
- kind: contract-existence
- status: covered
- note: 検証済: 自動公開ループ(:288-305)が NS_MODULES の各 ns×NAMESPACE_OPS を reg.set し handler(:302) で requireAuth(daemon)→hub[ns][op](p)。payment.NAMESPACE_OPS(:171-178)=6 op。NS_MODULES(:97)/NAMESPACE_MODULE_KEYS(:101)。ループ末尾は :305 まで(:304 で fix)

### [PAY-0017] payment RPC param schema が生成され型がプレースホルダに劣化しない
- surface: serve
- backend: cloud
- command: `payment.getPaymentMethods / payment.getClientSecret / payment.changeDefaultPayment / payment.removePayment / payment.payUpdateLevel / payment.getDevApiInfo`
- branch: -
- assert: rpc-params.generated.json に payment.<op> の named params(型付き)が在り、registry が gen.map で実 param を出す(汎用 (params) に落ちない)。NAMESPACE_MODULE_KEYS が 'payment' を含む
- ref: packages/kit/src/serve/rpc-params.generated.json:1021-1254; packages/kit/src/serve/registry.js:291-296; packages/kit/src/serve/registry.js:99-101
- kind: contract-existence
- status: covered
- note: P1-15 再発防止。検証済: rpc-params に payment 6 op(:1021-1254)が型付き named params で在る。registry(:291-296)が GEN_PARAMS[`${ns}.${op}`] 在れば gen.map、無ければ {name:'(params)'} に落ちる分岐。schema-drift.test.js:32 が NAMESPACE_MODULE_KEYS.toContain('payment') を検証

### [PAY-0018] payment proto/grpc/openrpc メソッド契約が registry と一致
- surface: serve, sdk
- backend: cloud
- command: `PaymentGetPaymentMethods / PaymentGetClientSecret / PaymentChangeDefaultPayment / PaymentRemovePayment / PaymentPayUpdateLevel / PaymentGetDevApiInfo`
- branch: grpc | openrpc
- assert: sesame.proto / grpc-methods.generated.json / schema/openrpc.json の payment 6 メソッドが registry の op・param 集合と 1:1(method 名・必須/任意・フィールド型が一致)
- ref: packages/kit/src/serve/sesame.proto:91-101; packages/kit/src/serve/sesame.proto:613-651; packages/kit/src/serve/grpc-methods.generated.json:366-422; schema/openrpc.json:1537-1842
- kind: surface-parity
- status: covered
- note: 検証済: proto rpc 宣言 6 本(:91-101)、Request message 6 個(:613-651, 全 field optional)。grpc-methods.generated.json:366-422 が Payment* gRPC 名→payment.<op>+param 名配列を保持(assert の grpc 部を支える出典として追加)。openrpc payment block は :1537-1842(旧 :1789 は getDevApiInfo の本体を切っていたため末尾 :1842 へ拡張)

### [PAY-0019] payUpdateLevel proto に subId と subscriptionId の両フィールドが存在
- surface: serve, sdk
- backend: cloud
- command: `PaymentPayUpdateLevel`
- branch: -
- assert: PaymentPayUpdateLevelRequest が subId(wire 送出名)と subscriptionId(別名入力)の両方を optional で持ち、core payUpdateLevel の subId||subscriptionId 受理と整合する
- ref: packages/kit/src/serve/sesame.proto:635-644; packages/core/src/payment.js:135; packages/kit/src/serve/rpc-params.generated.json:1164-1178
- kind: contract-existence
- status: covered
- note: 検証済: proto(:638 optional string subId=3, :639 optional string subscriptionId=4)。core payUpdateLevel(:135)が subId=params.subId||params.subscriptionId、:142 で subId!=null のみ frame に載せる(wire 送出名は subId)。rpc-params(:1164-1170 subId, :1171-1178 subscriptionId)

## serve-default-inject

### [PAY-0020] daemon が payment op の companyID を実アカウント値で自動注入
- surface: serve
- backend: cloud
- command: `payment.getPaymentMethods / payment.getDevApiInfo (代表)`
- branch: params で companyID/customerId 明示 | 省略(自動注入)
- assert: companyID 省略時、daemon が refreshAccount 済みの実 companyID を注入し、customerIdOf がそれを customerId に使う。明示渡しは上書きされない。gen-rpc-schema が required:false へ上書き済み
- ref: packages/kit/src/serve/daemon.js:129-140; packages/core/src/client.js:333-353; packages/kit/src/serve/rpc-params.generated.json:1030-1038
- kind: option-branch
- status: covered
- note: 検証済: 起動時 _connectLoop が refreshAccount()(daemon.js:134-136)で実 companyID/subUUID を config 反映。_bindNs(client.js:350)が out[name]=(params)=>fn(ws,{companyID,subUUID,...params}) で既定注入し ...params で明示優先。payment.customerIdOf(payment.js:23-25)が params.customerId||params.companyID を customerId に使う。rpc-params companyID は required:false+desc 'auto-injected by the daemon'(:1030-1038)

## serve-error

### [PAY-0021] payment の bad_request/rejected が JSON-RPC error 封筒へ写像
- surface: serve, sdk
- backend: cloud
- command: `payment.changeDefaultPayment / payment.payUpdateLevel (代表)`
- branch: bad_request(必須欠落) | rejected(上流 success:false) | timeout
- assert: core の SesameError code=bad_request→JSON-RPC INVALID_PARAMS/kind=bad_params、rejected→kind=rejected(data.upstreamCode 保持, retryable=false)、timeout→retryable=true に写像される
- ref: packages/core/src/jsonrpc.js:208-221; packages/core/src/jsonrpc.js:281-286; packages/core/src/util.js:34-56; packages/core/src/errors.js:33-35
- kind: error-path
- status: covered
- note: 旧 ref jsonrpc.js:161-174 は KIND enum の JSDoc のみで実写像を含まず(未確認: 写像表は別位置)。実体は SESAME_TO_RPC 写像表(jsonrpc.js:208-221: BAD_REQUEST→{INVALID_PARAMS,bad_params}/REJECTED→{APP_ERROR,rejected}/TIMEOUT→{APP_ERROR,timeout})と errorFromThrow の SesameError 分岐(:281-286, data.retryable=err.retryable を載せる)。util.js: assertSuccess(:34-43, REJECTED+data.upstreamCode+retryable:false)/badRequest(:54-56, BAD_REQUEST). errors.js:33-35=TIMEOUT/REJECTED/BAD_REQUEST code 定義

## sdk-exposure

### [PAY-0022] 生成 SDK (ts/py) に payment 6 メソッドが揃い param 形が openrpc と一致
- surface: sdk
- backend: cloud
- command: `client.payment.{getPaymentMethods,getClientSecret,changeDefaultPayment,removePayment,payUpdateLevel,getDevApiInfo}`
- branch: ts | python
- assert: sesame-client.ts / sesame_client.py の payment ネームスペースに 6 メソッドが在り、各 param(customerId/companyID/defaultPaymentMethod/paymentId/subId/subscriptionId/level/isUpgrade/isCancel/email/update/timeoutMs)が openrpc と一致。py は _omit_none で None を送らない
- ref: packages/kit/sdk/ts/sesame-client.ts:582-595; packages/kit/sdk/python/sesame_client.py:1142-1168; packages/kit/sdk/python/sesame_client.py:109; schema/openrpc.json:1537-1842
- kind: surface-parity
- status: covered
- note: 検証済: ts payment object(:582)に 6 メソッド(:584-594, 各 param 型は rpc-params/openrpc と一致)。py _Payment class(:1142)に 6 メソッド(:1148-1168)で _omit_none({...}) ラップ。_omit_none 定義は sesame_client.py:109(ref 追加)。openrpc payment block :1537-1842(旧 :1789 は getDevApiInfo 本体を切る範囲のため末尾 :1842 に修正)

## cli-methods

### [PAY-0023] sesame payment methods → getPaymentMethods 露出と --json/人間出力
- surface: cli
- backend: cloud
- command: `sesame payment methods [--customer-id]`
- branch: --json | 人間出力(空/件数) | --customer-id 指定/既定
- assert: hub.payment.getPaymentMethods({customerId}) を呼び、--json で {ok,count,paymentMethods}、非 json で件数と id 一覧(isDefaultPay は ' *')を出す。--customer-id 省略時は _bindNs が config.companyID を customerId フォールバックとして注入する経路
- ref: packages/kit/src/cli/payment.js:68-85; packages/core/src/payment.js:37-44; packages/core/src/client.js:333-350
- kind: surface-parity
- status: covered
- note: 確認済: CLI は customerInfo を customerId に使わず、_bindNs(client.js:350) の companyID 注入と customerIdOf(payment.js:22-25 の customerId||companyID) に依存

## cli-secret

### [PAY-0024] sesame payment client-secret → getClientSecret 露出と出力
- surface: cli
- backend: cloud
- command: `sesame payment client-secret [--customer-id]`
- branch: --json | 人間出力
- assert: hub.payment.getClientSecret({customerId}) を呼び、--json で {ok,clientSecret}、非 json で t('payment.secret.value') 経由 'clientSecret: <値>'(secret null は空文字)を出す
- ref: packages/kit/src/cli/payment.js:87-95; packages/core/src/payment.js:56-63
- kind: surface-parity
- status: covered

## cli-default

### [PAY-0025] sesame payment default <pm> → --yes ゲートと changeDefaultPayment 露出
- surface: cli
- backend: cloud
- command: `sesame payment default <paymentMethodId> [--yes] [--customer-id]`
- branch: --yes なし(終了コード2) | --yes あり | --json
- assert: --yes 無しで t('payment.err.confirmRequired') を出し ctx.die(...,2) で終了(送信しない)。--yes 時のみ changeDefaultPayment({customerId,defaultPaymentMethod}) を呼び {ok,response} を返す
- ref: packages/kit/src/cli/payment.js:97-110; packages/kit/src/cli/payment.js:24-30
- kind: error-path
- status: covered
- note: 確認済: requireYes は payment.js:24-30(jsdoc 23)、default 動作本体 103-104

## cli-remove

### [PAY-0026] sesame payment remove <id> → --yes ゲートと removePayment 露出
- surface: cli
- backend: cloud
- command: `sesame payment remove <paymentId> [--yes] [--customer-id]`
- branch: --yes なし(終了コード2) | --yes あり | --json
- assert: --yes 無しは confirmRequired で ctx.die(...,2)。--yes 時のみ removePayment({customerId,paymentId}) を呼び {ok,response} を返す
- ref: packages/kit/src/cli/payment.js:112-122; packages/kit/src/cli/payment.js:24-30
- kind: error-path
- status: covered

## cli-level

### [PAY-0027] sesame payment level <n> → --yes ゲートと payUpdateLevel 露出 (level 数値化)
- surface: cli
- backend: cloud
- command: `sesame payment level <level> [--yes] [--upgrade|--downgrade|--cancel] [--subscription-id] [--customer-id]`
- branch: --yes なし(2) | level 非数値(throw) | --json
- assert: --yes 必須。level を toInt で数値化(非数値は presetir.err.notANumber throw)。payUpdateLevel({customerId,subscriptionId,level,isUpgrade,isCancel}) を呼び subscriptionId 既定は customerInfo.subscriptionId
- ref: packages/kit/src/cli/payment.js:124-147; packages/kit/src/cli/payment.js:33-38
- kind: option-branch
- status: covered
- note: 確認済: toInt は payment.js:33-38(notANumber throw 36)、level 動作本体 134-140

### [PAY-0028] sesame payment level の isUpgrade 推論 (--upgrade/--downgrade/--cancel/自動)
- surface: cli
- backend: cloud
- command: `sesame payment level <level>`
- branch: --upgrade(true) | --downgrade/--cancel(false) | 両指定(conflict,2) | 自動(getPaymentConfig 比較) | 推論不能(2)
- assert: --upgrade→true、--downgrade/--cancel→false、両指定は upgradeConflict で ctx.die(...,2)。フラグ無しは getPaymentConfig().level*2<level で推論、不明なら upgradeUnknown で ctx.die(...,2)
- ref: packages/kit/src/cli/payment.js:47-59; packages/core/src/company.js:138-144; references_web/src/api/useStripeInfo.js:322-334
- kind: option-branch
- status: covered
- note: 確認済: inferIsUpgrade 47-59(conflict 49, current*2<level 56, unknown 57)。current*2<level は encoded level(planIndex*2+yearlyBit, core payment.js:123)の半証拠 (CLI ローカル発見的)。vendor getLevelConfig(:322-339, frame action 326/op 328) は BIZ3_MANAGE_COMPANY/getPaymentConfig で companyID トップレベル

## cli-devapi

### [PAY-0029] sesame payment dev-api → getDevApiInfo 露出と --update 時のみ --yes ゲート
- surface: cli
- backend: cloud
- command: `sesame payment dev-api [--email] [--update] [--yes] [--customer-id]`
- branch: 読取(--update なし, --yes 不要) | --update(--yes 必須, 無いと2) | email 既定 | --json
- assert: --update 無しは getDevApiInfo(update:null) を gate 無しで呼ぶ。--update 時のみ --yes 必須(無いと ctx.die(...,2))で update:true を渡す。email 既定は customerInfo.employeeEmail
- ref: packages/kit/src/cli/payment.js:149-168; packages/core/src/payment.js:158-168; references_web/src/api/useStripeInfo.js:277
- kind: option-branch
- status: covered
- note: 確認済: dev-api 149-168(update-gated yes 157, getDevApiInfo 158, email 既定 160, update:null/true 163)。vendor は priorityCompany.employeeEmail を email に使う(useStripeInfo.js:277 完全一致)。CLI 既定の根拠

## cli-output

### [PAY-0030] payment 全コマンドの --json 封筒 vs 人間出力の同値性
- surface: cli
- backend: cloud
- command: `sesame payment {methods,client-secret,default,remove,level,dev-api}`
- branch: --json | 人間出力
- assert: ctx.out(json, humanFn, jsonObj) により --json 時は構造化封筒(ok:true + ペイロード)、非 json 時は i18n 文言を出す。両分岐で同一 hub 呼び出し結果を反映する
- ref: packages/kit/src/cli/payment.js:74-83; packages/kit/src/cli/payment.js:163-166; packages/kit/src/cli/ctx.js:92-95
- kind: surface-parity
- status: covered
- note: 確認済: ctx.out の実体は ctx.js:92-95 (out(json,humanFn,jsonObj))。methods は ctx.out(...,{ok:true,count,paymentMethods}) (cli/payment.js:74-83)、dev-api は ctx.out(...,{ok:true,devApiInfo}) (163-166)。両分岐とも同一 hub 結果 (items/info) を参照。ref に ctx.out 定義元を追加

## i18n

### [PAY-0031] payment i18n カタログ (en/ja) のキー完全性とパリティ
- surface: cli, core
- backend: local
- command: `i18n payment.* catalog`
- branch: en | ja
- assert: cli/payment.js と core/payment.js が参照する payment.* キー(cmd/methods/secret/default/remove/level/devApi/opt.*/err.*)が en と ja で同一キー集合として存在し欠落が無い
- ref: packages/core/src/i18n/payment.js:1-76; packages/kit/src/cli/payment.js:66-167; packages/core/src/payment.js:40-162
- kind: i18n
- status: covered
- note: 確認済: en/ja とも 35 キーで差分ゼロ (en:2-38, ja:39-75)。cli が t() で参照する 24 キー・core が badRequest() で参照する 6 キー (payment.err.{customerId,defaultPaymentMethod,email,isUpgrade,level,paymentId}Required, core/payment.js:40,59,82,107,136-138,161-162) すべて catalog に存在。assert が core/payment.js を名指すため ref に core/payment.js を追加

## 監査追補 v2 (dual-audit)

### [PAY-0032] payUpdateLevel の isCancel を core が !!isCancel で bool 強制する vendor 非対称
- surface: core
- backend: cloud
- command: `payment.payUpdateLevel`
- branch: isCancel=true | isCancel=falsy(既定 false) | isCancel=truthy非bool
- assert: core は frame.isCancel=!!isCancel(truthy→bool 強制)、level=Number(level) で wire 値型を bool/number に正規化する。vendor は isCancel/level を変換せず raw 送出するため、非 bool/string 入力時に core 側のみ正規化が掛かる境界
- ref: packages/core/src/payment.js:140; references_web/src/api/useStripeInfo.js:201; references_web/src/api/useStripeInfo.js:210
- kind: wire-fidelity
- status: covered
- note: PAY-0006 はキー集合/enum 主張に留まり、!!isCancel/Number(level) の値型正規化(kit 側 fail-soft 寛容化)が未被覆。Number(level) 部分は [[PAY-0008]] と重なるが、!!isCancel の bool 強制(PAY-0006 軸)を独立観点として保持

### [PAY-0033] getPaymentMethods の非配列 data → [] 正規化が vendor raw 代入と非対称
- surface: core
- backend: cloud
- command: `payment.getPaymentMethods`
- branch: data=配列 | data=null/非配列([] へ正規化)
- assert: getPaymentMethods は応答 data が配列でない(null/undefined/非配列)とき [] を返す(core 側の fail-soft 正規化)。vendor は setCardList(message.data) で raw 代入し配列保証しない点と非対称で、removePayment(null 許容・縮約なし)とも分岐挙動が異なる
- ref: packages/core/src/payment.js:43; references_web/src/api/useStripeInfo.js:138
- kind: wire-fidelity
- status: covered
- note: PAY-0001/PAY-0005 とも返り値の非配列正規化境界を持たない。getPaymentMethods のみ [] 縮約、removePayment は null 許容という非対称が追加観点

### [PAY-0034] vendor の op 別 success ガード非対称を core が一律 assertSuccess で fail-closed 化
- surface: core
- backend: cloud
- command: `payment.getPaymentMethods / payment.removePayment / payment.changeDefaultPayment`
- branch: success:false(core 拒否/vendor 無ガード) | success 欠落(両者成功扱い)
- assert: vendor は getPaymentMethods/removePayment/changeDefaultPayment の応答に success ガードを持たず data/reqContext を無条件適用する(getDevApiInfo/payUpdateLevel のみ !success early-return)。core は 6 op すべてに assertSuccess を掛け success:false を rejected で弾く(vendor 無ガード 3 op への fail-closed 強化)。フレーム形は不変
- ref: references_web/src/api/useStripeInfo.js:117; references_web/src/api/useStripeInfo.js:124; references_web/src/api/useStripeInfo.js:138; references_web/src/api/useStripeInfo.js:141; packages/core/src/payment.js:42; packages/core/src/util.js:35
- kind: error-path
- status: covered
- note: PAY-0014 は lenient/early-return を note で言及するのみ。vendor の op 別 success ガード非対称(3 op 無ガード)と core の一律 assertSuccess(fail-closed 強化)が独立 assert として未被覆。[[PAY-0015]](customerId 軸の厳格化)と同型で success 軸版

### [PAY-0035] getDevApiInfo の update を core が !!update で bool 強制する vendor raw spread 非対称
- surface: core
- backend: cloud
- command: `payment.getDevApiInfo`
- branch: update=null/undefined(キー省略) | update=true | update=truthy非bool(!! で bool 化)
- assert: core は update 明示時 frame.update=!!update で truthy→bool 強制してから送出する(vendor は isUpdate 値を bool 強制せず raw spread)。null/undefined 時はキー省略で vendor と一致
- ref: packages/core/src/payment.js:165; references_web/src/api/useStripeInfo.js:286
- kind: wire-fidelity
- status: covered
- note: PAY-0010 は bool 表記のみで !!update の能動 bool 強制(kit 側正規化)が vendor raw spread と非対称な点を assert していない。低重大度(CLI 経路は常に true/null)

### [PAY-0036] getDevApiInfo の email 欠落: vendor silent-return vs kit badRequest throw の境界差
- surface: core
- backend: cloud
- command: `payment.getDevApiInfo`
- branch: email 欠落 (vendor silent-return) | email 指定
- assert: vendor getDevApiInfo は customerId に加え email も `if(!email) return;` でガードし、欠落時は何も送信せず黙って戻る(useStripeInfo.js:278)。kit core は email 欠落を payment.err.emailRequired の badRequest(SesameError code=bad_request, retryable=false)で送信前に throw する(payment.js:162)= fail-closed 強化。フレーム形自体(customerId,email,op)は一致
- ref: references_web/src/api/useStripeInfo.js:276-278; references_web/src/api/useStripeInfo.js:279-284; packages/core/src/payment.js:161-164; packages/core/src/i18n/payment.js:34
- kind: error-path
- status: covered
- note: PAY-0013 は branch に email 欠落を列挙し emailRequired に触れるが、vendor の `if(!email) return`(useStripeInfo.js:278)を ref/assert に持たず vendor 黙殺→kit throw の境界差を主張していない。[[PAY-0015]](changeDefaultPay/delCard の customerId 厳格化)と同型の vendor-silent-return-vs-kit-throw 境界の email 版

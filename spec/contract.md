<!-- spec-domain: contract | prefix: CTR | tests: packages/kit/tests, packages/kit/tests/serve -->

# 契約自己整合 spec (CTR)

openrpc.json ↔ registry ↔ proto ↔ SDK の 1:1 整合(205 メソッド)、CONTRACT_VERSION、NAMESPACE_OPS 1:1 宣言、result schema、stability/provenance 語彙、rpc.discover、drift ガードを監査する。

## method-set

各公開面のメソッド集合が単一真実源 (registry) から 1:1 で導出され、捏造/欠落ゼロで全成果物 (openrpc / proto / grpc-map) と一致することを固定する。

### [CTR-0001] openrpc↔registry↔proto↔grpc-map のメソッド集合が 1:1 (205) で完全一致する
- surface: core, serve, sdk
- backend: local
- command: buildRegistry / buildOpenRpcDoc / gen-grpc-proto
- branch: -
- assert: buildRegistry() のキー集合(205)が schema/openrpc.json の methods 名集合と一致し、events.* 2 op を除いた 203 op が sesame.proto の rpc 群 (RpcDiscover..BleOs2Register) と grpc-methods.generated.json のエントリ(203)に 1:1 写像される(捏造/欠落ゼロ)。proto の rpc 行は 203+Subscribe+Invoke=205
- ref: packages/kit/src/serve/registry.js:275-349; schema/openrpc.json:1; packages/kit/src/serve/sesame.proto:7-417; packages/kit/src/serve/grpc-methods.generated.json:1; scripts/gen-grpc-proto.mjs:53-58; scripts/gen-grpc-proto.mjs:107-135
- kind: contract-existence
- status: covered
- note: framework 不変条件。実測検証済: registry 205 (非event 203 / event 2) / openrpc methods 205 / proto rpc 行 205 (RpcDiscover@9..BleOs2Register@413 + Subscribe@415 + Invoke@417) / grpc-map 203 エントリ。ドメイン固有の method 存在性 (ACC-0054 等) とは別レイヤ。本エントリは 4 成果物横断の存在性ゲート(唯一)。proto↔grpc-map 細部 (jsonFields/optionalScalars の 1:1 自己整合) は [[SRV-0005]] が正典で本件はそこに踏み込まない(grpc-map 部の境界が SRV-0005 と接触するため責務分界を明記)。pascal 写像の単射性は [[CTR-0036]] が別途保証。出典 packages/kit/tests/serve/schema-drift.test.js:15-19 (proto+map 再生成 byte 一致) / openrpc-contract.test.js:48-51 (openrpc 射影一致)。gen-grpc-proto.mjs:54 buildRegistry()/:58 events.* skip に行ズレ修正

### [CTR-0002] rpc.discover が自身を含む全公開面を自己記述し、reg 経由でなく daemon が直接応答する
- surface: serve, sdk
- backend: local
- command: rpc.discover / openRpcDocument
- branch: rpc.discover(自己記述) | rpc.* 予約(method-not-found)
- assert: rpc.discover が registry に stable/local の 1 エントリとして存在し、応答 doc が自分自身を含む 205 メソッド + 4 x-events + 3 x-event-topics を網羅する。daemon.invoke は rpc.discover を openRpcDocument() で直接返し、他 rpc.* は METHOD_NOT_FOUND/not_implemented を投げる(reserved namespace fail-closed)
- ref: packages/kit/src/serve/registry.js:279-285; packages/kit/src/serve/daemon.js:223-230; packages/core/src/jsonrpc.js:11; packages/kit/tests/openrpc-contract.test.js:58-63
- kind: contract-existence
- status: covered
- note: 予約 rpc.* の自己記述+fail-closed の機構不変条件。実測 daemon.js:223 discover 直返し(reg を介さず openRpcDocument()) / :224-226 rpc.* 拒否(METHOD_NOT_FOUND+not_implemented) / :227-230 通常 reg lookup。registry.js:279-285 rpc.discover を stable/local の handler:({daemon})=>daemon.openRpcDocument() で公開。jsonrpc.js:11 が予約 namespace ルールの規範文。出典 openrpc-contract.test.js:58-63 (discover が x-stability=stable/x-provenance=local)

## namespace

7 名前空間の公開 op 集合が NAMESPACE_OPS / NAMESPACE_MODULE_KEYS を単一真実源として registry・param 生成・proto 生成を一貫駆動し、ns ごと脱落しないことを固定する。

### [CTR-0003] 各 NAMESPACE_OPS が公開 op の単一真実源として registry へ 1:1 自動公開される(7 ns)
- surface: core, serve
- backend: local
- command: buildRegistry NS_MODULES ループ / NAMESPACE_OPS
- branch: schedule(2) | org(34) | company(4) | payment(6) | access(11) | iot(10) | presetir(3)
- assert: NS_MODULES の 7 モジュールの NAMESPACE_OPS(計 70 op)を buildRegistry が ${ns}.${op} で 1:1 reg.set し、各ハンドラが requireAuth 後 hub[ns][op](params) へ一様委譲する。registry が op を捏造/欠落させず、NAMESPACE_OPS 外の op を公開しない(単一真実源)
- ref: packages/kit/src/serve/registry.js:97; packages/kit/src/serve/registry.js:288-305; packages/core/src/org.js:848; packages/core/src/access.js:972; packages/core/src/iot.js:530; packages/core/src/payment.js:171
- kind: contract-existence
- status: covered
- note: 横断版: 7 ns 一括の自動公開機構の不変条件。実測 NAMESPACE_OPS: schedule 2 / org 34 (org.js:848) / company 4 / payment 6 (payment.js:171) / access 11 (access.js:972) / iot 10 (iot.js:530) / presetir 3 = 70 op。registry.js:288-305 が for ループで reg.set 後 :302 で requireAuth(daemon)→hub[ns][op](p) 一様委譲。各 ns 単体 (ACC-0054 / company.js:152) とは別レイヤで「op 集合 = NAMESPACE_OPS 集合」を ns 跨ぎで検証

### [CTR-0004] NAMESPACE_MODULE_KEYS が registry/param生成/proto生成で同一集合を駆動する(payment 脱落再発防止)
- surface: core, serve, sdk
- backend: local
- command: NAMESPACE_MODULE_KEYS / gen-rpc-schema / generateSchema
- branch: -
- assert: registry の NS_MODULES から導出した NAMESPACE_MODULE_KEYS(7 key)を gen-rpc-schema.mjs が import し、生成 param schema が全 ns(payment 含む)を被覆して generateSchema() の出力に各 ns が少なくとも 1 op 現れる。手書きリストとの二重メンテで 1 ns が生成対象から脱落して型がプレースホルダに劣化する形(P1-15 再発)を機構的に封じる
- ref: packages/kit/src/serve/registry.js:101; scripts/gen-rpc-schema.mjs:13-16; scripts/gen-rpc-schema.mjs:163-169
- kind: contract-existence
- status: covered
- note: ns key 集合の単一真実源が生成器を貫通する機構不変条件 (namespace-keys-gen-parity + namespace-coverage を統合)。実測 registry.js:101 export NAMESPACE_MODULE_KEYS=Object.freeze(Object.keys(NS_MODULES)) (7 key) を gen-rpc-schema.mjs:13 が import、:16 で NS_MODULES に束ねて :163 のループが回す。rpc-params.generated.json は実測 70 key で payment.* 6 op を全て含む(プレースホルダ無)。出典 packages/kit/tests/serve/schema-drift.test.js:25-33 (全 ns が param schema に現れる / payment 含む)

## version-fingerprint

公開メソッド集合のフィンガープリントが CONTRACT_VERSION に 1:1 連動し、集合変化時のみ bump を強制 (result/params 形変更では不変) する横断ゲートを固定する。

### [CTR-0005] 公開メソッド集合フィンガープリント ↔ CONTRACT_VERSION の 1:1 連動 (規範7 bump 強制)
- surface: core, serve
- backend: local
- command: CONTRACT_VERSION / KNOWN_FINGERPRINTS / computeFingerprint
- branch: 一致(PASS) | 不一致(bump 必要)
- assert: buildRegistry().keys() ソート連結の SHA-256 下位 64bit が KNOWN_FINGERPRINTS[CONTRACT_VERSION]=28fc802bc1720a77 と一致し、CONTRACT_VERSION が表に登録されている。集合変化時のみ hash が動き bump を強制、result/params 形変更や gRPC presence 変更では hash 不変(bump 不要)であることを機械保証する
- ref: packages/core/src/jsonrpc.js:53; packages/core/src/jsonrpc.js:78; packages/kit/tests/serve/contract-fingerprint.test.js:31; packages/kit/tests/serve/contract-fingerprint.test.js:37
- kind: contract-existence
- status: covered
- note: fingerprint-version-gate(registry-keys hash) と contract-version-fingerprint(規範7 bump) を統合。実測 registry-keys hash=28fc802bc1720a77 一致。jsonrpc.js:78=KNOWN_FINGERPRINTS(version→fingerprint 表 canonical 定義、CONTRACT_VERSION=:53 同ファイル)。test:31=computeFingerprint([...keys].sort().join(',') の SHA-256 slice(0,16))、test:37=表一致ゲート。result/params/presence 変更は hash 不変=bump 不要を機械証明。22 tests green

### [CTR-0006] メソッド集合 + x-event-topics フィンガープリントと committed openrpc.json の一致
- surface: serve
- backend: local
- command: methodSetFingerprint / x-event-topics
- branch: live | committed openrpc.json
- assert: method名(ソート)+x-event-topics の SHA-256 先頭 16hex(=64ea81ba7ced77e0)が live レジストリ・committed openrpc.json の双方で CONTRACT_VERSION 登録値と一致する。method/topic 追加時の version bump と build 再生成の両方を強制する
- ref: packages/kit/tests/openrpc-contract.test.js:116; packages/kit/tests/openrpc-contract.test.js:134; packages/kit/tests/openrpc-contract.test.js:149
- kind: contract-existence
- status: covered
- note: registry-keys hash([[CTR-0005]]) とは別表(topics 込み hash)。実測 methods+topics hash=64ea81ba7ced77e0。test:116=methodSetFingerprint(JSON.stringify(methods.sort())+JSON.stringify(topics) の SHA-256 slice(0,16))、test:134=live branch、test:149=committed branch。x-event-topics の生成元は registry.js:409 のは [[CTR-0019]]。この openrpc-contract.test.js の KNOWN_FINGERPRINTS(106-109)は jsonrpc.js のものとは別表である点に留意

### [CTR-0007] CONTRACT_VERSION が openrpc info の x-apiVersion / x-contractVersion / info.version に同一刻印される
- surface: serve, sdk
- backend: local
- command: buildOpenRpcDoc / CONTRACT_VERSION
- branch: x-apiVersion(canonical) | x-contractVersion(deprecated別名) | info.version
- assert: buildOpenRpcDoc が info.version / x-apiVersion / x-contractVersion の 3 フィールドへ同一の CONTRACT_VERSION(1.4.0) を載せる。cited test は info.version + x-apiVersion の 2 フィールドのみ直接 toBe 検証し、x-contractVersion 同値は machineContract full-doc toEqual(:48) 射影で間接保証される。committed schema/openrpc.json と一致し、SDK(ts/py)が焼き込む API_VERSION もこの値と同一であること
- ref: packages/kit/src/serve/registry.js:392-398; packages/core/src/jsonrpc.js:53; packages/kit/tests/openrpc-contract.test.js:53-56; packages/kit/tests/openrpc-contract.test.js:48
- kind: contract-existence
- status: covered
- note: 3 フィールド同値刻印は registry.js:395-397 で直接刻印(x-apiVersion/x-contractVersion 同値 + info.version=渡された version)。cited test openrpc-contract.test.js:53-56 は info.version + x-apiVersion の 2 フィールドのみ assert、x-contractVersion 同値は :48-51 の full-doc toEqual で間接保証。SDK API_VERSION 連動の出典 sdk-ts-contract.test.js:29 / sdk-py-contract.test.js:27 (API_VERSION === x-apiVersion)。実測 info.version=x-apiVersion=x-contractVersion=1.4.0。AUTH-0123(auth.md) の auth 面 apiVersion とは別レイヤ

## openrpc-projection

openrpc.json 機械契約射影が実装と双方向一致し、全 method/event が tier/provenance/result schema を持つ完全性を固定する。

### [CTR-0008] openrpc.json 機械契約射影が実装と双方向一致し全 method/event が tier/provenance を持つ
- surface: serve, sdk
- backend: local
- command: buildOpenRpcDoc / machineContract / gen-openrpc
- branch: method(name/params/result/tier/prov) | event(name/tier/prov) | eventTopics
- assert: committed schema/openrpc.json の機械射影(method名/params名・required・schema/result schema/x-stability/x-provenance/x-events/x-event-topics)が buildOpenRpcDoc(buildRegistry()) の live 射影と一致(散文/locale 除外で双方向)。全 method/event が x-stability∈{stable,experimental} と string な x-provenance を持つ(公開契約の完全性)。result 形・tier 変更を commit したが build:openrpc を忘れた腐りを検出する
- ref: packages/kit/src/serve/registry.js:358-411; packages/kit/tests/openrpc-contract.test.js:18-43; packages/kit/tests/openrpc-contract.test.js:48; packages/kit/tests/openrpc-contract.test.js:65-73; scripts/gen-openrpc.mjs:21
- kind: contract-existence
- status: covered
- note: openrpc-machine-projection + openrpc-drift-gate を統合(中核 drift ゲート)。result schema 全体まで射影に含め型付き SDK return の drift も捕捉。buildOpenRpcDoc(registry.js:358-411)が params(:365-370)・result schema(:373-378)・x-stability/x-provenance(:380-381)・x-events(:401-406)・x-event-topics(:409)を出力。gen-openrpc.mjs:21=成果物固定(setLocale en で locale 非依存)。machineContract 射影(test:18-43, summary/description 除外)が test:48 で双方向 equality 比較、完全性 test:65-73

### [CTR-0009] buildOpenRpcDoc が全 method/event に x-stability/x-provenance を付与する
- surface: serve, sdk
- backend: local
- command: buildOpenRpcDoc
- branch: method | event
- assert: 公開 OpenRPC doc の全 method と x-events が x-stability {stable,experimental} と string の x-provenance を持つ。公開契約の安定性メタ完全性を保証する
- ref: packages/kit/src/serve/registry.js:380; packages/kit/src/serve/registry.js:388; packages/kit/tests/openrpc-contract.test.js:65
- kind: contract-existence
- status: covered
- note: registry.js:380=method の x-stability/x-provenance 付与, registry.js:388=event の付与, openrpc-contract.test.js:65=完全性テスト(committed doc 走査)。安定性メタ射影の機構境界。完全性そのものは [[CTR-0008]] と重なるが、こちらは「付与の有無」単独の不変条件として残す

### [CTR-0010] buildOpenRpcDoc の result.schema は RESULT_SCHEMAS を載せ、未登録は緩い object にフォールバック
- surface: serve, sdk
- backend: local
- command: buildOpenRpcDoc result.schema
- branch: RESULT_SCHEMAS 有り(型付き) | 無し(type:object フォールバック)
- assert: RESULT_SCHEMAS にキーがあるメソッドは result.schema にその型が射影され、無いものは {type:object} に落ちる。トレース確認済みのみ型を出し、嘘の型を主張しない契約射影
- ref: packages/kit/src/serve/registry.js:375; packages/kit/tests/openrpc-contract.test.js:32
- kind: contract-existence
- status: covered
- note: load-bearing な三項 RESULT_SCHEMAS[name] ? {...RESULT_SCHEMAS[name]} : {type:object} は registry.js:375-377(373 は result ブロック開始のみ)。openrpc-contract.test.js:32 は machineContract の result.schema 射影で支持。result-schemas.js が単一真実源(import: registry.js:18)

## result-schema

RESULT_SCHEMAS が registry 実メソッドにのみ存在し、生成器解釈可能な JSON-Schema 形で凍結され、STABLE_METHODS を漏れなく被覆することを固定する。

### [CTR-0011] RESULT_SCHEMAS の全キーが registry 実メソッド (orphan スキーマ無し)
- surface: serve, sdk
- backend: local
- command: RESULT_SCHEMAS / buildRegistry
- branch: -
- assert: RESULT_SCHEMAS の全キーが buildRegistry() の実メソッドに存在する。実在しないメソッドのスキーマ(orphan)が紛れると SDK に出ないのに気付けず腐るため、契約自己整合として禁止する
- ref: packages/kit/src/serve/result-schemas.js:57; packages/kit/src/serve/result-schemas.js:163; packages/kit/tests/serve/result-schemas-contract.test.js:14
- kind: contract-existence
- status: covered
- note: ble.os2.status は registry に無いため RESULT_SCHEMAS から除外 (result-schemas.js:159-165 の status 除外方針コメント)。mechStatus publish 待ちで typed spec 保留。:57=RESULT_SCHEMAS Object.freeze 開始、:163=orphan 禁止根拠コメント、test:14=orphan 無し it()

### [CTR-0012] 各 RESULT_SCHEMAS エントリが生成器解釈可能な JSON-Schema 形 (type を持つ)
- surface: serve, sdk
- backend: local
- command: RESULT_SCHEMAS
- branch: object | array | string | number | boolean
- assert: 各 RESULT_SCHEMAS 値は object で type が {object,array,string,number,boolean} のいずれか。生成器(gen-sdk-ts/py)が型付き return に変換できる形であることを契約として固定する
- ref: packages/kit/src/serve/result-schemas.js:23-34; packages/kit/tests/serve/result-schemas-contract.test.js:20; scripts/gen-sdk-ts.mjs:33
- kind: contract-existence
- status: covered
- note: result-schemas.js:23-34=型 primitive/コンストラクタ群(STR/NUM/BOOL/OBJ/arr/obj — type を必ず持つ schema 片の定義)。test:20=type∈集合の it()、gen-sdk-ts.mjs:33=tsResultType(消費側生成器)

### [CTR-0013] RESULT_SCHEMAS は Object.freeze で凍結 (実行時の誤改変防止)
- surface: serve
- backend: local
- command: RESULT_SCHEMAS
- branch: -
- assert: RESULT_SCHEMAS は Object.isFrozen が真。結果形の単一真実源を実行時改変から守る不変条件
- ref: packages/kit/src/serve/result-schemas.js:57; packages/kit/tests/serve/result-schemas-contract.test.js:27
- kind: contract-existence
- status: covered
- note: :57=export const RESULT_SCHEMAS = Object.freeze({、test:27=Object.isFrozen を検証する it()

### [CTR-0014] STABLE_METHODS ⊆ RESULT_SCHEMAS (rpc.discover 除く) — stable 昇格時のスキーマ漏れ検出
- surface: serve, sdk
- backend: local
- command: STABLE_METHODS / RESULT_SCHEMAS
- branch: rpc.discover 除外
- assert: STABLE_METHODS の全キー(rpc.discover 除く)に対応する RESULT_SCHEMAS エントリが存在する。欠落すると SDK 戻り型が unknown/Any に劣化するため、stable 昇格とスキーマ追加の一貫を機械強制する
- ref: packages/kit/src/serve/stability.js:19; packages/kit/src/serve/result-schemas.js:57; packages/kit/tests/serve/result-schemas-stable.test.js:15
- kind: contract-existence
- status: covered
- note: rpc.discover はメタ API でドメインデータを返さずスキーマ不要 (生成系の固定出力)。stability.js:19=STABLE_METHODS 定義開始、result-schemas.js:57=RESULT_SCHEMAS、test:15=STABLE_METHODS⊆RESULT_SCHEMAS(rpc.discover 除外)の it()

## stability

STABLE_METHODS/STABLE_EVENTS が registry/広告イベントの実在に裏付けられ、無言降格を防ぐ source integrity を固定する。

### [CTR-0015] STABLE_METHODS の全キーが registry 実メソッド (typo/rename による無言降格防止)
- surface: serve
- backend: local
- command: STABLE_METHODS / buildRegistry
- branch: -
- assert: STABLE_METHODS の全キーが registry の実メソッド名に存在する。stabilityOf が未登録を experimental にフォールバックするため、typo/rename で本来 stable が無言で experimental に降格する穴を CI で塞ぐ
- ref: packages/kit/src/serve/stability.js:19; packages/kit/src/serve/stability.js:57; packages/kit/tests/serve-stability.test.js:19
- kind: contract-existence
- status: covered
- note: stability.js:19=STABLE_METHODS、:57=stabilityOf(未登録→experimental フォールバック)、test:19=全 STABLE_METHODS キーが実 registered method である it()。STABLE_EVENTS 側の同型ガードは [[CTR-0016]]

### [CTR-0016] STABLE_EVENTS の全キーが広告イベント (x-events) に実在する
- surface: serve
- backend: local
- command: STABLE_EVENTS / buildOpenRpcDoc x-events
- branch: -
- assert: STABLE_EVENTS の全キーが buildOpenRpcDoc の x-events 広告名に存在する。手書き stable イベント名と広告イベント名の乖離(無言 experimental 降格)を防ぐ
- ref: packages/kit/src/serve/stability.js:38; packages/kit/src/serve/registry.js:401; packages/kit/tests/serve-stability.test.js:24
- kind: contract-existence
- status: covered
- note: stability.js:38=STABLE_EVENTS 定義(3キー), registry.js:401=x-events 配列(4広告: lockState/deviceUpdate/deviceListChanged/ready), serve-stability.test.js:24=実在ガード。STABLE⊆advertised の包含関係(deviceListChanged は experimental)で整合。機構レベル境界(source↔projection drift)

## provenance

tier(stable/experimental)が provenance({local,app-core,unverified})から導出される二境界モデルを method/event 双方で固定する。

### [CTR-0017] 全 method の provenance が語彙 {local,app-core,unverified} 内
- surface: serve
- backend: local
- command: provenanceOf
- branch: -
- assert: registry 全メソッドの provenanceOf が PROVENANCE_VOCAB {local,app-core,unverified} のいずれか。出所語彙の閉性を契約として固定する
- ref: packages/kit/src/serve/stability.js:65; packages/kit/tests/provenance.test.js:17
- kind: contract-existence
- status: covered
- note: stability.js:65=provenanceOf(未登録は "unverified" フォールバック), provenance.test.js:17=語彙内テスト(PROVENANCE_VOCAB は test:10 に定義)。語彙閉性の機構契約

### [CTR-0018] tier は provenance から導出 — stable⇔{local,app-core} / experimental⇔unverified の双条件
- surface: serve, sdk
- backend: local
- command: stabilityOf / provenanceOf
- branch: stable | experimental
- assert: stabilityOf==stable のメソッドは provenance が {local,app-core}、experimental は provenance==unverified。確信度(provenance)と外部約束(tier)が乖離しない二境界モデルを機械強制する
- ref: packages/kit/src/serve/stability.js:13; packages/kit/src/serve/stability.js:57; packages/kit/tests/provenance.test.js:23
- kind: contract-existence
- status: covered
- note: stability.js:13=tier 導出規則の根拠コメント, stability.js:57=stabilityOf 実装, provenance.test.js:23=双条件テスト(STABLE_PROVENANCE は test:11)

### [CTR-0019] イベントも tier↔provenance 双条件を満たす (event の不変条件)
- surface: serve
- backend: local
- command: eventStabilityOf / eventProvenanceOf
- branch: stable | experimental
- assert: x-events 各イベントの eventProvenanceOf が語彙内、かつ stable イベントは {local,app-core} / それ以外は unverified。method と同一の二境界不変条件をイベントにも適用する
- ref: packages/kit/src/serve/stability.js:73; packages/kit/src/serve/stability.js:81; packages/kit/tests/provenance.test.js:33
- kind: contract-existence
- status: covered
- note: stability.js:73=eventStabilityOf, stability.js:81=eventProvenanceOf, provenance.test.js:33=event 不変条件テスト(eventNames は x-events から導出)。method と同形の機構不変条件

## event-topics

購読可能 topic が SUBSCRIBABLE_TOPICS 単一定義から x-event-topics と daemon へ一致導出されることを固定する。

### [CTR-0020] 購読可能 topic が SUBSCRIBABLE_TOPICS 単一定義から x-event-topics と daemon へ一致導出される
- surface: serve, sdk
- backend: local
- command: SUBSCRIBABLE_TOPICS / STATE_TOPICS / x-event-topics
- branch: STATE_TOPICS(lockState,deviceUpdate) | +deviceListChanged | event.ready(購読外broadcast)
- assert: registry の SUBSCRIBABLE_TOPICS(=STATE_TOPICS+deviceListChanged)が x-event-topics と daemon の import で同一集合を駆動し、buildOpenRpcDoc の x-event-topics が SUBSCRIBABLE_TOPICS と完全一致する。event.ready 等の broadcast は x-events には載るが購読可能集合には含まれない
- ref: packages/kit/src/serve/registry.js:265-267; packages/kit/src/serve/registry.js:401-409; packages/kit/src/serve/daemon.js:16; packages/kit/tests/serve/registry-wiring.test.js:215-222; packages/kit/tests/serve/phase4-surfaces.test.js:210-217
- kind: contract-existence
- status: covered
- note: topic 集合の単一真実源が contract(x-event-topics)/SDK 型/daemon を貫通する機構(SURF-16/ARCH-07)。EVT-0001(各ドメイン spec)は subscribe param enum 面のみで本件と非重複。全 ref 実在確認済。出典 registry-wiring.test.js:215-222(x-event-topics==SUBSCRIBABLE_TOPICS) / phase4-surfaces.test.js:210-217(daemon.topics===SUBSCRIBABLE_TOPICS)・:445-455(enum 一致)

## grpc-encoding

gRPC proto/glue の符号化規約 (field presence・JSON 葉) が proto-loader の Struct 化を避け省略/明示既定値を区別することを固定する。

### [CTR-0021] proto3 field presence: required でない scalar に optional 付与し省略/明示既定値を区別する
- surface: serve, sdk
- backend: local
- command: gen-grpc-proto / grpc-methods.generated.json optionalScalars
- branch: 省略(undefined) | 明示既定値(0/false/"") | required scalar(optional無し)
- assert: gen-grpc-proto が required でない scalar に proto3 optional を付与し optionalScalars に列挙する。required scalar(例 LockSetAutolock.seconds)には optional を付けない。glue が synthetic oneof sentinel(_field)の有無で省略を判定し、scriptIndex/pageSize/scanTimeoutMs=0 の明示値を「未指定」と取り違えない(0 一律 delete を封じる)
- ref: packages/kit/src/serve/sesame.proto:1-4; scripts/gen-grpc-proto.mjs:62-82; packages/kit/src/serve/framing/grpc.js:114-140; packages/kit/src/serve/grpc-methods.generated.json:1
- kind: option-branch
- status: covered
- note: gRPC framing 機構の境界(R3:SURF-01)。method-unit wire ではなく presence 符号化の不変条件。検証: LockSetAutolockRequest.seconds=4 は optional 無し(proto:1537)、scriptIndex/pageSize/lastEvaluatedKey は optional(proto:1531/1586/1587)。glue は値ではなく _field sentinel で省略判定(grpc.js:124-132)。出典 packages/kit/tests/serve/grpc-presence.test.js:56-225(scriptIndex/pageSize/scanTimeoutMs の省略×明示0対を網羅)

### [CTR-0022] scalar 引数は proto 型・object/dynamic 葉は JSON 文字列 field として符号化される
- surface: serve, sdk
- backend: local
- command: gen-grpc-proto jsonFields / grpc.js reviveJsonArg
- branch: scalar(proto型) | object/dynamic(jsonFields=JSON文字列) | params丸ごと(jsonFields=params)
- assert: schema 付き scalar 引数(lock.unlock/lock.status/device.history/ir.send/ir.listKeys)は jsonFields に落ちず proto scalar field になり、object カーソル(device.battery.lastEvaluatedKey)は jsonFields=["lastEvaluatedKey"] として JSON 文字列 field になる。glue は jsonFields のみ JSON.parse して named params に復元する
- ref: packages/kit/src/serve/sesame.proto:2-3; scripts/gen-grpc-proto.mjs:38-46; packages/kit/src/serve/framing/grpc.js:137-140
- kind: payload-fidelity
- status: covered
- note: proto-loader が生 JS を Struct 化しないための符号化規約(機構)。検証: pbFieldType(gen-grpc-proto.mjs:38-46)が object/未知葉のみ {json:true} 化。生成物で 5 scalar method の jsonFields=[](map:1526/1569/1629/1744/1751)、device.battery のみ jsonFields=["lastEvaluatedKey"](map:1637-1639)。出典 packages/kit/tests/serve/schema-drift.test.js:54-66

## drift-gate

生成成果物 (proto / grpc-map / rpc-params) が registry/.d.ts から再生成した結果とバイト一致し、build 忘れによる stale を検出することを固定する。

### [CTR-0023] sesame.proto + grpc-methods.generated.json が registry から再生成した結果と一致する (drift gate)
- surface: serve, sdk
- backend: local
- command: gen-grpc-proto / sesame.proto / grpc-methods.generated.json
- branch: -
- assert: generateProto() が buildRegistry() から events.* を除外し RpcDiscover を通常ループで生成(SURF-22: Discover 二重追加なし)した protoText が committed sesame.proto とバイト一致し、nameMap が grpc-methods.generated.json と一致する。Subscribe(stream Event)/Invoke(JsonRpc) の 2 特別 rpc が末尾に固定追加される。registry を変えて build:grpc-proto を忘れた stale を検出する
- ref: scripts/gen-grpc-proto.mjs:53-58; scripts/gen-grpc-proto.mjs:84-112; packages/kit/src/serve/sesame.proto:7-417; packages/kit/tests/serve/schema-drift.test.js:15
- kind: contract-existence
- status: covered
- note: grpc-proto-drift + proto-drift-gate を統合(機構レベル生成物自己整合ゲート)。検証: events.* 除外(gen-grpc-proto.mjs:58)、SURF-22 旧 Discover 削除コメント(:84-86)、Subscribe/Invoke 末尾追加(:109-112 → proto:415-417)、RpcDiscover が通常ループ先頭(proto:9)。schema-drift.test.js:15-19(PROTO_PATH/MAP_PATH バイト比較)

### [CTR-0024] rpc-params.generated.json が .d.ts から再生成した結果と一致する (param schema drift gate)
- surface: serve, sdk
- backend: local
- command: gen-rpc-schema / rpc-params.generated.json
- branch: -
- assert: committed rpc-params.generated.json が今の types/*.d.ts から generateSchema()/serializeSchema() で再生成した結果とバイト一致し、registry の discover が名前空間 op の引数名/required/schema を自己記述できる。lib の param 型を変えて build:rpc-schema を忘れた stale を検出する
- ref: packages/kit/src/serve/rpc-params.generated.json:1; packages/kit/src/serve/registry.js:90-94; scripts/gen-rpc-schema.mjs:161; scripts/gen-rpc-schema.mjs:177; packages/kit/tests/serve/schema-drift.test.js:10
- kind: contract-existence
- status: covered
- note: rpc-params-drift + rpc-schema-drift-gate を統合(機構レベル生成物自己整合ゲート)。実測 rpc-params.generated.json=70 key、registry.js:90-94 が GEN_PARAMS として読み discover の実 param に展開、未生成時のみ汎用 (params) フォールバック。gen-rpc-schema.mjs:161=generateSchema()/:177=serializeSchema()。byte 一致は serializeSchema の `JSON.stringify(,2)+\n` 表現で比較。schema-drift.test.js:10-13(byte 一致)

### [CTR-0025] 公開 op の param schema が 1 つも空でない (型不明を放置しない回帰ガード)
- surface: serve, sdk
- backend: local
- command: gen-rpc-schema / generateSchema
- branch: -
- assert: generateSchema() の全 op の全 param が非空 schema を持つ。型不明(空 {})を放置せず nodeToSchema に対応を足すか param から外す、を契約の完全性として強制する
- ref: scripts/gen-rpc-schema.mjs:161; scripts/gen-rpc-schema.mjs:20; packages/kit/tests/serve/schema-drift.test.js:68
- kind: contract-existence
- status: covered
- note: 機構レベルの型生成完全性ガード。gen-rpc-schema.mjs:161=generateSchema()、:20=空 schema を生む張本人 nodeToSchema()(assert の『nodeToSchema に対応を足す』を直接支える)。schema-drift.test.js:68-78 が全 op×全 param の空 schema を収集し空配列を要求。3 suite 22 tests green

### [CTR-0026] stability tier が gRPC proto の各 rpc 宣言直前コメントに伝播する
- surface: serve
- backend: local
- command: generateProto / stabilityOf
- branch: stable(// stable) | experimental(// experimental (unverified))
- assert: STABLE_METHODS の op は rpc 宣言直前に '// stable'、それ以外は '// experimental (unverified)' コメントが付き、'// stable' 行数が service 掲載 stable 数(events.* 除く)と一致する。protoc 消費者が tier を判別できる契約伝播
- ref: scripts/gen-grpc-proto.mjs:101; packages/kit/src/serve/stability.js:57; packages/kit/tests/serve/result-schemas-stable.test.js:35; packages/kit/tests/serve/result-schemas-stable.test.js:100
- kind: contract-existence
- status: covered
- note: 機構レベルの tier 契約伝播(gen-grpc-proto.mjs:101 が stabilityOf を rpc コメントへ反映)。コメント存在は test:35、行数一致(11=STABLE_METHODS 13 - events.* 2、rpc.discover は RpcDiscover として service 掲載され計上)は test:100。実測 stable=11/experimental=192 で一致を確認

## dispatch

transport 非依存の JSON-RPC dispatch コア機構 (分類規約・error.kind 写像) が全 framing で共有される単一真実源であることを固定する。

### [CTR-0027] JSON-RPC dispatch の分類規約: batch 拒否 / id有=応答・id無=通知 / params secretKey 非 echo
- surface: serve
- backend: local
- command: classify / handleMessage / errorFromThrow
- branch: parse-error(-32700) | batch(-32600) | invalid(jsonrpc!=2.0/method欠落) | request(id有) | notification(id無)
- assert: classify が jsonrpc==="2.0" 厳密判定し、配列を batch として -32600 拒否、id 欠落=通知(応答せず)・id:null=request を区別する。errorFromThrow/makeError が error.data に inbound params を一切 echo しない(secretKey 漏洩防止)。通知はエラーでも沈黙する
- ref: packages/core/src/jsonrpc.js:301-325; packages/core/src/jsonrpc.js:345-369; packages/core/src/jsonrpc.js:243-252; packages/core/src/jsonrpc.js:12
- kind: error-path
- status: covered
- note: transport 非依存の protocol コア機構(全 framing 共有)。method-unit ではなく 1 メッセージの parse/分類/整形の不変条件。検証: classify(:301-325)で batch→{type:batch}(:309)・id欠落→notification(:323)・id:null→request(:324)・jsonrpc!==2.0→invalid(:314)、handleMessage(:355-358)通知は沈黙、makeError(:243-252)は data に kind のみ載せ inbound params を入れない。出典 packages/core/tests/jsonrpc.test.js:7-45

### [CTR-0028] error.kind 写像の全 framing 単一真実源: SesameError/BleResultError → JSON-RPC kind/retryable
- surface: core, serve
- backend: cloud, ble, ble-os2, local
- command: errorFromThrow / KIND / SESAME_TO_RPC / BLE_RESULT_TO_RPC
- branch: RpcError素通し | BleResultError(resultName写像) | SesameError(code写像) | 想定外(internal)
- assert: errorFromThrow が RpcError をそのまま、BleResultError を resultName→{kind,code,retryable}(invalidSig→not_authenticated/busy→rejected+retryable/未知名→rejected)、SesameError を code→kind(NOT_CONNECTED→connection_lost 等)へ写像し、想定外は internal に潰すが stack/params は出さない。KIND enum は実 emit 値のみ宣言する
- ref: packages/core/src/jsonrpc.js:169-222; packages/core/src/jsonrpc.js:260-294; packages/core/src/jsonrpc.js:155-177
- kind: error-path
- status: covered
- note: kind 写像テーブルが全 framing(http/ws/grpc/ndjson)で共有される単一真実源(SURF-11/P5-5)。kind→gRPC status の二次写像(grpcStatusFor, grpc.js:85-95)の正典は [[SRV-0057]] であり、本エントリは errorFromThrow の 4 分岐 kind 写像のみを索引する。検証: BLE_RESULT_TO_RPC(:194-203)で invalidSig→not_authenticated・busy→rejected+retryable:true、SESAME_TO_RPC(:209-222)で NOT_CONNECTED→connection_lost、未知 resultName fallback→rejected(:271)、想定外→INTERNAL(:293)。出典 packages/kit/tests/serve/serve-error-kind.test.js / ble-error-mapping.test.js:16-60 / http-kind-map.test.js

## sdk-gen

SDK(ts/py)がスキーマ駆動で機械生成され、全 stable メソッド露出・experimental 注記・nullable result 伝播が再生成一致でガードされることを固定する。

### [CTR-0029] SDK(ts/py)がスキーマ駆動で機械生成され全 stable メソッドを露出する(生成機構の自己整合)
- surface: sdk
- backend: local
- command: gen-sdk-ts / gen-sdk-py / sesame-client.ts / sesame_client.py
- branch: ts(op:/op =) | py(def op() ) | stable(露出必須) | experimental(@experimental注記)
- assert: generateSdk(spec)/generateSdkPy(spec) が committed の sesame-client.ts / sesame_client.py とバイト一致し、x-stability=stable な全メソッドが SDK に op として出る。experimental には @experimental 注記、両 SDK に API_VERSION===x-apiVersion を焼き込み、HTTP transport error が SesameRpcError kind/retryable へ正規化される
- ref: scripts/gen-sdk-ts.mjs:68-138; scripts/gen-sdk-py.mjs:137-166; packages/kit/sdk/ts/sesame-client.ts:1; packages/kit/sdk/python/sesame_client.py:1; schema/openrpc.json:1
- kind: contract-existence
- status: covered
- note: SDK 生成機構の drift+完全性ゲート(横断)。method-unit の SDK 存在性(access.md:684 等)とは別に「スキーマ→SDK 再生成一致」「全 stable 露出」を機構として検証。検証: generateSdk(gen-sdk-ts.mjs:68)/generateSdkPy(:137)、API_VERSION=x-apiVersion(ts:138)、@experimental 注記(ts:85/py:125)、httpErrorKind 正規化(ts:156)。出典 packages/kit/tests/sdk-ts-contract.test.js:14-37 / sdk-py-contract.test.js:13-28

### [CTR-0030] experimental tier が生成 SDK(ts/py)の @experimental 注記に伝播する
- surface: sdk
- backend: local
- command: gen-sdk-ts / gen-sdk-py
- branch: ts(JSDoc @experimental) | py(docstring @experimental)
- assert: x-stability=experimental のメソッドに生成 SDK が @experimental 注記(provenance 付き)を付与し、stable と型/ドキュメントレベルで区別する。SemVer 保証外であることを下流に伝える表示機構を固定する
- ref: scripts/gen-sdk-ts.mjs:85; scripts/gen-sdk-py.mjs:124; packages/kit/tests/sdk-ts-contract.test.js:27
- kind: contract-existence
- status: covered
- note: gen-sdk-ts.mjs:85=JSDoc '/** @experimental ${x-provenance} */'、gen-sdk-py.mjs:124=namespace メソッドの docstring '@experimental (${x-provenance})'(top-level は同 162 行)、sdk-ts-contract.test.js:27='experimental メソッドは @experimental 注記が付く'。SDK 全体の 1:1 被覆/署名 drift は SDK ドメイン spec が持つため、ここは experimental 注記伝播のみ

### [CTR-0031] nullable result schema が SDK 戻り型の | null / | None に伝播する
- surface: sdk
- backend: local
- command: gen-sdk-ts tsResultType / gen-sdk-py pyResultType(methodReturnType 経由)
- branch: nullable:true | 非 nullable
- assert: RESULT_SCHEMAS で nullable:true のメソッド(例 lock.status)は生成 SDK で TS `| null` / Python `| None` になる。値が null になりうる契約が SDK 型に正しく伝播することを固定する
- ref: packages/kit/src/serve/result-schemas.js:103; scripts/gen-sdk-ts.mjs:37; scripts/gen-sdk-py.mjs:55
- kind: contract-existence
- status: covered
- note: result-schemas.js:103=`"lock.status": nullable(DEVICE)`(nullable:true の出所)、gen-sdk-ts.mjs:37=`schema.nullable ? `${base} | null``、gen-sdk-py.mjs:55=`schema.nullable ? `${base} | None``(pyResultType、methodReturnType:90 が委譲)。nullable 単一真実源ヘルパは result-schemas.js:36

## experimental-display

experimental メソッド(keystore 等)が registry に存在し x-stability=experimental で契約面に正しく表出することを固定する。

### [CTR-0032] experimental メソッド(keystore 等)が registry に存在し x-stability=experimental で公開される
- surface: serve, sdk
- backend: local
- command: keystore.list / keystore.put / keystore.remove
- branch: -
- assert: keystore.* が registry に登録され、STABLE_METHODS 非掲載のため stabilityOf=experimental・provenanceOf=unverified として OpenRPC に射影される。experimental 機構が契約面に正しく表出することを固定する
- ref: packages/kit/tests/serve/keystore-rpc.test.js:35; packages/kit/src/serve/stability.js:57; packages/kit/src/serve/registry.js:380
- kind: contract-existence
- status: covered
- note: keystore-rpc.test.js:35='registry に登録されている'、stability.js:57=stabilityOf()(STABLE_METHODS 非掲載→experimental、provenanceOf は :66 で 'unverified' 既定)、registry.js:380=buildOpenRpcDoc の x-stability 射影。メソッド単位の hub 委譲 wire 形は KS ドメイン spec が持つため、ここは experimental 表示機構の不変条件のみ

## conformance-replay

記録済み上流応答が RESULT_SCHEMAS に適合する creds 不要のオフライン canary replay drift gate を固定する。

### [CTR-0033] 記録済み上流応答が RESULT_SCHEMAS に適合する (オフライン canary replay drift gate)
- surface: serve, sdk
- backend: local
- command: canary-upstream --replay / validate
- branch: 適合(exit 0) | スキーマ違反(exit 1, DRIFT) | nullable schema で null→許容 | 非 nullable で null→違反 | 値 undefined→違反
- assert: fixtures/upstream/*.json の記録済み上流応答が RESULT_SCHEMAS で検証され、適合時 exit 0・違反時 exit 1 で DRIFT 出力する。validate() は schema.nullable のとき value===null を許容し(lock.status / device.battery.lastEvaluatedKey の null fixture が nullable 経路で適合)、非 nullable schema で null を受けると違反、value===undefined も違反とする。観測 shape ↔ スキーマの一致を creds 不要で CI 常時ゲートする
- ref: scripts/canary-upstream.mjs:37; scripts/canary-upstream.mjs:40-42; scripts/canary-upstream.mjs:108; packages/kit/src/serve/result-schemas.js:98; packages/kit/src/serve/result-schemas.js:103; packages/kit/tests/serve/upstream-canary-replay.test.js:38
- kind: contract-existence
- status: covered
- note: validate(canary:37)は live(rpc.discover)と同一の schema 表現を評価し検証ロジック二重化を避ける。nullable 分岐は canary:40-42(value===null → schema.nullable ? [] : [違反])で、RESULT_SCHEMAS の nullable:true(result-schemas.js:103 lock.status / :98 device.battery.lastEvaluatedKey)を上流側で検証する。これにより nullable 契約が上流(canary) ↔ SDK 戻り型([[CTR-0031]] の `| null`/`| None`)の両端で閉じる。additionalProperties は許容(vendor 追加分は無視, canary:57)。canary:108 が RESULT_SCHEMAS[method] を引き fixture.sample(:117)を検証。test:38 がサブプロセスで exit 0/no-drift を確認。実測 19 テスト全 pass。機構レベルの二境界 drift ゲート

### [CTR-0034] 全 fixture の method が RESULT_SCHEMAS のキーであり sample を持つ
- surface: serve
- backend: local
- command: canary-upstream fixtures
- branch: -
- assert: fixtures/upstream/*.json の各 method が RESULT_SCHEMAS に実在し sample フィールドを持つ。stable read-only (status/account.whoami/devices.list/lock.status) の fixture が必ず存在する
- ref: packages/kit/tests/serve/upstream-canary-replay.test.js:46; packages/kit/tests/serve/upstream-canary-replay.test.js:56; packages/kit/src/serve/result-schemas.js:57
- kind: contract-existence
- status: covered
- note: fixtures 実在を確認(11 JSON: status/status.degraded/account.whoami/devices.list[+empty]/device.history/device.battery[+lastpage]/lock.status[+null]/lock.unlock、全て method+sample 保持)。test:46 が method⊆RESULT_SCHEMAS(:57)+sample 存在、test:56 が stable 4 種の fixture 存在を要求。機構レベルの fixture↔スキーマ整合

## i18n

kit+core 全 area の i18n カタログ完全性 (キー一致・重複ゼロ・{var} 一致・t() リテラル被覆) を固定する。

### [CTR-0035] i18n カタログ完全性: en/ja キー一致・area 間重複ゼロ・{var} 一致・t() リテラル全被覆
- surface: core, serve, cli
- backend: local
- command: registerCatalog / t / kit cli·serve·session + core 12 area
- branch: (1)en/ja キー集合一致 | (2)area間重複ゼロ | (3){var}一致 | (4)t()リテラル被覆
- assert: i18n カタログ完全性(en/ja キー一致・area 間重複ゼロ・{var} 一致・t() リテラル全被覆・registerCatalog 重複 throw)は [[I18N]] が正典として保持する
- ref: local-contract
- kind: i18n
- status: waived: 重複（正典 [[I18N]]）
- note: 正典は I18N ドメイン spec。i18n カタログ完全性ゲート(en/ja キー集合一致・area 間重複ゼロ・{var} 一致・kit src t() リテラル被覆・registerCatalog 起動時重複 throw)は I18N が単一真実源として索引する。本 CTR エントリは ID 永続のため waive 保持(契約自己整合ドメインからは i18n 完全性を扱わない)

## 監査追補 v2 (dual-audit)

デュアル監査(v2)で各監査人が独立に検出し人間裁定で採用された追加機構不変条件。

### [CTR-0036] pascal(method)→PascalCase 写像が非event registry メソッド全体に対し単射 (grpc-map silent 脱落ゼロ)
- surface: serve
- backend: local
- command: gen-grpc-proto pascal / grpc-methods.generated.json
- branch: -
- assert: pascal(method) が registry の非 events.* メソッド全体に対し単射であり、2 つの異なる JSON-RPC method 名が同一 Pascal に写像されて nameMap 後勝ち上書きで grpc-map から脱落することがない。grpc-methods.generated.json のエントリ数(203)が proto の typed rpc 数および非 event registry メソッド数と一致する(衝突による silent 脱落ゼロ)
- ref: scripts/gen-grpc-proto.mjs:28; scripts/gen-grpc-proto.mjs:135; packages/kit/src/serve/grpc-methods.generated.json:1
- kind: contract-existence
- status: covered
- note: framework 機構レベルの新規不変条件。[[CTR-0001]] は openrpc↔registry↔proto↔grpc-map の集合 1:1(205/203)を起票するが、pascal 写像が衝突しないこと(単射性)は別保証で未明示だった。pascal(:28-29)は method 名から非英数字を除去し PascalCase 連結するため 'ble.os2X'/'ble.os2.x' 系の op 追加時に衝突しても nameMap(:135 Object.fromEntries)が後勝ちで silently 上書きし、byte-drift gate([[CTR-0023]])が壊れるまで気付けない。実測 203 distinct pascal = 203 distinct method で衝突無し。schema-drift.test.js に Object.keys(nameMap).length === 非 event registry メソッド数 のアサート追加で直接ガードすべき

### [CTR-0037] dispatch コア makeResult の undefined→null 正規化と makeEvent の event.<topic> 命名規約
- surface: serve
- backend: local
- command: makeResult / makeEvent
- branch: result=undefined→null | makeEvent topic→event.<topic>
- assert: makeResult は result===undefined を null に正規化し(JSON-RPC 応答に result フィールドが必ず載る)、makeEvent は予約名 'event.<topic>' でイベントフレームを組む。この命名規約が gRPC Subscribe の prefix strip(grpc.js:187 で 'event.' を除去して topic 復元)と一致する
- ref: packages/core/src/jsonrpc.js:230; packages/core/src/jsonrpc.js:377; packages/kit/src/serve/framing/grpc.js:187
- kind: contract-existence
- status: covered
- note: [[CTR-0027]] の隣接機構(全 framing 共有の dispatch コア不変条件)。CTR-0027 は classify/handleMessage/makeError を被覆するが makeResult の undefined→null 正規化(jsonrpc.js:231)と makeEvent の event.<topic> 命名(:378)は assert に含まれない。event.<topic> 命名は daemon emit↔gRPC strip(grpc.js:187)↔SSE の wire 規約の単一真実源。jsonrpc.test.js で実テスト済みだが [ID] 索引が無かったため契約レベルで 1 行索引する

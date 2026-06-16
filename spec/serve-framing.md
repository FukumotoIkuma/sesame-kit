<!-- spec-domain: serve-framing | prefix: SRV | tests: packages/kit/tests/serve -->

# serve framing 機構 spec (SRV)

常駐デーモンの 7 framing(gRPC/HTTP/WS/ndjson/socket/stdio/token)の符号化・復号忠実度、proto3 presence、エラー封筒(kind→code)写像、daemon/registry 結線、stability/provenance ゲート、全 framing 等価性を監査する。メソッド単位の露出は各ドメイン spec へ。

## gRPC framing presence/glue

gRPC 型付き unary handler の proto3 presence 復号と jsonFields グルー、proto-loader 不変条件を固定する。

### [SRV-0001] gRPC optional-scalar presence: synthetic-oneof sentinel が省略/明示を判別する正規化機構
- surface: serve
- backend: local
- command: startGrpcFraming typed-unary / optional-scalar presence normalization
- branch: _field in params (明示送信→sentinel除去・値0/false/"" 維持) | _field 不在 (省略→field を params から削除)
- assert: 型付き unary handler は optionalScalars 各 f について、proto-loader(oneofs:true) が付与する synthetic oneof discriminator `_${f}` が params に在れば「明示送信」とみなし sentinel キーのみ削除して値(0/false/"" 含む)を維持し、不在なら「省略」とみなし f 自体を削除して daemon.invoke に未指定として届ける。これが「明示 0」と「未指定」を分離する presence 機構の中核で、0 一律 delete を禁ずる
- ref: packages/kit/src/serve/framing/grpc.js:124-132; packages/kit/src/serve/framing/grpc.js:102; packages/kit/tests/serve/grpc-presence.test.js:56-193
- kind: wire-fidelity
- status: covered
- note: 検証済: grpc.js:124-132 が sentinel 有無 (`_${f}` in params) で明示/省略を分岐する実 discriminator アルゴリズム、:102 が oneofs:true の loadSync。grpc-presence.test.js:56-193 は LockClick/LockSetAutolock 等ドメイン経由で観測するが [ID] タグ無し孤児

### [SRV-0002] gRPC jsonFields グルー: 空文字列は未指定扱いで削除、JSON.parse 失敗は INVALID_ARGUMENT(fieldMustBeJson)
- surface: serve
- backend: local
- command: startGrpcFraming typed-unary / jsonFields JSON decode glue
- branch: params[f]===undefined or '' (削除=未指定) | JSON.parse 成功 (オブジェクト化) | JSON.parse 失敗 (callback INVALID_ARGUMENT)
- assert: 型付き unary handler は jsonFields 各 f について、値が undefined または空文字列なら params から削除して未指定として届け(空 JSON 文字列は valid JSON でなく {}/null と区別できないため)、非空なら JSON.parse して動的オブジェクトを復元し、parse 失敗時は callback({code:INVALID_ARGUMENT, message:t('serve.grpc.fieldMustBeJson',{f})}) で打ち切る
- ref: packages/kit/src/serve/framing/grpc.js:137-140; packages/kit/src/serve/sesame.proto:1-3; packages/kit/src/i18n/serve.js:258
- kind: error-path
- status: covered
- note: 検証済: grpc.js:138 が undefined/'' delete、:139 が JSON.parse 失敗→callback(INVALID_ARGUMENT, t('serve.grpc.fieldMustBeJson',{f}))。proto:1-3 ヘッダが object/動的葉を string(json=true) で運ぶ写像の受信側、serve.js:258 が {f} 補間のカタログ実体

### [SRV-0003] gRPC proto-loader ロードオプション不変条件 (keepCase/longs:String/defaults/oneofs) が presence を成立させる
- surface: serve
- backend: local
- command: startGrpcFraming / protoLoader.loadSync options
- branch: -
- assert: startGrpcFraming は PROTO_PATH を loadSync({keepCase:true, longs:String, defaults:true, oneofs:true}) で読む。oneofs:true は proto3 optional の synthetic oneof 展開に必須(presence sentinel `_field` 生成の前提)、defaults:true は非 optional フィールドの初期値補完、longs:String は 64bit 安全、keepCase:true は field 名を camelCase 化させず JSON-RPC param 名と一致させる。この 4 オプションが grpc.js の presence/jsonFields グルーの動作契約を固定する
- ref: packages/kit/src/serve/framing/grpc.js:97-104; packages/kit/tests/serve/grpc-presence.test.js:18-23; scripts/gen-grpc-proto.mjs:10-16
- kind: contract-existence
- status: covered
- note: 検証済: grpc.js:102 (server 側 loadSync) と grpc-presence.test.js:20 (makeClient 側 loadSync) が同一 4 オプションを使うことを目視確認 — 不一致は presence 破綻を招くデコード設定の機構不変条件。gen-grpc-proto.mjs:10-16 が oneofs:true/optional 付与の前提を記す codegen 側ヘッダ

## gRPC framing codegen

proto テキストと grpc-methods.generated.json を生成する gen-grpc-proto の付与規則と自己整合を固定する。

### [SRV-0004] gen-grpc-proto optional 付与規則: required は非optional・repeated は非optional・無効名は単一 JSON params
- surface: serve, sdk
- backend: local
- command: gen-grpc-proto.mjs / proto field optional-application rule
- branch: required (optional 無し) | repeated string (proto3 仕様で optional 不可) | scalar/JSON-string non-required (optional 付与→optionalScalars 登録) | 無効 field 名 (単一 string params, json=true)
- assert: generateProto は各 param について useOptional = !required && !repeated を計算し、true のフィールドだけ proto に `optional` 前置 + optionalScalars に登録する。required scalar・repeated string には optional を付けず、proto フィールド名として無効な名前は単一 string `params`(jsonFields) に畳む。これにより proto の optional マーカ集合と grpc-methods.generated.json の optionalScalars が機構的に常に一致する
- ref: scripts/gen-grpc-proto.mjs:65-82; scripts/gen-grpc-proto.mjs:38-51; scripts/gen-grpc-proto.mjs:116-124
- kind: contract-existence
- status: covered
- note: 検証済: gen-grpc-proto.mjs:74-79 が useOptional=!isRequired&&!isRepeated を計算し optional/optionalScalars へ反映、:66-69 が validField 偽で単一 string params(jsonFields)、:38-51 が pbFieldType/validField、:120 が proto テキストの optional 前置。生成器の付与アルゴリズム自体 (required/repeated 除外規則) は機構レベル未被覆 (grep useOptional 0 件)

### [SRV-0005] grpc-methods.generated.json と sesame.proto の自己整合 (全 op で method 名・jsonFields・optionalScalars が proto と 1:1)
- surface: serve, sdk
- backend: local
- command: gen-grpc-proto.mjs / proto<->grpc-methods manifest self-consistency
- branch: -
- assert: 全エントリで grpc-methods.generated.json の各 Pascal キーが proto の対応 rpc/message と 1:1 対応し、jsonFields は対応 message の string(json=true) フィールド集合、optionalScalars は対応 message の `optional` マーカ付きフィールド集合に一致する(両者は同一 generateProto 実行の nameMap/proto 出力で、手編集禁止)。Subscribe/Invoke/JsonRpc/SubReq/Event は手書き定型部として methodMap に現れない
- ref: packages/kit/src/serve/grpc-methods.generated.json:1-5; packages/kit/src/serve/sesame.proto:415-418; scripts/gen-grpc-proto.mjs:135-146
- kind: contract-existence
- status: covered
- note: 検証済: gen-grpc-proto.mjs:135 が proto/nameMap を同一 methods 配列から生成 (手編集禁止ヘッダ :90)、:144-145 が両ファイルを書き出す。proto:415-418 は手書き Subscribe/Invoke rpc 部 (methodMap に現れない定型) を含む region。generated.json:1-5 が Pascal→{method,jsonFields,optionalScalars} 構造

## gRPC framing optional-deps/i18n

gRPC スタックの遅延 import と serve.grpc.* カタログ完全性を固定する。

### [SRV-0006] gRPC optional peerDependency 遅延 import: 未導入時に i18n 済み導入案内 (serve.grpc.missingDeps)
- surface: serve
- backend: local
- command: startGrpcFraming / importOptional(@grpc/grpc-js, @grpc/proto-loader)
- branch: 導入済 (default を取得し起動継続) | 未導入 (missingHint 付きで importOptional が throw)
- assert: startGrpcFraming は @grpc/grpc-js と @grpc/proto-loader をトップレベル import せず関数内で importOptional(name, t('serve.grpc.missingDeps')) により遅延 import する。未導入なら `npm i @grpc/grpc-js @grpc/proto-loader` を案内する i18n 済みエラーを投げ、grpcStatusFor も grpc を捕捉するため module スコープから関数スコープへ移動している。これにより --grpc 以外の framing は gRPC スタック不在でも影響を受けない
- ref: packages/kit/src/serve/framing/grpc.js:69-95; packages/kit/src/optional-deps.js:38-45; packages/kit/src/i18n/serve.js:260
- kind: contract-existence
- status: covered
- note: 検証済: grpc.js:72-78 が missingHint=t('serve.grpc.missingDeps') で importOptional 遅延 import、:85-95 で grpcStatusFor が関数スコープへ移動 (grpc を捕捉)。optional-deps.js:38-45 が importOptional 実体 (未導入→ERR_OPTIONAL_DEP_MISSING+hint)。serve.js:260 が en カタログの missingDeps 実体。全 spec で本機構 (P5-1 optional peerDependencies) 未被覆 (grep missingDeps/importOptional 0 件)

### [SRV-0007] serve.grpc.* i18n キー (unauthorized/fieldMustBeJson/unknownTopics/missingDeps) の en/ja 完全性
- surface: serve
- backend: local
- command: i18n catalog completeness / serve.grpc.* keys
- branch: -
- assert: grpc.js が t() で参照する 4 キー serve.grpc.{unauthorized,fieldMustBeJson,unknownTopics,missingDeps} が serve.js の en/ja 両カタログに存在し、{f}/{topics} プレースホルダが en/ja で一致する(i18n-catalog 完全性: en↔ja キー一致・area 間重複ゼロ・{var} 一致・kit/src の t リテラルが全てカタログに在る)
- ref: packages/kit/src/i18n/serve.js:257-260; packages/kit/src/i18n/serve.js:513-516; packages/kit/tests/i18n-catalog.test.js:75-92
- kind: i18n
- status: covered
- note: 検証済: serve.js:257-260 (en)・:513-516 (ja) に 4 キーが対で存在し fieldMustBeJson {f}・unknownTopics {topics} の補間が en/ja 一致。i18n-catalog.test.js:75-92 (テスト(3) {var} プレースホルダ一致) が placeholder 整合の正準 test。serve.grpc.* キー群への [ID] 索引が無く item 化が必要

## gRPC framing streaming/lifecycle

gRPC Subscribe の背圧・サーバ停止・stream エラー伝達・後方互換 Invoke を固定する。

### [SRV-0008] gRPC Subscribe 背圧: call.write 未排出 (!ok) の累積が MAX_BUFFERED(4MB) 超過で当該接続のみ close、drain で復帰
- surface: serve
- backend: local
- command: startGrpcFraming Subscribe / server-stream backpressure
- branch: call.write 返り ok (継続) | !ok (buffered+=json.length) → buffered>MAX_BUFFERED (conn.close) | drain イベント (buffered=0 にリセット)
- assert: Subscribe の conn.send は call.write({topic,json}) の返り値が false のとき json.length を buffered に加算し、MAX_BUFFERED(4MB) を超えた遅い購読者の接続のみ conn.close() で切る(他接続に影響しない lossy 背圧)。call.on('drain') で buffered を 0 にリセットし、write 例外は closed として握り潰す
- ref: packages/kit/src/serve/framing/grpc.js:178-191; packages/kit/src/serve/framing/grpc.js:179; packages/kit/src/serve/framing/grpc.js:189
- kind: wire-fidelity
- status: covered
- note: 検証済(全 ref 実在): buffered=0 初期化(178)/MAX_BUFFERED=4MB(179)/drain で reset(180)/!ok→buffered+=json.length→>MAX_BUFFERED で conn.close(189)/catch{/*closed*/}(190)。WS/NDJSON 背圧とは別の gRPC MAX_BUFFERED/drain 背圧で未被覆。機構レベル(ドメインメソッド非依存)

### [SRV-0009] gRPC server stop(): tryShutdown を試み 1s で畳めなければ forceShutdown でハングを断つ
- surface: serve
- backend: local
- command: startGrpcFraming stop / graceful-then-force shutdown
- branch: tryShutdown が 1s 以内に完了 (clearTimeout→resolve) | 1s タイムアウト (forceShutdown で全 call 即キャンセル→resolve)
- assert: stop() はまず server.tryShutdown() で graceful 終了を試み、1s の unref タイマで畳めなければ server.forceShutdown() を呼び全 call を即キャンセルして resolve する。done フラグで二重 resolve を防ぐ。これは Subscribe ストリームが開いている限り tryShutdown が待ち続けハングする問題への機構的対処
- ref: packages/kit/src/serve/framing/grpc.js:227-233; packages/kit/src/serve/framing/grpc.js:42-50
- kind: idempotency
- status: covered
- note: 検証済: stop() の done ガード+1s setTimeout(unref)→forceShutdown / tryShutdown(()=>clearTimeout+finish) は 227-233。endStreamWithError=call.emit('error',{code,details})(42-50) が非OK status 伝達の支持。grpc-js は package.json:53 で ^1.14.4。永続 Subscribe ストリーム下のサーバ停止不変条件で全 spec 未被覆

### [SRV-0010] gRPC server-stream の非OK status は emit('error',{code,details}) で返す (call.destroy は黙ってハング)
- surface: serve
- backend: local
- command: startGrpcFraming endStreamWithError / server-stream non-OK status
- branch: UNAUTHENTICATED (token 不一致) | INVALID_ARGUMENT (unknownTopics)
- assert: Subscribe が非 OK status をクライアントに返す唯一の手段は endStreamWithError = call.emit('error',{code,details}) であり、grpc-js 1.14 では call.destroy() が status を伝えず黙ってハングするため使えない(実測)。token 不一致は UNAUTHENTICATED、daemon.topics に無い topic は addConnection 前に INVALID_ARGUMENT(unknownTopics) でストリームを閉じる
- ref: packages/kit/src/serve/framing/grpc.js:42-50; packages/kit/src/serve/framing/grpc.js:177; packages/kit/src/serve/framing/grpc.js:196-204; packages/kit/tests/serve/grpc.test.js:103-114
- kind: error-path
- status: covered
- note: 検証済: endStreamWithError=call.emit('error',{code,details})(42-50, doc コメントに『call.destroy() は status を伝えず黙ってハング(実測)』)。token 不一致→UNAUTHENTICATED+return(177)。daemon.subscribe(daemon.js:275-281)は topic を検証しないため grpc 側で daemon.topics に対し明示検証し addConnection 前に INVALID_ARGUMENT(196-204)。test:103-114 は不正 topic→INVALID_ARGUMENT。emit('error') vs call.destroy という server-stream の status 伝達機構自体は未被覆

### [SRV-0011] 後方互換 Invoke は dispatchMessage を通し JSON-RPC 文字列で運ぶ (型付き面に無い op の汎用経路)
- surface: serve
- backend: local
- command: startGrpcFraming Invoke / generic JSON-RPC passthrough
- branch: out===null (通知→callback(null,{json:''})) | 非null (callback(null,{json:JSON.stringify(out)}))
- assert: Invoke は call.request.json を daemon.dispatchMessage(conn, raw) にそのまま渡し、戻り out が null のとき {json:''}、非 null のとき {json:JSON.stringify(out)} で返す。ephemeral 接続を addConnection/removeConnection で囲み、型付き面(methodMap)に無い op を型なし JSON-RPC として通す後方互換経路を成立させる(rpc Invoke は proto に独立定義され methodMap には無い)
- ref: packages/kit/src/serve/framing/grpc.js:163-172; packages/kit/src/serve/daemon.js:199-200; packages/kit/src/serve/sesame.proto:417; packages/kit/tests/serve/grpc.test.js:135-142
- kind: contract-existence
- status: covered
- note: refs 全実在・支持確認。grpc.js:169 dispatchMessage 委譲 / 171 out===null?'':JSON.stringify(out)、daemon.js:199-200 dispatchMessage→handleMessage、proto:417 rpc Invoke(JsonRpc) returns(JsonRpc)(methodMap に Invoke キー無し=型付き面外)、test:135-142 Invoke で rpc.discover。dispatchMessage 委譲という機構経路(型なし op の受け皿)を機構レベルで固定し、null→'' 分岐は branch のみ記載

## HTTP framing

POST /rpc 認証・応答符号化・body 上限・CORS・SSE・ルーティングを固定する。

### [SRV-0012] HTTP POST /rpc: token必須→未認証は401で JSON-RPC 2.0 error(id:null, APP_ERROR, kind=not_authenticated)+WWW-Authenticate:Bearer
- surface: serve
- backend: local
- command: HTTP framing POST /rpc auth
- branch: token一致 | token不一致/欠落
- assert: 401 も平文でなく JSON-RPC 2.0 error 封筒で返す: code は RPC.APP_ERROR、data.kind=not_authenticated、www-authenticate ヘッダ付与。旧 {error,hint} 形ではない (回帰防止)
- ref: packages/kit/src/serve/framing/http.js:87; packages/kit/src/serve/framing/http.js:92; packages/kit/src/serve/framing/http.js:95; packages/kit/tests/serve/http-ws.test.js:37
- kind: error-path
- status: covered
- note: 検証済: code/kind の load-bearing 行は L95 の makeError(...,RPC.APP_ERROR,...,KIND.NOT_AUTHENTICATED)、www-authenticate:Bearer は L92。test:37 が回帰防止 (j.error.data.kind==='not_authenticated' / hint undefined) を確認

### [SRV-0013] HTTP POST /rpc: 通知(応答null)は204、応答ありは200+application/json、ephemeral=true で events.* を弾く短命接続
- surface: serve
- backend: local
- command: HTTP framing POST /rpc response framing
- branch: dispatch null(通知)→204 | 応答あり→200 | dispatch throw→internal
- assert: POST は 1 往復: dispatchMessage が null(通知)なら 204 無 body、応答ありは 200 + content-type application/json。conn.ephemeral=true で event.ready 不送出・購読不可。dispatch throw は INTERNAL_ERROR 封筒へ
- ref: packages/kit/src/serve/framing/http.js:132; packages/kit/src/serve/framing/http.js:138; packages/kit/src/serve/framing/http.js:141; packages/kit/src/serve/framing/http.js:142
- kind: wire-fidelity
- status: covered
- note: 検証済: 'dispatch throw→INTERNAL_ERROR' を支える行は L138 の catch 内 makeError(...,RPC.INTERNAL_ERROR,...,KIND.INTERNAL)。L132 ephemeral:true / L141 通知→204 / L142 応答→200+application/json

### [SRV-0014] HTTP body 上限 1MB: 超過は 413(connection:close) + 残り body を破棄しつつ受け切る(O(1)メモリ, RST回避)
- surface: serve
- backend: local
- command: HTTP framing MAX_BODY guard
- branch: size<=MAX_BODY | size>MAX_BODY(413後 discard) | discard>MAX_BODY(destroy)
- assert: size>MAX_BODY で 413 を返した後、即 socket destroy せず残チャンクを破棄しつつ受け切る (送った 413 を届ける)。ただし破棄量も MAX_BODY 超で req.destroy (DoS 二段防御)
- ref: packages/kit/src/serve/framing/http.js:11; packages/kit/src/serve/framing/http.js:114; packages/kit/src/serve/framing/http.js:119; packages/kit/src/serve/framing/http.js:121; packages/kit/src/serve/framing/http.js:115
- kind: error-path
- status: covered
- note: 検証済: L11 MAX_BODY=1MB / L114 discarded += c.length(破棄しつつ受切る) / L119 size>MAX_BODY 検知 / L121 413 writeHead+connection:close / L115 discard>MAX_BODY→req.destroy(DoS 二段防御)

### [SRV-0015] HTTP CORS はオプトイン: 未指定なら ACAO 一切無し / allowlist は許可originのみecho+Vary:Origin / '*' は全echo / OPTIONS preflight は token不要204
- surface: serve
- backend: local
- command: HTTP framing CORS
- branch: corsOrigins=null | allowlist(許可/許可外) | '*' | OPTIONS preflight
- assert: CORS 無効時は preflight も通常処理(token無 OPTIONS=401)。allowlist は許可 origin のみ echo し非 '*' は Vary:Origin、許可外は ACAO 無し。'*' は req origin を echo。preflight は token 不要 204
- ref: packages/kit/src/serve/framing/http.js:19; packages/kit/src/serve/framing/http.js:33; packages/kit/src/serve/framing/http.js:34; packages/kit/src/serve/framing/http.js:50; packages/kit/src/serve/framing/http.js:63
- kind: option-branch
- status: covered
- note: 検証済: L19 オプトイン宣言 / L33 '*'=reqOrigin||'*' echo / L34 allowlist includes 判定で許可 origin のみ返す / L50 非'*'時 Vary:Origin / L63 OPTIONS preflight。allowedOrigin(L31-36) が許可外 null=ACAO 無しを保証

### [SRV-0016] HTTP GET /events (SSE): text/event-stream + 初期 ': ok' / data:行+改行2 フレーム境界 / 25s ハートビート / 不正topicは事前検証で400
- surface: serve
- backend: local
- command: HTTP framing GET /events (SSE)
- branch: topics空 | 一部有効 | 全不正→400 | event push
- assert: SSE フレーム符号化: 確立コメント ': ok' + 空行、各 event は 'data: '+JSON+ 空行、25s ': ping' ハートビート。topics 指定があり全て daemon.topics 外なら 400+valid一覧、空指定は購読なしで確立
- ref: packages/kit/src/serve/framing/http.js:148; packages/kit/src/serve/framing/http.js:152; packages/kit/src/serve/framing/http.js:162; packages/kit/src/serve/framing/http.js:167; packages/kit/src/serve/framing/http.js:173
- kind: wire-fidelity
- status: covered
- note: 検証済(全行一致): L148 /events 入口 / L152 reqTopics>0 かつ validTopics=0→400(+L154 valid:daemon.topics 一覧) / L162 確立コメント / L167 'data: '+JSON / L173 25s ': ping' heartbeat。空指定は L150-151 で validTopics=[] となり購読なし確立

### [SRV-0017] HTTP GET / は token不要の usage / GET /events 以外の未知 path/method は 404 JSON
- surface: serve
- backend: local
- command: HTTP framing routing
- branch: GET / | 未知 path/method
- assert: GET / は token 検証前に通り usage を返す(--http 0 でも実 boundPort を表示)。/rpc /events /(と OPTIONS) 以外は token 通過後 404 {error}
- ref: packages/kit/src/serve/framing/http.js:81; packages/kit/src/serve/framing/http.js:83; packages/kit/src/serve/framing/http.js:178; packages/kit/src/serve/framing/http.js:191
- kind: error-path
- status: covered
- note: refs 全行確認済: 81=GET/分岐(token検証より前), 83=usage(boundPort), 178=404 JSON(token通過後), 191=boundPort 実バインド代入。OPTIONS は line63 で token 不要 204。横断機構(framing routing)レベル, ドメイン固有メソッド重複なし

## WS framing

WebSocket の握手前認証・1メッセージ1JSON フレーム・背圧を固定する。

### [SRV-0018] WS 握手前 token 検証 (verifyClient): 失敗は 101 を返さず 401 (open発火させずクライアントが認証失敗を取りこぼさない)
- surface: serve
- backend: local
- command: WS framing verifyClient
- branch: token一致(101) | token不一致(401) | onConnection 防御再確認(1008)
- assert: verifyClient で upgrade 前に弾くため未認証は open でなく 401。1008 close は握手後で open に先を越されるため不採用。onConnection でも防御的に再検証し失敗は 1008
- ref: packages/kit/src/serve/framing/ws.js:19; packages/kit/src/serve/framing/ws.js:23; packages/kit/src/serve/framing/ws.js:24; packages/kit/src/serve/framing/ws.js:29; packages/kit/src/serve/framing/ws.js:30; packages/kit/tests/serve/http-ws.test.js:168
- kind: error-path
- status: covered
- note: refs 確認済: 19=握手前検証コメント, 23=verifyClient定義, 24=WebSocketServer に verifyClient 注入, 29=onConnection 防御再検証条件, 30=ws.close(1008)。test:168='token 無しは握手で拒否 (401。open は発火しない)' 一致

### [SRV-0019] WS フレーム=1メッセージ1JSON: send は JSON.stringify、受信 message は data.toString() を handleLine、event 通知がそのまま流れる持続接続
- surface: serve
- backend: local
- command: WS framing message framing
- branch: send | message受信 | close | error
- assert: WS は 1 接続=持続 Connection: 各 ws message を 1 行として handleLine、send は JSON.stringify 1 フレーム。close で removeConnection、error で conn.close
- ref: packages/kit/src/serve/framing/ws.js:37; packages/kit/src/serve/framing/ws.js:39; packages/kit/src/serve/framing/ws.js:44; packages/kit/src/serve/framing/ws.js:45; packages/kit/src/serve/framing/ws.js:46
- kind: wire-fidelity
- status: covered
- note: refs 確認済: 37=send定義, 39=ws.send(JSON.stringify(obj)), 44=message→handleLine(data.toString()), 45=close→removeConnection, 46=ws.on('error', ()=>conn.close())

### [SRV-0020] WS 背圧: bufferedAmount>4MB の遅い購読者は conn.close で切る (通知 lossy・デーモンは止めない)
- surface: serve
- backend: local
- command: WS framing MAX_BUFFERED backpressure
- branch: bufferedAmount<=4MB | >4MB→close
- assert: send 前に ws.bufferedAmount>MAX_BUFFERED(4MB) なら conn.close して return (追いつけない購読者をその接続だけ切る背圧機構)
- ref: packages/kit/src/serve/framing/ws.js:11; packages/kit/src/serve/framing/ws.js:38
- kind: error-path
- status: covered
- note: refs 確認済: 11=MAX_BUFFERED=4*1024*1024(4MB)定義, 38=send 内 ws.bufferedAmount>MAX_BUFFERED→conn.close;return。横断背圧機構レベル

## NDJSON framing

stdio/socket 共有の行分割・OOM 防御・出力背圧・close 冪等を固定する。

### [SRV-0021] NDJSON 行境界: 改行区切りで行分割、チャンク跨ぎ連結、空行(trim)スキップ、StringDecoder でマルチバイト UTF-8 復元
- surface: serve
- backend: local
- command: NDJSON makeLineConnection onData
- branch: 完全行 | チャンク跨ぎ | 空行 | マルチバイト境界
- assert: stdio/socket 共有の行分割機構: indexOf('\n') で 1 行ずつ取り出し残りを inbuf に保持、line.trim() 空はスキップ、decoder.write でチャンク跨ぎの UTF-8 を正しく結合
- ref: packages/kit/src/serve/framing/ndjson.js:26; packages/kit/src/serve/framing/ndjson.js:55; packages/kit/src/serve/framing/ndjson.js:57; packages/kit/src/serve/framing/ndjson.js:60
- kind: wire-fidelity
- status: covered
- note: refs 確認済: 26=StringDecoder('utf8'), 55=inbuf+=decoder.write(chunk)(チャンク跨ぎ復元), 57=while indexOf('\n')(行抽出), 60=if(line.trim())onLine(空行スキップ)。stdio/socket 共有の横断行分割機構

### [SRV-0022] NDJSON maxLine 超過(改行無し1行が上限超)→DoS切断: socket(closeWritable)は強制destroy / stdio(共有stdout)はwritable非破壊
- surface: serve
- backend: local
- command: NDJSON maxLine OOM guard
- branch: inbuf<=maxLine | inbuf>maxLine & closeWritable=true | inbuf>maxLine & closeWritable=false
- assert: 改行が来ないまま inbuf>maxLine(既定1MB)で切断。writable 所有時(socket)は writable.destroy で確実に切り、stdout 共有(stdio, closeWritable=false)は writable を触らない。切断後の入力は closed ガードで無視
- ref: packages/kit/src/serve/framing/ndjson.js:21; packages/kit/src/serve/framing/ndjson.js:66; packages/kit/src/serve/framing/ndjson.js:67; packages/kit/tests/serve/ndjson.test.js:73; packages/kit/tests/serve/ndjson.test.js:90
- kind: error-path
- status: covered
- note: refs 確認済: 21=既定値 maxLine=1_000_000/closeWritable=false, 66=if(inbuf.length>maxLine)切断, 67=closeWritable 時 writable.destroy(socket)。test:73='改行の無い行が maxLine を超えたら切断し、以後の入力を無視する', test:90='closeWritable=false…では writable を destroy しない'。横断 OOM 防御機構

### [SRV-0023] NDJSON 出力背圧: write が false で draining→queue、drain で順序保持 flush、再背圧で flush 中断、maxQueue 超でその接続だけ close
- surface: serve
- backend: local
- command: NDJSON makeLineConnection send/drain
- branch: write true(直接) | false(queue) | drain flush | drain中再背圧 | queue>maxQueue→close
- assert: write が false を返したら以後 queue に積み(FIFO順序保持)、drain で write が再 false なら flush 中断、queue.length>maxQueue(既定1000)で conn.close。close 後 send は無視
- ref: packages/kit/src/serve/framing/ndjson.js:33; packages/kit/src/serve/framing/ndjson.js:36; packages/kit/src/serve/framing/ndjson.js:41; packages/kit/src/serve/framing/ndjson.js:72; packages/kit/tests/serve/ndjson.test.js:116
- kind: error-path
- status: covered
- note: refs 確認済: 33=send(obj), 36=if(draining)queue分岐, 41=if(!writable.write(line))draining=true, 72=writable.on('drain')flush。test:116='write が false を返したら以後は queue に積み、drain で順序どおり flush する'。横断出力背圧機構

### [SRV-0024] NDJSON close 冪等性: 二度呼んでも onClose は1回、readable end/error でも close
- surface: serve
- backend: local
- command: NDJSON makeLineConnection close idempotency
- branch: close x2 | readable end | readable error
- assert: closed フラグで close は冪等 (onClose は 1 回だけ)、readable の end/error も conn.close を発火する。closeWritable 時のみ writable.end
- ref: packages/kit/src/serve/framing/ndjson.js:43; packages/kit/src/serve/framing/ndjson.js:47; packages/kit/src/serve/framing/ndjson.js:81; packages/kit/src/serve/framing/ndjson.js:82; packages/kit/tests/serve/ndjson.test.js:176
- kind: idempotency
- status: covered
- note: 検証済: L43 close()=L44 の closed ガードで冪等、L47 が closeWritable 時のみ writable.end、L81/L82 が readable end/error→conn.close。test L176 が二度呼び→onClose 1回、L187 が end でも close。framing 機構レベルの境界

## socket framing

Unix domain socket の stale 検出・0600 権限生成を固定する。

### [SRV-0025] Unix socket: listen前生存確認 → 生きてれば拒否(already running) / staleなら unlink して継続 (無条件 unlink しない)
- surface: serve
- backend: local
- command: socket framing ensureFreeSocket
- branch: 存在しない | live socket(reject) | stale socket(unlink)
- assert: 既存 socket に probe connect: connect 成功=別デーモン生存で reject、error(接続不可)=stale とみなし unlinkSync して resolve。存在しなければ即 resolve
- ref: packages/kit/src/serve/framing/socket.js:20; packages/kit/src/serve/framing/socket.js:22; packages/kit/src/serve/framing/socket.js:24; packages/kit/src/serve/framing/socket.js:28; packages/kit/tests/serve/socket.test.js:69; packages/kit/tests/serve/socket.test.js:78
- kind: error-path
- status: covered
- note: 検証済: ensureFreeSocket=L20、L22 が existsSync 無→即 resolve、L24 が probe connect 成功→reject(already running)、L28 が error→unlinkSync+resolve(stale)。test L69 が stale→unlink 起動、L78 が live→拒否(/already running/)

### [SRV-0026] Unix socket は 0600 で生成 (umask(0o177) で囲み復元) + 親 dir を 0700 で用意/締め直し (POSIX専用)
- surface: serve
- backend: local
- command: socket framing 0600 listen / ensureSecureDir
- branch: listen成功 | listen失敗(umask復元) | 親dir未存在 | 親dir緩い権限
- assert: net.listen は mode を無視するため process.umask(0o177) で囲んで socket を 0600 生成し finally で umask 復元。親 dir は ensureSecureDir で 0700 (未作成は作る・緩い権限は締める)
- ref: packages/kit/src/serve/framing/socket.js:63; packages/kit/src/serve/framing/socket.js:66; packages/kit/src/serve/framing/socket.js:70; packages/kit/src/serve/framing/socket.js:73; packages/core/src/secure-fs.js:30-34; packages/kit/tests/serve/socket.test.js:55; packages/kit/tests/serve/socket.test.js:84
- kind: error-path
- status: covered
- note: 検証済: L63 ensureSecureDir(dirname)、L66 umask(0o177)、L70 server.listen、L73 finally で umask 復元。test L55 が socket 0600、L84 が親未作成→0700 作成、L97(skipIf win32) が緩い親 dir(0755)→0700 締め直し。ensureSecureDir 本体は secure-fs.js:30-34 (mkdir 0700 + chmodSync で既存も締める)

## stdio framing

stdin/stdout 単一持続接続と EOF→shutdown を固定する。

### [SRV-0027] stdio framing: stdin/stdout NDJSON 単一持続接続、stdin EOF(onClose)で removeConnection+onShutdown、stdout共有で closeWritable=false
- surface: serve
- backend: local
- command: stdio framing startStdioFraming
- branch: stdin EOF→onShutdown | onShutdown 未指定
- assert: process.stdin/stdout を makeLineConnection でつなぐ単一 Connection。onClose(=stdin EOF=親終了)で removeConnection し onShutdown を呼んでデーモンを畳む。stdout はプロセス共有で閉じない
- ref: packages/kit/src/serve/framing/stdio.js:11; packages/kit/src/serve/framing/stdio.js:13; packages/kit/src/serve/framing/stdio.js:16; packages/kit/src/serve/framing/stdio.js:17; packages/kit/src/serve/framing/stdio.js:19
- kind: wire-fidelity
- status: covered
- note: 検証済 (純ローカル契約): L11 startStdioFraming、L13 makeLineConnection(process.stdin, process.stdout) で単一 Connection、L16 removeConnection、L17 if(onShutdown) onShutdown() で両分岐 (指定/未指定)、L19 が closeWritable=false (stdout 共有=閉じない) を記す。実起動 e2e は all-framings-e2e.test.js が別途カバー

## token framing

Bearer 解析・トークン抽出優先順・定数時間比較を固定する。

### [SRV-0028] parseBearer ReDoS安全: anchored /^Bearer\s+/i で線形、scheme大小区別なし、scheme単独はnull、空token後は空文字
- surface: serve
- backend: local
- command: token framing parseBearer
- branch: Bearer<sp>token | 大小違いscheme | 非Bearer/scheme単独/非文字列 | scheme+空 | 大量空白(ReDoS)
- assert: Bearer 解析の単一実装 (http/ws/grpc 共有): prefix のみ正規表現照合し残りは slice+trim。scheme は /i、'Bearer'(空白なし)/'Basic'/非文字列は null、'Bearer '+空白のみは空文字、10万空白でも線形(<200ms)
- ref: packages/kit/src/serve/framing/token.js:36; packages/kit/src/serve/framing/token.js:37; packages/kit/src/serve/framing/token.js:38; packages/kit/src/serve/framing/token.js:40; packages/kit/src/serve/framing/grpc.js:56-62; packages/kit/tests/serve/token.test.js:30
- kind: wire-fidelity
- status: covered
- note: P1-17: grpc.js が旧禁止 regex を再実装していた重複を解消した単一実装の不変条件。検証済: L36 parseBearer、L37 非文字列→null、L38 anchored /^Bearer\s+/i (後続に重なる量指定子なし=線形)、L40 slice+trim。grpc.js:56-62 metaToken が parseBearer を再利用 (旧 /^Bearer\s+(.+)$/i 重複を解消)。test L30 が 10万空白<200ms。framing 横断機構

### [SRV-0029] extractToken 優先順: Authorization:Bearer 最優先、空Bearerでもクエリへ落ちない、ヘッダ無し時のみ ?token= フォールバック
- surface: serve
- backend: local
- command: token framing extractToken
- branch: Bearerヘッダあり | 空Bearer | ヘッダ無し+クエリ | 両方無し
- assert: parseBearer が null 以外(空文字含む)を返せばそれを採用しクエリへ落ちない (空 Bearer を ?token= で上書きさせない従来挙動)。ヘッダ無し時のみ ?token= クエリ、両方無しは空文字
- ref: packages/kit/src/serve/framing/token.js:52; packages/kit/src/serve/framing/token.js:53; packages/kit/src/serve/framing/token.js:56; packages/kit/src/serve/framing/token.js:58; packages/kit/tests/serve/token.test.js:45
- kind: wire-fidelity
- status: covered
- note: 検証済: L52 extractToken、L53 parseBearer(req.headers?.authorization)、L56 fromHeader!==null で採用(空文字含む・クエリへ落ちない)、L58 ヘッダ無し時のみ URL searchParams 'token' || ''。test L45 が空 Bearer→クエリ不採用、L50/L54 がフォールバック/両無し

### [SRV-0030] tokenMatches 定数時間比較: 型不正/長さ不一致は即false、timingSafeEqual で内容比較 (CSRF/他ユーザ対策)
- surface: serve
- backend: local
- command: token framing tokenMatches / generateToken
- branch: 一致 | 不一致 | 長さ不一致 | 型不正(非文字列)
- assert: 32byte hex token を timingSafeEqual で定数時間比較。provided/expected が非文字列なら false、長さ不一致は timingSafeEqual 前に false (Buffer 長差の例外回避)。比較がタイミングリークしない。loopback の HTTP/WS/gRPC が同一 tokenMatches を共有し UDS は同一ユーザ前提で token 不要
- ref: packages/kit/src/serve/framing/token.js:7; packages/kit/src/serve/framing/token.js:16; packages/kit/src/serve/framing/token.js:17; packages/kit/src/serve/framing/token.js:18; packages/kit/src/serve/framing/token.js:20; packages/kit/tests/serve/token.test.js:61
- kind: crypto-vector
- status: covered
- note: 検証済: L7 generateToken=randomBytes(32).toString('hex')、L16 tokenMatches、L17 非文字列→false、L18 長さ不一致→false (timingSafeEqual 前、Buffer 長差例外回避)、L20 が実 timingSafeEqual(定数時間比較)。test の実 it は L61 (一致/不一致/長さ不一致/型不正)。grpc.js:117 unary handler が同一 tokenMatches で照合、UDS は token 不要という機構境界

## JSON-RPC 封筒

全 framing が funnel する classify/handleMessage/makeError/errorFromThrow を固定する。

### [SRV-0031] classify() メッセージ分類: parse-error / batch拒否 / invalid(jsonrpc!="2.0"・method欠落) / notification(id無し) / request(id:null含む)
- surface: serve, core
- backend: local
- command: JSON-RPC classify / handleMessage
- branch: parse-error | batch | invalid | notification | request
- assert: 全 framing が funnel する 1 行分類が JSON-RPC 2.0 規約どおり: 配列=batch→-32600、jsonrpc!="2.0"/method非文字列=invalid、'id' キー欠落=通知(応答null)、id:null は通知でなく request として応答する
- ref: packages/core/src/jsonrpc.js:301; packages/core/src/jsonrpc.js:309; packages/core/src/jsonrpc.js:314; packages/core/src/jsonrpc.js:317; packages/core/src/jsonrpc.js:323; packages/core/src/jsonrpc.js:345
- kind: wire-fidelity
- status: covered
- note: 検証済: classify(301)/Array→batch(309, handleMessage で INVALID_REQUEST=-32600 @352)/jsonrpc!="2.0"→invalid(314)/method非文字列 or 空→invalid(317)/!("id" in msg)=通知・id:null=request の境界(323)/全 framing funnel の handleMessage(345)。RPC.INVALID_REQUEST=-32600(jsonrpc.js:125)。機構レベル不変条件(ドメインメソッド非依存)

### [SRV-0032] 通知 (id欠落) はエラーでも一切応答を返さない (silent invoke)
- surface: serve, core
- backend: local
- command: JSON-RPC handleMessage notification path
- branch: notification invoke ok | notification invoke throw
- assert: type=notification は invoke を実行するが、成功・throw いずれでも応答オブジェクトを返さず null を返す (JSON-RPC 2.0: 通知に応答禁止)。throw は catch して沈黙する
- ref: packages/core/src/jsonrpc.js:355; packages/core/src/jsonrpc.js:357; packages/core/src/jsonrpc.js:358
- kind: wire-fidelity
- status: covered
- note: 検証済: case "notification"(355) で invoke を await・throw は catch{/*通知はサイレント*/}(357)、いずれの経路でも return null(358)。機構レベル(ドメインメソッド非依存)

### [SRV-0033] batch(配列)と parse 不能はプロトコルレベルで拒否し(-32600/-32700)、id:null は通知でなく request
- surface: core
- backend: local
- command: handleMessage / classify
- branch: parse-error(-32700) | batch(-32600) | invalid(jsonrpc!=2.0) | id:null→request
- assert: batch は v1 で INVALID_REQUEST+bad_params、parse 失敗は PARSE_ERROR+bad_params。classify が Array→batch・JSON.parse 失敗→parse-error・id:null は normalizeId が null を保持し request として応答する
- ref: packages/core/src/jsonrpc.js:301-325; packages/core/src/jsonrpc.js:345-369
- kind: error-path
- status: covered
- note: 検証済: classify(301-325) が Array→{type:batch}(309)・JSON.parse 失敗→{type:parse-error}(306-307)・id:null は request(324)を分類。handleMessage(345-369) が batch→INVALID_REQUEST+BAD_PARAMS(352)・parse-error→PARSE_ERROR+BAD_PARAMS(350)。SRV-0031 が classify 5分岐の wire-fidelity 索引、本 item は batch/parse の error 封筒(code)に焦点

### [SRV-0034] makeError: error.data に inbound params を絶対 echo しない / kind は caller data に上書き不可で最後に固定 (secretKey 漏洩防止)
- surface: serve, core
- backend: local
- command: JSON-RPC makeError / errorFromThrow
- branch: kind あり | kind なし | caller data に kind 衝突
- assert: makeError は data に kind を最後に代入して caller 提供 data の kind を上書き禁止にし、空 data なら error.data を省く。inbound params は引数に取らず echo 不能 (errorFromThrow も同様で secretKey 漏洩防止)
- ref: packages/core/src/jsonrpc.js:243; packages/core/src/jsonrpc.js:247; packages/core/src/jsonrpc.js:250; packages/core/src/jsonrpc.js:12
- kind: wire-fidelity
- status: covered
- note: 検証済: L247 のコメント 'kind は契約なので最後に置き、caller data に上書きさせない' が assert を直接支持。L250 が空 data 省略、L12 が secretKey 漏洩防止の不変条件を明記。makeError(243-252) は errorData に caller data を Object.assign(246) 後 if(kind) errorData.kind=kind を最後に置く(247)

### [SRV-0035] errorFromThrow 写像: RpcError透過 / BleResultError(name判定)→BLE_RESULT_TO_RPC / SesameError→SESAME_TO_RPC / 素Error→internal
- surface: serve, core
- backend: local, ble, cloud
- command: JSON-RPC errorFromThrow / SESAME_TO_RPC
- branch: RpcError | BleResultError | SesameError | 素Error
- assert: errorFromThrow 単一写像 (RpcError/BleResultError/SesameError/素Error→internal) の正典は [[CTR-0028]] (contract.md)
- ref: local-contract
- kind: error-path
- status: waived: 重複（正典 [[CTR-0028]]）
- note: 正典=CTR-0028 (errorFromThrow 単一写像)。任意 throw→JSON-RPC error 正規化の 4 分岐/全 framing 同一写像は契約自己整合として CTR が owner。SRV は per-transport の符号化 (gRPC grpcStatusFor 写像 [[SRV-0057]]) のみ保持

## daemon dispatch

Daemon の rpc.* ゲート・params 検証・直列化・classifyError を固定する。

### [SRV-0036] reserved namespace rpc.* は rpc.discover 以外 method-not-found (-32601 / kind=not_implemented)、未登録 method も同様
- surface: serve, core
- backend: local
- command: Daemon.invoke rpc.* gate
- branch: rpc.discover | rpc.<other> | 未登録 method
- assert: method==="rpc.discover" は OpenRPC 文書を返し、method.startsWith("rpc.") のその他と未登録 method は RpcError(-32601, not_implemented)。予約名前空間が registry へ漏れない (registry.get 到達前に gate)
- ref: packages/core/src/jsonrpc.js:11; packages/kit/src/serve/daemon.js:222-234; packages/kit/tests/serve/daemon.test.js:93-101
- kind: error-path
- status: covered
- note: 検証済: jsonrpc.js:11 が予約名前空間規約を明文化、daemon.invoke で rpc.discover→openRpcDocument(223)・startsWith("rpc.")(224)/未登録(227-230)→throw RpcError(code:RPC.METHOD_NOT_FOUND, kind:KIND.NOT_IMPLEMENTED)(225)。RPC.METHOD_NOT_FOUND=-32601/KIND.NOT_IMPLEMENTED="not_implemented"。test:93-101 が未知 method と rpc.secret の双方を kind=NOT_IMPLEMENTED で確認

### [SRV-0037] params 検証は invoke で一元化: null→{}、非object/配列は INVALID_PARAMS(bad_params) (全 framing 共通の params 形強制)
- surface: serve
- backend: local
- command: Daemon.invoke params validation
- branch: params null→{} | object | 配列/非object→bad_params
- assert: params==null は {} に正規化、typeof p!=='object'||Array.isArray(p) は RpcError(INVALID_PARAMS, bad_params)。JSON-RPC params=配列(positional)を機構として拒否する
- ref: packages/kit/src/serve/daemon.js:231; packages/kit/src/serve/daemon.js:232; packages/kit/src/serve/daemon.js:233
- kind: error-path
- status: covered
- note: 検証済: jsonrpc.js:321 classify が params 欠落を {} に初期化する点と二段。invoke 層 (daemon.js:231-233) は非object/配列を明示拒否

### [SRV-0038] メソッド名単位の直列化機構: 同名 op を1並行に絞りチェーンは前段成否に関わらず継続、解決後 tail 掃除でリーク防止
- surface: serve
- backend: local
- command: Daemon._serialize
- branch: 前段resolve→次実行 | 前段reject→次実行 | tailが末尾→delete
- assert: _locks[method] に prev.then(run,run) でチェーン、前段の成否に関わらず次を走らせ(応答入替防止)、tail 解決後に自分が末尾なら _locks から削除しチェーン無限伸長を防ぐ。同名 op の並行度は maxActive=1
- ref: packages/kit/src/serve/daemon.js:259-267; packages/kit/tests/serve/daemon.test.js:177-188
- kind: idempotency
- status: covered
- note: 検証済: _locks は constructor daemon.js:93 で Map。prev.then(run,run)=前段 reject でも next 実行 (261)、tail=p.catch でチェーン継続用 (263)、末尾一致時のみ delete (265)。test:177-188 が同 key 3 連投で maxActive===1 を確認

### [SRV-0039] classifyError: transport 構造化コード(TRANSPORT_ERR.TIMEOUT/CLOSED)→kind付き RpcError、文字列正規表現に依らない
- surface: serve, core
- backend: local, cloud
- command: Daemon.classifyError / TRANSPORT_ERR
- branch: RpcError透過 | TRANSPORT_ERR.TIMEOUT→timeout | TRANSPORT_ERR.CLOSED→connection_lost | その他透過
- assert: handler の素 Error を transport が付ける .code (TRANSPORT_ERR.*) で判定し timeout/connection_lost の kind 付き RpcError に正規化 (脆弱な文字列正規表現を排除)、非該当はそのまま errorFromThrow へ
- ref: packages/kit/src/serve/daemon.js:68-75; packages/kit/src/serve/daemon.js:239-247; packages/core/src/transport.js:73; packages/kit/tests/serve/fixes.test.js:67-76
- kind: error-path
- status: covered
- note: TRANSPORT_ERR = {TIMEOUT:'TRANSPORT_TIMEOUT', CLOSED:'TRANSPORT_CLOSED'} は transport.js:73。RpcError 透過は daemon.js:69、invoke の run() catch 呼び出しは 243。非該当は errorFromThrow が internal フォールバック。fixes.test.js:67-76 が TIMEOUT→timeout / CLOSED→connection_lost を実証

## registry dispatch

名前空間/BLE op の動的公開と requireAuth/need ゲートを固定する。

### [SRV-0040] 名前空間 op は NAMESPACE_OPS から自動公開され hub[ns][op](params) へ一様 dispatch される
- surface: serve, core
- backend: local
- command: buildRegistry / namespace dynamic dispatch
- branch: GEN_PARAMS あり(実 param) | GEN_PARAMS なし((params) プレースホルダ)
- assert: NS_MODULES (schedule/org/company/payment/access/iot/presetir) の各 NAMESPACE_OPS の全 op が ns.op として登録され、ハンドラが requireAuth 後 hub[ns][op](p) に委譲する (明示表でなく動的生成)
- ref: packages/kit/src/serve/registry.js:97; packages/kit/src/serve/registry.js:288; packages/kit/src/serve/registry.js:302; packages/kit/tests/serve/daemon.test.js:42; packages/kit/tests/serve/daemon.test.js:157
- kind: contract-existence
- status: covered
- note: 検証済: registry.js:97 NS_MODULES に7名前空間、:288-305 ループが各 NAMESPACE_OPS を ns.op で reg.set、:302 が requireAuth(daemon)後 hub[ns][op](p) 委譲、:294-296 が GEN_PARAMS 有無で実param/(params) 分岐。daemon.test.js:42-49 が自動公開、:157-162 が委譲を検証。機構レベル: 個々の ns.op の wire は各ドメイン spec が持つ

### [SRV-0041] BLE op は BLE_RPC_OPS/OS2_BLE_RPC_OPS から ble.<op>/ble.os2.<op> を自動展開し fail-closed allowlist を通す
- surface: serve, core
- backend: ble, ble-os2
- command: bleOpEntries / invokePath(allowlist)
- branch: ack result(bleCommandAck) | raw result | required param 欠落(bad_params)
- assert: 各 facade の op 宣言から named params→位置引数配列へ写像し invokePath(ble, opPath, args, allowlist) を通す。専用ハンドラ(bleEntries)が後から override できるよう先に set される
- ref: packages/kit/src/serve/registry.js:219; packages/kit/src/serve/registry.js:241; packages/kit/src/serve/registry.js:318; packages/kit/src/serve/registry.js:343; packages/core/src/ble/rpc-helpers.js:72
- kind: contract-existence
- status: covered
- note: 検証済: registry.js:219-250 bleOpEntries が named→位置写像(:241 specParams.map(p=>params[p.name]))、:237-239 required 欠落→bad_params、:244 ack→bleCommandAck 分岐。buildRegistry が bleGen/os2Gen を先に set(:318/:323)、専用 bleEntries を最後(:343)に set し override。BLE_RPC_OPS/OS2_BLE_RPC_OPS は ble/index.js:277/291 に実在。fail-closed allowlist は rpc-helpers.js:62/72。各 ble.op の引数 wire は ble ドメイン spec 側

### [SRV-0042] requireAuth ゲートは authState=expired→not_authenticated / hub 未接続→connection_lost を決定的に返す
- surface: serve
- backend: local, cloud
- command: requireAuth(daemon)
- branch: authState=expired | hub.connected=false | 両 OK
- assert: クラウド op の前段ガードが error 文字列正規表現ではなく authState とトークン有無で kind を決定する。expired は KIND.NOT_AUTHENTICATED、未接続は KIND.CONNECTION_LOST
- ref: packages/kit/src/serve/registry-helpers.js:55-62; packages/kit/src/serve/registry.js:302; packages/kit/tests/serve/daemon.test.js:164-174
- kind: error-path
- status: covered
- note: 検証済: registry.js:302 で名前空間 op が requireAuth(daemon) を前置し、daemon.test.js:164-168(expired→not_authenticated)・170-174(未接続→connection_lost)が両分岐を網羅

### [SRV-0043] need() / requireConfigStore() は欠落/構成不備を bad_params で明示拒否し internal 潰れを防ぐ
- surface: serve
- backend: local
- command: need / requireConfigStore
- branch: param undefined/null/'' | 0/false は有効値 | configStore 不在
- assert: need() は undefined/null/空文字を INVALID_PARAMS+bad_params で弾く(0/false は通す)。requireConfigStore は configStore 不在を bad_params で拒否し hub の plain Error(requiresConfigStore) が internal に潰れるのを防ぐ
- ref: packages/kit/src/serve/registry-helpers.js:32-38; packages/kit/src/serve/registry-helpers.js:71-75; packages/kit/tests/serve/phase4-surfaces.test.js:119-128; packages/kit/tests/serve/registry-wiring.test.js:179-187
- kind: error-path
- status: covered
- note: 検証済: phase4-surfaces.test.js:119-128(configStore 不在→bad_params, internal に潰さない)と registry-wiring.test.js:179-187(boolean false が欠落と誤判定されない=0/false 透過)

## dispatch fan-out / 購読

event.ready 発火・fan-out・購読一元所有・再接続再購読を固定する。

### [SRV-0044] event.ready は全永続接続(stdio/socket/ws/SSE/gRPC Subscribe)へ addConnection が一律発火、ephemeral(HTTP POST/gRPC unary)には送らない
- surface: serve
- backend: local
- command: Daemon.addConnection / makeEvent('ready')
- branch: persistent接続→event.ready 1本 | ephemeral接続→送らない
- assert: event.ready の addConnection 発火/ephemeral 除外ライフサイクルの正典は [[EVT-0017]] (events.md)
- ref: local-contract
- kind: wire-fidelity
- status: waived: 重複（正典 [[EVT-0017]]）
- note: 正典=EVT-0017 (event.ready 発火ライフサイクル, daemon.js:177-184 同一実装行)。接続確立通知の発火は購読ライフサイクルとして EVT が owner。SRV は gRPC unary の {ephemeral:true} 生成 (framing 符号化境界) のみ保持

### [SRV-0045] fan-out 機構: lockState/deviceUpdate は同一 pubDeviceStateChange 源を最初に購読中の topic ラベルで1回だけ配信(二重配信回避)、deviceListChanged は別 fanoutTopic
- surface: serve
- backend: local, cloud
- command: Daemon._fanout / _fanoutTopic
- branch: STATE_TOPICS の最初の購読ラベル | 両方購読(1回) | deviceListChanged別経路
- assert: lockState/deviceUpdate 二重配信回避と deviceListChanged 別ストリームの fan-out ライフサイクルの正典は [[EVT-0013]] (events.md)
- ref: local-contract
- kind: wire-fidelity
- status: waived: 重複（正典 [[EVT-0013]]）
- note: 正典=EVT-0013 (二重配信回避) + EVT-0015 (deviceListChanged 別ストリーム _fanoutTopic, daemon.js:361-380 同一実装行)。fan-out の購読配送ライフサイクルは EVT が owner。SRV は各 framing の符号化形 ([[SRV-0049]]) のみ保持

### [SRV-0046] 購読 topic 集合 (STATE_TOPICS/SUBSCRIBABLE_TOPICS) は registry.js が単一定義、daemon.topics/SSE 事前検証/discover x-event-topics/gRPC topic 検証が同一源を参照
- surface: serve
- backend: local
- command: registry SUBSCRIBABLE_TOPICS single-source / topic 検証
- branch: 既知 topic→購読 | 未知 topic→拒否(gRPC は addConnection 前 INVALID_ARGUMENT)
- assert: topic 集合 (STATE_TOPICS/SUBSCRIBABLE_TOPICS) の単一定義(single-source)の正典は [[CTR-0020]] (contract.md)
- ref: local-contract
- kind: contract-existence
- status: waived: 重複（正典 [[CTR-0020]]）
- note: 正典=CTR-0020 (topic 単一源, registry.js:265-267 同一源参照)。topic 集合の単一定義は契約自己整合として CTR が owner。SRV は gRPC Subscribe topic 検証の符号化/拒否境界 (addConnection 前 INVALID_ARGUMENT) のみ保持

### [SRV-0047] 購読は daemon が一元所有し下層 hub 購読を 1 本だけ張る、全解除/切断で畳む
- surface: serve
- backend: local
- command: Daemon.subscribe/unsubscribe/_ensureStateSub/_maybeTeardownStateSub
- branch: 初回購読→onDeviceUpdate 1本 | 追加購読→張り直さない | 全解除→teardown | removeConnection→teardown
- assert: 下層 hub 購読を 1 本に絞る一元所有と全解除/切断 teardown の購読リースライフサイクルの正典は [[EVT-0007]] (events.md)
- ref: local-contract
- kind: idempotency
- status: waived: 重複（正典 [[EVT-0007]]）
- note: 正典=EVT-0007 (購読リース一元所有) + EVT-0009 (最後の購読者離脱で teardown, daemon.js:302-350 同一実装行)。購読の lease/teardown は購読ライフサイクルとして EVT が owner

### [SRV-0048] 再接続で daemon が購読 frame を張り直す(旧 unsub→新 onDeviceUpdate)
- surface: serve, core
- backend: local, cloud
- command: Daemon._reestablishStateSub / hub.onReconnect
- branch: 購読者あり→張り直す | 購読者なし→張らない | 旧 unsub 必須(二重配信防止)
- assert: 再接続で購読 frame を張り直す(旧 unsub→新規購読・冪等再送)再接続再購読ライフサイクルの正典は [[EVT-0029]] (events.md)
- ref: local-contract
- kind: idempotency
- status: waived: 重複（正典 [[EVT-0029]]）
- note: 正典=EVT-0029 (再接続張り直し) / EVT-0030 (二重送信冪等, daemon.js:114-120/327-336 同一実装行)。再接続再購読は購読ライフサイクルとして EVT が owner

## event 封筒

makeEvent 形と gRPC Subscribe の {topic,json} 剥離を固定する。

### [SRV-0049] gRPC Subscribe は event.<topic> 封筒を {topic,json} へ剥がし、他 framing は makeEvent 形を保つ
- surface: serve, core
- backend: local
- command: makeEvent / gRPC Subscribe conn.send
- branch: NDJSON/WS/SSE: そのまま event.<topic> | gRPC: method→topic 剥離+params→json
- assert: makeEvent は {jsonrpc,method:event.<topic>,params}。gRPC のみ send で method の event. prefix を剥がし params を JSON 文字列化して Event{topic,json} stream へ符号化する(封筒変換が gRPC 固有)
- ref: packages/core/src/jsonrpc.js:377-379; packages/kit/src/serve/framing/grpc.js:184-191
- kind: surface-parity
- status: covered
- note: 検証済: makeEvent (jsonrpc.js:377-379) が `event.${topic}` を生成し全 framing が素通しする。gRPC Subscribe conn.send (grpc.js:184-191) のみ replace(/^event\./,"") で topic 抽出 + JSON.stringify(ev.params) を行い Event{topic,json} へ符号化。機構レベル(封筒変換の framing 固有性)であり各ドメイン event spec とは非重複

## stability/provenance

discover の x-stability/x-provenance tier 導出と無言降格防止を固定する。

### [SRV-0050] stability tier は provenance から導出され、全 method/event が x-stability/x-provenance を持つ
- surface: serve
- backend: local
- command: stabilityOf/provenanceOf / buildOpenRpcDoc
- branch: provenance local/app-core→stable | それ以外→experimental | event も同様
- assert: discover の全 method/event が x-stability∈{stable,experimental} と x-provenance を持ち、tier は STABLE_METHODS/STABLE_EVENTS 登録(local/app-core)からのみ stable に導出される(漏れない)
- ref: packages/kit/src/serve/stability.js:57-83; packages/kit/src/serve/registry.js:379-390; packages/kit/tests/serve/daemon.test.js:128-155
- kind: contract-existence
- status: covered
- note: 検証済: stability.js:57-83=stabilityOf/provenanceOf/eventStabilityOf/eventProvenanceOf (未登録は experimental/unverified フォールバック), registry.js:379-390=method+event の x-stability/x-provenance 注入, daemon.test.js:128-155=全 method tier 保持テスト

### [SRV-0051] STABLE_METHODS/STABLE_EVENTS の全キーが実レジストリ/広告イベントに実在する(無言降格防止)
- surface: serve
- backend: local
- command: STABLE_METHODS / STABLE_EVENTS 整合
- branch: -
- assert: STABLE_METHODS の全キーが buildRegistry のキーに、STABLE_EVENTS の全キーが x-events 名に実在する。typo/rename で stable が無言で experimental へ降格する穴を CI で落とす
- ref: packages/kit/src/serve/stability.js:19-42; packages/kit/tests/serve-stability.test.js:14-28
- kind: contract-existence
- status: covered
- note: 検証済: stability.js:19-34=STABLE_METHODS, 38-42=STABLE_EVENTS, serve-stability.test.js:14-28=integrity describe (STABLE_* 全キー実在チェック 2 it)。stabilityOf の experimental フォールバックを逆手に取った無言降格穴を塞ぐ自己整合ガード

## contract self-consistency

CONTRACT_VERSION フィンガープリント・openrpc.json drift・http-kind-map/KIND parity を固定する。

### [SRV-0052] 契約フィンガープリント: メソッド集合 hash が CONTRACT_VERSION と 1:1 連動する(1.4.0=28fc802bc1720a77, 205 メソッド)
- surface: serve, core
- backend: local
- command: KNOWN_FINGERPRINTS / CONTRACT_VERSION
- branch: メソッド増減→hash 不一致→bump 強制 | result/params 形のみ変更→hash 不変→bump 不要
- assert: メソッド集合 hash↔CONTRACT_VERSION の 1:1 フィンガープリント連動の正典は [[CTR-0005]] (contract.md)
- ref: local-contract
- kind: contract-existence
- status: waived: 重複（正典 [[CTR-0005]]）
- note: 正典=CTR-0005 (契約フィンガープリント, KNOWN_FINGERPRINTS/CONTRACT_VERSION 連動)。メソッド集合 hash↔バージョンの自己整合は契約レイヤとして CTR が owner

### [SRV-0053] 公開 OpenRPC 成果物(schema/openrpc.json)の機械契約射影が実装と一致する(drift gate)
- surface: serve
- backend: local
- command: buildOpenRpcDoc / schema/openrpc.json drift gate
- branch: method 名/params(名・required・schema)/result schema/x-stability/x-provenance/events/topics
- assert: 公開 OpenRPC 成果物 (schema/openrpc.json) の機械契約射影↔実装一致 (drift gate) の正典は [[CTR-0008]] (contract.md)
- ref: local-contract
- kind: contract-existence
- status: waived: 重複（正典 [[CTR-0008]]）
- note: 正典=CTR-0008 (openrpc.json drift gate, machineContract 等価)。committed 成果物↔live buildOpenRpcDoc の drift 検出は契約自己整合として CTR が owner

### [SRV-0054] CONTRACT_VERSION↔メソッド集合+x-event-topics の二重 hash 連動(live と committed の両方, 1.4.0=64ea81ba7ced77e0)
- surface: serve, core
- backend: local
- command: methodSetFingerprint / x-event-topics
- branch: live registry hash | committed openrpc.json hash | topics 変更も hash に反映
- assert: メソッド集合+x-event-topics の二重 hash↔CONTRACT_VERSION 連動 (live/committed 双方) の正典は [[CTR-0006]] (contract.md)
- ref: local-contract
- kind: contract-existence
- status: waived: 重複（正典 [[CTR-0006]]）
- note: 正典=CTR-0006 (methodSet+topics 二重 hash 連動)。メソッド集合+topics hash↔バージョンの live/committed 自己整合は契約レイヤとして CTR が owner

### [SRV-0055] HTTP status→kind 写像が4実装(sdk-ts/sdk-py/clients-js/clients-py)+生成テンプレで fixture と完全一致 (5xx→connection_lost, 既定→internal)
- surface: sdk, serve
- backend: cloud, local
- command: SURF-10 http-kind-map self-consistency
- branch: statuses表 | 5xx range | fallback | 4実装一致
- assert: tests/fixtures/http-kind-map.json を正として 4 実装と 2 生成テンプレ(gen-sdk-ts/py)の写像リテラルが全エントリ一致し、>=500→connection_lost・未登録→internal・retryable連動も固定。機構レベルの契約自己整合
- ref: packages/kit/tests/fixtures/http-kind-map.json:3; packages/kit/tests/serve/http-kind-map.test.js:30; packages/kit/tests/serve/http-kind-map.test.js:79; packages/kit/tests/serve/http-kind-map.test.js:98
- kind: contract-existence
- status: covered
- note: 検証済: fixture:3=statuses 表頭、serverErrorRange(>=500→connection_lost) は fixture:13-19、fallback(internal) は fixture:20-25。test:30=clients/js 実照合、:79=gen-sdk-ts テンプレ照合(5xx/internal/retryable 連動は test:84-86)、:98=4実装 SURF-10 出典コメント検証。clients/python 実照合は test:38(python3 不在時 skip)

### [SRV-0056] KIND enum (7値) の自己整合: clients/js d.ts の SesameErrorKind union が serve KIND 全値を含む (SURF-21)
- surface: sdk, serve
- backend: local
- command: SURF-21 KIND union parity
- branch: -
- assert: core/jsonrpc KIND の 7 値 (not_authenticated/bad_params/timeout/connection_lost/rejected/internal/not_implemented) が clients/js/sesame-client.d.ts の SesameErrorKind union に '| "<kind>"' で全て載る
- ref: packages/core/src/jsonrpc.js:169; packages/kit/clients/js/sesame-client.d.ts:21-28; packages/kit/tests/serve/http-kind-map.test.js:118
- kind: contract-existence
- status: covered
- note: 検証済: jsonrpc.js:169-177 KIND が7値、d.ts:21-28 が同7値を union で保持。test:118 が実 assert toContain('| "${kind}"')。横断機構レベル(各 kind の emit 元は errorFromThrow/ble 写像が持つ)

## error-mapping parity

全 framing 横断の単一 errorFromThrow と gRPC status 写像を固定する。

### [SRV-0057] gRPC status 写像 grpcStatusFor は kind→gRPC status を網羅し、他 framing と同一 kind を保つ
- surface: serve
- backend: local
- command: grpcStatusFor / metadata kind
- branch: not_authenticated/bad_params/not_implemented/connection_lost+timeout/rejected/default
- assert: gRPC は errorFromThrow の kind を metadata に載せつつ grpcStatusFor で gRPC status へ写像する。kind=rejected→FAILED_PRECONDITION、timeout/connection_lost→UNAVAILABLE。kind 自体は全 framing で同値
- ref: packages/kit/src/serve/framing/grpc.js:85-95; packages/kit/src/serve/framing/grpc.js:148-155; packages/kit/tests/serve/grpc.test.js:144-157
- kind: surface-parity
- status: covered
- note: 検証済: grpc.test.js:144-157 が SesameError(REJECTED)→FAILED_PRECONDITION + metadata kind=rejected/retryable=false を実証。grpc.js:85-95=grpcStatusFor switch、148-155=errorFromThrow の kind を md.set し grpcStatusFor で status 化

## proto3 presence 符号化

required/repeated 除外規則と省略/明示 0 区別の符号化規約を固定する。

### [SRV-0058] gRPC proto3 optional presence — 省略 scalar は undefined、明示 0/false は値として届く
- surface: serve, sdk
- backend: local
- command: gen-grpc-proto optional / synthetic oneof sentinel
- branch: required scalar→optional 非付与 | non-required scalar→optional 付与 | 省略→delete | 明示(_field sentinel)→値維持
- assert: required でない scalar に proto3 optional を付与し、glue が _fieldName sentinel の有無で省略/明示を判定する。明示 0/false/'' は維持され『0 を一律 delete』は禁止(台本0・timeout 0 が壊れる)
- ref: scripts/gen-grpc-proto.mjs:75-79; scripts/gen-grpc-proto.mjs:118-121; packages/kit/src/serve/framing/grpc.js:118-140; packages/kit/tests/serve/grpc-presence.test.js:56-95; packages/kit/tests/serve/grpc-presence.test.js:195-225
- kind: option-branch
- status: covered
- note: 検証済: gen-grpc-proto が isRequired/isRepeated で optional 付与判定(:75-79)し proto に `optional ` prefix を emit(:118-121)。glue は optionalScalars を _fieldName sentinel で省略/明示判定(grpc.js:124-132)、jsonFields parse(:137-140)。テストは LockClick 省略/明示0/3(:56-95)と生成 proto の optional 付与確認(:195-225)。SRV-0001 が presence glue の wire-fidelity 索引、本 item は presence 符号化規約(0/false 区別)の option-branch 焦点

## SDK 生成

rpc-params/proto/grpc-methods 生成物 drift と TS/Py SDK の単一ソース生成を固定する。

### [SRV-0059] rpc-params/proto/grpc-methods 生成物が .d.ts/registry から再生成した結果と一致する(stale 検出)
- surface: serve, sdk
- backend: local
- command: gen-rpc-schema / gen-grpc-proto drift gate
- branch: rpc-params.generated.json | sesame.proto | grpc-methods.generated.json | 全名前空間 coverage
- assert: 生成物 (rpc-params/proto/grpc-methods) ↔再生成結果一致の stale 検出 drift gate の正典は [[CTR-0023]] (contract.md)
- ref: local-contract
- kind: contract-existence
- status: waived: 重複（正典 [[CTR-0023]]）
- note: 正典=CTR-0023 (生成物 stale 検出 drift gate)。committed 生成物↔.d.ts/registry 再生成一致は契約自己整合として CTR が owner

### [SRV-0060] TS/Python SDK は schema/openrpc.json から生成され x-stability/x-provenance/x-event-topics を反映する
- surface: sdk
- backend: local
- command: gen-sdk-ts / gen-sdk-py
- branch: experimental→@experimental タグ | event topics は x-event-topics 由来(event.ready 除外)
- assert: TS/Python SDK の openrpc.json 単一ソース生成と x-stability/x-provenance/x-event-topics 反映の正典は [[CTR-0029]] (contract.md)
- ref: local-contract
- kind: contract-existence
- status: waived: 重複（正典 [[CTR-0029]]）
- note: 正典=CTR-0029 (SDK 生成パイプライン単一ソース化)。openrpc.json→TS/Py SDK 生成と tier/topics 反映は契約成果物射影として CTR が owner

## i18n 完全性

core/kit カタログの en/ja 一致・area 重複ゼロ・{var} 一致・t() リテラル網羅と registerCatalog 機構を固定する。

### [SRV-0061] i18n 完全性機構: core/kit 各 area で en/ja キー集合一致・area間重複ゼロ・{var}一致・src の t() リテラル全網羅
- surface: core, serve, cli
- backend: local
- command: i18n catalog completeness (core + kit, P5-2)
- branch: en/ja キー集合一致 | area 間キー重複ゼロ | {var} 一致 | src の t() リテラルが全てカタログに存在
- assert: i18n カタログ完全性 (en/ja キー一致・area 間重複ゼロ・{var} 一致・t() リテラル網羅) の正典は [[I18N-0001]]/[[I18N-0009]] 系 (i18n.md)
- ref: local-contract
- kind: i18n
- status: waived: 重複（正典 [[I18N-0001]]）
- note: 正典=I18N-0001/0009 系 (i18n.md)。core/kit カタログの en/ja 完全性・area 重複ゼロ・{var} 一致・src t() リテラル網羅は i18n 完全性として I18N が owner。serve.* 文言も I18N 配下

### [SRV-0062] registerCatalog 重複キー検出: 既存キー再登録は TypeError、t() 未定義キーは en→キー自身へフォールバック、{var} 補間は split-join 全置換
- surface: core
- backend: local
- command: i18n registerCatalog / t
- branch: 新規キー | 重複キー→TypeError | 未定義キー→enフォールバック→キー自身 | {var}補間
- assert: registerCatalog は既存キー重複で TypeError(誤登録早期検出)、t() は locale→en→キー文字列の3段フォールバックで {var} を split-join で全置換。framing 文言登録の機構不変条件
- ref: packages/core/src/i18n.js:52-66; packages/core/src/i18n.js:86-91; packages/core/tests/i18n.test.js:31-34; packages/core/tests/i18n.test.js:180-215
- kind: i18n
- status: covered
- note: 検証済: registerCatalog は en/ja 両ロケールで既存キー重複を hasOwn 検査し TypeError(i18n.js:52-66)。t() は key in dict → en → key 自身の決定的フォールバック(:88, 範囲 86-91)。テストは『未定義キー→キー自身』(i18n.test.js:31-34)、重複→TypeError と ja 欠落→en のみ(:180-215)

## all-framings e2e

単一 Daemon に全 framing 同居させた等価性と 1 イベント fan-out の実証境界。

### [SRV-0063] 全 framing 同一封筒 — 同一 op が UDS/HTTP/WS/gRPC で同一 hub メソッドへ同一結果で届く
- surface: serve
- backend: local
- command: Daemon.invoke / 4 framing 同居
- branch: UDS | HTTP POST /rpc | WS | gRPC Invoke (stdio は別プロセス)
- assert: 単一 Daemon に 4 経路同居し、同一 method+params が framing に依らず同じ hub メソッドへ同一結果で到達する(看板 op lock.unlock で実証)
- ref: packages/kit/tests/serve/all-framings-e2e.test.js:113-133; packages/kit/src/serve/daemon.js:199-247
- kind: surface-parity
- status: covered
- note: テストは fake hub で同居起動を行い実クラウド非依存(waived 不要)。検証済: e2e.test.js:114-133 が 4 経路の同一 result + hub.unlock 4 回呼出を確認、daemon.js:199-247=dispatchMessage→invoke の単一 dispatch。ドメインメソッド単位 parity は各ドメイン spec が保有

### [SRV-0064] 1 イベントが全購読経路へ各 framing の wire 形(NDJSON 行/SSE data:/gRPC Event)へ符号化される
- surface: serve
- backend: local
- command: Daemon._fanout / makeEvent
- branch: UDS event 行 | WS event | HTTP SSE data: | gRPC Event{topic,json}
- assert: fan-out された 1 イベントを各 framing が自身の wire 形へ符号化する (NDJSON=event.<topic> 行 / WS=event.<topic> フレーム / SSE='data: '+JSON / gRPC=event. prefix を剥がし Event{topic,json} へ変換) — 符号化形が framing 固有で正しい
- ref: packages/kit/tests/serve/all-framings-e2e.test.js:135-206; packages/kit/src/serve/framing/grpc.js:185-191; packages/core/src/jsonrpc.js:377-379
- kind: surface-parity
- status: covered
- note: NARROW: assert を framing 符号化に限定。購読者限定配送の fan-out 配送ライフサイクル (daemon.js:360-368 _fanout) は [[EVT-0014]] (events.md) が owner — 本 item は cross-ref のみ保持。検証済: e2e.test.js:135-206 が 4 経路同一 payload を確認(203-204)、grpc.js:185-191=Subscribe conn.send が event.<topic> を {topic,json} へ符号化、jsonrpc.js:377-379=makeEvent 形。各 framing 符号化形は [[SRV-0049]] (gRPC 封筒剥離) とも対をなす

### [SRV-0065] 全 framing 同居 e2e (実ポート/UDS bind を伴う実起動) — stdio は別プロセス spawn 検証
- surface: serve
- backend: local
- command: all-framings e2e single-daemon (実起動)
- branch: 4 framing 同居 + 実ポート/UDS bind | stdio は別プロセス(spawn)
- assert: 単一 Daemon に UDS/HTTP/WS/gRPC を実バインドで同居させ、全経路から同 op で同一結果を得て、hub の 1 イベントが全購読経路へ同時配信される機構を実起動で実証する (stdio は別プロセス framing のため別 spawn 検証)
- ref: packages/kit/tests/serve/all-framings-e2e.test.js:114-135; packages/kit/tests/serve/all-framings-e2e.test.js:4
- kind: surface-parity
- status: waived: 実起動(4 framing 同居 + 実ポート/UDS bind + stdio 別プロセス spawn)が要る e2e 境界。単体は各 framing spec (SRV-0001..0030) と fake-hub 同居 (SRV-0063/0064) が静的にカバー
- note: 検証済: e2e.test.js:114='lock.unlock が UDS/HTTP/WS/gRPC のどれでも同一結果'、:135='hub の 1 イベントが全購読経路へ同時 fan-out'、:4 stdio 別 spawn 注記。machine-level cross-framing 同一性。SRV-0063/0064 が fake-hub 版を planned で索引化、本 item は実バインド e2e を waived として残す

## 監査追補 v2 (dual-audit)

デュアル監査の人間裁定で SRV 正典 (per-transport 符号化/エラー封筒/proto3 presence/daemon 起動停止) に追加された機構不変条件。

### [SRV-0066] Daemon._connectLoop 常駐起動ポリシー: 接続成功→ok+refreshAccount best-effort、失敗→degraded/expired 分類+指数バックオフ(1s→×2→30s cap)
- surface: serve
- backend: cloud, local
- command: Daemon.start / Daemon._connectLoop / authState 遷移 / refreshAccount (SURF-09)
- branch: connect 成功→ok+refreshAccount+_ensureStateSub+return | connect 失敗かつ token あり→degraded | token 無し→expired | 失敗→指数バックオフ(1s→×2→30s cap) | refreshAccount throw→warn のみ継続 | _stopped→ループ離脱
- assert: start() が onReconnect を登録して _connectLoop を回す常駐起動ポリシー機構: hub.connect() 成功で authState='ok'、接続直後に refreshAccount() を best-effort で 1 回呼び SURF-09 の companyID/subUUID 不整合を解消する(throw は serve.refreshAccountFailed の warn のみで継続)、_ensureStateSub 後 return。接続失敗時は _hasStoredTokens() で degraded(トークン有)/expired(トークン無)を決定的に分類し、delay=Math.min(delay*2,30000) の指数バックオフ(1000ms から ×2・上限 30000ms)でキャンセル可能 sleep し、_stopped でループ離脱する
- ref: packages/kit/src/serve/daemon.js:114-120; packages/kit/src/serve/daemon.js:122-154; packages/kit/src/serve/daemon.js:147; packages/kit/src/serve/daemon.js:134-139; packages/kit/src/serve/daemon.js:156-161; packages/kit/tests/serve/phase4-surfaces.test.js:221-237
- kind: error-path
- status: covered
- note: authState を *設定する* producer(_connectLoop)は SRV/auth どちらにも索引ゼロだった機構。[[SRV-0042]] requireAuth は authState を *読む* gate のみ、[[AUTH-0094]] は status.authState 値↔遷移 parity のみを所有し、daemon 起動ループ機構は別境界。検証済: daemon.js:126-127 connect→authState='ok'、:134-139 refreshAccount best-effort(catch→serve.refreshAccountFailed warn 継続)、:141 _ensureStateSub、:147 _hasStoredTokens()?'degraded':'expired'、:150-151 sleep+delay=Math.min(delay*2,30000) 指数バックオフ。孤児テスト phase4-surfaces.test.js:221-237 は [ID] 付与で covered 化可能

### [SRV-0067] Daemon.shutdown() 冪等オーケストレーション: 二重呼びガード・retry sleep 即解除・購読 teardown・hub.close 1回
- surface: serve
- backend: local
- command: Daemon.shutdown / 冪等 graceful teardown
- branch: 初回shutdown | 二度目(冪等return, hub.close 1回) | sleep中(retryTimer clear+retryResolve 即解除) | _stateUnsub/_deviceListUnsub あり→teardown | hub.close throw(warnで握る)
- assert: Daemon.shutdown() は _shuttingDown ガードで冪等(二度目は即 return・hub.close は1回)、_stopped=true で受付/_connectLoop を止め、_retryTimer clearTimeout + _retryResolve() で connectLoop の sleep を即解除し、_stateUnsub/_deviceListUnsub があれば畳んでから hub.close() を await する(hub.close の throw は _log warn で握る)
- ref: packages/kit/src/serve/daemon.js:383-393; packages/kit/src/serve/daemon.js:385-386; packages/kit/src/serve/daemon.js:389; packages/kit/src/serve/daemon.js:168-173; packages/kit/tests/serve/daemon.test.js:247-254
- kind: idempotency
- status: covered
- note: daemon-level の graceful shutdown ライフサイクル(購読 teardown + sleep キャンセル + hub.close 1回)は [[SRV-0009]] (gRPC server.stop tryShutdown→forceShutdown)・[[SRV-0024]] (NDJSON 接続 close) とは別レイヤで索引ゼロだった機構。検証済: daemon.js:385-386 _shuttingDown 早期 return(冪等)、:388 retryTimer clearTimeout、:389 retryResolve() で connectLoop sleep 即解除、:390-391 _stateUnsub/_deviceListUnsub teardown、:392 try{await hub.close()}catch{_log}。孤児テスト daemon.test.js:247-254 (二度呼び→toHaveBeenCalledTimes(1)) は [ID] 付与で covered 化可能

### [SRV-0068] HTTP/WS/socket framing stop(): 持続接続を能動切断してから server.close でハング回避(gRPC SRV-0009 の同型対処)
- surface: serve
- backend: local
- command: startHttpFraming/startWsFraming/startSocketFraming stop() / active-close-before-close
- branch: HTTP closeAllConnections | WS terminate clients | socket destroy socks | server.close で resolve
- assert: HTTP/WS/Unix-socket の各 framing stop() は、持続接続(SSE/WS/UDS 購読者)が keep-alive で居座ると server.close が idle 接続を閉じずハングするため、close 前に全接続を能動切断する: HTTP=server.closeAllConnections?.()、WS=各 wss.clients を c.terminate()、socket=各 socks を s.destroy()。その後 server.close(()=>resolve) で確実に畳む
- ref: packages/kit/src/serve/framing/http.js:194-198; packages/kit/src/serve/framing/ws.js:65-68; packages/kit/src/serve/framing/socket.js:79-82
- kind: idempotency
- status: covered
- note: [[SRV-0009]] が gRPC framing の永続 Subscribe ストリーム下 graceful-then-force shutdown を被覆するのと対になる HTTP/WS/socket 横断機構が抜けていた。検証済: http.js:194-198 closeAllConnections?.()→server.close(コメント『SSE 購読者が keep-alive で居座ると server.close はハング』)、ws.js:65-68 for wss.clients c.terminate()→wss.close(コメント『接続が残る限りハング』)、socket.js:79-82 for socks s.destroy()→server.close(コメント『全接続が自発切断するまで callback 発火せずハング』)

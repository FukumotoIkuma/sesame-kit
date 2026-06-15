<!-- spec-domain: sdk | prefix: SDK | tests: packages/kit/tests, packages/kit/tests/serve, packages/kit/tests/cli -->

# 生成 SDK 機構 spec (SDK)

生成クライアント(TypeScript / Python)が契約と 1:1(全メソッド存在・署名一致・任意引数の扱い)であること、eject 機構、clients パッケージの整合を監査する。

## ts-sdk-generation

### [SDK-0001] TS SDK が契約 205 メソッドを 1:1 で _call へ委譲する
- surface: sdk
- backend: local
- command: `scripts/gen-sdk-ts.mjs / generateSdk`
- branch: -
- assert: openrpc.json の全 205 メソッドが生成 TS SDK に各 1 個の this._call("<method.name>", …) として現れ、メソッド名文字列が契約名と完全一致する (1:1・取りこぼし無し)
- ref: scripts/gen-sdk-ts.mjs:68-98; scripts/gen-sdk-ts.mjs:90; packages/kit/sdk/ts/sesame-client.ts:1-2; schema/openrpc.json:11; packages/kit/tests/sdk-ts-contract.test.js:18-25
- kind: contract-existence
- status: planned
- note: 確認済: gen-sdk-ts.mjs:90 が各メソッドにつき this._call(JSON.stringify(m.name), passed) を 1 個出力。生成物 sesame-client.ts に this._call が 205 個 (= openrpc methods 205, grep 実測一致)。ヘッダ sesame-client.ts:2 が 'apiVersion 1.4.0 · 205 methods (13 stable)' を自己申告。openrpc.json:11 は methods 配列先頭 (rpc.discover) のアンカー。sdk-ts-contract.test.js:18-25 は stable 13 個の op 名存在のみ検査するため、全 205 の 1:1 は :14-16 の byte-identity drift gate と合わせて担保 (note 通り honest)。メソッド単位の wire/surface-parity は各ドメイン spec が保持するためここでは存在性 (count 1:1) のみ。

### [SDK-0002] ドット名から ns/op を分割しネスト構造へマップする生成機構
- surface: sdk
- backend: local
- command: `scripts/gen-sdk-ts.mjs / generateSdk(namespace grouping)`
- branch: no-dot-root | single-dot-ns | multi-dot-quoted-op
- assert: name の最初の '.' で ns/op を分割し、ns 付きは `readonly <ns> = { ... }` ブロック、ドット無し (status) はクラス直下フィールド、op に '.' が残る (ble.script.click 等) 場合は識別子不正としてキーをクォートする
- ref: scripts/gen-sdk-ts.mjs:71-78; scripts/gen-sdk-ts.mjs:86; scripts/gen-sdk-ts.mjs:93-98; packages/kit/sdk/ts/sesame-client.ts:170; packages/kit/sdk/ts/sesame-client.ts:606-608
- kind: contract-existence
- status: planned
- note: 確認済: gen-sdk-ts.mjs:73-75 が indexOf('.') で ns(先頭)・op(残り) を切る → ble.script.click は ns 'ble'・op 'script.click'。safeOp 正規表現 (:86) が 'script.click' を不正識別子と判定しクォート (sesame-client.ts:337 で "script.click": として出る)。root の status (no-dot) は :98 rootMethods で field=true → sesame-client.ts:170 で `status = (..) =>`。rpc.discover は ns 'rpc' に入り sesame-client.ts:606-608 (readonly rpc = { discover: ... };) で現れる。multi-dot メソッドは契約に 63 個 (実測)。

### [SDK-0003] param の required フラグが TS 引数の任意性 (? 接尾) に転写される
- surface: sdk
- backend: local
- command: `scripts/gen-sdk-ts.mjs / paramsType`
- branch: required-no-suffix | optional-question-suffix | empty-params-no-arg
- assert: openrpc param の required:true は TS フィールド名に接尾辞無し・required:false は '?' を付与し、params 空配列のメソッドは引数を取らず this._call(name, {}) を発する (任意引数の正確な転写)
- ref: scripts/gen-sdk-ts.mjs:59-65; scripts/gen-sdk-ts.mjs:82-84; packages/kit/sdk/ts/sesame-client.ts:607; packages/kit/sdk/ts/sesame-client.ts:170
- kind: option-branch
- status: planned
- note: 確認済: gen-sdk-ts.mjs:63 が p.required ? '' : '?' を出力。:60 で paramsType が空 params に null を返し、:84 で passed='{}' → discover (sesame-client.ts:607) は `(): Promise<unknown> => this._call("rpc.discover", {})`、status (sesame-client.ts:170) も `(): … => this._call("status", {})`。schedule.getScheduleList は subUUID?/timeoutMs? を任意で出す (openrpc.json:30-46 で required:false; sesame-client.ts:614 で確認)。型不明 schema は tsType で unknown に倒す (嘘の型を主張しない)。

### [SDK-0004] generateSdk が決定的で committed 成果物と byte 一致する drift gate
- surface: sdk
- backend: local
- command: `scripts/gen-sdk-ts.mjs / generateSdk(determinism)`
- branch: -
- assert: 純関数 generateSdk(spec) の出力が committed sesame-client.ts と完全一致し、メソッドを ns・op 名で sort して決定的に並べるため schema 変更を build:sdk 忘れで腐らせない
- ref: scripts/gen-sdk-ts.mjs:67-72; scripts/gen-sdk-ts.mjs:94; scripts/gen-sdk-ts.mjs:107-282; packages/kit/tests/sdk-ts-contract.test.js:14-16
- kind: contract-existence
- status: planned
- note: 確認済: gen-sdk-ts.mjs:72 が methods を localeCompare で sort、:94 で ns ブロックも sort → 決定的。:107-281 の out テンプレ→:281 return out で純関数化。sdk-ts-contract.test.js:15 が expect(generateSdk(spec)).toBe(committed) で byte 一致を強制。CLI 実行 (gen-sdk-ts.mjs:285-291 の import.meta.url ガード) と import 時の純関数利用を副作用分離。

### [SDK-0005] x-stability=experimental が @experimental JSDoc に転写され API_VERSION を埋める
- surface: sdk
- backend: local
- command: `scripts/gen-sdk-ts.mjs / emitMethod(stability tag)`
- branch: stable-no-tag | experimental-jsdoc
- assert: x-stability=experimental のメソッドだけ '@experimental <x-provenance> — may change without notice.' JSDoc が前置され、API_VERSION 定数が spec.info.x-apiVersion と一致する (stable/experimental の型レベル区別)
- ref: scripts/gen-sdk-ts.mjs:85; scripts/gen-sdk-ts.mjs:138; packages/kit/sdk/ts/sesame-client.ts:276; packages/kit/tests/sdk-ts-contract.test.js:27-30
- kind: contract-existence
- status: planned
- note: 確認済: gen-sdk-ts.mjs:85 が m['x-stability']==='experimental' のときのみ tag を生成 (stable 13 個には付かない; 全体は experimental 192 個)。:138 で API_VERSION = JSON.stringify(spec.info['x-apiVersion'])。生成物 sesame-client.ts:276/278 等に `/** @experimental unverified — may change without notice. */` が現れる (x-provenance 値は local/unverified/app-core の 3 種; 旧 ref :277 はメソッド行だったため :276 に修正)。API_VERSION は sesame-client.ts:32 で "1.4.0"。sdk-ts-contract.test.js:28-29 が @experimental 文字列と API_VERSION="1.4.0" を要求。

## sdk-eject

### [SDK-0006] sesame sdk eject ts が同梱 SDK を byte 一致でコピー書き出しする
- surface: cli, sdk
- backend: local
- command: `sesame sdk eject ts [--out <dir>] / cmdSdkEject`
- branch: default-cwd | --out <dir>
- assert: eject ts は packages/kit/sdk/ts/sesame-client.ts を readFileSync→writeFileSync でそのまま書き出し、出力が同梱物と byte 一致し、--out 省略時は process.cwd() を出力先にする
- ref: packages/kit/src/cli/sdk.js:22-28; packages/kit/src/cli/sdk.js:48-49; packages/kit/src/cli/sdk.js:51-67; packages/kit/tests/cli/sdk-eject.test.js:50-56
- kind: contract-existence
- status: planned
- note: 確認済: sdk.js:22 が SDK_DIR を __dirname(=dirname(fileURLToPath(import.meta.url))) 相対 ../../sdk で解決 (インストール先非依存)。:53/:67 が readFileSync(entry.src)→writeFileSync(destPath) で無変換コピー (content は Buffer)。:48 で opts.out ? resolve(opts.out) : process.cwd()。sdk-eject.test.js:50-56 が spawnSync で実バイナリを叩き :55 で expect(out).toEqual(expected) (Buffer 等価) を検査。

### [SDK-0007] eject 未知 lang のエラー終了と --json 出力封筒の分岐
- surface: cli, sdk
- backend: local
- command: `sesame sdk eject <lang> --json / cmdSdkEject`
- branch: unknown-lang-exit1 | --json-ok-false | --json-ok-true | help-ts-py
- assert: 未知 lang は exit 1 で stderr に 'Unknown language' を出し、--json 時は exit 1 + stdout に {ok:false,error}、成功時は {ok:true,file:<絶対パス>} を出す (JSON モードと人間モードの封筒分岐)
- ref: packages/kit/src/cli/sdk.js:36-46; packages/kit/src/cli/sdk.js:79-83; packages/kit/tests/cli/sdk-eject.test.js:68-100
- kind: option-branch
- status: planned
- note: 確認済: sdk.js:38 が 'Unknown language "<lang>". Choose: ts, py' を組み、:44 で process.exitCode=1。isJsonMode() (:39 エラー枝 / :79 成功枝) で stdout JSON 封筒へ分岐。:80 が {ok:true,file:destPath} (destPath は join(outDir,entry.name); outDir は :48 で絶対化)。sdk-eject.test.js:88-100 が未知 lang の exit 1・stderr・ok:false を、:69-83 が ok:true・file 絶対パス一致 (:74 join(work,'sesame-client.ts')) を検査。

### [SDK-0008] sdk/ 同梱とコマンド登録: eject が配布物に含まれ CLI に結線される
- surface: cli, sdk
- backend: local
- command: `package.json files / registerSdkCommands`
- branch: -
- assert: packages/kit の files に 'sdk/' が含まれ同梱配布され、registerSdkCommands が `sesame sdk eject <lang>` を --out オプション付きで program に登録する (出荷物に SDK が同梱され eject 経路が存在する)
- ref: packages/kit/package.json:17-21; packages/kit/src/cli/sdk.js:90-104; packages/kit/src/cli.js:240; packages/kit/tests/cli/sdk-eject.test.js:34-45
- kind: contract-existence
- status: planned
- note: 確認済: package.json:21 'sdk/' が files に列挙 (同梱)。sdk.js:91-103 が program.command('sdk').command('eject <lang>').option('--out <dir>')。cli.js:240 が registerSdkCommands(program) を呼ぶ。sdk-eject.test.js:34-45 が SDK_DIR の ts/py 同梱ファイル実在と GENERATED ヘッダを確認。Python eject の同梱物はファイル名 sesame_client.py (note 旧記載の sdk_client.py は誤り、修正済) で SDK_FILES.py に対称登録 (sdk.js:27)。本スライスは機構 (同梱+登録) を見るので個別 lang は範囲外。

## py-sdk-generation

### [SDK-0009] gen-sdk-py 決定生成 / drift gate (純関数再実行で byte 一致)
- surface: sdk
- backend: local
- command: `scripts/gen-sdk-py.mjs generateSdkPy / build:sdk:py`
- branch: namespace-sort | root-sort | TypedDict-登録順
- assert: generateSdkPy(spec) が決定的 (methods を name で localeCompare ソート、namespace を localeCompare ソート、TypedDict は emit 副作用順) で、committed sesame_client.py と完全 byte 一致する。スキーマ変更→未再生成で腐ったら FAIL する drift gate が成立する
- ref: scripts/gen-sdk-py.mjs:137-145; scripts/gen-sdk-py.mjs:139; scripts/gen-sdk-py.mjs:153; packages/kit/tests/sdk-py-contract.test.js:13-15; packages/kit/sdk/python/sesame_client.py:1-3
- kind: contract-existence
- status: planned
- note: 確認済: gen-sdk-py.mjs:139 が name.localeCompare ソート、:153 が namespace[0].localeCompare ソート、:137-145 が generateSdkPy 入口+groups 構築。sdk-py-contract.test.js:14 が generateSdkPy(spec)===committed の byte gate。sesame_client.py:1 が 'GENERATED … DO NOT EDIT' ヘッダ。機構レベル: 個別メソッドの存在ではなく『生成器が純関数・決定的・byte 一致 gate』という不変条件。ドメイン spec の method-parity とは別軸。

### [SDK-0010] _omit_none 機構: optional 引数を None のまま送らない (required は default 無し)
- surface: sdk
- backend: local
- command: `methodParams / emitMethod / _omit_none`
- branch: required(default無) | optional(=None)
- assert: named-param メソッドは keyword-only (self, *, …) で生成され、required は default 無し・optional は `= None`、呼出は _omit_none({...}) で None のキーをフレームから除去する。これによりキー集合が openrpc の required/optional 区分と wire 上一致する (生成器側の普遍規則)
- ref: scripts/gen-sdk-py.mjs:116-119; scripts/gen-sdk-py.mjs:132-133; scripts/gen-sdk-py.mjs:166; packages/kit/sdk/python/sesame_client.py:109-110; packages/kit/sdk/python/sesame_client.py:330-332
- kind: option-branch
- status: planned
- note: 確認済: gen-sdk-py.mjs:117 が required?無default:`| None = None` の sig 生成、:132-133/:166 が `self, *, …` keyword-only + _omit_none 包み (ns / root 両方)。sesame_client.py:109-110 が _omit_none 定義、:330-332 が具体例 clearCards(self, *, deviceUUID: str, timeoutMs: float | None = None) → _omit_none({...}) (required 無default + optional=None)。各ドメイン spec は『そのメソッドが _omit_none で包まれる』を個別主張するが、ここは _omit_none テンプレートと required/optional→signature 規則そのものを 1 本で固定する機構不変条件。

### [SDK-0011] namespace ディスパッチ生成: ns.op → _Ns クラス + self.ns 属性、root は SesameClient メソッド
- surface: sdk
- backend: local
- command: `generateSdkPy nsClasses/nsAttrs/rootMethods`
- branch: namespaced(self._c._call) | root(self._call)
- assert: name に '.' を含むメソッドは namespace 毎に `_Ns` クラス化され self.<ns> = _Ns(self) で束ねられ self._c._call(name, …) へ委譲、'.' 無しの root メソッドは SesameClient 直下で self._call(name, …) へ委譲する。委譲先メソッド名は常に openrpc の完全 name (JSON.stringify(m.name)) であり op 名ではない
- ref: scripts/gen-sdk-py.mjs:140-144; scripts/gen-sdk-py.mjs:153-158; scripts/gen-sdk-py.mjs:160-167; packages/kit/sdk/python/sesame_client.py:1237-1256; packages/kit/sdk/python/sesame_client.py:332
- kind: contract-existence
- status: planned
- note: 確認済: gen-sdk-py.mjs:140-144 が name を ns/op に分割し groups へ、:153-158 が _Ns クラス生成 + nsAttrs.push(`self.${ns} = ${cls}(self)`)、:160-167 が root メソッド (self._call)。sesame_client.py:1237-1256 が self.access=_Access(self) … self.webapi=_Webapi(self) の束ね、:332 が `self._c._call("access.clearCards", …)` (委譲文字列が full name)。機構: ローカル op 名 (Python 識別子) と wire の完全 method name の二層対応。委譲文字列が常に full name であることが wire 整合の前提。

### [SDK-0012] 識別子/予約語安全フォールバック: 非識別子 param 名は **params generic へ退避
- surface: sdk
- backend: local
- command: `methodParams / pyIdentifier / PY_KEYWORDS`
- branch: real.length===0 | 非識別子/予約語あり | 全名 OK
- assert: param が 0 個、または Python 識別子化できない名/予約語を含む場合は { generic:true } となり def op(self, **params: Any) -> … で params を素通し (型主張せず)。op 名自体も pyIdentifier で予約語衝突 (`op_`)・先頭数字 (`_op`) を回避する。これにより生成 Python が常に構文的に妥当 (check:sdk:py が py_compile 成功) になる
- ref: scripts/gen-sdk-py.mjs:41-47; scripts/gen-sdk-py.mjs:107-120; scripts/gen-sdk-py.mjs:113-114; scripts/gen-sdk-py.mjs:128-130; package.json:37
- kind: option-branch
- status: planned
- note: 確認済: gen-sdk-py.mjs:41-47 が pyIdentifier (先頭数字→`_x`/予約語→`x_`)、:107-120 が methodParams (:109 length===0→generic, :113-114 非識別子/予約語→generic)、:128-130 が emitMethod の generic 分岐 (def op(self, **params: Any))。構文妥当性の機械担保は元案の sdk-py-contract.test.js:17-23 (def 列挙) では支えられず未確認だったため、py_compile gate の package.json:37 (check:sdk:py = python3 -m py_compile sesame_client.py) に置換。機構: 任意 schema 入力でも生成物が壊れない安全側分岐。

### [SDK-0013] TypedDict/NotRequired 生成と Python 3.10 ランタイム両立機構
- surface: sdk
- backend: local
- command: `registerTypedDict / emitTypedDicts / __future__ annotations`
- branch: required(裸型) | optional(NotRequired[]) | unsafe-key(dict[str,Any]) | bare-object(Any)
- assert: properties 付き result は TypedDict 登録、required は裸型・optional は NotRequired[...]、識別子化不能キーを含む形は dict[str, Any] に降格、bare object/形不明は Any。NotRequired は TYPE_CHECKING 下 import + `from __future__ import annotations` で注釈文字列化され Python 3.10 ランタイムでも import/実行可能
- ref: scripts/gen-sdk-py.mjs:49-67; scripts/gen-sdk-py.mjs:72-87; scripts/gen-sdk-py.mjs:94-104; packages/kit/sdk/python/sesame_client.py:7; packages/kit/sdk/python/sesame_client.py:15-16; packages/kit/sdk/python/sesame_client.py:115-117
- kind: contract-existence
- status: planned
- note: 確認済: gen-sdk-py.mjs:49-67 が pyResultType/Base (bare object→Any の降格)、:72-87 が registerTypedDict (:74-75 unsafe-key→dict[str,Any])、:94-104 が emitTypedDicts (:100 optional→NotRequired[...])。sesame_client.py:7 が `from __future__ import annotations`、:15-16 が `if TYPE_CHECKING: from typing import NotRequired`、:115-117 が AccountWhoamiResult(TypedDict) の NotRequired フィールド実例。機構: 型レイヤ生成規則 + 3.10 後方互換 (注釈文字列化)。個別 result 形ではなく『嘘をつかない型降格規則』と『古い Python で壊れない』の不変条件。

### [SDK-0014] 生成 SDK の JSON-RPC 封筒/HTTP 送信機構 (id 採番・Bearer・error→SesameRpcError)
- surface: sdk
- backend: local
- command: `SesameClient._call`
- branch: token有(Bearer) | token無 | JSON-RPC error body | HTTPError | URLError
- assert: _call は {jsonrpc:'2.0', id:++self._id, method, params} を POST {base}/rpc に送り、token があれば authorization: Bearer を付す。応答 error!=null は SesameRpcError(message, code, data) に、HTTPError/URLError は _raise_http_error/_raise_url_error で typed error に翻訳する (生成 HTTP-only クライアントの普遍封筒)
- ref: packages/kit/sdk/python/sesame_client.py:1258-1275; packages/kit/sdk/python/sesame_client.py:24-33; scripts/gen-sdk-py.mjs:304-321
- kind: contract-existence
- status: planned
- note: 確認済: sesame_client.py:1258-1275 が _call (:1259 self._id+=1, :1260 jsonrpc/id/method/params, :1262-1263 Bearer, :1264 POST {base}/rpc, :1268-1271 HTTPError/URLError→_raise_*, :1272-1274 error→SesameRpcError)、:24-33 が SesameRpcError(message,code,data) + kind/retryable 抽出。gen-sdk-py.mjs:304-321 が同一 _call テンプレート (生成元)。機構: 全 method 共通の封筒。ドメイン spec は payload を見るが、ここは id/jsonrpc/authorization/error-翻訳の封筒不変条件を 1 本化。

### [SDK-0015] experimental docstring 注記 + stable-only API_VERSION/SesameEventTopic 生成機構
- surface: sdk
- backend: local
- command: `emitMethod x-stability / API_VERSION / SesameEventTopic Literal`
- branch: stable | experimental(@experimental docstring) | x-event-topics 有/無
- assert: x-stability==='experimental' のメソッドは生成 def に @experimental (x-provenance) docstring を付し、ヘッダは spec.info x-apiVersion・stable 件数を記し API_VERSION 定数を出す。SesameEventTopic は spec['x-event-topics'] から Literal[] を生成 (空なら str)。全 stable メソッドが def として出ている
- ref: scripts/gen-sdk-py.mjs:122-126; scripts/gen-sdk-py.mjs:170-173; scripts/gen-sdk-py.mjs:175-177; packages/kit/sdk/python/sesame_client.py:2; packages/kit/sdk/python/sesame_client.py:18-21; packages/kit/tests/sdk-py-contract.test.js:17-28
- kind: contract-existence
- status: planned
- note: 確認済: 機構: 安定性メタの生成伝播。stream_events/topic 型の詳細は events ドメイン spec (EVENTS) が所有するため、ここは安定性注記と API_VERSION/全 stable 露出の機構に限定して重複回避。行番号確認済 (gen 122-126 が emitMethod の x-stability→@experimental tag、170 stableCount/172-173 eventTopics→topicType、176 ヘッダ apiVersion 行、生成物 line2='apiVersion 1.4.0 · 205 methods (13 stable)'・18 API_VERSION・21 SesameEventTopic Literal、test 17-23 stable 全 def・25-28 @experimental/API_VERSION)

## py-clients-error

### [SDK-0016] HTTP→kind 写像表が 4 実装で自己整合 (fixture 正)
- surface: sdk, serve
- backend: local
- command: `_HTTP_STATUS_KIND/_http_error_kind (sdk) / _http_kind (clients) / fixtures/http-kind-map.json`
- branch: 400/413/415=bad_params | 401/403=not_authenticated | 404=not_implemented | 408/429/5xx=connection_lost | else=internal
- assert: http-kind-map.json を正典とする 4 実装 + 2 生成テンプレの HTTP→kind 写像自己整合は [[SRV-0055]] が網羅的に所有する (本 ID はそのサブセットのため重複)
- ref: local-contract
- kind: contract-existence
- status: waived: 重複（正典 [[SRV-0055]]）
- note: 正典は [[SRV-0055]] (serve-framing) — fixtures/http-kind-map.json を正として 4 実装 (sdk-ts/sdk-py/clients-js/clients-py) + 2 生成テンプレ (gen-sdk-ts/py) の写像リテラル全エントリ一致・5xx→connection_lost・既定→internal・retryable 連動までを網羅所有。本 SDK-0016 は gen-sdk-py テンプレ + clients/python 照合のサブセットで二重起票のため waive。表自体ではなく body.kind が status 由来 kind を上書きする clients/python 固有の優先順位機構は別境界として [[SDK-0029]] が所有する

### [SDK-0017] SesameRpcError 正名化と SesameError deprecated alias (同一クラス) 機構
- surface: sdk
- backend: local
- command: `SesameRpcError / SesameError alias (clients + sdk)`
- branch: SesameRpcError(正) | SesameError(alias)
- assert: clients/python で SesameError is SesameRpcError (同一クラスオブジェクト) であり isinstance(SesameRpcError(...), SesameError) が成立、core の SesameError (packages/core/src/errors.js, code:string) との同名異義は解消され全クライアントが kind/code:int の SesameRpcError に統一されている
- ref: packages/kit/clients/python/sesame_client.py:63-75; packages/kit/sdk/python/sesame_client.py:24-33; packages/kit/tests/serve/clients-python.test.js:21-25
- kind: contract-existence
- status: planned
- note: 機構: SURF-35 改名と後方互換 alias の不変条件 (クラス同一性)。1 リリース維持の alias を機械固定。行番号確認済 (clients 63-70 が class・75 が alias 代入、sdk 24-33 が class、test 21-25 が export/is/isinstance アサート)。core 側 SesameError は workspace split で packages/core/src/errors.js に移動

## py-clients-transport

### [SDK-0018] clients/python 設定ディレクトリ解決が CLI(core/src/paths.js) と同一優先順位
- surface: sdk
- backend: local
- command: `_default_config_dir / _default_socket_path / _default_token_path`
- branch: SESAME_KIT_HOME | XDG_CONFIG_HOME/sesame-kit | ~/.config/sesame-kit
- assert: 同梱 thin クライアントの socket/token パス解決が SESAME_KIT_HOME → $XDG_CONFIG_HOME/sesame-kit → ~/.config/sesame-kit の順 (CLI 権威 packages/core/src/paths.js resolveConfigDir の再現) で、standalone コピーながら CLI と同一ディレクトリに収束する
- ref: packages/kit/clients/python/sesame_client.py:38-58; packages/kit/tests/serve/clients-python.test.js:71-99
- kind: option-branch
- status: planned
- note: 機構: src からの import 無しでパス解決を再現する不変条件。3 段優先順位は config ドメインではなく client パッケージ自体の自己整合。行番号確認済 (client 38-50 が _default_config_dir・53-54/57-58 が socket/token、test 71-88 が PY_PATHS・90-100 が describe)。権威 paths.js は workspace split で packages/core/src/paths.js に移動、CLI 側は --config-dir/overrideDir の tier-0 を持つが thin client は持たないため上記 3 段のみ再現

### [SDK-0019] clients/python transport: call/subscribe 共有 id 空間と reader 相関ディスパッチ
- surface: sdk
- backend: local
- command: `_StreamTransport.request/_reader/subscribe / _ids`
- branch: id応答(pending pop) | method.startswith('event.')→on_event | timeout
- assert: _StreamTransport は単一 itertools.count(1) を call と subscribe で共有し、reader は id 一致応答を _pending から取り出して Event を起こし、'event.' で始まる method 通知のみ on_event(topic, params) へ振り分ける。応答 20s 無で kind='timeout' を raise する (id 衝突しない相関機構)
- ref: packages/kit/clients/python/sesame_client.py:216-258; packages/kit/clients/python/sesame_client.py:224; packages/kit/clients/python/sesame_client.py:242-244; packages/kit/clients/python/sesame_client.py:254-257
- kind: idempotency
- status: planned
- note: 機構: 双方向ストリーム上で要求/応答/イベントを id・method prefix で多重分離する相関不変条件。caller は id を持たず transport が一元採番。行番号確認済 (216-258 が _StreamTransport、224 が共有 _ids、242-244 が event. 振り分け、254-257 が 20s timeout raise。採番は request の 247 で next(self._ids))

## py-clients-packaging

### [SDK-0020] clients/python パッケージ整合 (setup.cfg メタ + pyproject build-backend + npmignore)
- surface: sdk
- backend: local
- command: `pyproject.toml / setup.cfg / .npmignore`
- branch: setup.cfg(name/version/py_modules) | pyproject(build-system only)
- assert: clients/python は setup.cfg に name=sesame-client/version/py_modules=sesame_client/python_requires>=3.8 を宣言的に持ち、pyproject.toml は build-system のみ (PEP621 [project] を置かず古い setuptools の UNKNOWN-0.0.0 空 wheel 罠を回避)、.npmignore で __pycache__/ と *.py[cod] を npm 配布から除外する
- ref: packages/kit/clients/python/setup.cfg:1-11; packages/kit/clients/python/pyproject.toml:1-5; packages/kit/clients/python/.npmignore:1-2
- kind: contract-existence
- status: planned
- note: 機構: 配布パッケージ自己整合。古い setuptools 互換のため PEP621 を避け setup.cfg に寄せる設計不変条件。行番号確認済 (setup.cfg は [metadata] name/version + [options] py_modules/python_requires>=3.8、:1-11 で全域; pyproject 5 行が build-system のみ、.npmignore は __pycache__/ と *.py[cod] の 2 行)。当初候補の setup.cfg:1-12 は実ファイル 11 行のため :1-11 に補正。当初 assert の '__pycache__/*.pyc' 文言を実パターンに修正

## 監査追補 v2 (dual-audit)

### [SDK-0021] clients/js の serve.token テイントバリア (sanitizeServeToken) が CRLF/ヘッダ/URL インジェクションを遮断
- surface: sdk
- backend: local
- command: `sanitizeServeToken / WsTransport ctor / HttpTransport ctor`
- branch: null/空→null | URL-safe 文字のみ→trim 値 | 制御文字/空白/改行を含む→SesameRpcError(not_authenticated)
- assert: clients/js は token を Authorization ヘッダ/URL クエリに載せる前に必ず sanitizeServeToken に通し、/^[\w.~+/=-]+$/ に合致しない (制御文字・空白・改行を含む) 値を SesameRpcError(kind='not_authenticated') で拒否する。WsTransport(ctor) と HttpTransport(ctor) の双方がこの 1 バリアを通し、ファイル由来 serve.token の改竄値が CRLF ヘッダ注入/URL クエリ汚染へ波及しない (taint barrier の機構不変条件)
- ref: packages/kit/clients/js/sesame-client.mjs:60-70; packages/kit/clients/js/sesame-client.mjs:220; packages/kit/clients/js/sesame-client.mjs:258
- kind: error-path
- status: planned
- note: dual-audit consensus (A2≡B1)。セキュリティ critical。HttpTransport(mjs:258)/WsTransport(mjs:220) 両経路が同一バリアを通す。コメント mjs:55-59 が『serve.token がファイルから読まれ改竄値が混入すると HTTP ヘッダ/URL インジェクション。CodeQL js/file-access-to-http のテイントバリア』と明記。Python clients は token を URL に載せず Authorization ヘッダ固定 (sesame_client.py:339) のため同型バリア不要だが、JS は WS の URL ?token= フォールバック (mjs:224) があるため必須。spec・test とも完全未被覆 (packages/kit/tests/ に sanitizeServeToken/injection/CRLF を直接アサートする test 無し)

### [SDK-0022] clients/js thin-client transport 機構 (shared-id 相関 / idle-close / 握手認証) — Python SDK-0019 と対称
- surface: sdk
- backend: local
- command: `StreamTransport.request/routeMessage/subscribe / _scheduleIdleClose`
- branch: id応答(pending pop) | event.→onEvent | timeout | idle-close(unref)
- assert: clients/js の transport (StreamTransport/WsTransport/HttpTransport) が ++_ids を call と subscribe で共有し、routeMessage が id 一致応答を _pending から pop して resolve、method='event.<topic>' 通知のみ onEvent(topic,params) へ振り分ける。応答 20s 無で kind='timeout'、StreamTransport は購読/pending 無で _scheduleIdleClose+unref により one-shot 後にプロセスを解放、WsTransport は握手 401/close 1008 を not_authenticated に翻訳する (Python [[SDK-0019]] と対称な JS 機構不変条件)
- ref: packages/kit/clients/js/sesame-client.mjs:141-149; packages/kit/clients/js/sesame-client.mjs:151-214; packages/kit/clients/js/sesame-client.mjs:216-254; packages/kit/tests/serve/clients-js.test.js:73-84
- kind: idempotency
- status: planned
- note: dual-audit onlyA。Python thin-client transport は [[SDK-0019]] が所有、JS は出荷 exports './client' の実体だが framework 機構 spec が欠落。broad: StreamTransport の id-共有/idle-close ライフサイクル + WsTransport 握手認証を一括する Python 対称 parity。WS の header-vs-URL token 分岐に focus した狭い JS-WS 固有面は [[SDK-0025]] が別 assert スコープで所有 (本 ID は StreamTransport idle-close 含む broad / SDK-0025 は WS 限定)。relatedSpecId=SDK-0019

### [SDK-0023] 生成 TS SDK の JSON-RPC 封筒/HTTP 送信機構 (_call) — Python SDK-0014 と対称
- surface: sdk
- backend: local
- command: `SesameClient._call (TS) / httpErrorFromBody / parseResponseJson`
- branch: token有(Bearer) | fetch-throw(-32000) | 非200+JSON-RPC body(verbatim) | 非200 body無(httpErrorKind) | invalid-JSON(-32700)
- assert: 生成 TS SDK の _call は {jsonrpc:'2.0', id:++this._id, method, params} を POST {baseUrl}/rpc し token あれば Bearer を付す。fetch 例外は SesameRpcError(-32000, connection_lost, retryable)、res.ok=false は httpErrorFromBody が JSON-RPC error body を verbatim/無ければ httpErrorKind(status) で kind/retryable 合成、parse 不能ボディは -32700 internal に翻訳する (Python [[SDK-0014]] と対称な TS 封筒不変条件)
- ref: packages/kit/sdk/ts/sesame-client.ts:107-123; packages/kit/sdk/ts/sesame-client.ts:59-90; scripts/gen-sdk-ts.mjs:213-232
- kind: wire-fidelity
- status: planned
- note: dual-audit onlyA。Python _call は [[SDK-0014]] が所有、TS は assert/ref が Python 専用のため未被覆。本 ID は unary _call 封筒に scope を限定 (streamEvents は [[EVT-0039]]/[[EVT-0040]] が所有のため範囲外)。同じ生成 TS SDK の streamEvents(SSE) フレーム解析側は [[SDK-0028]] が補完 (httpErrorFromBody/parseResponseJson の ref が一部重なるが主軸が unary 封筒 vs SSE 解析で別)。sdk-ts-contract.test.js:32-37 は httpErrorKind 存在のみで封筒を固定しない。relatedSpecId=SDK-0014

### [SDK-0024] sesame sdk eject の readFileSync/writeFileSync 失敗パス (ok:false 封筒)
- surface: cli, sdk
- backend: local
- command: `sesame sdk eject <lang> [--out <dir>] / cmdSdkEject (I/O error)`
- branch: read-fail(Cannot read SDK source) | write-fail(Cannot write to <dest>)
- assert: eject で readFileSync(entry.src) が失敗すると 'Cannot read SDK source: <detail>'、mkdirSync/writeFileSync(destPath) が失敗すると 'Cannot write to <destPath>: <detail>' を、それぞれ isJsonMode 時 stdout {ok:false,error} / 非JSON 時 stderr 'error: ...' で出し process.exitCode=1 で終える ([[SDK-0007]] unknown-lang と同一封筒分岐の I/O 失敗版)
- ref: packages/kit/src/cli/sdk.js:51-63; packages/kit/src/cli/sdk.js:65-77
- kind: error-path
- status: planned
- note: dual-audit onlyA。[[SDK-0007]] は unknown-lang・--json 封筒・help だけを branch 化するが cmdSdkEject には更に 2 つの I/O error-path がある。--json/人間モード封筒分岐は SDK-0007 と共通だが分岐対象 (I/O 失敗) が別。sdk-eject.test.js は read/write 失敗を踏まない (java unknown-lang のみ)。relatedSpecId=SDK-0007

### [SDK-0025] clients/js の WebSocket transport (SesameClient.ws / WsTransport) — ヘッダ vs URL token 分岐・握手認証失敗 reject
- surface: sdk
- backend: local
- command: `SesameClient.ws / WsTransport (clients/js)`
- branch: ws パッケージ有(useHeader→Authorization ヘッダ) | 無(global WebSocket→URL ?token=) | open→resolve | error(401/403/unauthorized→not_authenticated) | close 1008→not_authenticated | request timeout 20s
- assert: clients/js の SesameClient.ws は ws パッケージ (WebSocket) を優先 import し、有れば useHeader=true で Authorization: Bearer ヘッダ認証 (token を URL に載せない)、無ければ global WebSocket にフォールバックし URL ?token= を使う。ready() で初回 open を同期確立し、error の 401/403/unauthorized 検知または close code 1008 を not_authenticated として reject (open に取りこぼされない)。id は transport 採番で 20s timeout を持つ。clients/python は WS transport を持たないため JS 固有面
- ref: packages/kit/clients/js/sesame-client.mjs:106-115; packages/kit/clients/js/sesame-client.mjs:216-254; packages/kit/tests/serve/clients-js.test.js:86-105
- kind: idempotency
- status: planned
- note: dual-audit onlyB。WS の header-vs-URL token 分岐 + 握手認証失敗 reject に focus した JS-WS 固有面。[[SDK-0022]] は StreamTransport の id-共有/idle-close ライフサイクルを含む broad な Python 対称 transport framework で、WsTransport 握手 401/1008 部分が重なるが assert スコープが異なる (SDK-0022=StreamTransport+WS lifecycle 一括 / 本 ID=WS 限定 + header-vs-URL 分岐)。clients-js.test.js:86-105 (WS 正常/誤token not_authenticated/不正topic bad_params) は [ID] タグ無し孤児のため status:planned (covered には [ID] タグが必要)。SRV-0018 (server verifyClient) とは client/server で面が違い重複しない

### [SDK-0026] clients/js の設定ディレクトリ解決 (defaultConfigDir 3 段優先順位) — SDK-0018 の JS 並行
- surface: sdk
- backend: local
- command: `defaultConfigDir/defaultSocketPath/defaultTokenPath (clients/js)`
- branch: SESAME_KIT_HOME | XDG_CONFIG_HOME/sesame-kit | ~/.config/sesame-kit
- assert: clients/js の socket/token パス解決 (defaultConfigDir→defaultSocketPath/defaultTokenPath) が SESAME_KIT_HOME → $XDG_CONFIG_HOME/sesame-kit → ~/.config/sesame-kit の順で CLI 権威 (packages/core/src/paths.js resolveConfigDir) を src import 無しに再現し、SesameClient.unix()/http() の既定パスが CLI と同一ディレクトリへ収束する ([[SDK-0018]] の JS 並行不変条件)
- ref: packages/kit/clients/js/sesame-client.mjs:27-38; packages/kit/clients/python/sesame_client.py:38-58
- kind: option-branch
- status: planned
- note: dual-audit onlyB。[[SDK-0018]] は ref が clients/python のみで clients/js を含まず assert も python に閉じる。config ドメインの CFG (resolveConfigDir CLI 側) とは別で重複しない (client パッケージ自体の自己整合)。clients/python は clients-python.test.js:71-99 の PY_PATHS で 3 段検証されるが clients/js には対応テスト無し。relatedSpecId=SDK-0018

### [SDK-0027] clients/js パッケージ配布整合 (exports['./client'] サブパス + files 同梱) — SDK-0020 の JS 側対称
- surface: sdk
- backend: local
- command: `package.json exports['./client'] / files (clients/js packaging)`
- branch: -
- assert: clients/js は packages/kit/package.json の exports['./client'] サブパスで types=clients/js/sesame-client.d.ts・default=clients/js/sesame-client.mjs として公開され、files に 'clients/' が含まれ同梱配布される (clients/js 自身は package.json を持たず親 kit の export-map に依存する設計)。[[SDK-0020]] が clients/python 配布自己整合を見るのと対称の JS 側不変条件
- ref: packages/kit/package.json:8-13; packages/kit/package.json:17-21
- kind: contract-existence
- status: planned
- note: dual-audit onlyB。clients/js ディレクトリには package.json が無く (README.md/sesame-client.d.ts/sesame-client.mjs のみ) 親 kit の export-map が唯一の公開経路。[[SDK-0020]] は clients/python の setup.cfg/pyproject.toml/.npmignore に閉じ JS の export-map/同梱を含まない。[[SDK-0008]] は sdk/ 同梱+eject 結線で clients/ の npm export-map は別物。.d.ts の SesameErrorKind union 内容は [[SRV-0056]] が持つが export-map 存在性とは別境界。relatedSpecId=SDK-0020

### [SDK-0028] 生成 TS SDK の streamEvents(SSE) フレーム解析 + HTTP error 翻訳 (httpErrorFromBody/parseResponseJson)
- surface: sdk
- backend: local
- command: `scripts/gen-sdk-ts.mjs / streamEvents (SSE) + httpErrorFromBody/parseResponseJson`
- branch: data: 行→onEvent | : コメント(heartbeat)無視 | チャンク跨ぎ部分行保持 | !res.ok→httpErrorFromBody | JSON.parse 失敗→SesameRpcError(-32700)
- assert: 生成 TS SDK は 205 メソッド表とは別に固定テンプレ部として streamEvents(topics,onEvent,{signal}) を持ち、GET {base}/events?topics=… を Authorization: Bearer 付きで開き 'data:' 行のみ JSON.parse して onEvent へ流し ':' コメント (heartbeat) を無視、buf.split('\n') の末尾部分行を保持する。HTTP エラーは parseResponseJson→httpErrorFromBody で JSON-RPC error body 優先・無ければ httpErrorKind(status) で kind/retryable を埋めた SesameRpcError に翻訳する (生成 SDK 固有の SSE + HTTP 封筒機構)
- ref: scripts/gen-sdk-ts.mjs:238-274; scripts/gen-sdk-ts.mjs:165-190; packages/kit/sdk/ts/sesame-client.ts:238
- kind: wire-fidelity
- status: planned
- note: dual-audit onlyB。[[SDK-0023]] は同じ生成 TS SDK の unary _call 封筒 (id 採番/jsonrpc/Bearer/-32700/-32000/非200-body) に scope を限定した別面で、httpErrorFromBody/parseResponseJson の ref が一部重なるが主軸 (SSE フレーム解析 vs unary 封筒) が異なる。drift gate ([[SDK-0004]]) はテンプレ全体を byte 照合するが SSE/error 翻訳の挙動不変条件は別 assert が要る。SDK-0001〜0005 は _call/205 メソッド表・ns マップ・任意引数・drift gate・stability に閉じ SSE/HTTP error 翻訳テンプレを索引していない。py 側 gen-sdk-py.mjs:323 stream_events も同様に未被覆

### [SDK-0029] clients/python の HTTP error 構築 (_sesame_error_from_http の body.kind 優先順位)
- surface: sdk
- backend: local
- command: `_sesame_error_from_http (clients/python)`
- branch: error が dict→err.data.kind 優先 (無ければ _http_kind(code)) | error が str→_http_kind(code) | body 非 dict/parse 不能→_http_kind(code)+text fallback
- assert: clients/python の HTTP transport は非200 応答を _sesame_error_from_http で SesameRpcError に翻訳し、JSON-RPC error body が dict ならその err.data.kind を _http_kind(code) より優先、err が str なら _http_kind(code)、body 不能なら text||'HTTP {code}: {reason}' + _http_kind(code) を kind とする。401 かつ token 無しは _unauthorized() で具体的案内へ分岐する (status 由来 kind と body 由来 kind の優先順位機構)
- ref: packages/kit/clients/python/sesame_client.py:95-107; packages/kit/clients/python/sesame_client.py:328-332
- kind: error-path
- status: planned
- note: dual-audit onlyB。waive 済の [[SDK-0016]] は _http_kind 表 (status→kind) の自己整合に閉じ、body.kind が status 由来 kind を上書きする優先順位ロジックは別境界として未被覆だった (表 vs 構築ロジックで別軸、conflict でない)。clients-python.test.js:35-41 は 413→bad_params/code を見るが body.kind 優先枝は未検証。relatedSpecId=SDK-0016

# sesame-kit フルリファクタリング計画書 v3(第3回監査)

作成日: 2026-06-13 / 監査方法: 参照実装(`_sesame_sdk_ref` = Android SesameSDK Kotlin, `references_web` = biz3 web React, `_aws_sdk_ref` = AWSMobileClient 2.77.0 Java)との全面突き合わせ第3回。9 領域(認証 / 個人クラウド / Biz3 / BLE-OS3 コア / BLE-OS2+周辺デバイス / 公開経路対称性 / アーキテクチャ / ドキュメント / 横断バグハント)を 9 サブエージェントで並列監査し、原典 67 所見を **56 計画項目**(Phase 1〜6)に統合した。**Critical 3 件・High 7 件は統括者が一次資料と実挙動(node 最小再現・ワイヤデコード実測)で再検証済み**。

> **v2 との関係**: 第2回計画書(2026-06-12 作成)は全 81 項目実装完了し、本書で置き換えた。v2 本文はコミット `4860ed3` 時点の `REFACTORING_PLAN.md` を参照。**本書の所見 ID(`R3:XXX-NN`)と項目番号(P1-1 等)は v1/v2 と独立**であり、同名でも別物。繰越は §9(実機検証 V1〜V14。今回 V15〜V19 を追加)と §10(見送り確定事項。今回 11〜15 を追加)のみ。

**v3 の主題**: v2 完了時点でワイヤ忠実性・経路対称性・契約ゲートは高水準に達している(§6 陰性結果の量を参照)。今回の Critical/High の中心は **「monorepo 内のドッグフードでは構造的に踏めない問題」** に移った:

1. **配布の不成立** — workspace 分割(v2 P5-14)後、`@sesame-kit/core` は単体 install で import 不能(P2-1)、release CI の publish はルート private で必敗(P2-2)、docs のライブラリ import 例は全滅(P6-1)。リポジトリ内では hoisting と相対パスが全てを隠蔽し、全ゲートが緑のまま「公開した瞬間に全消費者環境で死ぬ」状態。
2. **失敗経路の実行時バグ** — BLE トランスポート接続失敗で待機 Promise が孤児化し unhandledRejection でライブラリ利用者のプロセスが落ちる(P1-1)。既存テストは「成功するモック transport」しか使っておらず、失敗経路を踏んでいない。
3. **経路ごとの「未指定」の意味差** — 型付き gRPC が proto3 既定値(0/false/"")を実引数として注入し、stable メソッド lock.click を含む多数が誤動作(P1-3)。

## 実施状況

**全 56 項目 実装完了**(2026-06-13)。実装はワークフロー上の軽量エージェント(sonnet/haiku をファイル排他レーンに分割)、監査(参照一次資料との突き合わせ・全ゲート・敵対的再検証)は統括が担当。Phase 1〜6 を逐次実行し、各フェーズ末に統括が `typecheck`/`lint`(0 warning)/`check:refs`/`test`/`build` を独立再実行して合格を確認してから次フェーズへ進めた。

- **Phase 1(P1-1〜P1-5)**: 実行時バグ。BLE connect/register 失敗時の孤児 Promise → unhandledRejection を try/catch+待機者 clear+no-op catch で解消(OS3/OS2 計4経路)、OS2 送信を `_writeSeg` ヘルパ経由に統一。gRPC を proto3 `optional`+`oneofs:true`+`_field` sentinel で field presence 化(stable `lock.click` の台本0誤実行を解消)。canary に main ガード。`deleteDevice` に subUUID 同送。
- **Phase 2(P2-1〜P2-7)**: 配布成立。`@sesame-kit/core` に `ws` 依存追加(**package-lock は Docker Linux で再生成、Linux optional 保持・3行追加のみ**)+ CI 隔離 install スモーク。release.yml を `npm publish -w core -w kit` 化 + release.sh の version 三分裂検査。両パッケージに LICENSE/README(+core に LICENSE.biz3)。kit `files` から `types/` 除外・`main` 削除。sdk を `packages/kit/sdk/` へ git mv + `sesame sdk eject` コマンド新設。出荷ソース内の旧名 `sesame-kit`→`@sesame-kit/core`(grep ゲート付き)。README インストール節を正直化。
- **Phase 3(P3-1〜P3-18)**: クラウド/認証の参照忠実化。認証(P3-10〜18)は `_aws_sdk_ref`(AWSMobileClient 2.77.0)を一次資料に USERNAME(usernameInternal)・DEVICE_KEY 注入・ClientMetadata:{}・リトライ/タイムアウト(ClientConfiguration/PredefinedRetryPolicies/RetryUtils を in-repo 化し実値採用)・recoverable 例外・credential 永続化(0600)・device 無しトークン許容・readJsonOrNull の ENOENT 写像。クラウド(P3-1〜9)は invokeWebAPI body・**鍵ストア REST(getDevicesList/putKey/removeKey)+ keystore.* RPC 3メソッド**・subscribeChunks op 相関・IoT 大文字化・IR normalizeUuid・friend QR・formatPasscodeID・reqContext 戻り・isUuidV4。**CONTRACT_VERSION 1.3.0→1.4.0(205メソッド)**。
- **Phase 4(P4-1〜P4-7)**: BLE 忠実化。OS2 mechStatus の isStop を kind 3値化(os2lock=null〔CHSesame2.kt:40〕/ os2bike=flags bit0 / os2bot=motorStatus)+ result-schemas nullable 化、guest 鍵 sentinel(`secretKey.contains("000000")`)自動 server-auth 判定、生体 SS2 の 16B ガード、OS2 reset の dropKey 写像、OS3 `<4B` token の即時 reject 対称化、devicemodel BIKE_OS2 の os2bike 化、biometric の虚偽コメント是正。
- **Phase 5(P5-1〜P5-8)**: アーキ衛生。CLI/serve/session の i18n カタログ(約1400行)を `packages/kit/src/i18n/` へ移動 + core に `registerCatalog` API(層の逆転解消、本番 core は kit 非依存を維持)、**v2 で「実装済み」と誤記録されていた i18n 完全性テスト(P5-9)を実在化**(core/kit 両カタログ)。secure-fs ロック解放の ino 所有権確認、BLE アダプタ層エラーを SesameError 体系へ(BLE_* 5種)、serve スタブガードを opt-in 反転、bin の aws-sdk 残骸 env 削除、Windows 非サポートの明示。CONTRACT_VERSION 最終化(changelog に keystore/isStop/reqContext 記載)。
- **Phase 6(P6-1〜P6-11)**: ドキュメント正直化。docs/README の import 例を `@sesame-kit/core` に、削除済み `wifi.networkStatus()` 例の除去、workspace 分割後のパス/リンク是正、数値を実測(**205メソッド/contract 1.4.0**)へ、存在しない CLI 例の修正、provenance 語彙の実装値化、LICENSE の旧主張削除、promo 陳腐化是正、OS3 自動履歴ドレイン非実装の注記。

**最終横断監査(敵対的再検証)**: 認証・BLE/クラウドの最忠実性項目を独立エージェント2体で「テスト緑でも参照不一致」を狙って再検証。3 件を検出し是正済み — ① P3-13 リトライが Throttling 系 4xx を非リトライ(コメントは準拠と明記=コード乖離)、② `AbortSignal.timeout` の `TimeoutError` を取りこぼしリトライ(参照はソケットタイムアウト除外)、③ CHUserKey typedef の stateInfo 欠落。3リトライサイト(cognito-http / cognitoIdentityCall / makeApiGatewayTransport)で Throttling 4xx リトライ・TimeoutError 即 throw に統一し、SigV4 経路の ClockSkew リトライも追補(全て RetryUtils 引用付き、コメント↔コード一致)。

**完了ゲート(統括による独立再実行)**: `typecheck` clean / `lint` 0 warning / `check:refs` 18/18(P3-13 で ClientConfiguration/PredefinedRetryPolicies/RetryUtils を追加)/ **test unit 2119 + e2e 381 = 2500 全緑**(監査開始時 2220 から +280、各項目に検出テスト同梱)/ `build` 再生成冪等。**残件は §9 実機検証バックログ(V1〜V19)のみ** — コード実装は完遂、実機(SESAME/実 Cognito/実 API Gateway)が無いと最終キャプチャ照合だけ不可。該当 API は `@experimental` 維持。

**申し送り**: package-lock.json は本セッションで Docker Linux 再生成済み(core→ws の3行追加・Linux optional 保持)。次リリースは Phase 2 で整備した `npm publish -w core -w kit` 経路 + release.sh の version 同期検査を通すこと。`@sesame-kit/core` の npmjs Trusted Publisher 登録(リポジトリ外作業)が publish 前に必要。

---

## 0. 前提

### 0.1 規範(v1/v2 の規範 1〜9 を全て継承し、今回の教訓 10〜12 を追補)

v2 §0.1 の 1〜9 は本書でもそのまま有効(絶対制約 = 認証は AWSMobileClient 2.77.0 アプリ方式・web 禁止 / 1:1 ポート規範 / モックは参照の送信側から導出 / 経路対称性 6 点セット / `@experimental` マーカー / **自リポ file:line 引用禁止(シンボル名で書く)** / CONTRACT_VERSION 連動 / 「1:1 宣言」全件照合テスト義務 / 参照は in-repo)。追補:

10. **パッケージ単体解決の検証**(新規・P2-1/P2-2 の教訓): monorepo の hoisting は依存欠落・exports 不備を隠す。workspace パッケージの依存/exports/files を変更したら、`npm publish --dry-run -w packages/core -w packages/kit` と「隔離ディレクトリへ pack 相当コピー → install → import スモーク」を CI で常設・実行する。「リポジトリ内で動く」は配布物が動く証拠にならない。
11. **スクリプトは main ガード必須**(新規・P1-4 の教訓): `scripts/*.mjs` は `import.meta.url === pathToFileURL(process.argv[1]).href` ガードで実行副作用を隔離し、関数を export する。特に**資格情報・実クラウドに触れる処理を import 副作用で発火させるのは事故**(本監査中に実際に発火した。P1-4 参照)。
12. **「未指定」の表現は経路ごとに違う**(新規・P1-3 の教訓): JSON-RPC のキー不在 / proto3 の既定値 / CLI のフラグ不在は、同じ「未指定」でもワイヤ表現が異なる。params の既定値・省略判定(`?? / typeof / !== undefined`)を持つハンドラは、**全 framing(stdio/socket/http/ws/grpc)で「未指定」と「明示既定値」の両方を流す契約テスト**を書く。1 経路(JSON-RPC)のテストでは他経路の既定値注入を検出できない。

### 0.2 ベースライン(2026-06-13 監査時点、HEAD = `4860ed3`)

`npm run typecheck` / `npm run lint`(0 warning)/ `npm test`(**unit 1883 + e2e 337 = 2220 全緑**)/ `npm run build` 再生成ドリフト 0 / `npm run check:refs` 15/15。**つまり表面上の壊れは無く、本書の所見はすべて「既存ゲートが検出できない種類の問題」**(配布経路・失敗経路・経路間の意味差・参照との不一致・ドキュメント虚偽)である。Phase 1〜2 の各修正は「なぜ既存ゲートが検出できなかったか」を確認し、検出できるゲート(規範 10〜12)を同梱すること。

> 監査時の副作用開示: 監査エージェントが `scripts/canary-upstream.mjs` のエクスポート確認のため import した際、main ガード欠落(P1-4)により live canary が発火し、保存済みトークンで実クラウドへ read-only 4 op(status/whoami/devices.list/getDeviceStatus)が実行された。変更系操作は無し。これ自体が P1-4 の実証である。

### 0.3 重複所見の統合表

| 統合先 | 原典所見(R3) |
|---|---|
| P1-3(gRPC 既定値注入) | SURF-01 = SURF-05(lock.click の 0 判定は gRPC 修正に従属) |
| P2-2(リリース基盤) | ARCH-02 + DOC-11(architecture.md の prepack 虚偽記述) |
| P2-6(出荷ソース内の旧称) | ARCH-03(core 内コメント 7 箇所 + kit `main` デッドフィールド) |
| P3-18(意図的逸脱の文書化) | AUTH-08(User-Agent)+ AUTH-10(devicePassword 形式) |
| P6-3(構成 stale 一括) | DOC-05 + DOC-06 + DOC-07 + DOC-10 |
| P6-4(契約・数値表記) | DOC-08 = SURF-03(contract 1.2.0)+ DOC-09 + DOC-16 + DOC-19 + DOC-20 + SURF-04 |

### 0.4 フェーズ構成と依存

| Phase | 内容 | 規模 | 依存 |
|---|---|---|---|
| 1 | 実行時の確定バグ(Critical/High) | M | なし(最優先) |
| 2 | 配布・公開の成立(workspace 分割の完成) | M | なし(Phase 1 と並行可) |
| 3 | クラウド/認証の参照忠実性 残補完 | L | Phase 1 完了後推奨 |
| 4 | BLE 忠実性 残補完 | S | P1-1/P1-2 の後(同ファイル群を触るため) |
| 5 | アーキテクチャ衛生 | M | P5-8(契約 bump)は Phase 3 の面追加の後 |
| 6 | ドキュメント正直化 | M | P6-1/P6-2 は即時。残りは各 Phase に随伴 + 最終一括 |

---

## Phase 1 — 実行時の確定バグ(Critical/High)

#### P1-1. BLE 接続失敗時の待機 Promise 孤児化 → unhandledRejection でプロセス死〔R3:BUG-01 / **Critical**〕

- **対象**: `packages/core/src/ble/session.js` の `SesameBleSession.connect()` / `register()`、`packages/core/src/ble/os2/session.js` の `SesameOS2BleSession.connect()` / `register()`(計 4 箇所)。顕在化点: `packages/core/src/ble/index.js` の `SesameBle.connect()` catch 節(`_session.disconnect()` 呼び出し)。
- **現状と問題**: 4 メソッドとも、待機 Promise(`loginPromise`/`readyPromise` — `_loginWaiter`/`_readyWaiter` + 8 秒タイマ)を**生成した後**で `await this._transport.connect(...)` を呼ぶ。実機トランスポート(`NobleTransport`)はデバイス圏外 / Bluetooth OFF / 権限なし / scan timeout で `connect()` が reject するため、その時点で待機 Promise は `return` に到達せず**誰もハンドラを張っていない孤児**になる。その後 (a) 8 秒タイマの発火、または (b) ファサード `SesameBle.connect()` の catch が呼ぶ `_session.disconnect()` → `_failAllPending()` → `_rejectWaiter()` が孤児を reject し、**unhandledRejection** になる。
- **影響(統括再検証済み・node 最小再現あり)**: ① CLI には unhandledRejection ハンドラが無く**プロセスが exit 1 で落ちる**。② `@sesame-kit/core` 利用者が圏外ロックに `SesameBle.use()` しただけで**利用者のプロセスが落ちる**(ライブラリとして致命的)。③ serve デーモンは「60 秒間に 50 回超の unhandledRejection で `process.exit(1)`」のバースト保護を持つため、認証済みクライアントが圏外デバイスへ `ble.unlock` を連打するだけで**デーモンを自殺させられる**。
- **修正手順**: 4 メソッド共通で `await this._transport.connect(...)` を try/catch し、失敗時に (1) `clearTimeout(waiter.timer)`、(2) `this._loginWaiter = null`(register は `_readyWaiter`)、(3) 孤児 Promise に no-op catch を付与(`loginPromise.catch(() => {})`)してから rethrow する。代替案「待機者生成を transport.connect 成功後へ移動」は、connect 解決直後に initial packet が到着した場合の取りこぼしリスクを精査しない限り採らない(現行の「先に待機者を作る」順序は受信レースに対して正しい)。
- **テスト**: モック transport `connect: async () => { throw new Error("nope") }` で 4 経路すべてを叩き、`await expect(...).rejects.toThrow(/nope/)` の後に fake timer で 9 秒進めても `process.on("unhandledRejection")` スパイが発火しないことを固定。ファサード経路(`SesameBle.use`)でも同様に固定。**既存 BLE テストのモック transport が全て「成功する connect」しか持たない**ことが見逃しの根因なので、失敗 transport のテストヘルパを共通化する。
- **受け入れ基準**: 圏外デバイスへの connect/register 失敗が「呼び出し元への単一の reject」だけで完結し、unhandledRejection が 0 件。serve のバースト自殺がこの経路で起きない。

#### P1-2. OS2 セッションの送信が write の reject を握らず unhandledRejection〔R3:BUG-02 / High〕

- **対象**: `packages/core/src/ble/os2/session.js` の `_sendPlain()` / `_sendCipher()`(`this._transport.write(seg)` の戻り Promise を捨てている。`_requestPlain` 内の直呼びも同様)。
- **参照(kit 内の正しい実装)**: OS3 側 `packages/core/src/ble/session.js` の `_writeSeg()` は「同期 throw と Promise reject の両方を catch する(unhandledRejection を避けるため)」と明記して対処済み。OS2 だけ同じ堅牢化から漏れている非対称。
- **現状と問題(統括再検証済み・node 再現あり)**: `NobleTransport.write()` はリトライ枯渇時に reject する。login / timePhone / コマンド送信中にリンクが切れると reject が誰にも捕まらず unhandledRejection → P1-1 と同じ「CLI 即死 / ライブラリ利用者巻き込み / serve バースト自殺」面に合流する。
- **修正手順**: OS3 の `_writeSeg()` と等価なヘルパを OS2 セッションに追加し、`_sendPlain` / `_sendCipher` / `_requestPlain` の `this._transport.write` 直呼びを全てそのヘルパ経由に置換。送信失敗自体は応答 timeout / `_handleTransportDisconnect` の fail-fast が表面化を担うため、ヘルパ内は握り潰しで良い(OS3 と同じ流儀)。
- **テスト**: `write: () => Promise.reject(new Error("link lost"))` のモックで OS2 login 送信を起こし、unhandledRejection スパイ不発火 + pending が timeout/linkLost で reject されることを固定。
- **受け入れ基準**: OS2 セッションの全送信点が write 失敗を握り、unhandledRejection 0 件。

#### P1-3. 型付き gRPC が proto3 既定値を実引数として注入し、stable の lock.click 含む多数が誤動作〔R3:SURF-01(=SURF-05)/ High〕

- **対象**: `scripts/gen-grpc-proto.mjs`(`optional` キーワード不使用 — 生成 proto 全 1521 行に presence 無し)、`packages/kit/src/serve/framing/grpc.js` の glue(`protoLoader.loadSync(..., { defaults: true })` + jsonFields の空文字 delete のみ)、`packages/kit/src/serve/sesame.proto` / `grpc-methods.generated.json`(生成物)。
- **現状と問題(統括がワイヤデコード実測で再検証済み)**: proto3 は presence 無しの scalar を省略するとデコード側で既定値(数値 0 / bool false / 文字列 "")に化け、glue は jsonFields の `""` しか delete しないため、**未指定フィールドが「明示的な 0/false/""」としてハンドラに届く**。確定する誤動作:
  1. **lock.click(stable)**: ハンドラの `hasScript = params.scriptIndex !== undefined && !== null` が 0 を有効値と判定 → 型付き gRPC の `LockClick({name})` は**常に台本 0 実行(cmd 170)**になり、通常クリック(cmd 89)を実行できない。実機で副作用が出る誤動作。
  2. **lock.setAutolock**: `transport: ""` が `?? "cloud"` をすり抜け enum 検査で**常に bad_params**(transport を明示しない限り呼べない)。
  3. **typed ble.\* 全 74 op**: `scanTimeoutMs: 0` が既定 15s を回避し**即時 deviceNotFound**。`collectMs: 0` で生体一覧 5 op / ble.wifi.scan が**常に空**。
  4. **ble.os2.register**: `localServerAuth: false` 注入で認証モードが既定から反転。
  5. **presetir.sendIR / device.history / device.battery / ir.listRemotes / webapi.deviceHistory**: `operation: ""` / `pageSize: 0` 等が上流へ送出される(v2 P3-7 は `lastKey || null` の 1 箇所だけ塞いでいた)。
- **修正手順**: ① `gen-grpc-proto.mjs` で required でない scalar フィールドに proto3 `optional` を付与し field presence を有効化。② glue を「presence の無いフィールドは params から落とす」方式に書き換える。**@grpc/proto-loader の `defaults: true` と proto3 optional(synthetic oneof)の相互作用はバージョン依存があるため必ず実測**し、必要なら `defaults: false` に変更して presence ベースの正規化に一本化する。③ 明示的に `scriptIndex: 0` / `collectMs: 0` を送った場合は**値として届く**ことを同時に保証(0 を一律 delete する安易な修正は台本 0 実行を不能にするので禁止)。④ proto / generated.json の再生成と CONTRACT_VERSION への影響確認(メソッド集合は不変なので bump 不要の見込みだが、ハッシュ連動テストで確認)。
- **テスト**: gRPC e2e に「`LockClick({name})` → `botClick` が呼ばれ `botClickScript` は呼ばれない」「`LockClick({name, scriptIndex: 0})` → `botClickScript(_, 0)` が呼ばれる」「`LockSetAutolock({name, seconds})` が成功」「`DeviceHistory({deviceUUID})` の pageSize がハンドラに undefined で届く」を追加。規範 12 に従い、省略/明示既定値の対で固定する。
- **受け入れ基準**: 全 framing で「未指定」と「明示既定値」が区別され、型付き gRPC からの全メソッドが JSON-RPC 経路と同一挙動になる。

#### P1-4. canary スクリプトが import 副作用で実クラウドへ資格情報付きアクセスを実行〔R3:SURF-02 / High〕

- **対象**: `scripts/canary-upstream.mjs` 末尾(`if (replay) runReplay(); else runLive().catch(...)` がトップレベルで無条件実行)。
- **現状と問題(統括再検証済み)**: 他の生成スクリプト(gen-rpc-schema / gen-grpc-proto / gen-sdk-ts 等)は全て main ガード(`import.meta.url === pathToFileURL(process.argv[1]).href`)を持つのに、canary だけ欠落。このモジュールを import しただけで(argv に `--replay` が無ければ)`runLive()` が走り、**保存済みトークンで実クラウドに接続**して status/whoami/devices.list/getDeviceStatus を実行する。replay テストが subprocess 実行なのは偶然の回避に過ぎない。**本監査中に実際に発火した**(§0.2 開示参照)— read-only 4 op のみで変更系は無いが、これ自体が欠陥の実証。
- **影響**: テスト/ツールから関数を import した瞬間に、CI や開発機で意図しない実クラウド通信(資格情報使用)が起きる。
- **修正手順**: 末尾を main ガードで包み、`runReplay` / `runLive` / バリデーション関数を export する(既存の replay テストは subprocess 起動なのでそのまま動く)。規範 11 を `scripts/` 全体に適用し、ガード有無を検査する軽量テスト(全 .mjs を import して副作用が無いこと)を追加。
- **テスト**: unit に「`import("scripts/canary-upstream.mjs")` がネットワーク副作用を起こさない」(SesameHub3 生成系のスパイ不発火)を追加。
- **受け入れ基準**: scripts/ 配下の全モジュールが import 安全。canary live は明示実行時のみ走る。

#### P1-5. デバイス削除 `op:"del"` の items に subUUID が乗らない(参照は常に同送)〔R3:CLOUD-P-01 / High〕

- **対象**: `packages/core/src/client.js` の `SesameHub3#deleteDevice`(`items: [{ deviceUUID }]` のみ送出)。下流: CLI `device delete`、RPC `device.delete`。
- **参照**: `references_web/src/components/MobileRemoveDevice.js:58-64` — web の `del` 唯一の呼び出し元は `removeSesameDevices([{ deviceUUID, subUUID }], ...)` と **subUUID(操作者のユーザ UUID)を必ず同送**する。`useManageDevice.js:228-237` は items を素通しするため、ワイヤ上 `{deviceUUID, subUUID}` が正(統括が参照を直接確認済み)。
- **現状と問題**: kit は subUUID 欠落フレームを送る。サーバが subUUID を「ユーザ側鍵の同時削除」や履歴記録に使う場合、削除が部分的になる/拒否される可能性がある(サーバ側挙動は §9 V15)。del フレームのワイヤ形テストも無く欠落を検出できない。
- **修正手順**: `deleteDevice` で `renameDevice` と同形に `this._subUUID` 未取得なら NOT_CONNECTED を throw し、`items: [{ deviceUUID, subUUID: this._subUUID }]` を送る。`devices.deleteDevices` 自体は items 素通しのため変更不要。
- **テスト**: fake WS client でフレームをキャプチャし items 形(`{deviceUUID, subUUID}`)を固定。subUUID 未取得時のエラーも固定。manage-ops 系テストにワイヤ形スナップショットを追加。
- **受け入れ基準**: del フレームが参照と一致し、テストで固定される。§9 V15 に実機確認を登録。

---

## Phase 2 — 配布・公開の成立(workspace 分割の完成)

> v2 P5-14 は「コードの分割」を完遂したが、「**パッケージとして配布できる状態**」は未完成だった。本 Phase はその完成。完了後に初めて 0.6.x の publish が可能になる。

#### P2-1. `@sesame-kit/core` が実行時依存 `ws` を宣言せず、単体 install で import 不能〔R3:ARCH-01 / **Critical**〕

- **対象**: `packages/core/package.json`(`dependencies` フィールド自体が無い。optionalDependencies に noble のみ)、`packages/core/src/transport.js` の `import WebSocket from "ws"`(静的 top-level import。index.js が再 export するためエントリ import 全体が死ぬ)。
- **現状と問題(統括再検証済み)**: monorepo 内では kit の `dependencies.ws` がルート node_modules へ hoist され全ゲートが緑のまま隠蔽される。壊れるのは「`npm install @sesame-kit/core` をライブラリとして単体利用」という README が掲げる中核ユースケースだけで、**公開した瞬間に全消費者環境で `ERR_MODULE_NOT_FOUND` 即死**する。
- **修正手順**: ① `packages/core/package.json` に `"dependencies": { "ws": "^8.18.0" }`(kit と同レンジ)を追加。② package-lock の更新は既知の落とし穴どおり **Docker Linux** で行う(macOS npm install での再生成は Linux optional が消え CI 全滅)。③ 規範 10 の恒久ゲートを CI に追加: `npm publish --dry-run -w packages/core -w packages/kit` + 「core を一時ディレクトリへ隔離コピー → `npm install`(レジストリの ws を取得)→ `import '@sesame-kit/core'` が成功」のスモークジョブ。隔離スモークは publish 前ゲートとしてだけでなく常時 CI に置く(依存追加忘れの再発を全般的に塞ぐ)。
- **テスト**: 上記 CI スモークが本体。ローカルでは `node -e` で隔離 import 検証(監査で再現済みの手順を scripts 化してよい)。
- **受け入れ基準**: core 単体 install で import が成功する。隔離スモークが CI で常時実行される。

#### P2-2. リリースパイプラインが workspace 未対応 — publish 必敗・バージョン三分裂〔R3:ARCH-02(+DOC-11)/ **Critical**〕

- **対象**: `.github/workflows/release.yml`(publish ステップ)、`scripts/release.sh`(preflight / bump 案内)、ルート + 両パッケージの package.json、`docs/en|ja/architecture.md` の prepack 記述。
- **現状と問題(統括再検証済み)**:
  1. release.yml は**リポジトリルートで** `npm publish --provenance --access public` を 1 回実行するのみ。ルートは `"private": true` のため npm は **EPRIVATE で拒否**し、workspace パッケージは `-w` 指定が無い限り publish 対象にならない。`github-release` ジョブは `needs: publish` なので GitHub Release も作られない。
  2. release.yml のコメント「prepack (npm run build) が走り生成物を再生成」は**虚偽** — ルート・core・kit のどこにも prepack/prepublishOnly は存在しない(architecture.md の同主張 = DOC-11 も同根)。
  3. release.sh の二重リリース防止は `npm view "sesame-kit@$VERSION"` のみで `@sesame-kit/core` を見ない。バージョンは**ルート package.json だけ**読み、案内する `npm version --no-git-tag-version` はルートのみ bump するため、`packages/*/package.json`(各 0.6.2)と kit の依存ピン `"@sesame-kit/core": "0.6.2"` が分裂する。
  4. タグ最新は v0.6.1 — **分割後に一度もリリースされておらず、この経路は未検証のまま**。
- **修正手順**:
  1. publish ステップを `npm publish --provenance --access public -w packages/core -w packages/kit` に変更(core → kit の順)。
  2. release.sh の preflight に「root/core/kit の version 一致 + kit の core ピン一致」検査と `npm view "@sesame-kit/core@$VERSION"` の二重リリース確認を追加。bump 手順を `npm version <x> --no-git-tag-version --workspaces --include-workspace-root` + core ピン追従(スクリプト化)に差し替え。
  3. release.yml の tag 照合も 3 package.json 一致を検証。prepack 虚偽コメントを削除し「生成物は commit 済み + release.sh の drift 検査が担保」と正しく書く(architecture.md 側は P6-3 で同時是正)。
  4. `npm publish --dry-run -w ...` を通常 CI に常設(P2-1 と同ジョブ)。
  5. リリース前チェックリストに「npmjs 側で `@sesame-kit/core` を Trusted Publisher 登録」(リポジトリ外作業)を明記。
- **テスト**: dry-run ジョブが本体(EPRIVATE / files 漏れ / exports 不備を常時検出)。release.sh preflight に対するユニット(version 不一致を検出)。
- **受け入れ基準**: タグ push で 2 パッケージが provenance 付き publish され、version は 3 ファイル + ピンで常に一致する。

#### P2-3. 両パッケージに README / LICENSE / LICENSE.biz3 が同梱されない〔R3:DOC-14 / Medium〕

- **対象**: `packages/core/`・`packages/kit/`(README.md, LICENSE 不在)、各 package.json の `files`。
- **現状と問題**: npm はパッケージルートの LICENSE/README しか自動同梱しない。core は biz3 由来コードの逐語コピー(`packages/core/src/vendor/biz3/`)を `files: ["src/"]` で出荷するのに、MIT の「license text 同梱」要件を満たす LICENSE / LICENSE.biz3 がどちらの tarball にも入らない。npm ページの README も空になる。
- **修正手順**: 各パッケージに LICENSE(core には LICENSE.biz3 も)を複製配置(またはルートからのコピーを release preflight で検証)。短い README(パッケージの役割 + ルート README へのリンク + 最小の使用例)を各パッケージに追加。`npm publish --dry-run` の files 一覧で同梱確認。
- **受け入れ基準**: 両 tarball に LICENSE(+core: LICENSE.biz3)と README が入る。
- **注**: ユーザー規範「機能追加時は README 更新」に従い、本 Phase 完了時はルート README のインストール節(P2-7)とも同期する。

#### P2-4. kit が消費者から到達不能な types/(568KB)を出荷している〔R3:ARCH-08 / Low〕

- **対象**: `packages/kit/package.json`(`files` に `types/` があるがトップレベル `types` フィールド無し・exports は `./client` のみで参照先は `clients/js/sesame-client.d.ts`)。
- **現状と問題**: kit の公開面は bin(CLI)と `./client` だけで、`packages/kit/types/**`(cli/serve 内部の d.ts、568KB)はどの公開経路からも参照されない。tarball 肥大 + 「内部 API の型が配布される」混乱(v2 P5-8 の内部 API 非公開方針とも不整合)。
- **修正手順**: kit の `files` から `types/` を除外(リポジトリ内の型検査用 outDir としては維持 — composite ビルドに必要)。
- **受け入れ基準**: dry-run の files 一覧から types/ が消え、`./client` の型解決は維持される。

#### P2-5. 生成 SDK(sdk/ts, sdk/python)と schema/ の配布経路が「リポジトリからコピー」しか無い〔R3:ARCH-09 / Low(設計判断)〕

- **対象**: ルート `sdk/ts/sesame-client.ts`、`sdk/python/sesame_client.py`、`schema/openrpc.json`。生成器 `scripts/gen-sdk-*.mjs` とドリフトゲート(`packages/kit/tests/` の sdk 契約テスト)は kit の serve 契約に結合している。
- **現状と問題**: 「生成 SDK」を柱に掲げつつ、core/kit どちらの files にも入らず、利用者の入手手段が GitHub からの手動 vendoring に限られる。論理的な所属(kit の契約に従属)と物理配置(ルート)もずれている。
- **修正方針(決定込み)**: vendoring が意図された消費形態(README も「コピーして使う」と案内)なので、**「インストール済みパッケージから vendoring できる」状態を正解とする**: ① `git mv sdk packages/kit/sdk`(rename 履歴保持)。② kit の `files` に `sdk/` を追加。③ CLI に `sesame sdk eject <ts|py> [--out <path>]` を追加(同梱ファイルを書き出すだけの薄いコマンド。serve 契約と同バージョンの SDK が常に手に入る)。④ 生成器・ドリフトテスト・docs のパス更新(機械的)。⑤ schema/openrpc.json は `rpc.discover` で既に実行時取得可能なため移動不要(ルート維持)。
- **テスト**: eject コマンドの出力が同梱物と byte 一致。既存 SDK ドリフトゲートのパス更新後の green。
- **受け入れ基準**: `npm i -g sesame-kit && sesame sdk eject ts` で型付き SDK が入手できる。経路対称性チェックリスト(規範4)に従い docs(P6 系)も同時更新。

#### P2-6. 出荷ソース内の使用例が旧パッケージ名 `"sesame-kit"` のまま(実行すると必ず落ちる)〔R3:ARCH-03 / Medium〕

- **対象**: `packages/core/src/index.js` ヘッダ(パッケージ名・import 例・npm link 例)、`client.js` / `iot.js` / `ble/index.js` / `ble/os2/index.js` のコメント内 import 例(計 7 箇所、grep で機械列挙可能)、`packages/core/src/errors.js` の旧パス記述(`src/serve/jsonrpc.js` — 現在は core 直下)、`packages/kit/src/optional-deps.js` の旧前提記述、`packages/kit/package.json` の `"main": "./src/cli.js"`(exports 存在時は無視される到達不能デッドフィールド — 統括再検証済み: `import("sesame-kit")` は ERR_PACKAGE_PATH_NOT_EXPORTED)。
- **現状と問題**: core は `files: ["src/"]` でソースごと出荷するため、ライブラリ利用者が最初に読む index.js の使用例が**壊れた import を教える**。
- **修正手順**: ① core 内の `from "sesame-kit"` 例示を `@sesame-kit/core` に一括修正。② errors.js / optional-deps.js の旧構成記述を現構成(core/src/jsonrpc.js、kit/src/serve/daemon.js)へ更新。③ kit の `main` を削除(bin + `./client` exports を契約に一本化)。④ 再発防止: `grep -rn 'from "sesame-kit"' packages/core/src` が 0 件であることを check スクリプト(または lint テスト)に追加。
- **受け入れ基準**: 出荷ソース内の全使用例がコピペで動く。grep ゲートが CI で効く。

#### P2-7. README インストール節の正直化(`npm install @sesame-kit/core` は現状 404)〔R3:DOC-02 / High〕

- **対象**: `README.md` / `README.ja.md` のインストール節・依存関係節。
- **現状と問題(統括確認: npm registry 照会)**: `@sesame-kit/core` は**未 publish(E404)**。`sesame-kit` の最新は分割前の 0.6.1 で、その依存構成(node-aes-cmac / @aws-sdk / ink 必須)は README の現行記述(「必須 runtime 依存 3 つ」「AES-CMAC 内製」「ink/gRPC は optional peer」)と**全て不一致**。README はリポジトリ HEAD の姿を語っているが、`npm install` する読者には虚偽になる。
- **修正手順**: 二択を明示的に選ぶ — (a) P2-1〜P2-6 完了後に 0.6.2+ を publish して README と実態を一致させる(推奨・本 Phase のゴール)。(b) publish までの期間が空くなら、インストール節に「publish 準備中 — それまでは git clone + workspace で利用」と明記する暫定パッチ。リリース後は (b) の注記を撤去。
- **受け入れ基準**: README のインストール手順をそのまま実行して成功する(または成功しない理由が README 自身に明記されている)。

---

## Phase 3 — クラウド/認証の参照忠実性 残補完

> 3A(P3-1〜P3-9)= クラウド/Biz3、3B(P3-10〜P3-18)= 認証。3A/3B は並行可。

### 3A. クラウド・Biz3

#### P3-1. `invokeWebAPI` の body キー省略は参照と不一致(vendor は `body = {}` を常時送信)— v2 P3-10 の誤トレース是正〔R3:CLOUD-P-02 / Medium〕

- **対象**: `packages/core/src/devices.js` の `invokeWebAPI`(`...(body !== undefined && { body })` とコメント「vendor は query/body を渡さない呼び出しでキー自体を省く」)、`webapiDeviceState` / `webapiDeviceHistory`。誤挙動を固定しているテスト: `packages/core/tests/devices/manage-ops.test.js` の「query のみ渡した場合: body キー不在」ケース。
- **参照(統括再検証済み)**: `references_web/src/api/useDeveloper.js:46-58` — `invokeAPI = async ({ func, query, body = {}, cb })`。**body はデフォルト引数 `{}`** で msgData に常時含まれる。query は undefined のとき `JSON.stringify` で脱落(こちらは kit と一致)。よって正は: `getIoTDeviceState`/`getDeviceHistory` は `{..., query, body:{}}`、`triggerDevice` は `{..., body:{...}}`(query 無し)。
- **修正手順**: `invokeWebAPI` を「body は `body ?? {}` で常時送信 / query のみ条件スプレッド」へ。コメントの出典読み違い(`body = {}` デフォルトの見落とし)を訂正し、manage-ops テストの期待値を反転。
- **テスト**: 既存ワイヤ形テストの期待修正(query のみ → `frame.body` は `{}`)。§9 V16 にサーバ受理の実機確認を登録。
- **受け入れ基準**: webapi 系 3 op のフレームが参照導出形と一致。

#### P3-2. 個人アカウント鍵ストア REST(getDevicesList / putKey / removeKey)の経路欠落〔R3:CLOUD-P-03 / Medium〕

- **対象**: 対応実装なし。関連: `packages/core/src/devices.js`(REST は sign / sesame5 register のみ)、`packages/kit/src/cli/locks.js` の `locks add --from-url`(ローカル config 登録のみ)、`aws-credentials.js` の per-op エンドポイント表(列挙のみ実装なし)。
- **参照**: `_sesame_sdk_ref/.../server/CHAPIClient.kt:22-46` — `GET /device/list` / `PUT /device` / `DELETE /device`(いずれも `appidentifyid` ヘッダ付き、payload は `CHUserKey.kt` 形: deviceUUID/deviceModel/keyIndex/secretKey/sesame2PublicKey/nickname/level/rank)。`ScanQRcodeFG.kt:316-357` — QR で受けた鍵をローカル登録後**クラウドの鍵ストアへ putKey で同期**。`CHDeviceViewModel.kt:563-571, 596-597` — `syncDeviceFromServer()`(getDevicesList)がアプリの一覧復元経路、`dropDevice`/`resetDevice` は removeKey をクラウドへ送ってからローカル削除。
- **現状と問題**: これはテレメトリではなく**個人アカウントの鍵 CRUD**で §10-6 の対象外。kit は読み側を biz3 WS で代替しているが**書き側(putKey/removeKey)の経路が無い**。`locks add --from-url` で受けた共有鍵がクラウド鍵ストアに載らず公式アプリに出ない(アプリ併用時の片方向不整合)。
- **修正手順**: ① `devices.js` に register REST 群と同じ transport(SigV4 + x-api-key + **appidentifyid ヘッダあり** — CHAPIClient.kt:22-46 に明示)で `getDevicesList` / `putKey` / `removeKey` を追加(CHUserKey 形を JSDoc で固定)。② CLI: `locks add --from-url` に `--push`(クラウド同期)を追加、`locks` に `sync --from-account`(getDevicesList 取り込み)等の経路を設計。③ RPC: NAMESPACE_OPS の JSDoc 型のみで公開(v2 教訓: registry パッチ併用禁止)。④ 公開面が増えるため P5-8(CONTRACT_VERSION bump)に連動。
- **テスト**: fake transport で method/path/headers(appidentifyid)/body(CHUserKey 形)を固定。CLI/RPC の対称性テスト。
- **受け入れ基準**: kit から鍵ストアの読み書きが完結し、6 点セット(規範4)が揃う。`@experimental`(実 API Gateway 未検証)マーカー + §9 登録。

#### P3-3. `subscribeChunks` の errorAction が無関係な失敗フレームで一覧取得を誤 reject〔R3:CLOUD-P-04 / Low〕

- **対象**: `packages/core/src/util.js` の subscribeChunks errorAction リスナ(同 action かつ `success===false` で一律 finish(err))。利用側: `client.js#listDevices`、`devices.js#getUserDevices`。
- **参照**: `references_web/src/api/useManageDevice.js:27-34` — vendor の `!message.success` は snackbar 表示のみで、進行中のページ蓄積は中断しない。
- **現状と問題**: serve デーモンの並行 RPC 環境では、一覧取得の 10 秒窓に同 action の別 op(del / updateName 等)の失敗応答が来ただけで一覧が「他人のエラー」で reject される。
- **修正手順**: errorAction 判定に op 相関の絞りを入れる — 受信フレームに `op` があり、それが自要求の op 系列でない場合は無視。完全相関は不可能なので「op 欠落フレーム or 自 op のみ拾う」を上限とし、判定根拠をコメントで明記。
- **テスト**: fake client で一覧進行中に `{action: biz3ManageDevice, op: "del", success: false}` を流し、一覧が継続することを固定。
- **受け入れ基準**: 並行操作下で一覧系が誤 reject しない。

#### P3-4. IoT cmd の topic/payload で deviceId を大文字化しない(アプリは常に uppercase 送信)〔R3:CLOUD-P-05 / Low〕

- **対象**: `packages/core/src/iot.js` の `buildIotTopic` / `buildIotPayload`(「大文字小文字変換は一切しない」と注記)。
- **参照**: `_sesame_sdk_ref/.../CHAPIClientBiz.kt:204-237`(`updateRelay` — `deviceId.toString().uppercase()` を payload にも topic `wm2{...}cmd` にも適用)、同 `:160-172`(`cmdSesame` も uppercase)。アプリのローカル DB は鍵を lowercase 保存(`CHDeviceManager.kt:130-133`)するため**送信時 uppercase が正準ワイヤ形**。web は無変換だが web の deviceUUID はサーバ由来で常に大文字(`useIotCtrl.js:112-127`)。
- **現状と問題**: 直接経路・手入力で小文字 UUID を渡すと `wm2{小文字}cmd` topic へ送られ Hub3 に届かず、fire-and-forget 系は**無音タイムアウト**になる。
- **修正手順**: `buildIotTopic` / `buildIotPayload` で deviceId/hub3Id を `toUpperCase()` 正規化(出典: CHAPIClientBiz.kt:204-237 をコメント引用)。
- **テスト**: 小文字入力で topic/payload が大文字化されることを iot テストに追加。
- **受け入れ基準**: 入力ケースに依らず参照と同一の topic/payload。

#### P3-5. IR 購読 push の deviceId フィルタが kit 独自・大文字小文字非正規化〔R3:CLOUD-P-06 / Low〕

- **対象**: `packages/core/src/ir.js` の `subscribeIRData` / `subscribeIRMode`(`msg.deviceId !== deviceId` の厳密比較フィルタ)。
- **参照**: `references_web/src/api/useRemoteCtrl.js:306-333` — vendor はデバイス照合をせず全購読者へ配る。
- **現状と問題**: 参照に無い独自フィルタで、サーバ push の deviceId が別ケースだった場合に学習フロー(`learnIRKey` / `onIRLearned`)が波形を黙って捨てて timeout する。
- **修正手順**: 比較を `normalizeUuid`(crypto.js)同士で行う(フィルタ自体は多デバイス購読の利便として維持し、独自追加である旨をコメントに明記)。
- **テスト**: 大文字/小文字混在 deviceId の push で onData が発火することを固定。
- **受け入れ基準**: ケース差で IR 学習が落ちない。

#### P3-6. friend QR(`t=friend`)の生成/解析ヘルパ未移植 —「QR で社員追加」フローの経路欠落〔R3:BIZ-01 / Medium〕

- **対象**: `packages/core/src/sharekey.js`(`sk` QR のみ移植済み)、`org.addEmployees` の入力経路、CLI `org` 系。
- **参照**: `references_web/src/utils/biz3utils.js:107-112`(`generateUserQRCodeBySubUUID` — `ssm://UI/?t=friend&friend=<subUUID大文字>`)、`:144-165`(`readUserQrcode` — `t==='friend'` 検証 + `{friendID: 小文字}` 返却)、`references_web/src/components/biz/device/AddEmployee.js:386-410`(friendID + companyID で `addEmployee items=[{friendID, companyID}]`)。
- **修正手順**: ① sharekey.js に `buildFriendQrUrl(subUUID)` / `parseFriendQrUrl(url)` を biz3utils.js の 1:1 で追加(大文字生成・小文字解析・t 検証)。② CLI `org add-employee --friend-qr <url>` を追加し items を合成。③ 公開区分は既存 sharekey ヘルパの扱いに合わせ、新規の経路非対称を作らない(規範4 チェックリスト適用)。P5-8 連動。
- **テスト**: round-trip(大文字生成→小文字解析)、`t` 不一致/friend 欠落の拒否、AddEmployee 相当の items 合成スナップショット。
- **受け入れ基準**: friend QR ⇄ friendID 変換と社員追加が kit で完結する。

#### P3-7. `formatPasscodeID`(PIN 桁 → ファーム hex)未移植で手動/CSV 投入が非互換 ID を作りやすい〔R3:BIZ-02 / Low〕

- **対象**: `packages/core/src/access.js` / `ble/biometric.js` / `crypto.js`(変換ヘルパ無し、JSDoc に形式要件記載なし)。
- **参照**: `references_web/src/utils/biz3utils.js:262-267`(`"123"→"010203"`: 各桁→2桁hex→大文字)。利用: `passwords.js:160, 233`(手動追加 / CSV 取込)、`passworddetails.js:111,155`。
- **修正手順**: crypto.js に `formatPasscodeID(password)` を 1:1 移植し、`access.postPasscodes` / `biometric.passcodeAdd` の JSDoc と CLI ヘルプから形式要件を案内(変換は呼び出し側オプトイン — 素通し仕様自体は参照一致なので変えない)。
- **テスト**: `"123"→"010203"`, `"0"→"00"` 等の変換テスト。
- **受け入れ基準**: kit 利用者が web/app 互換の passwordID を生成できる。

#### P3-8. `payment.changeDefaultPayment` が応答の `reqContext` を破棄(vendor は reqContext を消費)〔R3:BIZ-03 / Low〕

- **対象**: `packages/core/src/payment.js` の `changeDefaultPayment`(`return resp?.data ?? null`)。
- **参照**: `references_web/src/api/useStripeInfo.js:123-135` — 応答処理は `message.reqContext.defaultPaymentMethod` を読む(応答の実体は `reqContext`)。
- **修正手順**: 戻り値を `{data: resp?.data ?? null, reqContext: resp?.reqContext}` に変更(他 op の shape 規約と整合させる)。RPC result schema があれば追従 + P5-8 で契約確認。
- **テスト**: fake 応答に reqContext を入れて戻り値で見えることを固定。
- **受け入れ基準**: vendor が消費する応答フィールドがライブラリ利用者に届く。

#### P3-9. `isUuidV4` 未提供 + 非 v4 nameUUID の「BLE で v4 化 → WS 更新」composite 欠落〔R3:BIZ-04 / Low〕

- **対象**: `packages/core/src/access.js` の `updateCardName` / `updatePasscodeName` / `syncEnrolledCards`、CLI `access cards name` 系、`crypto.js`。
- **参照**: `references_web/src/api/useManageAuthData.js:431-474` — web のリネームは必ず `biz3utils.isUUIDV4(uuid)` を判定し、非 v4 なら BLE `SSM_OS3_CARD_CHANGE(107)` / `SSM_OS3_PASSCODE_CHANGE(123)` で新規 v4 を書き込み、ack 後にその v4 で WS 更新する。`biz3utils.js:435-453`(isUUIDV4: 16B・version==0x40・variant==0x80)。
- **修正手順**: ① crypto.js に `isUuidV4(tag)` を 1:1 移植。② `syncEnrolledCards` と CLI name 系に「非 v4 検出時は警告 + (BLE 接続があるとき)useManageAuthData.js:438-471 の二段 composite をオプトイン実行」を実装。素通し API 自体の仕様は維持(JSDoc に v4 要件を明記)。
- **テスト**: v4/非 v4 入力の分岐、BLE モック ack 経由の二段送信順序。
- **受け入れ基準**: 非 v4 nameUUID で web が送らない形のフレームを黙って送らない。§9 V17(ファーム採番 nameUUID の v4 性)に登録。

### 3B. 認証(絶対制約領域 — 参照は `_aws_sdk_ref` / `_sesame_sdk_ref` のみ。web へ寄せる変更は禁止)

#### P3-10. チャレンジ応答の USERNAME が参照(内部ユーザー名)と不一致〔R3:AUTH-01 / Medium〕

- **対象**: `packages/core/src/auth.js` の `respondToPasswordVerifier`(USERNAME に userIdForSRP を使用)/ `loginVerify`(USERNAME に入力 email を使用)/ `loginInitiate`(`ChallengeParameters.USERNAME` を pending に保存していない)。
- **参照**: `_aws_sdk_ref/CognitoUser.java:3594-3600,3644` — `usernameInternal = challengeParameters.get("USERNAME")` を保持し、PASSWORD_VERIFIER 応答の USERNAME には usernameInternal(SRP 計算には userIdForSRP)を使う。CUSTOM_CHALLENGE 応答も `ChallengeContinuation.java:162` + `CognitoUser.java:3214-3216, 3950-3955`(updateInternalUsername)で同様。
- **現状と問題**: pool が email を内部 UUID ユーザー名へ写像する設定の場合、アプリと異なるワイヤ値になる(SRP の HMAC 対象バイト列自体は参照一致 — 監査で確認済み)。再現材料(ChallengeParameters.USERNAME)を保存していないのが根因。
- **修正手順**: `loginInitiate` で `resp.ChallengeParameters?.USERNAME` を pending(`usernameInternal` フィールド追加)に保存し、`loginVerify` / `respondToPasswordVerifier` の `ChallengeResponses.USERNAME` と DEVICE_KEY 照合キーを `usernameInternal ?? 入力email` に統一。
- **テスト**: InitiateAuth 応答 `ChallengeParameters.USERNAME = UUID(≠email)` のモックで、RespondToAuthChallenge の USERNAME が UUID になることを検証。
- **受け入れ基準**: アプリと同一のワイヤ値。§9 V19(実 pool の USERNAME 形式確認)に登録。

#### P3-11. PASSWORD_VERIFIER 応答に保存済み DEVICE_KEY を注入しない(参照は必ず注入)〔R3:AUTH-02 / Medium〕

- **対象**: `packages/core/src/auth.js` の `respondToPasswordVerifier`(ChallengeResponses に DEVICE_KEY 無し。注記「pending にデバイス情報はない」は不正確 — store から取得可能)。
- **参照**: `_aws_sdk_ref/CognitoUser.java:3645`(`srpAuthResponses.put(CHLG_RESP_DEVICE_KEY, deviceKey)`、null なら marshaller が省略)。kit 自身も `loginVerify` では同条件(`existing.username === s.username && existing.deviceKey`)で注入しており、PASSWORD_VERIFIER だけ非対称。
- **現状と問題**: PASSWORD_VERIFIER 経路(@experimental・§9 V13)で remembered device が無視され、ログイン毎に NewDeviceMetadata → ConfirmDevice → サーバ側 device レコード累積が再発する(v2 P2-3 が解消した問題の別経路)。
- **修正手順**: `loginInitiate` で `store.load()` の `{username, deviceKey}` を確認し、一致時に `respondToPasswordVerifier` へ deviceKey を渡して `ChallengeResponses.DEVICE_KEY` に付与。
- **テスト**: 保存済み deviceKey がある store で PASSWORD_VERIFIER 連鎖を流し、RespondToAuthChallenge 入力に DEVICE_KEY が乗ることを user-srp 系テストに追加。
- **受け入れ基準**: loginVerify と同一の device 注入規則。

#### P3-12. RespondToAuthChallenge 3 op で `ClientMetadata:{}` が欠落(v2 P2-6 の網羅漏れ)〔R3:AUTH-03 / Low〕

- **対象**: `packages/core/src/auth.js` の `respondToPasswordVerifier`、`deviceSrpAuth` の DEVICE_SRP_AUTH / DEVICE_PASSWORD_VERIFIER 送信。
- **参照**: `_aws_sdk_ref/CognitoUser.java:3653, 3528, 3738`(Java は空 Map をセットするため空でも `"ClientMetadata":{}` がワイヤに出る。marshaller は `!= null` 判定のみ)。CUSTOM_CHALLENGE 応答だけは `ChallengeContinuation.java:168-170` の isEmpty ガードで**付かない**(kit 一致 — 変更禁止)。
- **修正手順**: 上記 3 op の payload に `ClientMetadata: {}` を追加。CUSTOM_CHALLENGE には付けない。
- **テスト**: 各フローのモックで input への `ClientMetadata:{}` 有無(CUSTOM_CHALLENGE は無し)をアサート。
- **受け入れ基準**: バイト/フィールド単位の 1:1(規範2)。

#### P3-13. AWS 呼び出し全面にリトライ/タイムアウトが無い〔R3:AUTH-04 / Medium〕

- **対象**: `packages/core/src/cognito-http.js` の `cognitoCall`、`packages/core/src/aws-credentials.js` の `cognitoIdentityCall` / `makeApiGatewayTransport`(いずれも素 fetch 1 発・明示タイムアウト無し)。
- **参照**: AWS SDK for Android は ClientConfiguration 既定の retry policy(5xx/スロットリングに指数バックオフ最大 3 回)と 15s 級タイムアウトを全クライアントに適用(ClientConfiguration 本体は `_aws_sdk_ref` 未収載 — 取得して in-repo 化し、実値を確認してから実装すること。規範9)。
- **現状と問題**: 瞬断・スロットリングでアプリなら成功するログイン/refresh が kit では即失敗し、ハングは fetch 既定(分単位)まで固まる。
- **修正手順**: ① `_aws_sdk_ref` に ClientConfiguration.java を追補し実値を確定。② `cognitoCall` / `cognitoIdentityCall` / API Gateway transport に `AbortSignal.timeout(...)` + 「5xx / TooManyRequestsException / ThrottlingException / ネットワーク例外のみ指数バックオフ最大 3 回」の薄い retry を実装(4xx 認証エラーはリトライ禁止)。
- **テスト**: fetch モックで 500→200 系列が 2 回目に成功・NotAuthorizedException が非リトライであることを検証。
- **受け入れ基準**: 参照実値に基づく retry/timeout が入り、出典が注記される。

#### P3-14. Identity Pool 再解決のトリガ例外集合が参照と不一致〔R3:AUTH-05 / Low〕

- **対象**: `packages/core/src/aws-credentials.js` の `makeCognitoCredentialsProvider` 内 refresh(`recoverable = ResourceNotFound || NotAuthorized`)。
- **参照**: `_aws_sdk_ref/CognitoCredentialsProvider.java:789-803, 678-696` — 再解決(GetId からやり直し)は **ResourceNotFoundException と ValidationException** のみ。NotAuthorizedException はそのまま throw。
- **修正手順**: recoverable 判定を `ResourceNotFoundException || ValidationException` に変更。NotAuthorized は ERR.UNAUTHENTICATED として即時伝播。
- **テスト**: ValidationException → GetId 再試行 / NotAuthorizedException → 1 回で throw をモックで固定。
- **受け入れ基準**: 参照と同一の自己修復条件。

#### P3-15. AWS 一時 credentials / identityId が永続化されない(CognitoCachingCredentialsProvider 乖離)〔R3:AUTH-06 / Medium〕

- **対象**: `packages/core/src/aws-credentials.js` の `makeCognitoCredentialsProvider`(in-memory キャッシュのみ。ヘッダコメントは「CognitoCachingCredentialsProvider 相当」と過大表示)。
- **参照**: `_aws_sdk_ref/CognitoCachingCredentialsProvider.java:86-98, 434-435, 473-515` — identityId / accessKey / secretKey / sessionToken / expiration を永続化しアプリ再起動を跨いで再利用。
- **現状と問題**: CLI はコマンド毎に新プロセスのため、API Gateway 系コマンドの度に GetId + GetCredentialsForIdentity の 2 RTT を必ず払う。identityId はユーザー毎に安定で、参照は明確に永続化している。
- **修正手順**: ① identityId を tokens ストア(または config)へ永続化し、provider 初期化時に注入(GetId スキップ)。② credentials 本体も tokens.json と同等の 0600 ファイルへ expiration 付きで永続化(参照と同じ 500s 閾値で失効判定 — 既存実装の閾値は参照一致確認済み)。③ コメントの「相当」表示を実態と一致させる。
- **テスト**: 2 つの provider インスタンス(プロセス再起動模擬)で、永続化済み identityId があれば GetId が呼ばれないこと。
- **受け入れ基準**: 再起動を跨いで参照と同じキャッシュ挙動。

#### P3-16. デバイス無しトークンを「保存は許すが利用は必ず拒否する」自己矛盾〔R3:AUTH-07 / Low〕

- **対象**: `packages/core/src/auth.js` の `loginVerify`(`deviceKey: null` でも保存成功)vs `getValidIdToken` → `assertAppLoginTokens(..., { requireConfirmedDevice: true })`(device 3 点必須で常に拒否)。
- **参照**: `_aws_sdk_ref/CognitoUser.java:3130-3138`(NewDeviceMetadata が null なら ConfirmDevice せず成功)、`:3554-3564`(REFRESH は deviceKey null なら DEVICE_KEY を省略)— 参照は「device 無しトークン」を一級市民として扱う。
- **現状と問題**: Cognito が NewDeviceMetadata を返さない設定に変わった場合、verify 成功 → 直後に「Run `sesame login`」拒否の無限ループになり自力復帰不能。書く側と読む側の不変条件が食い違っている。
- **修正手順**: 参照忠実側に統一する — `requireConfirmedDevice` を「deviceKey が存在する場合のみ整合チェック」に緩め、device 無しトークンの REFRESH(DEVICE_KEY 省略)を許す。`hasConfirmedDevice` 系のヘルパと呼び出し点を全て洗い、device 有り/無しの 2 状態を型コメントで明示。
- **テスト**: NewDeviceMetadata 無しの AuthenticationResult で loginVerify → getValidIdToken → refresh の系列が一貫して成功すること。
- **受け入れ基準**: 保存できるトークン状態は必ず利用もできる(不変条件の一致)。

#### P3-17. トークン読み出しの existsSync→read TOCTOU で並行 clear 時に素の ENOENT が漏れる〔R3:AUTH-09 / Low〕

- **対象**: `packages/core/src/tokens.js` の `readJsonOrNull`(existsSync 後に readFileSync。`load()` / `loadPending()` は無ロック読み)。
- **現状と問題**: serve デーモンの load と CLI logout の unlink が競合すると、期待する「null → UNAUTHENTICATED」でなく生の `Error: ENOENT` が伝播する。
- **修正手順**: `readJsonOrNull` を try/catch にし `code === "ENOENT"` で null を返す(existsSync は除去)。JSON.parse 失敗時の扱いは現行どおり。
- **テスト**: readFileSync を ENOENT throw にモックして load() が null を返すこと。
- **受け入れ基準**: 読み側レースでユーザー可視の生エラーが出ない。

#### P3-18. 意図的逸脱 2 件の文書化(User-Agent 非送出 / devicePassword 形式)〔R3:AUTH-08 + AUTH-10 / Low〕

- **対象**: `packages/core/src/auth.js` ヘッダの「意図的逸脱一覧」、`cognito-http.js`、`device-srp.js` の `generateDeviceVerifier`。
- **現状と問題**: ① 全 AWS リクエストの User-Agent が Node fetch 既定のまま(参照は `aws-sdk-android/2.77.0 ...` を常時付与)で、UserContextData 非送出と同種の逸脱なのに注記が無い。② devicePassword が Android 参照(`CognitoDeviceHelper.java:269-279` の UUID 36 文字)でなく JS SDK 方式(randomBytes(40) base64)— ワイヤ不可視・エントロピー上位互換で**実装変更は不要**(§10-13)だが、規範上の逸脱注記が無い。
- **修正手順**: 意図的逸脱一覧に 2 件を追記(UA は「模倣値を送る」選択肢の検討結果も書く)。コード変更なし。
- **受け入れ基準**: auth 領域の逸脱が全て出典付きで文書化されている。

---

## Phase 4 — BLE 忠実性 残補完

#### P4-1. guest 鍵の server-auth 自動判定(`secretKey.contains("000000")`)未移植〔R3:BLE3-01 / Medium〕

- **対象**: `packages/core/src/ble/index.js` の `SesameBle`(`needAuthFromServer` は明示フラグのみ)、`packages/kit/src/cli/ble.js` の `resolveCliServerAuth`(フラグ指定時のみ true)。
- **参照**: `_sesame_sdk_ref/.../CHBaseDevice.kt` の `sesame2KeyData` setter — `isNeedAuthFromServer = it.secretKey.contains("000000")`(sentinel による自動判定)。`CHSesameOS3.kt:468-491` — initial 受信時に true なら `signGuestKey` → server token login へ自動分岐。
- **現状と問題**: guest/期限付き鍵で `--server-auth` を付けないと通常 login が走り `invalidSig (secretKey mismatch?)` で失敗。エラーが原因(server-auth 必要)へ誘導しない。SDK は無設定で成功する。
- **修正手順**: ① `SesameBle.connect()` で sentinel 検出 + `needAuthFromServer` 未指定の場合: registerTransport があれば自動で server-auth 経路へ(CHBaseDevice.kt と同条件)、無ければ「server 認証が必要。`--server-auth` を付けるか registerTransport を渡せ」の明示エラー。② `ble.hintInvalidSig` の i18n 文言に server-auth 案内を追記。
- **テスト**: facade テストに「sentinel 含み鍵 + フラグ無し」→ 自動切替 / 案内エラーの両ケース。
- **受け入れ基準**: guest 鍵が SDK と同じく無設定で接続できる(または原因を正しく案内する)。§9 V18 登録。

#### P4-2. OS2 ロックの `parseMechStatus` が isStop を flags bit0 から捏造(参照は null)〔R3:BLEP-01 / Medium〕

- **対象**: `packages/core/src/ble/os2/protocol.js` の `parseMechStatus`(isBot 以外は `(flags & 1) === 0` を isStop に採用。出典注記「Sesame2 既定」は虚偽)、`ble/os2/session.js` の kind 分岐(`model === "ssmbot_1"` のみ os2bot)。
- **参照**: `_sesame_sdk_ref/.../CHSesame2.kt:40`(`CHSesame2MechStatus.isStop: Boolean? = null` — **明示的に null**)。flags bit0 由来は `CHSesameBot.kt:28`(Bot1/Bike1 用クラス)のみ。Bike1 は `CHSesameBikeDevice.kt:296`(Bot クラス利用・motorStatus 上書き無し)。
- **現状と問題**: Sesame 2/3/4 で SDK が公開しない isStop ブール値を bit0 から捏造して status()/RPC に載せている(bit0 のロックでの意味は一次資料が無い)。
- **修正手順**: kind を 3 値化 — `os2bot`(現行: motorStatus 由来)/ `os2bike`(flags bit0 由来)/ 既定 `os2lock`(**isStop = null**)。session の分岐に `bike_1 → os2bike` を追加し、既定を os2lock に。JSDoc 出典を CHSesame2.kt:40 に訂正。RPC result schema の isStop を nullable にする(契約確認は P5-8)。
- **テスト**: 「kind 無し(Sesame2)→ isStop === null」「os2bike → bit0 由来」「os2bot → motorStatus 由来」の 3 ケース。
- **受け入れ基準**: 参照が公開しない値を捏造しない。

#### P4-3. biometric の SS2 鍵チャンクが base64 復号長 16B を検証せず、壊れスロットが空 ssmID で混入〔R3:BLEP-02 / Low〕

- **対象**: `packages/core/src/ble/biometric.js` の `parsePubKeySesame`(SS2 分岐)。
- **参照**: `CHSesameBiometricDeviceImpl.kt:243-249`(不正データは例外でスキップ)。kit 内の同等処理 `wm2.js parseSesameKeys` は `raw.length !== 16` ガード済みで、biometric 側だけ欠落。
- **修正手順**: SS2 分岐に `if (decoded.length !== 16) continue;` を追加(wm2 と同型)。
- **テスト**: base64 不正な 22B チャンク + lockStatus≠0 → keys に含まれないこと。
- **受け入れ基準**: 壊れたファームデータでゴミスロットが出ない。

#### P4-4. OS2 ファサード `reset()` が成功時の dropKey 写像(セッション破棄)をしない〔R3:BLEP-05 / Low〕

- **対象**: `packages/core/src/ble/os2/index.js` の `reset()`(ack を返すのみ)。
- **参照**: `CHSesame2Device.kt:570-578`(reset 成功時 dropKey → disconnect / 鍵破棄)。kit 内の `wm2.js reset()` は同写像を実装・注記済みで、OS2 だけ非対称。
- **修正手順**: resultCode === 0 のとき `await this._session.disconnect()`(wm2 と同型)。
- **テスト**: reset 成功 → 以後の request が not-logged-in で reject されること。
- **受け入れ基準**: リセット済みセッションの再利用が構造的に防がれる。

#### P4-5. initial token が 4B 未満のとき待機者を timeout 放置(>4B の即時 reject と非対称)〔R3:BLE3-03 / Low〕

- **対象**: `packages/core/src/ble/session.js` の `_handleInitial`(`token.length < 4` はログのみ return)。
- **現状と問題**: 4B 超は v2 是正で即時 reject 済みなのに、4B 未満は 8 秒の汎用 timeout まで宙づりになり実原因が消える。
- **修正手順**: `< 4` 分岐も `t("ble.initialTokenMustBe4", {len})` 相当で `_loginWaiter` / `_readyWaiter` を即 reject(>4B 分岐と同一処理に統合)。
- **テスト**: 3B token ケースを既存 5B ケースと対で追加。
- **受け入れ基準**: token 長異常の両方向が同一の fail-fast。

#### P4-6. devicemodel の BIKE_OS2 メタデータが `mechKind:"os2bot"` + 「7B」誤記〔R3:BLEP-03 / Low〕

- **対象**: `packages/core/src/ble/devicemodel.js` の `BIKE_OS2` プロファイルと「os2bot 7B」注記(実 OS2 mech_status は 8B — `CHSesame2Device.kt:631` sliceArray(20..27))。
- **修正手順**: P4-2 の kind 3 値化と同時に BIKE_OS2 の mechKind を `os2bike` へ変更し、注記を「8B」に訂正。mechKind の消費箇所は truthy 判定のみであることを確認済み(変更安全)。
- **テスト**: devicemodel スナップショット更新。
- **受け入れ基準**: メタデータと実 parse 経路の意味論が一致。

#### P4-7. biometric の「UUID 整形ヘルパが無い」虚偽コメント是正〔R3:BLEP-04 / Low〕

- **対象**: `packages/core/src/ble/biometric.js` の `parseTouchFace` / `parsePubKeySesame` JSDoc(「kit には UUID 整形ヘルパが無いため hex のまま返す」)。
- **現状と問題**: `crypto.js hexToUuid` が実在し wm2.js / hub3.js が使用中。hex 返し自体は等価で許容だが理由づけが虚偽(規範: コメントを真実に保つ)。
- **修正手順**: コメントを「biometric 層は識別子を hex 正規形で統一する方針(整形は消費側、hexToUuid 利用可)」へ書き換え。挙動変更なし。
- **受け入れ基準**: コメントが事実と一致。

---

## Phase 5 — アーキテクチャ衛生

#### P5-1. core が CLI/serve 専用 i18n カタログ(約 1,400 行)を抱え、層の向きがデータ面で逆転〔R3:ARCH-04 / Medium〕

- **対象**: `packages/core/src/i18n/cli.js`(830 行)/ `serve.js`(530 行)/ `session.js`(37 行)、集約 `packages/core/src/i18n.js`(静的 import、外部カタログ登録 API 無し)。
- **現状と問題**: これらのキーの消費者は kit のみ(t() 呼び出し全 1,306 箇所の照合で確認済み)。ライブラリが CLI/TUI/デーモンの UI 文言を出荷し、**kit の文言 1 つの修正にも core の新バージョン公開が必要**(kit は core を完全固定ピン)。
- **修正手順**: ① core の i18n.js に `registerCatalog(area)`(Object.assign 追記 + 重複キー検出 throw)を追加。② `i18n/cli.js`・`i18n/serve.js`・`i18n/session.js` を `packages/kit/src/i18n/` へ git mv し、kit のエントリ(cli.js / daemon 起動)で登録。③ domain/ble/auth/org 等のライブラリ文言は core に残す。④ P5-2 の完全性テストを「core カタログ」「kit カタログ登録後」の両層で走らせる設計にする。
- **テスト**: 登録 API のユニット(重複キー検出含む)+ 移動後の全 t() 解決テスト(P5-2)。
- **受け入れ基準**: core の出荷物から CLI/serve 文言が消え、kit 単独で文言を更新できる。

#### P5-2. v2 P5-9「i18n カタログ完全性テスト」が実装済みと記録されているが実在しない〔R3:ARCH-05 / Medium〕

- **対象**: `packages/core/tests/i18n.test.js`(現状はロケール機構のみ)、REFACTORING_PLAN v2 の P5-9 記録。
- **現状と問題(統括再検証済み)**: P5-9 の受け入れ基準(en/ja キー集合一致・領域間重複ゼロ・{var} プレースホルダ一致の 3 アサーション)が**どれも存在しない**。v2 の「全 81 項目実装完了」記録と食い違う唯一の確認漏れ。現時点の実カタログは健全(en/ja 1318 キー一致・重複 0・プレースホルダ不一致 0 — 監査で機械検査済み)だが守るガードが無く、テストは ja 固定のため en 側の腐敗は静かに進行し得る。
- **修正手順**: P5-9 原文の 3 アサーション + 第 4 アサーション「src(core+kit)中の `t("...")` リテラルが全てカタログに存在」を追加(監査で使った走査ロジックを流用可)。P5-1 実施後は kit 側カタログを含む 2 層で検査。
- **テスト**: 追加テスト自体。故意に ja 専用キーを 1 個消して落ちることを確認してからコミット。
- **受け入れ基準**: カタログ非対称・未定義キー参照が CI で検出される。

#### P5-3. secure-fs ロック解放側に所有権確認が無く、stale 奪取と組み合わさると二重保持が成立〔R3:ARCH-06 / Low〕

- **対象**: `packages/core/src/secure-fs.js` の `withFileLock` 解放部(finally の無条件 unlink)。
- **現状と問題**: v2 P5-12 は**取得側**の競合窓を閉じたが解放側が残る。P1 が保持中に 10 秒超停止(suspend 等)→ P2 が stale 奪取 → P1 復帰後の finally が P2 の新鮮なロックを unlink → P3 と P2 の二重保持 → tokens.json の lost-update(refresh token 巻き戻り)が理論上再現。
- **修正手順**: 取得成功時に lock の `ino`(または lock へ書いた pid+nonce)を保持し、解放時に現 lock と一致する場合のみ unlink(不一致 = 奪取済みなので何もしない)。isLockStale が既に ino を扱っており実装パターンは揃っている。
- **テスト**: 「保持中に lock ファイルを差し替え → 解放後も差し替え後の lock が残る」ユニット(fs 操作のみで再現可)。
- **受け入れ基準**: 解放は自分が所有するロックに限定される。

#### P5-4. serve のテストスタブ hub のガードが「production 以外で有効」と逆向き〔R3:ARCH-07 / Low〕

- **対象**: `packages/kit/src/cli/serve.js` のスタブ分岐(`SESAME_SERVE_TEST_HUB === "1" && NODE_ENV !== "production"`)。
- **現状と問題**: CLI 利用者は NODE_ENV を設定しないため、通常環境で env 1 つで「偽の unlock 成功を返すデーモン」が起動できる。コメントの主張(production で絶対使わない)と実装(既定で使える)が食い違う。
- **修正手順**: opt-in に反転 — `NODE_ENV === "test" || process.env.VITEST` のときのみ許可。テスト側の起動コードを新ガードに合わせ更新。
- **テスト**: 通常 env でスタブが起動しないこと、テスト env で従来どおり起動すること。
- **受け入れ基準**: スタブ経路がテスト環境限定になる。

#### P5-5. BLE アダプタ層のエラーコード(BLE_NO_ADAPTER 等)が SesameError 体系外で契約に載っていない〔R3:ARCH-10 / Low〕

- **対象**: `packages/core/src/ble/transport.js` の CodedError(plain Error + `.code` 後付け: BLE_NO_ADAPTER / BLE_UNAUTHORIZED / BLE_UNSUPPORTED)、`packages/core/src/errors.js` の ERR enum(BLE 系非掲載)。
- **現状と問題**: serve 経由は写像済み(ble-error-mapping テスト)だが、**ライブラリ直接利用者**は instanceof SesameError で拾えず、未文書の `.code` への duck-typing を強いられる。
- **修正手順**: BLE_* を ERR に追加し SesameError(retryable=false)で投げる。`errorFromThrow` の分岐順と serve 写像(resultName/kind)を壊さないことを既存テーブル駆動テストで確認。d.ts / README のエラー表に追記(P6 と同期)。
- **テスト**: facade のエラーコードテストを拡張。serve 写像の回帰。
- **受け入れ基準**: ライブラリ利用者がエラーを安定コードで分岐できる。

#### P5-6. 起動エントリの aws-sdk 残骸 env 設定を削除〔R3:ARCH-11 / Low〕

- **対象**: `packages/kit/bin/sesame.js` の `AWS_SDK_JS_NODE_VERSION_SUPPORT_WARNING_DISABLED ??= "true"`(依存ツリーに aws-sdk 系は無く、読むコードも無い旧実装の残骸)。
- **修正手順**: 1 行削除。既存 CLI 契約テストで回帰確認。
- **受け入れ基準**: 「AWS SDK を使っている」という誤った印象を起動エントリが与えない。

#### P5-7. Windows の設定ディレクトリ/サポート方針が未確定〔R3:ARCH-12 / Low(方針決定)〕

- **対象**: `packages/core/src/paths.js`(XDG → `~/.config/sesame-kit` のみ、APPDATA 非対応)、`docs/platform-roadmap.md`(Windows 言及ゼロ)、secure-fs の mode degrade 自認。
- **現状と問題**: 秘密鍵入りファイルが Windows では `%USERPROFILE%\.config` に 0600 無しで置かれる。サポート外なら明示が無く issue コストになる。
- **修正手順**: まず方針決定。**推奨: 当面サポート外を明示**(platform-roadmap.md と README に記載 + win32 起動時に警告)。サポートする判断なら paths.js の APPDATA 分岐 + Windows ACL 対応をロードマップ化(重い)。
- **テスト**: configPaths テストに platform 分岐テーブル(方針に応じて)。
- **受け入れ基準**: Windows の扱いがコードと文書で一致。

#### P5-8. 本ラウンドの公開面変更を CONTRACT_VERSION 1.4.0 に連動〔規範7 のゲート項目〕

- **対象**: `packages/core/src/jsonrpc.js` の CONTRACT_VERSION / KNOWN_FINGERPRINTS、`packages/kit/src/serve/` の生成物一式、docs の数値 claim。
- **内容**: P3-2(鍵ストア REST の RPC 公開)・P3-6(friend QR)・P3-8(reqContext 戻り値)・P4-2(isStop nullable 化)など公開面が変わる項目を**一括で 1.4.0 へ bump** し、changelog コメント・集合ハッシュテスト・`npm run build` 再生成・docs(P6-4)を同一マイルストーンで更新する。面が変わらない修正(P1-3 の presence 化はメソッド集合不変)は bump 対象外であることをハッシュテストで確認。
- **受け入れ基準**: メソッド集合/シグネチャ変更と version が機械的に連動(規範7)。

---

## Phase 6 — ドキュメント正直化

> 規範(v2 P6 から継続): docs はコード例・コマンド・数値を実測で裏取りしてから書く。自リポ file:line は書かない(シンボル/パスのみ)。

#### P6-1. docs/ のライブラリ import 例が全滅(旧 `"sesame-kit"` のまま)〔R3:DOC-01 / High〕

- **対象**: `docs/en|ja/library.md`(import 例が主役の文書 — 12 箇所超)、`docs/en|ja/ble.md`(`sesame-kit/access`・`sesame-kit/ble` 等 9 箇所超)、`docs/en|ja/commands.md` の各 1 箇所。
- **現状と問題(統括再検証済み)**: `import { SesameHub3 } from "sesame-kit"` は `ERR_PACKAGE_PATH_NOT_EXPORTED` で**全例が即死**(kit の exports は `./client` のみ)。README は `@sesame-kit/core` へ更新済みなのに docs/ が一切追従していない。
- **修正手順**: `"sesame-kit"` → `"@sesame-kit/core"`、`"sesame-kit/<sub>"` → `"@sesame-kit/core/<sub>"` へ一括置換(**`sesame-kit/client` のみ現状維持が正**)。置換後、全コード例を node で import 検証(P6 共通の例検証スクリプト化を推奨)。
- **受け入れ基準**: docs の全 import 例がコピペで動く。

#### P6-2. 削除済み API `wifi.networkStatus()` を ble.md がコード例として掲載〔R3:DOC-03 / High〕

- **対象**: `docs/en|ja/ble.md` の WM2 節のコード例 1 行。
- **現状と問題**: `wm2.js` に「networkStatus() / networkStatusData() / RPC op は**削除済み**(発明 op の捏造禁止・規範2。SDK に送信経路無し: CHWifiModule2Device.kt:502-510 は受信専用)」と明記済みなのに、docs が削除済みメソッドの呼び出し例を残している。コピペで TypeError。
- **修正手順**: 呼び出し行を削除し「networkStatus は受信専用(onPublish の kind で届く)」へ書き換え(直前の kind 列挙は正なので維持)。
- **受け入れ基準**: docs に存在しない API の例が無い。

#### P6-3. workspace 分割後の構成 stale 一括是正(architecture / integration / リンク切れ / 旧 src パス)〔R3:DOC-05+06+07+10 / Medium〕

- **対象と内容**:
  1. `docs/en|ja/architecture.md` — レイアウト図・「serve コア」節が分割前構成(`src/serve/jsonrpc.js` は**どこにも存在しない** — core 直下へ移動済み)。2 パッケージ構成へ全面書き換え + prepack 虚偽記述の削除(P2-2 と同期)。
  2. `docs/en|ja/integration.md` — protoc コマンドのパス(正: `packages/kit/src/serve/sesame.proto`)と `pip install ./packages/kit/clients/python`。
  3. 相対リンク切れ 10 件 — `sdk/ts/README.md` / `sdk/python/README.md`(`../../clients/...` → 正パス)、`packages/kit/clients/js|python/README.md`(`../../` 起点のズレ 8 件)。P2-5 で sdk/ を移設する場合は移設後パスで張ること。
  4. 旧 `src/`・`tests/` パス表記 — `docs/api-stability.md`(特に `src/serve/jsonrpc.js` は移動先名も変わる)、`docs/platform-roadmap.md`(7 箇所)、`REFERENCES.md`(冒頭の「`src/` mirrors…」含む 5 箇所)、`docs/en|ja/ble.md` の `src/itemcodes.js`、sdk README のテストパス。
- **修正手順**: 一括置換 + リンクチェッカ(監査で使用したものを scripts 化して CI に追加するのが恒久対策)。
- **受け入れ基準**: 全ドキュメントのパス/リンクが現構成で解決する。リンク検査が CI にある。

#### P6-4. 契約・数値表記の整合(contract 1.2.0→1.3.0 ほか)〔R3:DOC-08(=SURF-03)+09+16+19+20+SURF-04 / Medium〕

- **対象と内容**:
  1. 「202 methods as of contract **1.2.0**」→ 1.3.0(README 両言語 / api-stability.md 2 箇所 / platform-roadmap.md。202 は 1.3.0 で初めて成立する数 — 1.2.0 への帰属自体が誤り)。P5-8 実施後は 1.4.0 で再同期。
  2. 「76 typed BLE + 別枠 generic invoke」の自己矛盾 → 「74 typed + 2 generic = 76」へ統一(README / api-stability / platform-roadmap)。
  3. 互換性判定の案内が deprecated 別名(`contractVersion` / `x-contractVersion`)のみ → canonical の `apiVersion` / `x-apiVersion` を主、旧名併記へ(README / integration.md)。
  4. api-stability.md の `status` 結果説明に `contractVersion` フィールドが漏れ → 追記(deprecated 注記付き)。
  5. sdk/ts・sdk/python README の「stable: `lock.*`」過大表記 → 「`lock.*`(`setAutolock` を除く)」。
  6. integration.md の `org.getEmployees companyID` 必須表示 → 実 schema は全 optional のため `[companyID]` へ。
- **修正手順**: 実測値(schema/openrpc.json と stability.js)を正として一括修正。version 文字列の grep ベース doc-lint を check スクリプトに追加すると再発を塞げる。
- **受け入れ基準**: docs の数値・契約表記が全て実測と一致。

#### P6-5. README の OS2 履歴ドレイン節が実在しない CLI `sesame <device> history` を案内〔R3:DOC-04 / Medium〕

- **対象**: README.md / README.ja.md の Known limitations(OS2 自動履歴)節。
- **現状と問題**: デバイス主語 action は lock/unlock/toggle/click/autolock/status のみ。BLE 実機履歴の CLI 経路は `sesame ble invoke <device> history` / `ble os2-invoke <device> history`。
- **修正手順**: 実在コマンドへ書き換え。
- **受け入れ基準**: README のコマンド例が全て実在する。

#### P6-6. ble.md「専用 CLI が無い BLE 操作は enrollment と Bike3 指紋のみ」が過小列挙〔R3:DOC-12 / Low〕

- **対象**: `docs/en|ja/ble.md` の該当 1 文。
- **現状と問題**: magnet / opSensorControl / setBleTxPower / sendAdvProductType / 実機履歴 read・delete / WM2・Hub3 の insertSesames・removeSesame 等も `ble invoke` 経由のみで、「のみ」が成立しない。
- **修正手順**: 「主な例として〜」へ弱めるか列挙を補完(実装一覧から機械生成が確実)。
- **受け入れ基準**: 列挙が実装と一致。

#### P6-7. LICENSE 本文が docs で撤回済みの旧主張(client ID swapped)を保持〔R3:DOC-13 / Low〕

- **対象**: `LICENSE` の冒頭段落(「Cognito client ID を biz3 から差し替えた」)。
- **現状と問題**: architecture.md は「現行 biz3 も同一 Consumer Client であり機能的相違ではない」と訂正済み(references_web/src/aws-exports.js:5 で確認可能)。LICENSE だけが旧主張のまま。
- **修正手順**: 当該段落を「port of biz3 (MIT); see LICENSE.biz3」へ簡素化。
- **受け入れ基準**: LICENSE と docs の主張が一致。

#### P6-8. promo/zenn-article.md の陳腐化(「OS2 未実装」「ペアリング不可」「Node 18+」)〔R3:DOC-15 / Medium〕

- **対象**: `promo/zenn-article.md`(壊れた import 例 / OS2 BLE 未実装記述 / 新規ペアリング非対応記述 / Node 18+)。
- **現状と問題**: OS2 BLE・BLE register はいずれも実装済み、Node 要件は 20+。同じ promo/ の show-hn.md は更新済みで矛盾。**実装済み機能を「無い」と公言する公開予定文面**(ユーザー関心事の「諦め記述」型)。
- **修正手順**: README 現行版へ同期(import 例は `@sesame-kit/core`)。公開前チェックリストに promo の整合確認を追加。
- **受け入れ基準**: 公開文面に実装と矛盾する記述が無い。

#### P6-9. provenance 語彙の例示が実装語彙と不一致〔R3:DOC-17 / Low〕

- **対象**: `docs/api-stability.md` / `docs/platform-roadmap.md` の x-provenance 説明(`verified-live` 等の願望形のみ)。
- **現状と問題**: 実装語彙は `"local"` / `"app-core"` / `"unverified"`(stability.js と schema 実測)。読者が schema の実値と照合できない。
- **修正手順**: 実装語彙を正として記載し、旧例示は設計経緯と明示。
- **受け入れ基準**: 文書語彙 = 実装語彙。

#### P6-10. commands.md に `remote sync-from-server` が未掲載〔R3:DOC-18 / Low〕

- **対象**: `docs/en|ja/commands.md` の remote/Hub3 節。
- **修正手順**: 実在コマンド `remote sync-from-server <hub3> <irType>` を 1 行追加。
- **受け入れ基準**: コマンド表と実装の双方向一致(監査で他の乖離が無いことは確認済み)。

#### P6-11. OS3 ロックの自動履歴ドレイン非実装の注記が OS2 限定〔R3:BLE3-02 / Low〕

- **対象**: README Known limitations(OS2 のみ言及)、`packages/core/src/ble/session.js` 冒頭 JSDoc。
- **参照**: `CHSesameOS3LockBase.kt:42-58, 185-209`(広告 adv_tag_b1 をトリガに login 済みなら自動 readHistory → サーバ POST 成功時に 1 件削除のドレインループ)。
- **現状と問題**: OS2 の同種逸脱は v2 P3-26 で明文化済みだが、OS3 側(トリガが広告で別物)の注記が無く「移植漏れ」と誤読され得る。サーバ POST 部分は §10-6 と整合する意図的非実装。
- **修正手順**: README の同項に OS3 も同様である旨(出典付き)を追記。session.js JSDoc に 1 行注記。
- **受け入れ基準**: 意図的逸脱の文書カバレッジが OS2/OS3 で対称。

---

## 7. 領域別所見インデックス(原典 ID → 計画項目)

| 原典所見 | 計画項目 | | 原典所見 | 計画項目 |
|---|---|---|---|---|
| R3:BUG-01 | P1-1 | | R3:AUTH-01 | P3-10 |
| R3:BUG-02 | P1-2 | | R3:AUTH-02 | P3-11 |
| R3:SURF-01 / SURF-05 | P1-3 | | R3:AUTH-03 | P3-12 |
| R3:SURF-02 | P1-4 | | R3:AUTH-04 | P3-13 |
| R3:CLOUD-P-01 | P1-5 | | R3:AUTH-05 | P3-14 |
| R3:ARCH-01 | P2-1 | | R3:AUTH-06 | P3-15 |
| R3:ARCH-02 / DOC-11 | P2-2 | | R3:AUTH-07 | P3-16 |
| R3:DOC-14 | P2-3 | | R3:AUTH-09 | P3-17 |
| R3:ARCH-08 | P2-4 | | R3:AUTH-08 / AUTH-10 | P3-18 |
| R3:ARCH-09 | P2-5 | | R3:BLE3-01 | P4-1 |
| R3:ARCH-03 | P2-6 | | R3:BLEP-01 | P4-2 |
| R3:DOC-02 | P2-7 | | R3:BLEP-02 | P4-3 |
| R3:CLOUD-P-02 | P3-1 | | R3:BLEP-05 | P4-4 |
| R3:CLOUD-P-03 | P3-2 | | R3:BLE3-03 | P4-5 |
| R3:CLOUD-P-04 | P3-3 | | R3:BLEP-03 | P4-6 |
| R3:CLOUD-P-05 | P3-4 | | R3:BLEP-04 | P4-7 |
| R3:CLOUD-P-06 | P3-5 | | R3:ARCH-04 | P5-1 |
| R3:BIZ-01 | P3-6 | | R3:ARCH-05 | P5-2 |
| R3:BIZ-02 | P3-7 | | R3:ARCH-06 | P5-3 |
| R3:BIZ-03 | P3-8 | | R3:ARCH-07 | P5-4 |
| R3:BIZ-04 | P3-9 | | R3:ARCH-10 | P5-5 |
| R3:DOC-01 | P6-1 | | R3:ARCH-11 | P5-6 |
| R3:DOC-03 | P6-2 | | R3:ARCH-12 | P5-7 |
| R3:DOC-05/06/07/10 | P6-3 | | (規範7 ゲート) | P5-8 |
| R3:DOC-08(=SURF-03)/09/16/19/20, SURF-04 | P6-4 | | R3:DOC-04 | P6-5 |
| R3:DOC-12 | P6-6 | | R3:DOC-13 | P6-7 |
| R3:DOC-15 | P6-8 | | R3:DOC-17 | P6-9 |
| R3:DOC-18 | P6-10 | | R3:BLE3-02 | P6-11 |

## 8. 重大度集計

> 重大度は統括再検証後の確定値。Critical/High(計 10)は全件、統括が一次資料・実挙動で裏取り済み。

| 重大度 | 件数 | 項目 |
|---|---|---|
| Critical | 3 | P1-1(BLE 失敗経路でプロセス死)、P2-1(core 単体 install 不能)、P2-2(publish 必敗) |
| High | 7 | P1-2、P1-3(stable lock.click 誤動作)、P1-4(import 副作用で実クラウド)、P1-5(del ワイヤ不一致)、P2-7、P6-1、P6-2 |
| Medium | 17 | P2-3, P2-6, P3-1, P3-2, P3-6, P3-10, P3-11, P3-13, P3-15, P4-1, P4-2, P5-1, P5-2, P6-3, P6-4, P6-5, P6-8 |
| Low | 28 | P2-4, P2-5, P3-3〜P3-5, P3-7〜P3-9, P3-12, P3-14, P3-16〜P3-18, P4-3〜P4-7, P5-3〜P5-7, P6-6, P6-7, P6-9〜P6-11 |
| (ゲート) | 1 | P5-8(CONTRACT_VERSION 連動) |

合計 **56 計画項目**(Phase 1: 5 / Phase 2: 7 / Phase 3: 18 / Phase 4: 7 / Phase 5: 8 / Phase 6: 11)。原典所見 67 件(9 監査領域)を §0.3 と §7 で統合した。

---

## 9. 実機検証バックログ(コード修正後に必要なキャプチャ)

> v1/v2 から繰越(V1〜V14、内容は v2 §9 を git 履歴 `4860ed3` で参照 — OS2 実機 / WM2 / Bot2 / OS3 register / biometrics REST / Hub3 networkType / IR 実応答 / getCards 順序 / battery success / getRegisterKey / OS2 広告実値 / 生体 NOTIFY 端数 / アプリ形 InitiateAuth / pubUserDeviceChange)。今回 V15〜V19 を追加。該当 API は `@experimental` + 未検証マーカーを維持し、検証完了ごとに撤去する。

| # | 対象 | 検証内容 | 関連 |
|---|---|---|---|
| V15 | biz3 `del` | subUUID 同送(P1-5 修正後)のサーバ側挙動 — ユーザー鍵の同時削除/履歴記録に使われるか | R3:CLOUD-P-01 |
| V16 | webapi 系 3 op | `body:{}` 常時送信(P3-1 修正後)を中継 Lambda が受理するか | R3:CLOUD-P-02 |
| V17 | 生体タップ登録 | ファーム採番 nameUUID が UUIDv4 形式か(P3-9 の composite 発動条件) | R3:BIZ-04 |
| V18 | guest/期限付き鍵 | secretKey に "000000" sentinel が実在するか・自動 server-auth 切替(P4-1)の実機確認 | R3:BLE3-01 |
| V19 | 実 Cognito pool | InitiateAuth 応答 `ChallengeParameters.USERNAME` が email か内部 UUID か(P3-10。V13 と同時に確認可) | R3:AUTH-01 |

---

## 10. 見送り・非実装が正と確定した事項

v2 §10 の 1〜10 を継承(autolock クラウド設定 / schedule 作成系 op / Stripe confirm / TS 全面移行 / i18n 再設計 / アプリ専用テレメトリ REST / AWS IoT MQTT-WSS shadow / palmChange 送信 / OS2 register REST / updateBotScript)。今回の監査で追加確定:

11. **thin client(手書き最小 + 汎用 call)と生成 SDK(全 202 メソッド型付き)の二層構成** — 意図した設計で、双方にドリフトゲートあり。統合しないことが正(R3 SURF 監査で経路マトリクス全数照合済み)。
12. **`triggerLockRaw` / `getAllDeviceHistory` / `iot.subscribeIotResponse` 等の RPC 非公開** — raw cmd の安全性・lastKey ページングでの等価性・(params) 1 引数規約により、非公開が設計判断として正。
13. **devicePassword の randomBytes(40) base64 方式(JS SDK 形)維持** — Android 参照は UUID 36 文字だがワイヤ・サーバ不可視で、エントロピーは kit が上位互換。変更不要、P3-18 で逸脱注記のみ。
14. **巨大ファイル(client.js / ble/biometric.js 等 800 行超 8 本)の機械分割見送り** — 参照 1:1 ポートの忠実性を優先する v2 方針を継続(serve registry の分割は v2 で完了済み)。
15. **core の debug ゲート付き console.error** — ライブラリ純度違反ではない(無条件出力ではない)と確認。維持が正。

---

## 11. 推奨実施順序

```
Step 1 (最優先・並行可):
        ├ P1-1 → P1-2(同じ BLE セッション群。失敗 transport テストヘルパを共有)
        ├ P1-3(gRPC presence。独立)
        ├ P1-4(canary main ガード。即時・5 分で終わる)
        └ P1-5(del subUUID。独立)
Step 2 : Phase 2 を一括(P2-1 → P2-2 → P2-3/P2-4/P2-6 → P2-5 → P2-7)。
        完了判定 = 「タグ push で 2 パッケージが publish され、隔離 install スモークが CI で緑」。
        ここまでが 0.6.x リリースのブロッカー。
Step 3 : Phase 3(3A クラウドと 3B 認証は並行可。P3-13 は参照追補(ClientConfiguration)が前提)
Step 4 : Phase 4(P4-2 と P4-6 は同一 PR。P4-1 は §9 V18 を併記)
Step 5 : Phase 5(P5-1 → P5-2 の順。P5-8 は Phase 3/4 の面変更が出揃った後に一括 bump)
随時   : Phase 6(P6-1/P6-2 は Step 1 と同時に即時実施可。P6-3/P6-4 は P2-5/P5-8 の結果を反映して最終一括)
```

**マイルストーン M1(Phase 1 完了)**: 失敗経路で unhandledRejection が 0 件になり、型付き gRPC が JSON-RPC と同一挙動になる。
**マイルストーン M2(Phase 2 完了)**: `npm install @sesame-kit/core` / `npm i -g sesame-kit` がそのまま動く。**workspace 分割が「配布できる」状態で完成**。
**マイルストーン M3(Phase 3〜6 完了)**: 参照忠実性の既知差分が「§9 実機待ち」と「§10 確定見送り」だけになり、docs が全例コピペ可能な v1.0 候補。

---

> **検証規律(再掲)**: 本書の Critical/High は統括者が参照一次資料・実挙動で再検証済み。Medium/Low は各監査エージェントの報告に基づくが、着手時に必ず参照 file:line を自分で開いて裏取りすること(README・docs・コード内コメントは根拠にしない)。「1:1 宣言」には全件照合テストを併設し(規範8)、依存・exports・files を触る変更は隔離 install スモークで検証する(規範10)。

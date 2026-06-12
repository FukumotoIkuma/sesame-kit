# sesame-kit フルリファクタリング計画書 v2(第2回監査)

作成日: 2026-06-12 / 監査方法: 参照実装(`_sesame_sdk_ref` = Android SesameSDK Kotlin, `references_web` = biz3 web React, `/tmp/aws-sdk-android` = AWSMobileClient 2.77.0)との全面突き合わせ第2回。9 領域(認証 / 個人クラウド / Biz3 / BLE-OS3 コア / BLE-OS2 / BLE 周辺デバイス / 公開経路対称性 / アーキテクチャ / ドキュメント)を並列監査し、約 80 件の所見を統合した。Critical 2 件・High 9 件を含む全 Critical/High は統括者が一次資料で再検証済み。

> **v1 との関係**: 第1回計画書(2026-06-11 作成)は Phase 1〜6 + 追加バックログ 9 件まで**全て実装完了**し、本書で置き換えた。v1 の本文はコミット `6c939dd` 時点の `REFACTORING_PLAN.md` を参照。**本書の所見 ID(`R2:AUTH-01` 等)と項目番号(P1-1 等)は v1 と独立**であり、同名でも別物。v1 からの繰越は §9(実機検証 V1〜V10)と §10(見送り確定事項)、および P5-14(workspace 分割)のみ。

## 実施状況(2026-06-12 更新)

- **Phase 1(P1-1〜P1-8)実施済み**(Phase 1 コミット参照)。実装はワークフロー上の軽量エージェント、監査(参照突き合わせ・全ゲート)は統括が実施。
  - 付記: P1-4 で `devices.subscribeDevicesUpdate` の戻り値が `() => void` → `{unsubscribe, sendFrame}` に変更(ライブラリ公開面・experimental)。P1-7/P1-8 で RPC メソッド集合が変化(ble.scan 追加 = 199 メソッド、生体一覧 5 op の結果形が ack → records)。**いずれも P4-1 の CONTRACT_VERSION bump / changelog に記載すること**。
- **Phase 2(P2-1〜P2-10)実施済み**(Phase 2 コミット参照)。`_aws_sdk_ref/`(AWSMobileClient 2.77.0)を in-repo 化し `npm run check:refs` で健全性検査を導入。P2-2 で InitiateAuth がアプリ形(SRP_A 付き)になり PASSWORD_VERIFIER ハンドラを実装(@experimental・§9 V13 実機検証待ち)。P2-3 でトークン失効時の後始末を device 温存に変更。
  - **申し送り(P5 重複統合候補)**: P2-2 の user SRP(`auth.js` の `respondToPasswordVerifier`)は Java の `BigInteger.toByteArray()` バイナリ連結方式で独立実装した。既存の device SRP(`device-srp.js` の padHex/hexHash 方式)と数式は同型(poolName/username 差のみ)なので、本来 1 実装に統合できる。実機検証(V13)で両者の正しさが確認できたら統合を検討する(現状は二重実装の技術的負債として記録)。
- **Phase 3(P3-1〜P3-27)実施済み**(Phase 3 コミット参照)。クラウド/Biz3 のレスポンスパース忠実化、出典なしフォールバック撤去、BLE の timePhone 3 経路・mechStatus kind ディスパッチ・itemcode 182 補完(規範8 の全件照合テスト新設)・RESULT[9] 隔離・発明 op(WM2 networkStatus)削除。統括が `networkStatusData` デッドコードと index.js re-export も後始末。
  - **Phase 6 へ繰越(P3-26)**: README の Known limitations に「SDK の OS2 自動履歴読み出し(`CHSesame2Device.kt:543-553`)は kit では手動 `history()`」の逸脱注記を追記する(session.js JSDoc は実装済み。README 編集は Phase 6 に集約)。
- **Phase 4(P4-1〜P4-13)実施済み**(Phase 4 コミット参照)。CONTRACT_VERSION を 1.3.0 に bump(202 メソッド、stable 13 のシグネチャ不変・後方互換)し「メソッド集合ハッシュ ↔ version」連動テストで規範7 を機械強制。生体 REST 4op の CLI 公開、OS2 管理系 typed RPC(reset/configureLockPosition)、syncRemotesFromServer の RPC/CLI 対称化、BLE allowlist 逆方向テスト、status schema nullable 化、exit code 統一(bad_params→2)、thin client 表面統一、gRPC stability コメント、lock raw 非公開の明文化。
  - **統括修正(統合バグ)**: P4-10 の hub3DeviceId alias が presetir.js の JSDoc 型と registry.js パッチで**二重登録**され、生成 proto に `hub3DeviceId` が 2 回出て e2e 13 件が落ちた。registry パッチを削除し JSDoc 型方式に一本化(NAMESPACE_OPS 自動公開の単一経路)、未使用 i18n キーも除去。**教訓**: NAMESPACE_OPS 系の param 追加は JSDoc 型のみで足りる(registry パッチ併用は二重化)。レーンエージェントは build 後生成物を見ないため、この種の生成バグは統括の全量 build+test でのみ検出できる。
- **Phase 5(P5-1〜P5-13)実施済み**(Phase 5 コミット参照。P5-14 workspace 分割は次 major 据え置き)。エラー設計の乖離是正(serve 到達面の plain Error→typed SesameError、テーブル駆動回帰テスト)、registry.js 808 行モノリスを `src/serve/entries/*.js` 7 ファイルへ機械分割(挙動不変)、CLI→serve 結合を `src/ble/rpc-helpers.js` 葉モジュールへ細線化、UUID 正規化 14+3 箇所を crypto.js に統合、JWT claim 4 重実装統合、secure-fs stale lock を rename ベースで競合窓除去、i18n 完全性テスト、CI に SDK コンパイル検査、未使用 export 整理。
  - **統括修正**: P5-11 が tests/ を lint 対象化した結果、Phase 1〜5 で追加したテストの軽微な lint 違反(未使用 import/var 3 件・不要 biome-ignore)が露呈。実ゴミは削除し、テスト特有の正当パターン(リテラルキー・動的 namespace アクセス)は biome.jsonc の tests override で off にして完成させた(lint 0 warning/info)。
  - **申し送り(後方互換)**: P5-8 で偶発公開していた内部 API(`deriveIrOperation`/`PRODUCT_TYPE`/`AWS_REGION` 等)を d.ts から除去した。これらは本来非公開(experimental 相当)だが、外部利用者がいた場合は破壊的。次 major のリリースノートに記載すること。
- **Phase 6(P6-1〜P6-9 + P3-26 繰越)実施済み**(Phase 6 コミット参照)。**v2 全 Phase 完了**。動かないコード例(rpc lock.click)の修正、ble.md の虚偽「専用 CLI 無し」訂正、メソッド数 stale(135→実測 202)・thin client トランスポート虚偽・overrides 記述の是正、commands.md 欠落コマンド追記、自リポ内 file:line 引用のシンボル名化と vendor 引用の行ズレ修正。
  - **実測訂正**: 計画書の概算(ble.* 74 ops / config.* 4 ops)に対し docs は実測値(ble.* 76 ops / config.* 6 ops / 全 202 メソッド)を採用。計画書の概算値は指示時点のもので、docs が実装と一致すれば正(計画書側の数値は更新しない)。
- v1 からの繰越: §9 実機検証バックログ V1〜V10(未実施・該当 API は `@experimental` 維持)、workspace 分割(次 major、P5-14)。

**この文書の読み方**: 各項目は「初見の実装者が単独で着手できる」粒度で、対象 file:line・参照 file:line・修正手順・テスト・受け入れ基準を持つ。`R2:XXX-NN` は今回監査の所見 ID(複数監査が同一問題を検出した場合は §0.3 で統合済み)。**README・docs・コード内コメントの記述は本計画の根拠にしていない**。すべて参照実装の実コードで裏取りしてある。行番号は 2026-06-12 時点の HEAD(`6c939dd`)と参照 checkout に対するもの。

---

## 0. 前提

### 0.1 規範(v1 から継承し、今回の教訓 6〜9 を追補)

1. **絶対制約**: ログイン/トークン管理は Android アプリ(AWSMobileClient 2.77.0 + CUSTOM_AUTH + device SRP + ConfirmDevice)のトレースとする。web (`useAuthState.js`) の方式は使用禁止。auth を web に寄せる「修正」はそれ自体が regression。
2. **1:1 ポート規範**: クラウド/BLE のワイヤ形状は参照の byte/フィールド単位で一致させる。フォールバック連鎖 `a || b || c`・握りつぶし catch・出典なし防御は「未検証ポートの臭い」であり、参照をトレースして解消する。意図的に参照から逸脱する場合は、逸脱内容と理由をコードコメントに明記する。
3. **モックは参照から作る**: モックデバイス/モックサーバの応答バイト列・フレームは、必ず Kotlin/web の**送信側コード**から導出し、導出元 file:line をモック定義の隣に記載する。**エンディアンも導出対象**(今回 R2:BLE2-12 で BE/LE 取り違えモックが再発)。
4. **経路対称性チェックリスト**: ライブラリに公開機能を追加・変更したら、同一 PR 内で次を更新する — ① `SesameClient`/`SesameBle` メソッド ② CLI コマンド ③ `serve/registry.js` ④ `npm run build`(openrpc/proto/SDK 再生成)⑤ docs/en・docs/ja ⑥ テスト。
5. **実機未検証マーカー**: 実機キャプチャ未照合の経路は JSDoc に `@experimental` + 「実機未検証 (参照: <file:line>)」を付け、§9 に登録する。
6. **自リポジトリ内の file:line 引用禁止**(新規): 自分のコード位置への引用はリファクタの度に腐る(今回 5 ファイルで実測)。自己参照は**シンボル名**(`transport.js request() の FIFO 相関` 等)で書く。file:line 引用は不変スナップショットである参照リポジトリ(`_sesame_sdk_ref` / `references_web` / `_aws_sdk_ref`)に限る。
7. **RPC メソッド集合と CONTRACT_VERSION の連動**(新規): 公開メソッド集合・イベント topic・stable シグネチャの変更は同一 PR で `CONTRACT_VERSION` を bump する。P4-1 で「集合ハッシュ ↔ バージョン」の固定テストを導入し、機械的に強制する。
8. **「1:1 宣言」には全件照合テストを義務化**(新規): 「enum と 1:1」「全 op 移植済み」を宣言する定数表には、参照側の全メンバとキー集合一致を検査するテストを併設する(宣言だけの 1:1 は今回 2 件で破れていた: R2:BLE3-06, R2:BLEP-14)。
9. **参照は in-repo に置く**(新規): `/tmp` 等の揮発領域に置いた一次資料は消える・壊れる(今回 AuthenticationHelper.java が 404 プレースホルダ化していた)。一次資料はリポジトリ直下の gitignored ディレクトリに置き、取得時に中身の妥当性(非空・期待シンボルの存在)を確認する(P2-1)。

### 0.2 ベースライン(2026-06-12 監査時点)

`npm run typecheck` / `npm run lint` / `npm test`(unit 1571 + e2e 319)全緑、`npm run build` 再生成ドリフトなし、`npm audit` 0 件。**つまり表面的な壊れは無く、本書の所見はすべて「テストが検出できない種類の問題」**(参照との不一致・実機でしか踏まない経路・経路欠落・ドキュメント虚偽)である。Phase 1 の各修正は「なぜ既存テストが検出できなかったか」を必ず確認し、検出できるテストを同梱すること。

### 0.3 重複所見の統合表

| 統合先 | 原典所見(R2) |
|---|---|
| P1-5 (listDevices errorAction) | CLOUD-02 = BIZ-03 |
| P1-3 (OS2 CLI BLE 経路) | DOC-06(実装側の帰結) |
| P1-8 (生体一覧 RPC の実データ化) | SURF-26 + SURF-39(生体収集ヘルパ共有部) |
| P3-17 (itemcodes 182 欠落) | BLE3-06 = CLOUD-05 |
| P4-1 (CONTRACT_VERSION) | SURF-27 = DOC-04 |
| P5-3 (CLI→serve 結合) | ARCH-04 + SURF-39(WiFi 収集ヘルパ移設部) |
| P6-7 (引用整備) | BLE3-11 = ARCH-09 = CLOUD-07 = BLEP-16 = DOC-10 + AUTH-07(コメント部) |

### 0.4 フェーズ構成と依存

| Phase | 内容 | 規模 | 依存 |
|---|---|---|---|
| 1 | 実機・実害の確定バグ(Critical/High) | M | なし(最優先) |
| 2 | 認証のアプリ忠実化・残件(絶対制約領域) | M | P2-1(参照ベンダリング)が他 P2 の前提 |
| 3 | クラウド/BLE 忠実性の抜け漏れ補完 | L | 1 完了後推奨(3A/3B は並行可) |
| 4 | 経路対称性・契約 | M | P4-1 は Phase 1 の面変更(P1-7/P1-8)と P3-27/P4-5 の後 |
| 5 | アーキテクチャ刷新・衛生 | M | 1-4 と並行可(P5-1 は serve 到達面を触るため P4 と調整) |
| 6 | ドキュメント正直化・参照基盤 | S | 各 Phase に随伴 + 最終一括 |

---

## Phase 1 — 実機・実害の確定バグ

> 全項目、統括者が参照一次資料で再検証済みの確定バグ。1 所見 = 1 PR、モック/テストの修正を必ず同梱。

#### P1-1. OS2 機種の deviceID 導出(deviceName base64)を実装 — 現状 OS2 実機は発見・接続とも不能〔R2:BLE2-10 / Critical〕

- **対象**: `src/ble/transport.js:149-195`(`parseAdvertisement` — WM2/Hub3/SS5 の 3 レイアウトのみで、OS2 機種は SS5 形の else に落ちる)、`src/ble/transport.js:748-759`(`_scanForDevice` — `advUuid != null` を SESAME 判定に使い address 照合より先に弾く)、波及: `peripheralToDiscovery`(deviceUUID=null を列挙除外)、`src/cli/ble.js` の `os2-register`/`os2-invoke`、`src/serve/registry.js` の `ble.os2.*`。
- **参照**: `_sesame_sdk_ref/sesame-sdk/.../ble/Sesame2BleAdvertisement.kt:68-74` — `CHProductModel.SS2, SS4, SesameBot1, BiKeLock -> (deviceName + "==").base64decodeHex().noHashtoUUID()`(catch → null)。OS2 の deviceID は **manufacturerData ではなく BLE deviceName(base64 22 文字 + "==")から導出**する。OS2 の manufacturerData は短く 16B UUID を含まない。
- **問題**: kit は OS2 機種(productType 0/2/3/4)を SS5 用 else 分岐(`advBytes[3..19)` 必須)に落とすため deviceUUID が常に null になり、①一覧に出ない ②UUID 照合が永遠に不一致 ③さらに `_scanForDevice` の `isSesame = advUuid != null` ゲートにより `--address` 指定でも照合対象にならない。**v1 Phase 1 で直した OS2 ワイヤ層(P1-1〜P1-5)に実機で到達する手段が無い**。テストは transport 注入モックのため未検出だった。
- **修正手順**:
  1. `src/ble/transport.js` に `os2NameToUuid(localName)` を実装: `Buffer.from(localName + "==", "base64")` → 長さ 16B でなければ null(Kotlin の catch→null の写像)→ hex 32 文字 → `hexToUuid()`。導出元 `Sesame2BleAdvertisement.kt:68-74` / `DataExtention.kt:41-46`(noHashtoUUID)をコメントに記載。
  2. `parseAdvertisement(md)` に第 2 引数 `localName` を追加(後方互換: 省略可)。kind が OS2 系(`PRODUCT_TYPES[productType]` の os==2 / SESAME2・BOT_OS2・BIKE_OS2)のとき manufacturerData からの UUID 抽出をやめ `os2NameToUuid(localName)` を使う。`advToDeviceUUID` も同様に localName を受ける。
  3. 呼び出し元(`peripheralToDiscovery`, `scanSesames`, `_scanForDevice`)で `peripheral.advertisement.localName` を渡す。
  4. `_scanForDevice` の照合を修正: SESAME 判定は「company ID 一致(parseAdvertisement が非 null)」へ変更し、`address` 指定時は `advUuid == null` でも `peripheral.address` 照合を許可する(現行ゲートは参照に出典の無い防御)。
- **テスト**: `tests/ble/discovery.test.js` に OS2 ケースを追加 — md = `5a05` + `[productType, xx, registeredビット]`(SS2=0/Bot1=2/Bike1=3/SS4=4)+ localName = 16B UUID の base64(22 文字) → deviceUUID 導出を検証。localName 不正(decode≠16B)→ null。`--address` 照合のケース。
- **受け入れ基準**: OS2 4 機種が `ble scan` 相当(listNearbyDevices)で deviceUUID 付きで列挙され、UUID/address どちらの指定でも `_scanForDevice` が一致する。既存 OS3 系テスト緑維持。

#### P1-2. biometric の CARD/PASSCODE_NOTIFY が不正 payload で無限ループ → OOM でプロセス死〔R2:BLEP-13 / Critical〕

- **対象**: `src/ble/biometric.js:704-714`(CARD_NOTIFY ループ)、`:757-766`(PASSCODE_NOTIFY ループ)、根本は `parseTouchCard`(`:138-150`)。
- **参照**: `CHCardEventHandlers.kt:22-34` / `CHPassCodeEventHandlers.kt:22-34`(do-while で recordSize ずつ前進)、`CHSesameBiometricParseData.kt:10-17`(`CHSesameTouchCard` は `data[1]` 参照で短小入力なら **ArrayIndexOutOfBoundsException** → ループ脱出)。
- **問題**: `rest` が 2B 未満、または `idLength` 過大で `nameIndex` が範囲外のとき、`buf[i]` が undefined になり `recordSize = 1+1+undefined+1+undefined = NaN`。break 条件 `recordSize <= 0 || recordSize > rest.length` は **NaN でどちらも false**、`rest.subarray(NaN)` は `subarray(0)` と同じで前進せず**無限ループ**(ヒープ枯渇で `FATAL ERROR: ... heap out of memory` を実証済み)。Kotlin は例外で脱出するが、JS ポートは throw を NaN に変えてガードを無効化した。NOTIFY 末尾に端数バイトが付くだけで発火する現実的経路。
- **修正手順**:
  1. `parseTouchCard` 冒頭に範囲検証を追加し、Kotlin の AIOOBE を写して **throw** する: `if (buf.length < 2 || idLength + 2 >= buf.length || nameIndex + 1 + nameLength > buf.length) throw new Error(...)`(導出元: CHSesameBiometricParseData.kt:10-17 の `data[1]` 直アクセス)。
  2. CARD_NOTIFY / PASSCODE_NOTIFY のループを `try { ... } catch { break; }` で囲む(SDK の例外脱出と同義)。`parseTouchFace` 側にも同型の範囲検証が必要か確認し、必要なら同時に。
  3. CARD_CHANGE / PASSCODE_CHANGE 等、`parseTouchCard` の他の呼び出し元の throw 伝播経路を確認(publish ハンドラ内で落ちてセッションを壊さないこと — 既存のエラーハンドリング方針に合わせ、ログして無視)。
- **テスト**: truncated NOTIFY(1B payload・idLength 過大・name 切れ)の 3 ケースで「ハングせず、当該レコードのみ破棄して復帰」を固定。タイムアウト付きで回す。
- **受け入れ基準**: 不正 payload で CPU スピン・OOM が起きない。正常レコード列挙の既存テスト緑維持。

#### P1-3. OS2 デバイスの CLI BLE 経路が OS3 ファサード直結で構造的に不成立 — os 判別ルーティングを実装〔R2:DOC-06 実装側 / High〕

- **対象**: `src/cli/lock-ops.js:189-195`(`runBleOp` — 無条件に `SesameBle.use`(OS3)で接続)、`src/cli/lock-ops.js:79-101`(`pickTransport` — OS2 lock の `autolock` は cloud 非対応のため "ble" に振られる)、`src/ble/devicemodel.js:87-89`(OS2 kind の ble 能力: lock/unlock/toggle/autolock 等)。
- **参照**: OS2 の BLE 操作は `src/ble/os2/`(SesameOS2Ble ファサード)が担う設計(v1 P1-1〜P1-5 で整備済み)。OS3 セッション(`CHSesameOS3.kt` 系)と OS2 セッション(`CHSesame2Device.kt` 系)はハンドシェイク・暗号とも別物で互換性は無い。
- **問題**: `sesame <OS2デバイス> autolock 300` は pickTransport が "ble" を選び、`runBleOp` が **OS3 ファサード**で接続を試みる。OS2 実機には OS3 ハンドシェイクが成立しないため必ず失敗する(そもそも P1-1 修正前は発見すらできない)。`--ble-only` の lock/unlock/toggle/click も同様の死に経路。docs(`docs/en/architecture.md:44`)は逆に「OS2 は ble 空集合」と書いており、実装・文書の両方が現実と不一致。
- **修正手順**:
  1. `runBleOp` で `capabilitiesForModel(entry.model).os` を見て分岐: os===2 なら `src/ble/os2/index.js` の OS2 ファサードを(動的 import で)使い、lock/unlock/toggle/click/autolock を対応メソッドへ写像する。os===3 は現行どおり。
  2. `runBleOnLock` の status 表示(fmtMech)が OS2 の mechStatus 形(mechKind "os2lock"/"os2bot")を整形できるか確認し、必要なら表示分岐を追加。
  3. `docs/en/architecture.md:44` / `docs/ja/architecture.md:55` の「OS2 は ble 空集合 → クラウドのみ」を現実(OS2 kind は ble 能力を持ち、CLI は os 判別で OS2 ファサードに接続する)へ書き直す。`docs/{en,ja}/commands.md` の「専用 CLI 経路は OS2 ではクラウドのみ」も同時に訂正。
- **テスト**: `tests/cli/` に lock-ops のルーティングテストを追加 — OS2 model のエントリで `--ble-only lock` / `autolock` が OS2 ファサード(モック)に到達すること、OS3 model は従来どおりであること。
- **受け入れ基準**: OS2 エントリの BLE 系 CLI 操作が OS2 ファサードへ正しくルーティングされる(実機検証は §9 V1 に従属)。docs と実装の記述が一致。

#### P1-4. `onDeviceUpdate` / `subscribeDevicesUpdate` が WS 再接続後に購読フレームを再送せず push が黙って止まる〔R2:CLOUD-01 / High〕

- **対象**: `src/devices.js:290-295`(`subscribeDevicesUpdate` — フレームを 1 回 send するのみ)、`src/client.js:1440-1447`(`onDeviceUpdate` — 再接続フック無し)。対比: `src/client.js` の `onLockStateChangeDevice` は v1 P3-4 で `onReconnect(sendSubscribeFrame)` 済み。
- **参照**: `references_web/src/api/useManageDevice.js:352-358` — `WebSocketManager.onConnectionIdChange(() => getCompanyDevices())` → `:48-51` で `subscribeDevices(...)` を**再送**。`pubDeviceStateChange` 系 push は「subscribe フレームを送った接続にのみ」届く。
- **問題**: 再接続(keepalive pong timeout / sleep 検知で日常的)後、transport のローカル購読は残るが**サーバ側購読が失われ**、利用者にはエラーなしにイベントだけが来なくなる。serve daemon は自前で回避済み(`daemon.js` の `_reestablishStateSub`)だが、ライブラリ/SDK 直利用者には回避が無い。
- **修正手順**:
  1. `devices.subscribeDevicesUpdate` の「購読フレーム送信」部分を関数化する。
  2. `client.onDeviceUpdate` を `onLockStateChangeDevice` と同型に変更: 初回送信 + `this.onReconnect(resendFrame)` を併設し、戻り値の unsubscribe で両方解除する。
  3. daemon 側の自前回避は残してよい(再送が二重になるだけで無害)が、コメントに「ライブラリ層で再送されるようになった」旨を追記。
- **テスト**: `tests/devices/` または `tests/client/` に「subscribe → 再接続イベント → フレーム再送」を mock-ws で固定(onLockStateChangeDevice の既存テストと同型)。
- **受け入れ基準**: 再接続後も deviceUpdate push の受信が継続する(モックで検証)。unsubscribe 後は再送されない。

#### P1-5. `listDevices`(getCompanyDevice)に success:false 即時失敗検知(errorAction)が未適用 — 即時エラーが 10 秒 timeout に化ける〔R2:CLOUD-02 = R2:BIZ-03 / Medium〕

- **対象**: `src/client.js:466-497`(`listDevices` の `subscribeChunks` 呼び出しに `errorAction` キーが無い)。
- **参照**: `references_web/src/api/useManageDevice.js:27-34` — vendor は `biz3ManageDevice` の全応答で `!message.success` を一律失敗扱い(メッセージ表示)。同一プロトコルの `devices.getUserDevices`(`src/devices.js:87-89`)は v1 P3-9 で `errorAction: ACT_MANAGE` 適用済みで、兄弟実装間で非対称。
- **問題**: サーバが `{action:"biz3ManageDevice", op:"getCompanyDevice", success:false, message:"..."}` を即返するケース(認可・companyID 不正等)で、エラーメッセージが捨てられ 10 秒後に timeout(retryable=true の誤分類)になる。
- **修正手順**: `listDevices` の `subscribeChunks` 設定に `errorAction: ACTION_TYPES.BIZ3_MANAGE_DEVICE` を追加(getUserDevices と同形)。
- **テスト**: `tests/client/` に「success:false 即時応答で reject(message 透過・timeout でない)」を追加。
- **受け入れ基準**: 即時エラーがサーバメッセージ付きで即座に reject される。正常ページングの既存テスト緑維持。

#### P1-6. config.json のプロセス間 lost-update 防止が未実装(v1 P2-8 の半分が未完)〔R2:ARCH-01 / High〕

- **対象**: `src/config.js:373-391`(`ConfigStore.save()` — ロックなし・ディスク再読込なしでメモリ内容を全量上書き)。対比: `src/tokens.js:174-191` は `withFileLock` + load→merge→save 済み。
- **参照**: v1 P2-8 の表題・対象は「tokens.json **/ config.json**」だったが、実装されたのは tokens のみ(grep 実測で `withFileLock` 使用は tokens.js の 2 箇所だけ)。
- **問題**: serve デーモンは `config.syncLocks/syncHub3s/syncRemotes/syncRemoteKeys` や `refreshAccount()` で config.json を書き、CLI(`remote add`/`locks add`/`init` 等)も並行して書く。デーモン常駐 + CLI 併用は公式ユースケースなので、「serve が同期した直後に古いスナップショットの CLI save が上書き → **登録直後デバイスの secretKey エントリが消える**」競合が現実に起きうる(atomic rename は破損防止のみで競合上書きは防げない)。
- **修正手順**:
  1. `ConfigStore.save()` を `withFileLock(this.configPath, ...)` で包み、ロック内で「ディスク再読込(migrateConfig→normalizeConfig)→ 自データとのマージ → 書込」に変更する。
  2. マージ規則を tokens.js:106-126 と同様のコメント形式で文書化する。最低限: `devices`/`locks`/`remotes` 等のコレクションはキー単位の union(自分が触っていないキーを disk から温存)、スカラ設定は自分の値を採用。削除系 API はロック内 load-modify-save に統一(tombstone 不要であることを確認)。
  3. デーモン側(`refreshAccount` の load→mutate→save)も同じ save を通ることを確認。
- **テスト**: `tests/config/` に tokens の lost-update テストと同型の並行 save 競合テストを追加 —「プロセス A が device X を追加 → 古いスナップショットのプロセス B が save → X が消えない」。
- **受け入れ基準**: 並行書き込みでデバイスエントリが失われない。既存 config テスト・マイグレーションテスト緑維持。

#### P1-7. BLE デバイス発見(`ble.scan`)RPC の追加 — RPC/SDK だけで初期ペアリングが自己完結しない〔R2:SURF-25 / High〕

- **対象**: `src/serve/registry.js`(`ble.scan` 不在)。CLI には `sesame ble scan` が存在(`src/cli/ble.js`)。
- **問題**: `ble.register` / `ble.os2.register` RPC は deviceUUID 必須だが、RPC/SDK 消費者には近接デバイスの deviceUUID を知る手段が無い(allowlist はインスタンス op のみで static `listNearby` に届かない)。「ライブラリで出来ることは全経路で出来る」コンセプトの明確な破れ。
- **修正手順**:
  1. registry に `ble.scan` MethodEntry を追加: params `scanTimeoutMs?:number`, `includeUnknown?:boolean`。handler は `listNearbyDevices()` を呼び、CLI `cmdScan` と同じく `peripheral` ハンドルを落とした素直な JSON 配列(deviceUUID/model/kind/productType/isRegistered/rssi 等)を返す。
  2. `RESULT_SCHEMAS` に配列スキーマを追加。experimental(STABLE_METHODS 非掲載)のまま `npm run build` で openrpc/gRPC/TS/Py に自動伝播させる。
  3. P1-1(OS2 発見)と同一マイルストーンで入れると、OS2 の登録フローも RPC で完結する。
- **テスト**: `tests/serve/ble-rpc-wiring.test.js` に結線テスト(モック transport で discovery 2 件 → 配列が返る、peripheral ハンドル非含有)を追加。
- **受け入れ基準**: SDK(TS/Py)から `ble.scan` → `ble.register` の一連が(モック上で)完結する。openrpc/SDK 再生成差分がテストで固定される。

#### P1-8. BLE 一覧系 typed RPC が ack しか返さず実データ取得不能 — publish 収集ハンドラへ昇格〔R2:SURF-26 + R2:SURF-39(生体部) / High〕

- **対象**: `src/ble/biometric.js` の RPC op 表(`"biometric.cardGet": { params: [], result: "ack" }` ほか passcodeGet/faceListGet/palmListGet/fingerPrints)、`src/ble/hub3.js` の raw `hub3.scanWifiSSID`、`src/serve/registry.js:373-404`(bleOpEntries の ack 整形)。対比: CLI は `src/cli/ble.js` の `collectBiometricList` で publish を収集して一覧を返せる。
- **問題**: これらの op の実データは BLE publish で届くが、serve には BLE publish を運ぶイベント経路が無い。`ble.biometric.cardGet` 等は `{resultCode,resultName}` を返すだけで、**SDK 消費者はカード/パスコード/顔/掌/指紋の列挙が構造的に不可能**(CLI は可能 — 経路対称性の破れ)。「Get」の名で ack だけ返る契約も誤解を招く。
- **修正手順**:
  1. CLI の `collectBiometricList` を `src/ble/biometric.js` へ移管・export し、CLI はそれを import する(R2:SURF-39 の生体部分を同時解消)。
  2. registry の `ble.wifi.scan`(collectWifiScan)と同じパターンで、一覧系 5 op を専用ハンドラへ昇格: `registerDelegate` で {start, recv..., end} を収集し `records` 配列を返す。タイムアウトは `ble.wifi.scan` と同じ流儀。
  3. `RESULT_SCHEMAS` に records スキーマを追加し、`npm run build` で SDK へ伝播。これらは experimental なので結果形変更は契約上許容(P4-1 の changelog に記載)。
  4. raw `ble.hub3.scanWifiSSID` は summary に「RPC では結果未達。`ble.wifi.scan` を使うこと」と明記する(または生成対象から外す)。
- **テスト**: `tests/serve/` に「cardGet → publish 3 件 + end → records 3 件が返る」結線テスト。CLI 側は import 差し替えの回帰のみ。
- **受け入れ基準**: SDK から生体 5 種の一覧が取得できる。CLI の既存挙動・出力形は不変。

---

## Phase 2 — 認証のアプリ忠実化・残件(絶対制約領域)

> 監査の結論: v1 P2-1〜P2-9 の中核(device SRP の数学・ConfirmDevice・REFRESH_TOKEN_AUTH・Identity Pool・SigV4・トークン永続化)は**正しく実装済み**。残るのは initiate の形・失効時後始末・細部の逸脱注記。**作業前に P2-1(参照ベンダリング)を必ず実施**。

#### P2-1. AWSMobileClient 2.77.0 参照を in-repo にベンダリング(他 P2 の前提)〔規範9 / AUTH-10 一次資料整備〕

- **対象**: 認証の一次資料が `/tmp/aws-sdk-android/` に置かれている(揮発)。今回監査時 `AuthenticationHelper.java` と `AH.java` が「404: Not Found」の 14 バイトプレースホルダ化しており、`Hkdf.java` / `CognitoCredentialsProvider.java` は欠落していた(統括が release_v2.77.0 から補完した)。
- **問題**: `/tmp` は再起動で消え、欠損に気付かないまま「確認済み」と誤認するリスクがある(規範9 の発生源)。`src/auth.js:5-6` は「`/tmp/aws-sdk-android/` に取得済み」とコメントするが、これは揮発前提で不適切。
- **修正手順**:
  1. リポジトリ直下に `_aws_sdk_ref/`(gitignored)を作り、AWSMobileClient 2.77.0(`release_v2.77.0` タグ)の関連 Java を配置する。最低限: `CognitoUser.java`(inner `AuthenticationHelper` :3979-4097 を含む)、`CognitoUserPool.java`、`AWSMobileClient.java`、`AuthenticationDetails.java`、`ChallengeContinuation.java`、`CognitoDeviceHelper.java`、`Hkdf.java`、`CognitoIdentityProviderClientConfig.java`、`CognitoCredentialsProvider.java`、`CognitoCachingCredentialsProvider.java`。
  2. `REFERENCES.md` の一次資料表に `_aws_sdk_ref/`(auth 数式の最一次資料)を追記し、`_sesame_sdk_ref` は「アプリのログインフロー結線」、`_aws_sdk_ref` は「AWSMobileClient がフロー内で実際に送るワイヤ形」と役割を分ける。
  3. `src/auth.js` / `src/device-srp.js` / `src/aws-credentials.js` のコメント引用を `/tmp/...` から `_aws_sdk_ref/...` に書き換える。`AuthenticationHelper.java` 引用は実体が `CognitoUser.java` の inner class であることを注記(他監査が空ファイルを誤引用しないよう)。
  4. `scripts/` に参照健全性チェック(`canary-upstream.mjs` 拡張 or 新規)を足し、各参照ファイルが非空かつ期待シンボル(例 `CognitoUser.java` に `getDeviceAuthenticationKey`)を含むことを検査する。CI ではなくローカル/任意実行でよい(参照は gitignored のため)。
- **テスト**: 参照健全性スクリプトの自己テスト(欠損・プレースホルダを検出して非ゼロ終了)。
- **受け入れ基準**: auth 関連コメントの全 file:line が in-repo の `_aws_sdk_ref/` で解決し、健全性チェックが緑。**この項目完了まで P2-2 以降に着手しない**(数式の裏取り基盤のため)。

#### P2-2. InitiateAuth(CUSTOM_AUTH)をアプリ形(SRP_A 付き + PASSWORD_VERIFIER 応答)にする〔R2:AUTH-01 / High・絶対制約領域〕

- **対象**: `src/auth.js:255-262`(`loginInitiate` の InitiateAuth が `AuthParameters: { USERNAME }` のみ = web 形)、`:261-262` / `:357-358`(PASSWORD_VERIFIER を「Unexpected challenge」として throw)、`tests/auth/login-flow.test.js:86-91, 137-145`(誤形状を期待値に固定)。
- **参照**(すべて `_aws_sdk_ref/` 配置後の参照): `LoginMailFG.kt:131`(`signIn(mail, "dummypwk", null, ...)` — **password 付き** signIn)→ `AWSMobileClient.java:1318-1322`(password≠null かつ CUSTOM_AUTH なら 4 引数 `AuthenticationDetails`)→ `AuthenticationDetails.java:67-80, 181-184`(4 引数 ctor は `authenticationType=CUSTOM_CHALLENGE` + `setCustomChallenge(SRP_A)` を設定)→ `CognitoUser.java:3492-3494`(`SRP_A` のとき `authenticationParameters.put(SRP_A, A.toString(16))`)。つまりアプリの InitiateAuth は `AuthParameters = {USERNAME, CHALLENGE_NAME:"SRP_A", SRP_A:<g^a mod N hex>}`。さらに `CognitoUser.java:3057-3071, 3588-3662` — initiate 応答が `PASSWORD_VERIFIER` のときアプリは password="dummypwk" の user SRP で回答してから続行する。
- **問題**: kit は SRP_A を送らず、PASSWORD_VERIFIER チャレンジが来たら throw する。現行サーバは web 形(SRP_A なし)も受理しているため**現在は動作している**が、DefineAuthChallenge Lambda が「アプリは常に SRP セッションを提示する」前提に変われば kit だけログイン不能になる。`auth.js:220` の「LoginMailFG.kt の 1:1」主張は initiate については不正確で、テストが誤形状を固定している。
- **修正手順**:
  1. `src/device-srp.js` の SRP 数式を user SRP に流用(数式同一)。`generateEphemeralA()` を用意し `a`(1024bit 乱数 mod N)・`A=g^a mod N`(A≡0 retry)を生成。
  2. `loginInitiate` で `AuthParameters = {USERNAME, CHALLENGE_NAME:"SRP_A", SRP_A: A.toString(16)}` に変更し、`a`/`A` を pending に保存。
  3. initiate 応答が `PASSWORD_VERIFIER` の場合のハンドラを追加(`CognitoUser.java:3588-3662` の 1:1): `ChallengeParameters` から `USER_ID_FOR_SRP`/`SRP_B`/`SALT`/`SECRET_BLOCK` を読み、`x=H(salt, H(poolName ‖ userIdForSRP ‖ ":" ‖ "dummypwk"))`、`S`、`hkdf`、署名 `HMAC(hkdf, poolName ‖ userIdForSRP ‖ secretBlock ‖ timestamp)`、`ChallengeResponses = {PASSWORD_CLAIM_SECRET_BLOCK, PASSWORD_CLAIM_SIGNATURE, TIMESTAMP, USERNAME, DEVICE_KEY(あれば)}`。続く応答が CUSTOM_CHALLENGE なら現行どおり、CUSTOM_CHALLENGE 直行(現行観測)も従来どおり処理。
  4. `SRP_B ≡ 0 (mod N)` ガード(P2-4)を user SRP 側にも入れる。
  5. `tests/auth/login-flow.test.js` の initiate 期待形を 3 フィールドに修正し、`initiate→PASSWORD_VERIFIER→CUSTOM_CHALLENGE` 連鎖のモックシナリオを追加(モック応答フィールドは `CognitoUser.java:3594-3598` の読み取りから導出と明記)。`@experimental` + §9 V13 に「アプリ形 initiate を実 Cognito が受理し CUSTOM_CHALLENGE を返す」を登録。
- **代替最低線**: 実機検証で問題が出る場合でも、最低限コード/テストから「LoginMailFG.kt の 1:1」主張を外し「web 形 initiate を意図的採用(理由)」と正直に注記する(規範2)。ただし規範上は本修正を推奨。
- **受け入れ基準**: InitiateAuth が SRP_A を含み、PASSWORD_VERIFIER 経由でもトークンを取得できる。テストが連鎖シナリオを固定。

#### P2-3. refresh 失効時の後始末を「トークン 3 点のみ破棄・device 温存」に縮小〔R2:AUTH-02 / Medium・絶対制約領域〕

- **対象**: `src/auth.js:188-199`(`getValidIdToken` の NotAuthorized/UserNotFound → `store.clear()` で tokens.json 全削除)。
- **参照**: `CognitoUser.java:2703-2720`(`clearCachedTokens()` は **idToken/accessToken/refreshToken の 3 キーのみ** remove。device 3 点は別ストアで温存)。device が消えるのは `DEVICE_SRP_AUTH` が NotAuthorized になった時の `clearCachedDevice` のみ(`:3384-3396`)。
- **問題**: `store.clear()` は deviceKey/deviceGroupKey/devicePassword/username まで消すため、refresh 失効ごとに ConfirmDevice が新規発行され、**サーバに remembered device が累積**する(kit が logout で ForgetDevice を強化した理由を、失効経路で自ら作っている)。
- **修正手順**:
  1. `getValidIdToken` の失効 catch を `store.clear()` から「トークン 3 点 + lastRefresh を null/破棄し、clientId/username/device 3 点を温存した save」に変更(`StoredTokens.idToken` 型を null 許容に)。
  2. **注意(競合)**: `tokens.js:132-143` の merge は freshness 比較で disk 側が勝つとトークンを復活させる。素朴な「idToken 抜き save」では失効破棄が巻き戻るため、(a) `clear()` 後に device-only レコードを save する(clear 後は disk=null で merge 素通し)か、(b) merge 規則に「incoming の明示 null はトークン破棄の意図として尊重」例外を追加し `tests/tokens/lost-update.test.js` に固定する。
  3. `tests/auth/` に「refresh 失効 → 後始末 → 再ログインで DEVICE_KEY 付き回答 → DEVICE_SRP_AUTH 成立(ConfirmDevice 不発行)」シナリオを追加。
- **受け入れ基準**: refresh 失効後の再ログインが既存 device を再利用し、ConfirmDevice を重複発行しない。

#### P2-4. device SRP の `SRP_B mod N == 0` ガードを追加〔R2:AUTH-03 / Medium〕

- **対象**: `src/device-srp.js:172-186`(`deviceAuthSecrets` — `U===0n` のみ検査)。
- **参照**: `CognitoUser.java:3686-3689`(device 側)/ `:3605-3608`(user 側) — `if (srpB.mod(N).equals(ZERO)) throw "SRP error, B cannot be zero"`。
- **問題**: 悪性/故障サーバが `SRP_B ≡ 0 (mod N)` を返すと S が自明値になる SRP-6a の既知縮退を、参照はリクエスト組み立て前に拒否するが kit は素通し(実 Cognito では起きないが参照防御の欠落)。
- **修正手順**: `deviceAuthSecrets` 冒頭(または `auth.js` の SRP_B parse 直後)に `if (serverB % N === 0n) throw new Error("SRP error, B cannot be zero")` を追加。P2-2 で user SRP を実装する場合はそちらにも。
- **テスト**: `tests/auth/device-srp-auth.test.js` に B=0 / B=N / B=2N の拒否を追加。
- **受け入れ基準**: 縮退 B を明示エラーで拒否。

#### P2-5. Identity Pool credentials の refresh 閾値を参照値(500s)に揃える〔R2:AUTH-04 / Low〕

- **対象**: `src/aws-credentials.js:38-39`(`DEFAULT_REFRESH_MARGIN_MS = 60_000`、「余裕 60s」)。
- **参照**: `CognitoCredentialsProvider.java:67`(`DEFAULT_THRESHOLD_SECONDS = 500`)、`:853-863`(`needsNewSession()` は `timeRemaining < threshold*1000` で再取得)。
- **問題**: 「CognitoCachingCredentialsProvider 相当」と謳いつつ閾値が 60s。idToken 側は v1 P2-7 で 120s に揃えたのに Identity Pool 側は未調整。
- **修正手順**: `DEFAULT_REFRESH_MARGIN_MS` を `500_000` に変更し出典(`CognitoCredentialsProvider.java:67`)をコメントに記載。`tests/aws-credentials/aws-credentials.test.js:107-134` の margin 前提を更新。意図的に短くするなら逸脱注記を付ける。
- **受け入れ基準**: 閾値が参照と一致、テスト更新。

#### P2-6. Cognito リクエストの空コレクション送出と UserContextData 非送出を 1:1 化/注記〔R2:AUTH-06 / Low〕

- **対象**: `src/auth.js:244-259`(SignUp / InitiateAuth)。
- **参照**: SignUp は `LoginMailFG.kt:109`(validationData=空 map)+ `CognitoUserPool.java:531-554`(非 null なら空でも `ValidationData:[]` を構築)+ `AWSMobileClient.java:2135-2143`(clientMetadata=空)。InitiateAuth は `CognitoUser.java:3480`(`ClientMetadata:{}`)。UserContextData は `CognitoUserPool.java:626-636`(ASF 既定 ON、Android 端末フィンガープリント)。
- **問題**: kit はこれらを送らない。空コレクションは付与可能だが、UserContextData は Android 固有で Node から忠実再現不能。規範2「意図的逸脱はコメントに明記」が未充足。
- **修正手順**: SignUp に `ValidationData: []` / `ClientMetadata: {}`、InitiateAuth に `ClientMetadata: {}` を付与(テスト期待値更新)。UserContextData は「Android ASF 由来のため非送出(意図的逸脱)」と `auth.js` ヘッダに注記。**実装前に `_aws_sdk_ref/` の `*RequestMarshaller.java` で「空コレクションがワイヤに乗る」ことを実確認**(§未確認)。
- **受け入れ基準**: 空コレクション送出がマーシャラ実物で裏取りされ、逸脱が注記される。

#### P2-7. ConfirmDevice 失敗時の fail-fast を逸脱注記する(参照は best-effort 継続)〔R2:AUTH-05 / Low〕

- **対象**: `src/auth.js:395-418`(`confirmDevice` 失敗を throw し `loginVerify` 全体を失敗させる)。
- **参照**: `CognitoUser.java:3861-3868`(ConfirmDevice 失敗は握りつぶし `return null`)→ `:3140-3158`(null でも `onSuccess`、ログインは成功扱いで device がキャッシュされないだけ)。
- **問題**: kit は ConfirmDevice 失敗(ネットワーク断含む)で発行済みトークンを捨てる。kit の「未確認 device を永続化しない」ゲートとは整合するが、参照と逆挙動である旨がコメントに無い。
- **修正手順**: 最小対応として「参照は best-effort(`CognitoUser.java:3861-3868`)だが、本 kit は未確認 device の永続化が refresh 不能トークンを生むため意図的に fail-fast」と注記。挙動変更まで踏むなら「コード再入力なしの retry」を許す再試行可能エラー化を検討。
- **受け入れ基準**: 逸脱がコメントで明示される。

#### P2-8. ログイン直後の nickname 自動設定(アプリ挙動)の移植判断〔R2:AUTH-09 / Low〕

- **対象**: `src/auth.js` `loginVerify` 成功後(相当処理なし)。
- **参照**: `LoginVerifiCodeFG.kt:74-76, 112-150` — confirmSignIn 成功後に `getUserAttributes()` を引き、nickname 空かつ email 非空なら `updateUserAttributes({nickname: email の @ 前})` を best-effort 実行。
- **問題**: kit でログインした新規アカウントは nickname 未設定のままで、公式アプリ/共有先の表示名挙動と乖離する。
- **修正手順**: `cognitoCall("GetUser", {AccessToken})` → nickname 空なら `cognitoCall("UpdateUserAttributes", {AccessToken, UserAttributes:[{Name:"nickname",Value:<email local part>}]})` を loginVerify 成功後に best-effort(catch して続行)で追加。GetUser/UpdateUserAttributes の実ワイヤ形を AWS JSON 1.1 で確認しテスト追加。実装しない判断なら「アプリは行うが kit は省略(意図的逸脱)」と注記。
- **受け入れ基準**: nickname が設定される、または省略が注記される。

#### P2-9. device-srp テストの salt 長アサートを確率的 flaky から修正〔R2:AUTH-08 / Low〕

- **対象**: `tests/auth/device-srp.test.js:31-32`(`salt.length >= 16`)。
- **参照**: `CognitoDeviceHelper.java:373`(salt=128bit 乱数)— 先頭バイトが 0x00 なら `toByteArray()` は 15B 以下になり得る。`device-srp.js:97` も同分布。
- **問題**: 実装は参照と同じ正しい分布なのに、テストが「>=16」を仮定し約 0.8%/実行で偽赤。
- **修正手順**: 下限を「`<=17` かつ base64 往復一致」にするか、`randomBytes` 注入で上位 0x00 と 0x80+ の両ケースを固定ベクタ化。
- **受け入れ基準**: 1000 回連続実行で安定。

#### P2-10. auth 系 stale コメントの訂正〔R2:AUTH-07 / Low(P6-7 と同一 PR 可)〕

- **対象**: `src/cognito-http.js:4-5`(「Cognito API は 7 種(… UpdateDeviceStatus …)」— v1 P2-5 で撤去済み、現在 6 種)、`src/client.js:978-979, 993-994`(「biometrics に appidentifyid」— `/device/v1/biometrics` に appidentifyid は付かない。`access.js:161-165` 自身と矛盾)。
- **修正手順**: cognito-http.js の op 列挙を 6 種(InitiateAuth/RespondToAuthChallenge/SignUp/ConfirmDevice/ForgetDevice/RevokeToken)に訂正。client.js の 2 コメントから appidentifyid を削除し、`makeBiometricsTransport` が `config`/`configStore` を無視する互換引数である旨を一言添える。
- **受け入れ基準**: コメントが実コードと一致。

---

## Phase 3 — クラウド/BLE 忠実性の抜け漏れ補完

> 3A(クラウド/Biz3)と 3B(BLE)は領域独立で並行可。各項目は参照の送信側コードに対する 1:1 化、または出典なし防御・捏造・虚偽コメントの解消。Medium は機能/忠実性、Low は衛生。

### 3A. クラウド・Biz3 の忠実化

#### P3-1. addIRRemote の入力契約ドキュメントを vendor 実フィールドに訂正〔R2:CLOUD-03 / Medium〕

- **対象**: `src/ir.js:127-128`、`src/cli/ir.js:218-222`(「`{hub3DeviceId, type, name, irOperation, ...}` を渡せ」「search/match 出力をそのまま渡せる」)。
- **参照**: `references_web/.../learn/index.js:260-269` / `remote-air/index.js:512-520` / `remote-non-air/index.js:264-272` — 送る remote は `{uuid(クライアント発番・必須), model, state:'', alias, code, type, deviceUUID:hub3DeviceId, keys:[]}`。
- **問題**: Hub3 関連付けの実名は `deviceUUID`(`hub3DeviceId` ではない)、表示名は `alias`/`model`(`name` ではない)、`irOperation` は存在しない、`uuid` はクライアント発番必須。「search 出力をそのまま渡せる」も誤り(vendor は uuid/alias/state/deviceUUID/keys を付加してから送る)。ドキュメント通りに従うと Hub3 に紐付かない壊れたレコードを実サーバに作る。
- **修正手順**: `ir.js` JSDoc・`cli/ir.js` ヘルプを vendor 形 `{uuid, model, state, alias, code, type, deviceUUID, keys}` に訂正。kit 側で `uuid` 未指定時に `generateUUID()` 補完 + `deviceUUID` 欠落の badRequest 検査を入れる(vendor の前段組み立てに相当)。
- **テスト**: `tests/ir/` に「uuid 補完」「deviceUUID 欠落で badRequest」を追加。
- **受け入れ基準**: ドキュメント記載の手順がそのまま正しいレコードを生成する。

#### P3-2. プリセットリモコン 3 個/Hub3 上限(canAddMoreRemote)の移植と出典訂正〔R2:CLOUD-04 / Medium〕

- **対象**: `src/ir.js:126`(「3 個上限が**サーバ側にある**」)。
- **参照**: `references_web/src/api/useRemoteCtrl.js:226-255`(`canAddMoreRemote` — type 0x8000/0x2000/0xe000/0xc000 を `stateInfo.remoteList` で数え 3 個以上なら拒否、0xfe00 自己学習は無制限)、`:525-531`(addIRRemote が送信前にこのガードを通す)。サーバ側 enforcement のコードは参照に無い。
- **問題**: 制限はクライアント側のみ。「サーバ側にある」は出典なし断定で、サーバが enforce しないと 4 個目以降を追加でき実機挙動未定義。
- **修正手順**: コメントを「vendor はクライアント側で 3 個制限(サーバ側 enforcement は未確認)」に訂正。`client.addIRRemoteServer` に `stateInfo.remoteList` ベースの事前チェック(type 4 種カウント、0xfe00 除外)をオプトインまたは既定で実装。
- **テスト**: 3 個到達で 4 個目を拒否、0xfe00 は無制限。
- **受け入れ基準**: 上限超過が送信前に拒否され、出典が正直化される。

#### P3-3. getDeviceEmployeeKeys が捨てている `hasMore` を返す〔R2:BIZ-01 / Medium〕

- **対象**: `src/org.js:728-737`(`return resp?.data ?? []`)。
- **参照**: `references_web/src/components/DeviceUserList.js:29-31`(`setHasMore(resp.hasMore)` と `resp.data` の両方を消費)。
- **問題**: 参照はトップレベル `hasMore`(続きありフラグ)と `data` を読むが kit は data のみ返す。limit=5(非管理モード)相当が再現不能。
- **修正手順**: 戻り値を `{ list: resp.data ?? [], hasMore: resp.hasMore }` に変更(または raw resp)。JSDoc に `DeviceUserList.js:29-40` 由来の `hasMore` を明記。`tests/org/org.test.js` に hasMore パススルーを追加。serve/SDK スキーマに戻り形変更を反映(経路対称性)。
- **受け入れ基準**: hasMore がライブラリ/RPC/SDK で取得できる。

#### P3-4. payUpdateLevel の subId 必須化を撤廃(参照は欠落でも送信)〔R2:BIZ-02 / Medium〕

- **対象**: `src/payment.js:123-125`(`if (!subId) throw badRequest(...)`)。
- **参照**: `references_web/src/api/useStripeInfo.js:200-219` — ガードは `customerId` のみ。`subscriptionId` は `priorityCompany`(`:41-47`)で undefined になり得て、undefined は JSON.stringify で落ち subId なしで送信される。
- **問題**: サブスク未保持(Free)会社の初回 `payUpdateLevel` で、参照は subId なしフレームを送るのに kit は送信前に拒否する。ワイヤ上表現できない呼び出しが生じる。
- **修正手順**: subId 必須チェックを外し、`subId != null` のときのみフレームに含める(参照の「undefined は直列化で落ちる」挙動の 1:1)。level/isUpgrade の必須は呼び出し元が常に渡すため維持可。
- **テスト**: 「subId 省略時は subId キーなしで送る」を追加。
- **受け入れ基準**: Free 会社の初回アップグレードがワイヤ上表現できる。

#### P3-5. updateCardOwner を item 透過にする(2 フィールド固定を撤廃)〔R2:BIZ-04 / Low〕

- **対象**: `src/access.js:624-633`(obj を `{cardID, ownerSubUUID}` に固定)。
- **参照**: `useManageAuthData.js:346-353`(`obj:{...item}` をそのまま送る)。呼び出し元 `cards/index.js:385-396` は `{cardID, name, cardNameUUID, ownerSubUUID, timestamp, cardType, stpDeviceUUID}` の全フィールドを送る。
- **問題**: kit は 2 フィールド固定で cards/index.js 経路のフレームを再現できない。
- **修正手順**: シグネチャを item 透過(`updateCardOwner(client, { item, timeoutMs })`)に変更し `obj:{...item}` で送る(`'ownerSubUUID' in item` ガード維持)。後方互換が要るなら cardID/ownerSubUUID 直指定も item に合成。
- **テスト**: 全フィールド透過ケース。
- **受け入れ基準**: 両呼び出し元のフレームが再現できる。

#### P3-6. 出典なし `?? resp` / `?? {}` フォールバックの撤去〔R2:BIZ-05 / Low〕

- **対象**: `src/org.js:271`(addEmployeeGroup)、`:324`、`:571`、`:650`(getEmployeeDeviceKeys)、`src/access.js:653`(postAuthenticationData の `?? resp` / `?.items ?? resp`)。
- **参照**: 参照は無条件に `.data`(`.data.items`)を読む(`useManageEmployee.js:51-52`、`EmployeeItem.js:72-74`、`CHDataSynchronizeCapableImpl.kt:18-23` は欠落時クラッシュであってフォールバックではない)。
- **問題**: 欠落時に応答全体へすり替える分岐は参照に無く、奇形応答が黙って通り型が揺れる。`org.js:102`(getCurrentUserInfo)は同種を「推測だった」として撤去済みで不整合。
- **修正手順**: いずれも `resp.data`(access は `resp?.data?.items`)直返しに揃え、欠落は undefined のまま or assert で明示失敗。JSDoc から「無ければ応答全体」を削除。
- **受け入れ基準**: フォールバックが消え、テストが直返し形を固定。

#### P3-7. fetchAuthData の grace timer 未クリアとページ粒度の取りこぼし〔R2:BIZ-06 / Low〕

- **対象**: `src/access.js:342-349`(完了通知ハンドラ)、`:307-308`/`:347`(graceTimer)。
- **参照**: `useManageAuthData.js:116-132`(pub 蓄積)と `:179-185`(完了通知)は独立処理で到着順序保証は導出不能(v1 P3-12 の前提)。
- **問題**: ①完了通知時に「全要求デバイスに push が 1 件以上」で即 finish するため、page 1 受信済みデバイスの page≥2 が完了通知より後に届くと切り詰める。②graceTimer が subscribeChunks cleanup で clear されず最大 graceMs 残存する。
- **修正手順**: ①完了通知受信時は欠落有無に関わらず一律 graceMs 待って確定(または「ページ粒度は保護対象外」を JSDoc/§9 V8 に明記)。②`unsubs` に `() => clearTimeout(graceTimer)` を積む。
- **テスト**: 「完了通知 → 既知デバイスの追加ページ」が grace 内で吸収される。
- **受け入れ基準**: タイマーリークが無く、ページ取りこぼし方針が明示される。

#### P3-8. queryByCS の chunk 蓄積規則を参照(常に追記)に合わせる〔R2:BIZ-07 / Low〕

- **対象**: `src/org.js:809-811`(collectChunks 共通の「page===1 置換」を pubQueryByCS にも適用)。
- **参照**: `useManageEmployee.js:399-413`(pubQueryByCS は置換分岐なしの追記専用)。置換は pubEmployees(`:75-87`)の規則。
- **問題**: collectChunks が両 op に pubEmployees 規則を一律適用。実害はサーバが page 1 を再送する場合のみだが、コメント根拠が queryByCS に当てはまらない。
- **修正手順**: collectChunks にフラグを足して pubQueryByCS は追記専用にする、または「pubEmployees 規則を意図的共用(再送時は置換が安全側)」と逸脱注記。
- **受け入れ基準**: 蓄積規則が op ごとに参照と一致 or 注記される。

#### P3-9. BIZ 系 JSDoc の事実誤認 2 点の訂正〔R2:BIZ-08 / Low〕

- **対象**: `src/org.js:110-111`(addEmployees「tag はロール/タグ id の配列」)、`src/access.js:476-477`(postPasscodes「list 要素のフィールドは未確認」)。
- **参照**: `AddEmployee.js:346-357`(tagItems はタグ名文字列の配列で id フィールドは無い)、`passwords.js:94-113`(postPasscodes の list は `{passwordID, name, nameUUID}` で確定。同ファイル `access.js:826-830` は正しく確定記述)。
- **修正手順**: ①を「タグ名文字列の配列(`AddEmployee.js:346-357`)」に、②を `enrolledToPasscodeList` と同じ `passwords.js:101-113` 確定記述に更新。
- **受け入れ基準**: 同一事実の二重記述(未確認/確定)が解消。

#### P3-10. invokeWebAPI / matchRemote の空値の乗せ方を vendor に合わせる〔R2:CLOUD-06 / Low〕

- **対象**: `src/devices.js:462-473`(invokeWebAPI が `query={}, body={}` を常に送る)、`src/ir.js:394-408`(matchRemote の `brandName: brandName || ""`)。
- **参照**: `useDeveloper.js:46-58, 85-96`(query を渡さない=キー脱落)、`useRemoteCtrl.js:785-797`(brandName は常に値あり)。
- **問題**: vendor はキー自体を省くが kit は空オブジェクト/空文字を送る(サーバは無視する可能性が高いが 1:1 逸脱)。
- **修正手順**: 未指定の query/body はキーごと省く(`...(query !== undefined && { query })`)。matchRemote は brandName 未指定時にキー省略。
- **受け入れ基準**: ワイヤ形が vendor と一致。

#### P3-11. 合成 fixture の値を実観測/vendor 消費に合わせる〔R2:CLOUD-08 / Low〕

- **対象**: `tests/fixtures/upstream/lock.unlock.json`(`{action:"unlock", code:0, op:"cmd"}`)、`tests/fixtures/upstream/device.battery.json`(`records[].ts: 1717977600000` = ms)。
- **参照**: `src/lock.js:42-44`(実機 ack は `{action:"biz3TriggerLocker", code:200, data:{}, success:true}`、op 無し)、`MobileBatteryChart.js:41-42`(`new Date(item.ts * 1000)` = ts は秒)。
- **修正手順**: lock.unlock を観測 ack 形(action:"biz3TriggerLocker", code:200, op なし)に、battery の ts を秒桁(例 1717977600)に修正。
- **受け入れ基準**: fixture が実応答/vendor 消費と一致(canary の見本として正しい)。

#### P3-12. devices.js のエンドポイント列挙コメントから未実装の os2 register を削除〔R2:CLOUD-09 / Low〕

- **対象**: `src/devices.js:594-597`(「叩くエンドポイント」に `POST /device/v1/sesame2/{id} (register os2)` を列挙)。
- **問題**: kit に os2 register 呼び出しコードは無い(sign と sesame5 register のみ)。
- **修正手順**: 列挙から register os2 を削除(または「未実装・将来用」と明記)。
- **補足**: アプリ(Kotlin)側にのみ在るクラウド API(AWS IoT MQTT-WSS shadow、updateBotScript、postSS2/OS3History、OS2 register REST 等)は §10 の見送り/将来検討に整理する(updateBotScript は Bot2 スクリプトのクラウド保存で、将来 BLE bot2.js と対になり得る)。
- **受け入れ基準**: コメントが実装と一致。

#### P3-13. onUserDeviceChange の購読前提コメントを正直化〔R2:CLOUD-10 / Low〕

- **対象**: `src/devices.js:297-314`(「購読要求フレームは存在しない…ローカル購読のみ」)、`src/client.js:1380-1390`。
- **参照**: `useIotCtrl.js:12,23-25`(受信ハンドラのみ・専用 subscribe op 無し)。ただし vendor 接続は常に `subscribeDevicesUpdate` 送信済み(`useManageDevice.js:164-172`)で、`pubUserDeviceChange` が無購読接続にも届くかは web コードから排除できない。
- **修正手順**: コメントを「専用 subscribe op は無い。ただし vendor 接続は常に subscribeDevicesUpdate 送信済みのため、無購読接続にも push されるかは未検証」に。安全側にするなら onUserDeviceChange 時にも subscribeDevicesUpdate を送る(§9 V14 に登録)。
- **受け入れ基準**: 確度表示が正直化される。

### 3B. BLE の忠実化

#### P3-14. OS2 timePhone(時刻同期)の送信条件を参照 3 経路に分岐させる〔R2:BLE2-11 / Medium〕

- **対象**: `src/ble/os2/session.js:643-661`(`_maybeSyncTime` が全経路に「abs>3 かつ fwVersion>=1」の Sesame2 login 条件を一律適用)、`:623-640`。
- **参照**: `CHSesame2Device.kt:259-265`(login 応答: abs>3 かつ fw>=1)/ `:508-513`(**登録完了 login publish: 無条件送信**、register 完了は timePhone 応答後)/ `CHSesameBotDevice.kt:277-280`(無条件)・`:461-467` / `CHSesameBikeDevice.kt:351-358`(Bot/Bike login 応答: `timeError > 3` で **abs でなく** fw ガードなし)。
- **問題**: kit は登録直後(SDK は無条件)でも fw=0/時差≤3s なら送らず、Bot1/Bike1(fw=0 現存)では**永遠に時刻同期されない**。コメントは Bot/Bike 逸脱のみ注記し登録経路の無条件送信に触れていない。
- **修正手順**: `_maybeSyncTime` に経路/機種引数を持たせる: (a) register 完了は無条件送信、(b) Bot/Bike(facade から model を session へ伝搬)は `nowSec - systemTime > 3` のみ(fw ガードなし)、(c) Sesame2/3/4 login 応答は現行どおり。
- **テスト**: mock に timePhone 受信記録を足して 3 経路を検証(P3-15 と同時)。
- **受け入れ基準**: 3 経路の送信条件が Kotlin と一致。

#### P3-15. OS2 テストモックの login 応答 systemTime を LE で書く(BE 取り違え修正)〔R2:BLE2-12 / Medium・モック規範〕

- **対象**: `tests/ble/os2.test.js:428`、`tests/ble/os2-register.test.js:131,202`、`tests/ble/os2-robustness.test.js:43`(いずれも `writeUInt32BE`)。
- **参照**: `DataExtention.kt:69-71`(`toBigLong()` = little-endian)、`CHSesame2Device.kt:627`(`systemTime = payload[0..3].toBigLong()`)。デバイスは LE 4B 秒を送る。同リポの `os2.test.js:262-268` 自身が「mock も LE で書く」と注記しながら他 3 ファイルは BE のまま。
- **問題**: mock の systemTime がバイトスワップし、時刻差判定が常に >3 で評価される(実機の「時刻一致なら送らない」分岐をテストが踏めない)。現在は mock の fw=0 が偶然 timePhone を抑止しており、P3-14 を直すと BE が偽陽性/偽陰性を生む。**前回 Critical 2 件を隠したのと同じ「自実装の誤解を写したモック」クラス**。
- **修正手順**: 4 箇所を `writeUInt32LE` に修正し、各 mock に「導出元: `DataExtention.kt:69-71`(toBigLong=LE)/ `CHSesame2Device.kt:627`」を記載。P3-14 対応時に「時刻一致なら timePhone なし / 大きくずれたらあり」の両ケースを検証。
- **受け入れ基準**: モックが LE で導出元を明記し、両ケースを固定。

#### P3-16. OS2 RESULT[9]="invalidAction" の出典なし値を隔離 or 削除〔R2:BLE3-07 / Medium・規範違反〕

- **対象**: `src/ble/protocol.js:55-58`(`9: "invalidAction"`)と出典主張 `:50-53`(`references_ios/.../CHDeviceProtocol.swift:195` — **このディレクトリは存在しない**)。下流: `src/serve/jsonrpc.js:139`(`invalidAction → bad_params`)。
- **参照**: `SesameProtocols.kt:28-30`(`SesameResultCode` は `success(0)..INVALID_PARAM(8)` で **8 で終端**、9 は存在しない)。0..8 は 1:1 一致確認済み。
- **問題**: 9 は in-repo で検証不能(`references_ios/` 不在、REFERENCES.md の一次資料表にも無い)。v1 P3-14(209 捏造)で確立した「確証なき値は隔離」規範に反する。`CHError.BleInvalidAction` はクライアント側エラー enum で結果コード 9 の根拠にならない。
- **修正手順**: iOS SDK を `_sesame_ios_ref/` 等にベンダリングして該当行を確認できるまで、(a) `9: "invalidAction"` を RESULT から外し `resultName(9)` を `unknown(9)` に落とす、または (b) `UNVERIFIED_RESULT_NAMES` に隔離し RESULT 本体は `SesameProtocols.kt:28-30` と 1:1 に保つ。`jsonrpc.js:139` の `invalidAction` 写像も unknown 系既定分類に整理。
- **受け入れ基準**: RESULT 本体が参照と 1:1、未検証値が隔離される。

#### P3-17. itemcodes の STP_ITEM_CODE_CARDS_ADD(182) 欠落と虚偽例示の訂正〔R2:BLE3-06 = R2:CLOUD-05 / Medium・規範8〕

- **対象**: `src/itemcodes.js:9-10`(「`SesameProtocols.kt:32-53` と 1:1」宣言)、`:164-169`(183 を「enum 完全性のため」と置く)、`:241-243`(「182 は SesameItemCode のいずれとも無関係」)。
- **参照**: `SesameProtocols.kt:49` — `STP_ITEM_CODE_CARDS_ADD(182u), STP_ITEM_CODE_DEVICE_STATUS(183u)` は SesameItemCode enum 内に存在。SesameItemCode 全 110 メンバ照合で ITEM_CODES に欠けるのは 182 のみ。
- **問題**: 「1:1」宣言と「183 は完全性のため置く」に反し 182 を欠く。`:242` の「182 は無関係」は事実誤認(182 は両 enum に同名で存在する唯一の番号)。機能影響はない(送信は STP_ITEM_CODES 側)が宣言・完全性の破れ(規範8 違反の実例)。
- **修正手順**: ITEM_CODES に `STP_ITEM_CODE_CARDS_ADD: 182` を追加し 183 と同様の衝突注記を付ける。`:242` の例示を「182/183 は SesameItemCode 側にも同名宣言があり数値・名前とも衝突する(送信は StpItemCode 側を使う)」に訂正。**規範8 に従い**「ITEM_CODES のキー集合 = `SesameProtocols.kt` の SesameItemCode 全メンバ」を固定するテストを `tests/ble/` に追加。
- **受け入れ基準**: enum 全件一致テストが緑、宣言と実体が一致。

#### P3-18. OS3 session の mechStatus(81) 解析を kind ディスパッチにしフォールバック連鎖を排除〔R2:BLE3-09 / Low・規範2〕

- **対象**: `src/ble/session.js:670-681`(`try { parseMechStatus } catch { parseBiometricMechStatus }`)、`src/ble/index.js:782-788, 913-920`(`status()`/`lastStatus` が kind 非依存)。
- **参照**: `CHHub3Device.kt:291-301`(Hub3 は 81 を `CHWifiModule2NetWorkStatus` として型で解釈)。SDK は具象クラスが 81 の解釈を型で決める(Hub3=NetworkStatus / SS5=7B / Bot・Bike=3B / biometric=raw)。
- **問題**: kit の session は機種文脈を持たず「長さで lock/bot、失敗したら biometric 素通し」と推測するため、Hub3 の 1B payload が biometric 形で `lastStatus` にキャッシュされ、`hub3().onPublish`(parseNetworkStatus、v1 P3-16 で正)とファサード `status()` が同じ publish に別形を返す。規範2 の「フォールバック連鎖は未検証ポートの臭い」。
- **修正手順**: `SesameBle` constructor で kind を session に渡し(`mechStatusKind: "lock"|"bot"|"hub3"|"biometric"`)、81 ハンドラを kind で静的ディスパッチ(lock=7B / bot=3B / hub3=parseNetworkStatus / biometric=素通し。長さ不一致は推測せず明示エラーログ)。try/catch 連鎖を消す。
- **テスト**: `tests/ble/`(session/hub3)に kind 別 81 ディスパッチを固定。
- **受け入れ基準**: 同一 publish に対し facade と onPublish が同形を返す。

#### P3-19. biometric hexNameToBytes の奇数長落としと虚偽コメントを修正〔R2:BLEP-14 / Medium・規範8〕

- **対象**: `src/ble/biometric.js:114-120`(`hexNameToBytes` が奇数長の末尾ニブルを捨てる)、`:108-110`(「Kotlin chunked と同挙動」コメント)。利用: cardChangeData/fingerPrintChangeData/passcodeChangeData/faceChangeData。
- **参照**: `CHCardCapableImpl.kt:162`(`hexName.chunked(2).map { it.toInt(16).toByte() }` — 末尾 1 文字を残し `"c"→0x0c` として 1B 出力)。
- **問題**: 入力 `"abc"` で JS=`ab` / Kotlin=`ab0c`。`:108-110` コメントは Kotlin 実挙動と**逆の虚偽**。name が 16B UUID(偶数長)で起きにくいが規範1 のバイト 1:1 違反。
- **修正手順**: `for (let i=0;i<len;i+=2) out.push(parseInt(hexName.slice(i,i+2),16) & 0xff)`(奇数長末尾 1 文字も 1B 化)。コメントを実態に訂正。
- **テスト**: 奇数長入力(`"abc"`/`"abcde"`)で Kotlin と一致するバイト列。
- **受け入れ基準**: 奇数長で参照と一致、コメントが正しい。

#### P3-20. WM2 networkStatus() 送信経路(SDK 非存在の発明)を削除〔R2:BLEP-15 / Low・規範2〕

- **対象**: `src/ble/wm2.js:428-430`(`networkStatus()`)、`:513-517`(`WM2_RPC_OPS["wifi.networkStatus"]`)。
- **参照**: `CHWifiModule2Device.kt:502-510`(NETWORK_STATUS(6) は publish **受信のみ**)、`CHWifiModule2.kt:30-39`(公開 API に networkStatus 要求は無い)。
- **問題**: SDK に NETWORK_STATUS 送信(要求)経路は無いのに空 data で 6 を送る `networkStatus()` と RPC op が残存(v1 BLEP-07 で注記化したが捏造 op 自体は残置)。受信は onPublish の `{kind:"networkStatus"}` で足りる。
- **修正手順**: `networkStatus()` メソッドと `ble.wifi.networkStatus` RPC op を削除し、JSDoc を「状態は onPublish の networkStatus を購読」に誘導。RPC 削除は experimental なので契約上許容(P4-1 changelog に記載)。
- **受け入れ基準**: 発明 op が消え、受信経路に一本化。

#### P3-21. OS3 facade autolock() 成功後の mechSetting キャッシュ更新〔R2:BLE3-08 / Low〕

- **対象**: `src/ble/index.js:906`(`autolock()` が成功後に `autoLockSecond` を更新しない)。
- **参照**: `CHSesame5Device.kt:96-105`(autolock 応答時に `mechSetting?.autoLockSecond = delay`)。kit は configureLockPosition/opSensorControl では局所更新するのに autolock だけ非対称な抜け。
- **修正手順**: `session.js` に `autolock(seconds, opts)`(request 後 `_lastMechSetting` を `autoLockSecond: seconds` で更新、無ければ lock/unlock=0 で新規作成 — configureLockPosition と同流儀)を追加し facade を委譲。
- **テスト**: 「autolock 成功後 lastMechSetting.autoLockSecond が更新」を `session-mechsetting.test.js` に追加。
- **受け入れ基準**: 次の mechSetting publish 前でもキャッシュが整合。

#### P3-22. OS2 initial トークンの 4B 切り詰め防御を撤去 or 注記〔R2:BLE2-13 / Low・規範2〕

- **対象**: `src/ble/os2/session.js:534-536`(`this._mSesameToken = Buffer.from(token.subarray(0, 4))`、`<4B` 無視)。
- **参照**: `CHSesame2Device.kt:519`(`mSesameToken = receivePayload.payload` — 全長を切り詰めも検証もせず使う)。
- **修正手順**: 全長を保持し、`sessionToken()` 側の 4B 検証(`protocol.js:77`)で明示エラーに倒す(黙って切らない)。現挙動を残すなら「Kotlin は全長使用、実機 4B 前提の意図的逸脱」と注記。
- **受け入れ基準**: 出典なし切り詰めが解消 or 注記される。

#### P3-23. OS2 cipher の sessionToken 8B 固定と registration 可変長注記の矛盾を解消〔R2:BLE2-14 / Low〕

- **対象**: `src/ble/os2/cipher.js:84-86`(8B 以外 throw)、`src/ble/os2/protocol.js:158-162`(「registration の sessionToken 長は serverToken 依存。SDK の連結を再現」)、`session.js:299`。
- **参照**: `SesameOS2BleCipher.kt:7`(長さ検証なし、nonce=counter5B+token が CCM 13B 以下なら動く)、`CHServerAuth.kt:54`(`serverToken = ByteArray(4)` → 正準 st は 4B → registration トークンも 8B)。
- **問題**: protocol.js は「可変長を再現」と言い cipher.js は 8B 固定で弾く。自己矛盾。
- **修正手順**: cipher を「1..8B 許容(nonce 13B 制約由来)+ 8B 以外は警告ログ」にするか、protocol.js 注記を「st は 4B 固定(`CHServerAuth.kt:54`)。kit は 8B 固定で検証」に訂正して整合。
- **受け入れ基準**: 注記とコードが一致。

#### P3-24. Bot1 固有の status 意味論(state 2 値・isStop の motorStatus 由来)を分化〔R2:BLE2-15 / Low〕

- **対象**: `src/ble/os2/protocol.js:459-493`(全機種共通で state=locked/unlocked/moved、`isStop=(flags&1)==0`)。
- **参照**: `CHSesameBotDevice.kt:303,346`(Bot は `isInLockRange ? Locked : Unlocked` の 2 値、moved 無し)、`:286-293,334-344,472-479`(`isStop` は motorStatus 0/2→true,1/3→false で都度再計算、クラス初期値を上書き)。Sesame2/Bike は moved あり。
- **問題**: Bot1 で「どちらの range にも居ない」フレームを kit が `moved` と返す(SDK は Unlocked)。`isStop` も motorStatus 由来値と食い違うケースがある。
- **修正手順**: `parseMechStatus(buf, {kind})` または Bot 専用パーサで state 2 値化と `isStop = motorStatus 0/2→true,1/3→false,else false` を Bot で適用。facade は model(ssmbot_1)から選択。ベクタは `CHSesameBotDevice.kt:286-293` から導出を明記。
- **受け入れ基準**: Bot1 の status が SDK と一致。

#### P3-25. OS2 の fw_version 符号と getAutolock 桁上限の 1:1 化〔R2:BLE2-16 / Low〕

- **対象**: `src/ble/os2/protocol.js:593`(`fwVersion = payload[4]` 符号なし)+ `session.js:653`、`src/ble/os2/index.js:204`(`readUIntLE(0, length)` は length>6 で throw)。
- **参照**: `CHSesame2Device.kt:628`(`fw_version = loginPayload[4]` は符号付き Byte)+ `:262`(`fw_version >= 1` は 0x80+ で負となりガード不成立)、`:159`(autolock 応答を最大 8B parse)。
- **問題**: kit は fw 128..255 を「>=1」と判定し送る。getAutolock は 6B 超で throw(実ファーム値では未発生だが 1:1 逸脱)。
- **修正手順**: `fwVersion` を `readInt8(4)` に(公開値互換に注意するなら判定側だけ符号付き化)。`getAutolock` は length>6 で上位 0 なら下位 6B 読む等の明示処理。境界ケースをテスト追加。
- **受け入れ基準**: 符号・桁が参照と一致。

#### P3-26. OS2 mechStatus publish の自動履歴読み出し非実装を明文化〔R2:BLE2-17 / Low・逸脱注記〕

- **対象**: `src/ble/os2/session.js:518-523`(mechStatus publish はリスナ通知のみ)、`protocol.js:439`(コメントは「retCode 0 以外は履歴読み出しトリガ」と参照挙動を書くが session 未実装)。
- **参照**: `CHSesame2Device.kt:543-553`(mechStatus publish で `retCode != 0` または `target == Short.MIN_VALUE` のとき READ history を自動送出しサーバ POST)。
- **問題**: kit は `history()` 手動 API のみ。SDK の自動ドレインが無いとデバイス内履歴が溜まる(機能は壊れない)が、未実装がどこにも明記されていない。
- **修正手順**: 意図的逸脱として session/facade JSDoc・README Known limitations に「SDK の自動履歴読み出し(`CHSesame2Device.kt:543-553`)は kit では手動 `history()`」と明記。または opt-in(`autoReadHistory:true`)で SDK 挙動を再現。
- **受け入れ基準**: 逸脱が明文化される。

#### P3-27. OS3 session の同一 itemCode 同時 request 意味論を注記 or 直列化〔R2:BLE3-10 / Low〕

- **対象**: `src/ble/session.js:426-440`(item ごとの FIFO キューに積み常に送信)。
- **参照**: `CHSesameOS3.kt:349-372`(同一 itemCode が in-flight の間は新コマンドをワイヤに出さず callback 差し替えのみ、2s 経過で前回 callback 破棄)。
- **問題**: SDK は重複送信を抑止するが kit は両方送る(lock 連打で SDK 1 フレーム/kit 2 フレーム)。kit の FIFO 対応付けは健全だが観測可能な差。
- **修正手順**: 厳密 1:1 なら request() に「同一 itemCode の in-flight があればキューに積み送信は応答後」(直列化)を入れる。現状維持なら JSDoc に「SDK は重複送信を抑止する」意味論差を明記し意図的乖離として固定。**P4-1 の前に方針決定**(契約面に出るため)。
- **受け入れ基準**: 意味論差が解消 or 明記される。

---

## Phase 4 — 経路対称性・契約

> 「ライブラリで出来ることは全経路で出来る」コンセプトの回復と契約の整合。P4-1 を先に行い、以後の面変更が version に反映されるようにする。

#### P4-1. CONTRACT_VERSION を bump し「メソッド集合 ↔ バージョン」連動テストを導入〔R2:SURF-27 = R2:DOC-04 / Medium・規範7〕

- **対象**: `src/serve/jsonrpc.js:14-28`(changelog が 1.2.0 で終了、`CONTRACT_VERSION="1.2.0"`)、`schema/openrpc.json`(`info.version`/`x-contractVersion`/`x-apiVersion` = 1.2.0)。
- **問題**: v1 リリース(116 メソッド)→ HEAD(198 メソッド、+82: ble.* typed 74・cloud.ping・config.sync* 等)、event topic deviceListChanged 追加、stable の lock.click/device.history/device.battery に optional param 追加(破壊的変更は無し)。jsonrpc.js 自身の「後方互換追加は minor」ポリシーに反し版が据え置きで、消費者が apiVersion で機能検出できない。
- **修正手順**:
  1. `CONTRACT_VERSION` を **1.3.0** に bump し changelog に追加内容を記載。`npm run build` で openrpc/SDK 再生成。
  2. `tests/openrpc-contract.test.js` に「openrpc のメソッド名集合 + x-event-topics のハッシュ ↔ CONTRACT_VERSION」の固定テストを追加し、集合が変わったのに版が同じなら fail させる(規範7 の機械強制)。
  3. Phase 1 の面追加(P1-7 ble.scan、P1-8 records 形変更)と Phase 4 の追加(P4-4/P4-5)を反映してから最終 bump する(順序: 面変更 → bump)。
- **受け入れ基準**: version が面集合と連動し、テストが乖離を検出する。

#### P4-2. 「呼び出し側不正」の CLI 終了コードを経路間で統一(bad_params→2)〔R2:SURF-28 / Medium〕

- **対象**: `src/cli/serve.js:194`(toServeError: bad_params→exit 2)、`src/cli/errors.js:94-100`(runtimeExitCode は SesameError(BAD_REQUEST) を特別扱いせず 1)、`src/cli.js:275`。
- **問題**: 同一の失敗(不明な remote 名・必須引数欠落をライブラリ層が検出)が、`sesame rpc ir.send` 経由では exit 2、直接 `sesame send` では exit 1。README 契約「2=usage」の解釈が経路で割れている。
- **修正手順**: `runtimeExitCode`(または run() catch)に「`err instanceof SesameError && err.code === ERR.BAD_REQUEST` → EXIT.USAGE」を追加し rpc 経路(bad_params→2)と一致させる。`tests/cli/errors.test.js` / `rpc-exit-mapping.test.js` に対称ケースを追加。
- **受け入れ基準**: 呼び出し側不正の exit code が経路非依存で 2。

#### P4-3. BLE allowlist・RPC op 表の逆方向網羅テストを追加〔R2:SURF-29 / Medium・規範4〕

- **対象**: `tests/ble/rpc-allowlist.test.js`(表→実在の片方向のみ)、`src/ble/index.js:108-158`(「足したらここにも足す」コメント運用)。
- **問題**: SesameBle/SesameOS2Ble に公開メソッドを追加しても allowlist/RPC op への追加漏れを検出するテストが無い(fail-closed なので安全側だが経路対称性は黙って欠ける)。v1 P4-2 の invokePath 実装(default-deny・getter 解決前拒否・`_`/constructor/prototype 拒否)は正しいことを確認済み。
- **修正手順**: 「prototype の公開メソッド+getter 列挙 − 明示除外集合(connect/close/use/register/registerOnce/connectMany/listNearby/fromDiscovery/onStatus) == allowlist」の完全一致と、「allowlist − 制御 verb/読み取り getter 除外 ⊆ BLE_RPC_OPS のキー第1セグメント」を固定。
- **受け入れ基準**: ファサード拡張時に非対称が CI で検出される。

#### P4-4. 生体 REST 4 メソッドを CLI に公開〔R2:SURF-30 / Medium・規範4〕

- **対象**: `src/client.js:1010-1047`(postAuthenticationData/putAuthenticationData/deleteAuthenticationData/updateAuthenticationName)、`src/serve/registry.js:943-988`(RPC は有)、`src/cli/access.js`(コマンド不在)。
- **問題**: SigV4 biometrics REST へ CLI から到達する手段が無い(`sesame rpc access.postAuthenticationData` は serve 起動前提)。
- **修正手順**: `src/cli/access.js` に `access auth-data post|put|delete|name` を追加(`--operation --device-id --items <json>` / name は kind+フィールド)。出力は ctx.out の --json 契約に乗せる。
- **受け入れ基準**: CLI 単体で 4 op が叩ける(@experimental 維持)。

#### P4-5. OS2 管理系 op(reset/configureLockPosition/status)に typed RPC を追加〔R2:SURF-31 / Medium・規範4〕

- **対象**: `src/ble/index.js:206-233`(OS2_TOPLEVEL_RPC_OPS に無い)。対比: OS3 は `ble.reset`/`ble.position`。
- **問題**: 「制御 verb は cloud lock.* と重複のため載せない」除外根拠は reset/configureLockPosition には当てはまらない(cloud に該当機能なし)。OS2 工場リセット・角度設定が型付き面から見えない。
- **修正手順**: OS2_TOPLEVEL_RPC_OPS に `"reset":{params:[],result:"ack"}`、`"configureLockPosition":{params:[{lockDeg},{unlockDeg}],result:"ack"}` を追記(allowlist 掲載済みなので spec 追記で registry→4 面へ自動伝播)。`status` 読みは raw 追加 or 除外方針をコメント明文化。P1-3(OS2 CLI ルーティング)と同マイルストーン推奨。
- **受け入れ基準**: OS2 管理系が typed RPC/SDK に現れる。

#### P4-6. 宙吊り公開 API syncRemotesFromServer / listRemotesFromDevices の配線判断〔R2:SURF-32 / Medium〕

- **対象**: `src/client.js:591-600`(`syncRemotesFromServer` — 呼び出し元ゼロ)、`:561`(`listRemotesFromDevices` — CLI 内部利用のみ)。
- **問題**: ライブラリ公開メソッドだが CLI・RPC・SDK・docs から到達不能(経路対称性対象)。
- **修正手順**: (a) `config.syncRemotesFromServer` RPC + `sesame remote sync-from-server <hub3> <irType>` を追加して対称化、または (b) @deprecated を付け次 minor で ConfigStore 内部へ降格 — いずれか方針決定。listRemotesFromDevices は読み取り系なので `config.listRemoteCandidates` 等で RPC 公開すると対話 add の SDK 版が組める。
- **受け入れ基準**: 公開面が全経路到達可能 or 内部降格される。

#### P4-7. status result schema の nullable 化と fixture の実値化〔R2:SURF-33 / Low〕

- **対象**: `src/serve/result-schemas.js:59-62`(subUUID non-nullable)、`src/serve/registry.js:458-464`(未接続時 subUUID=null)、`src/serve/daemon.js:89`(authState=ok|degraded|expired)、`tests/fixtures/upstream/status.json`(authState:"authenticated" は emit されない値)。
- **修正手順**: subUUID を `nullable(STR)`、authState を `enum:["ok","degraded","expired"]` に変更し、fixture を実値+degraded 形(subUUID:null)サンプルに修正。SDK 再生成。
- **受け入れ基準**: 型契約が実 emit と一致、degraded 形が検証される。

#### P4-8. events.subscribe/unsubscribe の topics param に enum schema を付与〔R2:SURF-34 / Low〕

- **対象**: `src/serve/registry.js:1243,1258`(schema なし → SDK 型 `topics: unknown`/`Any`)。
- **修正手順**: 両エントリ params に `schema:{type:"array",items:{type:"string",enum:[...SUBSCRIBABLE_TOPICS]}}` を付与(定数は同ファイル)。生成系は enum を union/Literal に変換済みで自動追従。
- **受け入れ基準**: SDK の subscribe 引数が SesameEventTopic union 型になる。

#### P4-9. thin client 間の表面不一致を解消〔R2:SURF-35 / Low〕

- **対象**: `clients/python/sesame_client.py:60`(`class SesameError` — v1 ARCH-19 の改名未適用)、`clients/js/sesame-client.mjs:44-55`(SesameRpcError + alias)。便宜メソッド: js={unlock,lock,status,devices} / py={unlock,lock,toggle,devices,status}。
- **修正手順**: clients/python に `SesameRpcError` を正名導入し `SesameError = SesameRpcError` の deprecated alias を残す。clients/js に `toggle()` を追加(または両者の便宜面を README で固定)。
- **受け入れ基準**: 2 thin client のエラー名・便宜面が一致。

#### P4-10. Hub3 UUID を指す param 名の不統一を alias で吸収〔R2:SURF-36 / Low〕

- **対象**: `hub3DeviceId`(ir.listKeys/learn/addRemoteToMatter)vs `deviceId`(presetir.sendIR)vs `--device`(CLI iot raw)。
- **修正手順**: 破壊的変更を避け、presetir.sendIR に `hub3DeviceId` alias を追加(handler 内で deviceId へ写像)、desc に正準名を明記、openrpc description で相互参照。
- **受け入れ基準**: 同一概念の正準名が示され alias で受理される。

#### P4-11. stable メソッドに RESULT_SCHEMAS を強制する整合テスト〔R2:SURF-37 / Low〕

- **対象**: `tests/serve/result-schemas-contract.test.js`(orphan 方向のみ)、`src/serve/stability.js` STABLE_METHODS。
- **修正手順**: 「STABLE_METHODS のキー(rpc.discover 除く)⊆ RESULT_SCHEMAS のキー」を 1 アサーション追加(新 stable 昇格時のスキーマ漏れ→SDK 戻り型 unknown を防ぐ)。
- **受け入れ基準**: stable 昇格時にスキーマ欠落が CI で落ちる。

#### P4-12. gRPC 生成物に stability コメントを伝播〔R2:SURF-38 / Low〕

- **対象**: `scripts/gen-grpc-proto.mjs:79-94`(rpc 宣言にコメントなし)。対比: TS=JSDoc/Py=docstring/openrpc=x-stability。
- **修正手順**: `generateProto` で `stabilityOf(name)` を読み各 rpc 宣言直前に `// experimental (unverified)` 等を出力(drift テストは生成関数共有で自動追従)。
- **受け入れ基準**: protoc 消費者が stable/experimental を判別できる。

#### P4-13. lock 系 raw 脱出口の方針確定〔R2:SURF-40 / Low〕

- **対象**: `src/client.js:704`(triggerLockRaw)、`:1243`(triggerLockDevice)— RPC/CLI 不在。対比: iot/webapi/ble は脱出口公開済み。
- **修正手順**: 意図的に閉じるなら `docs/api-stability.md` に「lock raw は経路非公開(誤爆リスク)」と明文化。公開するなら `lock.raw {name|deviceUUID+secretKey, cmd}`(experimental)を追加。
- **受け入れ基準**: 脱出口ポリシーが全経路で一貫(公開 or 明示的に閉鎖)。

---

## Phase 5 — アーキテクチャ刷新・衛生

> P5-1(エラー設計)は serve 到達面に広く効くため Phase 4 と調整して進める。他は独立。

#### P5-1. エラー設計の乖離是正 — 呼び出し側不正が serve 経由で internal に化けるのを止める〔R2:ARCH-02 / High〕

- **対象**: `src/errors.js:8-28`(ポリシー)、写像 `src/serve/jsonrpc.js:194-228`、`throw new Error(` が src に **186 箇所**(grep 実測)、うち **90 箇所が t()/tr() で i18n 済みメッセージを素の Error で投げる**。具体経路: RPC `ir.send`(`registry.js:815-819`)→ `hub.send()` → `client.js:385` `throw new Error(t("domain.client.unknownKey"))` → JSON-RPC で `kind=internal` に化ける(利用者の入力ミスが internal_error)。英語ハードコードの利用者向けエラー: `auth.js:174`、`auth.js:435`(素 Error + 未 i18n + アクション要求文)、`secure-fs.js:203`。
- **問題**: errors.js は「呼び出し側不正 = badRequest/SesameError(BAD_REQUEST)」と明文化するのに、利用者向けと自認(i18n 済)の Error が素で投げられ internal に落ちる。client.js は serve の hub 実体なので 15 箇所全てが RPC 到達面。
- **修正手順**:
  1. 90 箇所を「方針1(badRequest/UNAUTHENTICATED へ変換)」と「方針3(plain Error のまま + 注記コメント)」に仕分けする一括パス。優先順は serve 到達面(client.js → transport.js → ble facade 入口)。`config.js:374` のような正当な plain Error(内部不変条件)は注記して残す。
  2. `auth.js:174`/`435`・`secure-fs.js:203` を i18n キー化し、`auth.js:435` は SesameError(UNAUTHENTICATED) に。
  3. 回帰防止に「serve 到達面の全 method × 代表 bad input で `error.data.kind !== "internal"`」のテーブル駆動テストを追加。
- **受け入れ基準**: 呼び出し側不正が RPC で bad_params 系に分類され、利用者向けエラーが i18n される。

#### P5-2. serve/registry.js の topLevelEntries() 808 行モノリスを分割〔R2:ARCH-03 / Medium〕

- **対象**: `src/serve/registry.js:411-1218`(単一関数 808 行、約 40 method + ローカル helper)。
- **問題**: v1 P5-3 で cli.js(2497 行)を分割した基準を当てれば分割対象。1 method の修正に 800 行スコープを読む必要があり diff 事故も起きやすい。
- **修正手順**: `src/serve/entries/{auth,config,lock,ir,device,ble,events}.js` へ「`Record<string, MethodEntry>` を返す純関数」として機械分割し、registry.js は merge と build* だけ残す。キー順を保持して挙動不変。`tests/serve/registry-wiring.test.js` と openrpc-contract がドリフト検査になる。
- **受け入れ基準**: registry.js が縮小し、生成物ドリフトなし。

#### P5-3. CLI→serve の過剰結合を細線化(helper を葉モジュールへ)〔R2:ARCH-04 + R2:SURF-39(WiFi 収集部) / Medium〕

- **対象**: `src/cli.js:43-44` → `src/cli/ble.js:31`(registry から invokePath/collectWifiScan/wifiViewOf/bleCommandAck を import)、`src/cli/serve.js:1-20`(daemon+全 framing 静的 import)、`src/serve/registry.js:72-76`(モジュールスコープで rpc-params.generated.json 2124 行を readFileSync+JSON.parse)。
- **問題**: `sesame lock` でも cli/ble.js・cli/serve.js の静的 import で registry 全体 + 生成 JSON 読込 + 全 framing が毎回評価される。cli/ble.js が registry から欲しいのは helper 数個。session-ui を動的 import で遅延させた設計と不整合。さらに `collectWifiScan/wifiViewOf` は serve 配下にあり package exports 非掲載でライブラリ消費者が import 不可(SURF-39 の WiFi 部)。
- **修正手順**:
  1. `invokePath`/`reviveJsonArg` と WiFi 収集 helper(collectWifiScan/wifiViewOf)を葉モジュール `src/ble/rpc-helpers.js`(or `src/serve/invoke-path.js`)へ移し、registry.js と cli/ble.js 双方からそこを import。WiFi helper は `src/ble/` 側に置き ble/index.js から再 export(ライブラリ消費者にも開放)。
  2. cli/serve.js の framing 群と daemon を `registerServeCommand` の action 内で動的 import に変える(optional-deps.js の既存パターン流用)。
- **受け入れ基準**: serve 無関係コマンドの起動が serve 層をロードしない。WiFi 収集がライブラリから import 可能。

#### P5-4. UUID 正規化・整形の 14+3 重実装を統合〔R2:ARCH-05 / Medium〕

- **対象**: 同一実装 `s.replace(/-/g,"").toLowerCase()` が client.js:108 / lock.js:256 / iot.js:501 / config.js:898 / cli/ble.js:927 / cli/iot.js:531 / ble/index.js:262 / ble/transport.js:88、変種(toLowerCase なし)が ble/wm2.js:85 / ble/hub3.js:45 / ble/biometric.js:64、インライン cli/device.js:156,197-199 / cli/remote.js:138。`hexToUuid`(ダッシュ挿入)が transport.js:119-122 / wm2.js:306 / hub3.js:238 の 3 重。
- **問題**: 同義関数 14 箇所 + hexToUuid 3 重。toLowerCase の有無という意味差が暗黙に紛れ、片側だけ正規化のバグを生みやすい。
- **修正手順**: `src/crypto.js`(既に uuid helper がある)に `normalizeUuid(s)`(空安全・lowercase)と `hexToUuid(hex32)`(transport.js:119 の検証付き実装を採用)を export し全箇所を置換。toLowerCase 不要だった箇所(wm2/hub3 の鍵導出)は意味を確認しコメントで使い分けを明示。types/ 再生成。
- **受け入れ基準**: 重複が 1 箇所に集約され、意味差が明示される。

#### P5-5. JWT claim デコードの 4 重実装を統合〔R2:ARCH-06 / Low〕

- **対象**: `src/auth.js:65-73`(jwtExp)/`:80-88`(jwtAud)/`:96-104`(jwtSub)、`src/tokens.js:72-82`(jwtExpSec — 「auth.js と同じロジックを複製」と自認)。
- **修正手順**: `src/auth.js` に `jwtClaim(token, name)` を実装して 3 関数を 1 行化・export し、tokens.js の複製を削除(逆向き依存が嫌なら src/util.js へ)。
- **受け入れ基準**: claim デコードが 1 実装に集約。

#### P5-6. ir.js の購読ペア(subscribeIRData/subscribeIRMode)の同形重複を統合〔R2:ARCH-07 / Low〕

- **対象**: `src/ir.js:325-352` と `:355-388`(コメント自身が「同形」と明記)。
- **修正手順**: `makeIrSubscription(client, {subOp, unsubOp, rspKey, topic, deviceId, companyID})` に共通化(ir.js 内 private)。
- **受け入れ基準**: 30 行重複が解消。

#### P5-7. cli/lock-ops.js ⇄ session.js の実行時循環を解消〔R2:ARCH-08 / Medium〕

- **対象**: `src/cli/session.js:15`(lock-ops を静的 import)⇄ `src/cli/lock-ops.js:243-244`(循環回避のため session を動的 import)。src 全体で実行時循環はこの 1 組のみ(他は型 import で無害)。
- **問題**: 共有実装(bleExec/fmtMech)が「単発実行」側に置かれ、遅延 import は症状回避にすぎない。
- **修正手順**: `bleExec`/`fmtMech`(+必要なら resolveLockEntry)を `src/cli/exec.js`(or ctx.js)へ抽出し、lock-ops/session 双方がそこへ依存する形に直して動的 import を撤去。P1-3(OS2 ルーティング)が runBleOp を触るので同時実施が効率的。
- **受け入れ基準**: 動的 import が消え循環が無くなる。

#### P5-8. ファイル外参照ゼロの export 41 件を整理〔R2:ARCH-10 / Low〕

- **対象**: (a) CLI 内部 helper の不要 export(cli/auth.js `bootstrapAfterLogin`、cli/lock-ops.js `resolveLockEntry`、cli/session.js `sessionLabel` 等、cli/migrate.js `parseDotenv`)、(b) 公開 subpath の偶発 API 化(config.js `deriveIrOperation` が types/config.d.ts に公開、crypto.js `PRODUCT_TYPE`/`MIN_*_BYTES`、devices.js `DEFAULT_REGISTER_BASE_URL`、aws-credentials.js `AWS_REGION`)、(c) 意図的公開面(biometric.js の *Data ビルダ 21 件 — 削除対象外)。
- **修正手順**: (a) export 削除(テスト seam が要るものは `@internal` 注記+テスト追加)。(b) 意図確認の上、内部なら export 削除で d.ts から消す(strip-private-decls は `_` プレフィクスのみ対象で本ルート漏出を防げない)。(c) 現状維持 + contract テストで固定するならコメント。
- **受け入れ基準**: 偶発公開 API が d.ts から消え、内部 helper が非 export 化。

#### P5-9. i18n カタログ完全性テストの追加〔R2:ARCH-11 / Low〕

- **対象**: `src/i18n.js:34-38`(Object.assign マージ、重複キー黙殺)、`tests/setup.i18n.js`(全テスト ja 固定)、`tests/i18n.test.js`(機構のみ)。
- **問題**: 本番既定は en なのにテストは ja を検証。en キー欠落は t() がキー文字列を返すだけで落ちない。現時点は en/ja 1281 キー一致・重複 0 だが守る仕組みが無い。
- **修正手順**: `tests/i18n.test.js` に (1) en/ja キー集合一致 (2) 領域間キー重複ゼロ (3) `{var}` プレースホルダの en/ja 一致 の 3 アサーションを追加(カタログ import で機械検査)。
- **受け入れ基準**: カタログ非対称が CI で検出される。

#### P5-10. serve 層の非 i18n RpcError リテラル 5 箇所を i18n 化〔R2:ARCH-12 / Low〕

- **対象**: `src/serve/registry.js:125`(`unsupported JSON argument key`)、`:177`(`missing required param: op` — 直下の need() は t() 使用で不整合)、`:180/:186/:193`(`unsupported BLE op`)。
- **修正手順**: `serve.unsupportedJsonKey`/`serve.unsupportedBleOp` キーを `src/i18n/serve.js` に追加して置換(`:177` は既存 serve.missingParam を再利用)。
- **受け入れ基準**: serve のエラーが全て i18n 経由。

#### P5-11. CI に生成 SDK のコンパイル検査を追加〔R2:ARCH-13 / Medium〕

- **対象**: `.github/workflows/ci.yml`(typecheck:sdk / check:sdk:py のステップなし)、package.json scripts(ローカル専用)、`tests/sdk-*-contract.test.js`(byte 一致のみ)。
- **問題**: 生成物 `sdk/ts/sesame-client.ts` は CI で一度も tsc を通らず、`sdk/python` も同様(clients/python の e2e は別物)。生成器が不正構文/型を出すリグレッションがドリフト一致では検出できない。biome lint は tests/ を対象外。
- **修正手順**: ci.yml の test job(build 直後)に `npm run typecheck:sdk` を追加、python3 セットアップ+`npm run check:sdk:py` を追加。tests/ の lint は別 override(緩め)で includes に足す。
- **受け入れ基準**: 壊れた生成 SDK が CI で落ちる。

#### P5-12. secure-fs の stale lock 奪取の競合窓を rename ベースに修正〔R2:ARCH-14 / Low〕

- **対象**: `src/secure-fs.js:196-200`(stale 判定→`unlinkSync(lockPath)`→continue)、自認コメント `:93-95`。
- **問題**: P1/P2 が同時に stale を観測→P1 が unlink+再取得→遅れた P2 の unlink が **P1 の新鮮な lock を消す**→二重保持(P2-8/P1-6 が防ぎたい lost-update そのもの)。`sleepSync`(Atomics.wait)は serve のイベントループを最大 timeoutMs ブロックする。
- **修正手順**: 奪取を「`renameSync(lockPath, ${lockPath}.reap.${pid})` → rename 勝者だけが unlink」に変える(rename は原子的で勝者一意)。可能なら fd の ino と stat の ino 比較で対象同一性を確認。`tests/secure-fs-lock.test.js` に「stale 観測後・unlink 前に別プロセスが取得済み」の interleave を fault-injection で追加。
- **受け入れ基準**: 同時奪取で二重保持が起きない。

#### P5-13. 細部衛生(XDG 相対パス・deprecated API・npm 同梱物)〔R2:ARCH-15 / Low〕

- **対象/修正**: (1) `src/paths.js:19-20` — XDG_CONFIG_HOME が相対のとき cwd 基準で解決してしまう(仕様は相対を無視)。`if (xdg && isAbsolute(xdg))` ガードを追加。(2) `src/presetir.js:180` — deprecated `String.prototype.substr` を `slice(i, i+2)` へ。(3) `package.json` `files` に scripts/ 全体と docs/ が含まれ開発スクリプトを配布物に同梱。scripts/ を外す(SDK 再生成を許すなら gen-*.mjs のみ列挙)。
- **受け入れ基準**: XDG 準拠、deprecated API 排除、配布物の最小化。

#### P5-14. パッケージングの workspace 分割(v1 繰越・次 major)〔v1 P5-1 段階2〕

- **対象**: ライブラリ利用者から CLI/TUI/serve 依存を外す段階2。段階1(optional peer 化)は v1 で実施済み(prod 依存は ws/commander/@inquirer/prompts まで縮小済み)。
- **修正手順**: 次 major で `@sesame-kit/core`(lib のみ)/`sesame-kit`(CLI/serve)等に workspace 分割。本書 Phase 1-5 の構造改善(P5-2 registry 分割、P5-3 結合細線化)を前提にすると分割境界が綺麗になる。
- **受け入れ基準**: core パッケージが CLI/serve/TUI を引かない。
- **備考**: 破壊的変更を伴うため Phase 1-5 完了・実機検証(§9)進捗後の major リリースに合わせる。

---

## Phase 6 — ドキュメント正直化・参照基盤

> docs を真とせず実装/参照で全数検証した結果の是正。特に「虚偽の制限」「動かないコード例」を最優先。各 Phase の修正 PR に随伴 + 最終一括。

#### P6-1. `sesame rpc lock.click --scriptIndex N` の動かないコード例を修正〔R2:DOC-01 / High〕

- **対象**: `docs/en/commands.md:352`、`docs/ja/commands.md:355`。
- **根拠**: `sesame rpc` のオプションは `--params/--socket/--subscribe/--paths/--http/--token` のみ。`rpc lock.click --scriptIndex 1` は `error: unknown option` で即死。RPC の lock.click には scriptIndex param が実在(stable)。
- **修正手順**: `sesame rpc lock.click --params '{"name":"...","scriptIndex":N}'` に書き換え(en/ja)。
- **受け入れ基準**: 記載例がそのまま動く。

#### P6-2. ble.md の「専用 CLI コマンドを持たない」虚偽主張を訂正〔R2:DOC-02 / High・虚偽の制限〕

- **対象**: `docs/en/ble.md:25-44`(特に 44 行「Bot2 script select/write/run-by-index, WM2/Hub3 provisioning, BLE OTA, factory reset, OS2 facade — has no dedicated CLI command」)、`docs/ja/ble.md:25-44`、`README.md:29`/`README.ja.md:29`。
- **根拠**: `src/cli/ble.js` に `script-run`/`script-select`/`script-write`/`ota`/`reset`/`wifi`/`position`/`invoke`/`os2-invoke` が実在(`ble --help` で確認)。`docs/{en,ja}/commands.md:322-344` はこれらを正しく記載しており**同一リポジトリ内でドキュメント同士が矛盾**。
- **修正手順**: ble.md のコマンド一覧を commands.md と同じ 19 コマンドに更新し、「専用 CLI なし」の対象を実際に無いもの(生体 add/delete/mode-set、Bike3 指紋書き込み等)だけに絞る。README の Bot2/Bot3 箇条書きに `ble script-run/script-select/script-write` を追記。
- **受け入れ基準**: ble.md/commands.md/README が相互整合し、虚偽の「無い」が消える。

#### P6-3. メソッド数・op 数の stale 数値を生成由来に置換〔R2:DOC-03 / Medium〕

- **対象**: `README.md:186`、`README.ja.md:187`、`docs/api-stability.md:142,161-162,227`、`docs/platform-roadmap.md:131-133`、`docs/en/integration.md:70`、`docs/ja/integration.md:70`(「135 メソッド」「ble.* 11 ops」)。
- **根拠**: openrpc.json は **198 メソッド**(stable 13/experimental 185)、ble.* は **74 ops**。「135」はどの時点とも一致しない。
- **修正手順**: 固定数の手書きをやめ生成時に schema 件数を埋めるか「`rpc.discover` で全列挙(現在 198)」に更新。api-stability の ble.* 行を「74 ops: 汎用 invoke/os2.invoke + 型付きラッパー」に書き直す。P4-1 の version bump と同 PR が自然。
- **受け入れ基準**: 数値が実体と一致 or 自動算出になる。

#### P6-4. thin client の対応トランスポート記載の虚偽を訂正〔R2:DOC-05 / Medium・虚偽の機能主張〕

- **対象**: `sdk/ts/README.md:9-10`(clients/js に「stdio」)、`sdk/python/README.md:97-98`(clients/python に「WebSocket」)、`clients/python/README.md:23-24`、`docs/en/architecture.md:91`/`docs/ja/architecture.md:124`。
- **根拠**: `clients/js/sesame-client.mjs:79-89` は unix/http/ws のみ(**stdio なし**)、`clients/python/sesame_client.py:109-122` は unix/stdio/http のみ(**WS なし**)。`README.md:231`/`integration.md:112` は正しい。
- **修正手順**: 4 箇所を「JS: Unix socket/HTTP/WebSocket、Python: Unix socket/stdio/HTTP」に統一。architecture.md の「equivalent」も書き分け。
- **受け入れ基準**: 存在しない接続方式の案内が消える。

#### P6-5. commands.md の欠落コマンドを追記〔R2:DOC-07 / Medium・doc 欠落〕

- **対象**: `docs/{en,ja}/commands.md`(iot節/access節/auth節/config節)。README は commands.md を「every command」と標榜。
- **根拠**(`<grp> --help` で確認): `iot wifi-clear`/`iot matter-open`/`iot add-sesame`/`iot rm-sesame`、`access cards name`/`cards post`、`access passcodes rm`/`clear`/`name`/`post`、`config path`/`config show`、`ble register --product-type/--address`、`ble os2-register --ak/--no-local-server-auth` が未掲載。
- **修正手順**: 上記を commands.md(en/ja)へ追記。
- **受け入れ基準**: help と commands.md が一致。

#### P6-6. 「BLE は invoke 経由」という serve 説明の stale を解消(typed 74 op 反映)〔R2:DOC-09 / Medium〕

- **対象**: `README.md:168,187`/`README.ja.md:169,188`、`docs/api-stability.md:90-92`、`docs/platform-roadmap.md:134-138`。
- **根拠**: openrpc に `ble.script.click`/`ble.biometric.cardAdd`/`ble.hub3.setWifiSSID` 等 74 の型付き BLE メソッドが実在。`docs/{en,ja}/integration.md:7` は正しく更新済み。
- **修正手順**: integration.md:7 の文面(「facade op ごとに型付き `ble.<op>`/`ble.os2.<op>`、invoke は escape hatch」)に揃える。
- **受け入れ基準**: BLE の公開面記述が実体(74 op)と一致。

#### P6-7. 自リポジトリ内 file:line 引用の整備(規範6 の一括適用)〔R2:BLE3-11 = ARCH-09 = CLOUD-07 = BLEP-16 = DOC-10 + AUTH-07(コメント部)〕

- **対象**(腐った自己参照 file:line、grep 実測):
  - `src/optional-deps.js:10`(「cli.js:1926」— cli.js は現 290 行、配線は cli/session.js:281 で実装済み。注記ごと obsolete)
  - `src/iot.js:33`(transport.js:395 — 現在は onReopen)、`src/lock.js:47`(transport.js:243-259 — 数行ズレ)、`src/access.js:169`(client.js:921)、`src/ble/index.js:802`(transport.js:189)
  - vendor 引用の行ズレ: `src/ble/dfu.js:5-7`/`src/ble/session.js:232-249,102,154`/`src/crypto.js:242`/`tests/ble/facade.test.js:444`(CHHub3Device.kt が現行 ref と +4 ズレ。dfu.test.js は正で不整合)、biometric.js:33,35,38(CHCardCapableImpl.kt の数行ズレ)
  - 存在しない参照ディレクトリ引用: `src/ble/protocol.js:4-6`(`references_esp32/.../ssm.c` 等)、`:50-53`(`references_ios/...`)
  - `REFERENCES.md:24`(`…/useOperateIoT.js` の誤ディレクトリ。実在は `references_web/src/hooks/`)
- **修正手順**:
  1. **自リポ内引用**(optional-deps/iot/lock/access/ble/index)はシンボル名に置換(規範6)。optional-deps.js:10 は配線完了の事実に合わせ全面書き直し。
  2. **vendor 引用の行ズレ**は現行 checkout の行番号へ一括更新(dfu.test.js が正なので機械的に揃う)。
  3. **protocol.js の ESP32/iOS 引用**は `_sesame_sdk_ref` の対応 Kotlin(SesameProtocols.kt/SesameBleReceiver.kt/SesameOS3BleCipher.kt 等)へ置換し、ESP32 の `ssm.c` 行引用は「未配置の補助資料」と明示 or 削除。iOS 引用は P3-16(RESULT[9])と連動。
  4. `REFERENCES.md:24` をフルパス `references_web/src/hooks/useOperateIoT.js` に修正。
  5. AUTH-07(P2-10)のコメント訂正も同 PR で。
- **受け入れ基準**: 全 file:line 引用が in-repo で解決し、自己参照はシンボル名になる(規範6 準拠)。

#### P6-8. README の overrides 記述(「単一 override」)を実構成(5 件)に訂正〔R2:DOC-08 / Medium〕

- **対象**: `README.md:90-96`/`README.ja.md:90-96`(snippet `"overrides": { "tar": "^7.5.16" }` +「この 1 つの override で」)。
- **根拠**: `package.json:220-226` の overrides は `@mapbox/node-pre-gyp`/`cacache`/`make-fetch-happen`/`node-gyp`/`tar` の 5 件。
- **修正手順**: snippet を実 5 件に更新し「tar の固定が核、node-gyp 系は新 major への引き上げ」等の現状理由を書き直す。
- **受け入れ基準**: npm audit 0 の根拠説明が実構成と一致。

#### P6-9. README/promo の軽微 stale を訂正〔R2:DOC-11, R2:DOC-12 / Low〕

- **対象/修正**:
  - `promo/show-hn.md:44`(「ペアリング非対応」— OS3/OS2 の BLE 初期登録が実装済み。`sesame ble register`/`os2-register`)。公開前に「factory-reset デバイスの BLE ペアリングも可(実機未検証)」へ。promo/ は gitignored ドラフトのため公開時対応で可。
  - `README.md:65-71`/`README.ja.md:65-71`(「`npm install` が引き込むのは 3 つだけ」が optionalDependencies の noble を捨象)。「必須 runtime 依存は 3 つ。加えて optional の noble が導入試行される(失敗しても本体は動く)」へ精緻化。
- **受け入れ基準**: ペアリング能力・依存導入の記述が実態と一致。

---

## 7. 領域別所見インデックス(原典 ID → 計画項目)

> 各監査エージェントの原典所見がどの計画項目に対応するかの逆引き。重大度は監査時点の評価。

| 原典 R2 ID | 重大度 | 計画項目 |
|---|---|---|
| AUTH-01 | High | P2-2 |
| AUTH-02 | Medium | P2-3 |
| AUTH-03 | Medium | P2-4 |
| AUTH-04 | Low | P2-5 |
| AUTH-05 | Low | P2-7 |
| AUTH-06 | Low | P2-6 |
| AUTH-07 | Low | P2-10 / P6-7 |
| AUTH-08 | Low | P2-9 |
| AUTH-09 | Low | P2-8 |
| AUTH-10 | Low | P2-1 |
| CLOUD-01 | High | P1-4 |
| CLOUD-02 | Medium | P1-5(=BIZ-03) |
| CLOUD-03 | Medium | P3-1 |
| CLOUD-04 | Medium | P3-2 |
| CLOUD-05 | Low | P3-17(=BLE3-06) |
| CLOUD-06 | Low | P3-10 |
| CLOUD-07 | Low | P6-7 |
| CLOUD-08 | Low | P3-11 |
| CLOUD-09 | Low | P3-12 |
| CLOUD-10 | Low | P3-13 |
| BIZ-01 | Medium | P3-3 |
| BIZ-02 | Medium | P3-4 |
| BIZ-03 | Medium | P1-5(=CLOUD-02) |
| BIZ-04 | Low | P3-5 |
| BIZ-05 | Low | P3-6 |
| BIZ-06 | Low | P3-7 |
| BIZ-07 | Low | P3-8 |
| BIZ-08 | Low | P3-9 |
| BLE3-06 | Medium | P3-17(=CLOUD-05) |
| BLE3-07 | Medium | P3-16 |
| BLE3-08 | Low | P3-21 |
| BLE3-09 | Low | P3-18 |
| BLE3-10 | Low | P3-27 |
| BLE3-11 | Low | P6-7 |
| BLE2-10 | Critical | P1-1 |
| BLE2-11 | Medium | P3-14 |
| BLE2-12 | Medium | P3-15 |
| BLE2-13 | Low | P3-22 |
| BLE2-14 | Low | P3-23 |
| BLE2-15 | Low | P3-24 |
| BLE2-16 | Low | P3-25 |
| BLE2-17 | Low | P3-26 |
| BLEP-13 | Critical | P1-2 |
| BLEP-14 | Medium | P3-19 |
| BLEP-15 | Low | P3-20 |
| BLEP-16 | Low | P6-7 |
| SURF-25 | High | P1-7 |
| SURF-26 | High | P1-8 |
| SURF-27 | Medium | P4-1(=DOC-04) |
| SURF-28 | Medium | P4-2 |
| SURF-29 | Medium | P4-3 |
| SURF-30 | Medium | P4-4 |
| SURF-31 | Medium | P4-5 |
| SURF-32 | Medium | P4-6 |
| SURF-33 | Low | P4-7 |
| SURF-34 | Low | P4-8 |
| SURF-35 | Low | P4-9 |
| SURF-36 | Low | P4-10 |
| SURF-37 | Low | P4-11 |
| SURF-38 | Low | P4-12 |
| SURF-39 | Low | P1-8(生体)/ P5-3(WiFi) |
| SURF-40 | Low | P4-13 |
| ARCH-01 | High | P1-6 |
| ARCH-02 | High | P5-1 |
| ARCH-03 | Medium | P5-2 |
| ARCH-04 | Medium | P5-3 |
| ARCH-05 | Medium | P5-4 |
| ARCH-06 | Low | P5-5 |
| ARCH-07 | Low | P5-6 |
| ARCH-08 | Medium | P5-7 |
| ARCH-09 | Low | P6-7 |
| ARCH-10 | Low | P5-8 |
| ARCH-11 | Low | P5-9 |
| ARCH-12 | Low | P5-10 |
| ARCH-13 | Medium | P5-11 |
| ARCH-14 | Low | P5-12 |
| ARCH-15 | Low | P5-13 |
| DOC-01 | High | P6-1 |
| DOC-02 | High | P6-2 |
| DOC-03 | Medium | P6-3 |
| DOC-04 | Medium | P4-1(=SURF-27) |
| DOC-05 | Medium | P6-4 |
| DOC-06 | Medium | P1-3(実装側) |
| DOC-07 | Medium | P6-5 |
| DOC-08 | Medium | P6-8 |
| DOC-09 | Medium | P6-6 |
| DOC-10 | Low | P6-7 |
| DOC-11 | Low | P6-9 |
| DOC-12 | Low | P6-9 |

---

## 8. 重大度集計

> 重大度は各所見の原典評価。P1-3 は原典 DOC-06(Medium)だが実機で BLE 経路が全死するため Phase 1(High 相当)に格上げした。

| 重大度 | 件数 | 項目 |
|---|---|---|
| Critical | 2 | P1-1(OS2 発見不能)、P1-2(生体 NOTIFY 無限ループ) |
| High | 8 | P1-4, P1-6, P1-7, P1-8(公開契約)、P2-2(認証)、P5-1(エラー設計)、P6-1, P6-2(虚偽ドキュメント) |
| Medium | 29 | P1-3, P1-5, P2-3, P2-4, P3-1〜P3-4, P3-14〜P3-17, P3-19, P4-1〜P4-6, P5-2, P5-3, P5-4, P5-7, P5-11, P6-3〜P6-6, P6-8 |
| Low | 41 | P2-1, P2-5〜P2-10, P3-5〜P3-13, P3-18, P3-20〜P3-27, P4-7〜P4-13, P5-5, P5-6, P5-8〜P5-10, P5-12, P5-13, P6-7, P6-9 |
| (major 繰越) | 1 | P5-14(workspace 分割・重大度未分類) |

合計 81 計画項目(Phase 1: 8 / Phase 2: 10 / Phase 3: 27 / Phase 4: 13 / Phase 5: 14 / Phase 6: 9 — うち P5-14 は v1 繰越、P6-9 は DOC-11/12 の 2 原典統合)。原典所見 89 件(§7 全掲載)を §0.3 と §7 で 81 項目に統合した。

---

## 9. 実機検証バックログ(コード修正後に必要なキャプチャ)

> v1 から繰越(V1〜V10、未実施)+ 今回追加(V11〜V14)。該当 API は `@experimental` + 未検証マーカーを維持し、検証完了ごとに撤去する。

| # | 対象 | 検証内容 | 関連 |
|---|---|---|---|
| V1 | OS2 実機(SESAME 3/4/Bot1/Bike1) | v1 P1-1〜P1-5 修正後の login/lock/unlock/履歴/register。今回 P1-1 の deviceName 由来 UUID 発見も含む | R2:BLE2-* |
| V2 | WM2 実機 | 新セッション層(INITIAL=13/暗号/login16B) | — |
| V3 | Bot2/Bike2 実機 | 67B register 応答 | — |
| V4 | OS3 register(SS5/Hub3) | 64B/77B 応答・needAuthFromServer・SigV4 REST | R2:AUTH-* |
| V5 | biometrics REST | SigV4 化後の `/device/v1/biometrics` 受理 | R2:BIZ-* |
| V6 | Hub3 networkType | 209 が実機で応答するか(しないなら削除) | — |
| V7 | IR 一覧/学習 | getRemoteList 実応答形・learn の success:false 実例 | R2:CLOUD-03/04 |
| V8 | access getCards | 完了通知と pub の到着順序(grace 撤廃可否) | R2:BIZ-06 |
| V9 | webapi/battery | success フィールドの有無 | — |
| V10 | getRegisterKey | OS2 server-auth の実機鍵合意 | — |
| **V11** | OS2 広告(実機) | manufacturerData 実長と deviceName(base64 22 文字)の実値 → P1-1 の UUID 導出を実機照合 | R2:BLE2-10 |
| **V12** | 生体 NOTIFY(実機) | CARD/PASSCODE NOTIFY の連結末尾に端数が付くか → P1-2 の境界 | R2:BLEP-13 |
| **V13** | アプリ形 InitiateAuth | 実 Cognito が SRP_A 付き initiate を受理し PASSWORD_VERIFIER/CUSTOM_CHALLENGE のどちらを返すか | R2:AUTH-01 |
| **V14** | pubUserDeviceChange | 無購読接続にも push されるか(P3-13 の確度確定) | R2:CLOUD-10 |

---

## 10. 見送り・非実装が正と確定した事項

v1 §10 を継承し、今回の調査で追加確定した分を併記する。**いずれも参照実装に存在しない/参照と整合済みで、実装しないことが正**。

**v1 から継承(再確認済み)**:
1. **autolock のクラウド設定** — `CHSesame5Device.kt:96-105` は BLE 限定、web IoT cmd にも無し。
2. **schedule 作成系 op** — 参照(web 全 grep)に list/cancel のみ。
3. **Stripe SetupIntent confirm の kit 内実装** — 技術的に可能だがカード情報を扱わない方針で非実装(やるなら別パッケージ/オプトイン)。
4. **TypeScript 全面移行** — d.ts 生成 + CI drift ゲートが機能しており見送り。
5. **i18n 再設計** — プロセスグローバルロケールは CLI 製品として妥当(完全性テストは P5-9 で補強)。
6. **Android 固有の付帯 REST**(feedHistory/battery post/SNS subscribe/friend 等)— アプリ専用テレメトリで web にも無く、kit スコープ外。

**今回追加で確定**:
7. **AWS IoT MQTT-WSS shadow 購読**(`CHIotManager.kt:244-335`、Hub3 の `goIOT`/relay 状態 topic 等)— kit はクラウド側 WS(biz3)経由で状態を取る設計。MQTT-WSS shadow は別経路で、移植はスコープ外(v1 で確認済みの設計判断を継続)。
8. **palmChange の送信**(`CHPalmEventHandlers.kt:16-18` で PALM_CHANGE 162 は受信専用)— v1 で非実装確定済み、今回も維持。
9. **OS2 register の REST**(`POST /device/v1/sesame2/{id}`、`myDevicesRegisterSesame2Post`)— kit は OS3 register(sesame5)のみ移植。OS2 のクラウド register は将来検討(P3-12 でコメントから削除)。
10. **updateBotScript 等のアプリ専用クラウド REST** — 現状スコープ外。将来 BLE bot2.js 機能と対で価値が出れば再検討(§見送りに記録のみ)。

---

## 11. 推奨実施順序

```
Step 1 (最優先・並行可): Phase 1 全 8 項目(1 所見 = 1 PR、テスト/モック修正を必ず同梱)
        ├ P1-1(OS2 発見)→ P1-7(ble.scan RPC)を同一マイルストーンで(OS2 登録が RPC 完結)
        ├ P1-2(生体無限ループ)は独立・即時
        └ P1-3(OS2 CLI ルーティング)は P1-1 完了後
Step 2 : Phase 2(P2-1 参照ベンダリングを最初に。以後 P2-2〜P2-10。auth は独立性が高い)
Step 3 : Phase 3(3A クラウド/Biz3 と 3B BLE は領域並行。P3-15 モック修正は P3-14 と同 PR)
Step 4 : Phase 4(P4-1 の version 連動を先に枠組みだけ入れ、面追加 P4-4/P4-5 の後に最終 bump)
        └ P3-27 の意味論方針を P4-1 前に決定
Step 5 : Phase 5(P5-1 エラー設計は serve 到達面に広く効くので Phase 4 と調整。P5-7 は P1-3 と同時が効率的)
随時   : Phase 6(各修正 PR に随伴 + 最終一括。P6-1/P6-2 の虚偽是正は早期に)
major  : P5-14(workspace 分割)— Phase 1-5 完了・実機検証進捗後
```

**マイルストーン M1(Phase 1 完了)**: 実機で動かない 2 つの確定 Critical(OS2 到達不能・生体 OOM)が解消し、参照由来ベクタのテストで検出される状態。
**マイルストーン M2(Phase 2-3 完了)**: 認証のアプリ忠実化が完了し、参照とのワイヤ互換が(実機未検証マーカー付き部分を除き)宣言できる。
**マイルストーン M3(Phase 4-5 完了)**: 「全機能 × 全経路」マトリクスに穴が無く、エラーモデルが経路間で一貫し、構造負債が解消された v1.0 候補。

---

> **検証規律(再掲)**: 本書の Critical/High は統括者が参照一次資料で再検証済み。Medium/Low は各監査エージェントの報告に基づくが、着手時に必ず参照 file:line を自分で開いて裏取りすること(README・docs・コード内コメントは根拠にしない)。「1:1 宣言」「全 op 移植済み」を主張する箇所には全件照合テストを併設する(規範8)。
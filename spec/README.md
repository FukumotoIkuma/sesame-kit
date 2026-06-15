# sesame-kit 機能監査 spec カタログ

このライブラリが「提供しているとされる全機能」を、**移植元実装との乖離がないか**という観点で
網羅監査するための **spec カタログ**。各 spec は ID 付きの索引エントリで、対応するテストの
存在は機械的に検証される（[spec↔test ガード](#spectest-ガード)）。

- 書式の正準定義: **[`_format.md`](./_format.md)**（ガードが従うグラマー）。
- E2E（実機/実クラウド往復）は監査対象から外すが、**その境界＝移植元と接する入出力の形**は
  すべてテストする。E2E でしか確認できない境界は捨てずに `status: waived:` として残す。

---

## 監査の対象軸（enumerate の母集合）

| 軸 | 値 |
|---|---|
| **surface**（クライアント面） | `core`（`@sesame-kit/core` 直接）, `serve`（常駐デーモン: gRPC/HTTP/WS/ndjson/socket/stdio/token の 7 framing）, `sdk`（生成 ts/py クライアント）, `cli`（`sesame …`） |
| **backend** | `cloud`（Cognito 認証 / AWS IoT / biz3 web API・WS）, `ble`（OS3 直結）, `ble-os2`（OS2 直結）, `local`（非ネットワーク） |
| **command** | 契約 **205 メソッド**（`schema/openrpc.json`, `CONTRACT_VERSION 1.4.0`）+ CLI 固有コマンド（login/init/serve/sdk/session/migrate 等） |
| **branch** | コマンドのオプション・引数・状態による分岐（経路 `--ble-only/--cloud-only/auto`、`--json`、機種能力、必須検証、再試行 …） |

spec = この母集合の各点に対する「移植元境界の一致」宣言。

## 移植元（ref が指す出典）

| 出典ディレクトリ | 中身 | 主担当ドメイン |
|---|---|---|
| `_aws_sdk_ref/` | AWSMobileClient 2.77.0 Java（Cognito wire） | auth/token wire |
| `_sesame_sdk_ref/` | Android アプリ + SesameSDK（Kotlin） | auth flow, BLE(OS2/OS3) |
| `references_web/` | CANDY-HOUSE biz3 web（React） | cloud transport（WS/IoT/web API） |

> **絶対制約**: 認証は Android アプリ方式（AWSMobileClient: CUSTOM_AUTH + device SRP + ConfirmDevice）を
> トレースする。web（`references_web/src/api/useAuthState.js`）方式は**負の証拠**としてのみ参照可。
> 詳細は リポジトリ直下 `REFERENCES.md`。

---

## ID プレフィックス登録簿（1 ファイル = 1 プレフィックス）

プレフィックスはファイルを跨いで一意。`spec/<slug>.md` ⇔ `<PREFIX>` ⇔ 対応テストディレクトリ。

| プレフィックス | spec ファイル | ドメイン | 主な対応テスト | 状態 |
|---|---|---|---|---|
| `AUTH` | `auth.md` | 認証フロー/wire・トークン・資格情報/SigV4 + account/serve/sdk 面横断 | `packages/core/tests/auth`, `aws-credentials`, `tokens`, `account`; `packages/kit/tests/serve` | ✅ pilot (133) |
| `AUTHC` | `auth-cli.md` | CLI 認証コマンド（login/verify/refresh/logout/whoami/init/setup/migrate/config/bootstrap/meta）の分岐 | `packages/kit/tests/cli` | ✅ pilot (52) |
| `LOCK` | `lock.md` | lock/unlock/toggle/click/autolock/status（cloud + BLE + webapi）+ デバイス主語ルーティング + `session`/`watch` | `packages/core/tests/lock`, `lock-manager`; `packages/kit/tests/cli`, `packages/kit/tests/session-ui` | ✅ pilot (141) |
| `DEV` | `devices.md` | devices.* / device.* 管理（list/add/reorder/history/battery/rename/delete/firmware） | `packages/core/tests/devices`, `client` | ✅ (52) |
| `CFG` | `config.md` | config.sync* / locks / remote 定義管理 | `packages/core/tests/config` | ✅ (98) |
| `ACC` | `access.md` | カード/パスコード/認証データ CRUD・enroll | `packages/core/tests/access`; `packages/kit/tests/cli/access-enroll` | ✅ (84) |
| `ORG` | `org.md` | 従業員/グループ/タグ/デバイスグループ/鍵共有/ゲスト QR | `packages/core/tests/org` | ✅ (110) |
| `CO` | `company.md` | company.* | `packages/core/tests/company` | ✅ (37) |
| `PAY` | `payment.md` | payment.* | `packages/core/tests/payment` | ✅ (36) |
| `IOT` | `iot.md` | iot.*（Hub3 LED/relay/sesame 追加削除/firmware/wifi/matter） | `packages/core/tests/iot` | ✅ (63) |
| `IR` | `ir.md` | ir.* + presetir.*（学習/送信/リモコン・キー CRUD/mode/match） | `packages/core/tests/ir`, `presetir` | ✅ (126) |
| `SCH` | `schedule.md` | schedule.* | `packages/core/tests/schedule` | ✅ (31) |
| `SK` | `sharekey.md` | 鍵共有 URL（`ssm://`）解析/生成・ゲスト鍵 | `packages/core/tests/sharekey` | ✅ (27) |
| `KS` | `keystore.md` | keystore.*（@experimental） | `packages/kit/tests/serve/keystore-rpc` | ✅ (31) |
| `WEB` | `webapi.md` | webapi.*（生クラウド passthrough） | `packages/core/tests/client` | ✅ (37) |
| `EVT` | `events.md` | events.subscribe/unsubscribe（ストリーミング） | `packages/kit/tests/serve` | ✅ (47) |
| `BLE3` | `ble-os3.md` | OS3 直結（scan/register/session/biometric/fingerprint/remoteNano/wifi/hub3/magnet/history …） | `packages/core/tests/ble` | ✅ (235) |
| `BLE2` | `ble-os2.md` | OS2 直結（autolock/history/versionTag/updateSetting/reset/configureLockPosition/register） | `packages/core/tests/ble` (os2-*) | ✅ (78) |
| `CRY` | `crypto.md` | 暗号プリミティブの**独立した既知応答ベクタ（KAT）**: AES-CMAC/ECDH/SRP math/HKDF/SigV4 canonical を入力固定で検証 | `packages/core/tests/crypto`, `sigv4` | ✅ (34) |
| `CLI` | `cli.md` | CLI 横断（dispatch/arg-router/global opt/`--json` 封筒/終了コード/対話 prompt/help） | `packages/kit/tests/cli` | ✅ (29) |
| `SRV` | `serve-framing.md` | 7 framing の符号化/復号忠実度・proto3 presence・エラー封筒・stability/provenance | `packages/kit/tests/serve` | ✅ (68) |
| `SDK` | `sdk.md` | 生成 SDK(ts/py) の 1:1 被覆・署名・eject | `packages/kit/tests/sdk-*`, `serve/clients-*` | ✅ (29) |
| `CTR` | `contract.md` | openrpc/proto/registry/NAMESPACE_OPS の自己整合・`CONTRACT_VERSION`・result schema | `packages/kit/tests/openrpc-contract`, `serve/*contract*` | ✅ (37) |
| `I18N` | `i18n.md` | カタログ完全性（全ロケール・全キー） | `packages/kit/tests/i18n-catalog` | ✅ (20) |

> ドメインの粒度方針: 1 ファイルが肥大化したら**プレフィックスを保ったまま分割**するのではなく、
> 新プレフィックス（例 `org.md` → `org-employee.md`/`org-keys.md` で `ORGE`/`ORGK`）に割って
> 「1 ファイル 1 プレフィックス」を維持する。目安は 1 ファイル 80 エントリ程度まで。
>
> **AUTH ↔ CRY 境界**（crypto.md 作成時の重複回避）: `AUTH` は HKDF/SRP/SigV4 を**認証フロー内で
> どう使うか**（生成値がどのフィールドに載るか・送信形）を `crypto-vector`/`wire-fidelity` で検証する。
> `CRY` は同プリミティブを**フローから切り離した固定入力 KAT**（既知ベクタ→既知出力）で検証する。
> 同一主張を両ファイルに二重起票しない。
>
> auth は肥大のため pilot 時点で `auth.md`（AUTH: フロー/wire/トークン/資格情報/面横断）と
> `auth-cli.md`（AUTHC: CLI コマンド分岐）に分割済み。この 2 プレフィックスが分割運用の先例。
>
> **session/watch の担当**: 対話セッション（`sesame session`/`watch`、デバイス主語の複数デバイス保持・経路別 action・
> 背景 BLE 接続）は `LOCK` が持つ（device-subject 操作の延長のため）。汎用 CLI 配線（dispatch/arg-router/global opt/
> help/対話 prompt の素材）は将来 `CLI` ドメイン。session の挙動（解決/経路/dispatch）は LOCK、UI 素材は CLI、と境界を引く。

---

## spec↔test ガード

`packages/kit/tests/spec-coverage.test.js`（unit, **実装済み・16 テスト**）が **spec とテストの対応を機械検証**する。

- spec 側: `### [ID]` を全抽出し、書式・一意性・プレフィックス整合・必須フィールド・語彙・**フィールド固定順・
  重複キー無し・`ref` の path:line 形式と参照ファイル実在**を検証。
- test 側: テストタイトル先頭の `[ID]` タグを全抽出。
- 突き合わせ: `covered` の spec はタグ付きテスト必須、孤児タグ（spec に無い ID）は FAIL、
  `planned`/`waived` にタグが付いたら状態更新を促す警告。

**テストの書き方の規約**: 監査テストはタイトル先頭に対応 spec ID を必ず置く。

```js
it("[AUTH-0007] ChallengeResponses のキー集合が AWSMobileClient と一致する", () => { /* ... */ });
```

詳細仕様は [`_format.md` §6](./_format.md)。

---

## 進め方（ロールアウト）

1. ~~**pilot**: `auth.md` / `lock.md` + 本フレーム + ガード~~ ✅ 完了（書式・ID 規約確定）。
2. ~~`planned` ドメインへ多エージェント横展開（1 ドメイン 1 ファイル）~~ ✅ 完了 — 全 24 ファイル。
3. ~~**デュアルエージェント品質監査**（各ドメインに独立 2 監査人 + アライナ → 人間が差分裁定 → 適用）~~ ✅ 完了 — 不足の補完・クロスドメイン重複の正典統合・実バグ抽出を実施。全 ref 実在をガードが機械検証。
4. **← いま ここ**: テスト実装に合わせて各 spec を `planned → covered` へ昇格。ガードで被覆率を単調増加させる。

> **現状サマリ（spec 作成 + 品質監査フェーズ完了）**: 24 ドメイン spec が出揃い、デュアル監査済み。全 **1,635 エントリ**（`planned` 約 1,561 / `waived` 74 = 実機/実クラウド限定 E2E + クロスドメイン重複の正典統合）。テスト本体（`[ID]` タグ付き）はこれから。
>
> **監査で抽出した実装バグ（spec ではなくコード側、別タスク）**: ① `sesame org keys device` が `{list,hasMore}` を配列扱い（常に「none」） ② `sesame remote add` が preset リモコンにも `irOperation:"learnEmit"` をハードコード ③ `lock-ops.js` の到達不能 `op==="bot"` デッドブランチ。いずれもタスクチップ化済み。
>
> **クロスドメイン正典（重複統合の方針）**: 暗号 KAT→`CRY` / イベント購読ライフサイクル→`EVT` / 契約自己整合→`CTR` / per-transport 符号化→`SRV` / i18n カタログ完全性→`I18N` / webapi→`WEB` / account→`AUTH` / locks·remote CLI→`CFG`。重複側は `status: waived: 重複（正典 [[OWNER]]）` で ID 保持。

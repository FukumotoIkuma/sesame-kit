# sesame-kit フルリファクタリング計画書

作成日: 2026-06-11 / 監査方法: 参照実装(`_sesame_sdk_ref` = Android SesameSDK Kotlin, `references_web` = biz3 web React)との全面突き合わせ。8 領域(認証/個人クラウド/Biz3/BLE-OS3 コア/BLE-OS2/BLE 周辺デバイス/公開経路/アーキテクチャ)を並列監査し、約 80 件の所見を統合した。

**この文書の読み方**: 各項目は「初見の実装者が単独で着手できる」粒度で、対象 file:line・参照 file:line・修正手順・テスト・受け入れ基準を持つ。所見 ID(`BLE2-01` 等)は監査時の原典 ID で、複数監査が同一問題を検出した場合は統合済み(§0.2)。**README・docs・コード内コメントの記述は本計画の根拠にしていない**(虚偽・stale が多数見つかったため)。すべて参照実装の実コードで裏取りしてある。

---

## 0. 前提

### 0.1 規範(全項目共通)

1. **絶対制約**: ログイン/トークン管理は Android アプリ(AWSMobileClient 2.77.0 + CUSTOM_AUTH)のトレースとする。web (`useAuthState.js`) の方式は使用禁止。
2. **1:1 ポート規範**: クラウド/BLE のワイヤ形状は参照の byte/フィールド単位で一致させる。フォールバック連鎖 `a || b || c`・握りつぶし catch・出典なし防御は「未検証ポートの臭い」であり、参照をトレースして解消する。意図的に参照から逸脱する場合は、逸脱内容と理由をコードコメントに明記する。
3. **モックは参照から作る**: 今回 Critical バグ 2 件(P1-1, P1-2)は「自実装の誤解をそのまま写したモック」がテストを緑に保っていた。モックデバイス/モックサーバの応答バイト列・フレームは、必ず Kotlin/web の**送信側コード**から導出し、導出元 file:line をモック定義の隣に記載する。
4. **経路対称性チェックリスト**: ライブラリに公開機能を追加・変更したら、同一 PR 内で次を更新する — ① `SesameClient`/`SesameBle` メソッド ② CLI コマンド ③ `serve/registry.js` ④ `npm run build`(openrpc/proto/SDK 再生成)⑤ docs/en・docs/ja ⑥ テスト。
5. **実機未検証マーカー**: 実機キャプチャ未照合の経路は JSDoc に `@experimental` + 「実機未検証 (参照: <file:line>)」を付け、§9 の実機検証バックログに登録する。

### 0.2 重複所見の統合表

| 統合先 | 原典所見 |
|---|---|
| P1-9 (device.history RPC 形状) | CLOUD-01 = BIZ-01 = SURF-02 |
| P1-7 (DFU 結線) | BLE3-01 = BLEP-04 |
| P3-14 (item code 209 捏造) | CLOUD-11 = BLE3-02 = BLEP-02 |
| P4-9 (TOPICS 重複) | SURF-16 = ARCH-07 |
| P3-7 (履歴/電池ページング公開) | CLOUD-16 = BIZ-02 = SURF-03 |
| P2-1 (SigV4 基盤) | AUTH-01 + AUTH-02 + BIZ-07 |

### 0.3 フェーズ構成と依存

| Phase | 内容 | 規模 | 依存 |
|---|---|---|---|
| 1 | 実機通信・公開契約を壊している確定バグ | M | なし(最優先) |
| 2 | 認証・登録系のアプリ忠実化 + SigV4 基盤 | M | なし(1 と並行可) |
| 3 | 参照突き合わせの抜け漏れ補完・挙動忠実化 | L | 1 完了後 |
| 4 | CLI/RPC/SDK 経路対称性の回復 | M | 3 と並行可(同じ op を触る項目のみ直列) |
| 5 | アーキテクチャ刷新(パッケージング・構造) | L | 1-4 完了後推奨(コード移動を伴うため) |
| 6 | ドキュメント正直化 | S | 各 Phase に随伴 + 最終一括 |

---

## Phase 1 — 実機通信・公開契約を壊している確定バグ

> このフェーズの所見はすべて両側ソースの読み合わせで**確定**しており、推測を含まない。1 項目 = 1 PR を推奨。

### 1A. BLE OS2(SESAME 2/3/4, Bot1, Bike1)

#### P1-1. OS2 応答フレームの itemCode/opCode バイト順を修正〔BLE2-01 / Critical〕
- **対象**: [src/ble/os2/protocol.js:240-251](src/ble/os2/protocol.js:240)(`parseRecvFrame` の response 分岐)
- **参照**: `_sesame_sdk_ref/sesame-sdk/.../ble/SesameProtocols.kt:15-19` — `SSM2ResponsePayload` は `cmdItCode = data[0]`, `cmdOPCode = data[1]`, `cmdResultCode = data[2]`
- **問題**: 自実装は `cmdOpCode = body[0], itemCode = body[1]` と**逆順**で読む(行 241 のコメント自体が Kotlin を逆に転記している)。応答ルーティングのキーである itemCode が opCode 値を拾うため、response 経由で届く **login 応答・lock/unlock/autolock 等すべてのコマンド応答が実機では解決されずタイムアウト**する。OS2 系の実機通信は現状成立しない。
- **修正手順**:
  1. response 分岐を `itemCode = body[0]; cmdOpCode = body[1]; resultCode = body[2]; payload = body.subarray(3)` に修正。コメントも Kotlin の正順に書き直す。
  2. publish 分岐(`itemCode = body[0]`)は元から正しいので触らない。
  3. **モック修正(必須)**: `tests/ble/os2.test.js:343,348`、`tests/ble/os2-robustness.test.js:45` のモックデバイスが送る response を `[RESPONSE, item, op, result]` 順に修正(現在は誤順 `[RESPONSE, op, item, result]` でバグを保護している)。モック定義の隣に「導出元: SesameProtocols.kt:15-19」を記載。
- **受け入れ基準**: 実機相当バイト列 `[7, 2(LOGIN), 5(SYNC), 0]` が login 応答としてルーティングされ、`[7, 82(LOCK), 6(ASYNC), 0]` で pending(82) が解決されるユニットテストが通る。

#### P1-2. OS2 mechStatus の retCode/flags バイト順を修正〔BLE2-02 / Critical〕
- **対象**: [src/ble/os2/protocol.js:468-489](src/ble/os2/protocol.js:468)(`parseMechStatus`)
- **参照**: `open/devices/CHSesame2.kt:34-39` — `retCode = data[6]`, `flags = data[7]`, `isInLockRange = flags and 2` ほか
- **問題**: 自実装は `flags = buf[6]`, `retCode = buf[7]` と**逆**。施錠/解錠判定・電池警告・`toggle()` の現在状態・履歴トリガ(retCode != 0)が全機種(Sesame2/Bot/Bike)で誤値になる。layout コメント(452-453 行)も逆に記述。
- **修正手順**:
  1. `const retCode = buf[6]; const flags = buf[7];` に修正(8B 必須化を検討。Kotlin は 8B 固定)。bit 判定(2/4/32)は flags=buf[7] から行う。
  2. layout コメントを Kotlin 準拠に修正。
  3. モック修正: `tests/ble/os2.test.js:190,207`、`os2-register.test.js:121`、`os2-robustness.test.js:44` の mechStatus ベクタで flags を byte[7] 位置へ移動。
  4. 同時に Bot 固有フィールドを追加(BLE2-09 後半): `motorStatus = buf[4]`(`CHSesameBotDevice.kt:286-293`)、`isStop = (flags & 1) === 0`。
- **受け入れ基準**: `CHSesame2.kt` の bit 定義どおりのベクタ(locked: byte7=0x02 等)で state/isInLockRange/isBatteryCritical が正しく出るテストが通る。

#### P1-3. lock/unlock/click/autolock の履歴タグを createHistag(22B) に統一〔BLE2-03 / High〕
- **対象**: [src/ble/os2/index.js:140-157](src/ble/os2/index.js:140)、[src/ble/os2/protocol.js:264-275](src/ble/os2/protocol.js:264)(`historyTag`)、[protocol.js:437](src/ble/os2/protocol.js:437)(`autolockData`)
- **参照**: `db/CHDBModel.kt:18-23`(`createHistag` = `[size:1B] ++ tag(最大21B) ++ 0埋め` で**常に 22B**)、使用箇所 `CHSesame2Device.kt:141,185,201`、Bot `CHSesameBotDevice.kt:370,387,408`、Bike `CHSesameBikeDevice.kt:311`
- **問題**: SDK はタグ無しでも全 0 の 22B を送るが、自実装の `historyTag()` は生バイト透過(タグ無しなら 0B)。実機は先頭 1B を長さとしてパースするため、フォーマット不正・履歴汚染になる。`createHistag` 相当(protocol.js:290-300)は実装済みなのに lock 系だけ未使用。
- **修正手順**:
  1. facade の lock/unlock/click/toggle と `autolockData` を `createHistag(tag)` 使用に切り替え(autolock は `[2B LE 秒] ++ createHistag(tag)` = 24B)。
  2. `historyTag()` 関数と誤った doc コメントを削除し、createHistag に一本化。
  3. テスト: lock コマンドの data 長 = 22B、autolock = 24B、タグ 21B 超過時の切り詰めを assert。
- **受け入れ基準**: 全 OS2 制御コマンドの payload が Kotlin の `createHistag` 出力と byte 一致。

#### P1-4. OS2 register の戻り値契約を修正(secretKey = ownerKey, keyIndex = "0000")〔BLE2-04, BLE2-06 / High〕
- **対象**: [src/ble/os2/session.js:97](src/ble/os2/session.js:97)(keyIndex 既定)、[session.js:279,305-309](src/ble/os2/session.js:279)(register 戻り値)
- **参照**: `CHSesame2Device.kt:462-469`(登録完了時に永続化するのは `keyIndex="0000"`, `secretKey=ownerKey.toHexString()`)、login 側 `CHSesame2Device.kt:233-252`(`sessionAuth = CMAC(secretKey=ownerKey, …)`、`loginPayload = userIdx(2B) ++ appPub64 ++ …`)
- **問題**: ① 自実装の `register()` は `secretKey` として ECDH `pre16` を返す。利用者がそれを次回 login に渡すと `CMAC(pre16,…)` となり実機は invalidSig で拒否する(正は ownerKey)。② keyIndex 省略時の既定が空(0B)のため loginPayload が 2B 短くなり実機のパースとずれる(正は `"0000"` = 2B)。
- **修正手順**:
  1. register 戻り値を `{ secretKey: ownerKey(hex), keyIndex: "0000", ecdhSecret: pre16(hex), sesame2PublicKey, … }` に変更。`this._secretKey` も ownerKey に。
  2. session コンストラクタの keyIndex 既定を `"0000"` に変更(空文字/0B を渡された場合は明示エラー)。
  3. `tests/ble/os2-register.test.js:165` の `res.secretKey === ecdhPre16` アサートを ownerKey に修正。register→login の連続シナリオテスト(登録で得た secretKey でそのまま login が成立する)を追加。
- **受け入れ基準**: register 戻り値をそのまま `new SesameOS2Ble({...})` に渡して login が成立する e2e モックテストが、**Kotlin の鍵導出順序から作った期待値**で通る。

#### P1-5. getRegisterKey の pubkey を 64B(X‖Y, prefix 無し)に修正〔BLE2-05 / High〕
- **対象**: [src/crypto.js:557,580](src/crypto.js:557) と注記コメント(369, 372 行)
- **参照**: `ble/os2/CHServerAuth.kt:138`(`publicKey.encoded.drop(27)` = SPKI 91B − 27B = **64B**)、`utils/EccKey.kt`(`fixheader` 27B は末尾 `04` を含む)
- **問題**: 自実装は `ecdh.getPublicKey()`(65B, `04` プレフィクス付き)を base64 化して返す。SDK 消費側は 64B 前提で `fixheader + remote` を組むため、65B を渡すと `04` が二重化し SPKI 破損。コメントの「drop(27) と一致 = 65B」は計算誤り。
- **修正手順**:
  1. `pubkey: pubKey.subarray(1).toString("base64")` に修正(64B)。
  2. コメント 3 箇所を「64B (uncompressed point の prefix 無し)」に訂正。
  3. `tests/crypto/serverauth.test.js:145-150` の golden(65B / `pub[0]===0x04` チェック)と `os2-register.test.js:179-180` の `expectedPub65` を 64B に修正。
  4. getRegisterKey 全体は引き続き「実機未検証」マーカーを維持(§9 へ)。
- **受け入れ基準**: pubkey の base64 デコード長が 64、sig1/st の golden は不変。

### 1B. BLE OS3 / WM2

#### P1-6. WM2 専用セッション層の実装(現状は全 WM2 BLE 機能が実機で不成立)〔BLEP-01 / Critical〕
- **対象**: [src/ble/session.js](src/ble/session.js)(initial/login/register/暗号)、[src/ble/wm2.js:16-20](src/ble/wm2.js:16)(虚偽コメント)、[src/ble/protocol.js:122-139](src/ble/protocol.js:122)(loginPayload / ccmNonce)
- **参照**: `ble/os3/CHWifiModule2Device.kt:279-312`(register override)、`:314-321`(login override)、`:521-528`(INITIAL 判定)、`:539-541`(`WM2ActionCode`: INITIAL=**13**, LOGIN_WM2=2, REGISTER_WM2=1)、`SesameOS3BleCipher.kt:8-32`
- **問題**: wm2.js は「セッション確立はロックと完全共通」と明記するが、Kotlin の WM2 は login/register を**オーバーライド**しており非互換。差分は 5 点:
  1. initial publish の itemCode が WM2 は **13**(自実装は 14 のみ処理 → トークンを受け取れず必ずタイムアウト)
  2. login 暗号鍵: WM2 は `secretKey 生 16B` + sault = `mSesameToken`(4B)→ nonce 12B(自実装: `CMAC(secretKey, token)` + sault 5B `0x00+token` → nonce 13B)
  3. login payload: WM2 は CMAC **16B 全量**(自実装: 先頭 4B)
  4. register payload: WM2 は **公開鍵 64B のみ**(自実装: 64B + timestamp 4B = 68B)
  5. register 後の鍵: WM2 は `ecdhSecret_pre16 生` + sault = token(自実装: `CMAC(pre16, token)` + `0x00+token`)
- **修正手順**:
  1. `SesameBleSession` コンストラクタに `profile: "lock" | "wm2"` を追加(既定 "lock")。`index.js` で `kind === KIND.WIFI` のとき "wm2" を渡す。
  2. `_handleInitial`: profile=wm2 なら itemCode 13 で発火させる(`initialItemCode` をプロファイルから引く)。
  3. `protocol.js` の `ccmNonce(count, sault)` を sault 引数化し、lock は `Buffer.concat([0x00, token])`、wm2 は `token` を渡す。`deriveSessionKey` も profile 分岐(wm2 login: 鍵 = secretKey 生、payload = `[LOGIN_WM2] ++ CMAC(secretKey, token) 16B`)。
  4. register: wm2 は `[REGISTER_WM2] ++ pubK64`、応答 `payload[0..63]` を ECDH、鍵 = `pre16 生`。
  5. wm2.js:16-20 の虚偽コメントを訂正し、「実機未検証」マーカーを付与(§9 へ)。
  6. テスト: `tests/ble/wm2.test.js` に INITIAL=13 → login(16B CMAC)→ コマンド暗号化の handshake テストを追加。期待値は `CHWifiModule2Device.kt` の式から手計算したベクタで固定する(モック session 注入では本問題を検出できないため、**実セッション層を通す**こと)。
- **受け入れ基準**: WM2 profile の handshake テストが Kotlin 由来ベクタで通る。lock profile の既存テストは無変更で通る(回帰なし)。

#### P1-7. DFU 結線の修正(OS3 ロックに MOVE_TO(84) を送らない)〔BLE3-01 = BLEP-04 / High〕
- **対象**: [src/ble/index.js:380-394](src/ble/index.js:380)(`updateFirmware()` の分岐)
- **参照**: `CHSesameOS3.kt:441-449`(OS3 共通 `updateFirmware` = **コマンド無送信**でデバイスハンドルを返すのみ。実転送は Nordic DFU が別 GATT で実施)、`CHHub3Device.kt:217-230`(MOVE_TO(84) を送る `updateFirmwareBleOnly` は **Hub3 専用**)
- **問題**: 自実装は `kind === KIND.HUB3 || kind === KIND.LOCK5` を `updateFirmwareBleOnly`(MOVE_TO 84 送信)へ流す。MOVE_TO はモーター駆動命令の番号域で、SS5 実機に対し SDK が送らないコマンドを送る(最悪モーター動作)。さらに biometric 機は SDK では DFU 可能(共通 no-op 経路)なのに自実装は throw する。[src/ble/dfu.js:96](src/ble/dfu.js:96) の no-op 版 `updateFirmware(session)` は実装・テスト済みなのに未結線。
- **修正手順**:
  1. 分岐を「`WIFI` → `updateFirmwareWM2` / `HUB3` → `updateFirmwareBleOnly` / `LOCK5`・`BIOMETRIC`・`BIKE2/3`・`BOT2` → `dfu.updateFirmware`(ハンドル返し)」に変更。
  2. README.md:352 / docs/en/ble.md:295 / docs/ja/ble.md:295 の「OS3 lock sends MOVE_TO(84)(CHSesameOS3.updateFirmware)」という虚偽記述を「OS3 lock は命令を送らずハンドルを返す(実転送は Nordic DFU 相当が必要で本 kit 未実装)」に訂正。
  3. テスト: `SesameBle({model:"sesame_5"}).updateFirmware()` が**一切コマンドを送らない**こと、`hub_3` のみ MOVE_TO を送ることをファサード経由で検証(現行テストは純関数直呼びでルーティングを見ていない)。
- **受け入れ基準**: 機種 × 送信コマンドのマトリクステストが Kotlin の振る舞い表と一致。

#### P1-8. Bot2/Bike2/Bot3/Bike3 の register 67B 応答形を追加〔BLEP-03 / High〕
- **対象**: [src/ble/session.js:731-745](src/ble/session.js:731)(`_extractRegisterDevicePubK` — 現在 64B/77B のみ許容)
- **参照**: `CHSesameBot2Device.kt:201-237` / `CHSesameBike2Device.kt:94-131` — try: 77B 形、**catch: `mechStatus(3B) + payload[3..66] の pubK64B` = 67B 形**
- **修正手順**: length===67 の分岐を追加し、`payload[0..2]` を `parseMechStatusBot` で `_lastStatus` へ、`payload.subarray(3, 67)` を devicePubK として返す。67B ベクタのテストを追加(Kotlin の式から導出)。
- **受け入れ基準**: 64/67/77B の 3 形がそれぞれ正しくパースされ、その他長は明示エラー。

#### P1-9. devicemodel の WM2 能力捏造を削除〔BLEP-08 / Medium〕
- **対象**: [src/ble/devicemodel.js:92](src/ble/devicemodel.js:92)(`[KIND.WIFI]: { cloud: ["ir", "relay", "led"] }`)
- **参照**: `open/devices/CHWifiModule2.kt:30-39`(WM2 の公開 API に IR/relay/LED は無い — これらは Hub3 専用)
- **修正手順**: KIND.WIFI の cloud を `[]` に変更。`tests/ble/devicemodel.test.js` に `supportsOp("wm_2","ir") === false` を追加。CLI/serve の能力ゲートが WM2 に IR 操作を提示しないことを確認。

#### P1-10. Bot2Commands 直接利用時の click payload 既定を修正〔BLEP-12 / Low〕
- **対象**: [src/ble/bot2.js:228-232](src/ble/bot2.js:228)
- **参照**: `CHSesameBot2Device.kt:91-93`(click は常に `historyTagBLE`、最低 `[0x00,0x0e]` 2B)
- **修正手順**: bot2.js が `protocol.js` の `historyTagBLE` を直接 import して既定値とする(注入は上書き用に残す)。

### 1C. クラウド / RPC

#### P1-11. RPC `device.history` のリクエスト形状バグ修正〔CLOUD-01 = BIZ-01 = SURF-02 / High・stable メソッド〕
- **対象**: [src/serve/registry.js:261](src/serve/registry.js:261)
- **参照**: `references_web/src/components/DeviceHistory.js:37`(`list` は常に `[{deviceUUID, lastKey}]` のオブジェクト配列)。CLI 側 [src/cli.js:1360](src/cli.js:1360) は正しい。
- **問題**: registry が `hub.getDeviceHistory([params.deviceUUID], …)` と**裸文字列の配列**を送る。サーバは `list[i].deviceUUID` を読むため RPC/SDK/gRPC 経由の履歴取得は壊れている。`tests/serve/grpc.test.js:82` が誤形状を期待値に固定しテストがバグを保護。
- **修正手順**:
  1. `hub.getDeviceHistory([{ deviceUUID: params.deviceUUID }], params.pageSize)` に修正。
  2. 同時に `lastKey` パラメータを追加(P3-7 と同一 PR 可)。
  3. grpc.test.js:22,82 の期待値修正 + stub hub で引数形状をキャプチャする回帰テストを追加。
- **受け入れ基準**: RPC ハンドラが lib 層へ渡す list 要素がオブジェクトであることをアサートするテストが通る。

#### P1-12. IR リモコン一覧/検索の応答パース修正〔CLOUD-02 / High〕
- **対象**: [src/ir.js:69-99](src/ir.js:69)(`getRemoteList` / `searchRemoteList` の `return resp.data || []`)
- **参照**: `references_web/src/api/useRemoteCtrl.js:42-64` — 応答 `data` は `{data: [...], pagination: {...}}` の**ラッパー**で、一覧は `message.data.data`
- **問題**: ラッパーをそのまま返すため、`sesame ir remotes/search` は `for...of` で TypeError、`syncRemotesFromServer` も崩壊。`|| []` は誤った期待の防御で常に素通り。テスト不在。
- **修正手順**:
  1. 両関数で `const d = resp.data ?? {}; return { list: d.data ?? [], pagination: d.pagination ?? null };` のように vendor の読み方を 1:1 実装(呼び出し側 [src/cli.js:1188-1216](src/cli.js:1188)・[src/config.js:632-656](src/config.js:632) を新形に追従)。
  2. vendor の `loadMoreRemotes` 相当(`currentPage+1` / `hasMore`)をページング引数として公開。
  3. 応答形状を固定するユニットテストを追加(fixture は useRemoteCtrl.js の応答処理から導出)。
- **受け入れ基準**: `{data:{data:[…], pagination:{…}}}` 応答で一覧が取れ、`ir remotes` CLI が件数を正しく表示。

#### P1-13. `listDevices`(会社デバイス一覧)の複数ページ対応〔CLOUD-03 / High〕
- **対象**: [src/client.js:463-498](src/client.js:463)
- **参照**: `useManageDevice.js:36-55` — `PubedCompanyDevice` は `{totalPage, data:{list, page}}` のページ分割 push で、`totalPage === page` まで蓄積
- **問題**: 最初の push で即 resolve するため、1 ページ超のアカウントで一覧が先頭ページに切り詰められる(`devices.list` RPC・config 同期・各 CLI のデバイス選択に波及)。同一プロトコルの `getUserDevices`([src/devices.js:52-77](src/devices.js:52))は正しく実装済み。
- **修正手順**: `listDevices` を `subscribeChunks`(util.js)ベースに置き換え(key=`biz3ManageDevice:PubedCompanyDevice`、`totalPage===page` で finish)。複数ページ push のテストを `tests/client/` に追加。

#### P1-14. IR 学習の `success:false` 応答処理を追加〔CLOUD-04 / Medium〕
- **対象**: [src/ir.js:368-374](src/ir.js:368)(`learnIRKey` の onData)
- **参照**: `references_web/src/pages/personal/devices/wifi-module/ir/learn/index.js:217-249`(`response.success === false` は失敗処理、データは success 時のみ採用)
- **問題**: 最初の Rsp で無条件 resolve するため、失敗応答でも `waveform=undefined` のまま `addIRCode` に進み壊れたキーを保存し得る。
- **修正手順**: `msg?.success === false` で reject、波形空でも reject。vendor の「波形長 ≤ 50 は無視して待機」(`remote-match/index.js:142-149`)の採否を決めて実装(採用推奨)。success:false の fixture テストを追加。

### 1D. 生成・配布物

#### P1-15. payment 名前空間を RPC スキーマ生成対象に追加〔SURF-01 / High〕
- **対象**: [scripts/gen-rpc-schema.mjs:13](scripts/gen-rpc-schema.mjs:13)(`NS_MODULES` に `"payment"` が無い)
- **問題**: payment.* 6 メソッドの型が openrpc/proto/TS/Py SDK すべてで `params` プレースホルダに劣化。生成物同士は同期しているため CI の drift ゲートでは検出不能。
- **修正手順**:
  1. `"payment"` を追加し `npm run build` で全再生成。
  2. **再発防止**: `src/serve/registry.js` から `Object.keys(NS_MODULES)` を export し、gen-rpc-schema が registry と同じ定数を import する形に一本化(または両者の一致を assert するテストを `tests/serve/` に追加)。
- **受け入れ基準**: 生成後の openrpc.json で `payment.getPaymentMethods` 等に実パラメータ定義が現れ、TS SDK の型が `Record<string, unknown>` でなくなる。

#### P1-16. strip-private-decls の取りこぼし修正(内部 API が公開型に漏洩)〔SURF-17 / Medium〕
- **対象**: [scripts/strip-private-decls.mjs:19,35](scripts/strip-private-decls.mjs:19)
- **問題**: 正規表現がプロパティ形式(`_x:`)のみ対象でメソッド形式(`_x(`)を素通し。`types/client.d.ts` に `_ensureConnected()` ほか内部メソッドが公開されている。`!done` パスはファイル残部を黙って欠落させる潜在バグ。
- **修正手順**:
  1. 正規表現を `/^    (?:private\s+)?_[A-Za-z0-9_]+\??[:(]/` に拡張(直前の JSDoc ブロックも併せて除去)。中期的には tsc `stripInternal` + `/** @internal */` への移行を検討。
  2. `!done` 時は残り全行をそのまま出力して警告ログ。
  3. 「types/ に `_` 始まりメンバが残っていない」検査テストを追加。

#### P1-17. gRPC metadata の Bearer 解析を ReDoS 安全版に統一〔ARCH-06 / Medium・セキュリティ〕
- **対象**: [src/serve/framing/grpc.js:69-73](src/serve/framing/grpc.js:69)
- **問題**: [framing/token.js:36-42](src/serve/framing/token.js:36) は「旧 `^Bearer\s+(.+)$` は ReDoS を起こした(実測)」と明記して prefix 照合へ修正済みなのに、grpc.js が**まさにその禁止パターン**を再実装している(重複が修正漏れを生んだ実例)。
- **修正手順**: token.js から `parseBearer(raw)` を export し grpc.js はそれを呼ぶ。`tests/serve/grpc.test.js` に長大空白 Authorization の回帰ケースを追加。

---

## Phase 2 — 認証・登録系のアプリ忠実化

> 監査で良い知らせ: 認証コア(CUSTOM_AUTH メール OTP、Pool/Client 値、ConfirmDevice、device-SRP のバイト等価、REFRESH_TOKEN_AUTH+DEVICE_KEY、トークン永続化セット)は**アプリと 1:1 で一致済み**と確認された。残るのは register/biometrics REST の認可方式と、周辺の忠実度・運用堅牢性。

#### P2-1. Identity Pool SigV4 基盤の実装(register / biometrics REST の正しい認可)〔AUTH-01 + AUTH-02 + BIZ-07 / High〕
- **対象**: [src/devices.js:392-414](src/devices.js:392)(`makeRegisterTransport` — 現在 `Authorization: Bearer <idToken>`)、[src/access.js:137-167](src/access.js:137)(`makeBiometricsTransport` — 同)
- **参照**: 公式の REST 認可は **SigV4(Cognito Identity Pool credentials)+ `x-api-key` + `appidentifyid`** — `ApiClientConfigBuilder.kt:34-46`、`app/.../BaseApp.kt:95-102`、`CHAPIClient.kt:19-46`、`AppIdentifyIdUtil.kt:42`。実値は `_sesame_sdk_ref/app.properties`: REST ホスト `https://app.candyhouse.co/prod`(行 2-3)、API key(行 5)、IdentityPool `ap-northeast-1:0a18…`(行 8)。idToken を Authorization に使う箇所は SDK に存在しない。
- **問題**: 現行 Bearer 経路は実 API Gateway(IAM 認可)にほぼ確実に 403 で拒否される。また「REST ホストは参照に無い」というコード注記・README 記述は虚偽(app.properties にチェックイン済み)で、不要な `baseUrl` 注入をユーザに要求している。
- **修正手順**:
  1. `src/aws-credentials.js` を新設: `GetId` / `GetCredentialsForIdentity`(logins = `cognito-idp.ap-northeast-1.amazonaws.com/<poolId> → idToken`)で一時 credentials を取得し、Expiration 前 refresh 付きでキャッシュ(`CognitoCachingCredentialsProvider` 相当)。実装は P2-2 の生 HTTP 方式に合わせ、`@aws-sdk/client-cognito-identity` を増やさず素 fetch + `X-Amz-Target` で行う。
  2. `src/sigv4.js` を新設(service=`execute-api`, region=`ap-northeast-1` の SigV4 署名。依存追加を避け自前実装 + 既知ベクタテスト。`@smithy/signature-v4` 採用は ARCH-01 の依存方針と相談の上の代替案)。
  3. `makeRegisterTransport` / `makeBiometricsTransport` を「SigV4 + `x-api-key: <app.properties:5 の値>` + `appidentifyid: ap-northeast-1:<ホスト固有 ID>`」に変更。`appidentifyid` 用の安定 ID は ANDROID_ID 相当としてランダム UUID を初回生成し config に永続化。
  4. `DEFAULT_REGISTER_BASE_URL = "https://app.candyhouse.co/prod"` を既定化(設定で上書き可)。devices.js:393 の「baseUrl 必須 throw」と README の虚偽記述を削除・訂正。
  5. 既存の idToken Bearer は撤去(参照に存在しないため)。
  6. テスト: 署名ヘッダ(Authorization の credential scope / signed headers / x-api-key / appidentifyid)を fixture で固定。実機検証は §9 へ。
- **受け入れ基準**: 注入 transport なしで `signGuestKey`/`registerSesame5`/biometrics 系のリクエストが「SigV4 + x-api-key + appidentifyid + 既定ホスト」で組み立てられる。

#### P2-2. Cognito SDK 依存を生 HTTP 化(アーキテクチャ前倒し)〔ARCH-02 / High〕
- **対象**: [src/auth.js:26-35,59](src/auth.js:26)
- **問題**: `@aws-sdk/client-cognito-identity-provider` が transitive 30 パッケージ・約 14MB を引き込み、`src/index.js` の import だけで実体化される。使用 API は 7 種(InitiateAuth / RespondToAuthChallenge / SignUp / ConfirmDevice / UpdateDeviceStatus / ForgetDevice / RevokeToken)で**すべて SigV4 不要の匿名 API**。`POST https://cognito-idp.<region>.amazonaws.com/` + `X-Amz-Target: AWSCognitoIdentityProviderService.<Op>` の素 fetch で完全置換できる。
- **修正手順**:
  1. `src/cognito-http.js` を新設: `cognitoCall(op, payload)`(fetch + エラー `__type` → 例外名写像。`NotAuthorizedException` 等の name 互換を維持し既存ハンドラを変えない)。
  2. auth.js の `cognito.send(new XxxCommand(p))` 7 箇所を `cognitoCall("Xxx", p)` に機械置換。
  3. `tests/auth/*` を fetch モックへ差し替え(アサート対象のリクエスト形は不変)。
  4. package.json から `@aws-sdk/client-cognito-identity-provider` を削除。
- **受け入れ基準**: 全 auth テストが通り、prod 依存ツリーから @aws-sdk/@smithy 系が消える。P2-1 の credentials 取得も同方式で実装されている。

#### P2-3. CUSTOM_AUTH の DEVICE_KEY 配置をアプリと同一にする〔AUTH-05 / Medium〕
- **対象**: [src/auth.js:244-255](src/auth.js:244)(InitiateAuth に DEVICE_KEY 同梱)、[auth.js:301-311](src/auth.js:301)(チャレンジ回答に DEVICE_KEY 無し)
- **参照**: AWSMobileClient 2.77.0 `CognitoUser.java:3473-3507`(initiate には入れない)/ `ChallengeContinuation.java:160-167`(**全チャレンジ回答に** USERNAME/SECRET_HASH/DEVICE_KEY を注入)
- **問題**: 自実装は参照と**逆配置**(initiate に入れ、回答に入れない)。現状動作はするが、注記「公式アプリと同じ」は誤りで、認証 Lambda の将来変更に脆い。
- **修正手順**: `loginVerify` の `ChallengeResponses` と `deviceSrpAuth` 前段に保存済み DEVICE_KEY を追加。initiate 側は「参照に無い互換維持」と注記の上で残すか撤去かを決める(撤去推奨: 1:1 規範)。コメントを実態に合わせ訂正。テストで ChallengeResponses 内 DEVICE_KEY をアサート。

#### P2-4. サインアップ形をアプリと同一にする(判断つき)〔AUTH-04 / Medium〕
- **対象**: [src/auth.js:57,262-271](src/auth.js:57)
- **参照**: アプリ `LoginMailFG.kt:106-127` — **signUp 先行**(UsernameExistsException 容認)、`Password:"dummypwk"`、`UserAttributes:[{Name:"email"}]`。web は `Aa123456`・属性なし(自実装は web 由来)。
- **修正手順**: アプリ忠実化(signUp 先行 + dummypwk + email 属性)へ変更する。既存アカウントへの影響なし(パスワードは新規作成時のみ意味を持つ)。少なくともコメントの「公式が使う値」という曖昧表記を「web=Aa123456 / app=dummypwk」と正確化する。
- **受け入れ基準**: signUp リクエストの形が `LoginMailFG.kt` と一致するテスト。

#### P2-5. 参照に無い独自防御の削除(UpdateDeviceStatus / NewDeviceMetadata)〔AUTH-06, AUTH-07 / Medium-Low〕
- **対象**: [src/auth.js:402-413](src/auth.js:402)(`UpdateDeviceStatusCommand("remembered")`)、[auth.js:214-223](src/auth.js:214)(refresh 応答の `NewDeviceMetadata` 再 ConfirmDevice 分岐)
- **参照**: `CognitoUser.java:3140-3151`(UserConfirmationNecessary でも remembered 化しない)、`CognitoUser.java:2865-2876`(refreshSession に NewDeviceMetadata 処理は存在しない)
- **修正手順**: 両分岐を削除(または「参照に無い独自追加」へ注記縮退し、観測時に警告ログ)。`r.RefreshToken` ローテーション取り込み(auth.js:213)は AWS 新機能への前方互換として**残す**(参照 SDK は旧 token 維持だが、こちらは意図的逸脱として注記)。

#### P2-6. 資格情報失効時の後始末をアプリと一致させる〔AUTH-08 / Medium〕
- **対象**: [src/auth.js:197-204](src/auth.js:197)(refresh 失敗時 throw のみ)、[auth.js:431-489](src/auth.js:431)(deviceSrpAuth 失敗時)
- **参照**: `CognitoUser.java:1306-1311`(refresh が NotAuthorized/UserNotFound → `clearCachedTokens()`)、`:3384-3396`(DEVICE_SRP_AUTH が NotAuthorized → `clearCachedDevice()` して認証を最初からやり直す)
- **修正手順**:
  1. `getValidIdToken` の NotAuthorizedException で `store.clear()`(pending verify 状態は残す)。
  2. `deviceSrpAuth` の NotAuthorizedException で device 3 点(deviceKey/deviceGroupKey/devicePassword)を null 化し、デバイス無し CUSTOM_AUTH を最初から再試行。
  3. 失効 → 再ログイン誘導 → 古い device で再失敗、のループが消えることをテストで固定。

#### P2-7. リフレッシュ閾値・WS 再接続時の refresh 方針を参照に揃える〔AUTH-11 / Low〕
- **対象**: [src/auth.js:167](src/auth.js:167)(margin 60s)、[src/client.js:272-280](src/client.js:272)(リトライ 3 回目で無条件 refresh)
- **参照**: `CognitoIdentityProviderClientConfig.java:40`(閾値 **120s**)、web `useAuthState.js:50-60`(リトライ時も期限内なら refresh しない)
- **修正手順**: marginSec 既定を 120 に。`onTokenRefreshNeeded` は exp を見て期限内なら現 token を返す形へ。

#### P2-8. tokens.json / config.json のプロセス間 lost-update 防止〔ARCH-13 / Medium〕
- **対象**: [src/secure-fs.js:39-51](src/secure-fs.js:39)、[src/tokens.js:90](src/tokens.js:90)、[src/config.js:276-287](src/config.js:276)
- **問題**: serve デーモン常駐 + CLI 併用が公式ユースケースだが、load-modify-save に跨るロックが無い。デーモンが refresh した直後に古いメモリ内容の CLI が save すると新 refreshToken が巻き戻る(rotation 環境では `Invalid Refresh Token` → 再ログイン要求)。atomic rename は破損を防ぐだけで競合上書きは防げない。
- **修正手順**: `writeSecretJson` に `O_EXCL` ロックファイル(`<path>.lock`、stale 検出付き)を追加し、TokenStore.save は load→merge→save をロック内で実行。並行 save の競合テスト(2 プロセス相当を同一プロセス内で擬似)を追加。

#### P2-9. REFERENCES.md の規範矛盾を解消〔AUTH-03 / Medium・規範文書〕
- **対象**: [REFERENCES.md:21](REFERENCES.md)
- **問題**: 「`references_web` = cloud/**auth** port's primary source」という記述が絶対制約(auth はアプリをトレース)と矛盾。将来の修正者が web 方式へ「忠実に」戻すリグレッションを正当化し得る。
- **修正手順**: 表を「**auth/token** = `_sesame_sdk_ref`(AWSMobileClient 2.77.0 の挙動含む)/ **cloud transport(WS フレーム)** = `references_web` / **BLE** = `_sesame_sdk_ref`」へ 3 分割し、絶対制約の理由(web 方式はトークン永続化不可)を明記する。

---

## Phase 3 — 参照突き合わせの抜け漏れ補完・挙動忠実化

> 新規 op の追加はすべて §0.1-4 の経路対称性チェックリスト(lib + CLI + RPC + SDK 再生成 + docs + テスト)を同一 PR で満たすこと。

### 3A. クラウド機能の欠落補完

#### P3-1. `biz3ManageDevice` 残り 5 op の移植〔CLOUD-06 / Medium〕
- **対象**: [src/devices.js](src/devices.js) に追加
- **参照**: `useManageDevice.js:256-268`(`add` — QR 由来キーの登録。**デバイスを「増やす」唯一の経路**で、del だけある現状は非対称)、`:270-285`(`reorderDevices`、rank=-index)、`:287-302`(`notifyList`)、`:304-320`(`notifyManage`)、`:360-372`(`switchRecharge`)
- **修正手順**: `addDevices(client,{companyID,items})` / `reorderDevices` / `getNotifyStatus` / `switchNotify` / `switchRechargeableBattery` を vendor フレームどおり追加し、client.js・registry・CLI(`sesame device add/reorder/notify/recharge`)へ配線。`Limit Exceeded` エラー応答(useManageDevice.js:28-30)の伝搬を確認。

#### P3-2. プリセット IR の状態永続化(updateRemoteState)〔CLOUD-05 / Medium〕
- **対象**: [src/ir.js](src/ir.js) に op 追加、[src/presetir.js](src/presetir.js) の emit に接続
- **参照**: `useRemoteCtrl.js:493-514`(op `updateRemoteState` {deviceId, uuid, state, companyID})、`remote-air/index.js:371-383` / `remote-non-air/index.js:158-166`(sendIR 成功後に command を保存)、`remote-air/index.js:108-113`(`remote.state` から復元)
- **問題**: エアコン等の状態(電源/温度/モード)が永続化されず、emit のたびに既定値からの送信になり公式アプリ/web と状態が乖離する。
- **修正手順**: `updateRemoteState` を追加し、`emitAir`/`emitButton` 成功後に `irDeviceUUID` があれば自動保存。emitAir の入力に保存 state からの復元ヘルパー(`parseAirCommand` 接続)を追加。

#### P3-3. addRemoteToMatter の移植〔CLOUD-07 / Medium〕
- **参照**: `useRemoteCtrl.js:933-955`。Matter ペアリング窓([src/iot.js:466-490](src/iot.js:466))まで実装済みなのに最終段の「リモコンの Matter デバイス化」が欠落。
- **修正手順**: `ir.addRemoteToMatter`(フィールド名は vendor どおり {hub3DeviceId, irDeviceType, cmdOn, cmdOff, irDeviceUUID, irDeviceName, companyID})を lib+RPC+CLI に追加。

#### P3-4. `onLockStateChange` の購読フレーム欠落修正〔CLOUD-09 / Medium〕
- **対象**: [src/client.js:1177-1200](src/client.js:1177)
- **参照**: `useManageDevice.js:48-51,322-350` — `pubDeviceStateChange` は **`subscribeDevicesUpdate` frame を送った接続にのみ** push される
- **問題**: ライブラリ利用者が `onLockStateChange()` だけ呼ぶとサーバ購読 frame が送られず、イベントが永遠に来ない(serve daemon 側は正しい)。[src/lock.js:41-45](src/lock.js:41) の「push が来ず timeout」という実機観測コメントの根本原因の可能性が高い。
- **修正手順**: `onLockStateChange` 内で対象デバイスの `subscribeDevicesUpdate` frame を送信し、`onReconnect` で再送。lock.js の観測コメントを再検証して書き直す。購読 frame 送信のテストを追加。

#### P3-5. `pubUserDeviceChange` push の受口を追加〔CLOUD-10 / Low〕
- **参照**: `useIotCtrl.js:12,23-25`(鍵共有・デバイス増減 push でデバイス一覧を再取得)
- **修正手順**: devices.js に購読ヘルパーを追加し、serve daemon は受信時に devices 再取得 or イベント fan-out(topic `deviceListChanged` として SUBSCRIBABLE_TOPICS へ追加)。

#### P3-6. lock コマンドの ack 相関を FIFO 化〔CLOUD-08 / Medium〕
- **対象**: [src/lock.js:32-94](src/lock.js:32)
- **問題**: ack には相関キーが無いのに subscribe で全 pending に配るため、並行 2 コマンドで応答を取り違える。transport の `request()`(FIFO 相関、[src/transport.js:507-514](src/transport.js:507))が既にあるのに未使用。
- **修正手順**: `dispatchTrigger` の ack 待ちを `client.request(...)`(key=`biz3TriggerLocker:`)へ変更。並行 2 コマンドの取り違えテストを追加。

#### P3-7. 履歴/電池ページングの全経路公開〔CLOUD-16 = BIZ-02 = SURF-03 / Medium〕
- **参照**: `DeviceHistory.js:37-74`(`lastKey` = 直前ページ末尾の timestamp、`res.length === pageSize` で継続)、`MobileBatteryChart.js:40-50`(`lastEvaluatedKey`)
- **問題**: lib 層は対応済みだが、CLI/RPC からは 2 ページ目以降が取得不能。battery に至っては `lastEvaluatedKey` を**返す**契約なのに**渡す**手段が無い片道契約。
- **修正手順**: RPC `device.history` に `lastKey`、`device.battery` に `lastEvaluatedKey` パラメータを追加。CLI `history` に `--last-key`(または vendor の fetchAllHistory 相当の `--all` 自動ページング)、`battery` に `--last-key <json>` を追加。`npm run build` 再生成。

#### P3-8. config 同期のプリセットリモコン対応〔CLOUD-12 / Medium〕
- **対象**: [src/config.js:589-616](src/config.js:589)
- **参照**: 学習リモコン(type 0xFE00)のみ `learnEmit`、プリセット(0xC000/0x2000/0xE000/0x8000)は `remoteEmit` + HXD code(`remote-air/index.js:369` ほか)。リモコン要素は `{uuid, type, **code**, state, alias…}`(`IrRemote.kt:5-15`)
- **問題**: `syncRemotesFromDevices` が全リモコンに `irOperation:"learnEmit"` を固定し、`code`/`state` を捨てるため、同期したプリセットリモコンが `hub.send()` で誤動作する。
- **修正手順**: 同期時に `irType === 0xFE00 ? "learnEmit" : "remoteEmit"` を導出し、`code`/`state` を config に保存。preset-ir CLI が config から code を解決できるようにする。

#### P3-9. chunk 収集のエラーフレーム検知〔CLOUD-13, BIZ-15 / Low〕
- **対象**: [src/devices.js:59-76](src/devices.js:59) ほか subscribeChunks 利用箇所、[src/org.js:195](src/org.js:195)
- **問題**: ① push op のみ購読し `success:false` 応答を拾わないため、サーバの即時エラーが 10 秒 timeout に化けてメッセージが失われる。② `totalPage ?? 1` により totalPage 欠落チャンクで**静かに結果が切り詰められる**(参照は完了しない=安全側)。
- **修正手順**: ① subscribeChunks に「同 action の success:false を観測したら finish(err)」を追加。② `?? 1` を外し、totalPage 欠落時は timeout に倒す。

### 3B. Biz3 系の忠実化

#### P3-10. role CLI の表示・ヒントを実フィールド名に修正〔BIZ-05 / Medium〕
- **対象**: [src/cli/org.js:385-387,423](src/cli/org.js:385)、[src/i18n/org.js:132-134](src/i18n/org.js:132)
- **参照**: ロールオブジェクトの実フィールドは `{tag, access[]}`(`DataTableColumns.js:560-575`、`EmployeeRoles.js:161-164,627`)。`id`/`name` は存在しない。
- **問題**: `role ls` が全行 "(no-id) (no-name)" 表示、`role post/rm` の `--json` ヒント通りに打つとサーバが解釈不能。`?? ` フォールバック連鎖が誤りを隠している。
- **修正手順**: 表示を `t.tag` + `t.access.join(",")` に、ヒントを `'{"tag":"Admin","access":["ユーザー","カード管理"]}'`(rm は tagSetting 全体)に修正。フォールバックを削除し、表示スナップショットテストを追加。

#### P3-11. カード/パスコード登録の nameUUID をファームウェア採番に一致させる〔BIZ-04 / Medium〕
- **対象**: [src/access.js:671-735](src/access.js:671)(enrolledToCardList / enrolledToPasscodeList / syncEnrolledCards)
- **参照**: `cards/index.js:104-136`(タップ登録は ack の `cardInfo.nameUUID` を使い **updateCardName** で同期)、`:264-295`(postCards は「先にファームへ書いた nameUUID」を DB へ送る)、`passwords.js:101-113`
- **問題**: BLE enroll 後に**新規採番**した nameUUID を postCards に送るため、ファーム側 nameUUID と恒久不一致になる。passcode は参照に無いフィールドも送っている。
- **修正手順**: ① ble/biometric.js の enroll collector に NOTIFY/ack 由来の nameUUID を含める。② タップ登録経路は `updateCardName` 委譲へ変更、postCards は「ファームと同一 nameUUID の一括投入」専用に。③ passcode 写像を `{passwordID, name, nameUUID}` のみへ削る。

#### P3-12. getCards/getPasscodes の完了順序前提を撤廃〔BIZ-03 / Medium〕
- **対象**: [src/access.js:199,246-251](src/access.js:199)
- **問題**: 「完了通知は必ず全 push の後」という参照から導出できない順序仮定で即 finish しており、逆順サーバでは黙って空成功になる。
- **修正手順**: 完了通知受信時に要求 deviceUUIDs が揃っているか検査し、欠落時のみ短い grace window(200-500ms)で残 push を吸収。コメントの断定を「未確認」に修正(実機キャプチャ後に確定: §9)。

#### P3-13. Biz 系の小型修正群〔BIZ-08, BIZ-09, BIZ-10, BIZ-11, BIZ-12, BIZ-14 / Low〕
1. **BIZ-08**: [src/access.js:176-179](src/access.js:176) `withSuffix` の条件付与を Kotlin の無条件連結(`CHDataSynchronizeCapableImpl.kt:17`)に合わせる(または JSDoc に逸脱明記)。
2. **BIZ-09**: [src/sharekey.js:88-89,142](src/sharekey.js:88) の参照に無いフォールバック(`keyLevel ?? deviceKey.keyLevel` 等)を削除または逸脱注記。
3. **BIZ-10**: [src/company.js:84](src/company.js:84) の `resp.data ?? {…}` 応答捏造をやめ、素の resp を返す(テストの固定化も解除)。
4. **BIZ-11**: web の `newTags` / `priorityCompany`(`useStripeInfo.js:28-71`)相当の純関数を account.js に追加し、payment/company 系の既定 customerId 解決に使う(最低限 docs に「既定 companyID は config 値」と明記)。
5. **BIZ-12**: `org keys rm` の randomTag を `cmacTime(secretKey)`(実装済み crypto.cmacTime)で自動補完(`DeviceUserList.js:117-132` と同じ計算。手入力は事実上不可能)。
6. **BIZ-14**: chunk 収集 timeout 時に部分結果を返す `{partial:true}` オプションを検討(現挙動は厳格化として許容)。

### 3C. BLE の忠実化(非 Critical)

#### P3-14. item code 209(networkType)の捏造解消〔CLOUD-11 = BLE3-02 = BLEP-02 / Medium・規範違反〕
- **対象**: [src/itemcodes.js:161](src/itemcodes.js:161)、[src/ble/hub3.js:86-131,231-252,319-331](src/ble/hub3.js:86)、`tests/ble/hub3.test.js:14-22`、README.md:352、docs/{en,ja}/ble.md
- **事実**: `SesameItemCode` enum に 209 は存在しない(`SesameProtocols.kt:32-53` は 208 で終端)。`CHHub3Device.kt` に NETWORK_TYPE ハンドラは無く、hub3.js:116 の引用「CHHub3Device.kt:328-333」は SSID_NOTIFY の行で**虚偽引用**。payload 解釈([wifi 1B][lte 1B])も出典なし。
- **修正手順**:
  1. 出典表記を「Android SDK に存在しない。biz3 web の native ブリッジ挙動からの推定(references_web/src/components/MobileWifiModule.js:219-235)」へ全面書き換え、`@experimental` + 実機未検証マーカーを付与(§9 へ)。
  2. itemcodes.js では `HUB3_ITEM_CODE_NETWORK_TYPE` を SDK 由来定数群から分離し `UNVERIFIED_ITEM_CODES` セクションへ移動(「SesameProtocols.kt と 1:1」という宣言を守るため)。
  3. テスト名・README・docs から「SDK 値と一致」「ported from CHHub3Device.kt」を削除。
  4. 別一次ソース(iOS SDK 等)が入手できたら引用を差し替え、確証が得られない場合は機能ごと削除を検討。

#### P3-15. biometric 能力の機種別ゲート(DeviceProfiles 移植)〔BLEP-05 / Medium〕
- **対象**: [src/ble/devicemodel.js:90](src/ble/devicemodel.js:90)、[src/ble/index.js:213-222](src/ble/index.js:213)
- **参照**: `CHSesameBiometricDevice.kt:28-57`(`BiometricCapability {CARD, FINGERPRINT, PASSCODE, FACE, PALM}` の機種別集合: TOUCH=card+fp / TOUCH_PRO=+passcode / FACE=card+fp+palm+face / FACE_AI=palm+face のみ / …)、`CHDeivceProtocols.kt:81,112,118,172`(**OpenSensor/Remote/RemoteNano は空集合**)
- **問題**: kind=BIOMETRIC 一律で全機能を露出するため、open sensor に card enroll、ssm_touch に passcode 等、SDK が許さない API が見えている。
- **修正手順**: PRODUCT_TYPES に `bioCaps` 集合を 1:1 移植し、`biometric` ゲッタで集合外メソッドを持たない限定ビューを返す(既存 fingerPrint ゲッタと同型)。`ssm_touch` から passcode 系が見えない・`open_sensor_1` で biometric ゲッタが throw する、をテストで固定。あわせて **BLEP-09**(REMOTE_NANO_PUB_TRIGGER_DELAYTIME(191) を remote/remote_nano 以外で黙殺)と **BLEP-11**(open sensor の `parsePubKeySesame(isOpenSensor)` 結線 — `CHSesameBiometricDeviceImpl.kt:225-231`)も model 伝搬の同一改修で解決する。

#### P3-16. Hub3 BLE ネットワーク状態(mechStatus 81)の解析追加〔BLEP-06 / Medium〕
- **対象**: [src/ble/hub3.js:233-234](src/ble/hub3.js:233)(誤コメント + 未解析)
- **参照**: `CHHub3Device.kt:291-301`(payload[0] の bit フラグ → isAp/isNet/isIot/各 Connecting)。同一 bit layout の解析器は [src/ble/wm2.js:265-279](src/ble/wm2.js:265) に実装済み。
- **修正手順**: `parseNetworkStatus` を共有化し、hub3.js の publish パースに `MECH_STATUS → {kind:"networkStatus", …}` を追加。誤コメント削除。bit ベクタテスト追加。

#### P3-17. BLE 小型修正群〔BLE3-03, BLE3-04, BLE3-05, BLE2-07, BLE2-08, BLE2-09, BLEP-07, BLEP-10 / Low〕
1. **BLE3-03**: Hub3/WM2 では login 後の time(8) 同期を送らない(`CHHub3Device.kt:167-178` は handleLoginResponse を呼ばない)。session に time 同期フラグを追加しファサードで抑制。
2. **BLE3-04**: Bot の mechStatus 既定値を SDK interface 既定(`position=0, target=0, isCritical=null`)に揃える。`STP_ITEM_CODE_DEVICE_STATUS(183)` 定数を追加(BLEP-10 と同件)。
3. **BLE3-05**: initial token 4B 固定の根拠(CCM nonce 13B 制約)をコメントに明記し、4B 超は明示エラー化。
4. **BLE2-07**: OS2 `parseLoginResponse` に mechSetting 解析(`lockPosition`/`unlockPosition`、`isConfigured = lock != unlock`、Bot の 7 フィールド — `CHSesame2.kt:24-27`)を追加し、facade に `loginInfo.isConfigured` を露出。
5. **BLE2-08**: OS2 target/position の度数変換(`*360/1024`)を SDK と揃える(`positionDeg` 併記でも可。単位を docs に明記)。
6. **BLE2-09**: `_maybeSyncTime` に `fwVersion >= 1` ガード(`CHSesame2Device.kt:262`)。
7. **BLEP-07**: wm2 `networkStatus()` 送信は SDK に存在しない発明 — hub3.js:323 同様の未検証注記を付けるか削除して onPublish 購読へ誘導。

#### P3-18. webapi/battery の strict 検証を実応答に合わせる〔CLOUD-17 / Low〕
- **対象**: [src/devices.js:203,261](src/devices.js:203)
- **問題**: vendor が success を見ない op に `strict:true` を課しており、実サーバが success を省略すると正常応答を例外化する。
- **修正手順**: 実応答キャプチャ(§9)で success の有無を確認後、無ければ非 strict(success===false のみ拒否)へ。

---

## Phase 4 — CLI/RPC/SDK 経路対称性の回復

#### P4-1. BLE 操作の経路体系を再設計(コンセプト違反の本丸)〔SURF-08 / High〕
- **現状**: BLE の書き込み系(biometric 登録/削除、Bot2 スクリプト書込、WM2/Hub3 Wi-Fi provisioning、OTA、reset、configureLockPosition、OS2 固有 op 等)は `ble.invoke`/`ble.os2.invoke` の**文字列 op パス**でしか RPC から呼べず、CLI には汎用脱出口すら無い。openrpc/SDK 型に個別 op が現れず、typed SDK の価値が BLE 面で全損している([src/cli/ble.js:8-9](src/cli/ble.js:8) の設計コメントが意図的にこの形にしたと明記)。
- **修正手順**(段階):
  1. **即効**: CLI に `sesame ble invoke <device> <op> [--args <json>]`(デーモン不要、SesameBle 直叩き)を追加し最低限の経路対称性を確保。
  2. **高価値 op の専用化**: `sesame ble ota <device>` / `ble reset <device>` / `ble wifi <device> scan|ssid|password|connect` / `ble enroll <card|passcode|finger|face|palm> <device>` / `ble position <device> <lock> <unlock>`。RPC は `ble.updateFirmware` / `ble.reset` / `ble.wifi.*` 等を registry に追加。
  3. **中期**: SesameBle ファサードのメソッド表(BLEP-05 で導入する bioCaps 含む)から registry エントリを自動生成する「BLE 版 NAMESPACE_OPS」を作り、手書き二重化を防ぐ。
- **受け入れ基準**: §「能力マトリクス」の BLE 行から「△(invoke のみ)」が消える(または明示的に脱出口専用と docs 宣言される)。

#### P4-2. ble.invoke の fail-open を allowlist 化〔ARCH-14 / Medium・セキュリティ〕
- **対象**: [src/serve/registry.js:140-163](src/serve/registry.js:140)(`invokePath` — ブロックリストのみで facade 全公開面に到達可、getter は実行される)
- **修正手順**: ble/index.js から `BLE_RPC_ALLOWLIST` を export し、invokePath 冒頭で第 1 セグメントを照合する fail-closed へ反転。否定ケーステストを追加。P4-1 の自動生成と同じ表を使う。

#### P4-3. RPC/SDK 表面の欠落補完〔SURF-04, SURF-05, SURF-06, SURF-07, SURF-23, SURF-24 / Medium-Low〕
1. **SURF-04**: `registerPasscodes`(syncEnrolledPasscodes)を SesameHub3 メソッド + RPC `access.registerPasscodes` + CLI `access passcodes enroll` に追加(cards と対称に)。
2. **SURF-05**: CLI `sesame ir remote-add --json <file|->` を追加(`ir search`/`match` の出力をそのまま渡せる入力契約)。
3. **SURF-06**: RPC `status.ping`(biz3KeepAlive 1 往復)を追加 — RPC 消費者が実疎通を確認できるように。
4. **SURF-07**: config 同期 6 メソッドを RPC `config.syncLocks/syncHub3s/syncRemotes/syncRemoteKeys` として experimental 公開(daemon は同じ ConfigStore を持つ。書込み許可の方針判断を docs に明記)。
5. **SURF-23**: `sesame iot raw --topic --payload [--await]` を追加するか、意図的に CLI から塞ぐ旨を docs に明記。
6. **SURF-24**: `ir.listKeys` に `hub3DeviceId`/`irDeviceUUID` 直指定(config 非依存)を追加(emit 側 presetir.sendIR との対称性)。

#### P4-4. RPC 契約の意味整合〔SURF-09, SURF-15 / Medium〕
1. **SURF-09**: namespace op の `companyID`/`subUUID` は daemon が自動注入するのに契約上 required:true。→ gen-rpc-schema で required:false に上書き + description に注入を明記。daemon 起動時に `refreshAccount` を一度実行し、config 既定値と実 companyID の食い違いを解消。
2. **SURF-15**: `lock.setAutolock`(cloud 経路・実機反映未確認)と CLI autolock(BLE 経路)の保証差を解消 — registry に `transport: "cloud"|"ble"` パラメータ(既定 ble)を追加するか、openrpc summary に「cloud 経路は実機反映未確認」を明記。

#### P4-5. エラーモデルの経路間一貫性〔SURF-10, SURF-11 / Medium〕
1. **SURF-10**: HTTP ステータス → kind/retryable 写像が 4 実装(TS SDK / Py SDK / thin js / thin py)でバラバラ(403 が Py で internal、404 が TS で bad_params 等)。→ 写像表を 1 つ定義(400/413/415→bad_params, 401/403→not_authenticated, 404→not_implemented, 408/429/5xx→connection_lost(retryable), else internal)し、gen-sdk-ts/py のテンプレートと clients/ 2 実装を揃え、共有 fixture で 4 実装を突き合わせるテストを追加。
2. **SURF-11**: `BleResultError`(resultCode/resultName 付き)が RPC 境界で kind=internal に潰れる。→ [src/serve/jsonrpc.js:172-191](src/serve/jsonrpc.js:172) の errorFromThrow に分岐を追加し、`data: { bleResultCode, bleResultName, itemCode }` を透過。

#### P4-6. 一貫性の小型修正群〔SURF-16=ARCH-07, SURF-19, SURF-20, SURF-21, SURF-22 / Low〕
1. **SURF-16**: `SUBSCRIBABLE_TOPICS` の二重定義を解消 — [src/serve/daemon.js:45](src/serve/daemon.js:45) を削除し registry から import。
2. **SURF-19**: BLE 環境エラー(BLE_UNAUTHORIZED 等)の exit code 2(=usage の契約)を 1 に変更。`sesame rpc` の bad_params → exit 2 写像を検討。README の終了コード表更新。
3. **SURF-20**: registry summary の i18n 混在を解消(全 `t("serve.sum.*")` 化、または「summary は英語 canonical」と決めて t() を剥がす — 後者推奨。gen-openrpc が en 固定のため)。
4. **SURF-21**: clients/js の `SesameErrorKind` union に `"rejected" | "internal"` を追加。
5. **SURF-22**: gen-grpc-proto.mjs:67 の `Discover` 重複 rpc を削除(後方互換要なら deprecated 注記付きで次 major まで)。

---

## Phase 5 — アーキテクチャ刷新

#### P5-1. パッケージングの分離(ライブラリ利用者から CLI/TUI/serve 依存を外す)〔ARCH-01 / Critical(コンセプト適合)〕
- **現状**: `import "sesame-kit"` するだけの利用者にも ink/react/@inquirer/commander/@grpc 等が強制され、prod 依存ツリー 344 パッケージ・約 35MB。ライブラリコンセプト(組み込みやすさ・依存の軽さ)と直接矛盾。
- **修正手順**(2 段階):
  1. **即効(非破壊)**: ink / react / ink-select-input / ink-text-input / @inquirer/prompts / commander / @grpc/grpc-js / @grpc/proto-loader を optional な peerDependencies に移し、利用箇所を dynamic import + 未導入時の案内エラーに変更(session-ui は遅延済み、grpc は `startGrpcFraming` 内 `await import` 化、qrcode-terminal に前例あり)。`npx sesame-kit` / グローバル install では npm が peer を自動解決しない問題があるため、**bin 利用者向けに install ガイドを README へ追記**するか、次項へ進む。
  2. **本筋(メジャー)**: npm workspaces で `sesame-kit`(core: ws + 内製 cmac のみ)/ `sesame-kit-cli`(bin・ink・commander)/ `@sesame-kit/serve-grpc` に分割。`exports` の `"./client"` と bin は CLI パッケージへ。
  3. P2-2(aws-sdk 除去)・P5-2(cmac 内製)が core の依存をほぼゼロにする前提工事。
- **受け入れ基準**: `npm i sesame-kit` 後の node_modules が ws + noble(optional)程度になり、`node -e "import('sesame-kit')"` の所要が 200ms → 数十 ms 級に下がる。

#### P5-2. node-aes-cmac の内製化〔ARCH-03 / Medium〕
- **問題**: 2014 年公開・無メンテの外部パッケージがロック施錠 MAC 生成というセキュリティ要所にあり、内部で deprecated な `new Buffer(...)` を使用。純 JS 約 70 行相当。
- **修正手順**: `src/aes-cmac.js` を RFC 4493 準拠で実装(subkey 生成 + AES-128-CBC 1 ブロック、約 50 行)。既存の RFC 4493 Test Vector テスト(tests/crypto/cmacTime.test.js:217)が受け入れテストになる。import 差し替えは 3 ファイル([src/crypto.js:12](src/crypto.js:12), [src/ble/protocol.js:15](src/ble/protocol.js:15), [src/ble/os2/protocol.js:25](src/ble/os2/protocol.js:25))。

#### P5-3. cli.js モノリス(2497 行)の分割〔ARCH-04 / High〕
- **修正手順**: 既存の `registerXxxCommands(program)` パターンを踏襲して抽出 — ① `src/cli/session.js`(session コントローラ群: cli.js:1733-1978。session-ui.js と対に)② `src/cli/migrate.js`(cmdMigrate + dotenv パーサ: 2062-2167)③ `src/cli/auth.js`(login/verify/setup/refresh/logout/whoami)④ `src/cli/lock-ops.js`(pickTransport/runBleOp/runCloudOp/cmdAct)⑤ `src/cli/ctx.js`(loadCtx/out/redactConfig)。cli.js は run() + コマンド登録のみ(~500 行)へ。挙動変更なし・テストはそのまま通ること。

#### P5-4. 重複ロジックの一本化〔ARCH-05, ARCH-08, ARCH-20 / Medium-Low〕
1. **ARCH-05**: name 解決(default/単一フォールバック)の 2 実装([src/config.js:410-421](src/config.js:410) vs [src/lock-manager.js:51-62](src/lock-manager.js:51))を純関数 `resolveByName(map, name, defaultName, errFactory)` に統一。エラーは `SesameError(BAD_REQUEST)` に揃える(ConfigStore 経路の plain Error が serve で internal に落ちる問題も解消)。
2. **ARCH-08**: hex 変換 4+ 実装を `crypto.js` の `hexToBuf/bufToHex` に集約。
3. **ARCH-20**: `sesame rpc` 用の自前 JSON-RPC クライアント([src/cli/serve.js:162-283](src/cli/serve.js:162))を `clients/js/sesame-client.mjs` ベースに書き換え(~120 行削減、timeout/ready 処理の一元化)。

#### P5-5. エラー設計の方針確立〔ARCH-09 / Medium〕
- **問題**: SesameError 採用が cloud 系に偏り、BLE/config の plain Error が serve で kind=internal に潰れる。
- **修正手順**: ① 「呼び出し側不正 = `badRequest()` / 内部不変条件 = plain Error」の線引きを [src/errors.js](src/errors.js) ヘッダに明文化。② config.js のドメイン操作と ble/index.js 公開面入口を SesameError 化。③ ble facade 入口で内部 Error を SesameError(BAD_REQUEST/REJECTED) に包む境界を 1 枚立てる(P4-5-2 と連動)。

#### P5-6. config のスキーマバージョンとマイグレーション体系〔ARCH-12 / Medium〕
- **修正手順**: ① `schemaVersion: 2` を emptyConfig/PERSISTED_KEYS に追加。② save() は未知キーを**保持**する方針へ(ダウングレード/新旧併用で黙って消えるのを防ぐ。ホワイトリストは派生 view の除外専用に)。③ 旧 shape 変換を `MIGRATIONS = {1: fn}` テーブルへ切り出し、normalizeConfig は最新 shape の正規化のみに。

#### P5-7. 型・テスト基盤の補強〔ARCH-15, ARCH-16, ARCH-17 / Medium-Low〕
1. **ARCH-15**: `@types/ws` を devDeps に追加し抑制 2 箇所 + 自前 WsLike typedef を削除。session-ui.js の `@ts-nocheck` を外し主要 props に JSDoc typedef(cli.js:1932,1948 の型ギャップ自認コメントも解消)。**TS 全面移行は見送り**(型の嘘が少なく d.ts 生成 + CI ゲートが機能しているため、移行コスト>効果)。
2. **ARCH-16**: 8+ ファイルで再実装されているモック WS クライアントを `tests/helpers/mock-ws.js` に集約(org.test.js 版を採用、`{strictRequestOnly}` オプションで差分吸収)。
3. **ARCH-17**: 直接テストの無い防御要所に小型ユニットテスト 4 本 — ndjson(maxLine 超過・背圧)/ token(timingSafeEqual 長不一致)/ subscribeChunks(二重 finish・timeout 後 push)/ lock-manager。

#### P5-8. CI・リリースの近代化〔ARCH-18, ARCH-21 / Medium〕
1. linter 導入(biome 推奨、または eslint flat config)+ `npm run lint` を CI に追加。[src/config.js:767](src/config.js:767) の存在しない linter への死んだ directive を削除。
2. CI に `npm audit --omit=dev --audit-level=high` ゲートを追加(README の「audit 0 件」主張の継続検証)。
3. release を tag-push トリガの GitHub Actions(`npm publish --provenance`)へ移行し、release.sh は bump+tag まで に縮小。
4. `.gitattributes` に `types/** linguist-generated=true` 等を追加し生成物 diff を折り畳み(直近 30 コミットで types/ 変更 311 ファイルのレビューノイズ対策)。

#### P5-9. 命名・衛生の小型修正〔ARCH-19, ARCH-22, ARCH-10 / Low〕
1. **ARCH-19**: clients/js の `SesameError`(kind/code:number)を sdk/ts と同じ `SesameRpcError` に改名し、`export { SesameRpcError as SesameError }` を 1 リリース維持(core の `SesameError`(code:string)との同名異義を解消)。ファイル命名は「新規はハイフン区切り」を CONTRIBUTING に明文化(既存 rename はしない)。
2. **ARCH-22**: リポジトリ直下の `keys.json`(個人 artifact、gitignore 済み)をリポジトリ外へ移動し、migrate の srcDir 指定を README に明記。
3. **ARCH-10**: bare catch 103 箇所は意図コメント付き best-effort と確認済み(バグ隠蔽パターンなし)。`_log` のあるクラスでは `catch (e) { this._log(...) }` への置換を機械適用(最低優先)。

---

## Phase 6 — ドキュメント正直化

> 原則: 「実装済み」「不可能」「SDK と一致」の各主張に参照 file:line の根拠を持たせる。Phase 1-5 の修正に随伴する記述変更は各 PR に含め、ここは残りの一括是正。

#### P6-1. README「Known limitations」の全面書き直し
- P1-7(MOVE_TO 記述の虚偽)、P2-1(REST ホスト「参照に無い」は虚偽 / Bearer 認可の未検証→SigV4 化)、P3-14(209 の出典)、BLEP-01(WM2「ported 1:1」の隠蔽)を反映。
- **CLOUD-15**: 「AWS IoT WS requires IPv4」→ 接続先は **API Gateway (execute-api)** であり AWS IoT ではない。主語を修正し IPv4 制約は実測根拠を脚注化。
- 検証済みの真実(autolock cloud 不可、IR 2 経路、WS stage /public — 監査で参照と整合を確認済み)はそのまま維持。

#### P6-2. Stripe 記述の訂正〔BIZ-06〕
- 「Stripe.js-capable client が必須」は技術的事実ではない(web コードから、必要なのは client_secret(取得済み)+ publishable key(`env_config.js:5-7` にハードコード)のみで、`POST /v1/payment_methods` → `POST /v1/setup_intents/{id}/confirm` の公開 API で完結できる)。→ 「本 kit はカード情報を扱わない方針のため confirm を実装しない。Stripe 公開 API か Stripe.js で confirm し、payment_method を `payment.changeDefaultPayment` に渡す」へ訂正。confirm の薄い実装は §10 のオプションバックログ。

#### P6-3. 認証まわりの記述是正〔AUTH-02, AUTH-09, AUTH-10, BIZ-13〕
1. AUTH-09: 「biz3 の client id 21u50… から差し替え」「唯一の機能的相違」(auth.js:14-17 / docs/{en,ja}/architecture.md:22)は現行参照(`aws-exports.js:5` = 同一 Consumer Client)と矛盾 — 歴史的経緯として書き直し。
2. AUTH-10: docs/architecture に認可マトリクス(① API GW REST = SigV4+x-api-key+appidentifyid ② AWS IoT MQTT-WSS = unauth identity SigV4(kit 未実装)③ biz3 web WS = idToken query)と kit の実装状況を追記。
3. BIZ-13: [src/access.js:386-388](src/access.js:386) の「サーバは応答 op を返さない」断定を「参照はコールバック未登録で応答を無視する(useManageAuthData.js:265 にハンドラ存在)」に訂正。
4. logout の「公式アプリ相当」注記([src/auth.js:502-535](src/auth.js:502))を「公式はローカル signOut のみ。ForgetDevice+RevokeToken は本 kit の意図的な強化」へ。

#### P6-4. 経路・契約ドキュメントの整合〔SURF-12, SURF-13, SURF-14, SURF-18, CLOUD-14, ARCH-11〕
1. SURF-12: 「clients は every framing 対応」は虚偽(js: UDS/HTTP/WS、py: UDS/stdio/HTTP、**gRPC は両方無し**)— 実装通りに修正(または欠けトランスポート実装)。
2. SURF-13: docs/api-stability.md の stale(「~15 methods + 2 events」→ 実数 13+3、iot 11→10 op、解決済み issue #2/#3/#5 の注記)。stability.js と docs の突き合わせテスト化を検討。
3. SURF-14: 「stable core `lock.*`」→ setAutolock は experimental のため列挙表記へ。
4. SURF-18: docs/en/commands.md に Auth & setup 節(login/verify/refresh/logout/whoami/init/setup/migrate/config/bootstrap/meta/ping)を追加(ja 同期)。
5. CLOUD-14: 再接続 queue の vendor 逸脱(同一 action 圧縮をしない)を transport.js ヘッダの逸脱一覧へ追記。
6. ARCH-11: docs/en/library.md に「ライブラリ throw の message はロケール依存。機械分岐は err.code で」を 1 節追加。

---

## 9. 実機検証バックログ(コード修正後に必要なキャプチャ)

> 修正の多くは「Kotlin から導出したベクタ」で受け入れ可能だが、以下は実機/実サーバでしか確定できない。検証完了まで該当 API は `@experimental` + 未検証マーカーを維持する。

| # | 対象 | 検証内容 | 関連 |
|---|---|---|---|
| V1 | OS2 実機(SESAME 3/4 等) | P1-1〜P1-5 修正後の login/lock/unlock/履歴/register 一連 | BLE2-* |
| V2 | WM2 実機 | P1-6 の新セッション層(INITIAL=13/暗号/login16B) | BLEP-01 |
| V3 | Bot2/Bike2 実機 | 67B register 応答(P1-8) | BLEP-03 |
| V4 | OS3 register(SS5/Hub3) | 64B/77B 応答・`needAuthFromServer`・SigV4 REST(P2-1) | AUTH-01 |
| V5 | biometrics REST | SigV4 化後の `/device/v1/biometrics` 受理(P2-1) | BIZ-07 |
| V6 | Hub3 networkType | 209 が実機で応答するか(しないなら機能削除)(P3-14) | BLEP-02 |
| V7 | IR 一覧/学習 | getRemoteList 実応答形・learn の success:false 実例(P1-12, P1-14) | CLOUD-02/04 |
| V8 | access getCards | 完了通知と pub の到着順序(P3-12 の grace 撤廃可否) | BIZ-03 |
| V9 | webapi/battery | success フィールドの有無(strict 解除判断)(P3-18) | CLOUD-17 |
| V10 | getRegisterKey | OS2 server-auth の実機鍵合意(P1-5 後) | BLE2-05 |

## 10. 見送り・非実装が正と確定した事項

調査の結果、以下は**参照実装に存在しない/参照と整合済み**であり、実装しないことが正:

1. **autolock のクラウド設定** — `CHSesame5Device.kt:96-105` は BLE 限定で cloud フォールバック無し、web IoT cmd にも無し。README の記載は真実(維持)。
2. **schedule 作成系 op** — 参照(web 全 grep)に list/cancel しか存在しない。現状の限定実装が正。
3. **Stripe SetupIntent confirm の kit 内実装** — 技術的には可能(P6-2)だがカード情報を扱わない方針として非実装を維持(やるなら別パッケージ/オプトイン)。
4. **TypeScript 全面移行** — 型の嘘が少なく(抑制 4・二重キャスト 22)、d.ts 生成 + CI drift ゲートが機能しているため見送り(ARCH-15)。
5. **i18n 再設計** — en/ja 1072 キー完全パリティ・ハードコード残存ゼロを確認。プロセスグローバルロケールは CLI 製品として妥当。docs 追記のみ(P6-4-6)。
6. **Android 固有の付帯 REST**(feedHistory/battery post/SNS subscribe/friend 等)— アプリ専用テレメトリで web にも無く、kit のスコープ外と明記。

## 11. 推奨実施順序

```
Week 1-2 : Phase 1 全件(1 所見 = 1 PR、モック修正を必ず同梱)
           └ 並行: P2-9 (REFERENCES.md 規範修正 — 全作業の前提)
Week 2-4 : Phase 2 (P2-1/P2-2 は同一作者推奨。auth はテスト密度が高く独立性あり)
Week 3-6 : Phase 3 (3A/3B/3C は領域ごとに並行可)
Week 5-7 : Phase 4 (P4-1 の方針決定を先に。P4-3 以降は機械的)
Week 7-10: Phase 5 (P5-1 パッケージング分割は major リリースに合わせる)
随時     : Phase 6 (各修正 PR に随伴 + 最終一括レビュー)
```

**マイルストーン M1(Phase 1 完了)**: 「実機で動かない実装が、参照由来ベクタのテストで検出される状態」に到達。
**マイルストーン M2(Phase 2-3 完了)**: 参照実装とのワイヤ互換が(実機未検証マーカー付き部分を除き)宣言できる。
**マイルストーン M3(Phase 4-5 完了)**: 「全機能 × 全経路」のマトリクスに穴が無く、core パッケージが軽量化された v1.0 候補。

# spec ファイル書式定義（機械可読グラマー）

このファイルは `spec/*.md`（`_` で始まるメタファイル・`README.md` を除く全ドメイン spec）の
**書式の単一真実源**である。カバレッジ検証テスト（spec↔test ガード, 後述）は、ここで定義した
正規表現で各 spec エントリを抽出・検証する。**書式を変える場合はガードと本ファイルを同時に更新すること。**

---

## 1. ファイルの役割

- 1 ファイル = 1 ドメイン = 1 **ID プレフィックス**（例 `spec/auth.md` → `AUTH`）。
- spec エントリは「テストの**索引**」であって、アサーションそのものではない。
  実際の検証は対応するテストが行う。spec は「何を・どの境界で・どの移植元に照らして
  検証するか」を 1 行で宣言し、ID で一意に参照できるようにする。
- spec ↔ test の対応は **テスト側のタイトル先頭に `[ID]` を書く** ことで張る
  （例 `it("[AUTH-0007] ChallengeResponses が ...", ...)`）。spec 側にテストファイル名は
  **書かない**（双方向参照を持つと必ず腐るため、参照方向は test → spec の一方向に固定する）。

---

## 2. ファイル先頭フロントマター（必須）

各ドメイン spec ファイルは次の HTML コメントを **1 行目** に持つ。ガードがプレフィックスと
ファイル名の対応を機械検証するために使う。

```
<!-- spec-domain: auth | prefix: AUTH | tests: packages/core/tests/auth, packages/kit/tests/cli -->
```

- `spec-domain`: ドメイン slug（ファイル名 `spec/<slug>.md` と一致）。
- `prefix`: このファイルが占有する ID プレフィックス（`[A-Z][A-Z0-9]{1,5}`）。**全ファイルで一意**。
- `tests`: 対応テストが置かれるディレクトリ（カンマ区切り、リポジトリ相対）。ガードのカバレッジ
  走査範囲のヒント（厳密強制はしないが、レビューの目印）。

---

## 3. spec エントリの書式

1 エントリ = 見出し（`###`）+ 直後のフィールド箇条書き。**順序は固定**。

```
### [AUTH-0007] verify → RespondToAuthChallenge (CUSTOM_CHALLENGE / OTP)
- surface: cli, serve, sdk, core
- backend: cloud
- command: `sesame verify [code]` / account.whoami
- branch: code-arg | interactive-prompt | wrong-code-retry
- assert: ChallengeResponses のキー集合と ANSWER 形が AWSMobileClient の RespondToAuthChallenge(CUSTOM_CHALLENGE) と一致する
- ref: _aws_sdk_ref/CognitoUser.java:3979-4097; _sesame_sdk_ref/.../LoginMailFG.kt:106-127
- kind: wire-fidelity
- status: planned
```

### 3.1 見出し行

```
### [<ID>] <title>
```

- `<ID>` … `<PREFIX>-<NNNN>`。`NNNN` は 4 桁ゼロ詰め連番（ファイル内で一意・昇順推奨）。
  抽出正規表現: `^###\s+\[([A-Z][A-Z0-9]{1,5}-\d{4})\]\s+(.+)$`
- 欠番可（削除した ID は再利用しない＝ID は永続）。
- `<title>` … 人間可読の短い説明（日本語可）。メソッド名/コマンド名を含めると検索しやすい。

### 3.2 フィールド（すべて `- key: value` 形式、この順）

| key | 必須 | 値（語彙） | 説明 |
|---|---|---|---|
| `surface` | ✓ | `core` `serve` `sdk` `cli` の 1 つ以上をカンマ区切り | この spec が成立する**クライアント面**。`core`=`@sesame-kit/core` 直接呼び出し、`serve`=常駐デーモン経由（全 framing）、`sdk`=生成クライアント(ts/py)、`cli`=`sesame …`。 |
| `backend` | ✓ | `cloud` `ble` `ble-os2` `local` の 1 つ以上 | 実際に叩く**バックエンド**。`cloud`=Cognito/IoT/biz3 web、`ble`=OS3 直結、`ble-os2`=OS2 直結、`local`=ネットワーク非依存（config/暗号/引数解釈など）。 |
| `command` | ✓ | 自由（`code`/メソッド名/CLI 文字列） | 対象の CLI コマンドまたは契約メソッド名。複数は ` / ` 区切り。 |
| `branch` | ✓ | 自由（`-` で「分岐なし」） | オプション/状態による分岐の列挙。` \| ` 区切り（例 `--ble-only \| --cloud-only \| auto`）。 |
| `assert` | ✓ | 自由（日本語可） | 検証する**境界**を 1 行で。「何が移植元と一致するか」を書く。 |
| `ref` | ✓ | 移植元/契約の出典 | `_aws_sdk_ref/…:行`, `_sesame_sdk_ref/…`, `references_web/…:行` を `;` 区切り。純ローカル契約は `local-contract`（出典なし）と書く。 |
| `kind` | ✓ | §4 の語彙 1 つ | テストの種類。 |
| `status` | ✓ | §5 の語彙 | ライフサイクル状態。 |
| `note` | 任意 | 自由 | 補足（既知の `未確認` 箇所・関連 ID `[[LOCK-0003]]` リンク等）。 |

抽出正規表現（フィールド）: `^- (surface|backend|command|branch|assert|ref|kind|status|note):\s*(.+)$`

---

## 4. `kind` 語彙（テスト種別）

| kind | 意味 |
|---|---|
| `wire-fidelity` | クラウドへ送る/から受ける**メッセージ形**（JSON-RPC/Cognito/IoT/WS フレームのキー・値・enum）が移植元と一致する。 |
| `payload-fidelity` | BLE へ書く/から読む**バイト列**（ItemCode・CCM・mech status のレイアウト）が SesameSDK と一致する。 |
| `crypto-vector` | 暗号プリミティブの既知応答ベクタ（HKDF/SRP/AES-CMAC/ECDH/SigV4 canonical）。 |
| `contract-existence` | 契約面の存在/形（openrpc/proto/registry/SDK にメソッドが 1:1 で在る、署名が一致する）。 |
| `surface-parity` | 同一操作が複数面（cli/serve/sdk/core, 各 framing）で**同じ結果/同じ封筒**になる。 |
| `option-branch` | コマンドのオプション/引数/状態による**分岐**の挙動（経路選択・既定値・必須検証）。 |
| `error-path` | 異常系（バリデーション失敗・サーバ拒否・タイムアウト・権限）と**終了コード/エラー封筒契約**。 |
| `idempotency` | 再送/重複/再接続時の冪等・相関（FIFO 相関, resubscribe 等）。 |
| `i18n` | ロケール別メッセージ/カタログ完全性。 |

---

## 5. `status` 語彙（ライフサイクル）とガードの強制規則

| status | 意味 | ガードの扱い |
|---|---|---|
| `planned` | 索引化済み。テストは**未作成**（これから書く）。 | テスト存在は**要求しない**（カタログのみ）。`[ID]` タグ付きテストが見つかったら「`covered` に更新せよ」と警告。 |
| `covered` | 対応テストが存在する。 | `[ID]` タグ付きテストが **1 個以上必須**。0 個なら **FAIL**。 |
| `waived: <理由>` | テストを**作らない**と決めた境界（例: 実機/実クラウド必須の E2E）。 | `[ID]` タグ付きテストが存在したら「waive 解除して covered にせよ」と警告。理由必須。 |

- `waived:` は「E2E は諦める」を機械的に表現する手段。諦めた境界も**カタログには必ず残す**
  （諦めた事実と理由を ID で追跡できる）。
- ガードは status に関わらず常に次を強制する: **(a)** ID の一意性・書式、**(b)** プレフィックス↔
  ファイル名一致、**(c)** 全必須フィールドの存在、**(d)** `surface`/`backend`/`kind`/`status` が
  語彙内、**(e)** テスト側 `[ID]` タグがすべて実在 spec を指す（孤児タグ＝FAIL）、
  **(f)** フィールド出現順が §3.2 の固定順、**(g)** 1 エントリ内に重複フィールドキーが無い、
  **(h)** `ref` の各部分が `local-contract` か `path:line`（`-`範囲・`,`複数可）で、参照ファイルが**実在**する。

---

## 6. spec↔test ガード（カバレッジ検証テスト）の仕様

実装先: `packages/kit/tests/spec-coverage.test.js`（unit）。手順:

1. `spec/*.md`（`README.md` と `_*.md` を除外）を読み、§2/§3 の正規表現で全エントリを抽出。
2. 構造検証（§5 の (a)〜(d),(f),(g),(h)）。違反は FAIL。`ref` は出典ファイルの**実在**まで機械検証する
   （行番号の妥当性は対象外＝レビューと敵対的検証で担保）。
3. `packages/*/tests/**/*.test.js` を読み、テストタイトル内の `[<ID>]`（正規表現
   `\[([A-Z][A-Z0-9]{1,5}-\d{4})\]`）を全収集 → **spec→test の被覆マップ**を作る。
4. カバレッジ検証（§5）:
   - `covered` で被覆 0 → FAIL（ID 列挙）。
   - 孤児タグ（spec に無い ID をテストが参照）→ FAIL。
   - `planned` で被覆あり / `waived` で被覆あり → 警告（非致命、`status` 更新を促す）。
5. レポート: ドメイン別の `planned/covered/waived` 件数と被覆率を出力。

> 段階導入: 当面は spec を `planned` で起こし、テストを書いた時点で `[ID]` を付け `covered` に
> 上げる。これでガードは壊れず、被覆は単調増加する。

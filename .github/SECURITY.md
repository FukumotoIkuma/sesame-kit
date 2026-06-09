# Security Policy / セキュリティポリシー

## Reporting a vulnerability / 脆弱性の報告

**Please do not open a public issue for security vulnerabilities.**
**脆弱性は公開 Issue に書かないでください。**

Report privately via GitHub's [private vulnerability reporting](https://github.com/FukumotoIkuma/sesame-kit/security/advisories/new).
GitHub の[非公開報告フォーム](https://github.com/FukumotoIkuma/sesame-kit/security/advisories/new)から報告してください。

If you cannot use that, email the maintainer (see the GitHub profile of
[@FukumotoIkuma](https://github.com/FukumotoIkuma)).
利用できない場合はメンテナ（[@FukumotoIkuma](https://github.com/FukumotoIkuma) のプロフィール参照）へメールしてください。

We aim to acknowledge reports within **72 hours**.
**72時間以内**の一次応答を目指します。

## Make the report executable / 報告を「実行可能」に

This project favors **proof over prose**, especially for security.
本プロジェクトは、特にセキュリティで**文章より証明**を重視します。

The most actionable report includes, when feasible:
可能であれば、最も対応しやすい報告は次を含みます:

1. A **failing test / PoC** that demonstrates the vulnerability — ideally a `vitest`
   test under `tests/` that fails because the insecure behavior is present.
   脆弱性を示す**失敗テスト / PoC**（理想は `tests/` 配下の vitest で、危険な挙動ゆえに落ちるもの）。
2. The conditions required to trigger it (versions, transport: BLE/cloud, config).
   発生条件（バージョン、経路：BLE/クラウド、設定）。
3. Suggested impact and, if you have one, a fix.
   想定される影響と、あれば修正案。

A fix is considered sufficient when that test goes **green** and CI proves it.
そのテストが**緑**になり CI が証明した時点で、修正が十分とみなせます。

⚠️ Never include real tokens, secret keys, or device secrets in a report.
⚠️ 実トークン・秘密鍵・端末の秘密情報は報告に含めないでください。

## Scope / 対象範囲

This is an **unofficial** library and is not affiliated with CANDY HOUSE.
本ライブラリは**非公式**であり、CANDY HOUSE とは無関係です。
Vulnerabilities in the SESAME hardware or official cloud should be reported to
CANDY HOUSE, not here. Report here for issues in **this codebase**
(crypto handling, token storage, BLE/RPC logic, dependency risks, etc.).
SESAME ハードウェアや公式クラウド自体の脆弱性は CANDY HOUSE へ。ここでは**本コードベース**
（暗号処理・トークン保管・BLE/RPC ロジック・依存関係リスク等）の問題を報告してください。

## Dependency advisories / 依存関係の advisory

BLE support relies on the **optional** native dependency `@abandonware/noble`
(under `optionalDependencies`); cloud / CLI / `sesame serve` do not need it. Its
native toolchain (`node-gyp`) historically pulled in a vulnerable `node-tar`. We
pin a patched release via a package.json `overrides` field
(`"overrides": { "tar": "^7.5.11" }`), after which `npm audit --omit=dev` reports
**0** vulnerabilities. If a future advisory cannot be cleared without breaking the
optional native build, it will be documented here as an optional-only advisory
that affects only users who install `@abandonware/noble` for BLE.
BLE 対応は**任意**のネイティブ依存 `@abandonware/noble`（`optionalDependencies`）に依存し、
クラウド / CLI / `sesame serve` には不要です。そのネイティブツールチェーン（`node-gyp`）は従来
脆弱な `node-tar` を引き込みました。package.json の `overrides`（`"overrides": { "tar": "^7.5.11" }`）で
パッチ版に固定しており、適用後 `npm audit --omit=dev` は脆弱性 **0** を報告します。今後、任意の
ネイティブビルドを壊さずに解消できない advisory が出た場合は、BLE 用に `@abandonware/noble` を
インストールしたユーザのみに影響する「任意依存限定の advisory」としてここに記載します。

## Supported versions / サポート対象

The latest released version on the `main` branch is supported.
`main` ブランチの最新リリースをサポート対象とします。

// kit テスト用の追加セットアップ: CLI/serve/session カタログを core へ登録する。
// kit テストが t("cli.*") / t("serve.*") / t("session.*") を使うため、
// テスト実行前にこのファイルで登録しておかないと生キー表示になって落ちる。
//
// NOTE: core の setup.i18n.js (beforeEach で ja 固定) は vitest.config.js の
// SETUP 配列に含まれているため両方が適用される。
import "./src/i18n/index.js";

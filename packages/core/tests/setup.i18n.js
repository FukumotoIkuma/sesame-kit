// テスト時のロケールを ja に固定する。
// 本番の既定は en だが、既存テストは日本語メッセージをアサートしているため、
// テスト中は ja を既定にして、各メッセージの **ja カタログ（= 旧来の文言）** を検証する。
// en パスと切替機構は tests/i18n.test.js / tests/session-ui.test.js が明示ロケールで検証する。
import { beforeEach } from "vitest";
import { setLocale } from "@sesame-kit/core/i18n";

beforeEach(() => setLocale("ja"));

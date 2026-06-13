// kit 専用 i18n カタログの登録エントリ。
//
// packages/core/src/i18n.js の registerCatalog() を使って CLI/serve/session 文言を追記する。
// core の t() は登録後のマージカタログを引くため、このファイルを import した後は
// t("cli.*") / t("serve.*") / t("session.*") が全て解決される。
//
// packages/kit/src/cli.js の先頭(最初の t() 呼び出し前)で副作用 import する:
//   import "./i18n/index.js";

import { registerCatalog } from "@sesame-kit/core/i18n";
import cli from "./cli.js";
import serve from "./serve.js";
import session from "./session.js";

registerCatalog("cli", cli);
registerCatalog("serve", serve);
registerCatalog("session", session);

// packages/core の出荷ソース内に旧パッケージ名 "sesame-kit" の import 例が残らないことを固定する。
// (P2-6 / R3:ARCH-03 — 再発防止ゲート)
//
// core は files:["src/"] でソースごと出荷するため、ライブラリ利用者が最初に読む index.js 等に
// 「from "sesame-kit"」が残ると壊れた import を教えることになる。
// このテストは grep 相当で src/ 全体を走査し、対象パターンを 0 件に固定する。
//
// 対象外 (意図的な "sesame-kit" 文字列):
//   - paths.js の APP_DIRNAME = "sesame-kit"  (ディレクトリ名。パッケージ import 例ではない)
//   - i18n 文字列の ~/.config/sesame-kit      (UI 向けパス表示)
//   - sesame-kit/ から始まる subpath (例 "sesame-kit/ble/os2" は修正済みなので出ない)
//
// これらは正規表現で除外する。

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

/**
 * ディレクトリを再帰的に走査して .js ファイルの絶対パスを返す。
 * @param {string} dir
 * @returns {string[]}
 */
function collectJs(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectJs(full));
    } else if (extname(full) === ".js") {
      results.push(full);
    }
  }
  return results;
}

/**
 * 行が "sesame-kit" を含んでいても除外すべきケースか判定する。
 * @param {string} line
 * @returns {boolean} true = 除外対象 (許可された参照)
 */
function isAllowed(line) {
  // ディレクトリ名定数 (paths.js: APP_DIRNAME = "sesame-kit")
  if (/APP_DIRNAME\s*=\s*["']sesame-kit["']/.test(line)) return true;
  // UI 向けパス文字列 (~/.config/sesame-kit 等)
  if (/~\/\.config\/sesame-kit/.test(line)) return true;
  // XDG_CONFIG_HOME パス記述
  if (/\$XDG_CONFIG_HOME\/sesame-kit/.test(line)) return true;
  // ソケットパス等 (sesame-kit/sesame.sock)
  if (/sesame-kit\//.test(line)) return true;
  // ランタイム警告ログプレフィックス (paths.js: "[sesame-kit] Windows is not supported...")
  if (/\[sesame-kit\]/.test(line)) return true;
  // JSDoc コメントでツール名を説明する行 (paths.js: "* ... sesame-kit が起動された場合...")
  // コメント行 (//) または JSDoc 行 ( * ) でのみ許可する
  if (/^\s*(\/\/|\*).*sesame-kit/.test(line)) return true;
  return false;
}

describe("P2-6: core/src に旧パッケージ名 \"sesame-kit\" の import 例が残らない", () => {
  it("src/ 配下の全 .js ファイルに \"sesame-kit\" 文字列が (許可外で) 存在しない", () => {
    const files = collectJs(SRC_ROOT);
    const violations = [];

    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes("sesame-kit") && !isAllowed(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(violations, `旧パッケージ名 "sesame-kit" の残存箇所:\n${violations.join("\n")}`).toHaveLength(0);
  });
});

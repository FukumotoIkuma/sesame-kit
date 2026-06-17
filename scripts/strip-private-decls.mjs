// tsc が生成する各ワークスペースの types/ 配下の .d.ts から `_` 始まりの private メンバ宣言を
// 除去する。(tsc は JS ソースの `_x` 慣習メンバも declaration に出力するため、配布物の公開型から
//  内部 API を落とす後処理。中期的には tsc `stripInternal` + `/** @internal */` への移行を検討)
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// workspace 分割により types/ は packages/core と packages/kit の 2 箇所に出力される。
const TYPE_DIRS = [
  fileURLToPath(new URL("../packages/core/types/", import.meta.url)),
  fileURLToPath(new URL("../packages/kit/types/", import.meta.url)),
];

function* dtsFiles(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) yield* dtsFiles(p);
    else if (ent.isFile() && extname(ent.name) === ".ts" && ent.name.endsWith(".d.ts")) yield p;
  }
}

// out 末尾に直前の JSDoc ブロックが残っていれば取り除く。
// メンバ宣言だけ消すと宙に浮いたコメントが公開型に残るため、メンバと一体で除去する。
// JSDoc と確信できない形 (継続行が `*` 始まりでない等) は触らず温存する。
/** @param {string[]} out */
function removeTrailingJsdoc(out) {
  const last = out.length - 1;
  if (last < 0) return;
  const tail = out[last];
  if (/^\s*\/\*\*.*\*\/\s*$/.test(tail)) { out.pop(); return; } // 1 行 JSDoc
  if (!/^\s*\*\/\s*$/.test(tail)) return; // 直前行が JSDoc 終端でなければ何もしない
  for (let j = last - 1; j >= 0; j -= 1) {
    const cur = out[j];
    if (/^\s*\/\*\*/.test(cur)) { out.length = j; return; } // 開始行まで遡って一括除去
    if (!/^\s*\*/.test(cur)) return; // JSDoc の継続行でない — 構造不明なので温存
  }
}

/**
 * d.ts テキストから `_` 始まりのクラスメンバ宣言 (直前の JSDoc 込み) を除去する。
 * 対象はプロパティ `_x:` / `_x?:` だけでなくメソッド `_x(` / `_x?(` も含む
 * (旧 regex は `:` のみ対象で、`_ensureConnected()` 等の内部メソッドが types/client.d.ts に
 *  漏れていた)。`private` 修飾子付きも対象。
 * @param {string} text
 * @param {string} [label] 警告ログ用のファイル名等
 * @returns {string}
 */
export function stripPrivateMembers(text, label = "(input)") {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^ {4}(?:private\s+)?_[A-Za-z0-9_]+\??[:(]/.test(line)) {
      out.push(line);
      continue;
    }

    // メンバ宣言の終端 (brace 深度 0 で `;` 終わり) まで読み飛ばす。
    const start = i;
    let depth = 0;
    let done = false;
    for (; i < lines.length; i += 1) {
      const cur = lines[i];
      depth += (cur.match(/\{/g) || []).length;
      depth -= (cur.match(/\}/g) || []).length;
      if (depth <= 0 && /;\s*$/.test(cur)) {
        done = true;
        break;
      }
    }
    if (!done) {
      // 終端が見つからない不正/想定外の入力。旧実装はここで break しファイル残部を黙って
      // 欠落させていた (P1-16)。型の欠落は配布物の破壊なので、メンバ宣言ごと残り全行を
      // そのまま出力し、警告だけ残す。
      console.warn(
        `strip-private-decls: ${label}: unterminated private member starting at line ${start + 1}; leaving the remainder of the file unmodified`,
      );
      out.push(...lines.slice(start));
      break;
    }
    removeTrailingJsdoc(out);
  }
  return out.join("\n");
}

function main() {
  let changed = 0;
  for (const dir of TYPE_DIRS) {
    if (!existsSync(dir)) continue; // build:types 未実行などで存在しなければスキップ
    for (const file of dtsFiles(dir)) {
      const before = readFileSync(file, "utf8");
      const after = stripPrivateMembers(before, file);
      if (after !== before) {
        writeFileSync(file, after);
        changed += 1;
      }
    }
  }
  console.log(`stripped private declaration members from ${changed} file(s)`);
}

// テストから stripPrivateMembers を import できるよう、直接実行時のみ types/ を書き換える。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

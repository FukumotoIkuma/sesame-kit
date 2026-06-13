// `sesame sdk eject <ts|py> [--out <dir>]` コマンド。P2-5 で追加。
//
// インストール済みの sesame-kit パッケージから同梱 SDK ファイル
// (packages/kit/sdk/ts/sesame-client.ts または sdk/python/sesame_client.py) を
// 指定ディレクトリへコピーして書き出す薄いコマンド。
//
// 設計:
// - ファイルはパッケージ同梱 (packages/kit/sdk/ が kit の files に含まれる)。
// - 実行時は import.meta.url から sdk/ への相対パスで解決するため、インストール先に依らず動く。
// - --out 省略時はカレントディレクトリへ書き出す。
// - --json 対応: {"ok":true, "file":"<出力先絶対パス>"} を stdout へ出す。
// - 参照実装不要 (純構成変更)。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonMode } from "./errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** sdk/ ディレクトリの物理パス (実行環境に依らず import.meta.url 相対で解決)。 */
const SDK_DIR = resolve(__dirname, "../../sdk");

/** language → 同梱ファイルのリストと既定出力ファイル名。 */
const SDK_FILES = {
  ts: { src: join(SDK_DIR, "ts", "sesame-client.ts"), name: "sesame-client.ts" },
  py: { src: join(SDK_DIR, "python", "sesame_client.py"), name: "sesame_client.py" },
};

/**
 * `sesame sdk eject ts|py [--out <dir>]` の実体。
 * @param {"ts"|"py"} lang
 * @param {{ out?: string }} opts
 */
export function cmdSdkEject(lang, opts) {
  const entry = SDK_FILES[lang];
  if (!entry) {
    const msg = `Unknown language "${lang}". Choose: ts, py`;
    if (isJsonMode()) {
      process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
    } else {
      process.stderr.write(`error: ${msg}\n`);
    }
    process.exitCode = 1;
    return;
  }

  const outDir = opts.out ? resolve(opts.out) : process.cwd();
  const destPath = join(outDir, entry.name);

  let content;
  try {
    content = readFileSync(entry.src);
  } catch (e) {
    const msg = `Cannot read SDK source: ${e instanceof Error ? e.message : String(e)}`;
    if (isJsonMode()) {
      process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
    } else {
      process.stderr.write(`error: ${msg}\n`);
    }
    process.exitCode = 1;
    return;
  }

  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(destPath, content);
  } catch (e) {
    const msg = `Cannot write to ${destPath}: ${e instanceof Error ? e.message : String(e)}`;
    if (isJsonMode()) {
      process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
    } else {
      process.stderr.write(`error: ${msg}\n`);
    }
    process.exitCode = 1;
    return;
  }

  if (isJsonMode()) {
    process.stdout.write(JSON.stringify({ ok: true, file: destPath }) + "\n");
  } else {
    console.log(`wrote ${destPath}`);
  }
}

/**
 * `sesame sdk` コマンドグループを program に登録する。
 * @param {import("./ctx.js").Program} program
 */
export function registerSdkCommands(program) {
  const sdk = program.command("sdk")
    .description("SDK management (eject bundled client files)");

  sdk
    .command("eject <lang>")
    .description('Write bundled SDK file to disk. lang: ts | py')
    .option("--out <dir>", "Output directory (default: current directory)")
    .addHelpText("after", `
Examples:
  sesame sdk eject ts               # writes sesame-client.ts to ./
  sesame sdk eject py --out ./src   # writes sesame_client.py to ./src/
  sesame sdk eject ts --json        # JSON output: {"ok":true,"file":"/abs/path/sesame-client.ts"}`)
    .action((lang, opts) => cmdSdkEject(lang, opts));
}

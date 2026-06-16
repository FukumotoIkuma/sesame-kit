// spec↔test ガード — spec/*.md の機能監査カタログとテストの対応を機械検証する。
//
// 仕様の正準定義は spec/_format.md §6。要旨:
//  (構造) ID 書式/一意性・プレフィックス↔ファイル名一致・必須フィールド・語彙
//  (被覆) status:covered の spec はタグ付きテスト必須 / 孤児タグ(spec に無い ID)は FAIL /
//         status:planned|waived にタグが付いたら状態更新を促す警告(非致命)
//
// テスト側は対応 spec を「タイトル先頭の [ID] タグ」で張る (test → spec の一方向参照)。
//   例: it("[AUTH-0007] ChallengeResponses が ...", () => {...})
//
// 段階導入: 当面の spec はほぼ planned。テストを書いた時点で [ID] を付け covered に上げると、
// このガードが被覆を単調増加で守る。今は構造検証が主役 (planned は被覆を要求しない)。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/kit/tests → リポジトリルート (tests → kit → packages → root)
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SPEC_DIR = join(REPO_ROOT, "spec");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

// このガード自身は [ID] 例や正規表現を含むためタグ走査から除外する (自己汚染防止)。
const SELF_PATH = fileURLToPath(import.meta.url);

// ---- _format.md と一致させる正規表現 (変更時は両方を更新) ----
const ID_RE = /^[A-Z][A-Z0-9]{1,5}-\d{4}$/;
const HEADING_RE = /^###\s+\[([A-Z][A-Z0-9]{1,5}-\d{4})\]\s+(.+)$/;
const FIELD_RE = /^-\s+(surface|backend|command|branch|assert|ref|kind|status|note):\s*(.+)$/;
const FRONTMATTER_RE = /^<!--\s*spec-domain:\s*([a-z0-9-]+)\s*\|\s*prefix:\s*([A-Z][A-Z0-9]{1,5})\s*\|\s*tests:\s*(.+?)\s*-->\s*$/;
const TAG_RE = /\[([A-Z][A-Z0-9]{1,5}-\d{4})\]/g;

const REQUIRED_FIELDS = ["surface", "backend", "command", "branch", "assert", "ref", "kind", "status"];
// _format.md §3.2 のフィールド固定順 (note は任意・末尾)。ガードはこの相対順を強制する。
const CANONICAL_ORDER = ["surface", "backend", "command", "branch", "assert", "ref", "kind", "status", "note"];
// ref 1 部分の形: "local-contract" または "path:line" / "path:line-range" / カンマ複数 ("path:12,34-56")。
const REF_PART_RE = /^.+:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/;
// 移植元参照ツリー (.gitignore 済・ローカルのみ)。不在環境 (CI) では ref 存在検証を省く。
const EXTERNAL_REF_ROOTS = ["references_web", "_sesame_sdk_ref", "_aws_sdk_ref"];
const SURFACE_VOCAB = new Set(["core", "serve", "sdk", "cli"]);
const BACKEND_VOCAB = new Set(["cloud", "ble", "ble-os2", "local"]);
const KIND_VOCAB = new Set([
  "wire-fidelity", "payload-fidelity", "crypto-vector", "contract-existence",
  "surface-parity", "option-branch", "error-path", "idempotency", "i18n",
]);
const STATUS_VOCAB = new Set(["planned", "covered"]); // "waived:<理由>" は別途接頭辞で判定

// ---- ファイル収集ヘルパ ----
function listSpecFiles() {
  if (!existsSync(SPEC_DIR)) return [];
  return readdirSync(SPEC_DIR)
    .filter((f) => f.endsWith(".md") && f !== "README.md" && !f.startsWith("_"))
    .map((f) => join(SPEC_DIR, f))
    .sort();
}

function walkTestFiles(dir, acc) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".claude") continue;
      walkTestFiles(p, acc);
    } else if (name.endsWith(".test.js") && p !== SELF_PATH) {
      acc.push(p);
    }
  }
  return acc;
}

// ---- spec 解析 ----
/**
 * @returns {{file:string, domain:string, prefix:string, tests:string[],
 *            entries:Array<{id:string,title:string,fields:Record<string,string>,
 *                           order:string[],line:number}>}[]}
 */
function parseSpecs() {
  const files = listSpecFiles();
  return files.map((file) => {
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);

    const fm = FRONTMATTER_RE.exec(lines[0] || "");
    const front = fm
      ? { domain: fm[1], prefix: fm[2], tests: fm[3].split(",").map((s) => s.trim()).filter(Boolean) }
      : { domain: null, prefix: null, tests: [] };

    const entries = [];
    let cur = null;
    lines.forEach((ln, i) => {
      const h = HEADING_RE.exec(ln);
      if (h) {
        cur = { id: h[1], title: h[2].trim(), fields: {}, order: [], line: i + 1 };
        entries.push(cur);
        return;
      }
      // 次の見出し (## or ###) でエントリのフィールド収集を閉じる
      if (cur && /^#{2,3}\s/.test(ln) && !HEADING_RE.test(ln)) cur = null;
      if (!cur) return;
      const f = FIELD_RE.exec(ln);
      if (f) {
        cur.fields[f[1]] = f[2].trim();
        cur.order.push(f[1]);
      }
    });

    return { file, ...front, entries };
  });
}

// ---- テスト側 [ID] タグ収集 ----
function collectTestTags() {
  const files = walkTestFiles(PACKAGES_DIR, []);
  const tagToFiles = new Map(); // id -> Set<relpath>
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    let m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(text)) !== null) {
      const id = m[1];
      if (!tagToFiles.has(id)) tagToFiles.set(id, new Set());
      tagToFiles.get(id).add(relative(REPO_ROOT, file));
    }
  }
  return tagToFiles;
}

const specs = parseSpecs();
const allEntries = specs.flatMap((s) => s.entries.map((e) => ({ ...e, _file: s.file, _prefix: s.prefix })));
const tagToFiles = collectTestTags();

describe("spec↔test ガード: 構造検証", () => {
  it("spec/ にドメイン spec ファイルが存在する (pilot: auth, lock)", () => {
    const names = specs.map((s) => basename(s.file));
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain("auth.md");
    expect(names).toContain("lock.md");
  });

  it("各 spec ファイルがフロントマター (spec-domain | prefix | tests) を持つ", () => {
    const bad = specs.filter((s) => !s.prefix || !s.domain);
    expect(bad.map((s) => basename(s.file))).toEqual([]);
  });

  it("spec-domain がファイル名 (<slug>.md) と一致する", () => {
    const mismatch = specs
      .filter((s) => s.domain && `${s.domain}.md` !== basename(s.file))
      .map((s) => `${basename(s.file)} ↔ domain:${s.domain}`);
    expect(mismatch).toEqual([]);
  });

  it("プレフィックスがファイル間で一意", () => {
    const seen = new Map();
    for (const s of specs) {
      if (!s.prefix) continue;
      if (seen.has(s.prefix)) seen.get(s.prefix).push(basename(s.file));
      else seen.set(s.prefix, [basename(s.file)]);
    }
    const dups = [...seen.entries()].filter(([, files]) => files.length > 1);
    expect(dups).toEqual([]);
  });

  it("全エントリ ID が書式に従う (<PREFIX>-NNNN)", () => {
    const bad = allEntries.filter((e) => !ID_RE.test(e.id)).map((e) => e.id);
    expect(bad).toEqual([]);
  });

  it("エントリ ID のプレフィックスがファイルのプレフィックスと一致", () => {
    const mismatch = allEntries
      .filter((e) => e._prefix && e.id.split("-")[0] !== e._prefix)
      .map((e) => `${e.id} (file prefix ${e._prefix})`);
    expect(mismatch).toEqual([]);
  });

  it("エントリ ID が全 spec で一意", () => {
    const seen = new Map();
    for (const e of allEntries) {
      if (seen.has(e.id)) seen.get(e.id).push(basename(e._file));
      else seen.set(e.id, [basename(e._file)]);
    }
    const dups = [...seen.entries()].filter(([, f]) => f.length > 1).map(([id, f]) => `${id}: ${f.join(",")}`);
    expect(dups).toEqual([]);
  });

  it("各エントリが必須フィールドを全て持つ", () => {
    const missing = [];
    for (const e of allEntries) {
      for (const k of REQUIRED_FIELDS) if (!(k in e.fields)) missing.push(`${e.id}: -${k}`);
    }
    expect(missing).toEqual([]);
  });

  it("surface / backend / kind / status が語彙内", () => {
    const violations = [];
    for (const e of allEntries) {
      for (const v of (e.fields.surface || "").split(",").map((s) => s.trim()).filter(Boolean))
        if (!SURFACE_VOCAB.has(v)) violations.push(`${e.id} surface:${v}`);
      for (const v of (e.fields.backend || "").split(",").map((s) => s.trim()).filter(Boolean))
        if (!BACKEND_VOCAB.has(v)) violations.push(`${e.id} backend:${v}`);
      if (!KIND_VOCAB.has((e.fields.kind || "").trim())) violations.push(`${e.id} kind:${e.fields.kind}`);
      const st = (e.fields.status || "").trim();
      if (!STATUS_VOCAB.has(st) && !st.startsWith("waived:")) violations.push(`${e.id} status:${st}`);
    }
    expect(violations).toEqual([]);
  });

  it("1 エントリ内に重複フィールドキーが無い (silent overwrite 防止)", () => {
    const dups = [];
    for (const e of allEntries) {
      if (new Set(e.order).size !== e.order.length) dups.push(`${e.id}: [${e.order.join(",")}]`);
    }
    expect(dups).toEqual([]);
  });

  it("フィールド出現順が _format.md §3.2 の固定順 (surface..note)", () => {
    const bad = [];
    for (const e of allEntries) {
      const idx = e.order.map((k) => CANONICAL_ORDER.indexOf(k));
      for (let i = 1; i < idx.length; i++) {
        if (idx[i] <= idx[i - 1]) { bad.push(`${e.id}: [${e.order.join(",")}]`); break; }
      }
    }
    expect(bad).toEqual([]);
  });

  it("ref が path:line 形式で参照ファイルが実在する (local-contract 除く)", () => {
    const badFormat = [];
    const missingFile = [];
    for (const e of allEntries) {
      const raw = e.fields.ref || "";
      for (const part of raw.split(";").map((s) => s.trim()).filter(Boolean)) {
        if (part === "local-contract") continue;
        if (!REF_PART_RE.test(part)) { badFormat.push(`${e.id}: '${part}'`); continue; }
        const path = part.slice(0, part.lastIndexOf(":"));
        // 移植元参照ツリー (references_web / _sesame_sdk_ref / _aws_sdk_ref) は .gitignore 済で
        // CI 等には存在しない。そのルートが不在の環境では存在検証をスキップする (format は検証済)。
        // ローカル (参照ツリーあり) では従来どおり存在検証し、ハルシネ ref を捕捉する。
        // committed なパス (packages/ ・schema/ ・scripts/ 等) は常に存在検証する。
        const root = path.split("/")[0];
        if (EXTERNAL_REF_ROOTS.includes(root) && !existsSync(join(REPO_ROOT, root))) continue;
        if (!existsSync(join(REPO_ROOT, path))) missingFile.push(`${e.id}: '${part}'`);
      }
    }
    expect({ badFormat, missingFile }).toEqual({ badFormat: [], missingFile: [] });
  });
});

describe("spec↔test ガード: 被覆検証", () => {
  it("テスト側の [ID] タグはすべて実在 spec を指す (孤児タグ禁止)", () => {
    const ids = new Set(allEntries.map((e) => e.id));
    const orphans = [];
    for (const [id, files] of tagToFiles) {
      if (!ids.has(id)) orphans.push(`${id} ← ${[...files].join(", ")}`);
    }
    expect(orphans).toEqual([]);
  });

  it("status:covered の spec は [ID] タグ付きテストを持つ", () => {
    const uncovered = allEntries
      .filter((e) => (e.fields.status || "").trim() === "covered")
      .filter((e) => !tagToFiles.has(e.id))
      .map((e) => e.id);
    expect(uncovered).toEqual([]);
  });

  it("planned/waived に被覆があれば status 更新を促す (非致命の警告のみ)", () => {
    const shouldPromote = allEntries.filter((e) => {
      const st = (e.fields.status || "").trim();
      return (st === "planned" || st.startsWith("waived:")) && tagToFiles.has(e.id);
    });
    if (shouldPromote.length > 0) {
      console.warn(
        `[spec-coverage] テストが存在するので status を covered に更新してください:\n` +
          shouldPromote.map((e) => `  ${e.id} (${(e.fields.status || "").trim()})`).join("\n"),
      );
    }
    expect(true).toBe(true);
  });

  it("被覆レポート (ドメイン別 planned/covered/waived 件数)", () => {
    const rows = specs.map((s) => {
      const c = { planned: 0, covered: 0, waived: 0 };
      for (const e of s.entries) {
        const st = (e.fields.status || "").trim();
        if (st === "covered") c.covered++;
        else if (st.startsWith("waived:")) c.waived++;
        else c.planned++;
      }
      const total = s.entries.length;
      const tested = s.entries.filter((e) => tagToFiles.has(e.id)).length;
      return `  ${basename(s.file).padEnd(16)} total=${total} planned=${c.planned} covered=${c.covered} waived=${c.waived} tagged=${tested}`;
    });
    console.info(`[spec-coverage] カタログ被覆:\n${rows.join("\n")}`);
    expect(allEntries.length).toBeGreaterThan(0);
  });
});

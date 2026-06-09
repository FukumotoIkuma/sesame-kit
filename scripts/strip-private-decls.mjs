import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = new URL("../types/", import.meta.url);

function* dtsFiles(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) yield* dtsFiles(p);
    else if (ent.isFile() && extname(ent.name) === ".ts" && ent.name.endsWith(".d.ts")) yield p;
  }
}

function stripPrivateMembers(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^    _[A-Za-z0-9_]+\??:/.test(line)) {
      out.push(line);
      continue;
    }

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
    if (!done) break;
  }
  return out.join("\n");
}

let changed = 0;
for (const file of dtsFiles(ROOT.pathname)) {
  const before = readFileSync(file, "utf8");
  const after = stripPrivateMembers(before);
  if (after !== before) {
    writeFileSync(file, after);
    changed += 1;
  }
}

console.log(`stripped private declaration members from ${changed} file(s)`);

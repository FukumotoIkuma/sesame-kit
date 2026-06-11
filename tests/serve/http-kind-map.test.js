// SURF-10 (REFACTORING_PLAN.md P4-5): HTTP ステータス → kind/retryable 写像が
// 4 実装 (sdk/ts / sdk/python / clients/js / clients/python) で食い違わないことの固定。
// 正は tests/fixtures/http-kind-map.json。検証は 3 系統:
//   (1) clients/js  : httpKind() を import して実照合
//   (2) clients/python : python3 で _http_kind() を実行して実照合 (python3 が無ければ skip)
//   (3) 生成テンプレート : gen-sdk-ts.mjs / gen-sdk-py.mjs のテンプレート文字列から
//       写像リテラルを抜き出し fixture の全エントリと突き合わせ
//       (生成物 sdk/ は npm run build 後に tests/sdk-ts-contract.test.js が同期を担保)
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { httpKind } from "../../clients/js/sesame-client.mjs";

const ROOT = resolve(__dirname, "..", "..");
const FIXTURE_PATH = resolve(ROOT, "tests", "fixtures", "http-kind-map.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
const hasPython = spawnSync("python3", ["--version"]).status === 0;

/** fixture を「status → kind」の検証ケース一覧に展開する (5xx/フォールバックの代表値込み)。 */
function allCases() {
  const cases = Object.entries(fixture.statuses).map(([s, v]) => [Number(s), v.kind]);
  for (const s of fixture.serverErrorRange.samples) cases.push([s, fixture.serverErrorRange.kind]);
  for (const s of fixture.fallback.samples) cases.push([s, fixture.fallback.kind]);
  return cases;
}

describe("SURF-10: HTTP→kind 写像 (clients/js)", () => {
  it("httpKind() が fixture の全エントリと一致する", () => {
    for (const [status, kind] of allCases()) {
      expect(httpKind(status), `status ${status}`).toBe(kind);
    }
  });
});

describe.skipIf(!hasPython)("SURF-10: HTTP→kind 写像 (clients/python)", () => {
  it("_http_kind() が fixture の全エントリと一致する", () => {
    // fixture を python 側で読み、_http_kind の実出力と突き合わせる。
    const py = `
import json, sys
import sesame_client as sc
with open(sys.argv[1]) as f:
    fx = json.load(f)
cases = [(int(s), v["kind"]) for s, v in fx["statuses"].items()]
cases += [(s, fx["serverErrorRange"]["kind"]) for s in fx["serverErrorRange"]["samples"]]
cases += [(s, fx["fallback"]["kind"]) for s in fx["fallback"]["samples"]]
for status, kind in cases:
    got = sc._http_kind(status)
    assert got == kind, (status, got, kind)
print("KINDOK")
`;
    const r = spawnSync("python3", ["-c", py, FIXTURE_PATH], {
      env: { ...process.env, PYTHONPATH: resolve(ROOT, "clients", "python"), PYTHONDONTWRITEBYTECODE: "1" },
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`python kind assertions failed:\n${r.stdout}\n${r.stderr}`);
    expect(r.stdout).toContain("KINDOK");
  });
});

/**
 * 生成テンプレート内の `{ 400: "bad_params", ... }` 形式の写像リテラルを
 * { "400": "bad_params", ... } に読み出す。
 * @param {string} src テンプレートを含むソース全文
 * @param {RegExp} blockRe 写像リテラル全体を group 1 で捕まえる正規表現
 */
function parseStatusMap(src, blockRe) {
  const m = src.match(blockRe);
  expect(m, `写像リテラルが見つからない: ${blockRe}`).toBeTruthy();
  const out = {};
  for (const [, status, kind] of m[1].matchAll(/(\d{3}):\s*"([a-z_]+)"/g)) out[status] = kind;
  return out;
}

describe("SURF-10: HTTP→kind 写像 (生成テンプレート)", () => {
  const fixtureMap = Object.fromEntries(Object.entries(fixture.statuses).map(([s, v]) => [s, v.kind]));

  it("gen-sdk-ts.mjs のテンプレートに fixture の全エントリが現れる", () => {
    const src = readFileSync(resolve(ROOT, "scripts", "gen-sdk-ts.mjs"), "utf8");
    const map = parseStatusMap(src, /HTTP_KIND_BY_STATUS: Record<number, string> = \{([\s\S]*?)\};/);
    expect(map).toEqual(fixtureMap);
    // 5xx → connection_lost と フォールバック internal、retryable=connection_lost 連動も固定する。
    expect(src).toMatch(/if \(status >= 500\) return "connection_lost";/);
    expect(src).toMatch(/HTTP_KIND_BY_STATUS\[status\] \?\? "internal";/);
    expect(src).toMatch(/httpErrorKind\(status\) === "connection_lost"/);
  });

  it("gen-sdk-py.mjs のテンプレートに fixture の全エントリが現れる", () => {
    const src = readFileSync(resolve(ROOT, "scripts", "gen-sdk-py.mjs"), "utf8");
    const map = parseStatusMap(src, /_HTTP_STATUS_KIND = \{([\s\S]*?)\}/);
    expect(map).toEqual(fixtureMap);
    expect(src).toMatch(/if status >= 500:[^\n]*\n\s*return "connection_lost"/);
    expect(src).toMatch(/_HTTP_STATUS_KIND\.get\(status, "internal"\)/);
    expect(src).toMatch(/retryable = kind == "connection_lost"/);
  });

  it("4 実装すべてに出典コメント (P4-5/SURF-10) がある", () => {
    for (const rel of [
      ["scripts", "gen-sdk-ts.mjs"],
      ["scripts", "gen-sdk-py.mjs"],
      ["clients", "js", "sesame-client.mjs"],
      ["clients", "python", "sesame_client.py"],
    ]) {
      const src = readFileSync(resolve(ROOT, ...rel), "utf8");
      expect(src, rel.join("/")).toContain("SURF-10");
      expect(src, rel.join("/")).toContain("http-kind-map.json");
    }
  });
});

describe("SURF-21: clients/js の SesameErrorKind が serve の 7 kind と一致", () => {
  it("d.ts の union に serve KIND の全値が載っている", async () => {
    const dts = readFileSync(resolve(ROOT, "clients", "js", "sesame-client.d.ts"), "utf8");
    const { KIND } = await import("../../src/serve/jsonrpc.js");
    for (const kind of Object.values(KIND)) {
      expect(dts, `kind ${kind}`).toContain(`| "${kind}"`);
    }
  });
});

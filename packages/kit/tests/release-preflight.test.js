// P2-2: release.sh preflight のバージョン整合チェックに対するユニットテスト。
//
// 「root / packages/core / packages/kit の version 一致 + kit の @sesame-kit/core ピン一致」
// 検査ロジックを JS で実装し、不一致ケースを固定する。
// release.sh の bash ロジックの忠実な対応物として、壊れた状態を検出できることを保証する。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// packages/kit/tests/file → packages/kit/tests/ → packages/kit/ → packages/ → repo root
const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

function readPkg(rel) {
  return JSON.parse(readFileSync(resolve(ROOT, rel), "utf8"));
}

// --- ヘルパ: release.sh の preflight バージョン整合チェックと同等のロジック ---
function checkVersionConsistency({ root, core, kit, kitCorePin }) {
  const errors = [];
  if (core !== root) errors.push(`packages/core version (${core}) != root (${root})`);
  if (kit !== root) errors.push(`packages/kit version (${kit}) != root (${root})`);
  if (kitCorePin !== root) {
    errors.push(
      `packages/kit @sesame-kit/core pin (${kitCorePin}) != root version (${root})`
    );
  }
  return errors;
}

describe("release preflight: version consistency", () => {
  // --- 現リポジトリ HEAD での整合確認 ---
  it("HEAD では root / core / kit バージョンが一致しており、core ピンも一致する", () => {
    const rootPkg = readPkg("package.json");
    const corePkg = readPkg("packages/core/package.json");
    const kitPkg = readPkg("packages/kit/package.json");

    const errors = checkVersionConsistency({
      root: rootPkg.version,
      core: corePkg.version,
      kit: kitPkg.version,
      kitCorePin: kitPkg.dependencies["@sesame-kit/core"],
    });

    expect(errors, `バージョン不整合:\n${errors.join("\n")}`).toHaveLength(0);
  });

  // --- 不一致ケースの検出確認 ---
  it("core version が root と異なるとき検出する", () => {
    const errors = checkVersionConsistency({
      root: "1.0.0",
      core: "0.9.0", // 不一致
      kit: "1.0.0",
      kitCorePin: "1.0.0",
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/packages\/core/);
  });

  it("kit version が root と異なるとき検出する", () => {
    const errors = checkVersionConsistency({
      root: "1.0.0",
      core: "1.0.0",
      kit: "0.9.0", // 不一致
      kitCorePin: "1.0.0",
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/packages\/kit version/);
  });

  it("kit の @sesame-kit/core ピンが root と異なるとき検出する", () => {
    const errors = checkVersionConsistency({
      root: "1.0.0",
      core: "1.0.0",
      kit: "1.0.0",
      kitCorePin: "0.6.2", // 旧バージョンのままピンが追従していない
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/@sesame-kit\/core pin/);
  });

  it("全て不一致のとき 3 件のエラーを返す", () => {
    const errors = checkVersionConsistency({
      root: "2.0.0",
      core: "1.9.0",
      kit: "1.8.0",
      kitCorePin: "1.7.0",
    });
    expect(errors).toHaveLength(3);
  });

  it("全て一致のとき 0 件", () => {
    const errors = checkVersionConsistency({
      root: "0.6.2",
      core: "0.6.2",
      kit: "0.6.2",
      kitCorePin: "0.6.2",
    });
    expect(errors).toHaveLength(0);
  });
});

describe("release preflight: publish ステップ構成確認", () => {
  // release.yml が workspace フラグ付きで publish していることを静的に検証する。
  // これにより「ルート private で EPRIVATE 即死」という P2-2 の根本原因の再発を防ぐ。
  it("release.yml の publish ステップが -w packages/core -w packages/kit を含む", () => {
    const yml = readFileSync(resolve(ROOT, ".github/workflows/release.yml"), "utf8");
    // workspace フラグが存在し、core→kit の順で指定されていることを確認
    const publishLine = yml
      .split("\n")
      .find((line) => line.includes("npm publish") && line.includes("--provenance"));
    expect(publishLine).toBeDefined();
    expect(publishLine).toContain("-w packages/core");
    expect(publishLine).toContain("-w packages/kit");
    // core が kit より前であること(依存順)
    const coreIdx = publishLine.indexOf("-w packages/core");
    const kitIdx = publishLine.indexOf("-w packages/kit");
    expect(coreIdx).toBeLessThan(kitIdx);
  });

  it("release.yml はルートへの単体 npm publish を含まない(EPRIVATE 防止)", () => {
    const yml = readFileSync(resolve(ROOT, ".github/workflows/release.yml"), "utf8");
    // "npm publish" が -w フラグなしで単独出現する行が存在しないことを確認
    const barePublish = yml
      .split("\n")
      .filter((line) => /^\s*run:.*npm publish/.test(line) && !line.includes("-w "));
    expect(
      barePublish,
      `ルートへの単体 publish 行が残っています:\n${barePublish.join("\n")}`
    ).toHaveLength(0);
  });

  it("release.yml のタグ照合ステップが core と kit のバージョンも確認する", () => {
    const yml = readFileSync(resolve(ROOT, ".github/workflows/release.yml"), "utf8");
    // packages/core/package.json と packages/kit/package.json の両方を参照していること
    expect(yml).toContain("packages/core/package.json");
    expect(yml).toContain("packages/kit/package.json");
  });
});

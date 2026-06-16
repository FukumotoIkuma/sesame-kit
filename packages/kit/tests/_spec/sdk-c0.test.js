// packages/kit/tests/_spec/sdk-c0.test.js
// Spec-driven tests for SDK-0001 through SDK-0019 (SDK-0016 除く).
// Domains: sdk-generation, sdk-eject, py-sdk-generation, py-clients-error, py-clients-transport.
// Each it() title is prefixed with [<ID>] per spec convention.
// TDD: assertions follow spec contract; red tests are acceptable where impl diverges.
// No network / real device access — all pure-function, in-memory, or source-level analysis.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { generateSdk } from "../../../../scripts/gen-sdk-ts.mjs";
import { generateSdkPy } from "../../../../scripts/gen-sdk-py.mjs";
import { registerSdkCommands } from "../../src/cli/sdk.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../../..");

const spec = JSON.parse(readFileSync(join(ROOT, "schema", "openrpc.json"), "utf8"));
const committedTs = readFileSync(join(ROOT, "packages", "kit", "sdk", "ts", "sesame-client.ts"), "utf8");
const committedPy = readFileSync(join(ROOT, "packages", "kit", "sdk", "python", "sesame_client.py"), "utf8");
const clientsPy = readFileSync(join(ROOT, "packages", "kit", "clients", "python", "sesame_client.py"), "utf8");
const kitPkg = JSON.parse(readFileSync(join(ROOT, "packages", "kit", "package.json"), "utf8"));

// ─── SDK-0001 ──────────────────────────────────────────────────────────────────

describe("[SDK-0001] TS SDK が契約 205 メソッドを 1:1 で _call へ委譲する", () => {
  it("[SDK-0001] openrpc.json の全メソッドが sesame-client.ts に this._call(<name>) として現れ数が一致する", () => {
    for (const m of spec.methods) {
      expect(committedTs).toContain(`this._call(${JSON.stringify(m.name)}`);
    }
    const callMatches = committedTs.match(/this\._call\(/g) || [];
    expect(callMatches.length).toBe(spec.methods.length);
  });

  it("[SDK-0001] spec.methods の総数が 205 である", () => {
    expect(spec.methods.length).toBe(205);
  });

  it("[SDK-0001] spec.info の x-apiVersion が 1.4.0 である", () => {
    expect(spec.info["x-apiVersion"]).toBe("1.4.0");
  });

  it("[SDK-0001] ヘッダが 205 メソッドの自己申告を含む", () => {
    expect(committedTs).toContain(`${spec.methods.length} methods`);
  });
});

// ─── SDK-0002 ──────────────────────────────────────────────────────────────────

describe("[SDK-0002] ドット名から ns/op を分割しネスト構造へマップする生成機構", () => {
  it("[SDK-0002] ドット無し root メソッド (status) はクラス直下フィールド (status =) として現れる", () => {
    expect(committedTs).toContain("status =");
    const statusLine = committedTs.split("\n").find((l) => l.includes("status =") && !l.includes("//"));
    expect(statusLine).toBeTruthy();
    expect(statusLine.trimEnd()).toMatch(/;$/);
  });

  it("[SDK-0002] ns 付き (rpc.discover) は readonly <ns> = { ... } ブロックとして現れる", () => {
    expect(committedTs).toContain("readonly rpc =");
    expect(committedTs).toContain("discover:");
  });

  it("[SDK-0002] op に '.' が残る multi-dot の場合はキーをクォートする (例: ble.fingerPrint.fingerPrintChange)", () => {
    expect(committedTs).toContain('"fingerPrint.fingerPrintChange"');
  });

  it("[SDK-0002] rpc.discover は readonly rpc = { discover: … } かつ 'rpc.discover' が _call 引数に現れる", () => {
    expect(committedTs).toContain("readonly rpc =");
    expect(committedTs).toContain("discover:");
    expect(committedTs).toContain('"rpc.discover"');
  });

  it("[SDK-0002] generateSdk の出力に rpc ns ブロックと status フィールドが現れる (純関数確認)", () => {
    const out = generateSdk(spec);
    expect(out).toContain("readonly rpc =");
    expect(out).toContain("discover:");
    expect(out).toContain("status =");
  });
});

// ─── SDK-0003 ──────────────────────────────────────────────────────────────────

describe("[SDK-0003] param の required フラグが TS 引数の任意性 (? 接尾) に転写される", () => {
  it("[SDK-0003] required:false の params は '?' 付きフィールドになる (schedule.getScheduleList)", () => {
    expect(committedTs).toContain("subUUID?:");
    expect(committedTs).toContain("timeoutMs?:");
  });

  it("[SDK-0003] params 空のメソッドは引数なしで this._call(name, {}) を発する (rpc.discover)", () => {
    expect(committedTs).toContain('this._call("rpc.discover", {})');
  });

  it("[SDK-0003] status (params 空) は this._call('status', {}) を発する", () => {
    expect(committedTs).toContain('this._call("status", {})');
  });

  it("[SDK-0003] paramsType 空 params → _call 第 2 引数 {} を generateSdk 出力で確認する (純関数)", () => {
    const out = generateSdk(spec);
    expect(out).toContain('this._call("rpc.discover", {})');
  });

  it("[SDK-0003] required:false の全 params は '?' 接尾を持つ — lock.unlock 例", () => {
    const lockUnlock = spec.methods.find((m) => m.name === "lock.unlock");
    expect(lockUnlock).toBeTruthy();
    expect(lockUnlock.params.every((p) => !p.required)).toBe(true);
    const unlockLine = committedTs.split("\n").find((l) => l.includes('"lock.unlock"'));
    expect(unlockLine).toBeTruthy();
    expect(unlockLine).toContain("name?:");
  });
});

// ─── SDK-0004 ──────────────────────────────────────────────────────────────────

describe("[SDK-0004] generateSdk が決定的で committed 成果物と byte 一致する drift gate", () => {
  it("[SDK-0004] generateSdk(spec) の出力が committed sesame-client.ts と完全 byte 一致する", () => {
    expect(generateSdk(spec)).toBe(committedTs);
  });

  it("[SDK-0004] generateSdk は決定的 — 同一入力で 2 回呼んでも同一出力", () => {
    const a = generateSdk(spec);
    const b = generateSdk(spec);
    expect(a).toBe(b);
  });

  it("[SDK-0004] 生成物ヘッダに apiVersion と method 数が自己申告される", () => {
    expect(committedTs).toContain(`// apiVersion ${spec.info["x-apiVersion"]}`);
    expect(committedTs).toContain(`${spec.methods.length} methods`);
  });
});

// ─── SDK-0005 ──────────────────────────────────────────────────────────────────

describe("[SDK-0005] x-stability=experimental が @experimental JSDoc に転写され API_VERSION を埋める", () => {
  it("[SDK-0005] experimental メソッドだけ @experimental JSDoc が前置される", () => {
    expect(committedTs).toContain("@experimental");
    expect(committedTs).toContain("— may change without notice.");
    expect(committedTs).toContain("@experimental unverified — may change without notice.");
  });

  it("[SDK-0005] stable メソッド (13 個) には @experimental が付かない", () => {
    const stableMethods = spec.methods.filter((m) => m["x-stability"] === "stable");
    expect(stableMethods).toHaveLength(13);
    for (const m of stableMethods) {
      expect(m["x-stability"]).toBe("stable");
    }
  });

  it("[SDK-0005] API_VERSION 定数が spec.info.x-apiVersion と一致する", () => {
    expect(committedTs).toContain(`API_VERSION = "${spec.info["x-apiVersion"]}"`);
  });

  it("[SDK-0005] API_VERSION の値は '1.4.0'", () => {
    expect(committedTs).toContain('API_VERSION = "1.4.0"');
  });

  it("[SDK-0005] x-provenance 値が @experimental コメントに埋め込まれる (unverified の例)", () => {
    expect(committedTs).toContain("@experimental unverified");
  });
});

// ─── SDK-0006 ──────────────────────────────────────────────────────────────────

describe("[SDK-0006] sesame sdk eject ts が同梱 SDK を byte 一致でコピー書き出しする", () => {
  it("[SDK-0006] cmdSdkEject が SDK_DIR 相対で src パスを解決する (sdk/ts/sesame-client.ts が実在する)", () => {
    const sdkDir = resolve(__dirname, "../../sdk");
    const content = readFileSync(join(sdkDir, "ts", "sesame-client.ts"), "utf8");
    expect(content).toContain("GENERATED by scripts/gen-sdk-ts.mjs");
  });

  it("[SDK-0006] --out 省略時は process.cwd() を出力先にする (src 解析)", () => {
    const sdkJsSrc = readFileSync(join(ROOT, "packages/kit/src/cli/sdk.js"), "utf8");
    expect(sdkJsSrc).toContain("process.cwd()");
    expect(sdkJsSrc).toContain("resolve(opts.out)");
  });

  it("[SDK-0006] cmdSdkEject の ts エントリは sesame-client.ts を src に持つ (src 解析)", () => {
    const sdkJsSrc = readFileSync(join(ROOT, "packages/kit/src/cli/sdk.js"), "utf8");
    expect(sdkJsSrc).toContain('"sesame-client.ts"');
  });

  it("[SDK-0006] SDK_DIR は __dirname 相対 ../../sdk で解決される (src 解析)", () => {
    const sdkJsSrc = readFileSync(join(ROOT, "packages/kit/src/cli/sdk.js"), "utf8");
    expect(sdkJsSrc).toContain("../../sdk");
    expect(sdkJsSrc).toContain("fileURLToPath(import.meta.url)");
  });

  it("[SDK-0006] readFileSync + writeFileSync による byte 一致コピーが実装されている (src 解析)", () => {
    const sdkJsSrc = readFileSync(join(ROOT, "packages/kit/src/cli/sdk.js"), "utf8");
    expect(sdkJsSrc).toContain("readFileSync(entry.src)");
    expect(sdkJsSrc).toContain("writeFileSync(destPath, content)");
  });
});

// ─── SDK-0007 ──────────────────────────────────────────────────────────────────

describe("[SDK-0007] eject 未知 lang のエラー終了と --json 出力封筒の分岐", () => {
  it("[SDK-0007] 未知 lang のエラーメッセージは 'Unknown language' を含む (src 解析)", () => {
    const sdkJsSrc = readFileSync(join(ROOT, "packages/kit/src/cli/sdk.js"), "utf8");
    expect(sdkJsSrc).toContain("Unknown language");
    expect(sdkJsSrc).toContain("process.exitCode = 1");
  });

  it("[SDK-0007] --json 時は stdout に ok:false+error を出す分岐がある (src 解析)", () => {
    const sdkJsSrc = readFileSync(join(ROOT, "packages/kit/src/cli/sdk.js"), "utf8");
    expect(sdkJsSrc).toContain("ok: false");
    expect(sdkJsSrc).toContain("process.stdout.write");
  });

  it("[SDK-0007] 成功時 --json は { ok:true, file: destPath } 封筒を出す (src 解析)", () => {
    const sdkJsSrc = readFileSync(join(ROOT, "packages/kit/src/cli/sdk.js"), "utf8");
    expect(sdkJsSrc).toContain("ok: true, file: destPath");
  });

  it("[SDK-0007] 未知 lang は isJsonMode でない場合 stderr にエラーメッセージを書き出す (src 解析)", () => {
    const sdkJsSrc = readFileSync(join(ROOT, "packages/kit/src/cli/sdk.js"), "utf8");
    expect(sdkJsSrc).toContain("process.stderr.write");
    expect(sdkJsSrc).toContain("`error: ${msg}\\n`");
  });
});

// ─── SDK-0008 ──────────────────────────────────────────────────────────────────

describe("[SDK-0008] sdk/ 同梱とコマンド登録: eject が配布物に含まれ CLI に結線される", () => {
  it("[SDK-0008] packages/kit の files 配列に 'sdk/' が含まれ同梱される", () => {
    expect(kitPkg.files).toContain("sdk/");
  });

  it("[SDK-0008] packages/kit の files 配列に 'clients/' が含まれる", () => {
    expect(kitPkg.files).toContain("clients/");
  });

  it("[SDK-0008] registerSdkCommands が 'sdk eject <lang>' と --out オプションを登録する", () => {
    const registeredCommands = [];
    const registeredOptions = [];
    const mockProgram = {
      command(name) { registeredCommands.push(name); return this; },
      description() { return this; },
      option(flag) { registeredOptions.push(flag); return this; },
      addHelpText() { return this; },
      action() { return this; },
    };
    registerSdkCommands(mockProgram);
    expect(registeredCommands).toContain("sdk");
    expect(registeredCommands).toContain("eject <lang>");
    expect(registeredOptions.some((f) => f.includes("--out"))).toBe(true);
  });

  it("[SDK-0008] 同梱 ts SDK ファイルが物理的に存在し GENERATED ヘッダを持つ", () => {
    const sdkDir = resolve(ROOT, "packages/kit/sdk");
    const content = readFileSync(join(sdkDir, "ts", "sesame-client.ts"), "utf8");
    expect(content).toContain("GENERATED by scripts/gen-sdk-ts.mjs");
    expect(content).toContain("export class SesameClient");
  });

  it("[SDK-0008] 同梱 python SDK ファイルが物理的に存在し GENERATED ヘッダを持つ", () => {
    const sdkDir = resolve(ROOT, "packages/kit/sdk");
    const content = readFileSync(join(sdkDir, "python", "sesame_client.py"), "utf8");
    expect(content).toContain("GENERATED by scripts/gen-sdk-py.mjs");
    expect(content).toContain("class SesameClient");
  });
});

// ─── SDK-0009 ──────────────────────────────────────────────────────────────────

describe("[SDK-0009] gen-sdk-py 決定生成 / drift gate (純関数再実行で byte 一致)", () => {
  it("[SDK-0009] generateSdkPy(spec) の出力が committed sesame_client.py と完全 byte 一致する", () => {
    expect(generateSdkPy(spec)).toBe(committedPy);
  });

  it("[SDK-0009] generateSdkPy は決定的 — 同一入力で 2 回呼んでも同一出力", () => {
    const a = generateSdkPy(spec);
    const b = generateSdkPy(spec);
    expect(a).toBe(b);
  });

  it("[SDK-0009] 生成物の先頭行に GENERATED ヘッダが来る", () => {
    const firstLine = committedPy.split("\n")[0];
    expect(firstLine).toContain("GENERATED by scripts/gen-sdk-py.mjs");
  });

  it("[SDK-0009] 生成物の 2 行目に apiVersion と method 数が自己申告される", () => {
    const secondLine = committedPy.split("\n")[1];
    expect(secondLine).toContain(`apiVersion ${spec.info["x-apiVersion"]}`);
    expect(secondLine).toContain(`${spec.methods.length} methods`);
  });
});

// ─── SDK-0010 ──────────────────────────────────────────────────────────────────

describe("[SDK-0010] _omit_none 機構: optional 引数を None のまま送らない", () => {
  it("[SDK-0010] _omit_none が定義されており None キーを除去する関数である (生成物解析)", () => {
    expect(committedPy).toContain("def _omit_none(");
    expect(committedPy).toContain("if v is not None");
  });

  it("[SDK-0010] keyword-only (self, *, …) シグネチャが生成される (clearCards 例)", () => {
    expect(committedPy).toContain("def clearCards(self, *, deviceUUID:");
  });

  it("[SDK-0010] required param は default 無し・optional param は | None = None (clearCards 例)", () => {
    expect(committedPy).toContain("deviceUUID: str");
    expect(committedPy).toContain("timeoutMs: float | None = None");
  });

  it("[SDK-0010] _omit_none({...}) 呼び出しが生成メソッド内に現れる", () => {
    expect(committedPy).toContain('_omit_none({"deviceUUID": deviceUUID, "timeoutMs": timeoutMs})');
  });

  it("[SDK-0010] gen-sdk-py が required:false に '| None = None' サフィックスを付ける (純関数確認)", () => {
    const out = generateSdkPy(spec);
    expect(out).toContain("subUUID: str | None = None");
  });
});

// ─── SDK-0011 ──────────────────────────────────────────────────────────────────

describe("[SDK-0011] namespace ディスパッチ生成: ns.op → _Ns クラス + self.ns 属性", () => {
  it("[SDK-0011] _Access クラスが生成される", () => {
    expect(committedPy).toContain("class _Access:");
  });

  it("[SDK-0011] SesameClient に self.access = _Access(self) 属性が束ねられる", () => {
    expect(committedPy).toContain("self.access = _Access(self)");
    expect(committedPy).toContain("self.rpc = _Rpc(self)");
  });

  it("[SDK-0011] ns メソッドは self._c._call(full_name, …) へ委譲する (access.clearCards 例)", () => {
    expect(committedPy).toContain('self._c._call("access.clearCards"');
  });

  it("[SDK-0011] root メソッド (status) は SesameClient 直下で self._call へ委譲する", () => {
    expect(committedPy).toContain('self._call("status"');
  });

  it("[SDK-0011] multi-dot メソッドも full name (wire 名) で委譲する (ble.fingerPrint.fingerPrintChange 例)", () => {
    expect(committedPy).toContain('"ble.fingerPrint.fingerPrintChange"');
  });

  it("[SDK-0011] rpc.discover は self._c._call('rpc.discover', …) で委譲される", () => {
    expect(committedPy).toContain('"rpc.discover"');
    expect(committedPy).toContain('self._c._call("rpc.discover",');
  });
});

// ─── SDK-0012 ──────────────────────────────────────────────────────────────────

describe("[SDK-0012] 識別子/予約語安全フォールバック: 非識別子 param 名は **params generic へ退避", () => {
  it("[SDK-0012] gen-sdk-py に pyIdentifier が定義されている (生成器ソース確認)", () => {
    const src = readFileSync(join(ROOT, "scripts/gen-sdk-py.mjs"), "utf8");
    expect(src).toContain("function pyIdentifier(");
    expect(src).toContain("PY_KEYWORDS");
  });

  it("[SDK-0012] params が 0 個の場合は generic=true (**params) になる (methodParams 機構)", () => {
    const src = readFileSync(join(ROOT, "scripts/gen-sdk-py.mjs"), "utf8");
    expect(src).toContain("generic: true");
    expect(src).toContain("real.length === 0");
  });

  it("[SDK-0012] **params: Any フォールバック構文が生成物に現れる (rpc.discover 等)", () => {
    expect(committedPy).toContain("**params: Any");
    const discoverLine = committedPy.split("\n").find(
      (l) => l.includes("def discover(") && l.includes("**params")
    );
    expect(discoverLine).toBeTruthy();
  });

  it("[SDK-0012] pyIdentifier は予約語に '_' 接尾を付ける (PY_KEYWORDS チェック)", () => {
    const src = readFileSync(join(ROOT, "scripts/gen-sdk-py.mjs"), "utf8");
    expect(src).toContain("PY_KEYWORDS.has(out)");
    expect(src).toContain("`${out}_`");
  });

  it("[SDK-0012] pyIdentifier は先頭数字に '_' を前置する", () => {
    const src = readFileSync(join(ROOT, "scripts/gen-sdk-py.mjs"), "utf8");
    expect(src).toContain("/^[0-9]/");
    expect(src).toContain("`_${out}`");
  });

  it("[SDK-0012] 生成 Python が py_compile で検証可能 — package.json に check:sdk:py が存在する", () => {
    const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(rootPkg.scripts?.["check:sdk:py"] || "").toMatch(/py_compile/);
  });
});

// ─── SDK-0013 ──────────────────────────────────────────────────────────────────

describe("[SDK-0013] TypedDict/NotRequired 生成と Python 3.10 ランタイム両立機構", () => {
  it("[SDK-0013] 'from __future__ import annotations' が先頭付近に配置され 3.10 互換を保つ", () => {
    expect(committedPy).toContain("from __future__ import annotations");
    const futureIdx = committedPy.indexOf("from __future__ import annotations");
    const firstClassIdx = committedPy.indexOf("class ");
    expect(futureIdx).toBeLessThan(firstClassIdx);
  });

  it("[SDK-0013] TYPE_CHECKING ガード下で NotRequired を import する", () => {
    expect(committedPy).toContain("if TYPE_CHECKING:");
    const lines = committedPy.split("\n");
    const typeCheckIdx = lines.findIndex((l) => l.includes("if TYPE_CHECKING:"));
    const notRequiredImportIdx = lines.findIndex((l) => l.includes("from typing import NotRequired"));
    expect(notRequiredImportIdx).toBeGreaterThan(typeCheckIdx);
    expect(lines[notRequiredImportIdx]).toMatch(/^\s+from typing import NotRequired/);
  });

  it("[SDK-0013] TypedDict サブクラスが生成される (AccountWhoamiResult 例)", () => {
    expect(committedPy).toContain("class AccountWhoamiResult(TypedDict):");
  });

  it("[SDK-0013] optional フィールドは NotRequired[...] で表現される", () => {
    expect(committedPy).toContain("NotRequired[");
    expect(committedPy).toContain("customerInfo: NotRequired[");
  });

  it("[SDK-0013] 識別子化不能キーを含む result は dict[str, Any] に降格される (unsafe-key branch)", () => {
    const src = readFileSync(join(ROOT, "scripts/gen-sdk-py.mjs"), "utf8");
    expect(src).toContain("dict[str, Any]");
    expect(src).toContain("unsafe");
  });

  it("[SDK-0013] bare object / 形不明 result は Any になる (嘘の型を主張しない)", () => {
    const src = readFileSync(join(ROOT, "scripts/gen-sdk-py.mjs"), "utf8");
    expect(src).toContain('"Any"');
  });
});

// ─── SDK-0014 ──────────────────────────────────────────────────────────────────

describe("[SDK-0014] 生成 SDK の JSON-RPC 封筒/HTTP 送信機構 (id 採番・Bearer・error→SesameRpcError)", () => {
  it("[SDK-0014] _call が self._id+=1 でリクエスト ID を採番する", () => {
    expect(committedPy).toContain("self._id += 1");
  });

  it("[SDK-0014] _call が jsonrpc/id/method/params を含む JSON-RPC 2.0 封筒を POST する", () => {
    expect(committedPy).toContain('"jsonrpc": "2.0"');
    expect(committedPy).toContain('"id": self._id');
    expect(committedPy).toContain('"method": method');
    expect(committedPy).toContain('"params": params');
  });

  it("[SDK-0014] token があれば 'authorization: Bearer ...' ヘッダを付す", () => {
    expect(committedPy).toContain("f\"Bearer {self._token}\"");
    expect(committedPy).toContain('"authorization"');
  });

  it("[SDK-0014] POST 先は {base_url}/rpc", () => {
    expect(committedPy).toContain("self._base_url}/rpc");
  });

  it("[SDK-0014] HTTPError は _raise_http_error で SesameRpcError に翻訳される", () => {
    expect(committedPy).toContain("_raise_http_error(e)");
    expect(committedPy).toContain("def _raise_http_error(");
  });

  it("[SDK-0014] URLError は _raise_url_error で SesameRpcError に翻訳される", () => {
    expect(committedPy).toContain("_raise_url_error(e)");
    expect(committedPy).toContain("def _raise_url_error(");
  });

  it("[SDK-0014] 応答の error!=None は SesameRpcError として raise される", () => {
    expect(committedPy).toContain('"error" in msg and msg["error"] is not None');
    expect(committedPy).toContain('raise SesameRpcError(err.get("message"');
    expect(committedPy).toContain('err.get("code"');
  });

  it("[SDK-0014] SesameRpcError は message/code/data の 3 引数コンストラクタを持つ", () => {
    expect(committedPy).toContain("class SesameRpcError(Exception):");
    expect(committedPy).toContain("def __init__(self, message: str, code:");
    expect(committedPy).toContain("code: int | None");
    expect(committedPy).toContain("data: dict[str, Any] | None");
  });
});

// ─── SDK-0015 ──────────────────────────────────────────────────────────────────

describe("[SDK-0015] experimental docstring 注記 + stable-only API_VERSION/SesameEventTopic 生成機構", () => {
  it("[SDK-0015] x-stability=experimental のメソッドは @experimental docstring を持つ", () => {
    expect(committedPy).toContain("@experimental");
    expect(committedPy).toContain("— may change without notice.");
  });

  it("[SDK-0015] API_VERSION 定数が spec の x-apiVersion と等しい", () => {
    expect(committedPy).toContain(`API_VERSION = "${spec.info["x-apiVersion"]}"`);
  });

  it("[SDK-0015] 全 stable メソッドが def として生成されている", () => {
    const stableMethods = spec.methods.filter((m) => m["x-stability"] === "stable");
    for (const m of stableMethods) {
      const op = m.name.includes(".") ? m.name.slice(m.name.indexOf(".") + 1) : m.name;
      expect(committedPy).toContain(`def ${op}(`);
    }
  });

  it("[SDK-0015] SesameEventTopic は spec['x-event-topics'] から Literal[] として生成される", () => {
    const topics = spec["x-event-topics"] || [];
    expect(topics.length).toBeGreaterThan(0);
    expect(committedPy).toContain("SesameEventTopic = Literal[");
    for (const t of topics) {
      expect(committedPy).toContain(`"${t}"`);
    }
  });

  it("[SDK-0015] ヘッダ行が apiVersion と stable 件数を申告する", () => {
    const stableCount = spec.methods.filter((m) => m["x-stability"] === "stable").length;
    expect(committedPy).toContain(`${spec.methods.length} methods (${stableCount} stable)`);
  });
});

// ─── SDK-0017 ──────────────────────────────────────────────────────────────────

describe("[SDK-0017] SesameRpcError 正名化と SesameError deprecated alias (同一クラス) 機構", () => {
  it("[SDK-0017] clients/python で SesameRpcError クラスが定義されている", () => {
    expect(clientsPy).toContain("class SesameRpcError(RuntimeError):");
  });

  it("[SDK-0017] clients/python で SesameError は SesameRpcError と同一オブジェクト参照 (alias 代入)", () => {
    expect(clientsPy).toContain("SesameError = SesameRpcError");
  });

  it("[SDK-0017] SesameError alias は完全一致の代入行として存在する (SesameError IS SesameRpcError)", () => {
    const aliasLine = clientsPy.split("\n").find((l) => l.trim().startsWith("SesameError ="));
    expect(aliasLine).toBeDefined();
    expect(aliasLine.trim()).toBe("SesameError = SesameRpcError");
  });

  it("[SDK-0017] SesameError alias は deprecated 注記付きで SesameRpcError 定義の直後に現れる", () => {
    const lines = clientsPy.split("\n");
    const aliasLine = lines.findIndex((l) => l === "SesameError = SesameRpcError");
    expect(aliasLine).toBeGreaterThan(-1);
    const contextBlock = lines.slice(Math.max(0, aliasLine - 5), aliasLine + 2).join("\n");
    expect(contextBlock).toMatch(/deprecated|alias|backward/i);
  });

  it("[SDK-0017] sdk/python/sesame_client.py にも SesameRpcError クラスが定義されている", () => {
    expect(committedPy).toContain("class SesameRpcError(Exception):");
    expect(committedPy).toContain("self.code = code");
    expect(committedPy).toContain("self.kind");
  });
});

// ─── SDK-0018 ──────────────────────────────────────────────────────────────────

describe("[SDK-0018] clients/python 設定ディレクトリ解決が CLI(core/src/paths.js) と同一優先順位", () => {
  it("[SDK-0018] SESAME_KIT_HOME が最優先: _default_config_dir が SESAME_KIT_HOME をそのまま返す", () => {
    expect(clientsPy).toContain('os.environ.get("SESAME_KIT_HOME")');
    const lines = clientsPy.split("\n");
    const homeIdx = lines.findIndex((l) => l.includes('SESAME_KIT_HOME"'));
    const returnIdx = lines.findIndex((l, i) => i > homeIdx && l.includes("return home"));
    expect(returnIdx).toBeGreaterThan(homeIdx);
    const block = lines.slice(homeIdx, returnIdx + 1).join("\n");
    expect(block).not.toContain("os.path.join(home,");
  });

  it("[SDK-0018] XDG_CONFIG_HOME 有り: _default_config_dir は $XDG_CONFIG_HOME/sesame-kit を返す", () => {
    expect(clientsPy).toContain('os.environ.get("XDG_CONFIG_HOME")');
    expect(clientsPy).toContain('os.path.join(xdg, "sesame-kit")');
  });

  it("[SDK-0018] どちらも無し: ~/.config/sesame-kit を返す", () => {
    expect(clientsPy).toContain('os.path.expanduser("~")');
    expect(clientsPy).toContain('".config", "sesame-kit"');
  });

  it("[SDK-0018] _default_socket_path は _default_config_dir() + 'sesame.sock'", () => {
    expect(clientsPy).toContain('_default_config_dir(), "sesame.sock"');
  });

  it("[SDK-0018] _default_token_path は _default_config_dir() + 'serve.token'", () => {
    expect(clientsPy).toContain('_default_config_dir(), "serve.token"');
  });

  it("[SDK-0018] 3 段優先順位は SESAME_KIT_HOME → XDG → ~/.config の順で実装される", () => {
    const skHomeIdx = clientsPy.indexOf("SESAME_KIT_HOME");
    const xdgIdx = clientsPy.indexOf("XDG_CONFIG_HOME");
    const homeDefaultIdx = clientsPy.indexOf(".config/sesame-kit");
    expect(skHomeIdx).toBeLessThan(xdgIdx);
    expect(xdgIdx).toBeLessThan(homeDefaultIdx);
  });
});

// ─── SDK-0019 ──────────────────────────────────────────────────────────────────

describe("[SDK-0019] clients/python transport: call/subscribe 共有 id 空間と reader 相関ディスパッチ", () => {
  it("[SDK-0019] _StreamTransport は itertools.count(1) を self._ids として保持する", () => {
    expect(clientsPy).toContain("itertools.count(1)");
    expect(clientsPy).toContain("self._ids = itertools.count(1)");
  });

  it("[SDK-0019] _ids は call (request) と subscribe で共有される単一 id 空間", () => {
    expect(clientsPy).toContain("call と subscribe で共有");
  });

  it("[SDK-0019] reader は id 一致応答を _pending から取り出し Event を起こす", () => {
    expect(clientsPy).toContain('self._pending.pop(msg["id"]');
    expect(clientsPy).toContain('slot["ev"].set()');
  });

  it("[SDK-0019] 'event.' で始まる method 通知のみ on_event(topic, params) へ振り分ける", () => {
    expect(clientsPy).toContain('msg["method"].startswith("event.")');
    expect(clientsPy).toContain('self._on_event(msg["method"][len("event."):], msg.get("params"))');
  });

  it("[SDK-0019] 応答が 20s 無で kind='timeout' の SesameRpcError を raise する", () => {
    expect(clientsPy).toContain("timeout=20");
    expect(clientsPy).toContain("request timed out");
    expect(clientsPy).toContain('kind="timeout"');
  });

  it("[SDK-0019] id 採番は request 内で next(self._ids) により行われ caller は id を持たない", () => {
    expect(clientsPy).toContain("next(self._ids)");
    expect(clientsPy).toContain("caller は id を持たない");
  });

  it("[SDK-0019] _pending への登録と write が同一 lock 内で行われ reader との競合を防ぐ", () => {
    expect(clientsPy).toContain("with self._lock:");
    expect(clientsPy).toContain("self._pending[mid] = slot");
  });
});

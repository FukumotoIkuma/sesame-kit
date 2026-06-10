// 同梱 JS クライアント (clients/js/sesame-client.mjs) を**実デーモン**に対して叩く e2e。
// 出荷物そのものの挙動 (HTTP/UDS/WS の正常系 + WS 誤token失敗 surface + subscribe 不正topic surface)
// を検証する。サーバ側 framing テストとは別に、利用者が実際に import するコードを通す。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Daemon } from "../../src/serve/daemon.js";
import { startSocketFraming } from "../../src/serve/framing/socket.js";
import { startHttpFraming } from "../../src/serve/framing/http.js";
import { startWsFraming } from "../../src/serve/framing/ws.js";
import { SesameClient, SesameError } from "../../clients/js/sesame-client.mjs";

const TOKEN = "jsclient-token-dddddddddddddddddddddddddddddddd";

function fakeHub() {
  let duFn = null;
  return {
    connected: true, subUUID: "s", config: { devices: {} },
    connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
    onDeviceUpdate: (_i, fn) => { duFn = fn; return () => { duFn = null; }; },
    _emit: (m) => duFn && duFn(m),
    unlock: vi.fn(async (n) => ({ ok: true, name: n })),
  };
}

let workDir, daemon, handles, clients;
beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), "sesame-jsc-")); handles = []; clients = []; });
afterEach(async () => {
  for (const c of clients) { try { c.close(); } catch { /* */ } }
  for (const h of handles.reverse()) { try { await h.stop(); } catch { /* */ } }
  rmSync(workDir, { recursive: true, force: true });
});

async function boot() {
  daemon = new Daemon({ hub: fakeHub(), version: "9.9.9" });
  daemon.authState = "ok";
  const socketPath = join(workDir, "s.sock");
  handles.push(await startSocketFraming(daemon, { socketPath }));
  const http = await startHttpFraming(daemon, { port: 0, token: TOKEN }); handles.push(http);
  const ws = await startWsFraming(daemon, { port: 0, token: TOKEN }); handles.push(ws);
  return { socketPath, httpUrl: http.url, wsUrl: ws.url };
}

describe("JS 同梱クライアント e2e", () => {
  it("HTTP: status が contractVersion を、discover が全 method を返す", async () => {
    const { httpUrl } = await boot();
    const c = SesameClient.http(httpUrl, TOKEN); clients.push(c);
    const st = await c.status();
    expect(st).toMatchObject({ connected: true });
    expect(st.contractVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect((await c.discover()).methods.length).toBeGreaterThan(50);
  });

  it("UDS: unlock が hub に届く", async () => {
    const { socketPath } = await boot();
    const c = SesameClient.unix(socketPath); clients.push(c);
    expect(await c.unlock("front")).toMatchObject({ ok: true, name: "front" });
  });

  it("UDS: one-shot 利用は close() 忘れでもプロセスを掴み続けない", async () => {
    const { socketPath } = await boot();
    const clientUrl = pathToFileURL(resolve(__dirname, "..", "..", "clients", "js", "sesame-client.mjs")).href;
    const code = `
      import { SesameClient } from ${JSON.stringify(clientUrl)};
      const c = SesameClient.unix(${JSON.stringify(socketPath)});
      console.log(JSON.stringify(await c.status()));
    `;
    const r = await runNode(code, 4000);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"connected":true');
  });

  it("WS: 正しい token で接続でき status が引ける", async () => {
    const { wsUrl } = await boot();
    const c = await SesameClient.ws(wsUrl, TOKEN); clients.push(c);
    expect(await c.status()).toMatchObject({ connected: true });
  });

  it("WS: 誤った token は not_authenticated で reject (握りつぶさない)", async () => {
    const { wsUrl } = await boot();
    await expect(SesameClient.ws(wsUrl, "wrong-token")).rejects.toMatchObject({
      name: "SesameError", kind: "not_authenticated",
    });
  });

  it("WS: subscribe の不正 topic は throw する (await で受け取れる)", async () => {
    const { wsUrl } = await boot();
    const c = await SesameClient.ws(wsUrl, TOKEN); clients.push(c);
    await expect(c.subscribe(["bogus_topic"], () => {})).rejects.toMatchObject({
      name: "SesameError", kind: "bad_params",
    });
  });

  it("HTTP: subscribe の不正 topic は throw する", async () => {
    const { httpUrl } = await boot();
    const c = SesameClient.http(httpUrl, TOKEN); clients.push(c);
    await expect(c.subscribe(["bogus_topic"], () => {})).rejects.toBeInstanceOf(SesameError);
  });

  it("HTTP: SSE subscribe は token を URL に載せず Authorization ヘッダで認証する (ログ漏れ防止)", async () => {
    const { httpUrl } = await boot();
    // 同梱クライアントが叩く /events の URL を捕捉しつつ実リクエストは通す。
    let sseUrl = null;
    const realFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      if (typeof url === "string" && url.includes("/events")) sseUrl = url;
      return realFetch(url, init);
    });
    try {
      const c = SesameClient.http(httpUrl, TOKEN); clients.push(c);
      const got = new Promise((resolve) => {
        // SSE は接続直後に `ready` ハンドシェイクイベントを流すので、実データ (lockState) だけ待つ。
        c.subscribe(["lockState"], (topic, payload) => { if (topic === "lockState") resolve({ topic, payload }); });
      });
      // subscribe が SSE 接続を確立する猶予 (URL 捕捉は同期的に起きる)。
      await new Promise((r) => setTimeout(r, 50));
      expect(sseUrl).toBeTruthy();
      // バグ修正の核心: token がクエリに載っていない。ヘッダ認証なので 401 にもならない。
      expect(sseUrl).not.toContain("token=");
      expect(sseUrl).not.toContain(TOKEN);
      // ヘッダ認証で実際にイベントが届くこと (401 で黙って失敗していない) を確認。
      daemon.hub._emit({ deviceUUID: "d1", state: "locked" });
      const ev = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error("no event")), 1500))]);
      expect(ev.topic).toBe("lockState");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("未起動 UDS は connection_lost を自己説明的に throw", async () => {
    const c = SesameClient.unix(join(workDir, "nope.sock")); clients.push(c);
    await expect(c.status()).rejects.toMatchObject({ kind: "connection_lost" });
  });
});

function runNode(code, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`child timed out; stdout=${stdout} stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

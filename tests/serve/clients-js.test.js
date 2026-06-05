// 同梱 JS クライアント (clients/js/sesame-client.mjs) を**実デーモン**に対して叩く e2e。
// 出荷物そのものの挙動 (HTTP/UDS/WS の正常系 + WS 誤token失敗 surface + subscribe 不正topic surface)
// を検証する。サーバ側 framing テストとは別に、利用者が実際に import するコードを通す。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("未起動 UDS は connection_lost を自己説明的に throw", async () => {
    const c = SesameClient.unix(join(workDir, "nope.sock")); clients.push(c);
    await expect(c.status()).rejects.toMatchObject({ kind: "connection_lost" });
  });
});

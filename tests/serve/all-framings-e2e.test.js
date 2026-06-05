// 5 フレーミング通し E2E: **単一の Daemon** に UDS/HTTP/WS/gRPC を同時に上げ、
// 全経路から (a) 看板 op `lock.unlock` を叩いて同一結果を得る、(b) `lockState` を購読し
// hub の 1 イベントが**全経路へ同時に fan-out** されることを実証する。
// (stdio は別プロセス framing のため serve-cli.test.js で spawn 検証。ここは同居4経路。)
//
// 注: 実クラウドは使わない (fake hub)。「実トークンで 1 回叩く」最終確認だけは手動。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import net from "node:net";
import { WebSocket } from "ws";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon } from "../../src/serve/daemon.js";
import { startSocketFraming } from "../../src/serve/framing/socket.js";
import { startHttpFraming } from "../../src/serve/framing/http.js";
import { startWsFraming } from "../../src/serve/framing/ws.js";
import { startGrpcFraming } from "../../src/serve/framing/grpc.js";

const TOKEN = "e2e-token-cccccccccccccccccccccccccccccccc";
const PROTO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "serve", "sesame.proto");

function fakeHub() {
  let duFn = null;
  return {
    connected: true, subUUID: "s", config: { devices: {} },
    connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
    onDeviceUpdate: (_items, fn) => { duFn = fn; return () => { duFn = null; }; },
    _emit: (m) => duFn && duFn(m), // テストから 1 イベントを注入する
    unlock: vi.fn(async (n) => ({ ok: true, name: n })),
  };
}

// ---- 各 framing の薄いクライアント (1 リクエスト/1 購読だけ) ----

function socketRpc(path, obj) {
  return new Promise((res, rej) => {
    const c = net.connect(path);
    let buf = "";
    c.on("connect", () => c.write(JSON.stringify(obj) + "\n"));
    c.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) { c.destroy(); res(JSON.parse(buf.slice(0, nl))); }
    });
    c.on("error", rej);
    setTimeout(() => { c.destroy(); rej(new Error("socket timeout")); }, 2000);
  });
}

function httpRpc(url, obj) {
  return fetch(`${url}/rpc`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(obj),
  }).then((r) => r.json());
}

function wsRpc(url, obj) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${url}?token=${TOKEN}`);
    ws.on("open", () => ws.send(JSON.stringify(obj)));
    ws.on("message", (d) => { ws.close(); res(JSON.parse(d.toString())); });
    ws.on("error", rej);
    setTimeout(() => { try { ws.close(); } catch { /* */ } rej(new Error("ws timeout")); }, 2000);
  });
}

function grpcClient(port) {
  const def = protoLoader.loadSync(PROTO, { keepCase: true, longs: String, defaults: true });
  const proto = grpc.loadPackageDefinition(def).sesame;
  return new proto.Sesame(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
}
function grpcInvoke(client, obj) {
  const md = new grpc.Metadata(); md.set("authorization", `Bearer ${TOKEN}`);
  return new Promise((res, rej) =>
    client.Invoke({ json: JSON.stringify(obj) }, md, (e, r) => e ? rej(e) : res(JSON.parse(r.json))));
}

let workDir, daemon, handles, grpcCli;
beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), "sesame-e2e-")); handles = []; });
afterEach(async () => {
  try { grpcCli?.close(); } catch { /* */ }
  for (const h of handles.reverse()) { try { await h.stop(); } catch { /* */ } }
  rmSync(workDir, { recursive: true, force: true });
});

async function bootAllFramings(hub) {
  daemon = new Daemon({ hub, version: "9.9.9" });
  daemon.authState = "ok";
  const socketPath = join(workDir, "s.sock");
  const hSock = await startSocketFraming(daemon, { socketPath });
  const hHttp = await startHttpFraming(daemon, { port: 0, token: TOKEN });
  const hWs = await startWsFraming(daemon, { port: 0, token: TOKEN });
  const hGrpc = await startGrpcFraming(daemon, { port: 0, token: TOKEN });
  handles.push(hSock, hHttp, hWs, hGrpc);
  grpcCli = grpcClient(hGrpc.port);
  return { socketPath, httpUrl: hHttp.url, wsUrl: hWs.url };
}

describe("5 フレーミング通し E2E (単一 Daemon に同居)", () => {
  it("lock.unlock が UDS/HTTP/WS/gRPC のどれでも同一結果で hub.unlock に届く", async () => {
    const hub = fakeHub();
    const { socketPath, httpUrl, wsUrl } = await bootAllFramings(hub);
    const req = (id) => ({ jsonrpc: "2.0", id, method: "lock.unlock", params: { name: "front" } });

    const [s, h, w, g] = await Promise.all([
      socketRpc(socketPath, req(1)),
      httpRpc(httpUrl, req(2)),
      wsRpc(wsUrl, req(3)),
      grpcInvoke(grpcCli, req(4)),
    ]);

    expect(s.result).toMatchObject({ ok: true, name: "front" });
    expect(h.result).toMatchObject({ ok: true, name: "front" });
    expect(w.result).toMatchObject({ ok: true, name: "front" });
    expect(g.result).toMatchObject({ ok: true, name: "front" });
    // 看板 op が framing に依らず同じ hub メソッドへ届いている
    expect(hub.unlock).toHaveBeenCalledTimes(4);
    expect(hub.unlock).toHaveBeenCalledWith("front");
  });

  it("hub の 1 イベントが全購読経路 (UDS/WS/SSE/gRPC) へ同時 fan-out される", async () => {
    const hub = fakeHub();
    const { socketPath, httpUrl, wsUrl } = await bootAllFramings(hub);

    // --- UDS: 購読して event 行を待つ ---
    const udsEvent = new Promise((res, rej) => {
      const c = net.connect(socketPath); let buf = "";
      c.on("connect", () => c.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events.subscribe", params: { topics: ["lockState"] } }) + "\n"));
      c.on("data", (d) => {
        buf += d.toString(); let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const m = JSON.parse(line);
          if (m.method === "event.lockState") { c.destroy(); res(m.params); }
        }
      });
      c.on("error", rej);
      setTimeout(() => { c.destroy(); rej(new Error("uds event timeout")); }, 3000);
    });

    // --- WS: 購読して event を待つ ---
    const ws = new WebSocket(`${wsUrl}?token=${TOKEN}`);
    const wsReady = new Promise((res) => ws.on("open", () => res()));
    const wsEvent = new Promise((res, rej) => {
      ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.method === "event.lockState") res(m.params); });
      ws.on("error", rej);
      setTimeout(() => rej(new Error("ws event timeout")), 3000);
    });
    await wsReady;
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events.subscribe", params: { topics: ["lockState"] } }));

    // --- HTTP SSE: GET /events を購読 ---
    const sseRes = await fetch(`${httpUrl}/events?topics=lockState`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const sseEvent = (async () => {
      const reader = sseRes.body.getReader(); const dec = new TextDecoder(); let buf = "";
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true }); let nl;
        while ((nl = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, nl); buf = buf.slice(nl + 2);
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (line) { const m = JSON.parse(line.slice(6)); if (m.method === "event.lockState") { reader.cancel(); return m.params; } }
        }
      }
      throw new Error("sse event timeout");
    })();

    // --- gRPC: Subscribe ストリーム ---
    const gmd = new grpc.Metadata(); gmd.set("authorization", `Bearer ${TOKEN}`);
    const stream = grpcCli.Subscribe({ token: TOKEN, topics: ["lockState"] }, gmd);
    const grpcEvent = new Promise((res, rej) => {
      stream.on("data", (ev) => { res(JSON.parse(ev.json)); });
      stream.on("error", rej);
      setTimeout(() => rej(new Error("grpc event timeout")), 3000);
    });

    // 全経路が購読を確立する猶予を与えてから 1 イベント注入。
    await new Promise((r) => setTimeout(r, 250));
    hub._emit({ data: { deviceUUID: "u1", state: "unlocked" } });

    const [uds, wsv, sse, grpcv] = await Promise.all([udsEvent, wsEvent, sseEvent, grpcEvent]);
    try { ws.close(); } catch { /* */ }
    try { stream.cancel(); } catch { /* */ }

    // 同一イベントが 4 経路すべてに届いた
    for (const got of [uds, wsv, sse, grpcv]) {
      expect(got).toMatchObject({ data: { deviceUUID: "u1", state: "unlocked" } });
    }
  });
});

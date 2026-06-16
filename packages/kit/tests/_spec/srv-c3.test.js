// [SRV-0068] HTTP/WS/socket framing stop(): 持続接続を能動切断してから server.close でハング回避
//
// spec: serve-framing.md § SRV-0068
// assert: HTTP/WS/Unix-socket の各 framing stop() は、持続接続(SSE/WS/UDS 購読者)が
//   keep-alive で居座ると server.close がハングするため、close 前に全接続を能動切断する:
//   HTTP=server.closeAllConnections?.()、WS=各 wss.clients を c.terminate()、
//   socket=各 socks を s.destroy()。その後 server.close(()=>resolve) で確実に畳む。
//
// ref:
//   packages/kit/src/serve/framing/http.js:194-198
//   packages/kit/src/serve/framing/ws.js:65-68
//   packages/kit/src/serve/framing/socket.js:79-82
//
// 実ネットワーク bind あり (port:0 / tmpdir UDS)、実クラウド/実機なし (fake hub)。
// stop() が持続接続を能動切断してから解決するかを実起動で検証する。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import net from "node:net";
import { WebSocket } from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../../src/serve/daemon.js";
import { startHttpFraming } from "../../src/serve/framing/http.js";
import { startWsFraming } from "../../src/serve/framing/ws.js";
import { startSocketFraming } from "../../src/serve/framing/socket.js";

const TOKEN = "srv0068-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STOP_TIMEOUT_MS = 3000; // stop() がこの時間内に resolve しなければハングとみなす

function fakeHub() {
  let duFn = null;
  return {
    connected: true,
    subUUID: "s",
    config: { devices: {} },
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onDeviceUpdate: (_items, fn) => {
      duFn = fn;
      return () => { duFn = null; };
    },
    _emit: (m) => duFn && duFn(m),
  };
}

/**
 * stop() を STOP_TIMEOUT_MS でタイムアウトさせ、ハング検出を決定論的にする。
 * @param {() => Promise<void>} stopFn
 * @returns {Promise<"stopped"|"timeout">}
 */
function stopWithTimeout(stopFn) {
  return Promise.race([
    stopFn().then(() => /** @type {"stopped"} */ ("stopped")),
    new Promise((resolve) =>
      setTimeout(() => resolve(/** @type {"timeout"} */ ("timeout")), STOP_TIMEOUT_MS),
    ),
  ]);
}

// ─── テスト用 tmpdir ───────────────────────────────────────────────────────────

let workDir;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "sesame-srv0068-"));
});
afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

// ─── [SRV-0068] ───────────────────────────────────────────────────────────────

describe("[SRV-0068] HTTP/WS/socket framing stop(): 持続接続を能動切断してから server.close でハング回避", () => {

  it("[SRV-0068] HTTP framing stop() は SSE 接続が残っていても Promise が解決する (closeAllConnections)", async () => {
    // SSE 持続接続を貼った状態でも stop() が timely に resolve することを実証する。
    // server.closeAllConnections?.() を呼ばない場合、この Promise は resolve しない。
    const daemon = new Daemon({ hub: fakeHub(), version: "9.9.9" });
    daemon.authState = "ok";
    const handle = await startHttpFraming(daemon, { port: 0, token: TOKEN });

    // SSE 接続を確立して keep-alive で居座らせる
    const ctrl = new AbortController();
    const ssePromise = fetch(`${handle.url}/events?topics=lockState`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: ctrl.signal,
    }).catch(() => { /* abort による切断は期待通り */ });

    // SSE 確立を待つ (200 のレスポンスヘッダが届くまで)
    await new Promise((r) => setTimeout(r, 100));

    // stop() が STOP_TIMEOUT_MS 以内に resolve することを確認する
    const result = await stopWithTimeout(() => handle.stop());

    ctrl.abort();
    await ssePromise;

    // spec assert: stop() は持続接続があっても確実に畳む
    expect(result).toBe("stopped");
  });

  it("[SRV-0068] WS framing stop() は WS 接続が残っていても Promise が解決する (clients.terminate)", async () => {
    const daemon = new Daemon({ hub: fakeHub(), version: "9.9.9" });
    daemon.authState = "ok";
    const handle = await startWsFraming(daemon, { port: 0, token: TOKEN });

    // WS 持続接続を確立して居座らせる
    const ws = new WebSocket(`${handle.url}?token=${TOKEN}`);
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
      setTimeout(() => reject(new Error("ws open timeout")), 2000);
    });

    // stop() が STOP_TIMEOUT_MS 以内に resolve することを確認する
    const result = await stopWithTimeout(() => handle.stop());

    // WS は terminate されているはずだが念のため
    try { ws.terminate(); } catch { /* ignore */ }

    // spec assert: stop() は WS 持続接続があっても確実に畳む
    expect(result).toBe("stopped");
  });

  it("[SRV-0068] socket framing stop() は UDS 接続が残っていても Promise が解決する (socks.destroy)", async () => {
    const socketPath = join(workDir, "srv0068.sock");
    const daemon = new Daemon({ hub: fakeHub(), version: "9.9.9" });
    daemon.authState = "ok";
    const handle = await startSocketFraming(daemon, { socketPath });

    // UDS 持続接続を確立して居座らせる
    const sock = await new Promise((resolve, reject) => {
      const c = net.connect(socketPath);
      c.on("connect", () => resolve(c));
      c.on("error", reject);
      setTimeout(() => reject(new Error("socket connect timeout")), 2000);
    });

    // 接続確立を確実にする
    await new Promise((r) => setTimeout(r, 50));

    // stop() が STOP_TIMEOUT_MS 以内に resolve することを確認する
    const result = await stopWithTimeout(() => handle.stop());

    // ソケットはすでに destroy されているはずだが念のため
    try { sock.destroy(); } catch { /* ignore */ }

    // spec assert: stop() は UDS 持続接続があっても確実に畳む
    expect(result).toBe("stopped");
  });

  it("[SRV-0068] HTTP framing stop() は接続ゼロでも resolve する (closeAllConnections は No-op、server.close は即 callback)", async () => {
    const daemon = new Daemon({ hub: fakeHub(), version: "9.9.9" });
    const handle = await startHttpFraming(daemon, { port: 0, token: TOKEN });

    // 持続接続なしで stop() — 接続ゼロでも resolve する基本ケース
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it("[SRV-0068] WS framing stop() は接続ゼロでも resolve する (wss.clients は空、wss.close が即 callback)", async () => {
    const daemon = new Daemon({ hub: fakeHub(), version: "9.9.9" });
    const handle = await startWsFraming(daemon, { port: 0, token: TOKEN });

    // WS クライアント接続なしで stop()
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it("[SRV-0068] socket framing stop() は接続ゼロでも resolve する (socks は空、server.close が即 callback)", async () => {
    const socketPath = join(workDir, "srv0068-empty.sock");
    const daemon = new Daemon({ hub: fakeHub(), version: "9.9.9" });
    const handle = await startSocketFraming(daemon, { socketPath });

    // Unix socket に接続なしで stop()
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it("[SRV-0068] WS framing stop(): 複数 WS クライアントが接続中でも全 terminate → stop() が resolve する", async () => {
    const daemon = new Daemon({ hub: fakeHub(), version: "9.9.9" });
    daemon.authState = "ok";
    const handle = await startWsFraming(daemon, { port: 0, token: TOKEN });

    // 複数クライアント接続
    const clients = await Promise.all([0, 1, 2].map(() =>
      new Promise((res, rej) => {
        const ws = new WebSocket(`${handle.url}?token=${TOKEN}`);
        ws.on("open", () => res(ws));
        ws.on("error", rej);
        setTimeout(() => rej(new Error("ws open timeout")), 2000);
      }),
    ));

    // 全クライアント接続中のまま stop() — 全員 terminate してから wss.close
    const result = await stopWithTimeout(() => handle.stop());
    expect(result).toBe("stopped");

    // terminate 後の readyState 伝播を待つ (terminate は非同期的に状態を遷移させる)
    await new Promise((r) => setTimeout(r, 50));

    // 全クライアントが CLOSING(2) 以上 (CLOSED=3 含む) になっている
    for (const ws of clients) {
      expect(ws.readyState).toBeGreaterThanOrEqual(WebSocket.CLOSING);
    }
  });
});

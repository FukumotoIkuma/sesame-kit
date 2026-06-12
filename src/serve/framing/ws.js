// WebSocket フレーミング: 全二重。ブラウザ/全言語から JSON-RPC を双方向で。
// 1 接続 = 持続 Connection。events.subscribe で event 通知がそのまま流れる。
// 接続時に loopback token (?token= / Authorization: Bearer) を要求。

// 型は devDependencies の @types/ws が提供する (REFACTORING_PLAN P5-7/ARCH-15:
// 旧 @ts-expect-error + 自前 WsSocket 最小 typedef を正式型へ置き換え)。
import { WebSocketServer } from "ws";
import { tokenMatches, extractToken } from "./token.js";
import { t } from "../../i18n.js";

const MAX_BUFFERED = 4 * 1024 * 1024; // 4MB を超えて溜まった遅い購読者は切る (背圧)

/**
 * @param {import("../daemon.js").Daemon} daemon
 * @param {{ bind?:string, port:number, token:string }} opts
 * @returns {Promise<{ port:number, url:string, stop:()=>Promise<void> }>}
 */
export async function startWsFraming(daemon, { bind = "127.0.0.1", port, token }) {
  // 握手前 (HTTP upgrade) に token を検証し、失敗は 101 を返さず 401 で弾く。
  // これで未認証クライアントの open は発火せず error になる (close 1008 は握手後で open に先を越され
  // クライアントが認証失敗を取りこぼすため、ここで止めるのが正しい)。
  /** @param {{ req: import("node:http").IncomingMessage }} info */
  const verifyClient = (info) => tokenMatches(extractToken(info.req), token);
  const wss = new WebSocketServer({ host: bind, port, verifyClient });

  /** @param {import("ws").WebSocket} ws @param {import("node:http").IncomingMessage} req */
  const onConnection = (ws, req) => {
    // verifyClient で認証済みだが、防御的に再確認 (verifyClient 無効化時の保険)。
    if (!tokenMatches(extractToken(req), token)) {
      try { ws.close(1008, t("serve.ws.unauthorized")); } catch { /* ignore */ }
      return;
    }
    /** @type {import("../daemon.js").Connection} */
    const conn = {
      id: "ws",
      /** @param {unknown} obj */
      send: (obj) => {
        if (ws.bufferedAmount > MAX_BUFFERED) { conn.close(); return; } // 追いつけない購読者を切る
        try { ws.send(JSON.stringify(obj)); } catch { /* closed */ }
      },
      close: () => { try { ws.close(); } catch { /* ignore */ } },
    };
    daemon.addConnection(conn);
    ws.on("message", (/** @type {{ toString(): string }} */ data) => daemon.handleLine(conn, data.toString()));
    ws.on("close", () => daemon.removeConnection(conn));
    ws.on("error", () => conn.close());
  };
  wss.on("connection", onConnection);

  await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    wss.once("error", reject);
    wss.once("listening", () => resolve());
  }));

  // TCP listen (host+port) の address() は listening 後は AddressInfo を返す
  // (string になるのは UDS/pipe listen のみ、null は listen 前)。@types/ws 導入 (P5-7) に
  // 伴い union を明示ナローする。万一の契約破れは「黙って port=NaN」ではなく明示エラーに倒す。
  const addr = wss.address();
  if (addr === null || typeof addr === "string") {
    throw new Error(`ws framing: unexpected non-TCP address from listening server: ${String(addr)}`);
  }
  return {
    port: addr.port,
    url: `ws://${bind}:${addr.port}`,
    // 購読中クライアントを terminate してから close (しないと wss.close は接続が残る限りハング)。
    stop: () => /** @type {Promise<void>} */ (new Promise((resolve) => {
      for (const c of wss.clients) { try { c.terminate(); } catch { /* ignore */ } }
      wss.close(() => resolve());
    })),
  };
}

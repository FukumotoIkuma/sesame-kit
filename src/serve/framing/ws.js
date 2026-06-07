// WebSocket フレーミング: 全二重。ブラウザ/全言語から JSON-RPC を双方向で。
// 1 接続 = 持続 Connection。events.subscribe で event 通知がそのまま流れる。
// 接続時に loopback token (?token= / Authorization: Bearer) を要求。

import { WebSocketServer } from "ws";
import { tokenMatches, extractToken } from "./token.js";
import { t } from "../../i18n.js";

const MAX_BUFFERED = 4 * 1024 * 1024; // 4MB を超えて溜まった遅い購読者は切る (背圧)

/**
 * @param {import("../daemon.js").Daemon} daemon
 * @param {{ bind?:string, port:number, token:string }} opts
 * @returns {Promise<{ stop:()=>Promise<void> }>}
 */
export async function startWsFraming(daemon, { bind = "127.0.0.1", port, token }) {
  // 握手前 (HTTP upgrade) に token を検証し、失敗は 101 を返さず 401 で弾く。
  // これで未認証クライアントの open は発火せず error になる (close 1008 は握手後で open に先を越され
  // クライアントが認証失敗を取りこぼすため、ここで止めるのが正しい)。
  const verifyClient = (info) => tokenMatches(extractToken(info.req), token);
  const wss = new WebSocketServer({ host: bind, port, verifyClient });

  wss.on("connection", (ws, req) => {
    // verifyClient で認証済みだが、防御的に再確認 (verifyClient 無効化時の保険)。
    if (!tokenMatches(extractToken(req), token)) {
      try { ws.close(1008, t("serve.ws.unauthorized")); } catch { /* ignore */ }
      return;
    }
    const conn = {
      id: "ws",
      send: (obj) => {
        if (ws.bufferedAmount > MAX_BUFFERED) { conn.close(); return; } // 追いつけない購読者を切る
        try { ws.send(JSON.stringify(obj)); } catch { /* closed */ }
      },
      close: () => { try { ws.close(); } catch { /* ignore */ } },
    };
    daemon.addConnection(conn);
    ws.on("message", (data) => daemon.handleLine(conn, data.toString()));
    ws.on("close", () => daemon.removeConnection(conn));
    ws.on("error", () => conn.close());
  });

  await new Promise((resolve, reject) => {
    wss.once("error", reject);
    wss.once("listening", () => resolve());
  });

  return {
    port: wss.address().port,
    url: `ws://${bind}:${wss.address().port}`,
    // 購読中クライアントを terminate してから close (しないと wss.close は接続が残る限りハング)。
    stop: () => new Promise((resolve) => {
      for (const c of wss.clients) { try { c.terminate(); } catch { /* ignore */ } }
      wss.close(() => resolve());
    }),
  };
}

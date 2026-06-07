// HTTP フレーミング: 全言語/ブラウザから叩ける。
//   POST /rpc      → 1 件の JSON-RPC を処理し応答を返す (request/response 専用、購読は持続しない)
//   GET  /events   → SSE。?topics=lockState,deviceUpdate を購読し event を流す (購読チャネル)
// 全エンドポイントで loopback token (Authorization: Bearer / ?token=) 必須。

import http from "node:http";
import { makeError, RPC, KIND } from "../jsonrpc.js";
import { tokenMatches, extractToken } from "./token.js";
import { t } from "../../i18n.js";

const MAX_BODY = 1_000_000; // 1MB 上限 (過大 body 拒否)

/**
 * @param {import("../daemon.js").Daemon} daemon
 * @param {{ bind?:string, port:number, token:string }} opts
 * @returns {Promise<{ url:string, stop:()=>Promise<void> }>}
 */
export async function startHttpFraming(daemon, { bind = "127.0.0.1", port, token }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    // GET / は token 不要の人間向け案内 (ブラウザで開いた初学者が迷子にならないように)。
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(t("serve.http.usage", { bind, port }));
      return;
    }

    if (!tokenMatches(extractToken(req), token)) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="sesame"', // クライアントに token 必須を明示
      });
      res.end(JSON.stringify({ error: t("serve.http.unauthorized"), hint: t("serve.http.unauthorizedHint") }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/rpc") {
      const chunks = [];
      let size = 0;
      let discarded = 0;
      let aborted = false;
      // req の error を握る (未処理だとグローバル uncaughtException 経由で daemon 全停止しうる)。
      req.on("error", () => { aborted = true; });
      req.on("data", (c) => {
        if (aborted) {
          // 413 送出後: 残り body を**破棄しつつ受け切る** (バッファには積まない=O(1) メモリ)。
          // ここで socket を destroy するとクライアントの送信中 write が RST で失敗し、送った 413 を
          // 受け取れず "fetch failed" になる。受け切れば応答が確実に届く。ただし悪質に巨大な
          // アップロードは上限で打ち切る (DoS 防止)。
          discarded += c.length;
          if (discarded > MAX_BODY) { try { req.destroy(); } catch { /* ignore */ } }
          return;
        }
        size += c.length;
        if (size > MAX_BODY) { // 過大 body は 413 で明示拒否
          aborted = true;
          res.writeHead(413, { "content-type": "application/json", connection: "close" });
          res.end(JSON.stringify({ error: t("serve.http.payloadTooLarge") }));
          return;
        }
        chunks.push(c);
      });
      req.on("end", async () => {
        if (aborted) return;
        const body = Buffer.concat(chunks).toString("utf8"); // チャンク跨ぎ UTF-8 を正しく結合
        // POST は短命接続 (購読は持続しない)。ephemeral=true で events.* を弾く。
        const conn = { id: "http-rpc", ephemeral: true, send() {}, close() {} };
        daemon.addConnection(conn);
        let out;
        try {
          out = await daemon.dispatchMessage(conn, body);
        } catch {
          out = makeError(null, RPC.INTERNAL_ERROR, t("serve.internal"), KIND.INTERNAL);
        }
        daemon.removeConnection(conn);
        if (out === null) { res.writeHead(204); res.end(); return; } // 通知
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      // topic を事前検証: 指定があるのに全部不正なら 400 (黙って無用なストリームを返さない)。
      const reqTopics = (url.searchParams.get("topics") || "").split(",").map((s) => s.trim()).filter(Boolean);
      const validTopics = reqTopics.filter((t) => daemon.topics.includes(t));
      if (reqTopics.length && validTopics.length === 0) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: t("serve.http.unknownTopics", { topics: reqTopics.join(",") }), valid: daemon.topics }));
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": ok\n\n"); // 初期コメントでストリーム確立
      const conn = {
        id: "http-sse",
        send: (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* closed */ } },
        close: () => { try { res.end(); } catch { /* ignore */ } },
      };
      daemon.addConnection(conn);
      try { if (validTopics.length) daemon.subscribe(conn, validTopics); } catch { /* ignore */ }
      // ハートビート: 中継 proxy のアイドル切断を防ぎ、死んだ接続を検知する。
      const heartbeat = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, 25000);
      req.on("close", () => { clearInterval(heartbeat); daemon.removeConnection(conn); });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: t("serve.http.notFound") }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => resolve());
  });
  const addr = server.address();
  return {
    url: `http://${bind}:${addr.port}`,
    // SSE 購読者が keep-alive で居座ると server.close は idle 接続を閉じずハングするため、
    // 全接続を能動 destroy してから close (closeAllConnections は Node 18.2+)。
    stop: () => new Promise((resolve) => {
      try { server.closeAllConnections?.(); } catch { /* ignore */ }
      server.close(() => resolve());
    }),
  };
}

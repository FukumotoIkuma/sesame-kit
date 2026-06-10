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
 * @param {{ bind?:string, port:number, token:string, corsOrigins?:(string[]|"*"|null) }} opts
 * @returns {Promise<{ url:string, stop:()=>Promise<void> }>}
 */
export async function startHttpFraming(daemon, { bind = "127.0.0.1", port, token, corsOrigins = null }) {
  // CORS は **オプトイン**。--cors 未指定なら何のヘッダも出さない (安全な既定)。
  // "*" は全許可、配列は許可 origin のリスト。
  const corsAll = corsOrigins === "*";
  const corsList = Array.isArray(corsOrigins) ? corsOrigins : null;
  const corsEnabled = corsAll || (corsList != null && corsList.length > 0);

  // リクエスト Origin が許可されているか判定し、レスポンスに載せる
  // Access-Control-Allow-Origin の値 (許可外/無効なら null) を返す。
  /**
   * @param {string|undefined} reqOrigin
   * @returns {string|null}
   */
  function allowedOrigin(reqOrigin) {
    if (!corsEnabled) return null;
    if (corsAll) return reqOrigin || "*";
    if (reqOrigin && corsList != null && corsList.includes(reqOrigin)) return reqOrigin;
    return null;
  }

  // 実 CORS レスポンスへ Access-Control-Allow-Origin (+ Vary) を付与する。
  /**
   * @param {import("node:http").IncomingMessage} req
   * @param {Record<string, string>} headers
   * @returns {Record<string, string>}
   */
  function applyCors(req, headers) {
    if (!corsEnabled) return headers;
    const ao = allowedOrigin(req.headers.origin);
    if (ao) {
      headers["access-control-allow-origin"] = ao;
      // origin ごとに応答が変わるため (echo 方式) キャッシュ汚染防止に Vary を付ける。
      if (!corsAll) headers.vary = "Origin";
    }
    return headers;
  }

  // server.listen 解決後に実バインド先のポートを埋める (--http 0 のエフェメラル対応)。
  // ハンドラのクロージャはこの変数を読むので、案内文や url が実ポートを反映する。
  let boundPort = port;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");

    // CORS preflight: OPTIONS は token 不要で 204 を返す (有効時のみ)。
    if (corsEnabled && req.method === "OPTIONS") {
      const ao = allowedOrigin(req.headers.origin);
      /** @type {Record<string, string>} */
      const headers = {
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "86400",
      };
      if (ao) {
        headers["access-control-allow-origin"] = ao;
        if (!corsAll) headers.vary = "Origin";
      }
      res.writeHead(204, headers);
      res.end();
      return;
    }

    // GET / は token 不要の人間向け案内 (ブラウザで開いた初学者が迷子にならないように)。
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(t("serve.http.usage", { bind, port: boundPort }));
      return;
    }

    if (!tokenMatches(extractToken(req), token)) {
      // 401 も JSON-RPC 2.0 error で返す (README の構造化エラー契約 / SDK が期待する形)。
      // not_authenticated は RPC 層の APP_ERROR コードに揃える (SESAME_TO_RPC の写像と一致)。
      res.writeHead(401, applyCors(req, {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="sesame"', // クライアントに token 必須を明示
      }));
      res.end(JSON.stringify(
        makeError(null, RPC.APP_ERROR, t("serve.http.unauthorized"), KIND.NOT_AUTHENTICATED),
      ));
      return;
    }

    if (req.method === "POST" && url.pathname === "/rpc") {
      /** @type {Buffer[]} */
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
        /** @type {import("../daemon.js").Connection} */
        const conn = { id: "http-rpc", ephemeral: true, send() {}, close() {} };
        daemon.addConnection(conn);
        let out;
        try {
          out = await daemon.dispatchMessage(conn, body);
        } catch {
          out = makeError(null, RPC.INTERNAL_ERROR, t("serve.internal"), KIND.INTERNAL);
        }
        daemon.removeConnection(conn);
        if (out === null) { res.writeHead(204, applyCors(req, {})); res.end(); return; } // 通知
        res.writeHead(200, applyCors(req, { "content-type": "application/json" }));
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
      res.writeHead(200, applyCors(req, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      }));
      res.write(": ok\n\n"); // 初期コメントでストリーム確立
      /** @type {import("../daemon.js").Connection} */
      const conn = {
        id: "http-sse",
        /** @param {unknown} obj */
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

  await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => resolve());
  }));
  const addr = server.address();
  // address() は listen 後なら AddressInfo (string は UDS のみ)。TCP listen 済なので port を持つ。
  const boundAddr = /** @type {import("node:net").AddressInfo} */ (addr);
  // --http 0 はエフェメラルポートを割り当てるので、案内文/URL は **実バインド先** を使う
  // (入力 port=0 をそのまま見せると 127.0.0.1:0 という無意味な例になる)。
  boundPort = boundAddr.port;
  return {
    url: `http://${bind}:${boundAddr.port}`,
    // SSE 購読者が keep-alive で居座ると server.close は idle 接続を閉じずハングするため、
    // 全接続を能動 destroy してから close (closeAllConnections は Node 18.2+)。
    stop: () => /** @type {Promise<void>} */ (new Promise((resolve) => {
      try { server.closeAllConnections?.(); } catch { /* ignore */ }
      server.close(() => resolve());
    })),
  };
}

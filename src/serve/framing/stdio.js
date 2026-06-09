// stdio フレーミング: stdin/stdout で NDJSON JSON-RPC。埋め込み (親が子プロセスとして spawn) 用。
// 単一 Connection。stdin EOF (親が死んだ) で graceful shutdown を起こす。

import { makeLineConnection } from "./ndjson.js";

/**
 * @param {import("../daemon.js").Daemon} daemon
 * @param {{ onShutdown?:()=>void }} [opts]
 * @returns {{ stop:()=>void }}
 */
export function startStdioFraming(daemon, { onShutdown } = {}) {
  let conn;
  conn = makeLineConnection(process.stdin, process.stdout, {
    onLine: (c, raw) => daemon.handleLine(c, raw),
    onClose: () => {
      daemon.removeConnection(conn);
      if (onShutdown) onShutdown(); // stdin EOF = 親終了 → デーモンも畳む
    },
    // stdout はプロセス共有なので閉じない (closeWritable=false)
  });
  // event.ready は daemon.addConnection が全永続接続へ一律送る (stdout で準備完了を通知し、
  // stderr を読む非通念な儀式を不要にする)。
  daemon.addConnection(conn);
  return { stop() { conn.close(); } };
}

// stdio フレーミング: stdin/stdout で NDJSON JSON-RPC。埋め込み (親が子プロセスとして spawn) 用。
// 単一 Connection。stdin EOF (親が死んだ) で graceful shutdown を起こす。

import { makeLineConnection } from "./ndjson.js";
import { makeEvent } from "../jsonrpc.js";

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
  daemon.addConnection(conn);
  // 準備完了を **stdout の通常チャネル** で通知する (event.ready)。stderr を読む非通念な
  // 儀式を不要にする。早期に書かれた入力は OS パイプが buffer するので待たなくても良いが、
  // 待ちたいクライアントはこの 1 本を見れば良い (全言語が既に demux するチャネル)。
  conn.send(makeEvent("ready", {}));
  return { stop() { conn.close(); } };
}

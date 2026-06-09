// 改行区切り JSON (NDJSON) の Connection ヘルパ。
// stdio (2 ストリーム) と Unix socket (1 duplex) が共有する。
//
// - 手動行分割 (readline は 1 行を無制限にバッファでき OOM DoS。ここは maxLine で上限)。
// - StringDecoder でチャンク跨ぎのマルチバイト UTF-8 を正しく復元。
// - 書き込みは背圧 (write/drain) を尊重。出力キューが maxQueue を超えた遅い接続は
//   **その接続だけ** 切る (通知は lossy。デーモン全体は止めない)。

import { StringDecoder } from "node:string_decoder";

let _idSeq = 0;

/**
 * @param {import("node:stream").Readable} readable
 * @param {import("node:stream").Writable} writable
 * @param {{ onLine:(conn:object, raw:string)=>void, onClose?:()=>void,
 *           maxQueue?:number, maxLine?:number, closeWritable?:boolean }} opts
 * @returns {{ id:string, send:(obj:object)=>void, close:()=>void }}
 */
export function makeLineConnection(readable, writable, opts) {
  const { onLine, onClose, maxQueue = 1000, maxLine = 1_000_000, closeWritable = false } = opts;
  let closed = false;
  let draining = false;
  const queue = [];
  const decoder = new StringDecoder("utf8");
  let inbuf = "";

  const conn = {
    id: `c${++_idSeq}`,
    send(obj) {
      if (closed) return;
      const line = JSON.stringify(obj) + "\n";
      if (draining) {
        queue.push(line);
        if (queue.length > maxQueue) conn.close(); // 追いつけない購読者を切る
        return;
      }
      if (!writable.write(line)) draining = true;
    },
    close() {
      if (closed) return;
      closed = true;
      readable.off("data", onData);
      if (closeWritable) { try { writable.end(); } catch { /* ignore */ } }
      if (onClose) onClose();
    },
  };

  function onData(chunk) {
    if (closed) return;
    inbuf += decoder.write(chunk);
    let nl;
    while ((nl = inbuf.indexOf("\n")) >= 0) {
      const line = inbuf.slice(0, nl);
      inbuf = inbuf.slice(nl + 1);
      if (line.trim()) onLine(conn, line);
    }
    // 改行が来ないまま 1 行が上限超過 → DoS とみなし切断。
    // graceful end (writable.end) だと、こちらが送った未読データ (例: 接続時の event.ready) を
    // 抱えた paused クライアントが即座に閉じないことがあるため、writable を所有する場合
    // (socket) は強制 destroy で確実に切る。stdout 共有の stdio (closeWritable=false) は触らない。
    if (inbuf.length > maxLine) {
      if (closeWritable) { try { writable.destroy(); } catch { /* ignore */ } }
      conn.close();
    }
  }

  writable.on("drain", () => {
    draining = false;
    while (queue.length && !draining) {
      if (!writable.write(queue.shift())) draining = true;
    }
  });
  writable.on("error", () => conn.close());

  readable.on("data", onData);
  readable.on("end", () => conn.close());
  readable.on("error", () => conn.close());

  return conn;
}

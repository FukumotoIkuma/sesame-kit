// Unix domain socket フレーミング: ローカル常駐・多クライアント。NDJSON JSON-RPC。
// POSIX 専用 (mode 0600。Windows の named pipe は非対象)。
//
// 安全性:
//   - listen 前に生存確認 → 別デーモンが生きていれば拒否、stale なら unlink (無条件 unlink しない)。
//   - net.listen は mode を尊重しない (umask 任せ) → umask(0o177) で囲んで 0600 生成。
//   - ソケットは configPaths.dir (0700) 配下に置き、ディレクトリでも二重に守る。

import net from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { makeLineConnection } from "./ndjson.js";
import { t } from "../../i18n.js";

/** 既存ソケットが生きてれば throw、stale なら unlink して継続。 */
export function ensureFreeSocket(socketPath) {
  return new Promise((resolve, reject) => {
    if (!existsSync(socketPath)) return resolve();
    const probe = net.connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      reject(new Error(t("serve.socket.alreadyRunning", { socketPath })));
    });
    probe.once("error", () => {
      probe.destroy();
      try { unlinkSync(socketPath); } catch { /* ignore */ }
      resolve();
    });
  });
}

/**
 * @param {import("../daemon.js").Daemon} daemon
 * @param {{ socketPath:string }} opts
 * @returns {Promise<{ path:string, stop:()=>Promise<void> }>}
 */
export async function startSocketFraming(daemon, { socketPath }) {
  await ensureFreeSocket(socketPath);

  const socks = new Set(); // shutdown 時に能動 destroy するため接続中 socket を追跡
  const server = net.createServer((sock) => {
    socks.add(sock);
    sock.on("close", () => socks.delete(sock));
    let conn;
    conn = makeLineConnection(sock, sock, {
      onLine: (c, raw) => daemon.handleLine(c, raw),
      onClose: () => daemon.removeConnection(conn),
      closeWritable: true,
    });
    daemon.addConnection(conn);
    sock.on("error", () => conn.close());
    sock.on("close", () => conn.close());
  });

  // 0600 で生成するため listen を umask で囲む (callback で必ず復元)。
  const oldUmask = process.umask(0o177);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
  } finally {
    process.umask(oldUmask);
  }

  return {
    path: socketPath,
    // 接続中の購読者がいても即終了するため socket を能動 destroy してから close
    // (これをしないと server.close は全接続が自発切断するまで callback を発火せずハングする)。
    stop: () => new Promise((resolve) => {
      for (const s of socks) { try { s.destroy(); } catch { /* ignore */ } }
      server.close(() => resolve());
    }),
  };
}

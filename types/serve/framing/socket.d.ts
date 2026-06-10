/** 既存ソケットが生きてれば throw、stale なら unlink して継続。
 * @param {string} socketPath
 * @returns {Promise<void>}
 */
export function ensureFreeSocket(socketPath: string): Promise<void>;
/**
 * @param {import("../daemon.js").Daemon} daemon
 * @param {{ socketPath:string }} opts
 * @returns {Promise<{ path:string, stop:()=>Promise<void> }>}
 */
export function startSocketFraming(daemon: import("../daemon.js").Daemon, { socketPath }: {
    socketPath: string;
}): Promise<{
    path: string;
    stop: () => Promise<void>;
}>;
//# sourceMappingURL=socket.d.ts.map
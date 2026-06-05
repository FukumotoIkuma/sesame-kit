/** 既存ソケットが生きてれば throw、stale なら unlink して継続。 */
export function ensureFreeSocket(socketPath: any): Promise<any>;
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
/**
 * @param {import("../daemon.js").Daemon} daemon
 * @param {{ onShutdown?:()=>void }} [opts]
 * @returns {{ stop:()=>void }}
 */
export function startStdioFraming(daemon: import("../daemon.js").Daemon, { onShutdown }?: {
    onShutdown?: () => void;
}): {
    stop: () => void;
};
//# sourceMappingURL=stdio.d.ts.map
/**
 * @param {import("../daemon.js").Daemon} daemon
 * @param {{ bind?:string, port:number, token:string }} opts
 * @returns {Promise<{ stop:()=>Promise<void> }>}
 */
export function startWsFraming(daemon: import("../daemon.js").Daemon, { bind, port, token }: {
    bind?: string;
    port: number;
    token: string;
}): Promise<{
    stop: () => Promise<void>;
}>;
//# sourceMappingURL=ws.d.ts.map
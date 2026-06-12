/**
 * @param {import("../daemon.js").Daemon} daemon
 * @param {{ bind?:string, port:number, token:string }} opts
 * @returns {Promise<{ port:number, url:string, stop:()=>Promise<void> }>}
 */
export function startWsFraming(daemon: import("../daemon.js").Daemon, { bind, port, token }: {
    bind?: string;
    port: number;
    token: string;
}): Promise<{
    port: number;
    url: string;
    stop: () => Promise<void>;
}>;
//# sourceMappingURL=ws.d.ts.map
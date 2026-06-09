/**
 * @param {import("../daemon.js").Daemon} daemon
 * @param {{ bind?:string, port:number, token:string, corsOrigins?:(string[]|"*"|null) }} opts
 * @returns {Promise<{ url:string, stop:()=>Promise<void> }>}
 */
export function startHttpFraming(daemon: import("../daemon.js").Daemon, { bind, port, token, corsOrigins }: {
    bind?: string;
    port: number;
    token: string;
    corsOrigins?: (string[] | "*" | null);
}): Promise<{
    url: string;
    stop: () => Promise<void>;
}>;
//# sourceMappingURL=http.d.ts.map
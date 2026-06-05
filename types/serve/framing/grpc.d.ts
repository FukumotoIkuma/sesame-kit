/**
 * @param {import("../daemon.js").Daemon} daemon
 * @param {{ bind?:string, port:number, token:string }} opts
 * @returns {Promise<{ port:number, stop:()=>Promise<void> }>}
 */
export function startGrpcFraming(daemon: import("../daemon.js").Daemon, { bind, port, token }: {
    bind?: string;
    port: number;
    token: string;
}): Promise<{
    port: number;
    stop: () => Promise<void>;
}>;
//# sourceMappingURL=grpc.d.ts.map
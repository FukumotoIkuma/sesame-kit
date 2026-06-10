/**
 * `ws` の WebSocket の、本ファイルが触る面だけの最小ローカル型 (パッケージが型を同梱しないため)。
 * @typedef {object} WsSocket
 * @property {number} bufferedAmount
 * @property {(data: string) => void} send
 * @property {(code?: number, reason?: string) => void} close
 * @property {(event: string, cb: (...args: any[]) => void) => void} on
 */
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
/**
 * `ws` の WebSocket の、本ファイルが触る面だけの最小ローカル型 (パッケージが型を同梱しないため)。
 */
export type WsSocket = {
    bufferedAmount: number;
    send: (data: string) => void;
    close: (code?: number, reason?: string) => void;
    on: (event: string, cb: (...args: any[]) => void) => void;
};
//# sourceMappingURL=ws.d.ts.map
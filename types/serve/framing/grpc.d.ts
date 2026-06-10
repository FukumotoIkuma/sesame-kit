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
/**
 * proto-loader が動的生成する gRPC call の、本ファイルが触る面だけの最小型。
 * proto から生成される具体型は静的に分からないため、ここで構造的に定義する。
 */
export type GrpcCall = {
    /**
     * デコード済みリクエスト message
     */
    request: Record<string, any>;
    metadata?: {
        get?: (k: string) => unknown[];
    } | undefined;
    emit: (event: string, payload?: unknown) => void;
    on: (event: string, cb: (...args: any[]) => void) => void;
    write: (chunk: {
        topic: string;
        json: string;
    }) => boolean;
    end: () => void;
};
/**
 * unary handler の callback (err-first)。
 */
export type GrpcUnaryCallback = (err: (import("@grpc/grpc-js").ServiceError | Partial<import("@grpc/grpc-js").ServiceError>) | null, value?: {
    json: string;
}) => void;
//# sourceMappingURL=grpc.d.ts.map
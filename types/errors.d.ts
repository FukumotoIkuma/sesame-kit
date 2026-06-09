/** 機械可読なエラーコード (安定契約。serve が kind へ写像)。 */
export const ERR: Readonly<{
    NOT_CONNECTED: "not_connected";
    TIMEOUT: "timeout";
    REJECTED: "rejected";
    BAD_REQUEST: "bad_request";
    UNAUTHENTICATED: "unauthenticated";
}>;
export class SesameError extends Error {
    /**
     * @param {string} message
     * @param {{ code: string, retryable?: boolean, data?: object|null, cause?: any }} opts
     */
    constructor(message: string, { code, retryable, data, cause }?: {
        code: string;
        retryable?: boolean;
        data?: object | null;
        cause?: any;
    });
    code: string;
    retryable: boolean;
    data: any;
    cause: any;
}
//# sourceMappingURL=errors.d.ts.map
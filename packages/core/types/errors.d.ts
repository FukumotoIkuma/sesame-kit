/** 機械可読なエラーコード (安定契約。serve が kind へ写像)。 */
export const ERR: Readonly<{
    NOT_CONNECTED: "not_connected";
    TIMEOUT: "timeout";
    REJECTED: "rejected";
    BAD_REQUEST: "bad_request";
    UNAUTHENTICATED: "unauthenticated";
    BLE_NO_ADAPTER: "ble_no_adapter";
    BLE_UNAUTHORIZED: "ble_unauthorized";
    BLE_UNSUPPORTED: "ble_unsupported";
    BLE_POWERED_OFF: "ble_powered_off";
    BLE_INIT_TIMEOUT: "ble_init_timeout";
}>;
export class SesameError extends Error {
    /**
     * @param {string} message
     * @param {{ code?: string, retryable?: boolean, data?: object|null, cause?: unknown }} [opts]
     */
    constructor(message: string, { code, retryable, data, cause }?: {
        code?: string;
        retryable?: boolean;
        data?: object | null;
        cause?: unknown;
    });
    code: string | undefined;
    retryable: boolean;
    data: object | null;
    cause: unknown;
}
//# sourceMappingURL=errors.d.ts.map
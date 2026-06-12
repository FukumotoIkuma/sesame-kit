/**
 * @param {{ bleUseOptsFromParams: (hub: any, params: any) => any, bleCommandAck: (r: {resultCode: number}) => any }} helpers
 * @returns {Record<string, import("../registry-helpers.js").MethodEntry>}
 */
export function lockEntries({ bleUseOptsFromParams, bleCommandAck }: {
    bleUseOptsFromParams: (hub: any, params: any) => any;
    bleCommandAck: (r: {
        resultCode: number;
    }) => any;
}): Record<string, import("../registry-helpers.js").MethodEntry>;
//# sourceMappingURL=lock.d.ts.map
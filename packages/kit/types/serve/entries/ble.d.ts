/**
 * @param {{
 *   invokePath: (root: any, path: string, args?: any[], allowlist?: readonly string[]) => Promise<any>,
 *   wifiViewOf: (ble: any, opts?: {companyId?: string}) => {type: "wm2"|"hub3", view: any},
 *   collectWifiScan: (view: any, opts?: {collectMs?: number}) => Promise<{ssids: Array<{ssid: string, rssi: number}>}>,
 *   bleCommandAck: (r: {resultCode: number}) => {resultCode: number, resultName: string},
 *   bleUseOptsFromParams: (hub: any, params: any) => any,
 *   scrubDiscovery: (d: Record<string, unknown>) => Record<string, unknown>,
 *   reviveJsonArg: (value: any) => any,
 *   BLE_RPC_ALLOWLIST: readonly string[],
 *   OS2_BLE_RPC_ALLOWLIST: readonly string[],
 * }} helpers
 * @returns {Record<string, import("../registry-helpers.js").MethodEntry>}
 */
export function bleEntries({ invokePath, wifiViewOf, collectWifiScan, bleCommandAck, bleUseOptsFromParams, scrubDiscovery, reviveJsonArg, BLE_RPC_ALLOWLIST, OS2_BLE_RPC_ALLOWLIST, }: {
    invokePath: (root: any, path: string, args?: any[], allowlist?: readonly string[]) => Promise<any>;
    wifiViewOf: (ble: any, opts?: {
        companyId?: string;
    }) => {
        type: "wm2" | "hub3";
        view: any;
    };
    collectWifiScan: (view: any, opts?: {
        collectMs?: number;
    }) => Promise<{
        ssids: Array<{
            ssid: string;
            rssi: number;
        }>;
    }>;
    bleCommandAck: (r: {
        resultCode: number;
    }) => {
        resultCode: number;
        resultName: string;
    };
    bleUseOptsFromParams: (hub: any, params: any) => any;
    scrubDiscovery: (d: Record<string, unknown>) => Record<string, unknown>;
    reviveJsonArg: (value: any) => any;
    BLE_RPC_ALLOWLIST: readonly string[];
    OS2_BLE_RPC_ALLOWLIST: readonly string[];
}): Record<string, import("../registry-helpers.js").MethodEntry>;
//# sourceMappingURL=ble.d.ts.map
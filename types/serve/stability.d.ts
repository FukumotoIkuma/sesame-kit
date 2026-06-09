/** メソッド名 → "stable" | "experimental" (provenance から導出)。 */
export function stabilityOf(name: any): "stable" | "experimental";
/** メソッド名 → provenance 文字列。未登録は "unverified"。 */
export function provenanceOf(name: any): any;
/** イベント名 → "stable" | "experimental"。 */
export function eventStabilityOf(name: any): "stable" | "experimental";
/** イベント名 → provenance。 */
export function eventProvenanceOf(name: any): any;
export const STABLE_METHODS: {
    status: string;
    "account.whoami": string;
    "lock.lock": string;
    "lock.unlock": string;
    "lock.toggle": string;
    "lock.click": string;
    "lock.status": string;
    "devices.list": string;
    "device.history": string;
    "device.battery": string;
    "events.subscribe": string;
    "events.unsubscribe": string;
};
export const STABLE_EVENTS: {
    "event.lockState": string;
    "event.deviceUpdate": string;
    "event.ready": string;
};
//# sourceMappingURL=stability.d.ts.map
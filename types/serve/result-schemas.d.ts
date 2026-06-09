export const RESULT_SCHEMAS: Readonly<{
    status: {
        type: string;
        properties: any;
        required: any[];
    };
    "events.subscribe": {
        type: string;
        properties: any;
        required: any[];
    };
    "events.unsubscribe": {
        type: string;
        properties: any;
        required: any[];
    };
    "account.whoami": {
        type: string;
        properties: any;
        required: any[];
    };
    "devices.list": {
        type: string;
        items: any;
    };
    "device.history": {
        type: string;
        items: any;
    };
    "device.battery": {
        type: string;
        properties: any;
        required: any[];
    };
    "lock.status": any;
    "lock.lock": {
        type: string;
        properties: any;
        required: any[];
    };
    "lock.unlock": {
        type: string;
        properties: any;
        required: any[];
    };
    "lock.toggle": {
        type: string;
        properties: any;
        required: any[];
    };
    "lock.click": {
        type: string;
        properties: any;
        required: any[];
    };
}>;
//# sourceMappingURL=result-schemas.d.ts.map
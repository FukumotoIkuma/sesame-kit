/**
 * @param {import("node:stream").Readable} readable
 * @param {import("node:stream").Writable} writable
 * @param {{ onLine:(conn:import("../daemon.js").Connection, raw:string)=>void, onClose?:()=>void,
 *           maxQueue?:number, maxLine?:number, closeWritable?:boolean }} opts
 * @returns {import("../daemon.js").Connection}
 */
export function makeLineConnection(readable: import("node:stream").Readable, writable: import("node:stream").Writable, opts: {
    onLine: (conn: import("../daemon.js").Connection, raw: string) => void;
    onClose?: () => void;
    maxQueue?: number;
    maxLine?: number;
    closeWritable?: boolean;
}): import("../daemon.js").Connection;
//# sourceMappingURL=ndjson.d.ts.map
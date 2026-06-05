/**
 * @param {import("node:stream").Readable} readable
 * @param {import("node:stream").Writable} writable
 * @param {{ onLine:(conn:object, raw:string)=>void, onClose?:()=>void,
 *           maxQueue?:number, maxLine?:number, closeWritable?:boolean }} opts
 * @returns {{ id:string, send:(obj:object)=>void, close:()=>void }}
 */
export function makeLineConnection(readable: import("node:stream").Readable, writable: import("node:stream").Writable, opts: {
    onLine: (conn: object, raw: string) => void;
    onClose?: () => void;
    maxQueue?: number;
    maxLine?: number;
    closeWritable?: boolean;
}): {
    id: string;
    send: (obj: object) => void;
    close: () => void;
};
//# sourceMappingURL=ndjson.d.ts.map
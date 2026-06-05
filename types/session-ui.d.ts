/**
 * セッション UI を起動し、ユーザーが終了するまで待つ。
 * @param {{
 *   devices: Map<string, {entry:object, ble:object|null}>,
 *   hasCloud: boolean,                       // クラウド経路が使えるか (タグ表示用)
 *   bus: import("node:events").EventEmitter, // "update" で再描画
 *   exec: (op:string, device:object, seconds?:number)=>Promise<string>, // 1 操作を実行し結果文字列を返す
 *   actionsFor: (device:object)=>Array<{label:string, value:string}>,   // 型の能力に応じた操作 (status 含む)
 *   fmtState: (device:object)=>string,       // ヘッダの状態表示
 * }} props
 */
export function runSessionUI(props: {
    devices: Map<string, {
        entry: object;
        ble: object | null;
    }>;
    hasCloud: boolean;
    bus: import("node:events").EventEmitter;
    exec: (op: string, device: object, seconds?: number) => Promise<string>;
    actionsFor: (device: object) => Array<{
        label: string;
        value: string;
    }>;
    fmtState: (device: object) => string;
}): Promise<void>;
export function SessionApp({ devices, hasCloud, bus, exec, actionsFor, fmtState, hub3RemotesFor, listKeysFor }: {
    devices: any;
    hasCloud: any;
    bus: any;
    exec: any;
    actionsFor: any;
    fmtState: any;
    hub3RemotesFor: any;
    listKeysFor: any;
}): any;
//# sourceMappingURL=session-ui.d.ts.map
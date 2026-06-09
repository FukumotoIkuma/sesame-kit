/**
 * @param {import("commander").Command} program
 * @param {object} ctx cli.js makeCtx() が供給する共有コンテキスト
 */
export function registerBleCommands(program: import("commander").Command, ctx: object): void;
/** GET 要求 → publish(START→NOTIFY×N→END) を収集し、END または timeout で確定する。
 *  (テストのため export。spec は BIO_LIST の 1 entry。) */
export function collectBiometricList(cmds: any, spec: any, timeoutMs: any): Promise<any>;
/** record (card/passcode/finger は {id,name,type}、face/palm はパース済みオブジェクト) を1行に。
 *  (テストのため export。) */
export function formatRecord(r: any): string;
export namespace BIO_LIST {
    namespace card {
        let getter: string;
        let start: string;
        let recv: string;
        let end: string;
    }
    namespace passcode {
        let getter_1: string;
        export { getter_1 as getter };
        let start_1: string;
        export { start_1 as start };
        let recv_1: string;
        export { recv_1 as recv };
        let end_1: string;
        export { end_1 as end };
    }
    namespace finger {
        let getter_2: string;
        export { getter_2 as getter };
        let start_2: string;
        export { start_2 as start };
        let recv_2: string;
        export { recv_2 as recv };
        let end_2: string;
        export { end_2 as end };
    }
    namespace face {
        let getter_3: string;
        export { getter_3 as getter };
        let start_3: string;
        export { start_3 as start };
        let recv_3: string;
        export { recv_3 as recv };
        let end_3: string;
        export { end_3 as end };
        export let single: boolean;
    }
    namespace palm {
        let getter_4: string;
        export { getter_4 as getter };
        let start_4: string;
        export { start_4 as start };
        let recv_4: string;
        export { recv_4 as recv };
        let end_4: string;
        export { end_4 as end };
        let single_1: boolean;
        export { single_1 as single };
    }
}
//# sourceMappingURL=ble.d.ts.map
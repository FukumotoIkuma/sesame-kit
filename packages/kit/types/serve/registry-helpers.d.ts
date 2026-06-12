/**
 * 1 メソッドのレジストリエントリ。
 * @typedef {object} MethodEntry
 * @property {string} summary
 * @property {Array<{name:string, required:boolean, desc?:string, schema?:Record<string, unknown>}>} params
 * @property {string} result
 * @property {(ctx: HandlerCtx) => unknown} handler
 * @property {string} [namespace]
 */
/**
 * RPC ハンドラに渡る実行コンテキスト。
 * @typedef {object} HandlerCtx
 * @property {import("./daemon.js").HubLike & Record<string, any>} hub 常駐 SesameHub3
 * @property {Record<string, any>} params JSON-RPC params (オブジェクト)
 * @property {import("./daemon.js").Connection} [conn] 呼び出し元 Connection
 * @property {import("./daemon.js").Daemon} daemon Daemon (購読/リース/authState 用)
 */
/**
 * params 必須キーの存在チェック (軽量バリデータ)。欠落は bad_params。
 * @param {Record<string, unknown>} params
 * @param {string[]} keys
 */
export function need(params: Record<string, unknown>, keys: string[]): void;
/**
 * topics param を topic 文字列配列へ正規化する (単一値も配列に包む)。
 * 値の妥当性 (既知 topic か) は呼び出し側が TOPICS で検証する。
 * @param {unknown} raw
 * @returns {string[]}
 */
export function asTopicList(raw: unknown): string[];
/**
 * クラウド接続が要る op の前段ガード (未認証/未接続を明示エラーに)。
 * @param {import("./daemon.js").Daemon} daemon
 */
export function requireAuth(daemon: import("./daemon.js").Daemon): void;
/**
 * config 同期 RPC (config.*) の前段ガード (SURF-07)。daemon の hub が ConfigStore を持たない
 * 構成 (config/tokenStore 直渡しの埋め込み等) では同期先が無いため bad_params で明示拒否する。
 * hub.syncXxx 側の plain Error (requiresConfigStore) が kind=internal に潰れるのを防ぐ。
 * @param {import("./daemon.js").HubLike & Record<string, any>} hub
 * @param {string} op エラーメッセージに出すメソッド名
 */
export function requireConfigStore(hub: import("./daemon.js").HubLike & Record<string, any>, op: string): void;
/**
 * 1 メソッドのレジストリエントリ。
 */
export type MethodEntry = {
    summary: string;
    params: Array<{
        name: string;
        required: boolean;
        desc?: string;
        schema?: Record<string, unknown>;
    }>;
    result: string;
    handler: (ctx: HandlerCtx) => unknown;
    namespace?: string | undefined;
};
/**
 * RPC ハンドラに渡る実行コンテキスト。
 */
export type HandlerCtx = {
    /**
     * 常駐 SesameHub3
     */
    hub: import("./daemon.js").HubLike & Record<string, any>;
    /**
     * JSON-RPC params (オブジェクト)
     */
    params: Record<string, any>;
    /**
     * 呼び出し元 Connection
     */
    conn?: import("./daemon.js").Connection | undefined;
    /**
     * Daemon (購読/リース/authState 用)
     */
    daemon: import("./daemon.js").Daemon;
};
//# sourceMappingURL=registry-helpers.d.ts.map
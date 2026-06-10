export function run(argv?: string[]): Promise<void>;
/**
 * commander の Command (全コマンドハンドラに渡る program)。
 */
export type Program = import("commander").Command;
export type DeviceInfo = import("./client.js").DeviceInfo;
export type IRKey = import("./client.js").IRKey;
export type LoadedConfig = import("./config.js").LoadedConfig;
/**
 * グローバルオプション (program.opts())。--config-dir / --debug / --json / --lang。
 * commander が返す OptionValues は緩い型なので、既知キーだけ宣言し残りは index で許容する。
 */
export type GlobalOpts = {
    configDir?: string | undefined;
    debug?: boolean | undefined;
    json?: boolean | undefined;
    lang?: string | undefined;
};
/**
 * commander のサブコマンドオプション (.action の opts 引数)。既知キーは個別 typedef で、
 * 汎用経路はこの緩い型で受ける。
 */
export type CmdOpts = Record<string, any>;
/**
 * client.js が投げうるエラー (SesameError 含む。code/message を読む場面用)。
 */
export type CliError = Error & {
    code?: string;
    exitCode?: number;
    message: string;
};
export type LockEntry = {
    name: string;
    deviceUUID: string;
    secretKey: string;
    model?: string | null | undefined;
};
/**
 * config 由来の Hub3 entry (relay/LED 用 secretKey 付き)。
 */
export type Hub3Entry = {
    name: string;
    deviceId: string | undefined;
    model: string;
    secretKey: string | null;
};
/**
 * loadCtx() の戻り (ConfigStore / TokenStore / paths / opts)。
 */
export type CliLoadCtx = {
    /**
     * commander の program.opts()
     */
    opts: Record<string, any>;
    paths: import("./paths.js").ConfigPaths;
    configStore: import("./config.js").ConfigStore;
    tokenStore: import("./tokens.js").FileTokenStore;
};
/**
 * withHub/withAccount のコールバックが受け取る追加情報。
 */
export type HubExtra = {
    opts: Record<string, any>;
    paths: import("./paths.js").ConfigPaths;
};
/**
 * cli/ サブモジュール (registerXxxCommands) に渡す共有コンテキスト。makeCtx() の戻り。
 * 各 register は `register(program, ctx)` でこの ctx 越しに cli.js の helper を使う。
 */
export type CliCtx = {
    /**
     *   --json 指定時は jsonObj を、それ以外は humanFn() を出力。
     */
    out: (json: boolean, humanFn: () => void, jsonObj: unknown) => void;
    /**
     * エラー表示して exit (usage は code 2)。
     */
    die: (msg: string, code?: number) => never;
    /**
     * TTY かつ --json なしなら true。
     */
    canPrompt: () => boolean;
    /**
     * ConfigStore/TokenStore/paths/opts を取得。
     */
    loadCtx: () => CliLoadCtx;
    /**
     *   connect → fn(hub, {opts, paths}) → close。
     */
    withHub: (fn: (hub: import("./client.js").SesameHub3, extra: HubExtra) => any) => Promise<any>;
    /**
     *   withHub に加え refreshAccount() 済み customerInfo を extra へ渡す。
     */
    withAccount: (fn: (hub: import("./client.js").SesameHub3, extra: HubExtra & {
        customerInfo: any;
    }) => any) => Promise<any>;
    prompts: {
        selectFromList: typeof selectFromList;
        promptText: typeof promptText;
        confirm: typeof confirmPrompt;
        promptLine: (question: string) => Promise<string>;
    };
    /**
     * SesameBle ファサード生成。
     */
    makeBle: (opts: any) => import("./ble/index.js").SesameBle;
    /**
     * --json 文字列を JSON.parse (失敗は die(...,2))。
     */
    parseJson: (raw: string, hint?: string) => any;
};
/**
 * 認証後の自動セットアップ。接続して companyID 取得 → ロック / Hub3+リモコン を devices から取り込む。
 * best-effort: 各ステップは個別に try/catch し、失敗しても他を続行 (ネットワーク不調で認証成功を潰さない)。
 */
export type SyncResult = {
    added: string[];
    updated: string[];
    removed?: string[];
};
/**
 * 認証後の自動セットアップ。接続して companyID 取得 → ロック / Hub3+リモコン を devices から取り込む。
 * best-effort: 各ステップは個別に try/catch し、失敗しても他を続行 (ネットワーク不調で認証成功を潰さない)。
 */
export type BootstrapSummary = {
    companyID: string | null;
    locks: SyncResult | null;
    hub3s: {
        added?: string[];
        updated?: string[];
    } | null;
    remotes: SyncResult | null;
    errors: string[];
    authExpired?: boolean | undefined;
};
/**
 * biz3GetLoginUser の customerInfo (companyID/subUUID 等)。client は object|null で返すため絞る。
 */
export type CustomerInfo = {
    companyID?: string;
    subUUID?: string | null;
    name?: string;
    subscriptionId?: string;
};
/**
 * --remote <name> を取る系のオプション袋。
 */
export type RemoteOpts = {
    remote?: string | null;
};
/**
 * listDevices の生レコードは DeviceRecord より広い (keyLevel / sesame2PublicKey 等の生フィールド)。
 */
export type FullDeviceInfo = DeviceInfo & {
    keyLevel?: number;
    sesame2PublicKey?: string;
};
/**
 * `locks add` のオプション袋。フラグ指定で非対話登録できる。
 */
export type LockAddOpts = {
    name?: string | undefined;
    uuid?: string | undefined;
    secret?: string | undefined;
    model?: string | undefined;
    alias?: string | undefined;
    fromUrl?: string | undefined;
};
/**
 * BLE の mechStatus (ble.status() の戻り)。
 */
export type MechStatus = {
    state?: string;
    position?: number | null;
    isBatteryCritical?: boolean;
    isStop?: boolean;
    isCritical?: boolean;
};
/**
 * セッション対象 1 デバイスの entry (ロック / Hub3 を統合した緩い形)。
 */
export type SessionEntry = {
    name: string;
    /**
     * ロック (BLE)
     */
    deviceUUID?: string | undefined;
    secretKey?: string | undefined;
    /**
     * Hub3 (cloud relay/LED)
     */
    deviceId?: string | undefined;
    model?: string | null | undefined;
    kind?: string | undefined;
};
/**
 * セッション中の 1 デバイス。ble は接続できたら SesameBle、未接続は null。
 * lastStatus は SesameBle 側のキャッシュ済み mechStatus。
 */
export type SessionDevice = {
    kind: string;
    entry: SessionEntry;
    ble: (import("./ble/index.js").SesameBle & {
        lastStatus?: MechStatus | null;
    }) | null;
};
/**
 * 旧構成 (.env / keys.json / .tokens.json) からの移行サマリ。
 */
export type MigrateSummary = {
    configDir: string;
    imported: string[];
    hub3Added?: string | undefined;
    remoteAdded?: string | undefined;
};
/**
 * cloud の device-status (stateInfo) を fmtMech と揃えた 1 行に整形。
 * @param {{ stateInfo?: { position?: number|null, batteryPercentage?: number|null, CHSesame2Status?: string } }|null|undefined} st
 * @returns {string}
 */
export function fmtCloudStatus(st: {
    stateInfo?: {
        position?: number | null;
        batteryPercentage?: number | null;
        CHSesame2Status?: string;
    };
} | null | undefined): string;
/**
 * status 出力から秘匿値 (secretKey) を落とす。status は状態読み取りで鍵は不要。
 * @param {unknown} st
 * @returns {unknown}
 */
export function sanitizeStatus(st: unknown): unknown;
/** config show 用に config を複製し secretKey を**ツリー全体で**マスクする (tokens と同じ扱い)。
 *  config には devices と派生 locks の双方に鍵が入る等、複数箇所に現れるため一律で潰す。
 *  生の鍵が要るときは `sesame devices` (意図的な全ダンプ口) を使う。 */
/**
 * @param {unknown} cfg
 * @returns {unknown}
 */
export function redactConfig(cfg: unknown): unknown;
import { selectFromList } from "./prompts.js";
import { promptText } from "./prompts.js";
import { confirm as confirmPrompt } from "./prompts.js";
//# sourceMappingURL=cli.d.ts.map
/**
 * BLE ファサードをドット区切り op パスで辿って実行する (`ble.invoke` / `ble.os2.invoke` /
 * CLI `sesame ble invoke` 共通の単一実装。CLI が同じドット op パス・同じ JSON 引数 revive
 * 規約を共有するため export している)。
 *
 * **fail-closed (P4-2 / ARCH-14)**: 第 1 セグメントを allowlist (ble/index.js の
 * BLE_RPC_ALLOWLIST / OS2_BLE_RPC_ALLOWLIST = ファサードの意図的公開面) と照合し、
 * 非掲載は **値の解決 (getter 実行) より前に** bad_params で拒否する。旧実装は
 * `_`/constructor/prototype のブロックリストのみの fail-open で、connect/close/register 等の
 * ライフサイクル API や任意の getter に到達できた。
 *
 * @param {Record<string, any>} root 走査対象のオブジェクトツリー (ble facade 等)。
 * @param {string} path ドット区切りの op パス。
 * @param {unknown[]} [args]
 * @param {readonly string[]} [allowlist] 第 1 セグメントの allowlist。**未指定は全拒否**
 *   (fail-closed の既定。呼び出し側が公開面の表を明示的に渡す)。
 */
export function invokePath(root: Record<string, any>, path: string, args?: unknown[], allowlist?: readonly string[]): Promise<any>;
/**
 * SesameBle ファサードから Wi-Fi プロビジョニング view を kind で自動判別して返す。
 *   - wifiProvisioning (WM2)  → ble.wifi({companyId})
 *   - hubProvisioning (Hub3)  → ble.hub3()
 * どちらでもない model は bad_params (op を捏造して実機に送らない)。
 * CLI `sesame ble wifi` も同じ判別を共有する (export)。
 * @param {import("../ble/index.js").SesameBle} ble
 * @param {{companyId?:string}} [opts]
 * @returns {{type:"wm2"|"hub3", view:Record<string, any>}}
 */
export function wifiViewOf(ble: import("../ble/index.js").SesameBle, { companyId }?: {
    companyId?: string;
}): {
    type: "wm2" | "hub3";
    view: Record<string, any>;
};
/**
 * scanWifiSSID を送り、publish ({kind:"scanWifiSSID"}) を収集して SSID 一覧を返す。
 * Hub3 は SSID_LAST(134) マーカー publish (CHHub3Device.kt:325) で確定し、WM2 は終了通知が
 * 無い (CHWifiModule2Device.kt:486-490 は逐次 publish のみ) ため collectMs で打ち切る。
 * 同一 SSID の再 publish は rssi を更新する (重複行を返さない)。
 * @param {Record<string, any>} view WifiModule2 / Hub3Commands (onPublish + scanWifiSSID を持つ
 *   wifiViewOf の戻り view。Record なのは両クラスの publish 正規化形が異なるため)
 * @param {{collectMs?:number}} [opts]
 * @returns {Promise<{ssids:Array<{ssid:string, rssi:number}>}>}
 */
export function collectWifiScan(view: Record<string, any>, { collectMs }?: {
    collectMs?: number;
}): Promise<{
    ssids: Array<{
        ssid: string;
        rssi: number;
    }>;
}>;
/**
 * BLE コマンド応答 ({resultCode, payload}) を JSON 化可能な ack へ正規化する
 * (payload の生 Buffer は契約に載せない。生バイトが要る場合は ble.invoke を使う)。
 * @param {{resultCode:number}} r
 * @returns {{resultCode:number, resultName:string}}
 */
export function bleCommandAck(r: {
    resultCode: number;
}): {
    resultCode: number;
    resultName: string;
};
/**
 * 全エントリを {name → entry} で構築する。
 * @returns {Map<string, MethodEntry>}
 */
export function buildRegistry(): Map<string, MethodEntry>;
/**
 * OpenRPC 文書を組み立てる (rpc.discover 応答)。param スキーマは初期は粗いが
 * 「何の op が在るか」は完全網羅する。secretKey 等の実値 example は載せない。
 * @param {Map<string, MethodEntry>} reg
 * @param {string} version
 * @returns {Record<string, unknown>}
 */
export function buildOpenRpcDoc(reg: Map<string, MethodEntry>, version: string): Record<string, unknown>;
export const NAMESPACE_MODULE_KEYS: readonly string[];
/**
 * WM2 connectWifi の verification に使う既定 companyId。
 * 出典: _sesame_sdk_ref/app.properties:6 `aws.apigateway.clientId` (= BuildConfig.API_GATEWAY_CLIENT_ID。
 * CHWifiModule2Device.kt:358-363 が ":"/"-" を除去して company 部に使う)。params.companyId で上書き可。
 */
export const WM2_API_GATEWAY_CLIENT_ID: "ap-northeast-1:0a1820f1-dbb3-4bca-9227-2a92f6abf0ae";
/** pubDeviceStateChange を源とする state push の topic (同一ストリームの別ラベル — daemon._fanout 参照)。 */
export const STATE_TOPICS: readonly string[];
/** 購読可能な全 topic。deviceListChanged は pubUserDeviceChange 源の別ストリーム。 */
export const SUBSCRIBABLE_TOPICS: readonly string[];
/**
 * 常駐 hub。registry は (a) 明示メソッド (hub.lock 等) と (b) 名前空間 op の動的
 * dispatch (hub[ns][op]) の両方で hub を使う。どちらも実行時に解決する設計なので、
 * 型は daemon の HubLike を index signature 付きで緩める (動的 dispatch を許す)。
 * daemon が実際に渡す `this.hub` (HubLike) と互換である必要がある。
 */
export type Hub = import("./daemon.js").HubLike & Record<string, any>;
/**
 * RPC ハンドラに渡る実行コンテキスト。
 */
export type HandlerCtx = {
    /**
     * 常駐 SesameHub3
     */
    hub: Hub;
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
 * gen-rpc-schema が抽出した 1 param の記述。
 * desc は生成側が上書きした説明 (SURF-09: companyID/subUUID の自動注入注記等)。無ければ tsType を出す。
 */
export type GenParam = {
    name: string;
    required: boolean;
    tsType?: string;
    desc?: string;
    schema?: Record<string, unknown>;
};
//# sourceMappingURL=registry.d.ts.map
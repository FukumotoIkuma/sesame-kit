/**
 * model 文字列から kind を返す。
 *   - model 未指定 (null/空) → lock5 (SesameBle の config-less 利用 & 既存ロック config の後方互換。
 *     config.locks は同期時にロック機種のみ whitelist + model 保存なので、ここに来るのは実質ロック)。
 *   - model 文字列がテーブルに無い → **UNKNOWN (操作なし)**。未知機種を勝手にロック扱いして解錠等を
 *     捏造しない (Hub3 が解錠を出していた類のバグを構造的に防ぐ)。
 * @param {string|null|undefined} model
 * @returns {string} KIND
 */
export function kindForModel(model: string | null | undefined): string;
/**
 * model 文字列から能力定義を返す。
 *   - cloud / ble : 各経路で操作可能な op
 *   - ops         : 和集合 (UI で見せる操作・提示順)
 *   - bleSupported: BLE 制御を実装しているか (= ble.length>0)
 * @param {string|null|undefined} model
 * @returns {{kind:string, os:number, cloud:string[], ble:string[], ops:string[], mechKind:string|null, bleSupported:boolean, label:string}}
 */
export function capabilitiesForModel(model: string | null | undefined): {
    kind: string;
    os: number;
    cloud: string[];
    ble: string[];
    ops: string[];
    mechKind: string | null;
    bleSupported: boolean;
    label: string;
};
/** その model が op を (いずれかの経路で) 操作できるか。 */
export function supportsOp(model: any, op: any): boolean;
/** その model が (いずれかの経路で) 何か操作できるか。session の対象判定に使う。 */
export function isOperable(model: any): boolean;
/**
 * その model の op を運べる transport 一覧 (型×経路の能力テーブルから導出)。
 * 例: lock5 の autolock は ["ble"]、lock は ["ble","cloud"]、hub3 の ir は ["cloud"]。
 * @param {string|null|undefined} model
 * @param {string} op
 * @returns {string[]} ("ble" / "cloud" の部分集合)
 */
export function transportsForOp(model: string | null | undefined, op: string): string[];
/**
 * BLE 上の「デバイス種別 (kind)」。productType→実装クラスの多対一を、能力の単位でまとめたもの。
 * - lock5     : Sesame5/5Pro/6/6Pro/US/miwa, BLE Connector (OS3 ロック)
 * - bot2      : SESAME Bot2/Bot3 (OS3) — click のみ
 * - bike2     : SESAME Bike2/Bike3 (OS3) — unlock のみ
 * - sesame2   : Sesame2/3/4 (OS2 ロック) — BLE は別プロトコル (未実装)
 * - botOs2    : SESAME Bot1 (OS2) — BLE 未実装
 * - bikeOs2   : Bike1 (OS2) — BLE 未実装
 * - biometric : Touch/Face/OpenSensor/Remote (鍵束デバイス。施錠操作なし)
 * - hub3      : Hub3/Hub3 LTE (IoT 中継。BLE 施錠操作なし)
 * - wifi      : WifiModule2
 */
export const KIND: Readonly<{
    LOCK5: "lock5";
    BOT2: "bot2";
    BIKE2: "bike2";
    SESAME2: "sesame2";
    BOT_OS2: "botOs2";
    BIKE_OS2: "bikeOs2";
    BIOMETRIC: "biometric";
    HUB3: "hub3";
    WIFI: "wifi";
    UNKNOWN: "unknown";
}>;
/**
 * productType (整数) → { model, kind }。
 * 値は CHProductModel enum (CHDeivceProtocols.kt:28-252) と deviceFactory() の生成クラスに準拠。
 * pType 12 は SDK でも欠番。
 */
export const PRODUCT_TYPES: Readonly<{
    0: {
        model: string;
        kind: "sesame2";
    };
    1: {
        model: string;
        kind: "wifi";
    };
    2: {
        model: string;
        kind: "botOs2";
    };
    3: {
        model: string;
        kind: "bikeOs2";
    };
    4: {
        model: string;
        kind: "sesame2";
    };
    5: {
        model: string;
        kind: "lock5";
    };
    6: {
        model: string;
        kind: "bike2";
    };
    7: {
        model: string;
        kind: "lock5";
    };
    8: {
        model: string;
        kind: "biometric";
    };
    9: {
        model: string;
        kind: "biometric";
    };
    10: {
        model: string;
        kind: "biometric";
    };
    11: {
        model: string;
        kind: "lock5";
    };
    13: {
        model: string;
        kind: "hub3";
    };
    14: {
        model: string;
        kind: "biometric";
    };
    15: {
        model: string;
        kind: "biometric";
    };
    16: {
        model: string;
        kind: "lock5";
    };
    17: {
        model: string;
        kind: "bot2";
    };
    18: {
        model: string;
        kind: "biometric";
    };
    19: {
        model: string;
        kind: "biometric";
    };
    20: {
        model: string;
        kind: "lock5";
    };
    21: {
        model: string;
        kind: "lock5";
    };
    22: {
        model: string;
        kind: "biometric";
    };
    23: {
        model: string;
        kind: "biometric";
    };
    24: {
        model: string;
        kind: "biometric";
    };
    25: {
        model: string;
        kind: "biometric";
    };
    26: {
        model: string;
        kind: "biometric";
    };
    27: {
        model: string;
        kind: "biometric";
    };
    28: {
        model: string;
        kind: "biometric";
    };
    29: {
        model: string;
        kind: "lock5";
    };
    30: {
        model: string;
        kind: "biometric";
    };
    31: {
        model: string;
        kind: "biometric";
    };
    32: {
        model: string;
        kind: "lock5";
    };
    33: {
        model: string;
        kind: "bike2";
    };
    35: {
        model: string;
        kind: "bot2";
    };
    36: {
        model: string;
        kind: "hub3";
    };
}>;
//# sourceMappingURL=devicemodel.d.ts.map
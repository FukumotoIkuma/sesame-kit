/**
 * @param {import("commander").Command} program
 * @param {import("../cli.js").CliCtx} ctx cli.js makeCtx() が供給する共有コンテキスト
 */
export function registerBleCommands(program: import("commander").Command, ctx: import("../cli.js").CliCtx): void;
/**
 * record (card/passcode/finger は {id,name,type}、face/palm はパース済みオブジェクト) を1行に。
 * (テストのため export。CLI 出力整形専用、biometric.js へは移さない。)
 * @param {unknown} r
 * @returns {string}
 */
export function formatRecord(r: unknown): string;
/**
 * ble サブコマンドの commander options。値は string|undefined (boolean フラグは無い)。
 */
export type BleOptions = {
    secret?: string;
    model?: string;
    timeout?: string;
    index?: string;
    address?: string;
    productType?: string;
    save?: string;
    localServerAuth?: boolean;
    ak?: string;
    registerBaseUrl?: string;
    serverAuth?: boolean;
    args?: string;
    keyIndex?: string;
    ssmPublicKey?: string;
    yes?: boolean;
    companyId?: string;
};
/**
 * resolveBleEntry の解決結果。
 * ssmPublicKey/keyIndex は OS2 デバイス用の鍵素材 (バックログ4): 優先順位は
 * 明示フラグ (--ssm-public-key / --key-index) > config locks エントリの保存値 > null。
 */
export type BleEntry = {
    name: string;
    deviceUUID: string;
    secretKey: string;
    model: (string | null);
    ssmPublicKey: (string | null);
    keyIndex: (string | null);
};
/**
 * listNearby() / listNearbyDevices() の発見結果 1 件 (advertise だけから判る属性 + rssi)。
 * SesameBle.listNearby は Array<object> 宣言で型を落とすため、ここで実体形状にナロー化する。
 */
export type BleDiscovery = {
    deviceUUID: string;
    productType?: number;
    model?: (string | null);
    kind?: string;
    isRegistered?: boolean;
    advTagB1?: boolean;
    isConnectable?: boolean;
    rssi?: (number | null);
    localName?: (string | null);
    address?: (string | null);
    peripheral?: unknown;
};
/**
 * BIO_LIST の 1 entry (getter 名 + collect 用 delegate コールバック名)。
 * P1-8: biometric.js で定義・export 済み。ここは型参照のみ。
 */
export type BioSpec = import("../ble/biometric.js").BioSpec;
export { BIO_LIST, collectBiometricList } from "../ble/biometric.js";
//# sourceMappingURL=ble.d.ts.map
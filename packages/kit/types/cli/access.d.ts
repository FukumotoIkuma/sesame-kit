/**
 * @param {import("commander").Command} program
 * @param {import("../cli.js").CliCtx} ctx cli.js makeCtx() が供給する共有コンテキスト
 */
export function registerAccessCommands(program: import("commander").Command, ctx: import("../cli.js").CliCtx): void;
/**
 * getCards の items 要素 (lib access.js:144 の集約結果)。表示で読むフィールドのみ宣言。
 */
export type CardItem = {
    cardID?: string | undefined;
    name?: string | undefined;
    cardType?: string | number | undefined;
    /**
     * 該当 deviceUUID 群 (idKey 集約で付与)
     */
    uuids?: string[] | undefined;
};
/**
 * getPasscodes の items 要素 (lib access.js:165 の集約結果)。表示で読むフィールドのみ宣言。
 */
export type PasscodeItem = {
    passwordID?: string | undefined;
    name?: string | undefined;
    /**
     * 該当 deviceUUID 群 (idKey 集約で付与)
     */
    uuids?: string[] | undefined;
};
/**
 * getCards / getPasscodes の戻り (lib access.js:68,143,164)。namespace getter は
 * これを unknown に erase するため CLI 側で cast に使う。
 */
export type AccessListResult<T> = {
    items: T[];
    byDevice: Record<string, object[]>;
};
/**
 * BLE enroll (実機タップ/入力の即時収集 → クラウド DB 一括登録) の種別ごとの差分定義。
 * cards / passcodes で共通のフロー (cards enroll の実装) を再利用するための delegate 表
 * (SURF-04: passcode は onKeyBoardReceive / passcodeModeSet 系に差し替えるだけで同型)。
 */
export type EnrollKind = {
    /**
     * resolveDeviceUUIDs の die ヒント
     */
    cmdHint: string;
    /**
     * bioCaps 限定ビューに必要メソッドが生えているか
     */
    hasCapability: (bio: Record<string, unknown>) => boolean;
    /**
     * 能力なし機種の die メッセージキー
     */
    notCapableKey: string;
    /**
     * registerDelegate に渡す delegate
     */
    delegateFor: (collect: (id: string | undefined, record: object) => void) => object;
    /**
     * 登録モード切替 (1=REGISTER / 0=CONTROL)
     */
    modeSet: (bio: any, mode: number) => Promise<void>;
    /**
     * クラウド DB 登録
     */
    register: (hub: import("@sesame-kit/core/client").SesameHub3, deviceUUID: string, records: object[]) => Promise<unknown>;
    /**
     * 対話時のプロンプト文言キー
     */
    tapPromptKey: string;
    /**
     * 非対話時の収集待ち文言キー
     */
    waitingKey: string;
    /**
     * 収集結果文言キー
     */
    collectedKey: string;
    /**
     * 0 件文言キー
     */
    noneKey: string;
    /**
     * 登録完了文言キー
     */
    registeredKey: string;
    /**
     * JSON 出力でレコード配列を入れるキー名
     */
    recordsKey: string;
};
//# sourceMappingURL=access.d.ts.map
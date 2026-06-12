/**
 * BLE の mechStatus (ble.status() の戻り)。
 * @typedef {{ state?: string, position?: number|null, isBatteryCritical?: boolean, isStop?: boolean, isCritical?: boolean }} MechStatus
 */
/**
 * mechStatus を 1 行に整形。
 * @param {MechStatus|null|undefined} s
 * @returns {string}
 */
export function fmtMech(s: MechStatus | null | undefined): string;
/**
 * 接続済み SesameBle / SesameOS2Ble に op を実行する**唯一のコア**。単発コマンド・セッションの両方がここを通る
 * (session は保持中の接続を、単発は都度張った接続を渡す。「保持接続があればそれで操作する」という
 * セッションモードの挙動が、両方の既定動作になる)。能力ゲートは SesameBle 側が担保。表示はしない。
 * OS2 ファサード (SesameOS2Ble) も lock/unlock/toggle/click/autolock/status の同名メソッドを持つため、
 * 型は SesameBle | SesameOS2Ble の共通サブタイプとして `any` で受ける (両者に共通 interface 無し)。
 * @param {string} op
 * @param {import("@sesame-kit/core/ble").SesameBle|import("@sesame-kit/core/ble/os2").SesameOS2Ble} ble
 * @param {string|number|null|undefined} seconds
 * @returns {Promise<{result:any, status:MechStatus|null}>}
 */
export function bleExec(op: string, ble: import("@sesame-kit/core/ble").SesameBle | import("@sesame-kit/core/ble/os2").SesameOS2Ble, seconds: string | number | null | undefined): Promise<{
    result: any;
    status: MechStatus | null;
}>;
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
//# sourceMappingURL=exec.d.ts.map
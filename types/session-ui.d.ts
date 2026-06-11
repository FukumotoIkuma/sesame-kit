/**
 * メニュー 1 項目 (ink-select-input の Item<string> と構造互換)。
 * @typedef {{ label: string, value: string }} MenuItem
 */
/**
 * UI が直接読むデバイスの最小形。cli/session.js の SessionDevice はこれを満たす
 * (entry/ble の残りのフィールドは exec/actionsFor/fmtState コールバック側だけが使う)。
 * @typedef {object} SessionUIDeviceLike
 * @property {string} [kind] "lock" | "hub3" (省略時はロック扱い)
 * @property {{ model?: string|null }} entry config 由来のデバイス定義 (UI は model のみ参照)
 * @property {object|null} ble BLE 接続済みなら truthy (UI は真偽のみ参照)
 */
/**
 * セッション UI の props。D は呼び出し側のデバイス型 (cli/session.js では SessionDevice)。
 * @template {SessionUIDeviceLike} D
 * @typedef {object} SessionUIProps
 * @property {Map<string, D>} devices 表示対象デバイス (key = 表示名)
 * @property {boolean} hasCloud クラウド経路が使えるか (タグ表示用)
 * @property {import("node:events").EventEmitter} bus "update" で再描画
 * @property {(op: string, d: D, extra?: any) => Promise<string>} exec 1 操作を実行し結果文字列を返す
 * @property {(d: D) => MenuItem[]} actionsFor 型の能力に応じた操作 (status 含む)
 * @property {(d: D) => string} fmtState ヘッダの状態表示
 * @property {(d: D) => MenuItem[]} [hub3RemotesFor] IR: Hub3 配下のリモコン一覧 (Hub3 を含む場合)
 * @property {(remoteName: string) => MenuItem[]|Promise<MenuItem[]>} [listKeysFor] IR: リモコンのキー一覧
 */
/**
 * 画面 mode (画面遷移の状態機械)。
 * @typedef {"devices"|"actions"|"autolock"|"led"|"ir-remote"|"ir-key"|"busy"} SessionMode
 */
/**
 * セッション UI を起動し、ユーザーが終了するまで待つ。
 * @template {SessionUIDeviceLike} D
 * @param {SessionUIProps<D>} props
 */
export function runSessionUI<D extends SessionUIDeviceLike>(props: SessionUIProps<D>): Promise<void>;
/**
 * @template {SessionUIDeviceLike} D
 * @param {SessionUIProps<D>} props
 */
export function SessionApp<D extends SessionUIDeviceLike>({ devices, hasCloud, bus, exec, actionsFor, fmtState, hub3RemotesFor, listKeysFor }: SessionUIProps<D>): React.FunctionComponentElement<{
    readonly position?: "absolute" | "relative" | "static" | undefined;
    readonly top?: number | string | undefined;
    readonly right?: number | string | undefined;
    readonly bottom?: number | string | undefined;
    readonly left?: number | string | undefined;
    readonly columnGap?: number | undefined;
    readonly rowGap?: number | undefined;
    readonly gap?: number | undefined;
    readonly margin?: number | undefined;
    readonly marginX?: number | undefined;
    readonly marginY?: number | undefined;
    readonly marginTop?: number | undefined;
    readonly marginBottom?: number | undefined;
    readonly marginLeft?: number | undefined;
    readonly marginRight?: number | undefined;
    readonly padding?: number | undefined;
    readonly paddingX?: number | undefined;
    readonly paddingY?: number | undefined;
    readonly paddingTop?: number | undefined;
    readonly paddingBottom?: number | undefined;
    readonly paddingLeft?: number | undefined;
    readonly paddingRight?: number | undefined;
    readonly flexGrow?: number | undefined;
    readonly flexShrink?: number | undefined;
    readonly flexDirection?: "row" | "column" | "row-reverse" | "column-reverse" | undefined;
    readonly flexBasis?: number | string | undefined;
    readonly flexWrap?: "nowrap" | "wrap" | "wrap-reverse" | undefined;
    readonly alignItems?: "flex-start" | "center" | "flex-end" | "stretch" | "baseline" | undefined;
    readonly alignSelf?: "flex-start" | "center" | "flex-end" | "auto" | "stretch" | "baseline" | undefined;
    readonly alignContent?: "flex-start" | "flex-end" | "center" | "stretch" | "space-between" | "space-around" | "space-evenly" | undefined;
    readonly justifyContent?: "flex-start" | "flex-end" | "space-between" | "space-around" | "space-evenly" | "center" | undefined;
    readonly width?: number | string | undefined;
    readonly height?: number | string | undefined;
    readonly minWidth?: number | string | undefined;
    readonly minHeight?: number | string | undefined;
    readonly maxWidth?: number | string | undefined;
    readonly maxHeight?: number | string | undefined;
    readonly aspectRatio?: number | undefined;
    readonly display?: "flex" | "none" | undefined;
    readonly borderStyle?: (keyof import("cli-boxes").Boxes | import("cli-boxes").BoxStyle) | undefined;
    readonly borderTop?: boolean | undefined;
    readonly borderBottom?: boolean | undefined;
    readonly borderLeft?: boolean | undefined;
    readonly borderRight?: boolean | undefined;
    readonly borderColor?: import("type-fest").LiteralUnion<import("ansi-styles").ForegroundColorName, string> | undefined;
    readonly borderTopColor?: import("type-fest").LiteralUnion<import("ansi-styles").ForegroundColorName, string> | undefined;
    readonly borderBottomColor?: import("type-fest").LiteralUnion<import("ansi-styles").ForegroundColorName, string> | undefined;
    readonly borderLeftColor?: import("type-fest").LiteralUnion<import("ansi-styles").ForegroundColorName, string> | undefined;
    readonly borderRightColor?: import("type-fest").LiteralUnion<import("ansi-styles").ForegroundColorName, string> | undefined;
    readonly borderDimColor?: boolean | undefined;
    readonly borderTopDimColor?: boolean | undefined;
    readonly borderBottomDimColor?: boolean | undefined;
    readonly borderLeftDimColor?: boolean | undefined;
    readonly borderRightDimColor?: boolean | undefined;
    readonly borderBackgroundColor?: import("type-fest").LiteralUnion<import("ansi-styles").ForegroundColorName, string> | undefined;
    readonly borderTopBackgroundColor?: import("type-fest").LiteralUnion<import("ansi-styles").ForegroundColorName, string> | undefined;
    readonly borderBottomBackgroundColor?: import("type-fest").LiteralUnion<import("ansi-styles").ForegroundColorName, string> | undefined;
    readonly borderLeftBackgroundColor?: import("type-fest").LiteralUnion<import("ansi-styles").ForegroundColorName, string> | undefined;
    readonly borderRightBackgroundColor?: import("type-fest").LiteralUnion<import("ansi-styles").ForegroundColorName, string> | undefined;
    readonly overflow?: "visible" | "hidden" | undefined;
    readonly overflowX?: "visible" | "hidden" | undefined;
    readonly overflowY?: "visible" | "hidden" | undefined;
    readonly backgroundColor?: import("type-fest").LiteralUnion<import("ansi-styles").ForegroundColorName, string> | undefined;
} & {
    readonly 'aria-label'?: string;
    readonly 'aria-hidden'?: boolean;
    readonly 'aria-role'?: "button" | "checkbox" | "combobox" | "list" | "listbox" | "listitem" | "menu" | "menuitem" | "option" | "progressbar" | "radio" | "radiogroup" | "tab" | "tablist" | "table" | "textbox" | "timer" | "toolbar";
    readonly 'aria-state'?: {
        readonly busy?: boolean;
        readonly checked?: boolean;
        readonly disabled?: boolean;
        readonly expanded?: boolean;
        readonly multiline?: boolean;
        readonly multiselectable?: boolean;
        readonly readonly
        /** @param {boolean} allowExitAtTop */
        ? /** @param {boolean} allowExitAtTop */: boolean;
        readonly required?: boolean;
        readonly selected?: boolean;
    };
} & {
    children?: React.ReactNode | undefined;
} & React.RefAttributes<import("ink").DOMElement>>;
/**
 * メニュー 1 項目 (ink-select-input の Item<string> と構造互換)。
 */
export type MenuItem = {
    label: string;
    value: string;
};
/**
 * UI が直接読むデバイスの最小形。cli/session.js の SessionDevice はこれを満たす
 * (entry/ble の残りのフィールドは exec/actionsFor/fmtState コールバック側だけが使う)。
 */
export type SessionUIDeviceLike = {
    /**
     * "lock" | "hub3" (省略時はロック扱い)
     */
    kind?: string | undefined;
    /**
     * config 由来のデバイス定義 (UI は model のみ参照)
     */
    entry: {
        model?: string | null;
    };
    /**
     * BLE 接続済みなら truthy (UI は真偽のみ参照)
     */
    ble: object | null;
};
/**
 * セッション UI の props。D は呼び出し側のデバイス型 (cli/session.js では SessionDevice)。
 */
export type SessionUIProps<D extends SessionUIDeviceLike> = {
    /**
     * 表示対象デバイス (key = 表示名)
     */
    devices: Map<string, D>;
    /**
     * クラウド経路が使えるか (タグ表示用)
     */
    hasCloud: boolean;
    /**
     * "update" で再描画
     */
    bus: import("node:events").EventEmitter;
    /**
     * 1 操作を実行し結果文字列を返す
     */
    exec: (op: string, d: D, extra?: any) => Promise<string>;
    /**
     * 型の能力に応じた操作 (status 含む)
     */
    actionsFor: (d: D) => MenuItem[];
    /**
     * ヘッダの状態表示
     */
    fmtState: (d: D) => string;
    /**
     * IR: Hub3 配下のリモコン一覧 (Hub3 を含む場合)
     */
    hub3RemotesFor?: ((d: D) => MenuItem[]) | undefined;
    /**
     * IR: リモコンのキー一覧
     */
    listKeysFor?: ((remoteName: string) => MenuItem[] | Promise<MenuItem[]>) | undefined;
};
/**
 * 画面 mode (画面遷移の状態機械)。
 */
export type SessionMode = "devices" | "actions" | "autolock" | "led" | "ir-remote" | "ir-key" | "busy";
import React from "react";
//# sourceMappingURL=session-ui.d.ts.map
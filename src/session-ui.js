// @ts-nocheck
// SESAME セッションのライブダッシュボード (Ink / React)。
//
// inquirer の 1 問 1 答だと「入力待ちでブロック → 外部イベントで再描画できない」ため、
// 状態が変わった瞬間に描き直す Ink (React for CLI) で実装する。BLE の mechStatus publish や
// バックグラウンド接続の完了を `bus` の "update" イベントで受け、React state を更新して再描画する。
//
// 操作: ↑↓ 移動 / → か Enter で決定 / ← か Esc で戻る / q で終了。
// アクション実行後はホームに戻らず、その操作メニューに留まる (続けて操作できる)。
//
// JSX は使わない (本リポは src を素の ESM で実行しビルド工程が無いため)。React.createElement = h。

import React from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import { t } from "./i18n.js";

const h = React.createElement;

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
export async function runSessionUI(props) {
  const { waitUntilExit } = render(h(SessionApp, props));
  await waitUntilExit();
}

export function SessionApp({ devices, hasCloud, bus, exec, actionsFor, fmtState, hub3RemotesFor, listKeysFor }) {
  const { exit } = useApp();
  const names = [...devices.keys()];
  const single = names.length === 1;

  const [, setTick] = React.useState(0);
  // mode: devices | actions | autolock | led | ir-remote | ir-key | busy
  const [mode, setMode] = React.useState(single ? "actions" : "devices");
  const [selName, setSelName] = React.useState(single ? names[0] : null);
  const [msg, setMsg] = React.useState("");
  const [numVal, setNumVal] = React.useState("");      // autolock 秒数 / LED duty 入力
  const [selRemote, setSelRemote] = React.useState(null); // IR: 選択中リモコン
  const [irKeys, setIrKeys] = React.useState(null);    // IR: 取得したキー一覧 (null=未取得)
  const [hi, setHi] = React.useState(null);            // → 決定用: ハイライト中の項目

  // BLE onStatus / 背景接続完了 → 再描画。
  React.useEffect(() => {
    const on = () => setTick((t) => (t + 1) % 1_000_000);
    bus.on("update", on);
    return () => bus.off("update", on);
  }, [bus]);

  // → 決定用ハイライト hi のリセット:
  // ink-select-input の onHighlight は **初期項目では発火しない** ため、mode を変えた直後は
  // 前メニューの hi が残る。そのまま → を押すと前メニューの項目を新メニューのハンドラに渡してしまう
  // (例: デバイスを → で選ぶと actions に入るが hi=デバイス項目のまま → actions で → を押すと
  //  selectAction にデバイス項目が渡り runExec(デバイス名) → exec が hub[デバイス名] を呼んで
  //  "hub[op] is not a function")。mode が変わるたびに hi をクリアし、ユーザーが ↑↓ で動かして
  // onHighlight が発火するまで goForward は menuItems()[0] にフォールバックさせる。
  React.useEffect(() => { setHi(null); }, [mode]);

  const backToActions = () => { setMode("actions"); };

  // ---- 各メニューの選択ハンドラ (SelectInput.onSelect と → 決定の両方から呼ぶ) ----
  const selectDevice = (it) => {
    if (!it) return;
    if (it.value === "__quit") { exit(); return; }
    setSelName(it.value); setMsg(""); setMode("actions");
  };
  const selectAction = (it) => {
    if (!it) return;
    if (it.value === "__back") { if (single) exit(); else { setMode("devices"); setMsg(""); } return; }
    if (it.value === "autolock") { setNumVal(""); setMode("autolock"); return; }
    if (it.value === "led") { setNumVal(""); setMode("led"); return; }
    if (it.value === "ir") { setSelRemote(null); setIrKeys(null); setMode("ir-remote"); return; }
    runExec(it.value, devices.get(selName));
  };
  const selectIrRemote = (it) => {
    if (!it) return;
    if (it.value === "__back") { backToActions(); return; }
    setSelRemote(it.value); setIrKeys(null); setMode("ir-key");
    Promise.resolve(listKeysFor ? listKeysFor(it.value) : []).then(setIrKeys).catch(() => setIrKeys([]));
  };
  const selectIrKey = (it) => {
    if (!it) return;
    if (it.value === "__back") { setMode("ir-remote"); return; }
    runExec("ir", devices.get(selName), { remote: selRemote, key: it.value });
  };

  // ← / Esc で 1 つ戻る。Esc は最上位 (devices / single の actions) では終了する。
  // ← は最上位では何もしない (誤操作で終了しないように)。
  const goBack = (allowExitAtTop) => {
    if (mode === "actions") {
      if (single) { if (allowExitAtTop) exit(); }
      else { setMode("devices"); setMsg(""); }
    } else if (mode === "ir-key") setMode("ir-remote");
    else if (mode === "devices") { if (allowExitAtTop) exit(); }
    else backToActions(); // autolock / led / ir-remote
  };

  // 現在 mode のメニュー項目 (render と → 決定で共有。順序が両者で一致する)。
  const menuItems = () => {
    if (mode === "devices") return [...names.map((n) => ({ label: n, value: n })), { label: t("session.quit"), value: "__quit" }];
    if (mode === "actions") return [...actionsFor(devices.get(selName)), { label: single ? t("session.quit") : t("session.back"), value: "__back" }];
    if (mode === "ir-remote") {
      const r = hub3RemotesFor ? hub3RemotesFor(devices.get(selName)) : [];
      return r.length ? [...r, { label: t("session.back"), value: "__back" }] : [];
    }
    if (mode === "ir-key") return (irKeys && irKeys.length) ? [...irKeys, { label: t("session.back"), value: "__back" }] : [];
    return [];
  };

  // → で決定。ink-select-input の onHighlight は初期項目では発火しないため、移動前は hi=null。
  // その場合は先頭 (= 既定でハイライトされている項目) にフォールバックする。
  const goForward = () => {
    const it = hi || menuItems()[0];
    if (!it) return;
    if (mode === "devices") selectDevice(it);
    else if (mode === "actions") selectAction(it);
    else if (mode === "ir-remote") selectIrRemote(it);
    else if (mode === "ir-key") selectIrKey(it);
  };

  const isList = mode === "devices" || mode === "actions" || mode === "ir-remote" || mode === "ir-key";

  useInput((input, key) => {
    if (mode === "busy") return;
    // q は**メニュー系のみ**で終了。autolock/LED の数値入力中は文字として TextInput へ渡す。
    if (input === "q" && isList) { exit(); return; }
    if (key.escape) { goBack(true); return; }       // Esc: 戻る (最上位では終了)
    // ← / → は数値入力 (autolock/led) ではテキストカーソル移動に使うので、リスト系のみで奪う。
    if (isList && key.leftArrow) { goBack(false); return; }  // ←: 戻る (最上位では何もしない)
    if (isList && key.rightArrow) { goForward(); return; }   // →: 決定
  });

  const runExec = (op, d, extra) => {
    setMode("busy");
    exec(op, d, extra)
      .then((m) => setMsg(m))
      .catch((e) => setMsg(`error: ${e?.message || e}`))
      .finally(() => setMode("actions")); // ホームに戻らず操作メニューに留まる (続けて操作できる)
  };

  // ヘッダ: 全デバイスの現在状態 (ライブ) + 操作ヒント。
  const header = h(
    Box,
    { flexDirection: "column" },
    h(Text, { dimColor: true }, t("session.title")),
    ...names.map((n) => {
      const d = devices.get(n);
      const tag = d.kind === "hub3" ? "hub3" : (d.ble ? "BLE" : (hasCloud ? "cloud" : "—"));
      const label = d.kind === "hub3" ? "hub3" : (d.entry.model || "?");
      return h(Text, { key: n, color: d.ble ? "green" : undefined },
        `  ${n} [${label}·${tag}]: ${fmtState(d)}`);
    }),
    h(Text, { dimColor: true }, "  " + t("session.hints")),
    msg ? h(Text, { color: "yellow" }, msg) : null,
  );
  const box = (...kids) => h(Box, { flexDirection: "column" }, header, ...kids);

  if (mode === "busy") return box(h(Text, null, t("session.busy")));

  // 数値入力 (autolock 秒数 / LED duty)。
  if (mode === "autolock" || mode === "led") {
    const d = devices.get(selName);
    const isLed = mode === "led";
    const prompt = isLed ? t("session.ledPrompt", { name: selName }) : t("session.autolockPrompt", { name: selName });
    const max = isLed ? 255 : 65535;
    return box(h(Box, null,
      h(Text, null, prompt),
      h(TextInput, {
        value: numVal,
        onChange: setNumVal,
        onSubmit: (v) => {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 0 || n > max) { setMsg(t("session.numRange", { max })); backToActions(); return; }
          runExec(isLed ? "led" : "autolock", d, n);
        },
      }),
    ));
  }

  // IR: リモコン選択。
  if (mode === "ir-remote") {
    const d = devices.get(selName);
    const remotes = (hub3RemotesFor ? hub3RemotesFor(d) : []);
    if (remotes.length === 0) {
      return box(h(Text, null, t("session.noRemotes", { name: selName })));
    }
    return box(h(Text, null, t("session.irPickRemote", { name: selName })),
      h(SelectInput, { items: menuItems(), onHighlight: setHi, onSelect: selectIrRemote }),
    );
  }

  // IR: キー選択 (非同期取得中はローディング表示)。
  if (mode === "ir-key") {
    if (irKeys === null) return box(h(Text, null, t("session.keysLoading", { remote: selRemote })));
    if (irKeys.length === 0) return box(h(Text, null, t("session.noKeys", { remote: selRemote })));
    return box(h(Text, null, t("session.irPickKey", { remote: selRemote })),
      h(SelectInput, { items: menuItems(), onHighlight: setHi, onSelect: selectIrKey }),
    );
  }

  if (mode === "actions") {
    return box(h(Text, null, t("session.actionsTitle", { name: selName })),
      h(SelectInput, { items: menuItems(), onHighlight: setHi, onSelect: selectAction }),
    );
  }

  // mode === "devices"
  return box(h(Text, null, t("session.devicesTitle")),
    h(SelectInput, { items: menuItems(), onHighlight: setHi, onSelect: selectDevice }),
  );
}

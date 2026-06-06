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

  // mode が変わったらハイライトを一旦クリア (空リスト mode で前メニューの項目が残らないように)。
  // SelectInput マウント時の onHighlight が直後に先頭項目で埋め直す。
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

  // → で決定 (ハイライト中の項目を選択)。リスト系 mode のみ。
  const goForward = () => {
    if (mode === "devices") selectDevice(hi);
    else if (mode === "actions") selectAction(hi);
    else if (mode === "ir-remote") selectIrRemote(hi);
    else if (mode === "ir-key") selectIrKey(hi);
  };

  const isList = mode === "devices" || mode === "actions" || mode === "ir-remote" || mode === "ir-key";

  useInput((input, key) => {
    if (mode === "busy") return;
    if (input === "q") { exit(); return; }
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
    h(Text, { dimColor: true }, "─── SESAME セッション ───"),
    ...names.map((n) => {
      const d = devices.get(n);
      const tag = d.kind === "hub3" ? "hub3" : (d.ble ? "BLE" : (hasCloud ? "cloud" : "—"));
      const label = d.kind === "hub3" ? "hub3" : (d.entry.model || "?");
      return h(Text, { key: n, color: d.ble ? "green" : undefined },
        `  ${n} [${label}·${tag}]: ${fmtState(d)}`);
    }),
    h(Text, { dimColor: true }, "  ↑↓ 移動  → 決定  ← 戻る  q 終了"),
    msg ? h(Text, { color: "yellow" }, msg) : null,
  );
  const box = (...kids) => h(Box, { flexDirection: "column" }, header, ...kids);

  if (mode === "busy") return box(h(Text, null, "実行中..."));

  // 数値入力 (autolock 秒数 / LED duty)。
  if (mode === "autolock" || mode === "led") {
    const d = devices.get(selName);
    const isLed = mode === "led";
    const prompt = isLed ? `${selName} LED 調光 (0-255): ` : `${selName} オートロック秒数 (0=無効): `;
    const max = isLed ? 255 : 65535;
    return box(h(Box, null,
      h(Text, null, prompt),
      h(TextInput, {
        value: numVal,
        onChange: setNumVal,
        onSubmit: (v) => {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 0 || n > max) { setMsg(`⚠ 0..${max} の整数で指定してください。`); backToActions(); return; }
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
      return box(h(Text, null, `${selName}: 登録リモコンがありません ( sesame remote add で登録 )。← / Esc で戻る`));
    }
    const items = [...remotes, { label: "← 戻る", value: "__back" }];
    return box(h(Text, null, `${selName} の IR: リモコン選択`),
      h(SelectInput, { items, onHighlight: setHi, onSelect: selectIrRemote }),
    );
  }

  // IR: キー選択 (非同期取得中はローディング表示)。
  if (mode === "ir-key") {
    if (irKeys === null) return box(h(Text, null, `${selRemote}: キー取得中...`));
    if (irKeys.length === 0) return box(h(Text, null, `${selRemote}: キーがありません ( sesame remote sync-keys )。← / Esc で戻る`));
    const items = [...irKeys, { label: "← 戻る", value: "__back" }];
    return box(h(Text, null, `${selRemote} のキー選択 (送信)`),
      h(SelectInput, { items, onHighlight: setHi, onSelect: selectIrKey }),
    );
  }

  if (mode === "actions") {
    const d = devices.get(selName);
    const items = [...actionsFor(d)];
    items.push({ label: single ? "終了" : "← 戻る", value: "__back" });
    return box(h(Text, null, `${selName} の操作:`),
      h(SelectInput, { items, onHighlight: setHi, onSelect: selectAction }),
    );
  }

  // mode === "devices"
  const items = names.map((n) => ({ label: n, value: n }));
  items.push({ label: "終了", value: "__quit" });
  return box(h(Text, null, "操作するデバイス:"),
    h(SelectInput, { items, onHighlight: setHi, onSelect: selectDevice }),
  );
}

// セッション UI (Ink) の描画・操作テスト。ink-testing-library で実フレームを検証する。
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { EventEmitter } from "node:events";
import { SessionApp } from "../src/session-ui.js";
import { setLocale } from "../src/i18n.js";

const h = React.createElement;

function makeDevices() {
  return new Map([
    ["front", { entry: { name: "front", model: "sesame_5" }, ble: { lastStatus: { state: "locked", position: -176 } } }],
    ["kitchen", { entry: { name: "kitchen", model: "bot_2" }, ble: null }],
  ]);
}
const actionsFor = (d) => {
  if (d.kind === "hub3") return [{ label: "📡 IR 送信", value: "ir" }, { label: "🔌 リレー ON", value: "relay-on" }, { label: "💡 LED 調光", value: "led" }];
  return d.entry.model === "bot_2"
    ? [{ label: "👆 クリック", value: "click" }, { label: "ℹ 状態", value: "status" }]
    : [{ label: "🔓 解錠", value: "unlock" }, { label: "ℹ 状態", value: "status" }];
};
const fmtState = (d) => {
  if (d.kind === "hub3") return "(Hub3)";
  return d.ble ? `state=${d.ble.lastStatus.state} pos=${d.ble.lastStatus.position}` : "(BLE未接続)";
};

const baseProps = (over = {}) => ({
  devices: makeDevices(),
  hasCloud: true,
  bus: new EventEmitter(),
  exec: vi.fn(async () => "OK"),
  actionsFor,
  fmtState,
  ...over,
});

describe("SessionApp (Ink)", () => {
  beforeEach(() => setLocale("en")); // 既定 (英語) で検証。ja は専用テストで確認。

  it("全デバイスをライブ状態付きで表示し、デバイス選択メニューを出す", () => {
    const { lastFrame } = render(h(SessionApp, baseProps()));
    const f = lastFrame();
    expect(f).toContain("front [sesame_5·BLE]: state=locked pos=-176");
    expect(f).toContain("kitchen [bot_2·cloud]: (BLE未接続)");
    expect(f).toContain("Pick a device:");
  });

  it("bus 'update' で再描画され、BLE 昇格 (cloud→BLE) が反映される", async () => {
    const props = baseProps();
    const { lastFrame, rerender } = render(h(SessionApp, props));
    expect(lastFrame()).toContain("kitchen [bot_2·cloud]");
    // 背景接続が完了したと仮定して devices を更新し、update を流す
    props.devices.get("kitchen").ble = { lastStatus: { state: "unlocked", position: 0 } };
    props.bus.emit("update");
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain("kitchen [bot_2·BLE]: state=unlocked");
  });

  it("Hub3 は IR/リレー/LED の操作を出す", () => {
    const devices = new Map([["hub3-living", { kind: "hub3", entry: { name: "hub3-living", deviceId: "uuid" }, ble: null }]]);
    const { lastFrame } = render(h(SessionApp, baseProps({
      devices,
      hub3RemotesFor: () => [{ label: "aircon", value: "aircon" }],
      listKeysFor: async () => [{ label: "power", value: "power" }],
    })));
    const f = lastFrame();
    expect(f).toContain("hub3-living [hub3·hub3]: (Hub3)");
    expect(f).toContain("IR 送信");
    expect(f).toContain("リレー");
    expect(f).toContain("LED");
  });

  it("単一デバイスはデバイス選択を飛ばして操作メニューに直行 (型で操作が変わる)", () => {
    const devices = new Map([["kitchen", { entry: { name: "kitchen", model: "bot_2" }, ble: null }]]);
    const { lastFrame } = render(h(SessionApp, baseProps({ devices })));
    const f = lastFrame();
    expect(f).toContain("kitchen — actions:");
    expect(f).toContain("クリック"); // bot は click
    expect(f).not.toContain("解錠");
  });

  // ---- 操作 (キー入力) ----
  const ENTER = "\r", RIGHT = "[C", LEFT = "[D";
  const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

  it("アクション実行後はホーム(デバイス一覧)に戻らず操作メニューに留まる", async () => {
    const props = baseProps();
    const { lastFrame, stdin } = render(h(SessionApp, props));
    stdin.write(ENTER);                       // 先頭デバイス front を選択
    await tick();
    expect(lastFrame()).toContain("front — actions:");
    stdin.write(ENTER);                       // 先頭アクション (解錠) を実行
    await tick(100);                          // exec(async) 完了 + 再描画を待つ
    expect(props.exec).toHaveBeenCalledTimes(1);
    expect(props.exec.mock.calls[0][0]).toBe("unlock");
    // 実行後も操作メニューのまま (旧挙動のデバイス一覧へは戻らない)
    expect(lastFrame()).toContain("front — actions:");
    expect(lastFrame()).not.toContain("Pick a device:");
  });

  it("→ で決定・← で戻るができる", async () => {
    const { lastFrame, stdin } = render(h(SessionApp, baseProps()));
    expect(lastFrame()).toContain("Pick a device:");
    stdin.write(RIGHT);                        // → : ハイライト中のデバイスを決定
    await tick();
    expect(lastFrame()).toContain("front — actions:");
    stdin.write(LEFT);                         // ← : 1つ戻る
    await tick();
    expect(lastFrame()).toContain("Pick a device:");
  });

  it("↓でデバイスをハイライト→→選択→→実行しても、前メニューの hi が誤爆しない (regression)", async () => {
    // 回帰: mode 変更時に hi をクリアしないと、↓ で kitchen をハイライト (hi=kitchen) →
    // → で選択して操作メニューに入った後も hi=kitchen が残り、操作メニューで → を押すと
    // selectAction にデバイス項目が渡って runExec("kitchen") → exec が hub["kitchen"] を呼んで
    // "hub[op] is not a function" になっていた。
    const DOWN = LEFT.slice(0, -1) + "B"; // ESC[D(←) から ESC[B(↓) を作る (ESC バイトを直書きしない)
    const props = baseProps();
    const { lastFrame, stdin } = render(h(SessionApp, props));
    stdin.write(DOWN);                         // ↓ : kitchen をハイライト (onHighlight が hi=kitchen に)
    await tick();
    stdin.write(RIGHT);                        // → : kitchen を決定 → 操作メニュー
    await tick();
    expect(lastFrame()).toContain("kitchen — actions:");
    stdin.write(RIGHT);                        // → : 先頭アクションを実行
    await tick(100);
    expect(props.exec).toHaveBeenCalledTimes(1);
    // 先頭アクション "click" であるべき。バグ版ではデバイス名 "kitchen" が op に渡る。
    expect(props.exec.mock.calls[0][0]).toBe("click");
    expect(props.exec.mock.calls[0][0]).not.toBe("kitchen");
  });

  it("setLocale('ja') で日本語 UI になる (i18n 切替)", () => {
    setLocale("ja");
    const { lastFrame } = render(h(SessionApp, baseProps()));
    const f = lastFrame();
    expect(f).toContain("操作するデバイス:");        // 英語 "Pick a device:" の ja
    expect(f).toContain("↑↓ 移動");                  // ヒント行も ja
    expect(f).not.toContain("Pick a device:");
  });
});

// BLE RPC 共有ヘルパー — CLI と serve/registry の両方から使う葉モジュール (P5-3)。
//
// 移設元: src/serve/registry.js (P5-3 / R2:ARCH-04 + R2:SURF-39 WiFi 収集部)。
// 目的: cli/ble.js が serve/registry.js の全体 (rpc-params.generated.json 2124 行の
//   readFileSync+JSON.parse・全 framing 静的 import) を巻き込まず、必要な helper だけを
//   依存できるようにする。ble/index.js から再 export することでライブラリ消費者も import 可能。
//
// 依存方向: ble/ → serve/jsonrpc.js は serve 層の protocol 定数 (RpcError/RPC/KIND) のみ。
//   build artifact や registry の大塊には依存しない。

import { Buffer } from "node:buffer";
import { RpcError, RPC, KIND } from "../serve/jsonrpc.js";
import { t } from "../i18n.js";
import { ITEM_CODES } from "../itemcodes.js";
import { resultName } from "./protocol.js";

/**
 * JSON で送られた特殊エンコード (Buffer/$buffer) を実値へ復元する。prototype 汚染キーは拒否。
 * serve/registry.js の ble.invoke / ble.os2.register が使う単一実装。
 * CLI も `sesame ble invoke` の引数パースでこの規約を共有する (P5-3 移設)。
 * @param {any} value
 * @returns {any}
 */
export function reviveJsonArg(value) {
  if (Array.isArray(value)) return value.map(reviveJsonArg);
  if (!value || typeof value !== "object") return value;
  if (value.type === "Buffer" && Array.isArray(value.data)) return Buffer.from(value.data);
  if (typeof value.$buffer === "string") {
    const encoding = value.encoding === "base64" ? "base64" : "hex";
    return Buffer.from(value.$buffer, encoding);
  }
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new RpcError(t("serve.unsupportedJsonKey", { k: key }), { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
    }
    out[key] = reviveJsonArg(nested);
  }
  return out;
}

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
export async function invokePath(root, path, args = [], allowlist = []) {
  if (!path || typeof path !== "string") {
    throw new RpcError(t("serve.missingParam", { k: "op" }), { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
  }
  if (path.includes("_") || path.includes("constructor") || path.includes("prototype")) {
    throw new RpcError(t("serve.unsupportedBleOp", { op: path }), { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
  }
  const parts = path.split(".").filter(Boolean);
  // fail-closed: allowlist 非掲載の第 1 セグメントは、root のプロパティ解決 (getter が実行され
  // 得る) に入る前に拒否する。
  if (parts.length === 0 || !allowlist.includes(parts[0])) {
    throw new RpcError(t("serve.unsupportedBleOp", { op: path }), { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
  }
  let target = root;
  for (let i = 0; i < parts.length; i += 1) {
    const key = parts[i];
    const value = target?.[key];
    if (value === undefined) {
      throw new RpcError(t("serve.unsupportedBleOp", { op: path }), { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
    }
    if (i === parts.length - 1) {
      if (typeof value !== "function") return value;
      const revived = reviveJsonArg(args);
      return value.apply(target, Array.isArray(revived) ? revived : [revived]);
    }
    target = typeof value === "function" ? value.call(target) : value;
  }
  return target;
}

/**
 * WM2 connectWifi の verification に使う既定 companyId。
 * 出典: _sesame_sdk_ref/app.properties:6 `aws.apigateway.clientId` (= BuildConfig.API_GATEWAY_CLIENT_ID。
 * CHWifiModule2Device.kt:358-363 が ":"/"-" を除去して company 部に使う)。params.companyId で上書き可。
 */
export const WM2_API_GATEWAY_CLIENT_ID = "ap-northeast-1:0a1820f1-dbb3-4bca-9227-2a92f6abf0ae";

// Wi-Fi SSID スキャン publish の既定収集時間 (SDK に終了通知契約が無い WM2 のための打ち切り)。
const WIFI_SCAN_COLLECT_MS = 8_000;

/**
 * SesameBle ファサードから Wi-Fi プロビジョニング view を kind で自動判別して返す。
 *   - wifiProvisioning (WM2)  → ble.wifi({companyId})
 *   - hubProvisioning (Hub3)  → ble.hub3()
 * どちらでもない model は bad_params (op を捏造して実機に送らない)。
 * CLI `sesame ble wifi` も同じ判別を共有する (export)。
 * @param {import("./index.js").SesameBle} ble
 * @param {{companyId?:string}} [opts]
 * @returns {{type:"wm2"|"hub3", view:Record<string, any>}}
 */
export function wifiViewOf(ble, { companyId } = {}) {
  const caps = ble.capabilities;
  if (caps.wifiProvisioning) return { type: "wm2", view: ble.wifi({ companyId: companyId ?? WM2_API_GATEWAY_CLIENT_ID }) };
  if (caps.hubProvisioning) return { type: "hub3", view: ble.hub3() };
  throw new RpcError(t("serve.bleWifiNotSupported", { label: caps.label }), { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
}

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
export function collectWifiScan(view, { collectMs = WIFI_SCAN_COLLECT_MS } = {}) {
  return new Promise((resolve, reject) => {
    /** @type {Map<string, {ssid:string, rssi:number}>} */
    const found = new Map();
    let done = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    /** @type {() => void} */
    let off = () => {};
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      off();
      resolve({ ssids: [...found.values()] });
    };
    off = view.onPublish((/** @type {any} */ p) => {
      if (p && p.kind === "scanWifiSSID" && typeof p.ssid === "string") {
        found.set(p.ssid, { ssid: p.ssid, rssi: p.rssi });
      } else if (p && p.kind === "ssidMarker" && p.itemCode === ITEM_CODES.HUB3_ITEM_CODE_SSID_LAST) {
        finish(); // Hub3 のみ: 末尾マーカーで早期確定
      }
    });
    timer = setTimeout(finish, collectMs);
    // スキャン要求の ack 失敗 (BleResultError 等) は収集を打ち切って伝搬する。
    Promise.resolve(view.scanWifiSSID()).catch((err) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      off();
      reject(err);
    });
  });
}

/**
 * BLE コマンド応答 ({resultCode, payload}) を JSON 化可能な ack へ正規化する
 * (payload の生 Buffer は契約に載せない。生バイトが要る場合は ble.invoke を使う)。
 * @param {{resultCode:number}} r
 * @returns {{resultCode:number, resultName:string}}
 */
export function bleCommandAck(r) {
  return { resultCode: r.resultCode, resultName: resultName(r.resultCode) };
}

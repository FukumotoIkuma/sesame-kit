// 公開ライブラリエントリ。
//
// パッケージ名は "sesame-kit" (package.json の "name")。
// 注: このパッケージは `"private": true` のため npm publish されていません。
//     他プロジェクトから使うには `npm link sesame-kit` か
//     `npm install /path/to/sesame-kit` で取り込んでください。
//
// 高レベル:
//   import { SesameHub3 } from "sesame-kit";
//   await SesameHub3.use(async (hub) => {
//     await hub.send("ac", "停止");
//   });
//   // または手動で connect/close:
//   const hub = await SesameHub3.fromConfig();
//   await hub.connect();
//   try { await hub.send("ac", "停止"); } finally { await hub.close(); }
//
// 低レベル (自前で WS / トークン管理する場合):
//   import { Hub3WsClient, sendIR, getIRCodes, FileTokenStore } from "sesame-kit";
//   import { lock } from "sesame-kit";   // lock.* namespace も利用可

export { SesameHub3 } from "./client.js";
export { SesameError, ERR } from "./errors.js"; // 型付きドメインエラー (err.code で分岐)
export { Hub3WsClient, sendIR, getIRCodes } from "./transport.js";
export { FileTokenStore } from "./tokens.js";
export { ConfigStore } from "./config.js";
export { configPaths, resolveConfigDir } from "./paths.js";
export * as auth from "./auth.js";
export * as crypto from "./crypto.js";
export * as ir from "./ir.js";
export * as devices from "./devices.js";
export * as account from "./account.js";
export * as schedule from "./schedule.js";
export * as org from "./org.js";
export * as company from "./company.js";
export * as access from "./access.js";
export * as iot from "./iot.js";
export * as presetir from "./presetir.js";
export * as sharekey from "./sharekey.js";
export * as lock from "./lock.js";
// BLE 直接制御 (クラウド非経由)。SesameBle.use({secretKey, deviceUUID}, fn) で利用。
export * as ble from "./ble/index.js";
export { SesameBle } from "./ble/index.js";
// OS2 デバイス (SESAME2/3/4・初代 Bot・初代 Bike) の BLE 直接制御。login が ECDH 由来のため
// SesameBle とは別ファサード (keyIndex/ssmPublicKey + transport 注入が必須)。
export { SesameOS2Ble } from "./ble/index.js";
// WS 応答 success 判定の共通 helper (低レベル import で op を直叩きする消費者向け)。
export { assertSuccess } from "./util.js";
// lock.* の主要関数は個別 named export でも提供 (後方互換 + 利便性)。
// 注: `botClick` は低レベル関数 (client, params) → SesameHub3#botClick(name) とは別物。
export {
  triggerLock,
  lockLock,
  lockUnlock,
  lockToggle,
  botClick,
  triggerItemCommand,
  setAutolock,
} from "./lock.js";

// 正準 SesameItemCode。クラウド経路 (biz3TriggerLocker / cmdSesame) も BLE 経路 (GATT) も、
// 最後に送る「命令の正体」はこの同一の itemCode。違うのは梱包 (cloud=CMAC(time)+base64 を WS /
// BLE=AES-CCM 暗号セグメントを GATT) だけ — 公式 SesameSDK の CHSesame5.lock() 等が内部で
// 「BLE 可なら BLE、不可ならクラウド」を選びつつ同じ itemCode を送るのと同じ構造。
//
// かつてクラウド側 (crypto.js CMD) と BLE 側 (ble/protocol.js ITEM) で同じ番号を二重定義していたが、
// それは設計の取り違え。ここを唯一のソースとし、両者は別名で参照する。
//
// 値の出典: Android SesameSDK SesameProtocols.kt:32-53 (SesameItemCode)。
export const ITEM_CODES = Object.freeze({
  NONE: 0,
  REGISTRATION: 1,
  LOGIN: 2,
  USER: 3,
  HISTORY: 4,
  VERSION_TAG: 5,
  TIME: 8,
  AUTOLOCK: 11,        // payload = 2byte LE 秒数 (0=無効)。クラウド中継は ack のみで未反映 (実機検証済み) → BLE 専用扱い
  INITIAL: 14,
  MAGNET: 17,
  HISTORY_DELETE: 18,
  MECH_SETTING: 80,
  MECH_STATUS: 81,     // 状態通知 (publish)
  LOCK: 82,
  UNLOCK: 83,
  MOVE_TO: 84,
  TOGGLE: 88,          // 現在状態で施錠/解錠を反転 (クラウドはサーバが判定、BLE は SDK 同様クライアントが lock/unlock を選ぶ)
  CLICK: 89,           // SESAME Bot のクリック (biz3 web の呼称は BOT_CLICK)
});

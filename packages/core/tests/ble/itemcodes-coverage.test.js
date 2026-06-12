// P3-17: 規範8「ITEM_CODES のキー集合 = SesameItemCode 全メンバ」全件照合テスト。
// 「Android SesameSDK SesameProtocols.kt:32-53 と 1:1」宣言の機械的な強制。
// 参照: _sesame_sdk_ref/sesame-sdk/.../ble/SesameProtocols.kt:32-53
import { describe, it, expect } from "vitest";
import { ITEM_CODES } from "../../src/itemcodes.js";

// SesameItemCode enum の全メンバを数値で列挙。
// 出典: SesameProtocols.kt:32-53 (internal enum class SesameItemCode(val value: UByte))。
// 各数値は 参照ファイル内の宣言 `NAME(Xu)` と 1:1 対応。
// 名前は対応する ITEM_CODES キーの確認用コメントとして添えてある。
const SESAME_ITEM_CODE_VALUES = new Set([
  0,   // none
  1,   // registration
  2,   // login
  3,   // user
  4,   // history
  5,   // versionTag
  6,   // disconnectRebootNow
  7,   // enableDFU
  8,   // time
  9,   // bleConnectionParam
  10,  // bleAdvParam
  11,  // autolock
  12,  // serverAdvKick
  13,  // ssmtoken
  14,  // initial
  15,  // IRER
  16,  // timePhone
  17,  // magnet
  18,  // SSM2_ITEM_CODE_HISTORY_DELETE
  19,  // SENSOR_INVERVAL
  20,  // SENSOR_INVERVAL_GET
  80,  // mechSetting
  81,  // mechStatus
  82,  // lock
  83,  // unlock
  84,  // moveTo
  85,  // driveDirection
  86,  // stop
  87,  // detectDir
  88,  // toggle
  89,  // click
  90,  // DOOR_OPEN
  91,  // DOOR_CLOSE
  92,  // OPS_CONTROL
  93,  // SCRIPT_SETTING
  94,  // SCRIPT_SELECT
  95,  // SCRIPT_CURRENT
  96,  // SCRIPT_NAME_LIST
  101, // ADD_SESAME
  102, // PUB_KEY_SESAME
  103, // REMOVE_SESAME
  104, // Reset
  106, // NOTIFY_LOCK_DOWN
  107, // SSM_OS3_CARD_CHANGE
  108, // SSM_OS3_CARD_DELETE
  109, // SSM_OS3_CARD_GET
  110, // SSM_OS3_CARD_NOTIFY
  111, // SSM_OS3_CARD_LAST
  112, // SSM_OS3_CARD_FIRST
  113, // SSM_OS3_CARD_MODE_GET
  114, // SSM_OS3_CARD_MODE_SET
  115, // SSM_OS3_FINGERPRINT_CHANGE
  116, // SSM_OS3_FINGERPRINT_DELETE
  117, // SSM_OS3_FINGERPRINT_GET
  118, // SSM_OS3_FINGERPRINT_NOTIFY
  119, // SSM_OS3_FINGERPRINT_LAST
  120, // SSM_OS3_FINGERPRINT_FIRST
  121, // SSM_OS3_FINGERPRINT_MODE_GET
  122, // SSM_OS3_FINGERPRINT_MODE_SET
  123, // SSM_OS3_PASSCODE_CHANGE
  124, // SSM_OS3_PASSCODE_DELETE
  125, // SSM_OS3_PASSCODE_GET
  126, // SSM_OS3_PASSCODE_NOTIFY
  127, // SSM_OS3_PASSCODE_LAST
  128, // SSM_OS3_PASSCODE_FIRST
  129, // SSM_OS3_PASSCODE_MODE_GET
  130, // SSM_OS3_PASSCODE_MODE_SET
  131, // HUB3_ITEM_CODE_WIFI_SSID
  132, // HUB3_ITEM_CODE_SSID_FIRST
  133, // HUB3_ITEM_CODE_SSID_NOTIFY
  134, // HUB3_ITEM_CODE_SSID_LAST
  135, // HUB3_ITEM_CODE_WIFI_PASSWORD
  136, // HUB3_UPDATE_WIFI_SSID
  137, // HUB3_MATTER_PAIRING_CODE
  138, // SSM_OS3_PASSCODE_ADD
  139, // SSM_OS3_CARD_CHANGE_VALUE
  140, // SSM_OS3_CARD_ADD
  141, // SSM_OS3_CARD_MOVE
  142, // SSM_OS3_PASSCODE_MOVE
  143, // SSM_OS3_IR_MODE_SET
  144, // SSM_OS3_IR_CODE_CHANGE
  145, // SSM_OS3_IR_CODE_EMIT
  146, // SSM_OS3_IR_CODE_GET
  147, // SSM_OS3_IR_CODE_LAST
  148, // SSM_OS3_IR_CODE_FIRST
  149, // SSM_OS3_IR_CODE_DELETE
  150, // SSM_OS3_IR_MODE_GET
  151, // SSM_OS3_IR_CODE_NOTIFY
  153, // HUB3_MATTER_PAIRING_WINDOW
  154, // SSM_OS3_FACE_CHANGE
  155, // SSM_OS3_FACE_DELETE
  156, // SSM_OS3_FACE_GET
  157, // SSM_OS3_FACE_NOTIFY
  158, // SSM_OS3_FACE_LAST
  159, // SSM_OS3_FACE_FIRST
  160, // SSM_OS3_FACE_MODE_GET
  161, // SSM_OS3_FACE_MODE_SET
  162, // SSM_OS3_PALM_CHANGE
  163, // SSM_OS3_PALM_DELETE
  164, // SSM_OS3_PALM_GET
  165, // SSM_OS3_PALM_NOTIFY
  166, // SSM_OS3_PALM_LAST
  167, // SSM_OS3_PALM_FIRST
  168, // SSM_OS3_PALM_MODE_GET
  169, // SSM_OS3_PALM_MODE_SET
  170, // BOT2_ITEM_CODE_RUN_SCRIPT_0
  171, // BOT2_ITEM_CODE_RUN_SCRIPT_1
  172, // BOT2_ITEM_CODE_RUN_SCRIPT_2
  173, // BOT2_ITEM_CODE_RUN_SCRIPT_3
  174, // BOT2_ITEM_CODE_RUN_SCRIPT_4
  175, // BOT2_ITEM_CODE_RUN_SCRIPT_5
  176, // BOT2_ITEM_CODE_RUN_SCRIPT_6
  177, // BOT2_ITEM_CODE_RUN_SCRIPT_7
  178, // BOT2_ITEM_CODE_RUN_SCRIPT_8
  179, // BOT2_ITEM_CODE_RUN_SCRIPT_9
  180, // ADD_HUB3
  181, // BOT2_ITEM_CODE_EDIT_SCRIPT
  182, // STP_ITEM_CODE_CARDS_ADD (SesameItemCode 側)
  183, // STP_ITEM_CODE_DEVICE_STATUS (SesameItemCode 側)
  190, // REMOTE_NANO_ITEM_CODE_SET_TRIGGER_DELAYTIME
  191, // REMOTE_NANO_ITEM_CODE_PUB_TRIGGER_DELAYTIME
  192, // SSM_OS3_FACE_MODE_DELETE_NOTIFY
  193, // SSM_OS3_PALM_MODE_DELETE_NOTIFY
  200, // SSM_OS3_RADAR_PARAM_SET
  201, // SSM_OS3_RADAR_PARAM_PUBLISH
  202, // SSM3_ITEM_CODE_BATTERY_VOLTAGE
  204, // SSM3_ITEM_CODE_SESAME_UNSUPPORT
  205, // SS3_ITEM_CODE_SET_ADV_PRODUCT_TYPE
  206, // SSM3_ITEM_CODE_BLE_TX_POWER_SETTING
  208, // HUB3_ITEM_CODE_RELAY_SWITCH
]);

describe("ITEM_CODES ↔ SesameItemCode 全件照合 (規範8 / P3-17)", () => {
  const itemValues = new Set(Object.values(ITEM_CODES));

  it("ITEM_CODES の値集合は SesameItemCode 全メンバの値集合と一致する (欠落なし)", () => {
    // SDK にあって ITEM_CODES にないものを検出
    const missing = [...SESAME_ITEM_CODE_VALUES].filter(v => !itemValues.has(v)).sort((a, b) => a - b);
    expect(missing, `ITEM_CODES に欠落: ${missing.join(", ")}`).toEqual([]);
  });

  it("ITEM_CODES の値集合は SesameItemCode 全メンバの値集合と一致する (余剰なし)", () => {
    // ITEM_CODES にあって SDK にないものを検出 (UNVERIFIED 汚染の検出)
    const extra = [...itemValues].filter(v => !SESAME_ITEM_CODE_VALUES.has(v)).sort((a, b) => a - b);
    expect(extra, `ITEM_CODES に余剰 (SDK 非存在): ${extra.join(", ")}`).toEqual([]);
  });

  it("SesameItemCode の全メンバ数は 130 件", () => {
    // メンバ数が変わったら照合リストの更新を強制する番兵
    expect(SESAME_ITEM_CODE_VALUES.size).toBe(130);
  });
});

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
  DISCONNECT_REBOOT_NOW: 6, // OS2 切断+即時リブート (SesameProtocols.kt:34 disconnectRebootNow(6))
  ENABLE_DFU: 7,            // OS2 BLE DFU 開始 (SesameProtocols.kt:34 enableDFU(7))。payload "01" で開始、本体転送は別途
  TIME: 8,
  BLE_CONNECTION_PARAM: 9,
  BLE_ADV_PARAM: 10,
  AUTOLOCK: 11,        // payload = 2byte LE 秒数 (0=無効)。クラウド中継は ack のみで未反映 (実機検証済み) → BLE 専用扱い
  SERVER_ADV_KICK: 12,
  SSMTOKEN: 13,
  INITIAL: 14,
  IRER: 15,            // OS2 登録時の IR/ER 読み出し (SesameProtocols.kt:34)。READ 応答 payload の drop(16) が ER
  TIMEPHONE: 16,       // OS2 login 後の時刻同期 (SesameProtocols.kt:34 SesameItemCode.timePhone)。TIME(8) とは別物
  MAGNET: 17,
  HISTORY_DELETE: 18,
  SENSOR_INTERVAL: 19,
  SENSOR_INTERVAL_GET: 20,
  MECH_SETTING: 80,
  MECH_STATUS: 81,     // 状態通知 (publish)
  LOCK: 82,
  UNLOCK: 83,
  MOVE_TO: 84,
  DRIVE_DIRECTION: 85,
  STOP: 86,
  DETECT_DIR: 87,
  TOGGLE: 88,          // 現在状態で施錠/解錠を反転 (クラウドはサーバが判定、BLE は SDK 同様クライアントが lock/unlock を選ぶ)
  CLICK: 89,           // SESAME Bot のクリック (biz3 web の呼称は BOT_CLICK)
  DOOR_OPEN: 90,
  DOOR_CLOSE: 91,
  OPS_CONTROL: 92,     // opSensorControl / opsSetting (SesameProtocols.kt:36 OPS_CONTROL(92u))。publish で opsSetting を載せる
  SCRIPT_SETTING: 93,

  // --- SESAME Bot2/Bot3 スクリプト機能 — 出典: SesameProtocols.kt:36,47-48 ---
  // Bot2/Bot3 は最大 10 個のスクリプト (各スクリプトは name + 最大 20 個の Bot2Action) を保持する。
  // CHSesameBot2Device.kt:73-193 と CHSesameBot2.kt 準拠。
  SCRIPT_SELECT: 94,   // アクティブなスクリプトを切り替え (selectScript)。送信 payload=[index 1B]
  SCRIPT_CURRENT: 95,  // 現在 (または index 指定) のスクリプト内容を取得 (getCurrentScript)
  SCRIPT_NAME_LIST: 96, // 全スクリプトの index/name 一覧を取得 (getScriptNameList)
  // index 指定 click。click(index) は RUN_SCRIPT_0(170)+index の itemCode を送る
  // (CHSesameBot2Device.kt:73-97)。0..9 の 10 本。
  BOT2_ITEM_CODE_RUN_SCRIPT_0: 170,
  BOT2_ITEM_CODE_RUN_SCRIPT_1: 171,
  BOT2_ITEM_CODE_RUN_SCRIPT_2: 172,
  BOT2_ITEM_CODE_RUN_SCRIPT_3: 173,
  BOT2_ITEM_CODE_RUN_SCRIPT_4: 174,
  BOT2_ITEM_CODE_RUN_SCRIPT_5: 175,
  BOT2_ITEM_CODE_RUN_SCRIPT_6: 176,
  BOT2_ITEM_CODE_RUN_SCRIPT_7: 177,
  BOT2_ITEM_CODE_RUN_SCRIPT_8: 178,
  BOT2_ITEM_CODE_RUN_SCRIPT_9: 179,
  ADD_HUB3: 180,
  BOT2_ITEM_CODE_EDIT_SCRIPT: 181, // スクリプトの書き込み (sendClickScript)。送信 payload=[index 1B]+scriptBytes

  // --- OS3 登録デバイス (Sesame Touch / Touch Pro / Face / Palm) ---
  // SDK では SesameItemCode の連番に同居。生体・カード・暗証番号の各操作は
  // CHANGE/DELETE/GET/NOTIFY/LAST/FIRST/MODE_GET/MODE_SET の 8 命令を基本セットとし、
  // 種別ごとに ADD/MOVE 等の追加命令を持つ。値は SesameProtocols.kt と 1:1。

  // カード (FeliCa/MIFARE) — 出典: SesameProtocols.kt:37,40
  CARD_CHANGE: 107,
  CARD_DELETE: 108,
  CARD_GET: 109,
  CARD_NOTIFY: 110,
  CARD_LAST: 111,
  CARD_FIRST: 112,
  CARD_MODE_GET: 113,
  CARD_MODE_SET: 114,
  CARD_CHANGE_VALUE: 139,
  CARD_ADD: 140,
  CARD_MOVE: 141,

  // 指紋 — 出典: SesameProtocols.kt:38
  FINGERPRINT_CHANGE: 115,
  FINGERPRINT_DELETE: 116,
  FINGERPRINT_GET: 117,
  FINGERPRINT_NOTIFY: 118,
  FINGERPRINT_LAST: 119,
  FINGERPRINT_FIRST: 120,
  FINGERPRINT_MODE_GET: 121,
  FINGERPRINT_MODE_SET: 122,

  // 暗証番号 (Passcode) — 出典: SesameProtocols.kt:39,40,42
  PASSCODE_CHANGE: 123,
  PASSCODE_DELETE: 124,
  PASSCODE_GET: 125,
  PASSCODE_NOTIFY: 126,
  PASSCODE_LAST: 127,
  PASSCODE_FIRST: 128,
  PASSCODE_MODE_GET: 129,
  PASSCODE_MODE_SET: 130,
  PASSCODE_ADD: 138,
  PASSCODE_MOVE: 142,

  // Hub3 IR BLE item codes — 出典: SesameProtocols.kt:41-42
  SSM_OS3_IR_MODE_SET: 143,
  SSM_OS3_IR_CODE_CHANGE: 144,
  SSM_OS3_IR_CODE_EMIT: 145,
  SSM_OS3_IR_CODE_GET: 146,
  SSM_OS3_IR_CODE_LAST: 147,
  SSM_OS3_IR_CODE_FIRST: 148,
  SSM_OS3_IR_CODE_DELETE: 149,
  SSM_OS3_IR_MODE_GET: 150,
  SSM_OS3_IR_CODE_NOTIFY: 151,
  HUB3_MATTER_PAIRING_WINDOW: 153,

  // 顔認証 (Face) — 出典: SesameProtocols.kt:43-44
  FACE_CHANGE: 154,
  FACE_DELETE: 155,
  FACE_GET: 156,
  FACE_NOTIFY: 157,
  FACE_LAST: 158,
  FACE_FIRST: 159,
  FACE_MODE_GET: 160,
  FACE_MODE_SET: 161,
  FACE_MODE_DELETE_NOTIFY: 192,   // 出典: SesameProtocols.kt:50

  // 掌紋 (Palm) — 出典: SesameProtocols.kt:45-46
  PALM_CHANGE: 162,
  PALM_DELETE: 163,
  PALM_GET: 164,
  PALM_NOTIFY: 165,
  PALM_LAST: 166,
  PALM_FIRST: 167,
  PALM_MODE_GET: 168,
  PALM_MODE_SET: 169,
  PALM_MODE_DELETE_NOTIFY: 193,   // 出典: SesameProtocols.kt:50

  // OS3 デバイス間 鍵共有 (HUB3/WM2 が子 Sesame を追加・削除) — 出典: SesameProtocols.kt:36
  ADD_SESAME: 101,
  PUB_KEY_SESAME: 102,
  REMOVE_SESAME: 103,
  RESET: 104,                     // SesameProtocols.kt:36 Reset
  NOTIFY_LOCK_DOWN: 106,

  // SESAME Hub3 / Hub3 LTE 固有 (Wi-Fi プロビジョニング・SSID スキャン) — 出典: SesameProtocols.kt:40,52
  // WM2 が WM2ActionCode (別 enum) で Wi-Fi 設定を持つのに対し、Hub3 は **SesameItemCode に直接**
  // 131-136/208 を持つ (CHHub3Device.kt は CHSesameOS3 を継承し SesameOS3Payload(itemCode,...) で送る)。
  // 値は SesameProtocols.kt:40 (131-136) / :52 (208) と 1:1。
  // 注: 旧版でここに同居していた NETWORK_TYPE(209) は SesameItemCode に **存在しない**
  //   (enum は 208 で終端) ため、SDK 由来定数群から分離し UNVERIFIED_ITEM_CODES へ移した (P3-14)。
  HUB3_ITEM_CODE_WIFI_SSID: 131,      // SSID スキャン要求 (送信 data 無し)。結果は SSID_NOTIFY(133) publish で届く
  HUB3_ITEM_CODE_SSID_FIRST: 132,     // SSID スキャン結果の先頭マーカー publish (CHHub3Device.kt:324 で no-op)
  HUB3_ITEM_CODE_SSID_NOTIFY: 133,    // SSID スキャン 1 件 publish: [rssi(LE int16) 2B][ssid UTF-8...]
  HUB3_ITEM_CODE_SSID_LAST: 134,      // SSID スキャン結果の末尾マーカー publish (CHHub3Device.kt:325 で no-op)
  HUB3_ITEM_CODE_WIFI_PASSWORD: 135,  // Wi-Fi パスワード設定 (送信 data = password の UTF-8 bytes)
  HUB3_UPDATE_WIFI_SSID: 136,         // Wi-Fi SSID 設定 (送信 data = ssid の UTF-8 bytes)
  HUB3_MATTER_PAIRING_CODE: 137,
  HUB3_ITEM_CODE_RELAY_SWITCH: 208,   // リレー切替の op (IoT 経由でも使う。CHHub3Device.kt:150)

  // STP_ITEM_CODE_DEVICE_STATUS(183) — 出典: SesameProtocols.kt:49 (SesameItemCode 側の宣言)。
  // ★SDK 内で参照箇所が無い (送信も受信ハンドラも存在しない) 未使用コード。さらに別 enum の
  //   StpItemCode 側 183 (STP_ITEM_CODE_CARDS_DELETE, SesameProtocols.kt:66) と **数値が衝突** する
  //   (BLEP-10)。batchAdd/Delete の cmdItCode に使うのは STP_ITEM_CODES 側であり、本定数は
  //   SesameItemCode enum の 1:1 完全性のためだけに置く (混同しないこと)。
  STP_ITEM_CODE_DEVICE_STATUS: 183,

  // Remote Nano (トリガ遅延) — 出典: SesameProtocols.kt:49
  // REMOTE_NANO_ITEM_CODE_SET_TRIGGER_DELAYTIME(190u) / REMOTE_NANO_ITEM_CODE_PUB_TRIGGER_DELAYTIME(191u)。
  // 送信(190): [time(UByte 1B)]。受信(191 publish): payload 先頭 1B(LE) = triggerDelaySecond。
  REMOTE_NANO_SET_TRIGGER_DELAYTIME: 190,
  REMOTE_NANO_PUB_TRIGGER_DELAYTIME: 191,

  // Face radar sensitivity — 出典: SesameProtocols.kt:50
  // SSM_OS3_RADAR_PARAM_SET(200u) / SSM_OS3_RADAR_PARAM_PUBLISH(201u)。
  // 送信(200): raw payload Buffer をそのまま。受信(201 publish): payload を生で渡す。
  SSM_OS3_RADAR_PARAM_SET: 200,
  SSM_OS3_RADAR_PARAM_PUBLISH: 201,

  // OS3 デバイス共通の電池/サポート/設定/制御コマンド — 出典: SesameProtocols.kt:51-52
  // SSM3_ITEM_CODE_BATTERY_VOLTAGE(202u): 電池電圧 publish (生体デバイス)。
  //   CHSesameBiometricDeviceImpl.kt:185-187 で reportBatteryData(payload.toHexString()) に渡す
  //   (payload 全体を hex 化してサーバへ post する)。kit は publish を delegate へ素通しする。
  // SSM3_ITEM_CODE_SESAME_UNSUPPORT(204u): 子鍵スロットが非サポートの publish。
  //   CHSesameBiometricDeviceImpl.kt:189-192 で ssm2KeysMap.setSupport(false) を呼ぶ。
  //   kit は support=false を delegate へ通知する。
  // SS3_ITEM_CODE_SET_ADV_PRODUCT_TYPE(205u): LOCK5 のアドバタイズ productType を書き換える
  //   (CHSesame5Device.kt:85-94)。送信 payload = data(任意 ByteArray) をそのまま。
  // SSM3_ITEM_CODE_BLE_TX_POWER_SETTING(206u): BLE 送信出力を設定する
  //   (CHSesameOS3LockBase.kt:62-71 / CHSesameBiometricDeviceImpl.kt:194-197)。送信 payload =
  //   [txPower(符号付き 1B)]。publish 受信 (CHSesameOS3LockBase.kt:229-231 /
  //   CHSesameBiometricDeviceImpl.kt:194-197) では payload[0] が現値。
  SSM3_ITEM_CODE_BATTERY_VOLTAGE: 202,
  SSM3_ITEM_CODE_SESAME_UNSUPPORT: 204,
  SS3_ITEM_CODE_SET_ADV_PRODUCT_TYPE: 205,
  SSM3_ITEM_CODE_BLE_TX_POWER_SETTING: 206,
});

// ============================ UNVERIFIED_ITEM_CODES ============================
// 一次ソース (Android SDK SesameProtocols.kt) に **存在しない** 番号。「SesameProtocols.kt と 1:1」
// という ITEM_CODES の宣言を守るため、ここに隔離する。確証 (iOS SDK 等の別一次ソース or 実機
// キャプチャ) が得られたら ITEM_CODES へ昇格、得られない場合は機能ごと削除を検討する (§9 V6)。
export const UNVERIFIED_ITEM_CODES = Object.freeze({
  // Hub3 LTE の接続種別 publish: [isWifiConnected 1B][isLTEConnected 1B] (各 1=接続) — と推定。
  // 出典: Android SDK に存在しない。SesameItemCode enum は 208 (HUB3_ITEM_CODE_RELAY_SWITCH) で
  //   終端し (SesameProtocols.kt:32-53)、CHHub3Device.kt の onGattSesamePublish にも 209 の
  //   ハンドラは無い。biz3 web の native ブリッジ挙動 (requestNetworkType → onNetworkType で
  //   {isWifiConnected, isLTEConnected} が返る。references_web/src/components/MobileWifiModule.js:219-235)
  //   からの **推定** であり、BLE itemCode 値・payload 配置 ([wifi 1B][lte 1B]) の一次ソースは無い。
  // @experimental 実機未検証 (§9 V6)。
  HUB3_ITEM_CODE_NETWORK_TYPE: 209,
});

// WM2 (Wi-Fi Module 2) 専用アクションコード。
// SesameItemCode とは別 enum で、数値空間が重複する (例: 3=UPDATE_WIFI_SSID は
// SesameItemCode の USER とは無関係)。混同を避けるため別オブジェクトに隔離する。
// WM2 への BLE 命令は SesameOS3Payload(cmdItCode, payload) として送られ、
// cmdItCode にこの値が入る。値は CHWifiModule2Device.kt:539-540 (WM2ActionCode) と 1:1。
export const WM2_ACTION_CODES = Object.freeze({
  CODE_NON: 0,
  REGISTER_WM2: 1,            // EccKey 公開鍵を渡して WM2 を登録
  LOGIN_WM2: 2,              // loginTag で WM2 にログイン
  UPDATE_WIFI_SSID: 3,       // payload = SSID 文字列の UTF-8 bytes
  UPDATE_WIFI_PASSWORD: 4,   // payload = パスワード文字列の UTF-8 bytes
  CONNECT_WIFI: 5,           // payload = verification。設定済み SSID/PASSWORD で接続開始
  NETWORK_STATUS: 6,         // 接続状態の publish (payload[0] が状態コード)
  DELETE_SESAME: 7,          // payload = sesameKeyTag (大文字 UTF-8)
  ADD_SESAME: 8,             // payload = allKey。子 Sesame の鍵を WM2 に登録
  INITIAL: 13,               // 初期化/ハンドシェイク
  CCCD: 14,
  SESAME_KEYS: 16,           // WM2 が保持する子 Sesame 鍵の push 通知
  RESET_WM2: 18,             // WM2 を工場出荷状態へ
  SCAN_WIFI_SSID: 19,        // 周辺 SSID のスキャン (結果は publish)
  OPEN_OTA_SERVER: 126,      // BLE OTA 開始。進捗は payload.first() で onOTAProgress
  VERSION_TAG: 127,          // WM2 ファームウェアの versionTag 取得
});

// StpItemCode (生体・アクセス制御デバイスの分割転送 batchAdd 専用)。
// SesameItemCode とは別 enum で、数値空間が重複しうる (例: 182 は SesameItemCode の
// いずれとも無関係)。WM2_ACTION_CODES と同様、混同を避けるため別オブジェクトに隔離する。
// card/passcode の batchAdd は SesameItemCode ではなくこの cmdItCode で 209B ずつ送る。
// 値の出典: SesameProtocols.kt:65-67 (internal enum class StpItemCode(val value: UByte))。
export const STP_ITEM_CODES = Object.freeze({
  STP_ITEM_CODE_CARDS_ADD: 182,       // card の一括登録 (分割転送)
  STP_ITEM_CODE_CARDS_DELETE: 183,    // card の一括削除
  STP_ITEM_CODE_PASSCODES_ADD: 184,   // passcode の一括登録 (分割転送)
  STP_ITEM_CODE_PASSCODES_DELETE: 185, // passcode の一括削除
});

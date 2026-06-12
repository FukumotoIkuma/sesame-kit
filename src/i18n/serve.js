// serve レイヤ (cli/serve.js, serve/jsonrpc.js, serve/daemon.js, serve/registry.js,
// serve/framing/*) のユーザ向けメッセージ。
export default {
  en: {
    // ---- cli/serve.js ----
    "serve.invalidPort": "invalid port: {v}",
    "serve.cmd.desc": "Resident JSON-RPC backend (exposes all features to other languages over stdio/UDS/HTTP/WS/gRPC)",
    "serve.opt.stdio": "NDJSON JSON-RPC over stdin/stdout (embed: parent spawns as a child process)",
    "serve.opt.socket": "Unix domain socket (default ~/.config/sesame-kit/sesame.sock when omitted)",
    "serve.opt.noSocket": "Disable UDS",
    "serve.opt.http": "Listen for HTTP(+SSE) (default {port})",
    "serve.opt.ws": "Listen for WebSocket (default {port})",
    "serve.opt.grpc": "Listen for gRPC (default {port})",
    "serve.opt.bind": "TCP bind address",
    "serve.opt.token": "loopback token for HTTP/WS/gRPC (generated and shown when omitted)",
    "serve.opt.cors": "enable CORS for HTTP (comma-separated allowed origins, or '*'). Off by default",
    "serve.noFraming": "no framing selected. Pick at least one: --stdio / --socket / --http / --ws / --grpc (or run `sesame serve` with no args for the default UDS)",
    "serve.note.cors": "CORS enabled for HTTP origins: {origins}",
    "serve.help.after": `
If unsure: start with no args (UDS) and use \`sesame rpc\` from another terminal (no JSON to write).
  sesame serve                         # UDS (default. most portable)
  sesame rpc                           #   → list all methods and params
  sesame rpc lock.unlock --params '{"name":"front"}'
  sesame rpc --subscribe lockState     #   → keep printing lock-state changes

Pick at least one framing. The exposed methods are identical on all of them.
  sesame serve --stdio                 # embed (Python/Go spawn as a child process)
  sesame serve --http 8080             # browser/all languages. open http://… in a browser for usage
  sesame serve --ws 8081 --grpc 50051  # full-duplex / typed stubs

Connection info for other languages: sesame rpc --paths   (socket / token paths as JSON)
Log in with the CLI beforehand: sesame login <email>`,
    "serve.rpc.desc": "Send JSON-RPC to a running `sesame serve` (UDS). Omit method to list all methods",
    "serve.rpc.opt.params": "pass params as JSON (e.g. '{\"name\":\"front\"}')",
    "serve.rpc.opt.socket": "UDS path (default when omitted)",
    "serve.rpc.opt.subscribe": "subscribe to events (e.g. lockState,deviceUpdate). Ctrl-C to stop",
    "serve.rpc.opt.paths": "print connection info (socket / token paths) as JSON (for other-language clients)",
    "serve.rpc.opt.http": "target an HTTP `serve --http` instead of UDS (default URL http://127.0.0.1:8080)",
    "serve.rpc.opt.token": "Bearer token for --http (default: read from serve.token)",
    "serve.rpc.help.after": `
Examples:
  sesame rpc                                  # list all methods and params
  sesame rpc status
  sesame rpc lock.unlock --params '{"name":"front"}'
  sesame rpc --subscribe lockState            # keep printing lock-state changes
  sesame rpc --http status                     # talk to a running serve --http
  sesame rpc --paths                          # connection info for other languages as JSON`,
    "serve.subscribed": "[subscribed] {topics} — Ctrl-C to stop",
    "serve.notRunning": "sesame serve is not running (socket: {socketPath}). Run `sesame serve` in another terminal",
    "serve.httpNotRunning": "cannot reach sesame serve over HTTP at {url}. Start it with `sesame serve --http`",
    "serve.httpUnauthorized": "HTTP 401: bad or missing token. Pass --token or start `sesame serve --http` (token saved to serve.token)",
    "serve.subscribeHttpUnsupported": "--subscribe over --http is not supported here; use SSE: curl -N -H 'Authorization: Bearer <token>' '{url}/events?topics={topics}'",
    "serve.rpcTimeout": "rpc timeout",
    "serve.badParamsJson": "Error: --params is not valid JSON: {message}",
    "serve.rpcEventsPersistent": "events.subscribe/unsubscribe requires a persistent stream. Use `sesame rpc --subscribe lockState` or SSE / WebSocket / gRPC Subscribe.",
    "serve.hint.notLoggedIn": "Hint: not logged in / token expired. Run `sesame login <email>` and restart the daemon",
    "serve.discoverFooter": "\n{count} methods. e.g.: sesame rpc lock.unlock --params '{\"name\":\"front\"}'",
    "serve.note.shuttingDown": "shutting down ({reason})...",
    "serve.note.watchdog": "shutdown watchdog: forcing exit",
    "serve.note.stdioReady": "stdio framing ready (NDJSON JSON-RPC on stdin/stdout)",
    "serve.note.unixSocket": "unix socket: {path}",
    "serve.note.socketTest": "  quick test: printf '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"rpc.discover\"}\\n' | nc -U {path} | head -c 200",
    "serve.note.http": "http: {url}  (open in a browser for usage. POST /rpc, GET /events)",
    "serve.note.ws": "ws: {url}  (auth via Authorization: Bearer. browser only ?token=<token>)",
    "serve.note.wsTest": "  quick test: wscat -c \"{url}?token=<token>\"  (npm i -g wscat)",
    "serve.note.grpc": "grpc: {bind}:{port}  (typed. advanced. proto: src/serve/sesame.proto)",
    "serve.note.token": "token: {token}",
    "serve.note.tokenUse": "  use as: Authorization: Bearer {token}",
    "serve.note.tokenSaved": "  saved to: {tokenFile}",
    "serve.note.tokenNoFile": "token: {token}  (Authorization: Bearer <token> required)",
    "serve.note.bindWarn": "WARNING: --bind {bind} exposes lock control on the network.",
    "serve.note.bindWarn2": "  HTTP/WS/gRPC are all plaintext without TLS. Both the token and lock-control commands",
    "serve.note.bindWarn3": "  can be sniffed/replayed, so limit LAN exposure to VPN / SSH tunnel / TLS reverse proxy,",
    "serve.note.bindWarn4": "  and restrict source addresses with a firewall (the token alone is useless against plaintext sniffing).",
    "serve.note.ready": "ready. (if not logged in, check the cloud connect failure above and run `sesame login`. Ctrl-C to stop)",
    "serve.note.uncaught": "uncaughtException:",
    "serve.note.unhandled": "unhandledRejection (ignored):",
    "serve.note.tooManyRej": "too many unhandled rejections in 60s — exiting",

    // ---- serve/jsonrpc.js ----
    "serve.parseError": "Parse error (send one JSON per line; pretty-print not allowed)",
    "serve.batchUnsupported": "Batch requests are not supported",
    "serve.invalidRequest": "Invalid Request",
    "serve.internal": "internal",
    "serve.internalError": "internal error",

    // ---- serve/daemon.js ----
    "serve.hubRequired": "hub required",
    "serve.connectFailed": "[serve] cloud connect failed ({authState}): {detail}",
    "serve.methodNotFound": "Method not found: {method}",
    "serve.paramsMustBeObject": "params must be an object",
    "serve.connNotRegistered": "connection not registered",
    "serve.refreshAccountFailed": "[serve] refreshAccount failed (companyID injection keeps the config default): {detail}",

    // ---- serve/registry.js ----
    "serve.missingParam": "missing required param: {k}",
    "serve.notAuthenticated": "not authenticated — run: sesame login <email>  (then restart the daemon)",
    "serve.cloudNotConnected": "cloud not connected",
    "serve.desc.lockNameParam": "lock name in config (not needed when deviceUUID is given)",
    "serve.desc.deviceUUIDParam": "deviceUUID to specify directly",
    "serve.desc.secretKeyParam": "32-hex shared key when deviceUUID is given",
    "serve.desc.lockScriptIndex": "Bot2/Bot3 script number 0..9 to run (omit = click the selected script)",
    "serve.sum.rpcDiscover": "machine-readable OpenRPC description of this daemon",
    "serve.result.openrpc": "OpenRPC document",
    "serve.sum.status": "daemon status (connection/auth/user/contract version)",
    "serve.sum.cloudPing": "verify cloud liveness with one biz3KeepAlive round-trip",
    "serve.sum.whoami": "logged-in user info (biz3GetLoginUser)",
    "serve.result.customerInfo": "customerInfo etc.",
    "serve.sum.lockLock": "lock",
    "serve.sum.lockUnlock": "unlock",
    "serve.sum.lockToggle": "toggle",
    "serve.sum.lockClick": "Bot click",
    "serve.sum.lockSetAutolock": "set autolock seconds. transport:\"cloud\" (default) is unverified on real hardware (ack only); transport:\"ble\" sends ItemCode 11 over BLE and is the reliable path",
    "serve.desc.autolockSeconds": "0..65535 (0 = disable)",
    "serve.desc.autolockTransport": "\"cloud\" (default; unverified on real hardware) or \"ble\" (reliable; needs deviceUUID/secretKey/model)",
    "serve.badAutolockTransport": "unknown transport: {transport} (use \"cloud\" or \"ble\")",
    "serve.result.statePush": "state push",
    "serve.sum.lockStatus": "current device state (lock state/battery)",
    "serve.desc.targetDeviceUUID": "target deviceUUID",
    "serve.sum.accessRegisterCards": "[experimental] register read IC cards to the cloud DB (per-record updateCardName)",
    "serve.desc.registerCardsCards": "card records to register: [{cardID, cardName, cardType, nameUUID?}, ...] (nameUUID = firmware-assigned, from BLE enroll)",
    "serve.sum.accessRegisterPasscodes": "[experimental] register read passcodes to the cloud DB (postPasscodes; symmetric with access.registerCards)",
    "serve.desc.registerPasscodesRecords": "passcode records to register: [{cardID|passwordID, cardName|name, nameUUID?}, ...] (nameUUID = firmware-assigned, from BLE enroll)",
    "serve.sum.accessPostAuthData": "Kotlin SDK biometric credential sync: postAuthenticationData",
    "serve.sum.accessPutAuthData": "Kotlin SDK biometric credential sync: putAuthenticationData",
    "serve.sum.accessDeleteAuthData": "Kotlin SDK biometric credential sync: deleteAuthenticationData",
    "serve.sum.accessUpdateAuthName": "Kotlin SDK biometric credential sync: updateAuthenticationName",
    "serve.sum.devicesList": "all SESAME devices (includes secretKey)",
    "serve.sum.devicesUserList": "personal user device list (biz3 getUserDevice)",
    "serve.sum.devicesAdd": "add devices to the company (biz3ManageDevice/add; items = QR-derived key objects)",
    "serve.sum.devicesReorder": "reorder company devices (biz3ManageDevice/reorderDevices; rank = -index is assigned)",
    "serve.sum.devicesNotifyStatus": "per-device push-notification settings (biz3ManageDevice/notifyList)",
    "serve.sum.devicesNotifyManage": "switch push notification for one device (biz3ManageDevice/notifyManage)",
    "serve.desc.enablePush": "1/0 or boolean",
    "serve.sum.devicesSwitchRecharge": "switch rechargeable-battery mode (biz3ManageDevice/switchRecharge)",
    "serve.sum.deviceRename": "rename a device",
    "serve.sum.deviceDelete": "delete a device from the company",
    "serve.sum.firmwareList": "available firmware list",
    "serve.sum.configSyncLocks": "[experimental] import locks from the device list into the daemon config (writes config.json)",
    "serve.sum.configSyncHub3s": "[experimental] import Hub3s from the device list into the daemon config (writes config.json)",
    "serve.sum.configSyncRemotes": "[experimental] import Hub3s + IR remotes from the device list into the daemon config (writes config.json)",
    "serve.sum.configSyncRemoteKeys": "[experimental] fetch one remote's keys from the server and write them back to the daemon config",
    "serve.desc.syncPrune": "also remove config entries that no longer exist in the device list",
    "serve.desc.syncRemoteName": "remote name in config (default remote when omitted)",
    "serve.configStoreRequired": "{op} requires the daemon to own a ConfigStore (started from `sesame serve`); this daemon was built without one",
    "serve.sum.deviceHistory": "open/close history",
    "serve.sum.deviceBattery": "battery history",
    "serve.sum.deviceHideHistory": "hide (soft-delete) one open/close history entry",
    "serve.sum.deviceHideBattery": "hide (soft-delete) one battery history entry",
    "serve.desc.historyTimestamp": "timestamp of the history record to hide (from device.history)",
    "serve.desc.batteryTimestamp": "ts (second) of the battery record to hide (from device.battery)",
    "serve.desc.historyLastKey": "paging cursor: timestamp of the last record of the previous page (DeviceHistory.js:37-44)",
    "serve.desc.batteryLastEvaluatedKey": "paging cursor: lastEvaluatedKey object returned by the previous device.battery page",
    "serve.desc.devicesAddItems": "QR-derived device key objects to add (biz3ManageDevice/add items)",
    "serve.desc.devicesReorderItems": "device objects in the desired order (rank = -index is assigned)",
    "serve.desc.pushToken": "mobile push token (FCM etc.; carried in the biz3 notify frame)",
    "serve.desc.irDeviceType": "IR remote type (irRemote.type, e.g. 49152=AC)",
    "serve.desc.matterCmdOn": "ON command HEX emitted when Matter switches the device on",
    "serve.desc.matterCmdOff": "OFF command HEX emitted when Matter switches the device off",
    "serve.sum.webapiInvoke": "call a biz3 WebAPI proxy function (apiKeyId from config when omitted)",
    "serve.desc.webapiFunc": "WebAPI function name",
    "serve.desc.webapiQuery": "query object (optional)",
    "serve.desc.webapiBody": "request body object (optional)",
    "serve.desc.webapiApiKeyId": "API key id (falls back to config apiKeyId)",
    "serve.sum.webapiDeviceState": "WebAPI proxy: device shadow state",
    "serve.sum.webapiDeviceHistory": "WebAPI proxy: device history",
    "serve.sum.webapiSendCmd": "WebAPI proxy: send a lock command",
    "serve.sum.irSend": "send an IR remote key",
    "serve.desc.irRemote": "remote name (default when omitted)",
    "serve.desc.irKey": "key name or keyUUID",
    "serve.result.sendResponse": "send response",
    "serve.sum.irListKeys": "learned keys of a remote (config name, or direct hub3DeviceId+irDeviceUUID)",
    "serve.desc.irListKeysHub3DeviceId": "direct target: Hub3 deviceUUID (config-independent; pass together with irDeviceUUID)",
    "serve.desc.irListKeysIrDeviceUUID": "direct target: IR remote UUID (config-independent; pass together with hub3DeviceId)",
    "serve.sum.irLearn": "learn one IR key into a configured remote",
    "serve.sum.irListRemotes": "list registered IR remotes by type",
    "serve.sum.irSearchRemotes": "search preset IR remotes",
    "serve.sum.irAddRemote": "add an IR remote object on the server",
    "serve.sum.irDeleteRemote": "delete a configured IR remote on the server",
    "serve.sum.irRenameRemote": "rename an IR remote alias",
    "serve.sum.irDeleteKey": "delete one IR key",
    "serve.sum.irRenameKey": "rename one IR key",
    "serve.sum.irGetMode": "get Hub3 IR mode",
    "serve.sum.irSetMode": "set Hub3 IR mode",
    "serve.sum.irMatchRemote": "match learned IR data against preset remotes",
    "serve.sum.irAddRemoteToMatter": "register an IR remote as a Matter on/off device on Hub3 (experimental, untested on real hardware)",
    "serve.sum.bleInvoke": "invoke a registered OS3 BLE operation through the daemon host Bluetooth adapter",
    "serve.sum.bleGenericOp": "[experimental] BLE op {op} (auto-generated typed wrapper; not yet confirmed against real hardware)",
    "serve.sum.bleRegister": "register a factory-reset OS3 BLE device through the daemon host Bluetooth adapter",
    "serve.sum.bleOs2Invoke": "invoke a registered OS2 BLE operation through the daemon host Bluetooth adapter",
    "serve.sum.bleOs2Register": "register a factory-reset OS2 BLE device through the daemon host Bluetooth adapter",
    "serve.sum.eventsSubscribe": "subscribe to events (topics: {topics}). event.<topic> notifications follow",
    "serve.desc.subscribeTopics": "topic array to subscribe ({topics})",
    "serve.eventsNeedPersistent": "events.* requires a persistent connection (UDS/WebSocket/SSE/gRPC Subscribe). HTTP POST /rpc and gRPC Invoke cannot subscribe",
    "serve.unknownTopics": "unknown topic(s): {topics}",
    "serve.sum.eventsUnsubscribe": "unsubscribe from events",
    "serve.sum.nsOp": "{op} of {ns} (auto-exposed)",
    "serve.desc.nsParams": "pass the biz3 op params as-is",
    // ---- ble.* 専用 RPC (P4-1 段階2 / P1-7) ----
    // P1-7 (R2:SURF-25): ble.scan — 近接 SESAME 発見一覧 (鍵不要)
    "serve.sum.bleScan": "[experimental] scan for nearby SESAME devices over BLE (no key required; returns deviceUUID/model/kind/isRegistered/rssi per device)",
    "serve.desc.bleScanTimeoutMs": "scan duration in ms (default: transport default ~8000)",
    "serve.desc.bleScanIncludeUnknown": "include devices whose productType is not recognized (default: false)",
    "serve.sum.bleUpdateFirmware": "start BLE firmware update (WM2: OPEN_OTA_SERVER / Hub3: MOVE_TO / OS3 locks: no command sent, SDK no-op path)",
    "serve.sum.bleReset": "factory-reset an OS3 device over BLE (destructive: invalidates its keys)",
    "serve.sum.blePosition": "configure lock/unlock angles over BLE (configureLockPosition; OS3 Sesame5/6-family locks)",
    "serve.sum.bleWifiScan": "scan nearby Wi-Fi SSIDs via WM2/Hub3 BLE (kind auto-detected from model)",
    "serve.sum.bleWifiSetSsid": "set Wi-Fi SSID via WM2/Hub3 BLE (kind auto-detected from model)",
    "serve.sum.bleWifiSetPassword": "set Wi-Fi password via WM2/Hub3 BLE (kind auto-detected from model)",
    "serve.sum.bleWifiConnect": "connect WM2 to the configured Wi-Fi (CONNECT_WIFI; WM2 only)",
    "serve.desc.bleModelWifi": "device model (required: decides WM2 [dedicated GATT] vs Hub3 command set)",
    "serve.desc.bleCompanyId": "WM2 connect verification companyId (default: API_GATEWAY_CLIENT_ID from app.properties)",
    "serve.desc.bleCollectMs": "how long to collect publishes in ms (default 8000; Hub3 Wi-Fi scan finishes early on the SSID_LAST marker)",
    // P1-8 (R2:SURF-26 + R2:SURF-39): 生体一覧専用収集ハンドラ
    "serve.sum.bleBioListGet": "[experimental] retrieve the registered {type} list over BLE (collectBiometricList: GET → FIRST→NOTIFY×N→LAST publish collection)",
    "serve.desc.blePositionLock": "lock angle (signed 16-bit integer)",
    "serve.desc.blePositionUnlock": "unlock angle (signed 16-bit integer)",
    "serve.bleWifiNotSupported": "{label} has no Wi-Fi provisioning over BLE (WM2/Hub3 only; check the model param)",
    "serve.bleWifiConnectWm2Only": "ble.wifi.connect exists only on WM2 (CONNECT_WIFI); Hub3 applies SSID/password on its own",
    "serve.result.opResponse": "op response",
    "serve.openrpc.description": "Language-agnostic JSON-RPC backend for SESAME control",
    "serve.event.lockState": "lock state change push (events.subscribe lockState)",
    "serve.event.deviceUpdate": "device state update push (events.subscribe deviceUpdate)",
    "serve.event.deviceListChanged": "device-list change push (key sharing / device add-remove; biz3 pubUserDeviceChange)",
    "serve.event.ready": "connection-ready notification sent once on every persistent connection (stdio/socket/ws/SSE/gRPC Subscribe)",

    // ---- serve/framing/http.js ----
    "serve.http.usage": `sesame serve is running (JSON-RPC 2.0).

Endpoints (Authorization: Bearer <token> required):
  POST /rpc     - send one JSON-RPC request, get one response
  GET  /events  - SSE event stream (?topics=lockState,deviceUpdate)

The token was printed to stderr when the daemon started.
List all methods:
  curl -s -H "Authorization: Bearer <token>" \\
    -d '{"jsonrpc":"2.0","id":1,"method":"rpc.discover"}' http://{bind}:{port}/rpc

Watch events (SSE):
  curl -N -H "Authorization: Bearer <token>" "http://{bind}:{port}/events?topics=lockState"
`,
    "serve.http.unauthorized": "unauthorized: send Authorization: Bearer <token> (the token is printed to stderr when serve starts)",
    "serve.http.payloadTooLarge": "payload too large",
    "serve.http.unknownTopics": "unknown topic(s): {topics}",
    "serve.http.notFound": "not found",

    // ---- serve/framing/socket.js ----
    "serve.socket.alreadyRunning": "already running (live socket at {socketPath})",

    // ---- serve/framing/ws.js ----
    "serve.ws.unauthorized": "unauthorized",

    // ---- serve/framing/grpc.js ----
    "serve.grpc.unauthorized": "unauthorized",
    "serve.grpc.fieldMustBeJson": "field \"{f}\" must be JSON",
    "serve.grpc.unknownTopics": "unknown topic(s): {topics}",
    "serve.grpc.missingDeps": "gRPC framing needs optional packages that are not installed. Run `npm i @grpc/grpc-js @grpc/proto-loader` to enable --grpc.",
  },
  ja: {
    // ---- cli/serve.js ----
    "serve.invalidPort": "invalid port: {v}",
    "serve.cmd.desc": "常駐 JSON-RPC バックエンド (stdio/UDS/HTTP/WS/gRPC で cloud/Biz3 RPC と BLE op を他言語へ公開)",
    "serve.opt.stdio": "stdin/stdout で NDJSON JSON-RPC (埋め込み: 親が子プロセスとして spawn)",
    "serve.opt.socket": "Unix domain socket (省略時 ~/.config/sesame-kit/sesame.sock)",
    "serve.opt.noSocket": "UDS を無効化",
    "serve.opt.http": "HTTP(+SSE) を listen (既定 {port})",
    "serve.opt.ws": "WebSocket を listen (既定 {port})",
    "serve.opt.grpc": "gRPC を listen (既定 {port})",
    "serve.opt.bind": "TCP バインドアドレス",
    "serve.opt.token": "HTTP/WS/gRPC 用の loopback token (省略時は生成して表示)",
    "serve.opt.cors": "HTTP の CORS を有効化 (カンマ区切りの許可 origin、または '*')。既定は無効",
    "serve.noFraming": "フレーミングが 1 つも選ばれていません。最低 1 つ選んでください: --stdio / --socket / --http / --ws / --grpc (既定の UDS なら引数なしで `sesame serve`)",
    "serve.note.cors": "HTTP の CORS を有効化 (許可 origin: {origins})",
    "serve.help.after": `
迷ったら: 引数なしで起動 (UDS) し、別端末で \`sesame rpc\` を使うのが最速 (JSON を書かずに済む)。
  sesame serve                         # UDS (既定。最も移植性が高い)
  sesame rpc                           #   → 全メソッドと引数を一覧
  sesame rpc lock.unlock --params '{"name":"front"}'
  sesame rpc --subscribe lockState     #   → 鍵状態の変化を表示し続ける

フレーミングは 1 つ以上選ぶ。公開メソッドはどれでも同一。
  sesame serve --stdio                 # 埋め込み (Python/Go が子プロセスとして spawn)
  sesame serve --http 8080             # ブラウザ/全言語。http://… をブラウザで開くと使い方が出る
  sesame serve --ws 8081 --grpc 50051  # 全二重 / 型付きスタブ

他言語から繋ぐ接続情報: sesame rpc --paths   (socket / token のパスを JSON で)
事前に CLI でログインしておくこと: sesame login <email>`,
    "serve.rpc.desc": "起動中の `sesame serve` に JSON-RPC を送る (UDS)。method 省略で全メソッド一覧",
    "serve.rpc.opt.params": "params を JSON で渡す (例: '{\"name\":\"front\"}')",
    "serve.rpc.opt.socket": "UDS パス (省略時は既定)",
    "serve.rpc.opt.subscribe": "イベント購読 (例: lockState,deviceUpdate)。Ctrl-C で停止",
    "serve.rpc.opt.paths": "接続情報 (socket / token のパス) を JSON 出力 (他言語クライアント用)",
    "serve.rpc.opt.http": "UDS でなく HTTP の `serve --http` に繋ぐ (既定 URL http://127.0.0.1:8080)",
    "serve.rpc.opt.token": "--http 用の Bearer トークン (既定: serve.token から読む)",
    "serve.rpc.help.after": `
例:
  sesame rpc                                  # 全メソッドと引数を一覧
  sesame rpc status
  sesame rpc lock.unlock --params '{"name":"front"}'
  sesame rpc --subscribe lockState            # 鍵状態の変化を表示し続ける
  sesame rpc --http status                     # 起動中の serve --http に繋ぐ
  sesame rpc --paths                          # 他言語から繋ぐ接続情報を JSON で`,
    "serve.subscribed": "[subscribed] {topics} — Ctrl-C で停止",
    "serve.notRunning": "sesame serve が起動していません (socket: {socketPath})。別ターミナルで `sesame serve` を実行してください",
    "serve.httpNotRunning": "HTTP {url} の sesame serve に到達できません。`sesame serve --http` で起動してください",
    "serve.httpUnauthorized": "HTTP 401: トークンが不正/未指定です。--token を渡すか `sesame serve --http` を起動してください (token は serve.token に保存)",
    "serve.subscribeHttpUnsupported": "--http での --subscribe は未対応です。SSE を使ってください: curl -N -H 'Authorization: Bearer <token>' '{url}/events?topics={topics}'",
    "serve.rpcTimeout": "rpc timeout",
    "serve.badParamsJson": "Error: --params が不正な JSON: {message}",
    "serve.rpcEventsPersistent": "events.subscribe/unsubscribe には永続ストリームが必要です。`sesame rpc --subscribe lockState` または SSE / WebSocket / gRPC Subscribe を使ってください。",
    "serve.hint.notLoggedIn": "Hint: 未ログイン/失効です。`sesame login <email>` 後にデーモンを再起動してください",
    "serve.discoverFooter": "\n{count} methods. 例: sesame rpc lock.unlock --params '{\"name\":\"front\"}'",
    "serve.note.shuttingDown": "shutting down ({reason})...",
    "serve.note.watchdog": "shutdown watchdog: forcing exit",
    "serve.note.stdioReady": "stdio framing ready (NDJSON JSON-RPC on stdin/stdout)",
    "serve.note.unixSocket": "unix socket: {path}",
    "serve.note.socketTest": "  quick test: printf '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"rpc.discover\"}\\n' | nc -U {path} | head -c 200",
    "serve.note.http": "http: {url}  (ブラウザで開くと使い方。POST /rpc, GET /events)",
    "serve.note.ws": "ws: {url}  (認証は Authorization: Bearer。ブラウザのみ ?token=<token>)",
    "serve.note.wsTest": "  quick test: wscat -c \"{url}?token=<token>\"  (npm i -g wscat)",
    "serve.note.grpc": "grpc: {bind}:{port}  (型付き。上級者向け。proto: src/serve/sesame.proto)",
    "serve.note.token": "token: {token}",
    "serve.note.tokenUse": "  use as: Authorization: Bearer {token}",
    "serve.note.tokenSaved": "  saved to: {tokenFile}",
    "serve.note.tokenNoFile": "token: {token}  (Authorization: Bearer <token> 必須)",
    "serve.note.bindWarn": "WARNING: --bind {bind} はロック制御をネットワークに公開します。",
    "serve.note.bindWarn2": "  HTTP/WS/gRPC はいずれも TLS なしの平文です。token もロック制御コマンドも",
    "serve.note.bindWarn3": "  盗聴・リプレイ可能なので、LAN 公開は VPN / SSH トンネル / TLS リバースプロキシ越しに限定し、",
    "serve.note.bindWarn4": "  ファイアウォールで接続元を絞ること (token があるだけでは平文盗聴に無力)。",
    "serve.note.ready": "ready. (未ログインなら上の cloud connect 失敗を確認し `sesame login` を実行。Ctrl-C で停止)",
    "serve.note.uncaught": "uncaughtException:",
    "serve.note.unhandled": "unhandledRejection (ignored):",
    "serve.note.tooManyRej": "too many unhandled rejections in 60s — exiting",

    // ---- serve/jsonrpc.js ----
    "serve.parseError": "Parse error (1 行 1 JSON で送ること。pretty-print 不可)",
    "serve.batchUnsupported": "Batch requests are not supported",
    "serve.invalidRequest": "Invalid Request",
    "serve.internal": "internal",
    "serve.internalError": "internal error",

    // ---- serve/daemon.js ----
    "serve.hubRequired": "hub required",
    "serve.connectFailed": "[serve] cloud connect failed ({authState}): {detail}",
    "serve.methodNotFound": "Method not found: {method}",
    "serve.paramsMustBeObject": "params must be an object",
    "serve.connNotRegistered": "connection not registered",
    "serve.refreshAccountFailed": "[serve] refreshAccount に失敗 (companyID 自動注入は config 既定値のまま継続): {detail}",

    // ---- serve/registry.js ----
    "serve.missingParam": "missing required param: {k}",
    "serve.notAuthenticated": "not authenticated — run: sesame login <email>  (then restart the daemon)",
    "serve.cloudNotConnected": "cloud not connected",
    "serve.desc.lockNameParam": "config 上のロック名 (deviceUUID 指定時は不要)",
    "serve.desc.deviceUUIDParam": "直接指定する deviceUUID",
    "serve.desc.secretKeyParam": "deviceUUID 指定時の 32hex 共通鍵",
    "serve.desc.lockScriptIndex": "実行する Bot2/Bot3 の台本番号 0..9 (省略で選択中の台本をクリック)",
    "serve.sum.rpcDiscover": "この daemon の機械可読 OpenRPC 記述",
    "serve.result.openrpc": "OpenRPC document",
    "serve.sum.status": "デーモン状態 (接続/認証/ユーザ/契約版)",
    "serve.sum.cloudPing": "biz3KeepAlive 1 往復でクラウド疎通を実検証",
    "serve.sum.whoami": "ログインユーザ情報 (biz3GetLoginUser)",
    "serve.result.customerInfo": "customerInfo 等",
    "serve.sum.lockLock": "施錠",
    "serve.sum.lockUnlock": "解錠",
    "serve.sum.lockToggle": "トグル",
    "serve.sum.lockClick": "Bot クリック",
    "serve.sum.lockSetAutolock": "オートロック秒数設定。transport:\"cloud\" (既定) は実機反映未確認 (ack のみ)。確実なのは transport:\"ble\" (ItemCode 11 を BLE 直送)",
    "serve.desc.autolockSeconds": "0..65535 (0=無効)",
    "serve.desc.autolockTransport": "\"cloud\" (既定。実機反映未確認) か \"ble\" (確実。deviceUUID/secretKey/model が必要)",
    "serve.badAutolockTransport": "未知の transport: {transport} (\"cloud\" か \"ble\")",
    "serve.result.statePush": "状態 push",
    "serve.sum.lockStatus": "デバイスの現在状態 (lock state/battery)",
    "serve.desc.targetDeviceUUID": "対象 deviceUUID",
    "serve.sum.accessRegisterCards": "[experimental] 読み取った IC カードをクラウド DB に登録 (レコード毎の updateCardName)",
    "serve.desc.registerCardsCards": "登録するカードレコード: [{cardID, cardName, cardType, nameUUID?}, ...] (nameUUID = BLE enroll で得たファーム採番値)",
    "serve.sum.accessRegisterPasscodes": "[experimental] 読み取ったパスコードをクラウド DB に登録 (postPasscodes。access.registerCards と対称)",
    "serve.desc.registerPasscodesRecords": "登録するパスコードレコード: [{cardID|passwordID, cardName|name, nameUUID?}, ...] (nameUUID = BLE enroll で得たファーム採番値)",
    "serve.sum.accessPostAuthData": "Kotlin SDK の生体クレデンシャル同期: postAuthenticationData",
    "serve.sum.accessPutAuthData": "Kotlin SDK の生体クレデンシャル同期: putAuthenticationData",
    "serve.sum.accessDeleteAuthData": "Kotlin SDK の生体クレデンシャル同期: deleteAuthenticationData",
    "serve.sum.accessUpdateAuthName": "Kotlin SDK の生体クレデンシャル同期: updateAuthenticationName",
    "serve.sum.devicesList": "全 SESAME デバイス一覧 (secretKey 含む)",
    "serve.sum.devicesUserList": "個人ユーザのデバイス一覧 (biz3 getUserDevice)",
    "serve.sum.devicesAdd": "デバイスを company に追加 (biz3ManageDevice/add。items = QR 由来キーオブジェクト)",
    "serve.sum.devicesReorder": "デバイスの並び順更新 (biz3ManageDevice/reorderDevices。rank = -index を自動採番)",
    "serve.sum.devicesNotifyStatus": "デバイスごとの push 通知設定一覧 (biz3ManageDevice/notifyList)",
    "serve.sum.devicesNotifyManage": "単機の push 通知 ON/OFF 切替 (biz3ManageDevice/notifyManage)",
    "serve.desc.enablePush": "1/0 か boolean",
    "serve.sum.devicesSwitchRecharge": "充電池モード切替 (biz3ManageDevice/switchRecharge)",
    "serve.sum.deviceRename": "デバイス名変更",
    "serve.sum.deviceDelete": "デバイスを company から削除",
    "serve.sum.firmwareList": "利用可能なファームウェア一覧",
    "serve.sum.configSyncLocks": "[experimental] デバイス一覧からロックをデーモンの config に取り込む (config.json へ書き込み)",
    "serve.sum.configSyncHub3s": "[experimental] デバイス一覧から Hub3 をデーモンの config に取り込む (config.json へ書き込み)",
    "serve.sum.configSyncRemotes": "[experimental] デバイス一覧から Hub3 + IR リモコンをデーモンの config に取り込む (config.json へ書き込み)",
    "serve.sum.configSyncRemoteKeys": "[experimental] リモコン 1 台のキー一覧を server から取得し config へ書き戻す",
    "serve.desc.syncPrune": "デバイス一覧に存在しなくなった config エントリも削除する",
    "serve.desc.syncRemoteName": "config 上のリモコン名 (省略時 default のリモコン)",
    "serve.configStoreRequired": "{op} はデーモンが ConfigStore を持つ構成 (`sesame serve` 起動) でのみ使えます。この daemon は ConfigStore なしで構築されています",
    "serve.sum.deviceHistory": "開閉履歴",
    "serve.sum.deviceBattery": "電池履歴",
    "serve.sum.deviceHideHistory": "開閉履歴の1エントリを非表示化 (論理削除)",
    "serve.sum.deviceHideBattery": "電池履歴の1エントリを非表示化 (論理削除)",
    "serve.desc.historyTimestamp": "非表示化する履歴 record の timestamp (device.history の値)",
    "serve.desc.batteryTimestamp": "非表示化する電池 record の ts 秒 (device.battery の値)",
    "serve.desc.historyLastKey": "ページングカーソル: 直前ページ末尾レコードの timestamp (DeviceHistory.js:37-44)",
    "serve.desc.batteryLastEvaluatedKey": "ページングカーソル: 前回 device.battery 応答の lastEvaluatedKey オブジェクト",
    "serve.desc.devicesAddItems": "追加する QR 由来デバイスキーオブジェクト (biz3ManageDevice/add の items)",
    "serve.desc.devicesReorderItems": "並べたい順のデバイスオブジェクト配列 (rank = -index を自動採番)",
    "serve.desc.pushToken": "モバイル push トークン (FCM 等。biz3 の notify frame に乗る)",
    "serve.desc.irDeviceType": "IR リモコン type (irRemote.type, 例 49152=エアコン)",
    "serve.desc.matterCmdOn": "Matter からの ON 操作で発射する command HEX",
    "serve.desc.matterCmdOff": "Matter からの OFF 操作で発射する command HEX",
    "serve.sum.webapiInvoke": "biz3 WebAPI proxy 関数を呼ぶ (apiKeyId 省略時は config)",
    "serve.desc.webapiFunc": "WebAPI 関数名",
    "serve.desc.webapiQuery": "query オブジェクト (任意)",
    "serve.desc.webapiBody": "リクエスト body オブジェクト (任意)",
    "serve.desc.webapiApiKeyId": "API キー id (省略時 config の apiKeyId)",
    "serve.sum.webapiDeviceState": "WebAPI proxy: デバイス shadow state",
    "serve.sum.webapiDeviceHistory": "WebAPI proxy: デバイス履歴",
    "serve.sum.webapiSendCmd": "WebAPI proxy: ロックコマンド送信",
    "serve.sum.irSend": "IR リモコンのキーを送信",
    "serve.desc.irRemote": "リモコン名 (省略時 default)",
    "serve.desc.irKey": "キー名 or keyUUID",
    "serve.result.sendResponse": "送信応答",
    "serve.sum.irListKeys": "リモコンの学習済みキー一覧 (config 名、または hub3DeviceId+irDeviceUUID 直指定)",
    "serve.desc.irListKeysHub3DeviceId": "直指定: Hub3 の deviceUUID (config 非依存。irDeviceUUID とセットで渡す)",
    "serve.desc.irListKeysIrDeviceUUID": "直指定: IR リモコンの UUID (config 非依存。hub3DeviceId とセットで渡す)",
    "serve.sum.irLearn": "設定済みリモコンへ IR キーを 1 つ学習",
    "serve.sum.irListRemotes": "登録済み IR リモコン一覧 (type 別)",
    "serve.sum.irSearchRemotes": "プリセット IR リモコン検索",
    "serve.sum.irAddRemote": "IR リモコンオブジェクトを server に追加",
    "serve.sum.irDeleteRemote": "設定済み IR リモコンを server から削除",
    "serve.sum.irRenameRemote": "IR リモコンの alias を変更",
    "serve.sum.irDeleteKey": "IR キーを 1 つ削除",
    "serve.sum.irRenameKey": "IR キーを 1 つ改名",
    "serve.sum.irGetMode": "Hub3 の IR モード取得",
    "serve.sum.irSetMode": "Hub3 の IR モード設定",
    "serve.sum.irMatchRemote": "学習波形をプリセットリモコンと照合",
    "serve.sum.irAddRemoteToMatter": "IR リモコンを Matter の on/off デバイスとして Hub3 に登録 (experimental・実機未検証)",
    "serve.sum.bleInvoke": "登録済み OS3 BLE op をデーモンホストの Bluetooth アダプタで実行",
    "serve.sum.bleGenericOp": "[experimental] BLE op {op} (型付き自動生成。実機未確認)",
    "serve.sum.bleRegister": "工場出荷状態の OS3 BLE デバイスをデーモンホストの Bluetooth アダプタで登録",
    "serve.sum.bleOs2Invoke": "登録済み OS2 BLE op をデーモンホストの Bluetooth アダプタで実行",
    "serve.sum.bleOs2Register": "工場出荷状態の OS2 BLE デバイスをデーモンホストの Bluetooth アダプタで登録",
    "serve.sum.eventsSubscribe": "イベント購読 (topics: {topics})。以後 event.<topic> 通知が届く",
    "serve.desc.subscribeTopics": "購読する topic 配列 ({topics})",
    "serve.eventsNeedPersistent": "events.* は持続接続が必要です (UDS/WebSocket/SSE/gRPC Subscribe)。HTTP POST /rpc や gRPC Invoke では購読できません",
    "serve.unknownTopics": "unknown topic(s): {topics}",
    "serve.sum.eventsUnsubscribe": "イベント購読解除",
    "serve.sum.nsOp": "{ns} の {op} (自動公開)",
    "serve.desc.nsParams": "biz3 op の params をそのまま渡す",
    // ---- ble.* 専用 RPC (P4-1 段階2 / P1-7) ----
    // P1-7 (R2:SURF-25): ble.scan — 近接 SESAME 発見一覧 (鍵不要)
    "serve.sum.bleScan": "[experimental] BLE で周辺 SESAME デバイスをスキャン (鍵不要。deviceUUID/model/kind/isRegistered/rssi を返す)",
    "serve.desc.bleScanTimeoutMs": "スキャン時間 ms (既定: transport の既定値 ~8000)",
    "serve.desc.bleScanIncludeUnknown": "productType が未知のデバイスを含める (既定: false)",
    "serve.sum.bleUpdateFirmware": "BLE ファームウェア更新を開始 (WM2: OPEN_OTA_SERVER / Hub3: MOVE_TO / OS3 ロック系: SDK 同様コマンド無送信)",
    "serve.sum.bleReset": "OS3 デバイスを BLE で工場出荷状態へ戻す (破壊的: 登録済みの鍵が無効化される)",
    "serve.sum.blePosition": "施錠/解錠角を BLE で設定 (configureLockPosition。OS3 Sesame5/6 系ロック)",
    "serve.sum.bleWifiScan": "WM2/Hub3 の BLE で周辺 Wi-Fi SSID をスキャン (種別は model から自動判別)",
    "serve.sum.bleWifiSetSsid": "WM2/Hub3 の BLE で Wi-Fi SSID を設定 (種別は model から自動判別)",
    "serve.sum.bleWifiSetPassword": "WM2/Hub3 の BLE で Wi-Fi パスワードを設定 (種別は model から自動判別)",
    "serve.sum.bleWifiConnect": "WM2 を設定済み Wi-Fi へ接続 (CONNECT_WIFI。WM2 のみ)",
    "serve.desc.bleModelWifi": "デバイス model (必須: WM2 [専用 GATT] か Hub3 かのコマンド体系を決める)",
    "serve.desc.bleCompanyId": "WM2 connect の verification に使う companyId (既定: app.properties の API_GATEWAY_CLIENT_ID)",
    "serve.desc.bleCollectMs": "publish の収集時間 ms (既定 8000。Wi-Fi Hub3 は SSID_LAST マーカーで早期確定)",
    // P1-8 (R2:SURF-26 + R2:SURF-39): 生体一覧専用収集ハンドラ
    "serve.sum.bleBioListGet": "[experimental] BLE で登録済み {type} 一覧を取得 (collectBiometricList: GET → FIRST→NOTIFY×N→LAST publish 収集)",
    "serve.desc.blePositionLock": "施錠角 (符号付き 16bit 整数)",
    "serve.desc.blePositionUnlock": "解錠角 (符号付き 16bit 整数)",
    "serve.bleWifiNotSupported": "{label} は BLE の Wi-Fi プロビジョニングを持ちません (WM2/Hub3 のみ。model param を確認してください)",
    "serve.bleWifiConnectWm2Only": "ble.wifi.connect は WM2 のみ (CONNECT_WIFI)。Hub3 は SSID/password 設定後に本体側で適用されます",
    "serve.result.opResponse": "op 応答",
    "serve.openrpc.description": "SESAME 制御の言語非依存 JSON-RPC バックエンド",
    "serve.event.lockState": "ロック状態変化 push (events.subscribe lockState)",
    "serve.event.deviceUpdate": "デバイス状態更新 push (events.subscribe deviceUpdate)",
    "serve.event.deviceListChanged": "デバイス一覧の増減 push (鍵共有・デバイス追加/削除; biz3 pubUserDeviceChange)",
    "serve.event.ready": "全 persistent connection (stdio/socket/ws/SSE/gRPC Subscribe) で接続直後に 1 回送る ready 通知",

    // ---- serve/framing/http.js ----
    "serve.http.usage": `sesame serve is running (JSON-RPC 2.0).

Endpoints (Authorization: Bearer <token> required):
  POST /rpc     - send one JSON-RPC request, get one response
  GET  /events  - SSE event stream (?topics=lockState,deviceUpdate)

The token was printed to stderr when the daemon started.
List all methods:
  curl -s -H "Authorization: Bearer <token>" \\
    -d '{"jsonrpc":"2.0","id":1,"method":"rpc.discover"}' http://{bind}:{port}/rpc

Watch events (SSE):
  curl -N -H "Authorization: Bearer <token>" "http://{bind}:{port}/events?topics=lockState"
`,
    "serve.http.unauthorized": "unauthorized: Authorization: Bearer <token> を送ってください (token は serve 起動時に stderr へ表示)",
    "serve.http.payloadTooLarge": "payload too large",
    "serve.http.unknownTopics": "unknown topic(s): {topics}",
    "serve.http.notFound": "not found",

    // ---- serve/framing/socket.js ----
    "serve.socket.alreadyRunning": "already running (live socket at {socketPath})",

    // ---- serve/framing/ws.js ----
    "serve.ws.unauthorized": "unauthorized",

    // ---- serve/framing/grpc.js ----
    "serve.grpc.unauthorized": "unauthorized",
    "serve.grpc.fieldMustBeJson": "field \"{f}\" must be JSON",
    "serve.grpc.unknownTopics": "unknown topic(s): {topics}",
    "serve.grpc.missingDeps": "gRPC フレーミングに必要な optional パッケージが未導入です。`npm i @grpc/grpc-js @grpc/proto-loader` を実行すると --grpc が使えます。",
  },
};

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
    "serve.rpc.help.after": `
Examples:
  sesame rpc                                  # list all methods and params
  sesame rpc status
  sesame rpc lock.unlock --params '{"name":"front"}'
  sesame rpc --subscribe lockState            # keep printing lock-state changes
  sesame rpc --paths                          # connection info for other languages as JSON`,
    "serve.subscribed": "[subscribed] {topics} — Ctrl-C to stop",
    "serve.notRunning": "sesame serve is not running (socket: {socketPath}). Run `sesame serve` in another terminal",
    "serve.rpcTimeout": "rpc timeout",
    "serve.badParamsJson": "Error: --params is not valid JSON: {message}",
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

    // ---- serve/registry.js ----
    "serve.missingParam": "missing required param: {k}",
    "serve.notAuthenticated": "not authenticated — run: sesame login <email>  (then restart the daemon)",
    "serve.cloudNotConnected": "cloud not connected",
    "serve.desc.lockNameParam": "lock name in config (not needed when deviceUUID is given)",
    "serve.desc.deviceUUIDParam": "deviceUUID to specify directly",
    "serve.desc.secretKeyParam": "32-hex shared key when deviceUUID is given",
    "serve.sum.status": "daemon status (connection/auth/user/contract version)",
    "serve.sum.whoami": "logged-in user info (biz3GetLoginUser)",
    "serve.result.customerInfo": "customerInfo etc.",
    "serve.sum.lockLock": "lock",
    "serve.sum.lockUnlock": "unlock",
    "serve.sum.lockToggle": "toggle",
    "serve.sum.lockClick": "Bot click",
    "serve.result.statePush": "state push",
    "serve.sum.lockStatus": "current device state (lock state/battery)",
    "serve.desc.targetDeviceUUID": "target deviceUUID",
    "serve.sum.devicesList": "all SESAME devices (includes secretKey)",
    "serve.sum.deviceHistory": "open/close history",
    "serve.sum.deviceBattery": "battery history",
    "serve.sum.irSend": "send an IR remote key",
    "serve.desc.irRemote": "remote name (default when omitted)",
    "serve.desc.irKey": "key name or keyUUID",
    "serve.result.sendResponse": "send response",
    "serve.sum.irListKeys": "learned keys of a remote",
    "serve.sum.eventsSubscribe": "subscribe to events (topics: {topics}). event.<topic> notifications follow",
    "serve.desc.subscribeTopics": "topic array to subscribe ({topics})",
    "serve.eventsNeedPersistent": "events.* requires a persistent connection (UDS/WebSocket/SSE/gRPC Subscribe). HTTP POST /rpc and gRPC Invoke cannot subscribe",
    "serve.unknownTopics": "unknown topic(s): {topics}",
    "serve.sum.eventsUnsubscribe": "unsubscribe from events",
    "serve.sum.nsOp": "{op} of {ns} (auto-exposed)",
    "serve.desc.nsParams": "pass the biz3 op params as-is",
    "serve.result.opResponse": "op response",
    "serve.openrpc.description": "Language-agnostic JSON-RPC backend for SESAME control",
    "serve.event.lockState": "lock state change push (events.subscribe lockState)",
    "serve.event.deviceUpdate": "device state update push (events.subscribe deviceUpdate)",
    "serve.event.ready": "startup-complete notification (stdio framing only. once right after connect. not sent on other transports)",

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
    "serve.http.unauthorized": "unauthorized",
    "serve.http.unauthorizedHint": "Authorization: Bearer <token> (the token is printed to stderr when serve starts)",
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
  },
  ja: {
    // ---- cli/serve.js ----
    "serve.invalidPort": "invalid port: {v}",
    "serve.cmd.desc": "常駐 JSON-RPC バックエンド (stdio/UDS/HTTP/WS/gRPC で全機能を他言語へ公開)",
    "serve.opt.stdio": "stdin/stdout で NDJSON JSON-RPC (埋め込み: 親が子プロセスとして spawn)",
    "serve.opt.socket": "Unix domain socket (省略時 ~/.config/sesame-kit/sesame.sock)",
    "serve.opt.noSocket": "UDS を無効化",
    "serve.opt.http": "HTTP(+SSE) を listen (既定 {port})",
    "serve.opt.ws": "WebSocket を listen (既定 {port})",
    "serve.opt.grpc": "gRPC を listen (既定 {port})",
    "serve.opt.bind": "TCP バインドアドレス",
    "serve.opt.token": "HTTP/WS/gRPC 用の loopback token (省略時は生成して表示)",
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
    "serve.rpc.help.after": `
例:
  sesame rpc                                  # 全メソッドと引数を一覧
  sesame rpc status
  sesame rpc lock.unlock --params '{"name":"front"}'
  sesame rpc --subscribe lockState            # 鍵状態の変化を表示し続ける
  sesame rpc --paths                          # 他言語から繋ぐ接続情報を JSON で`,
    "serve.subscribed": "[subscribed] {topics} — Ctrl-C で停止",
    "serve.notRunning": "sesame serve が起動していません (socket: {socketPath})。別ターミナルで `sesame serve` を実行してください",
    "serve.rpcTimeout": "rpc timeout",
    "serve.badParamsJson": "Error: --params が不正な JSON: {message}",
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

    // ---- serve/registry.js ----
    "serve.missingParam": "missing required param: {k}",
    "serve.notAuthenticated": "not authenticated — run: sesame login <email>  (then restart the daemon)",
    "serve.cloudNotConnected": "cloud not connected",
    "serve.desc.lockNameParam": "config 上のロック名 (deviceUUID 指定時は不要)",
    "serve.desc.deviceUUIDParam": "直接指定する deviceUUID",
    "serve.desc.secretKeyParam": "deviceUUID 指定時の 32hex 共通鍵",
    "serve.sum.status": "デーモン状態 (接続/認証/ユーザ/契約版)",
    "serve.sum.whoami": "ログインユーザ情報 (biz3GetLoginUser)",
    "serve.result.customerInfo": "customerInfo 等",
    "serve.sum.lockLock": "施錠",
    "serve.sum.lockUnlock": "解錠",
    "serve.sum.lockToggle": "トグル",
    "serve.sum.lockClick": "Bot クリック",
    "serve.result.statePush": "状態 push",
    "serve.sum.lockStatus": "デバイスの現在状態 (lock state/battery)",
    "serve.desc.targetDeviceUUID": "対象 deviceUUID",
    "serve.sum.devicesList": "全 SESAME デバイス一覧 (secretKey 含む)",
    "serve.sum.deviceHistory": "開閉履歴",
    "serve.sum.deviceBattery": "電池履歴",
    "serve.sum.irSend": "IR リモコンのキーを送信",
    "serve.desc.irRemote": "リモコン名 (省略時 default)",
    "serve.desc.irKey": "キー名 or keyUUID",
    "serve.result.sendResponse": "送信応答",
    "serve.sum.irListKeys": "リモコンの学習済みキー一覧",
    "serve.sum.eventsSubscribe": "イベント購読 (topics: {topics})。以後 event.<topic> 通知が届く",
    "serve.desc.subscribeTopics": "購読する topic 配列 ({topics})",
    "serve.eventsNeedPersistent": "events.* は持続接続が必要です (UDS/WebSocket/SSE/gRPC Subscribe)。HTTP POST /rpc や gRPC Invoke では購読できません",
    "serve.unknownTopics": "unknown topic(s): {topics}",
    "serve.sum.eventsUnsubscribe": "イベント購読解除",
    "serve.sum.nsOp": "{ns} の {op} (自動公開)",
    "serve.desc.nsParams": "biz3 op の params をそのまま渡す",
    "serve.result.opResponse": "op 応答",
    "serve.openrpc.description": "SESAME 制御の言語非依存 JSON-RPC バックエンド",
    "serve.event.lockState": "ロック状態変化 push (events.subscribe lockState)",
    "serve.event.deviceUpdate": "デバイス状態更新 push (events.subscribe deviceUpdate)",
    "serve.event.ready": "起動完了通知 (stdio framing のみ。接続直後に 1 回。他経路では飛ばない)",

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
    "serve.http.unauthorized": "unauthorized",
    "serve.http.unauthorizedHint": "Authorization: Bearer <token> (token は serve 起動時に stderr へ表示)",
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
  },
};

// Type declarations for the thin official JS client (`sesame-client.mjs`).
//
// Hand-written, zero-dependency thin client for connecting to a separately
// running `sesame serve` daemon (Node 20+). This mirrors the public surface of
// sesame-client.mjs only; it is NOT the generated sdk/ts client.
//
//   import { SesameClient } from "sesame-kit/client";
//   const c = SesameClient.unix();                 // default UDS path (POSIX)
//   console.log(await c.unlock("front"));
//   await c.subscribe(["lockState"], (topic, p) => console.log("EVENT", topic, p));
//
//   const h = SesameClient.http("http://127.0.0.1:8080"); // token from serve.token
//   const w = await SesameClient.ws("ws://127.0.0.1:8081");
//
// Failures throw SesameRpcError(message, kind, code)
// (kind: not_authenticated / connection_lost / timeout / not_implemented / bad_params /
//  rejected / internal — matches the 7 `error.data.kind` values emitted by `sesame serve`).

/** Category of a SesameRpcError. Runtime values are free-form strings; these are the known kinds
 * (the 7 kinds emitted by `sesame serve` — see src/serve/jsonrpc.js KIND. SURF-21). */
export type SesameErrorKind =
  | "not_authenticated"
  | "connection_lost"
  | "timeout"
  | "not_implemented"
  | "bad_params"
  | "rejected"
  | "internal"
  | (string & {});

/**
 * HTTP status → SesameRpcError.kind mapping (pinned by tests/fixtures/http-kind-map.json —
 * shared with sdk/ts, sdk/python and clients/python).
 * Exported for test cross-checking.
 */
export declare function httpKind(status: number): SesameErrorKind;

/** Callback invoked for each subscription event. `topic` is the event name (`event.` prefix stripped). */
export type SesameEventHandler = (topic: string, params: any) => void;

/** Error thrown by every client failure path.
 * (P5-9 / ARCH-19: renamed from `SesameError` to resolve the homonym with the core
 *  `SesameError` in src/errors.js, whose `code` is a string. Matches the sdk/ts name.) */
export declare class SesameRpcError extends Error {
  name: "SesameRpcError";
  /** Coarse failure category, e.g. "not_authenticated" / "connection_lost" / "timeout". */
  kind?: SesameErrorKind;
  /** Optional JSON-RPC / HTTP-style error code (e.g. 401, 1008), when available. */
  code?: number;
  constructor(message: string, kind?: SesameErrorKind, code?: number);
}

/**
 * @deprecated Old name. Renamed to {@link SesameRpcError} to resolve the homonym with the
 * core `SesameError` (string `code`). Kept as a backward-compatible alias for one release;
 * scheduled for removal in the next minor.
 */
export { SesameRpcError as SesameError };

/**
 * Thin client for a running `sesame serve` daemon.
 *
 * Construct via a static transport factory (`unix` / `http` / `ws`) rather than
 * the constructor directly. `ws` opens the connection and is therefore async.
 */
export declare class SesameClient {
  /** @param transport internal transport instance produced by a factory. */
  constructor(transport: unknown);

  /**
   * Connect over a Unix domain socket (POSIX only).
   * Throws SesameError("not_implemented") on Windows.
   * @param path UDS path; defaults to `$XDG_CONFIG_HOME/sesame-kit/sesame.sock`.
   */
  static unix(path?: string): SesameClient;

  /**
   * Connect over HTTP JSON-RPC. Synchronous (no connection opened until first call).
   * @param base base URL; trailing slash is stripped. Default `http://127.0.0.1:8080`.
   * @param token bearer token; defaults to the contents of `serve.token`, or null if absent.
   */
  static http(base?: string, token?: string | null): SesameClient;

  /**
   * Connect over WebSocket (full-duplex). Prefers the `ws` package (header auth);
   * falls back to the global WebSocket (URL `?token=`). Awaits the connection.
   * @param url WebSocket URL. Default `ws://127.0.0.1:8081`.
   * @param token bearer token; defaults to the contents of `serve.token`, or null if absent.
   */
  static ws(url?: string, token?: string | null): Promise<SesameClient>;

  /** Send a raw JSON-RPC request and return its `result` (throws SesameError on `error`). */
  call(method: string, params?: Record<string, any>): Promise<any>;

  /** Subscribe to topics. Always `await` this — connection/auth/bad-topic errors throw. */
  subscribe(topics: string[], onEvent: SesameEventHandler): Promise<any>;

  /** Call `rpc.discover`. */
  discover(): Promise<any>;

  /** Unlock a device (or the default device when `name` is omitted/falsy). */
  unlock(name?: string | null, kw?: Record<string, any>): Promise<any>;

  /** Lock a device (or the default device when `name` is omitted/falsy). */
  lock(name?: string | null, kw?: Record<string, any>): Promise<any>;

  /**
   * Toggle a device (or the default device when `name` is omitted/falsy).
   * P4-9 (SURF-35): added for surface symmetry with the Python client.
   */
  toggle(name?: string | null, kw?: Record<string, any>): Promise<any>;

  /** Call `status`. */
  status(): Promise<any>;

  /** Call `devices.list`. */
  devices(): Promise<any>;

  /** Close the underlying transport. */
  close(): void;
}

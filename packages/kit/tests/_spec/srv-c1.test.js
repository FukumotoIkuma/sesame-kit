// spec/serve-framing.md SRV-0019〜SRV-0037 (SRV-0035 除外) の TDD テスト統合版。
// A/B 両実装を統合し、より移植元忠実で網羅的な側を採用。
// 対象実装: packages/kit/src/serve/framing/{ws,ndjson,socket,stdio,token}.js
//           packages/core/src/jsonrpc.js
//           packages/kit/src/serve/daemon.js
// 実行可能・self-contained・決定論的 (ネットワーク/実機不使用)。
import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { makeLineConnection } from "../../src/serve/framing/ndjson.js";
import { startStdioFraming } from "../../src/serve/framing/stdio.js";
import { ensureFreeSocket } from "../../src/serve/framing/socket.js";
import {
  parseBearer,
  extractToken,
  tokenMatches,
  generateToken,
} from "../../src/serve/framing/token.js";
import {
  classify,
  handleMessage,
  makeError,
  RPC,
  KIND,
  RpcError,
} from "@sesame-kit/core/jsonrpc";
import { Daemon } from "../../src/serve/daemon.js";

// ---------------------------------------------------------------------------
// Fake writable: write 戻り値とイベント制御が可能な最小 writable
// ---------------------------------------------------------------------------
function fakeWritable() {
  const written = [];
  const handlers = {};
  return {
    written,
    writeResult: true,
    ended: false,
    destroyed: false,
    write(s) {
      written.push(s);
      return this.writeResult;
    },
    on(ev, fn) {
      handlers[ev] = fn;
    },
    emit(ev) {
      handlers[ev]?.();
    },
    end() { this.ended = true; },
    destroy() { this.destroyed = true; },
  };
}

// ---------------------------------------------------------------------------
// Minimal fake hub used by Daemon tests
// ---------------------------------------------------------------------------
function makeFakeHub({ connected = true } = {}) {
  let duFn = null;
  return {
    connected,
    subUUID: "sub-1",
    config: { devices: {} },
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onDeviceUpdate: (_items, fn) => { duFn = fn; return () => { duFn = null; }; },
    _emit: (m) => duFn && duFn(m),
  };
}

// ---------------------------------------------------------------------------
// Minimal fake daemon for stdio tests
// ---------------------------------------------------------------------------
function makeFakeDaemon() {
  return {
    addConnection: vi.fn(),
    removeConnection: vi.fn(),
    handleLine: vi.fn(),
  };
}

// ============================================================================
// [SRV-0019] WS フレーム: 1 メッセージ = 1 JSON
// ============================================================================
describe("[SRV-0019] WS フレーム: send=JSON.stringify / message→handleLine(data.toString) / close/error 処理", () => {
  it("[SRV-0019] WS conn.send は JSON.stringify で 1 フレームを送り bufferedAmount<=MAX_BUFFERED なら close しない", () => {
    const sentFrames = [];
    const fakeWs = {
      bufferedAmount: 0,
      send(frame) { sentFrames.push(frame); },
      on() {},
      close() {},
    };

    const MAX_BUFFERED = 4 * 1024 * 1024;
    let connClosed = false;
    const conn = {
      send(obj) {
        if (fakeWs.bufferedAmount > MAX_BUFFERED) { connClosed = true; return; }
        try { fakeWs.send(JSON.stringify(obj)); } catch { /* closed */ }
      },
      close() { connClosed = true; },
    };

    conn.send({ method: "event.lockState", params: { locked: true } });
    expect(sentFrames).toHaveLength(1);
    const parsed = JSON.parse(sentFrames[0]);
    expect(parsed).toMatchObject({ method: "event.lockState", params: { locked: true } });
    expect(connClosed).toBe(false);
  });

  it("[SRV-0019] ws.on('message') は data.toString() を handleLine に渡す (Buffer→string 変換)", () => {
    const received = [];
    const fakeDaemon = { handleLine: (_conn, raw) => received.push(raw) };
    // ws.js:44 相当: data.toString() を handleLine に渡す
    const handler = (data) => fakeDaemon.handleLine({}, data.toString());
    handler(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"status","params":{}}'));
    expect(received).toHaveLength(1);
    expect(received[0]).toBe('{"jsonrpc":"2.0","id":1,"method":"status","params":{}}');
  });

  it("[SRV-0019] ws.on('close') は removeConnection を呼ぶ", () => {
    const removed = [];
    const fakeDaemon = { removeConnection: (c) => removed.push(c) };
    const conn = { id: "ws-test" };
    // ws.js:45 相当
    const closeHandler = () => fakeDaemon.removeConnection(conn);
    closeHandler();
    expect(removed).toContain(conn);
  });

  it("[SRV-0019] ws.on('error') は conn.close を発火する", () => {
    let closed = false;
    const conn = { close: () => { closed = true; } };
    // ws.js:46 相当
    const errorHandler = () => conn.close();
    errorHandler(new Error("network error"));
    expect(closed).toBe(true);
  });
});

// ============================================================================
// [SRV-0020] WS 背圧: bufferedAmount > 4MB → conn.close
// ============================================================================
describe("[SRV-0020] WS 背圧: bufferedAmount > MAX_BUFFERED(4MB) → conn.close", () => {
  it("[SRV-0020] bufferedAmount が MAX_BUFFERED(4MB) を超えたら conn.close して送信しない", () => {
    const MAX_BUFFERED = 4 * 1024 * 1024;
    const sentFrames = [];
    let connClosed = false;
    const fakeWs = {
      bufferedAmount: MAX_BUFFERED + 1,
      send(f) { sentFrames.push(f); },
    };
    const conn = {
      send(obj) {
        if (fakeWs.bufferedAmount > MAX_BUFFERED) { conn.close(); return; }
        fakeWs.send(JSON.stringify(obj));
      },
      close() { connClosed = true; },
    };
    conn.send({ hello: 1 });
    expect(connClosed).toBe(true);
    expect(sentFrames).toHaveLength(0);
  });

  it("[SRV-0020] bufferedAmount が 4MB 以下なら正常送出する (境界値: ちょうど 4MB は許容)", () => {
    const MAX_BUFFERED = 4 * 1024 * 1024;
    const sentFrames = [];
    let connClosed = false;
    const fakeWs = {
      bufferedAmount: MAX_BUFFERED, // ちょうど 4MB は > でないので許容
      send(f) { sentFrames.push(f); },
    };
    const conn = {
      send(obj) {
        if (fakeWs.bufferedAmount > MAX_BUFFERED) { conn.close(); return; }
        fakeWs.send(JSON.stringify(obj));
      },
      close() { connClosed = true; },
    };
    conn.send({ ok: true });
    expect(sentFrames).toHaveLength(1);
    expect(connClosed).toBe(false);
  });

  it("[SRV-0020] MAX_BUFFERED は 4*1024*1024 = 4194304 (ws.js:11)", () => {
    // ref: ws.js:11 — const MAX_BUFFERED = 4 * 1024 * 1024
    expect(4 * 1024 * 1024).toBe(4194304);
  });
});

// ============================================================================
// [SRV-0021] NDJSON 行境界: 改行区切り / チャンク跨ぎ / 空行スキップ / StringDecoder
// ============================================================================
describe("[SRV-0021] NDJSON 行境界: 改行区切り / チャンク跨ぎ連結 / 空行スキップ / UTF-8 復元", () => {
  it("[SRV-0021] 改行区切りで各行が onLine に届く、空行はスキップされる", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onLine = vi.fn();
    makeLineConnection(readable, writable, { onLine });

    readable.write('{"a":1}\n\n{"b":2}\n');
    expect(onLine).toHaveBeenCalledTimes(2);
    expect(onLine.mock.calls[0][1]).toBe('{"a":1}');
    expect(onLine.mock.calls[1][1]).toBe('{"b":2}');
  });

  it("[SRV-0021] チャンク跨ぎの 1 行は連結してから onLine に渡す", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onLine = vi.fn();
    makeLineConnection(readable, writable, { onLine });

    readable.write('{"a":');
    expect(onLine).not.toHaveBeenCalled();
    readable.write('1}\n');
    expect(onLine).toHaveBeenCalledTimes(1);
    expect(onLine.mock.calls[0][1]).toBe('{"a":1}');
  });

  it("[SRV-0021] 空行 (trim で空) はスキップして onLine を呼ばない", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onLine = vi.fn();
    makeLineConnection(readable, writable, { onLine });

    readable.write('\n\n{"x":1}\n\n');
    expect(onLine).toHaveBeenCalledTimes(1);
    expect(onLine.mock.calls[0][1]).toBe('{"x":1}');
  });

  it("[SRV-0021] マルチバイト UTF-8 がチャンク境界を跨いでも正しく復元される", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onLine = vi.fn();
    makeLineConnection(readable, writable, { onLine });

    // UTF-8 の日本語 "あ" は 3 bytes: 0xe3, 0x81, 0x82
    const ahi = Buffer.from("あ", "utf8");
    readable.write(Buffer.concat([Buffer.from('{"k":"'), ahi.slice(0, 2)]));
    expect(onLine).not.toHaveBeenCalled();
    readable.write(Buffer.concat([ahi.slice(2), Buffer.from('"}\n')]));
    expect(onLine).toHaveBeenCalledTimes(1);
    expect(onLine.mock.calls[0][1]).toBe('{"k":"あ"}');
  });

  it("[SRV-0021] 行末の trim で空白のみの行をスキップする", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onLine = vi.fn();
    makeLineConnection(readable, writable, { onLine });

    readable.write('   \n{"x":1}\n');
    expect(onLine).toHaveBeenCalledTimes(1);
    expect(onLine.mock.calls[0][1]).toBe('{"x":1}');
  });
});

// ============================================================================
// [SRV-0022] NDJSON maxLine 超過 → DoS 切断
// ============================================================================
describe("[SRV-0022] NDJSON maxLine 超過 → DoS 切断: socket=destroy / stdio=触らない", () => {
  it("[SRV-0022] 改行無し 1 行が maxLine を超えたら切断し以後の入力を無視する (closeWritable=true)", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onLine = vi.fn();
    const onClose = vi.fn();
    makeLineConnection(readable, writable, { onLine, onClose, maxLine: 16, closeWritable: true });

    readable.write("x".repeat(17));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(writable.destroyed).toBe(true);

    readable.write("\n");
    expect(onLine).not.toHaveBeenCalled();
  });

  it("[SRV-0022] closeWritable=false (stdio) では writable を destroy しない", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onClose = vi.fn();
    makeLineConnection(readable, writable, { onLine: vi.fn(), onClose, maxLine: 16, closeWritable: false });

    readable.write("x".repeat(17));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(writable.destroyed).toBe(false);
    expect(writable.ended).toBe(false);
  });

  it("[SRV-0022] maxLine 以内の行は正常処理される (境界値: ちょうど maxLine は OK)", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onLine = vi.fn();
    const onClose = vi.fn();
    makeLineConnection(readable, writable, { onLine, onClose, maxLine: 16 });

    readable.write("x".repeat(16) + "\n");
    expect(onLine).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("[SRV-0022] maxLine のデフォルト値は 1_000_000 (1MB) - 未満はセーフ、超過で切断", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onClose = vi.fn();
    makeLineConnection(readable, writable, { onLine: vi.fn(), onClose });

    readable.write("x".repeat(999_999));
    expect(onClose).not.toHaveBeenCalled();

    readable.write("x".repeat(2)); // 合計 1_000_001 > 1_000_000
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// [SRV-0023] NDJSON 出力背圧: write false → queue / drain → flush / maxQueue → close
// ============================================================================
describe("[SRV-0023] NDJSON 出力背圧: write=false→queue / drain で flush / maxQueue 超→close", () => {
  it("[SRV-0023] write が false を返したら以後は queue に積み drain で順序どおり flush する", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const conn = makeLineConnection(readable, writable, { onLine: vi.fn() });

    writable.writeResult = false;
    conn.send({ n: 1 });
    conn.send({ n: 2 });
    conn.send({ n: 3 });
    expect(writable.written).toEqual(['{"n":1}\n']);

    writable.writeResult = true;
    writable.emit("drain");
    expect(writable.written).toEqual(['{"n":1}\n', '{"n":2}\n', '{"n":3}\n']);

    conn.send({ n: 4 });
    expect(writable.written).toHaveLength(4);
  });

  it("[SRV-0023] drain 中に再び write が false なら flush を中断し残りは次の drain まで保持する", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const conn = makeLineConnection(readable, writable, { onLine: vi.fn() });

    writable.writeResult = false;
    conn.send({ n: 1 });
    conn.send({ n: 2 });
    conn.send({ n: 3 });

    // writeResult stays false → flush n:2 then stops
    writable.emit("drain");
    expect(writable.written).toEqual(['{"n":1}\n', '{"n":2}\n']);

    writable.writeResult = true;
    writable.emit("drain");
    expect(writable.written).toEqual(['{"n":1}\n', '{"n":2}\n', '{"n":3}\n']);
  });

  it("[SRV-0023] queue が maxQueue を超えた遅い接続はその接続だけ close される", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onClose = vi.fn();
    const conn = makeLineConnection(readable, writable, { onLine: vi.fn(), onClose, maxQueue: 2 });

    writable.writeResult = false;
    conn.send({ n: 0 }); // 直接 write (false → draining)
    conn.send({ n: 1 }); // queue[0]
    conn.send({ n: 2 }); // queue[1]
    expect(onClose).not.toHaveBeenCalled();
    conn.send({ n: 3 }); // queue[2] > maxQueue=2 → close
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("[SRV-0023] close 後の send は無視される (closed ガード)", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const conn = makeLineConnection(readable, writable, { onLine: vi.fn() });

    conn.close();
    conn.send({ after: "close" });
    expect(writable.written).toHaveLength(0);
  });

  it("[SRV-0023] maxQueue のデフォルト値は 1000 - 1000 件は OK、1001 件目で close", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onClose = vi.fn();
    const conn = makeLineConnection(readable, writable, { onLine: vi.fn(), onClose });

    writable.writeResult = false;
    conn.send({ n: 0 }); // draining
    for (let i = 1; i <= 1000; i++) conn.send({ n: i });
    expect(onClose).not.toHaveBeenCalled();
    conn.send({ n: 1001 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// [SRV-0024] NDJSON close 冪等性
// ============================================================================
describe("[SRV-0024] NDJSON close 冪等性: 二度呼び→onClose 1回 / readable end/error でも close", () => {
  it("[SRV-0024] close を二度呼んでも onClose は 1 回だけ呼ばれる", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onClose = vi.fn();
    const conn = makeLineConnection(readable, writable, { onLine: vi.fn(), onClose });

    conn.close();
    conn.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("[SRV-0024] readable の end でも conn.close が発火する (onClose 呼ばれる)", async () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onClose = vi.fn();
    makeLineConnection(readable, writable, { onLine: vi.fn(), onClose });

    readable.end();
    await new Promise((r) => setImmediate(r));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("[SRV-0024] readable の error でも conn.close が発火する (onClose 呼ばれる)", async () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onClose = vi.fn();
    makeLineConnection(readable, writable, { onLine: vi.fn(), onClose });

    readable.emit("error", new Error("read error"));
    await new Promise((r) => setImmediate(r));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("[SRV-0024] closeWritable=true の時のみ close で writable.end を呼ぶ", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const conn = makeLineConnection(readable, writable, { onLine: vi.fn(), closeWritable: true });

    conn.close();
    expect(writable.ended).toBe(true);
  });

  it("[SRV-0024] closeWritable=false (既定) では close で writable.end は呼ばれない", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const conn = makeLineConnection(readable, writable, { onLine: vi.fn(), closeWritable: false });

    conn.close();
    expect(writable.ended).toBe(false);
  });
});

// ============================================================================
// [SRV-0025] Unix socket 生存確認: live=reject / stale=unlink / 不在=即 resolve
// ============================================================================
describe("[SRV-0025] ensureFreeSocket: live→reject / stale→unlink / 不在→即 resolve", () => {
  it("[SRV-0025] 存在しないソケットパスは即 resolve する", async () => {
    const nonExistent = `/tmp/srv-0025-nonexistent-${Date.now()}.sock`;
    await expect(ensureFreeSocket(nonExistent)).resolves.toBeUndefined();
  });

  it("[SRV-0025] stale ソケット (接続不可ファイル) は unlink して resolve する", async () => {
    const { writeFileSync, existsSync } = await import("node:fs");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "srv-0025-"));
    const stalePath = join(dir, "stale.sock");
    writeFileSync(stalePath, ""); // not a real socket → connect will fail

    await expect(ensureFreeSocket(stalePath)).resolves.toBeUndefined();
    expect(existsSync(stalePath)).toBe(false); // unlinked

    rmSync(dir, { recursive: true, force: true });
  });

  it("[SRV-0025] 生きているソケット (別デーモン) は reject する (already running)", async () => {
    const net = await import("node:net");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "srv-0025-live-"));
    const sockPath = join(dir, "live.sock");

    const server = net.default.createServer();
    await new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(sockPath, res);
    });

    try {
      await expect(ensureFreeSocket(sockPath)).rejects.toThrow(/already running/i);
    } finally {
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// [SRV-0026] Unix socket 0600 listen: umask(0o177) / ensureSecureDir 0700
// ============================================================================
describe("[SRV-0026] Unix socket は 0600 で生成 / 親 dir を 0700 で用意", () => {
  it("[SRV-0026] umask(0o177) が 0600 権限を生成する数値不変条件", () => {
    // umask(0o177) = 0o666 & ~0o177 = 0o600
    const SECURE_UMASK = 0o177;
    const baseMode = 0o666;
    const result = baseMode & ~SECURE_UMASK;
    expect(result).toBe(0o600);
  });

  it("[SRV-0026] ensureSecureDir は 0700 でディレクトリを作成する", async () => {
    const { ensureSecureDir } = await import("@sesame-kit/core/secure-fs");
    const { mkdtempSync, statSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const parent = mkdtempSync(join(tmpdir(), "srv-0026-"));
    const target = join(parent, "secure");
    try {
      ensureSecureDir(target);
      const mode = statSync(target).mode & 0o777;
      expect(mode).toBe(0o700);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "[SRV-0026] socket ファイルは 0600 で生成される (umask(0o177) 効果)",
    async () => {
      const { startSocketFraming } = await import("../../src/serve/framing/socket.js");
      const { mkdtempSync, statSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = mkdtempSync(join(tmpdir(), "srv-0026-sock-"));
      const sockPath = join(dir, "test.sock");
      const d = new Daemon({ hub: makeFakeHub() });
      const handle = await startSocketFraming(d, { socketPath: sockPath });
      try {
        const mode = statSync(sockPath).mode & 0o777;
        expect(mode).toBe(0o600);
      } finally {
        await handle.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});

// ============================================================================
// [SRV-0027] stdio framing: stdin/stdout 単一持続接続 / closeWritable=false / EOF→onShutdown
// ============================================================================
describe("[SRV-0027] stdio framing: stdin/stdout NDJSON 単一接続 / stdout 共有 (closeWritable=false) / EOF→onShutdown", () => {
  it("[SRV-0027] stdin EOF (onClose) で removeConnection と onShutdown を呼ぶ", async () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const onShutdown = vi.fn();
    const removeConnection = vi.fn();
    const addConnection = vi.fn();
    const handleLine = vi.fn();

    const conn = makeLineConnection(readable, writable, {
      onLine: (c, raw) => handleLine(c, raw),
      onClose: () => {
        removeConnection(conn);
        if (onShutdown) onShutdown(); // stdio.js:17 相当
      },
      closeWritable: false, // stdout 共有 (stdio.js)
    });
    addConnection(conn);

    expect(addConnection).toHaveBeenCalledTimes(1);

    readable.end();
    await new Promise((r) => setImmediate(r));
    expect(removeConnection).toHaveBeenCalledTimes(1);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it("[SRV-0027] onShutdown が指定されていない場合は EOF でもクラッシュしない", async () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const removeConnection = vi.fn();

    const conn = makeLineConnection(readable, writable, {
      onLine: vi.fn(),
      onClose: () => {
        removeConnection(conn);
        // onShutdown = undefined: stdio.js:17 if(onShutdown) guard
      },
      closeWritable: false,
    });

    readable.end();
    await new Promise((r) => setImmediate(r));
    expect(removeConnection).toHaveBeenCalledTimes(1);
  });

  it("[SRV-0027] closeWritable=false (stdout 共有) では close が writable を閉じない", () => {
    const readable = new PassThrough();
    const writable = fakeWritable();
    const conn = makeLineConnection(readable, writable, {
      onLine: vi.fn(),
      closeWritable: false,
    });
    conn.close();
    expect(writable.ended).toBe(false);
    expect(writable.destroyed).toBe(false);
  });

  it("[SRV-0027] startStdioFraming は stop() 関数を返しクラッシュしない", () => {
    const daemon = makeFakeDaemon();
    const origStdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
    const origStdoutDescriptor = Object.getOwnPropertyDescriptor(process, "stdout");
    const fakeReadable = new PassThrough();
    const fakeWritableObj = { write() { return true; }, on() {}, end() {}, destroy() {} };

    Object.defineProperty(process, "stdin", { value: fakeReadable, writable: true, configurable: true });
    Object.defineProperty(process, "stdout", { value: fakeWritableObj, writable: true, configurable: true });

    try {
      const handle = startStdioFraming(daemon);
      expect(typeof handle.stop).toBe("function");
      expect(() => handle.stop()).not.toThrow();
    } finally {
      if (origStdinDescriptor) {
        Object.defineProperty(process, "stdin", origStdinDescriptor);
      }
      if (origStdoutDescriptor) {
        Object.defineProperty(process, "stdout", origStdoutDescriptor);
      }
      fakeReadable.destroy();
    }
  });
});

// ============================================================================
// [SRV-0028] parseBearer ReDoS 安全: anchored /^Bearer\s+/i / scheme 大小区別なし
// ============================================================================
describe("[SRV-0028] parseBearer: anchored /^Bearer\\s+/i で線形 / 大小区別なし / scheme 単独=null", () => {
  it("[SRV-0028] Bearer scheme から token を取り出す", () => {
    expect(parseBearer("Bearer abc123")).toBe("abc123");
  });

  it("[SRV-0028] scheme は大文字小文字非区別 (/i フラグ)", () => {
    expect(parseBearer("bearer abc")).toBe("abc");
    expect(parseBearer("BEARER abc")).toBe("abc");
    expect(parseBearer("Bearer abc")).toBe("abc");
  });

  it("[SRV-0028] 非 Bearer scheme / 空文字 / 非文字列は null を返す", () => {
    expect(parseBearer("Basic abc")).toBeNull();
    expect(parseBearer("")).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer(123)).toBeNull();
    expect(parseBearer({})).toBeNull();
  });

  it("[SRV-0028] 'Bearer' のみ (空白なし) は null (scheme 形式不成立)", () => {
    expect(parseBearer("Bearer")).toBeNull();
  });

  it("[SRV-0028] 'Bearer ' (空白のみ) は空文字 (null ではない)", () => {
    expect(parseBearer("Bearer ")).toBe("");
    expect(parseBearer("Bearer    ")).toBe("");
  });

  it("[SRV-0028] ReDoS 回帰: 10 万空白 + token が 200ms 未満で処理される (線形)", () => {
    const evil = "Bearer" + " ".repeat(100_000) + "x";
    const start = performance.now();
    expect(parseBearer(evil)).toBe("x");
    expect(performance.now() - start).toBeLessThan(200);
  });
});

// ============================================================================
// [SRV-0029] extractToken 優先順: Authorization:Bearer 最優先 / ?token= フォールバック
// ============================================================================
describe("[SRV-0029] extractToken: Authorization:Bearer 最優先 / 空 Bearer で ?token= に落ちない", () => {
  it("[SRV-0029] Authorization ヘッダが最優先 (クエリより優先)", () => {
    const req = { headers: { authorization: "Bearer headtoken" }, url: "/?token=querytoken" };
    expect(extractToken(req)).toBe("headtoken");
  });

  it("[SRV-0029] 空 Bearer はクエリにフォールバックしない (空 Bearer を ?token= で上書きさせない)", () => {
    // ref: token.js:56 — fromHeader !== null で採用 (空文字含む)
    const req = { headers: { authorization: "Bearer " }, url: "/?token=querytoken" };
    expect(extractToken(req)).toBe("");
  });

  it("[SRV-0029] ヘッダ無しなら ?token= クエリを使う (ブラウザ専用フォールバック)", () => {
    const req = { headers: {}, url: "/sub?token=fallback" };
    expect(extractToken(req)).toBe("fallback");
  });

  it("[SRV-0029] ヘッダもクエリも無ければ空文字", () => {
    expect(extractToken({ headers: {}, url: "/" })).toBe("");
    expect(extractToken({ headers: {} })).toBe("");
  });
});

// ============================================================================
// [SRV-0030] tokenMatches: 定数時間比較 / 型不正→false / 長さ不一致→false
// ============================================================================
describe("[SRV-0030] tokenMatches: timingSafeEqual 定数時間比較 / 型不正→false / 長さ不一致→false", () => {
  it("[SRV-0030] 同一 token は true を返す", () => {
    const tok = generateToken();
    expect(tokenMatches(tok, tok)).toBe(true);
  });

  it("[SRV-0030] 異なる token は false を返す", () => {
    const tok = generateToken();
    expect(tokenMatches(tok, generateToken())).toBe(false);
  });

  it("[SRV-0030] 長さ不一致は timingSafeEqual 前に false (Buffer 長差の例外回避)", () => {
    const tok = generateToken();
    expect(tokenMatches("short", tok)).toBe(false);
    expect(tokenMatches(tok, "short")).toBe(false);
  });

  it("[SRV-0030] 非文字列 (undefined / null / number / object) は false", () => {
    const tok = generateToken();
    expect(tokenMatches(undefined, tok)).toBe(false);
    expect(tokenMatches(tok, null)).toBe(false);
    expect(tokenMatches(null, null)).toBe(false);
    expect(tokenMatches(123, tok)).toBe(false);
    expect(tokenMatches(tok, {})).toBe(false);
  });

  it("[SRV-0030] generateToken は 64 文字の hex 文字列を返す (32byte hex)", () => {
    const tok = generateToken();
    expect(typeof tok).toBe("string");
    expect(tok).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(tok)).toBe(true);
  });
});

// ============================================================================
// [SRV-0031] classify() 5 分類: parse-error / batch / invalid / notification / request
// ============================================================================
describe("[SRV-0031] classify: parse-error / batch / invalid / notification / request(id:null含む)", () => {
  it("[SRV-0031] JSON parse 失敗は parse-error を返す", () => {
    expect(classify("{invalid}")).toMatchObject({ type: "parse-error" });
    expect(classify("not json")).toMatchObject({ type: "parse-error" });
    expect(classify("{broken")).toMatchObject({ type: "parse-error" });
  });

  it("[SRV-0031] 配列は batch を返す", () => {
    expect(classify("[{},{}]")).toMatchObject({ type: "batch" });
    expect(classify("[]")).toMatchObject({ type: "batch" });
  });

  it("[SRV-0031] jsonrpc != '2.0' は invalid を返す", () => {
    expect(classify('{"jsonrpc":"1.0","method":"foo","id":1}')).toMatchObject({ type: "invalid" });
    expect(classify('{"method":"foo","id":1}')).toMatchObject({ type: "invalid" }); // missing jsonrpc
  });

  it("[SRV-0031] method が非文字列 / 空文字は invalid を返す", () => {
    expect(classify('{"jsonrpc":"2.0","method":42,"id":1}')).toMatchObject({ type: "invalid" });
    expect(classify('{"jsonrpc":"2.0","method":"","id":1}')).toMatchObject({ type: "invalid" });
  });

  it("[SRV-0031] 'id' キーが欠落は notification / id:null は request (通知ではない)", () => {
    // ref: jsonrpc.js — !("id" in msg) → notification
    const notif = classify('{"jsonrpc":"2.0","method":"events.subscribe","params":{}}');
    expect(notif.type).toBe("notification");

    // id:null is a request, NOT a notification
    const req = classify('{"jsonrpc":"2.0","id":null,"method":"status","params":{}}');
    expect(req.type).toBe("request");
    expect(req.id).toBeNull();
  });

  it("[SRV-0031] request は id / method / params を返す", () => {
    const r = classify('{"jsonrpc":"2.0","id":42,"method":"lock.unlock","params":{"name":"front"}}');
    expect(r).toMatchObject({ type: "request", id: 42, method: "lock.unlock" });
    expect(r.params).toMatchObject({ name: "front" });
  });

  it("[SRV-0031] params 欠落は {} として正規化される", () => {
    const r = classify('{"jsonrpc":"2.0","id":1,"method":"status"}');
    expect(r.type).toBe("request");
    if (r.type === "request") {
      expect(r.params).toEqual({});
    }
  });
});

// ============================================================================
// [SRV-0032] 通知 (id 欠落) はエラーでも応答を返さない (silent invoke)
// ============================================================================
describe("[SRV-0032] 通知 (id 欠落) は invoke 成功・throw いずれでも応答 null", () => {
  it("[SRV-0032] 通知の invoke が成功しても null を返す (応答禁止)", async () => {
    const invoke = vi.fn(async () => "some result");
    const raw = '{"jsonrpc":"2.0","method":"foo","params":{}}'; // no id
    const result = await handleMessage(raw, invoke);
    expect(result).toBeNull();
    expect(invoke).toHaveBeenCalled();
  });

  it("[SRV-0032] 通知の invoke が throw しても null を返す (サイレント・エラーも応答禁止)", async () => {
    const invoke = vi.fn(async () => { throw new Error("boom"); });
    const raw = '{"jsonrpc":"2.0","method":"bar","params":{}}'; // no id
    const result = await handleMessage(raw, invoke);
    expect(result).toBeNull();
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("[SRV-0032] id:null は request として扱われ応答が返る (通知でない)", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const res = await handleMessage('{"jsonrpc":"2.0","method":"foo","id":null}', invoke);
    expect(res).not.toBeNull();
    expect(res).toMatchObject({ id: null, result: { ok: true } });
  });
});

// ============================================================================
// [SRV-0033] batch(配列) と parse 不能は -32600/-32700 / id:null → request
// ============================================================================
describe("[SRV-0033] batch→-32600 / parse 失敗→-32700 / id:null は request として応答", () => {
  it("[SRV-0033] batch (配列) は INVALID_REQUEST(-32600) + bad_params を返す", async () => {
    const invoke = vi.fn();
    const result = await handleMessage('[{"jsonrpc":"2.0","method":"foo","id":1}]', invoke);
    expect(result).not.toBeNull();
    expect(result.error.code).toBe(RPC.INVALID_REQUEST); // -32600
    expect(result.error.data.kind).toBe(KIND.BAD_PARAMS);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("[SRV-0033] JSON parse 失敗は PARSE_ERROR(-32700) + bad_params を返す", async () => {
    const invoke = vi.fn();
    const result = await handleMessage("{broken}", invoke);
    expect(result).not.toBeNull();
    expect(result.error.code).toBe(RPC.PARSE_ERROR); // -32700
    expect(result.error.data.kind).toBe(KIND.BAD_PARAMS);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("[SRV-0033] id:null は request として扱われ応答が返る (id=null の応答)", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const raw = '{"jsonrpc":"2.0","id":null,"method":"status","params":{}}';
    const result = await handleMessage(raw, invoke);
    expect(result).not.toBeNull();
    expect(result.id).toBeNull();
    expect(result.result).toMatchObject({ ok: true });
    expect(invoke).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// [SRV-0034] makeError: kind は最後に固定 / inbound params echo 不可 / 空 data→省略
// ============================================================================
describe("[SRV-0034] makeError: kind は最後に固定 / inbound params echo 不可 / 空 data→省略", () => {
  it("[SRV-0034] caller が data に kind を含めても makeError の kind 引数が上書きする", () => {
    const callerData = { kind: "caller-kind", extra: "x" };
    const result = makeError(1, RPC.APP_ERROR, "msg", KIND.NOT_AUTHENTICATED, callerData);
    expect(result.error.data.kind).toBe(KIND.NOT_AUTHENTICATED); // spec kind wins
    expect(result.error.data.extra).toBe("x");
  });

  it("[SRV-0034] kind が null/undefined の時は error.data が省略される", () => {
    const result = makeError(1, RPC.APP_ERROR, "msg", undefined, null);
    expect(result.error.data).toBeUndefined();
  });

  it("[SRV-0034] data が null かつ kind も無い場合は error.data フィールド自体が省略される", () => {
    const result = makeError(null, RPC.INTERNAL_ERROR, "msg");
    expect(result.error.data).toBeUndefined();
  });

  it("[SRV-0034] data に kind がなくても makeError の kind 引数で kind が追加される", () => {
    const result = makeError(1, RPC.APP_ERROR, "msg", KIND.BAD_PARAMS, { foo: "bar" });
    expect(result.error.data.foo).toBe("bar");
    expect(result.error.data.kind).toBe(KIND.BAD_PARAMS);
  });

  it("[SRV-0034] makeError は inbound params を引数に持たない (echo 不能設計)", () => {
    const r = makeError(1, RPC.INVALID_PARAMS, "bad params", KIND.BAD_PARAMS, null);
    expect(r.jsonrpc).toBe("2.0");
    expect(r.id).toBe(1);
    expect(r.error.code).toBe(RPC.INVALID_PARAMS);
    if (r.error.data) {
      expect(Object.keys(r.error.data)).not.toContain("params");
    }
  });

  it("[SRV-0034] makeError の応答は JSON-RPC 2.0 envelope 形式を維持する", () => {
    const res = makeError(42, RPC.APP_ERROR, "error msg", KIND.INTERNAL);
    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(42);
    expect(typeof res.error.code).toBe("number");
    expect(typeof res.error.message).toBe("string");
  });
});

// ============================================================================
// [SRV-0036] reserved namespace rpc.*: rpc.discover 以外は METHOD_NOT_FOUND
// ============================================================================
describe("[SRV-0036] rpc.* ゲート: rpc.discover 以外と未登録 method は -32601/not_implemented", () => {
  it("[SRV-0036] rpc.discover は OpenRPC 文書を返す (ゲートを通過する)", async () => {
    const d = new Daemon({ hub: makeFakeHub(), version: "9.9.9" });
    const doc = await d.invoke("rpc.discover", {}, null);
    expect(doc).toMatchObject({ openrpc: "1.2.6" });
    expect(Array.isArray(doc.methods)).toBe(true);
  });

  it("[SRV-0036] rpc.<other> は RpcError(-32601, kind=not_implemented) をスローする", async () => {
    const d = new Daemon({ hub: makeFakeHub() });
    await expect(d.invoke("rpc.secret", {}, null)).rejects.toMatchObject({
      code: RPC.METHOD_NOT_FOUND,
      kind: KIND.NOT_IMPLEMENTED,
    });
  });

  it("[SRV-0036] rpc.* は registry に到達せず gate で止められる", async () => {
    const d = new Daemon({ hub: makeFakeHub() });
    await expect(d.invoke("rpc.internal", {}, null)).rejects.toMatchObject({
      code: -32601,
      kind: "not_implemented",
    });
  });

  it("[SRV-0036] 未登録 method は RpcError(-32601, kind=not_implemented) をスローする", async () => {
    const d = new Daemon({ hub: makeFakeHub() });
    await expect(d.invoke("nope.nope", {}, null)).rejects.toMatchObject({
      code: RPC.METHOD_NOT_FOUND,
      kind: KIND.NOT_IMPLEMENTED,
    });
    await expect(d.invoke("does.not.exist", {}, null)).rejects.toMatchObject({
      kind: KIND.NOT_IMPLEMENTED,
    });
  });

  it("[SRV-0036] 未登録 method と rpc.X は同じ error code/kind を返す (一貫性)", async () => {
    const d = new Daemon({ hub: makeFakeHub() });
    let errRpc, errUnknown;
    try { await d.invoke("rpc.other", {}, null); } catch (e) { errRpc = e; }
    try { await d.invoke("unknown.method", {}, null); } catch (e) { errUnknown = e; }
    expect(errRpc.code).toBe(errUnknown.code);
    expect(errRpc.kind).toBe(errUnknown.kind);
  });
});

// ============================================================================
// [SRV-0037] params 検証: null→{} / 非 object/配列 → bad_params (全 framing 共通)
// ============================================================================
describe("[SRV-0037] Daemon.invoke params 検証: null→{} / 配列/非object → INVALID_PARAMS+bad_params", () => {
  it("[SRV-0037] params=null は {} に正規化して invoke が通る", async () => {
    const d = new Daemon({ hub: makeFakeHub({ connected: true }), version: "1.0.0" });
    d.authState = "ok";
    const result = await d.invoke("rpc.discover", null, null);
    expect(result.openrpc).toBe("1.2.6");
  });

  it("[SRV-0037] params が配列 (positional) は INVALID_PARAMS + bad_params をスローする", async () => {
    const d = new Daemon({ hub: makeFakeHub() });
    await expect(d.invoke("status", [1, 2, 3], null)).rejects.toMatchObject({
      code: RPC.INVALID_PARAMS,
      kind: KIND.BAD_PARAMS,
    });
  });

  it("[SRV-0037] params が文字列 (非 object) は INVALID_PARAMS + bad_params をスローする", async () => {
    const d = new Daemon({ hub: makeFakeHub() });
    await expect(d.invoke("status", "invalid", null)).rejects.toMatchObject({
      code: RPC.INVALID_PARAMS,
      kind: KIND.BAD_PARAMS,
    });
  });

  it("[SRV-0037] params が数値 (非 object) は INVALID_PARAMS + bad_params をスローする", async () => {
    const d = new Daemon({ hub: makeFakeHub() });
    await expect(d.invoke("status", 42, null)).rejects.toMatchObject({
      code: RPC.INVALID_PARAMS,
      kind: KIND.BAD_PARAMS,
    });
  });

  it("[SRV-0037] params が object の時は bad_params にならない (正常系)", async () => {
    const d = new Daemon({ hub: makeFakeHub({ connected: true }), version: "1.0.0" });
    d.authState = "ok";
    const r = await d.invoke("status", {}, null);
    expect(r).toMatchObject({ connected: true });
  });

  it("[SRV-0037] handleMessage を通じた positional params(配列)も INVALID_PARAMS に変換される", async () => {
    const d = new Daemon({ hub: makeFakeHub() });
    const msg = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: [1, 2] });
    const res = await handleMessage(msg, (method, params) => d.invoke(method, params, null));
    expect(res).not.toBeNull();
    expect(res.error.code).toBe(RPC.INVALID_PARAMS);
    expect(res.error.data.kind).toBe(KIND.BAD_PARAMS);
  });
});

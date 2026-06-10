// Unix socket フレーミングの統合テスト (fake hub の Daemon を実ソケットで叩く)。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import net from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../../src/serve/daemon.js";
import { startSocketFraming, ensureFreeSocket } from "../../src/serve/framing/socket.js";

function fakeHub() {
  return {
    connected: true, subUUID: "s", config: { devices: {} },
    connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
    onDeviceUpdate: () => () => {},
    listDevices: vi.fn(async () => [{ deviceUUID: "u1" }]),
  };
}

/** ソケットに 1 リクエストを送り 1 応答行を受け取る。 */
function rpc(socketPath, obj) {
  return new Promise((resolve, reject) => {
    const c = net.connect(socketPath);
    let buf = "";
    c.on("connect", () => c.write(JSON.stringify(obj) + "\n"));
    c.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (!("id" in msg)) continue; // 接続時の event.ready 等の通知はスキップ
        c.destroy(); resolve(msg); return;
      }
    });
    c.on("error", reject);
    setTimeout(() => { c.destroy(); reject(new Error("timeout")); }, 2000);
  });
}

let workDir, socketPath, handle;
beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), "sesame-sock-")); socketPath = join(workDir, "s.sock"); });
afterEach(async () => { if (handle) await handle.stop(); handle = null; rmSync(workDir, { recursive: true, force: true }); });

describe("socket framing", () => {
  it("rpc.discover が UDS 越しに引ける", async () => {
    const d = new Daemon({ hub: fakeHub(), version: "9.9.9" });
    handle = await startSocketFraming(d, { socketPath });
    const res = await rpc(socketPath, { jsonrpc: "2.0", id: 1, method: "rpc.discover" });
    expect(res.id).toBe(1);
    expect(res.result.openrpc).toBe("1.2.6");
    expect(res.result.methods.map((m) => m.name)).toContain("org.getEmployees");
  });

  it("ソケットファイルは 0600 で生成される", async () => {
    const d = new Daemon({ hub: fakeHub() });
    handle = await startSocketFraming(d, { socketPath });
    const mode = statSync(socketPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("未知 method は -32601", async () => {
    const d = new Daemon({ hub: fakeHub() });
    handle = await startSocketFraming(d, { socketPath });
    const res = await rpc(socketPath, { jsonrpc: "2.0", id: 2, method: "does.not.exist" });
    expect(res.error.code).toBe(-32601);
  });

  it("stale ソケット (死んだファイル) は unlink して起動できる", async () => {
    writeFileSync(socketPath, ""); // 生きていないソケット風のゴミ
    await expect(ensureFreeSocket(socketPath)).resolves.toBeUndefined();
    const d = new Daemon({ hub: fakeHub() });
    handle = await startSocketFraming(d, { socketPath }); // 起動できる
    const res = await rpc(socketPath, { jsonrpc: "2.0", id: 3, method: "status" });
    expect(res.result).toBeDefined();
  });

  it("生きているソケットには二重起動を拒否する", async () => {
    const d = new Daemon({ hub: fakeHub() });
    handle = await startSocketFraming(d, { socketPath });
    await expect(ensureFreeSocket(socketPath)).rejects.toThrow(/already running/);
  });

  it("親ディレクトリが存在しなくても 0700 で作って listen する (未初期化 config dir で EACCES にしない)", async () => {
    // 既定 UDS は configPaths.dir 配下に置かれるが、その親が未作成のケースを再現する。
    const nestedPath = join(workDir, "nope", "sesame.sock");
    const d = new Daemon({ hub: fakeHub() });
    handle = await startSocketFraming(d, { socketPath: nestedPath });
    // 親ディレクトリが 0700 で作られている。
    const dirMode = statSync(join(workDir, "nope")).mode & 0o777;
    expect(dirMode).toBe(0o700);
    // 実際に待受できている。
    const res = await rpc(nestedPath, { jsonrpc: "2.0", id: 9, method: "status" });
    expect(res.result).toBeDefined();
  });

  it.skipIf(process.platform === "win32")("既存の緩い親ディレクトリを 0700 に締めてから listen する", async () => {
    const parent = join(workDir, "loose");
    mkdirSync(parent);
    chmodSync(parent, 0o755);
    const nestedPath = join(parent, "sesame.sock");
    const d = new Daemon({ hub: fakeHub() });
    handle = await startSocketFraming(d, { socketPath: nestedPath });
    expect(statSync(parent).mode & 0o777).toBe(0o700);
    const res = await rpc(nestedPath, { jsonrpc: "2.0", id: 10, method: "status" });
    expect(res.result).toBeDefined();
  });
});

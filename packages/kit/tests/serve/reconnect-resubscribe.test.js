// C1 通し統合テスト: transport → SesameHub3 → Daemon を実オブジェクトで貫く。
// ws と auth だけ mock し、「再接続 (2 回目の OPEN) で daemon が subscribe frame を
// 張り直す」ことを実 frame で確認する。
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- ws を制御可能な Fake に差し替え ---
const __ws = [];
class FakeWebSocket {
  constructor(url) {
    this.url = url; this.readyState = 0; this._l = new Map(); this.sent = [];
    __ws.push(this);
    queueMicrotask(() => { this.readyState = 1; this._emit("open"); }); // 生成直後に open
  }
  on(ev, fn) { (this._l.get(ev) || this._l.set(ev, []).get(ev)).push(fn); return this; }
  once(ev, fn) { const w = (...a) => { this._off(ev, w); fn(...a); }; return this.on(ev, w); }
  _off(ev, fn) { const a = this._l.get(ev); if (a) this._l.set(ev, a.filter((f) => f !== fn)); }
  removeAllListeners(ev) { if (ev) this._l.delete(ev); else this._l.clear(); }
  _emit(ev, ...a) { for (const fn of [...(this._l.get(ev) || [])]) fn(...a); }
  send(data) { this.sent.push(typeof data === "string" ? data : data.toString()); }
  close() { this.readyState = 3; this._emit("close", 1006, Buffer.from("")); }
  ping() {}
  terminate() {}
}
vi.mock("ws", () => ({ default: FakeWebSocket }));
vi.mock("@sesame-kit/core/auth", () => ({
  getValidIdToken: vi.fn(async () => "header.eyJzdWIiOiJzdWItMSJ9.sig"), // sub=sub-1
  jwtSub: () => "sub-1",
}));

const { SesameHub3 } = await import("@sesame-kit/core/client");
const { Daemon } = await import("../../src/serve/daemon.js");

function countSubscribeFrames() {
  // 全 ws インスタンスの送信から subscribeDevicesUpdate frame を数える。
  return __ws.flatMap((w) => w.sent).filter((s) => s.includes("subscribeDevicesUpdate")).length;
}

beforeEach(() => { __ws.length = 0; });

describe("C1 通し: 再接続で subscribe frame が張り直される", () => {
  it("初回購読で 1 回、再接続 (2 回目 OPEN) で合計 3 回 subscribe frame が出る", async () => {
    // P1-4 以降の動作:
    //   frame #1: 初回 _ensureStateSub → onDeviceUpdate → sendFrame
    //   再接続時 _fireReconnect のスナップショットには 2 つのコールバックが入る:
    //     frame #2: daemon._reestablishStateSub → offSub → onDeviceUpdate → sendFrame (新)
    //     frame #3: 旧 sendFrame (スナップショット取得時点で登録済み) — offReconnect が
    //               呼ばれても Set からは削除されるがスナップショットには残る
    //   二重送信は無害 (サーバは同じ items の subscribe を冪等に受け付ける)。
    //   ライブラリ層の再送については onDeviceUpdate のコメントを参照。
    const hub = new SesameHub3({
      config: { wsUrl: "wss://x/public", companyID: "co", devices: { front: { deviceUUID: "u1", deviceModel: "sesame_5" } } },
      tokenStore: { load: () => ({ idToken: "t", refreshToken: "r" }) },
    });
    await hub.connect();                       // FakeWebSocket #0 が open
    const d = new Daemon({ hub });
    d.start();                                  // onReconnect 登録
    const conn = { id: "x", send() {}, close() {} };
    d.addConnection(conn);
    d.subscribe(conn, ["lockState"]);           // → subscribeDevicesUpdate frame #1
    expect(countSubscribeFrames()).toBe(1);

    // 実際の再接続を起こす: 現 ws を close → transport が再接続 → 新 ws が open。
    const before = __ws.length;
    hub._ws.ws.close();                         // _onClose → _handleReconnect (即時パス)
    // 新しい ws インスタンスが生成され open するまで microtask/timer を回す
    await vi.waitFor(() => {
      expect(__ws.length).toBeGreaterThan(before); // 新 ws が作られた
      expect(countSubscribeFrames()).toBe(3);      // 再接続後: daemon 再登録 + ライブラリ層再送 (P1-4)
    }, { timeout: 2000, interval: 20 });

    await hub.close();
  });
});

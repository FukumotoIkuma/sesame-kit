// debug ログの資格情報伏字 (clear-text-logging 対策) の単体テスト。
//
// transport.js は debug 時に送受信 payload を console.error に出すが、apiKeyId / token /
// secretKey / sign などの資格情報は "***" に伏せる (redactPayloadForLog)。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hub3WsClient } from "../../src/transport.js";

describe("debug ログの資格情報伏字", () => {
  let spy;
  beforeEach(() => { spy = vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { spy.mockRestore(); });

  /** spy に渡った全引数を 1 本の文字列へ。 */
  const logged = () => spy.mock.calls.map((c) => c.join(" ")).join("\n");

  it("未接続 send は queued ログで apiKeyId / token / sign を伏せる", () => {
    const c = new Hub3WsClient({ wsUrl: "wss://example/public", idToken: "tok", debug: true });
    // 未接続なので _sendOrQueue は "queued (not open)" ログを出す。
    c.send({ action: "biz3InvokeWebAPIs", op: "webapi_cmd_send", apiKeyId: "SECRET_KEY_ID", sign: "deadbeef", deviceId: "d-1" });
    const out = logged();
    expect(out).toContain("queued (not open)");
    expect(out).not.toContain("SECRET_KEY_ID");
    expect(out).not.toContain("deadbeef");
    expect(out).toContain("***");
    // 非機密フィールドは残る (デバッグ性を保つ)。
    expect(out).toContain("d-1");
    expect(out).toContain("webapi_cmd_send");
  });

  it("debug 無効ならそもそも何も出さない", () => {
    const c = new Hub3WsClient({ wsUrl: "wss://example/public", idToken: "tok", debug: false });
    c.send({ action: "x", apiKeyId: "SECRET_KEY_ID" });
    expect(logged()).toBe("");
  });
});

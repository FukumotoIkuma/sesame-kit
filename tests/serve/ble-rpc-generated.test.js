// SURF-08 段階3: BLE_RPC_OPS から自動生成した ble.<op> RPC の結線テスト。
//
// 検証の要: named params → ファサードメソッドの **位置引数** への写像が宣言順どおりであること
// (順序がずれるとワイヤのバイト列が壊れる)。SesameBle.use をスタブし、ファサードの該当
// メソッドが期待引数で呼ばれることを invokePath 経由で確認する。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildRegistry } from "../../src/serve/registry.js";
import { stabilityOf } from "../../src/serve/stability.js";
import * as bleIndex from "../../src/ble/index.js";

const daemon = { authState: "ok", hub: { connected: true } };

/** SesameBle.use をスタブし、fn に渡す擬似 facade を差し込む。 */
function stubBle(fakeFacade) {
  return vi.spyOn(bleIndex.SesameBle, "use").mockImplementation(async (_opts, fn) => fn(fakeFacade));
}

const TARGET = { secretKey: "0123456789abcdef0123456789abcdef", deviceUUID: "d-1", model: "ssm_bot_2" };

describe("生成された ble.script.* RPC", () => {
  let reg;
  beforeEach(() => { reg = buildRegistry(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("ble.script.click が登録され experimental", () => {
    expect(reg.get("ble.script.click")).toBeTruthy();
    expect(stabilityOf("ble.script.click")).toBe("experimental");
  });

  it("index を script.click(index) の位置引数へ写像し、ack を返す", async () => {
    const click = vi.fn(async () => ({ resultCode: 0, payload: Buffer.alloc(0) }));
    stubBle({ script: { click } });
    const r = await reg.get("ble.script.click").handler({ hub: {}, daemon, params: { ...TARGET, index: 3 } });
    expect(click).toHaveBeenCalledWith(3);
    expect(r).toMatchObject({ resultCode: 0, resultName: expect.any(String) });
  });

  it("sendClickScript は (index, script) の順で位置引数化される", async () => {
    const sendClickScript = vi.fn(async () => ({ resultCode: 0, payload: Buffer.alloc(0) }));
    stubBle({ script: { sendClickScript } });
    const script = { name: "x", actions: [{ action: 1, time: 2 }] };
    await reg.get("ble.script.sendClickScript").handler({ hub: {}, daemon, params: { ...TARGET, index: 2, script } });
    expect(sendClickScript).toHaveBeenCalledWith(2, script);
  });

  it("必須 index 欠落は bad_params (sendClickScript)", async () => {
    stubBle({ script: { sendClickScript: vi.fn() } });
    await expect(reg.get("ble.script.sendClickScript").handler({ hub: {}, daemon, params: { ...TARGET, script: {} } }))
      .rejects.toThrow();
  });

  it("raw result はそのまま返す (getScriptNameList)", async () => {
    const getScriptNameList = vi.fn(async () => ({ curIdx: 1, events: [] }));
    stubBle({ script: { getScriptNameList } });
    const r = await reg.get("ble.script.getScriptNameList").handler({ hub: {}, daemon, params: { ...TARGET } });
    expect(r).toEqual({ curIdx: 1, events: [] });
  });

  it("allowlist 非掲載 op は生成されない (= ble.invoke escape hatch のみ)", () => {
    // 生成は BLE_RPC_OPS のキーのみ。未宣言の op は ble.<op> として存在しない。
    expect(reg.get("ble.script.bogus")).toBeUndefined();
  });
});

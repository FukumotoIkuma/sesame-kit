// `sesame config` (show) の secretKey マスクを検証する。
// 回帰: config show は tokens を mask() で伏せていたのに config.json を verbatim 出力していたため、
// 各デバイスの secretKey が平文で漏れていた。さらに config には devices と派生 locks の双方に鍵が
// 入るので、devices だけ潰すと locks 側から漏れる。redactConfig はツリー全体の secretKey を潰す。
// 生鍵が要るときは `sesame devices` (意図的な全ダンプ口) を使う。
import { describe, it, expect } from "vitest";
import { redactConfig } from "../../src/cli.js";

const RAW = "5ccec6781bb7509bdd58fa21565b647b"; // 32 hex
const cfg = {
  companyID: "ch_x",
  devices: {
    front: { deviceName: "front", secretKey: RAW, sesame2PublicKey: "6b59370c" },
  },
  locks: {
    front: { deviceUUID: "AABB", secretKey: RAW, model: "sesame_5" }, // 派生 locks 側にも鍵
  },
};

describe("redactConfig", () => {
  it("devices と locks の双方で secretKey をマスクする (生鍵を残さない)", () => {
    const r = redactConfig(cfg);
    expect(r.devices.front.secretKey).not.toBe(RAW);
    expect(r.locks.front.secretKey).not.toBe(RAW);
    // mask() 形式: 先頭4…末尾4 (len=NN)
    expect(r.devices.front.secretKey).toMatch(/^[a-f0-9]{4}….*len=32/);
  });

  it("出力ツリーのどこにも生 32hex secretKey を残さない", () => {
    const json = JSON.stringify(redactConfig(cfg));
    expect(json).not.toContain(RAW);
  });

  it("秘密でないフィールドは保持する", () => {
    const r = redactConfig(cfg);
    expect(r.companyID).toBe("ch_x");
    expect(r.devices.front.sesame2PublicKey).toBe("6b59370c");
    expect(r.locks.front.deviceUUID).toBe("AABB");
  });

  it("元オブジェクトは破壊しない (複製して返す)", () => {
    redactConfig(cfg);
    expect(cfg.devices.front.secretKey).toBe(RAW);
  });

  it("null/非オブジェクトはそのまま返す", () => {
    expect(redactConfig(null)).toBe(null);
    expect(redactConfig(undefined)).toBe(undefined);
  });
});

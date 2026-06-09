// cloud status 出力の純関数を検証する。
// 回帰: 以前は cloud status を `JSON.stringify(st)` で丸ごと出していたため、
//   (1) 人間向け出力が生 JSON ダンプで読めない、
//   (2) device-status は devices 一覧と同形 = secretKey を含むため端末に鍵が漏れる、
// という 2 点があった。fmtCloudStatus で 1 行整形し、sanitizeStatus で secretKey を落とす。
import { describe, it, expect } from "vitest";
import { fmtCloudStatus, sanitizeStatus } from "../../src/cli.js";

const sampleStatus = {
  deviceName: "front",
  secretKey: "00112233445566778899aabbccddeeff",
  sesame2PublicKey: "1ffab469",
  deviceUUID: "11200423-0300-0207-3200-0101FFFFFFFF",
  stateInfo: { CHSesame2Status: "locked", position: -503, batteryPercentage: 100, batteryVoltage: 5.97 },
};

describe("sanitizeStatus", () => {
  it("secretKey を必ず落とす (端末/JSON に鍵を出さない)", () => {
    const safe = sanitizeStatus(sampleStatus);
    expect("secretKey" in safe).toBe(false);
    // 状態に必要なフィールドは残す
    expect(safe.stateInfo.CHSesame2Status).toBe("locked");
    expect(safe.deviceUUID).toBe(sampleStatus.deviceUUID);
  });
  it("元オブジェクトは破壊しない", () => {
    sanitizeStatus(sampleStatus);
    expect(sampleStatus.secretKey).toBeTruthy();
  });
  it("null/非オブジェクトはそのまま返す", () => {
    expect(sanitizeStatus(null)).toBe(null);
    expect(sanitizeStatus(undefined)).toBe(undefined);
  });
});

describe("fmtCloudStatus", () => {
  it("stateInfo を 1 行 (state/pos/battery) に整形する", () => {
    expect(fmtCloudStatus(sampleStatus)).toBe("state=locked pos=-503 battery=100%");
  });
  it("position 無し (Bot 等) は state/battery だけ出す", () => {
    expect(fmtCloudStatus({ stateInfo: { CHSesame2Status: "unlocked", batteryPercentage: 80 } }))
      .toBe("state=unlocked battery=80%");
  });
  it("stateInfo 無しは未取得扱い (例外を投げない)", () => {
    expect(typeof fmtCloudStatus(null)).toBe("string");
    expect(typeof fmtCloudStatus({})).toBe("string");
  });
  it("整形文字列に secretKey を含めない", () => {
    expect(fmtCloudStatus(sampleStatus)).not.toContain(sampleStatus.secretKey);
  });
});

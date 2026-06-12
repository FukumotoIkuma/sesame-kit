// transport.js の純関数 advToDeviceUUID の単体テスト (noble 不要)。
import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { advToDeviceUUID } from "../../src/ble/transport.js";

describe("advToDeviceUUID", () => {
  it("company 0x055A + 16B deviceID を UUID 文字列に整形", () => {
    // [5A 05][productType][flags x2][deviceID x16]
    const deviceId = Buffer.from("112004230300020732000101ffffffff", "hex");
    const md = Buffer.concat([Buffer.from([0x5a, 0x05, 0x05, 0x00, 0x00]), deviceId]);
    expect(advToDeviceUUID(md)).toBe("11200423-0300-0207-3200-0101ffffffff");
  });

  it("company ID が違えば null", () => {
    const md = Buffer.concat([Buffer.from([0x00, 0x00, 0, 0, 0]), Buffer.alloc(16)]);
    expect(advToDeviceUUID(md)).toBeNull();
  });

  it("短すぎる/未定義は null", () => {
    expect(advToDeviceUUID(Buffer.from([0x5a, 0x05]))).toBeNull();
    expect(advToDeviceUUID(null)).toBeNull();
    expect(advToDeviceUUID(undefined)).toBeNull();
  });
});

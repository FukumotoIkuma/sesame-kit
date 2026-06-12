// _bindNs (client.js) の allowlist 契約を守るための回帰テスト。
//
// presetir / iot は client を取らない純ロジック (class / builder / 内部 helper) を
// export しているため、_bindNs がそれらを誤って ws 注入ラップすると壊れる。
// NAMESPACE_OPS allowlist が「client op だけ」を列挙し、純ロジックを除外していることを保証する。
import { describe, it, expect } from "vitest";
import * as presetir from "../../src/presetir.js";
import * as iot from "../../src/iot.js";

describe("presetir.NAMESPACE_OPS", () => {
  it("client op (sendIR/emitAir/emitButton) のみを公開する", () => {
    expect(presetir.NAMESPACE_OPS).toEqual(["sendIR", "emitAir", "emitButton"]);
  });

  it("列挙された名前はすべて関数として存在する", () => {
    for (const name of presetir.NAMESPACE_OPS) {
      expect(typeof presetir[name]).toBe("function");
    }
  });

  it("純ロジック (class / builder) は namespace に含めない", () => {
    for (const excluded of [
      "HXDCommandProcessor",
      "HXDParametersSwapper",
      "buildAirCommandHex",
      "buildNonAirCommandHex",
    ]) {
      expect(presetir.NAMESPACE_OPS).not.toContain(excluded);
    }
  });
});

describe("iot.NAMESPACE_OPS", () => {
  it("列挙された名前はすべて関数として存在する", () => {
    for (const name of iot.NAMESPACE_OPS) {
      expect(typeof iot[name]).toBe("function");
    }
  });

  it("client を取らない内部 helper (buildIotTopic/buildIotPayload/__internal) は除外", () => {
    for (const excluded of ["buildIotTopic", "buildIotPayload", "__internal"]) {
      expect(iot.NAMESPACE_OPS).not.toContain(excluded);
    }
  });
});

// BLE RPC 公開面 allowlist (P4-1 段階3 / P4-2) の整合テスト。
//
// BLE_RPC_ALLOWLIST / OS2_BLE_RPC_ALLOWLIST は serve の invokePath が fail-closed 照合に使う
// 「ファサードの意図的公開面」の単一の真実。ここでは
//   (1) 表の全名が実ファサードに実在する (typo / リネーム漏れで op が無言で死ぬのを防ぐ)
//   (2) 接続ライフサイクル・登録系・購読 API が表に**載っていない** (fail-closed の意図を固定)
//   (3) [P4-3] 逆方向: prototype 公開面 - 除外集合 == allowlist (ファサード拡張時の追加漏れ検出)
//   (4) [P4-3] 逆方向: allowlist - 制御verb/読みgetter/専用RPC ⊆ BLE_RPC_OPS 第1セグメント
// を固定する。
import { describe, it, expect } from "vitest";
import {
  SesameBle, SesameOS2Ble, BLE_RPC_ALLOWLIST, OS2_BLE_RPC_ALLOWLIST, BLE_RPC_OPS, OS2_BLE_RPC_OPS,
} from "../../src/ble/index.js";

/** 接続しないダミー transport (コンストラクタ要求を満たすだけ)。 */
const fakeTransport = {
  connect: async () => {},
  write: () => {},
  disconnect: async () => {},
};

describe("BLE_RPC_ALLOWLIST (OS3 SesameBle)", () => {
  // registerMode: secretKey 無しで構築できる (公開面の存在確認に login は不要)。
  const ble = new SesameBle({ registerMode: true, model: "sesame_5", transport: fakeTransport });

  it("表の全名が SesameBle ファサードに実在する (getter 実行はしない)", () => {
    for (const name of BLE_RPC_ALLOWLIST) {
      // `in` は getter を実行せずに存在確認できる (biometric 等は機種ガードで throw するため)。
      expect(name in ble, `BLE_RPC_ALLOWLIST の "${name}" が SesameBle に存在しない`).toBe(true);
    }
  });

  it("接続ライフサイクル・登録・購読 API は載っていない (fail-closed の意図)", () => {
    for (const name of ["connect", "close", "use", "register", "registerOnce", "connectMany", "listNearby", "fromDiscovery", "onStatus", "constructor"]) {
      expect(BLE_RPC_ALLOWLIST).not.toContain(name);
    }
  });

  it("意図的公開面の代表 op を網羅している", () => {
    for (const name of [
      "lock", "unlock", "click", "toggle", "autolock", "status",
      "history", "deleteHistory", "getVersionTag", "reset", "updateFirmware",
      "setBleTxPower", "configureLockPosition", "magnet", "opSensorControl", "sendAdvProductType",
      "biometric", "fingerPrint", "remoteNano", "script", "wifi", "hub3",
    ]) {
      expect(BLE_RPC_ALLOWLIST).toContain(name);
    }
  });
});

describe("OS2_BLE_RPC_ALLOWLIST (SesameOS2Ble)", () => {
  const ble = new SesameOS2Ble({ registerMode: true, model: "sesame_3", transport: fakeTransport });

  it("表の全名が SesameOS2Ble ファサードに実在する", () => {
    for (const name of OS2_BLE_RPC_ALLOWLIST) {
      expect(name in ble, `OS2_BLE_RPC_ALLOWLIST の "${name}" が SesameOS2Ble に存在しない`).toBe(true);
    }
  });

  it("接続ライフサイクル・登録・購読 API は載っていない", () => {
    for (const name of ["connect", "close", "use", "register", "registerOnce", "onStatus", "constructor"]) {
      expect(OS2_BLE_RPC_ALLOWLIST).not.toContain(name);
    }
  });

  it("意図的公開面の代表 op を網羅している", () => {
    for (const name of [
      "lock", "unlock", "click", "toggle", "autolock", "disableAutolock", "getAutolock",
      "status", "history", "versionTag", "reset", "configureLockPosition", "updateSetting", "updateFirmware",
    ]) {
      expect(OS2_BLE_RPC_ALLOWLIST).toContain(name);
    }
  });
});

// ------------------------------------------------------------------
// P4-3: 逆方向網羅テスト — ファサード拡張時の追加漏れ検出
// ------------------------------------------------------------------
//
// 「prototype 公開メンバ - 明示除外集合 == allowlist」の完全一致を固定する。
// ファサードにメソッドを追加しても allowlist への追加を忘れると CI でこのテストが落ちる。
//
// 明示除外集合 (allowlist に**載せない**もの):
//   connect / close / use / register / registerOnce / connectMany / listNearby /
//   fromDiscovery / onStatus — 接続ライフサイクル・登録・購読 API は RPC 経由で
//   二重 connect / 切断 / 再登録させない方針 (src/ble/index.js BLE_RPC_ALLOWLIST 定義コメント)。

/** SesameBle prototype の公開メンバ名を列挙 (_プレフィクス・constructor を除く)。 */
function enumeratePrototypeMembers(Cls) {
  return new Set(
    Object.getOwnPropertyNames(Cls.prototype).filter(
      (n) => n !== "constructor" && !n.startsWith("_")
    )
  );
}

/** SesameBle static メンバ名を列挙 (length/name/prototype を除く)。 */
function enumerateStaticMembers(Cls) {
  return new Set(
    Object.getOwnPropertyNames(Cls).filter(
      (n) => !["length", "name", "prototype"].includes(n)
    )
  );
}

// OS3 (SesameBle) 逆方向テスト
describe("BLE_RPC_ALLOWLIST 逆方向 (P4-3 SesameBle)", () => {
  // 接続ライフサイクル・登録・購読 API — allowlist に**載せない**明示除外集合。
  // この集合を変更したら下記テストも合わせて更新する。
  const EXCLUDE = new Set([
    "connect", "close", "onStatus",
    // static メソッド (prototype にはない)
    "use", "register", "registerOnce", "connectMany", "listNearby", "fromDiscovery",
  ]);

  // prototype の全公開メンバ (instance 面)
  const protoMembers = enumeratePrototypeMembers(SesameBle);
  // static メンバ (use / registerOnce / connectMany / listNearby / fromDiscovery)
  const staticMembers = enumerateStaticMembers(SesameBle);
  // 全公開面 = prototype + static
  const allPublic = new Set([...protoMembers, ...staticMembers]);

  it("prototype + static の公開面 - 除外集合 == BLE_RPC_ALLOWLIST の完全一致", () => {
    // prototype + static - 除外集合
    const expected = [...allPublic].filter((n) => !EXCLUDE.has(n)).sort();
    const actual = [...BLE_RPC_ALLOWLIST].sort();

    // allowlist に無い公開面 → 追加漏れ
    const missing = expected.filter((n) => !BLE_RPC_ALLOWLIST.includes(n));
    expect(
      missing,
      `ファサードに公開メンバを追加したが BLE_RPC_ALLOWLIST へ追加していない: ${missing.join(", ")}`
    ).toEqual([]);

    // allowlist にあるが facade に無い → typo / 削除漏れ
    const extra = actual.filter((n) => !allPublic.has(n) && !EXCLUDE.has(n));
    expect(
      extra,
      `BLE_RPC_ALLOWLIST にあるが SesameBle ファサードに存在しない: ${extra.join(", ")}`
    ).toEqual([]);

    // 完全一致
    expect(actual).toEqual(expected);
  });
});

// OS2 (SesameOS2Ble) 逆方向テスト
describe("OS2_BLE_RPC_ALLOWLIST 逆方向 (P4-3 SesameOS2Ble)", () => {
  // 接続ライフサイクル・登録・購読 API — allowlist に**載せない**明示除外集合。
  // OS2 は connectMany / listNearby / fromDiscovery を持たないが、
  // 除外集合に含めておいても影響はない (setOf と filter は交差のみ見る)。
  const EXCLUDE = new Set([
    "connect", "close", "onStatus",
    "use", "register", "registerOnce", "connectMany", "listNearby", "fromDiscovery",
  ]);

  const protoMembers = enumeratePrototypeMembers(SesameOS2Ble);
  const staticMembers = enumerateStaticMembers(SesameOS2Ble);
  const allPublic = new Set([...protoMembers, ...staticMembers]);

  it("prototype + static の公開面 - 除外集合 == OS2_BLE_RPC_ALLOWLIST の完全一致", () => {
    const expected = [...allPublic].filter((n) => !EXCLUDE.has(n)).sort();
    const actual = [...OS2_BLE_RPC_ALLOWLIST].sort();

    const missing = expected.filter((n) => !OS2_BLE_RPC_ALLOWLIST.includes(n));
    expect(
      missing,
      `ファサードに公開メンバを追加したが OS2_BLE_RPC_ALLOWLIST へ追加していない: ${missing.join(", ")}`
    ).toEqual([]);

    const extra = actual.filter((n) => !allPublic.has(n) && !EXCLUDE.has(n));
    expect(
      extra,
      `OS2_BLE_RPC_ALLOWLIST にあるが SesameOS2Ble ファサードに存在しない: ${extra.join(", ")}`
    ).toEqual([]);

    expect(actual).toEqual(expected);
  });
});

// ------------------------------------------------------------------
// P4-3: allowlist と BLE_RPC_OPS 第1セグメントの包含テスト
// ------------------------------------------------------------------
//
// 「allowlist − 制御verb − 読みgetter − 専用RPC-override ⊆ BLE_RPC_OPS キー第1セグメント」
// を固定する。
//
// 除外 3 グループの根拠:
//   制御 verb   : lock/unlock/click/toggle/autolock は cloud lock.* / ble.invoke と重複するため
//                 BLE_RPC_OPS に**載せない** (src/ble/index.js OS3_TOPLEVEL_RPC_OPS コメント)。
//   読み getter : lastStatus/lastMechSetting/lastOpsSetting/isConnected/model/capabilities/supports
//                 /status は読み取り専用で 1 往復 RPC 向きではなく BLE_RPC_OPS に未掲載。
//   専用 RPC    : configureLockPosition / reset / resetWifiModule2 / updateFirmware は
//                 専用 RPC (ble.position 等) が override するため BLE_RPC_OPS に未掲載
//                 (src/ble/index.js OS3_TOPLEVEL_RPC_OPS コメント)。

describe("allowlist ⊆ BLE_RPC_OPS 第1セグメント (P4-3 包含テスト)", () => {
  // BLE_RPC_OPS キーの第1セグメント集合 (ドット区切りの先頭 or キー全体)。
  const OPS_FIRST_SEGMENTS = new Set(
    Object.keys(BLE_RPC_OPS).map((k) => k.split(".")[0])
  );

  // allowlist から除外する 3 グループ。
  // 除外集合を変えたら BLE_RPC_OPS 側か ble/index.js の設計意図コメントと照合すること。
  const CONTROL_VERBS = new Set(["lock", "unlock", "click", "toggle", "autolock"]);
  const READ_GETTERS = new Set([
    "lastStatus", "lastMechSetting", "lastOpsSetting", "isConnected",
    "model", "capabilities", "supports", "status",
  ]);
  // configureLockPosition / reset / resetWifiModule2 / updateFirmware は
  // 専用 RPC (ble.position / ble.reset 等) が override するため BLE_RPC_OPS 未掲載。
  const DEDICATED_RPC_OVERRIDES = new Set([
    "configureLockPosition", "reset", "resetWifiModule2", "updateFirmware",
  ]);

  it("allowlist の残余が BLE_RPC_OPS 第1セグメントのサブセットである", () => {
    const residual = [...BLE_RPC_ALLOWLIST].filter(
      (n) =>
        !CONTROL_VERBS.has(n) &&
        !READ_GETTERS.has(n) &&
        !DEDICATED_RPC_OVERRIDES.has(n)
    );
    const notInOps = residual.filter((n) => !OPS_FIRST_SEGMENTS.has(n));
    expect(
      notInOps,
      [
        `allowlist の次のエントリが BLE_RPC_OPS に未掲載: ${notInOps.join(", ")}`,
        "制御verb・読みgetter・専用RPC-override 以外は BLE_RPC_OPS にも載せる。",
        "追加した facade メソッドに対応する *_RPC_OPS エントリを src/ble/*.js に追加すること。",
      ].join(" ")
    ).toEqual([]);
  });
});

describe("OS2_BLE_RPC_ALLOWLIST ⊆ OS2_BLE_RPC_OPS 第1セグメント (P4-3 包含テスト)", () => {
  const OS2_OPS_FIRST_SEGMENTS = new Set(
    Object.keys(OS2_BLE_RPC_OPS).map((k) => k.split(".")[0])
  );

  // OS2 の除外グループ (OS3 と同方針)。
  const CONTROL_VERBS = new Set(["lock", "unlock", "click", "toggle"]);
  const READ_GETTERS = new Set([
    "lastStatus", "isConnected", "model", "loginInfo", "status",
  ]);
  // reset / updateFirmware / configureLockPosition は OS2 でも専用 RPC が管理するため未掲載。
  const DEDICATED_RPC_OVERRIDES = new Set(["reset", "updateFirmware", "configureLockPosition"]);

  it("OS2 allowlist の残余が OS2_BLE_RPC_OPS 第1セグメントのサブセットである", () => {
    const residual = [...OS2_BLE_RPC_ALLOWLIST].filter(
      (n) =>
        !CONTROL_VERBS.has(n) &&
        !READ_GETTERS.has(n) &&
        !DEDICATED_RPC_OVERRIDES.has(n)
    );
    const notInOps = residual.filter((n) => !OS2_OPS_FIRST_SEGMENTS.has(n));
    expect(
      notInOps,
      [
        `OS2 allowlist の次のエントリが OS2_BLE_RPC_OPS に未掲載: ${notInOps.join(", ")}`,
        "制御verb・読みgetter・専用RPC-override 以外は OS2_BLE_RPC_OPS にも載せる。",
      ].join(" ")
    ).toEqual([]);
  });
});

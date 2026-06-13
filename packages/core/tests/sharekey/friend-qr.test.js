// P3-6: buildFriendQrUrl / parseFriendQrUrl の単体テスト。
//
// 参照ベクタ: references_web/src/utils/biz3utils.js:107-112 (generateUserQRCodeBySubUUID)
//             references_web/src/utils/biz3utils.js:144-165 (readUserQrcode)
//             references_web/src/constants/qrType.js:3      (QR_FRIEND = 'friend')
//             references_web/src/components/biz/device/AddEmployee.js:386-410
//               → sendParam = { ...userInfo, companyID } → submit([sendParam])

import { describe, it, expect } from "vitest";
import { buildFriendQrUrl, parseFriendQrUrl } from "../../src/sharekey.js";

const SUBUUID = "aaaabbbb-cccc-dddd-eeee-ffffabcd1234";

describe("buildFriendQrUrl", () => {
  it("ssm://UI/?t=friend&friend=<subUUID 大文字> を生成する (biz3utils.js:107-112)", () => {
    const url = buildFriendQrUrl(SUBUUID);
    expect(url).toBe(`ssm://UI/?t=friend&friend=${SUBUUID.toUpperCase()}`);
  });

  it("入力が既に大文字でも toUpperCase は冪等", () => {
    const upper = SUBUUID.toUpperCase();
    const url = buildFriendQrUrl(upper);
    expect(url).toBe(`ssm://UI/?t=friend&friend=${upper}`);
  });

  it("subUUID 省略/falsy で throw (badRequest)", () => {
    expect(() => buildFriendQrUrl("")).toThrow();
    expect(() => buildFriendQrUrl(/** @type {any} */ (null))).toThrow();
    expect(() => buildFriendQrUrl(/** @type {any} */ (undefined))).toThrow();
  });
});

describe("parseFriendQrUrl", () => {
  it("buildFriendQrUrl の round-trip: 生成 → 解析で元の friendID(小文字)が得られる (biz3utils.js:158)", () => {
    const url = buildFriendQrUrl(SUBUUID);
    const { friendID } = parseFriendQrUrl(url);
    expect(friendID).toBe(SUBUUID.toLowerCase());
  });

  it("friendID は常に小文字で返す (biz3utils.js:158: friendUUID.toLowerCase())", () => {
    const url = `ssm://UI/?t=friend&friend=AABBCCDD-EEFF-0011-2233-445566778899`;
    const { friendID } = parseFriendQrUrl(url);
    expect(friendID).toBe("aabbccdd-eeff-0011-2233-445566778899");
  });

  it("t=sk (QR_SESAMEKEY) は t !== 'friend' なので throw", () => {
    const url = `ssm://UI/?t=sk&sk=SOME_SK_PAYLOAD`;
    // sharekey.err.invalidFriendQr — en: "invalid friend QR URL", ja: "friend QR URL が不正です"
    expect(() => parseFriendQrUrl(url)).toThrow(/friend QR URL/);
  });

  it("t=friend でも friend パラメータ欠落なら throw (biz3utils.js:153)", () => {
    const url = `ssm://UI/?t=friend`;
    // sharekey.err.invalidFriendQr — en: "invalid friend QR URL", ja: "friend QR URL が不正です"
    expect(() => parseFriendQrUrl(url)).toThrow(/friend QR URL/);
  });

  it("t=matter は throw", () => {
    const url = `ssm://UI/?t=matter&matter=foo`;
    // sharekey.err.invalidFriendQr — en: "invalid friend QR URL", ja: "friend QR URL が不正です"
    expect(() => parseFriendQrUrl(url)).toThrow(/friend QR URL/);
  });

  it("url 省略/falsy で throw (badRequest)", () => {
    expect(() => parseFriendQrUrl("")).toThrow();
    expect(() => parseFriendQrUrl(/** @type {any} */ (null))).toThrow();
  });

  // AddEmployee.js:394-406 の items 合成スナップショット
  it("parseFriendQrUrl + companyID で AddEmployee.js:402-405 相当の items を合成できる", () => {
    const url = buildFriendQrUrl(SUBUUID);
    const { friendID } = parseFriendQrUrl(url);
    const companyID = "co-001";
    const items = [{ friendID, companyID }];
    // sendParam = { ...userInfo, companyID } (AddEmployee.js:402-405)
    expect(items).toEqual([{ friendID: SUBUUID.toLowerCase(), companyID: "co-001" }]);
  });
});

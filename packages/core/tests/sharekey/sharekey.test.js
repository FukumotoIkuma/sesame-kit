// sharekey (デバイス鍵共有 URL) の単体テスト。
// biz3 generateInviteGuestQRCodeByInfo / readQrcode の移植を round-trip + 構造で検証。
import { describe, it, expect } from "vitest";
import { buildShareKeyUrl, parseShareKeyUrl } from "../../src/sharekey.js";

// SesameOS3 機種 (sesame_5 = productType 5, 5-5>=0 → OS3): publicKey 4B。
const OS3_KEY = {
  deviceModel: "sesame_5",
  secretKey: "00112233445566778899aabbccddeeff", // 16B
  sesame2PublicKey: "0a0b0c0d", // 4B
  keyIndex: "0001", // 2B
  deviceUUID: "12345678-9ABC-DEF0-1234-56789ABCDEF0",
  deviceName: "玄関",
  keyLevel: 0,
};

describe("buildShareKeyUrl", () => {
  it("ssm://UI?t=sk&sk=...&l=...&n=... を生成する", () => {
    const url = buildShareKeyUrl(OS3_KEY, { keyLevel: 0 });
    expect(url.startsWith("ssm://UI?")).toBe(true);
    const p = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(p.get("t")).toBe("sk");
    expect(p.get("l")).toBe("0");
    expect(p.get("n")).toBe("玄関");
    expect(p.get("sk")).toBeTruthy();
  });

  it("先頭バイトは productType (sesame_5 → 5)", () => {
    const url = buildShareKeyUrl(OS3_KEY, { keyLevel: 0 });
    const sk = new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("sk").replace(/ /g, "+");
    const data = Buffer.from(sk, "base64");
    expect(data[0]).toBe(5);
  });

  it("ゲスト共有 (guestKeyId) は secretKey 位置を上書きする", () => {
    const guestKeyId = "ffeeddccbbaa99887766554433221100";
    const url = buildShareKeyUrl(OS3_KEY, { keyLevel: 2, guestKeyId });
    const back = parseShareKeyUrl(url);
    expect(back.secretKey).toBe(guestKeyId);
    expect(back.keyLevel).toBe(2);
  });

  it("未知 deviceModel は throw", () => {
    expect(() => buildShareKeyUrl({ ...OS3_KEY, deviceModel: "__nope__" }, { keyLevel: 0 }))
      .toThrow(/未知の deviceModel/);
  });

  it("必須 hex フィールド欠落は throw", () => {
    const { keyIndex, ...noKeyIndex } = OS3_KEY;
    expect(() => buildShareKeyUrl(noKeyIndex, { keyLevel: 0 })).toThrow(/keyIndex required/);
  });

  // ---- BIZ-09: biz3utils.js:127-131 と 1:1 (参照に無いフォールバックを置かない) ----

  it("l は opts.keyLevel のみ — deviceKey.keyLevel へフォールバックしない (biz3utils.js:131)", () => {
    // OS3_KEY.keyLevel = 0 だが opts 未指定なら biz3 同様 'undefined' が埋まる。
    const url = buildShareKeyUrl(OS3_KEY, {});
    const p = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(p.get("l")).toBe("undefined");
  });

  it("n は name || deviceKey.deviceName。両欠落時は biz3 同様 'undefined' (biz3utils.js:127 1:1)", () => {
    const { deviceName, ...noName } = OS3_KEY;
    const url = buildShareKeyUrl(noName, { keyLevel: 0 });
    const p = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(p.get("n")).toBe("undefined");
  });
});

describe("parseShareKeyUrl (round-trip)", () => {
  it("OS3 鍵を encode → decode して全フィールド復元", () => {
    const url = buildShareKeyUrl(OS3_KEY, { keyLevel: 1, name: "テスト" });
    const back = parseShareKeyUrl(url);
    expect(back.secretKey).toBe(OS3_KEY.secretKey);
    expect(back.sesame2PublicKey).toBe(OS3_KEY.sesame2PublicKey);
    expect(back.keyIndex).toBe(OS3_KEY.keyIndex);
    expect(back.deviceUUID).toBe(OS3_KEY.deviceUUID); // 大文字 + ハイフン整形
    expect(back.deviceModel).toBe("sesame_5");
    expect(back.deviceName).toBe("テスト");
    expect(back.keyLevel).toBe(1);
  });

  it("sk の '+' が空白化していても復元できる (biz3 互換)", () => {
    const url = buildShareKeyUrl(OS3_KEY, { keyLevel: 0 });
    const spaced = url.replace(/\+/g, " ");
    const back = parseShareKeyUrl(spaced);
    expect(back.secretKey).toBe(OS3_KEY.secretKey);
  });

  it("sk param が無ければ throw", () => {
    expect(() => parseShareKeyUrl("ssm://UI?t=sk&l=0")).toThrow(/sk param not found/);
  });

  it("l 欠落時の keyLevel は NaN (biz3utils.js:189 parseInt の 1:1。null には倒さない)", () => {
    // l パラメータを落とした URL を作る。
    const url = buildShareKeyUrl(OS3_KEY, { keyLevel: 0 });
    const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    const noL = `ssm://UI?t=sk&sk=${encodeURIComponent(params.get("sk"))}`;
    const back = parseShareKeyUrl(noL);
    expect(Number.isNaN(back.keyLevel)).toBe(true);
  });
});

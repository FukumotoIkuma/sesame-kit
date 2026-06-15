// sk-c0.test.js — SK-0001 〜 SK-0018 統合 TDD spec テスト
//
// 参照ベクタ:
//   references_web/src/utils/biz3utils.js:107-213 (generateInviteGuestQRCodeByInfo, readQrcode,
//                                                   generateUserQRCodeBySubUUID, readUserQrcode)
//   references_web/src/constants/qrType.js:2-4
//   packages/core/src/sharekey.js (実装)
//   packages/core/src/vendor/biz3/constants/sesameDeviceModel.js (productType 対応表)
//
// 方針:
//   - 各 spec につき 1 個以上の it を書き、タイトル先頭に [<ID>] を置く。
//   - assert は spec どおりの期待値を検証 (実装の現状に合わせて歪めない)。
//   - ネットワーク/実機に触れない。全て純関数で決定的に動く。
//   - ファイル自己完結 (先頭 import、describe でまとめ、各 it 独立)。

import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import {
  buildShareKeyUrl,
  parseShareKeyUrl,
  buildFriendQrUrl,
  parseFriendQrUrl,
} from "../../src/sharekey.js";

// ---------------------------------------------------------------------------
// テスト用フィクスチャ
// ---------------------------------------------------------------------------

// OS3 機種: sesame_5 = productType 5 (isSesameOs3 = true, 5-5>=0)
const OS3_MODEL = "sesame_5";
const OS3_PRODUCT_TYPE = 5; // 0x05

// OS2 機種: sesame_4 = productType 4 (isSesameOs3 = false, 4-5<0)
const OS2_MODEL = "sesame_4";
const OS2_PRODUCT_TYPE = 4; // 0x04

// 16バイト(hex 32文字) secretKey
const SECRET_KEY = "0102030405060708090a0b0c0d0e0f10";
// OS3 pubkey: 4バイト(hex 8文字)
const OS3_PUB_KEY = "aabbccdd";
// OS2 pubkey: 64バイト(hex 128文字)
const OS2_PUB_KEY = "ab".repeat(64);
// keyIndex: 2バイト(hex 4文字)
const KEY_INDEX = "0001";
// deviceUUID (ハイフン付き小文字)
const DEVICE_UUID = "12345678-abcd-ef01-2345-678901234567";
// ハイフン除去済み
const DEVICE_UUID_NOHYPHEN = DEVICE_UUID.replace(/-/g, "");
// 正規化後 (大文字+ハイフン)
const DEVICE_UUID_NORMALIZED = "12345678-ABCD-EF01-2345-678901234567";

const DEVICE_NAME = "My Lock";

/** OS3 用 deviceKey */
function makeOs3Key(overrides = {}) {
  return {
    deviceModel: OS3_MODEL,
    secretKey: SECRET_KEY,
    sesame2PublicKey: OS3_PUB_KEY,
    keyIndex: KEY_INDEX,
    deviceUUID: DEVICE_UUID,
    deviceName: DEVICE_NAME,
    ...overrides,
  };
}

/** OS2 用 deviceKey */
function makeOs2Key(overrides = {}) {
  return {
    deviceModel: OS2_MODEL,
    secretKey: SECRET_KEY,
    sesame2PublicKey: OS2_PUB_KEY,
    keyIndex: KEY_INDEX,
    deviceUUID: DEVICE_UUID,
    deviceName: DEVICE_NAME,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildShareKeyUrl テスト
// ---------------------------------------------------------------------------

describe("buildShareKeyUrl", () => {
  // SK-0001: URL 骨格 ssm://UI?t=sk&sk=&l=&n= の組み立て
  it("[SK-0001] URL 骨格 ssm://UI?t=sk&sk=&l=&n= が biz3 generateInviteGuestQRCodeByInfo と 1:1", () => {
    const key = makeOs3Key();
    const url = buildShareKeyUrl(key, { keyLevel: 0, name: "Test" });

    // スキーム+ホスト部: ssm://UI (スラッシュ無し、friend の ssm://UI/ と異なる)
    expect(url.startsWith("ssm://UI?")).toBe(true);

    // クエリ部をパース
    const qIdx = url.indexOf("?");
    const qs = url.slice(qIdx + 1);
    const params = new URLSearchParams(qs);

    // t=sk 固定
    expect(params.get("t")).toBe("sk");
    // sk が base64 文字列として存在する
    expect(params.get("sk")).toBeTruthy();
    // l= が keyLevel
    expect(params.get("l")).toBe("0");
    // n= が name
    expect(params.get("n")).toBe("Test");

    // パラメータ順: t, sk, l, n の 4 param を & 連結 (biz3utils.js:127-134 と 1:1)
    const parts = qs.split("&");
    expect(parts[0]).toMatch(/^t=/);
    expect(parts[1]).toMatch(/^sk=/);
    expect(parts[2]).toMatch(/^l=/);
    expect(parts[3]).toMatch(/^n=/);
    expect(parts).toHaveLength(4);
  });

  // SK-0002: sk バイト列レイアウト deviceModel(1B)+secretKey(16B)+pubKey+keyIndex(2B)+deviceUUID
  it("[SK-0002] sk base64 のバイト列レイアウト: deviceModelHex+secretKey+sesame2PublicKey+keyIndex+deviceUUID(ハイフン除去)", () => {
    const key = makeOs3Key();
    const url = buildShareKeyUrl(key, { keyLevel: 0 });

    const qs = url.slice("ssm://UI?".length);
    const params = new URLSearchParams(qs);
    const skB64 = params.get("sk");

    // base64 デコード
    const decoded = Buffer.from(skB64, "base64");

    // 先頭バイト = productType = 5
    expect(decoded[0]).toBe(OS3_PRODUCT_TYPE);

    // 連結 hex を手動で組み立て
    const expectedHex =
      OS3_PRODUCT_TYPE.toString(16).padStart(2, "0") +
      SECRET_KEY +
      OS3_PUB_KEY +
      KEY_INDEX +
      DEVICE_UUID_NOHYPHEN;
    const expectedBytes = Buffer.from(expectedHex, "hex");

    expect(decoded.equals(expectedBytes)).toBe(true);

    // secretKey が bytes[1..17]
    expect(decoded.slice(1, 17).toString("hex")).toBe(SECRET_KEY);
  });

  // SK-0003: deviceModel→productType 解決が biz3 modelNameByProductType 逆引きと一致
  it("[SK-0003] deviceModel→productType 逆引き: sesame_5→5, sesame_6→20, sesame_4→4 がバイト先頭に反映される", () => {
    // sesame_5 → productType=5
    const os3Key = makeOs3Key();
    const url3 = buildShareKeyUrl(os3Key, { keyLevel: 0 });
    const data3 = Buffer.from(new URLSearchParams(url3.slice("ssm://UI?".length)).get("sk"), "base64");
    expect(data3[0]).toBe(5);

    // sesame_6 → productType=20 (OS3 機種なので pubKey は 4B)
    const os6Key = { ...makeOs3Key(), deviceModel: "sesame_6", sesame2PublicKey: OS3_PUB_KEY };
    const url6 = buildShareKeyUrl(os6Key, { keyLevel: 0 });
    const data6 = Buffer.from(new URLSearchParams(url6.slice("ssm://UI?".length)).get("sk"), "base64");
    expect(data6[0]).toBe(20);

    // sesame_4 → productType=4 (OS2)
    const key4 = makeOs2Key();
    const url4 = buildShareKeyUrl(key4, { keyLevel: 0 });
    const data4 = Buffer.from(new URLSearchParams(url4.slice("ssm://UI?".length)).get("sk"), "base64");
    expect(data4[0]).toBe(4);
  });

  // SK-0004: guestKeyId 指定時は secretKey 位置を上書き
  it("[SK-0004] guestKeyId 指定時は keydata の secretKey 位置に guestKeyId が入る", () => {
    const guestKeyId = "ffeebbaa99887766554433221100aabb";
    const key = makeOs3Key();
    const url = buildShareKeyUrl(key, { keyLevel: 2, guestKeyId });

    const qs = url.slice("ssm://UI?".length);
    const params = new URLSearchParams(qs);
    const decoded = Buffer.from(params.get("sk"), "base64");

    // bytes[1..17] が guestKeyId
    expect(decoded.slice(1, 17).toString("hex")).toBe(guestKeyId);

    // guestKeyId 未指定時は deviceKey.secretKey が使われる
    const urlOwner = buildShareKeyUrl(key, { keyLevel: 0 });
    const decodedOwner = Buffer.from(
      new URLSearchParams(urlOwner.slice("ssm://UI?".length)).get("sk"),
      "base64"
    );
    expect(decodedOwner.slice(1, 17).toString("hex")).toBe(SECRET_KEY);
  });

  // SK-0005: l=opts.keyLevel のみ・n=name||deviceName・両欠落で encodeURIComponent(undefined)='undefined'
  it("[SK-0005] l= は opts.keyLevel のみ / n= は name||deviceName / 両欠落で n=undefined", () => {
    const key = makeOs3Key({ deviceName: "DevName" });

    // keyLevel 未指定 → 'l=undefined'
    const urlNoLevel = buildShareKeyUrl(key, { name: "SomeName" });
    expect(urlNoLevel).toContain("l=undefined");

    // keyLevel=0 → 'l=0'
    const url0 = buildShareKeyUrl(key, { keyLevel: 0, name: "x" });
    expect(url0).toContain("l=0");

    // keyLevel=2 → 'l=2'
    const url2 = buildShareKeyUrl(key, { keyLevel: 2, name: "x" });
    expect(url2).toContain("l=2");

    // name 指定 → n=name
    const urlWithName = buildShareKeyUrl(key, { keyLevel: 1, name: "OverrideName" });
    const p1 = new URLSearchParams(urlWithName.slice("ssm://UI?".length));
    expect(p1.get("n")).toBe("OverrideName");

    // name 未指定 → deviceName フォールバック
    const urlDevName = buildShareKeyUrl(key, { keyLevel: 0 });
    const p2 = new URLSearchParams(urlDevName.slice("ssm://UI?".length));
    expect(p2.get("n")).toBe("DevName");

    // name も deviceName も無し → encodeURIComponent(undefined) = 'undefined'
    const keyNoName = makeOs3Key({ deviceName: undefined });
    const urlNoName = buildShareKeyUrl(keyNoName, { keyLevel: 0 });
    expect(urlNoName).toContain("n=undefined");
  });

  // SK-0006: 未知 deviceModel は badRequest(org.sharekey.unknownDeviceModel)
  it("[SK-0006] deviceKey 無しで throw / 未知 deviceModel で badRequest(org.sharekey.unknownDeviceModel)", () => {
    // deviceKey 無し
    expect(() => buildShareKeyUrl(null)).toThrow(/deviceKey required/);
    expect(() => buildShareKeyUrl(undefined)).toThrow(/deviceKey required/);

    // 未知 deviceModel
    const unknownKey = makeOs3Key({ deviceModel: "unknown_model_xyz" });
    expect(() => buildShareKeyUrl(unknownKey, { keyLevel: 0 })).toThrow(
      /unknownDeviceModel|unknown|deviceModel/i
    );
  });

  // SK-0007: 必須 hex フィールド欠落は badRequest(org.sharekey.fieldRequired)
  it("[SK-0007] 必須 hex フィールド欠落は badRequest(org.sharekey.fieldRequired) を throw", () => {
    // secretKey 欠落 (guestKeyId 未指定時)
    expect(() =>
      buildShareKeyUrl(makeOs3Key({ secretKey: undefined }), { keyLevel: 0 })
    ).toThrow();

    // sesame2PublicKey 欠落
    expect(() =>
      buildShareKeyUrl(makeOs3Key({ sesame2PublicKey: undefined }), { keyLevel: 0 })
    ).toThrow();

    // keyIndex 欠落
    expect(() =>
      buildShareKeyUrl(makeOs3Key({ keyIndex: undefined }), { keyLevel: 0 })
    ).toThrow();

    // deviceUUID 欠落
    expect(() =>
      buildShareKeyUrl(makeOs3Key({ deviceUUID: undefined }), { keyLevel: 0 })
    ).toThrow();

    // guestKeyId 指定時は secretKey 欠落でも throw しない
    const guestKeyId = "ffeebbaa99887766554433221100aabb";
    expect(() =>
      buildShareKeyUrl(makeOs3Key({ secretKey: undefined }), { keyLevel: 2, guestKeyId })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseShareKeyUrl テスト
// ---------------------------------------------------------------------------

describe("parseShareKeyUrl", () => {
  // SK-0008: OS3 バイトスライス
  it("[SK-0008] OS3(productType-5>=0) の byte スライス secretKey16/pubKey4/keyIndex2/deviceUUID残り が biz3 と一致", () => {
    // OS3 バイト列を手動で組み立て (round-trip でなく raw bytes から確認)
    const raw = Buffer.concat([
      Buffer.from([OS3_PRODUCT_TYPE]),
      Buffer.from(SECRET_KEY, "hex"),
      Buffer.from(OS3_PUB_KEY, "hex"),
      Buffer.from(KEY_INDEX, "hex"),
      Buffer.from(DEVICE_UUID_NOHYPHEN, "hex"),
    ]);
    const sk = raw.toString("base64");
    const url = `ssm://UI?t=sk&sk=${encodeURIComponent(sk)}&l=0&n=Test`;

    const result = parseShareKeyUrl(url);

    expect(result.secretKey).toBe(SECRET_KEY);
    expect(result.sesame2PublicKey).toBe(OS3_PUB_KEY); // 4B hex = 8 chars
    expect(result.keyIndex).toBe(KEY_INDEX);
    // deviceUUID は大文字+ハイフン正規化
    expect(result.deviceUUID).toBe(DEVICE_UUID_NORMALIZED);
  });

  // SK-0009: OS2 固定バイトスライス
  it("[SK-0009] OS2(productType-5<0) の固定 byte スライス secretKey16/pubKey64/keyIndex2/deviceUUID16 が biz3 と一致", () => {
    const raw = Buffer.concat([
      Buffer.from([OS2_PRODUCT_TYPE]),
      Buffer.from(SECRET_KEY, "hex"),
      Buffer.from(OS2_PUB_KEY, "hex"), // 64B
      Buffer.from(KEY_INDEX, "hex"),
      Buffer.from(DEVICE_UUID_NOHYPHEN, "hex"),
    ]);
    const sk = raw.toString("base64");
    const url = `ssm://UI?t=sk&sk=${encodeURIComponent(sk)}&l=1&n=Lock`;

    const result = parseShareKeyUrl(url);

    expect(result.secretKey).toBe(SECRET_KEY);
    expect(result.sesame2PublicKey).toBe(OS2_PUB_KEY); // 64B hex = 128 chars
    expect(result.sesame2PublicKey.length).toBe(128);
    expect(result.keyIndex).toBe(KEY_INDEX);
    expect(result.deviceUUID).toBe(DEVICE_UUID_NORMALIZED);
  });

  // SK-0010: sk base64 の ' '→'+' 復元 (biz3utils.js:173)
  it("[SK-0010] sk の空白→'+' 復元 (biz3utils.js:173 の sk.replace(/ /g,'+') 相当)", () => {
    // OS3 バイト列で正常 base64 を作り、'+' を空白に置換して URL に埋め込む
    const raw = Buffer.concat([
      Buffer.from([OS3_PRODUCT_TYPE]),
      Buffer.from(SECRET_KEY, "hex"),
      Buffer.from(OS3_PUB_KEY, "hex"),
      Buffer.from(KEY_INDEX, "hex"),
      Buffer.from(DEVICE_UUID_NOHYPHEN, "hex"),
    ]);
    const skOriginal = raw.toString("base64");
    // '+' → 空白に置換して URL に埋め込む (クエリエンコード崩れのシミュレーション)
    const skWithSpaces = skOriginal.replace(/\+/g, " ");
    // URLSearchParams 経由で渡すとスペースが維持される
    const params = new URLSearchParams({ t: "sk", sk: skWithSpaces, l: "0", n: "X" });
    const url = `ssm://UI?${params.toString()}`;

    // parse が空白→'+' 変換で正しく base64 デコードできる
    const result = parseShareKeyUrl(url);
    expect(result.secretKey).toBe(SECRET_KEY);
    expect(result.sesame2PublicKey).toBe(OS3_PUB_KEY);
  });

  // SK-0011: deviceUUID の 8-4-4-4-12 ハイフン挿入 + 大文字化
  it("[SK-0011] deviceUUID が (\\w{8})(\\w{4})(\\w{4})(\\w{4})(\\w{12}) → '$1-$2-$3-$4-$5' + toUpperCase", () => {
    const raw = Buffer.concat([
      Buffer.from([OS3_PRODUCT_TYPE]),
      Buffer.from(SECRET_KEY, "hex"),
      Buffer.from(OS3_PUB_KEY, "hex"),
      Buffer.from(KEY_INDEX, "hex"),
      Buffer.from(DEVICE_UUID_NOHYPHEN, "hex"),
    ]);
    const sk = raw.toString("base64");
    const url = `ssm://UI?t=sk&sk=${encodeURIComponent(sk)}&l=0&n=X`;

    const result = parseShareKeyUrl(url);

    // 8-4-4-4-12 形式かつ大文字
    expect(result.deviceUUID).toMatch(
      /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/
    );
    expect(result.deviceUUID).toBe(DEVICE_UUID_NORMALIZED);
  });

  // SK-0012: 返却フィールド集合と各値の出所 (keyLevel=parseInt(l) で NaN 維持)
  it("[SK-0012] 返却フィールド集合と各値の出所が biz3 qrKeyInfo と 1:1 / l 欠落・非数値は NaN", () => {
    const raw = Buffer.concat([
      Buffer.from([OS3_PRODUCT_TYPE]),
      Buffer.from(SECRET_KEY, "hex"),
      Buffer.from(OS3_PUB_KEY, "hex"),
      Buffer.from(KEY_INDEX, "hex"),
      Buffer.from(DEVICE_UUID_NOHYPHEN, "hex"),
    ]);
    const sk = raw.toString("base64");

    // l 数値あり
    const url = `ssm://UI?t=sk&sk=${encodeURIComponent(sk)}&l=1&n=MyLock`;
    const result = parseShareKeyUrl(url);

    // キー集合チェック
    expect(Object.keys(result).sort()).toEqual(
      ["secretKey", "keyIndex", "sesame2PublicKey", "keyLevel", "deviceModel", "deviceName", "deviceUUID"].sort()
    );

    expect(result.secretKey).toBe(SECRET_KEY);
    expect(result.sesame2PublicKey).toBe(OS3_PUB_KEY);
    expect(result.keyIndex).toBe(KEY_INDEX);
    expect(result.keyLevel).toBe(1);
    expect(result.deviceModel).toBe(OS3_MODEL); // modelNameByProductType[5] = 'sesame_5'
    expect(result.deviceName).toBe("MyLock");
    expect(result.deviceUUID).toBe(DEVICE_UUID_NORMALIZED);

    // l 欠落 → NaN (null に倒さない。biz3utils.js:189 と 1:1)
    const urlNoL = `ssm://UI?t=sk&sk=${encodeURIComponent(sk)}&n=X`;
    const resNoL = parseShareKeyUrl(urlNoL);
    expect(Number.isNaN(resNoL.keyLevel)).toBe(true);

    // l 非数値 → NaN
    const urlNonNum = `ssm://UI?t=sk&sk=${encodeURIComponent(sk)}&l=abc&n=X`;
    const resNonNum = parseShareKeyUrl(urlNonNum);
    expect(Number.isNaN(resNonNum.keyLevel)).toBe(true);

    // 未知 productType の deviceModel は null (biz3utils.js:185: ??null)
    const fakeData = Buffer.alloc(99);
    fakeData[0] = 255; // unknown productType (255)
    const fakeSk = fakeData.toString("base64");
    const fakeUrl = `ssm://UI?t=sk&sk=${encodeURIComponent(fakeSk)}&l=0&n=Test`;
    const fakeResult = parseShareKeyUrl(fakeUrl);
    expect(fakeResult.deviceModel).toBeNull();
  });

  // SK-0013: url falsy / sk param 欠落で throw
  it("[SK-0013] url が falsy なら badRequest('url required') / sk 欠落で throw / t パラメータは検証しない", () => {
    // url falsy
    expect(() => parseShareKeyUrl("")).toThrow(/url required/);
    expect(() => parseShareKeyUrl(/** @type {any} */ (null))).toThrow(/url required/);
    expect(() => parseShareKeyUrl(/** @type {any} */ (undefined))).toThrow(/url required/);

    // sk 欠落
    expect(() => parseShareKeyUrl("ssm://UI?t=sk&l=0&n=Test")).toThrow(/sk param not found/);

    // t パラメータは検証しない: t=friend でも sk があれば share-key として解釈する
    const raw = Buffer.concat([
      Buffer.from([OS3_PRODUCT_TYPE]),
      Buffer.from(SECRET_KEY, "hex"),
      Buffer.from(OS3_PUB_KEY, "hex"),
      Buffer.from(KEY_INDEX, "hex"),
      Buffer.from(DEVICE_UUID_NOHYPHEN, "hex"),
    ]);
    const sk = raw.toString("base64");
    const urlFriendWithSk = `ssm://UI?t=friend&sk=${encodeURIComponent(sk)}&l=0&n=X`;
    expect(() => parseShareKeyUrl(urlFriendWithSk)).not.toThrow();
  });

  // SK-0014: isSesameOs3 判定境界 productType-5>=0
  it("[SK-0014] isSesameOs3 境界: productType<5→OS2(pubkey 64B) / productType>=5→OS3(pubkey 4B)", () => {
    // productType=4 (sesame_4) → OS2 → pubkey 64B
    const rawOs2 = Buffer.concat([
      Buffer.from([4]),
      Buffer.from(SECRET_KEY, "hex"),
      Buffer.from(OS2_PUB_KEY, "hex"), // 64B
      Buffer.from(KEY_INDEX, "hex"),
      Buffer.from(DEVICE_UUID_NOHYPHEN, "hex"),
    ]);
    const skOs2 = rawOs2.toString("base64");
    const urlOs2 = `ssm://UI?t=sk&sk=${encodeURIComponent(skOs2)}&l=0&n=X`;
    const resOs2 = parseShareKeyUrl(urlOs2);
    expect(resOs2.sesame2PublicKey).toBe(OS2_PUB_KEY);
    expect(resOs2.sesame2PublicKey).toHaveLength(128); // 64 bytes = 128 hex chars
    // productType=4 は OS2 (4-5 < 0)
    expect(4 - 5 >= 0).toBe(false);

    // productType=5 (sesame_5) → OS3 最小値 → pubkey 4B
    const rawOs3 = Buffer.concat([
      Buffer.from([5]),
      Buffer.from(SECRET_KEY, "hex"),
      Buffer.from(OS3_PUB_KEY, "hex"), // 4B
      Buffer.from(KEY_INDEX, "hex"),
      Buffer.from(DEVICE_UUID_NOHYPHEN, "hex"),
    ]);
    const skOs3 = rawOs3.toString("base64");
    const urlOs3 = `ssm://UI?t=sk&sk=${encodeURIComponent(skOs3)}&l=0&n=X`;
    const resOs3 = parseShareKeyUrl(urlOs3);
    expect(resOs3.sesame2PublicKey).toBe(OS3_PUB_KEY);
    expect(resOs3.sesame2PublicKey).toHaveLength(8); // 4 bytes = 8 hex chars
    // productType=5 が OS3 最小 (isSesameOs3(5) = 5-5>=0 = true)
    expect(5 - 5 >= 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildShareKeyUrl → parseShareKeyUrl round-trip テスト
// ---------------------------------------------------------------------------

describe("buildShareKeyUrl → parseShareKeyUrl round-trip", () => {
  // SK-0015: round-trip (OS3 / OS2)
  it("[SK-0015] OS3 owner(l=0) round-trip: 全フィールド復元 + deviceUUID 大文字+ハイフン正規化", () => {
    const key = makeOs3Key({ deviceName: "RoundLock" });
    const url = buildShareKeyUrl(key, { keyLevel: 0, name: "RoundLock" });
    const result = parseShareKeyUrl(url);

    expect(result.secretKey).toBe(SECRET_KEY);
    expect(result.sesame2PublicKey).toBe(OS3_PUB_KEY);
    expect(result.keyIndex).toBe(KEY_INDEX);
    expect(result.keyLevel).toBe(0);
    expect(result.deviceModel).toBe(OS3_MODEL);
    expect(result.deviceName).toBe("RoundLock");
    // 入力 UUID が小文字+ハイフンでも大文字+ハイフンに正規化される
    expect(result.deviceUUID).toBe(DEVICE_UUID_NORMALIZED);
  });

  it("[SK-0015] OS3 manager(l=1) round-trip", () => {
    const key = makeOs3Key();
    const url = buildShareKeyUrl(key, { keyLevel: 1 });
    const result = parseShareKeyUrl(url);

    expect(result.keyLevel).toBe(1);
    expect(result.secretKey).toBe(SECRET_KEY);
    expect(result.sesame2PublicKey).toBe(OS3_PUB_KEY);
  });

  it("[SK-0015] OS2 round-trip: 全フィールド復元", () => {
    const key = makeOs2Key({ deviceName: "OldLock" });
    const url = buildShareKeyUrl(key, { keyLevel: 0, name: "OldLock" });
    const result = parseShareKeyUrl(url);

    expect(result.secretKey).toBe(SECRET_KEY);
    expect(result.sesame2PublicKey).toBe(OS2_PUB_KEY);
    expect(result.keyIndex).toBe(KEY_INDEX);
    expect(result.keyLevel).toBe(0);
    expect(result.deviceModel).toBe(OS2_MODEL);
    expect(result.deviceName).toBe("OldLock");
    expect(result.deviceUUID).toBe(DEVICE_UUID_NORMALIZED);
  });

  // SK-0016: guestKeyId round-trip で secretKey 位置に復元 (guest l=2)
  it("[SK-0016] guestKeyId round-trip: parsed.secretKey に guestKeyId, keyLevel=2", () => {
    const guestKeyId = "deadbeefcafebabe0102030405060708";
    const key = makeOs3Key();
    const url = buildShareKeyUrl(key, { keyLevel: 2, guestKeyId, name: "Guest" });
    const result = parseShareKeyUrl(url);

    // parse 側は sk バイト位置から復元するので guestKeyId が secretKey として返る
    expect(result.secretKey).toBe(guestKeyId);
    expect(result.keyLevel).toBe(2);
    expect(result.sesame2PublicKey).toBe(OS3_PUB_KEY);
    expect(result.keyIndex).toBe(KEY_INDEX);
  });
});

// ---------------------------------------------------------------------------
// buildFriendQrUrl テスト
// ---------------------------------------------------------------------------

describe("buildFriendQrUrl", () => {
  const SUBUUID = "aaaabbbb-cccc-dddd-eeee-ffffabcd1234";

  // SK-0017: wire ssm://UI/?t=friend&friend=<subUUID 大文字>
  it("[SK-0017] ssm://UI/?t=friend&friend=<subUUID 大文字> を生成する (biz3utils.js:107-112)", () => {
    const url = buildFriendQrUrl(SUBUUID);
    // スラッシュ有り (share-key の 'ssm://UI?' とは異なる)
    expect(url.startsWith("ssm://UI/?")).toBe(true);
    expect(url).toBe(`ssm://UI/?t=friend&friend=${SUBUUID.toUpperCase()}`);
  });

  it("[SK-0017] subUUID falsy で badRequest('sharekey.err.subUUIDRequired') を throw", () => {
    expect(() => buildFriendQrUrl("")).toThrow();
    expect(() => buildFriendQrUrl(/** @type {any} */ (null))).toThrow();
    expect(() => buildFriendQrUrl(/** @type {any} */ (undefined))).toThrow();
  });

  it("[SK-0017] 既に大文字の入力でも toUpperCase は冪等", () => {
    const upper = SUBUUID.toUpperCase();
    const url = buildFriendQrUrl(upper);
    expect(url).toBe(`ssm://UI/?t=friend&friend=${upper}`);
  });
});

// ---------------------------------------------------------------------------
// parseFriendQrUrl テスト
// ---------------------------------------------------------------------------

describe("parseFriendQrUrl", () => {
  const SUBUUID = "aaaabbbb-cccc-dddd-eeee-ffffabcd1234";

  // SK-0018: friendID を小文字で返す / t!=='friend' または friend 欠落で throw
  it("[SK-0018] t=friend & friend 有りで {friendID: friend.toLowerCase()} を返す (biz3utils.js:157-159)", () => {
    const url = buildFriendQrUrl(SUBUUID);
    const result = parseFriendQrUrl(url);
    expect(result).toEqual({ friendID: SUBUUID.toLowerCase() });
    expect(result.friendID).toBe(SUBUUID.toLowerCase());
  });

  it("[SK-0018] friendID は常に小文字 (大文字 UUID 入力でも toLowerCase)", () => {
    const url = `ssm://UI/?t=friend&friend=AABBCCDD-EEFF-0011-2233-445566778899`;
    const { friendID } = parseFriendQrUrl(url);
    expect(friendID).toBe("aabbccdd-eeff-0011-2233-445566778899");
  });

  it("[SK-0018] t=sk は t!=='friend' なので badRequest('sharekey.err.invalidFriendQr') を throw", () => {
    const url = `ssm://UI?t=sk&sk=SOME_SK_PAYLOAD`;
    expect(() => parseFriendQrUrl(url)).toThrow(/friend QR URL|invalidFriendQr/i);
  });

  it("[SK-0018] t=matter は throw", () => {
    const url = `ssm://UI/?t=matter&matter=foo`;
    expect(() => parseFriendQrUrl(url)).toThrow(/friend QR URL|invalidFriendQr/i);
  });

  it("[SK-0018] t=friend でも friend パラメータ欠落なら throw (biz3utils.js:153)", () => {
    const url = `ssm://UI/?t=friend`;
    expect(() => parseFriendQrUrl(url)).toThrow(/friend QR URL|invalidFriendQr/i);
  });

  it("[SK-0018] url falsy で badRequest('sharekey.err.friendQrUrlRequired') を throw", () => {
    expect(() => parseFriendQrUrl("")).toThrow();
    expect(() => parseFriendQrUrl(/** @type {any} */ (null))).toThrow();
    expect(() => parseFriendQrUrl(/** @type {any} */ (undefined))).toThrow();
  });
});

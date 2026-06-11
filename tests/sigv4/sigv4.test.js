// src/sigv4.js — AWS Signature Version 4 自前実装の既知ベクタテスト。
//
// 期待値の出典 (REFACTORING_PLAN P2-1 手順 2「既知ベクタテストを必ず付ける」):
//   (A) AWS General Reference「Signature Version 4 signing process」掲載の IAM ListUsers 例。
//       固定日時 20150830T123600Z・固定鍵 AKIDEXAMPLE / wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY
//       に対する canonical request hash / string-to-sign / signing key / signature が
//       ドキュメントに hex で明記されている。下の EXPECTED_* 定数はそのままの転記。
//   (B) AWS SigV4 test suite (aws-sig-v4-test-suite) の get-vanilla / post-vanilla
//       (host=example.amazonaws.com, region=us-east-1, service=service, 同上の固定日時・固定鍵)。
//       canonical request はスイートの .creq ファイルの形をテスト内に literal で再掲し、
//       node:crypto の HMAC 連鎖だけで独立に signature を導出して突き合わせる
//       (実装の URL パース/ヘッダ正規化と、署名計算の両方を別経路で検証する)。
//
// 導出の確認手順 (コメントとして記録):
//   canonical request → sha256 hex → string-to-sign:
//     "AWS4-HMAC-SHA256\n<amzDate>\n<date>/<region>/<service>/aws4_request\n<hash>"
//   signing key = HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request")
//   signature   = HMAC(signingKey, string-to-sign) の hex
import { describe, it, expect } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { signRequest, deriveSigningKey, sha256Hex } from "../../src/sigv4.js";

const ACCESS_KEY = "AKIDEXAMPLE";
const SECRET_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const FIXED_DATE = new Date("2015-08-30T12:36:00Z"); // 20150830T123600Z
// 空ボディの sha256 (周知の固定値)
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** HMAC-SHA256 (テスト側の独立実装。src の deriveSigningKey に依存しない検算用) */
function hmac(key, data) {
  return createHmac("sha256", key).update(data, "utf8").digest();
}
/** テスト側の独立した signature 導出 (canonical request 文字列 → signature hex) */
function independentSignature({ canonicalRequest, amzDate, dateStamp, region, service, secret }) {
  const hash = createHash("sha256").update(canonicalRequest).digest("hex");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, `${dateStamp}/${region}/${service}/aws4_request`, hash].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), "aws4_request");
  return createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
}

describe("signRequest — AWS ドキュメント IAM ListUsers 既知ベクタ (出典 A)", () => {
  const signed = signRequest({
    method: "GET",
    url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: "",
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    service: "iam",
    region: "us-east-1",
    date: FIXED_DATE,
  });

  it("canonical request がドキュメントの形と一致する", () => {
    expect(signed.canonicalRequest).toBe(
      [
        "GET",
        "/",
        "Action=ListUsers&Version=2010-05-08",
        "content-type:application/x-www-form-urlencoded; charset=utf-8",
        "host:iam.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "content-type;host;x-amz-date",
        EMPTY_SHA256,
      ].join("\n"),
    );
    // ドキュメント掲載の canonical request hash
    expect(sha256Hex(signed.canonicalRequest)).toBe(
      "f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59",
    );
  });

  it("string-to-sign がドキュメントと一致する", () => {
    expect(signed.stringToSign).toBe(
      [
        "AWS4-HMAC-SHA256",
        "20150830T123600Z",
        "20150830/us-east-1/iam/aws4_request",
        "f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59",
      ].join("\n"),
    );
  });

  it("signing key がドキュメント掲載の hex と一致する", () => {
    expect(
      deriveSigningKey({
        secretAccessKey: SECRET_KEY,
        dateStamp: "20150830",
        region: "us-east-1",
        service: "iam",
      }).toString("hex"),
    ).toBe("c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9");
  });

  it("signature と Authorization ヘッダがドキュメントと一致する", () => {
    expect(signed.signature).toBe(
      "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
    expect(signed.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-date, " +
        "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
    expect(signed.headers["x-amz-date"]).toBe("20150830T123600Z");
    expect(signed.headers.host).toBe("iam.amazonaws.com");
  });
});

describe("signRequest — SigV4 test suite 相当ベクタ (出典 B)", () => {
  it("get-vanilla: GET https://example.amazonaws.com/ (署名 5fa00fa3…)", () => {
    const signed = signRequest({
      method: "GET",
      url: "https://example.amazonaws.com/",
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
      service: "service",
      region: "us-east-1",
      date: FIXED_DATE,
    });
    // test suite get-vanilla.creq:
    //   GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n<empty-sha>
    const creq = [
      "GET",
      "/",
      "",
      "host:example.amazonaws.com",
      "x-amz-date:20150830T123600Z",
      "",
      "host;x-amz-date",
      EMPTY_SHA256,
    ].join("\n");
    expect(signed.canonicalRequest).toBe(creq);
    // 独立導出 (テスト内 HMAC 連鎖) とも、test suite の確定値とも一致すること
    const indep = independentSignature({
      canonicalRequest: creq,
      amzDate: "20150830T123600Z",
      dateStamp: "20150830",
      region: "us-east-1",
      service: "service",
      secret: SECRET_KEY,
    });
    expect(signed.signature).toBe(indep);
    expect(signed.signature).toBe(
      "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("post-vanilla: POST https://example.amazonaws.com/ (署名 5da7c1a2…)", () => {
    const signed = signRequest({
      method: "POST",
      url: "https://example.amazonaws.com/",
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
      service: "service",
      region: "us-east-1",
      date: FIXED_DATE,
    });
    const indep = independentSignature({
      canonicalRequest: [
        "POST",
        "/",
        "",
        "host:example.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "host;x-amz-date",
        EMPTY_SHA256,
      ].join("\n"),
      amzDate: "20150830T123600Z",
      dateStamp: "20150830",
      region: "us-east-1",
      service: "service",
      secret: SECRET_KEY,
    });
    expect(signed.signature).toBe(indep);
    expect(signed.signature).toBe(
      "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
    );
  });
});

describe("signRequest — ヘッダ/クエリ/トークンの canonical 規則", () => {
  const creds = { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY };

  it("sessionToken があれば X-Amz-Security-Token を署名対象ヘッダに含める", () => {
    const signed = signRequest({
      method: "POST",
      url: "https://app.candyhouse.co/prod/device/v1/biometrics",
      headers: { "content-type": "application/json", "x-api-key": "key" },
      body: "{}",
      credentials: { ...creds, sessionToken: "SESSION-TOKEN" },
      date: FIXED_DATE,
    });
    expect(signed.headers["x-amz-security-token"]).toBe("SESSION-TOKEN");
    // SignedHeaders はソート済みで security-token を含む
    expect(signed.signedHeaders).toBe(
      "content-type;host;x-amz-date;x-amz-security-token;x-api-key",
    );
    // 既定 scope は execute-api / ap-northeast-1 (ApiClientConfigBuilder.kt:18 DEFAULT_REGION)
    expect(signed.credentialScope).toBe("20150830/ap-northeast-1/execute-api/aws4_request");
    expect(signed.headers.authorization).toContain(
      "Credential=AKIDEXAMPLE/20150830/ap-northeast-1/execute-api/aws4_request",
    );
  });

  it("クエリはエンコード後のキー → 値でソートされる", () => {
    const signed = signRequest({
      method: "GET",
      url: "https://example.amazonaws.com/?b=2&a=1&a=0",
      credentials: creds,
      service: "service",
      region: "us-east-1",
      date: FIXED_DATE,
    });
    expect(signed.canonicalRequest.split("\n")[2]).toBe("a=0&a=1&b=2");
  });

  it("ヘッダ値は trim + 連続空白の単一化、名前は小文字ソート", () => {
    const signed = signRequest({
      method: "GET",
      url: "https://example.amazonaws.com/",
      headers: { "My-Header": "  a   b  c  " },
      credentials: creds,
      service: "service",
      region: "us-east-1",
      date: FIXED_DATE,
    });
    expect(signed.canonicalRequest).toContain("my-header:a b c\n");
  });

  it("入力バリデーション (method / url / credentials)", () => {
    const base = { method: "GET", url: "https://example.amazonaws.com/", credentials: creds };
    expect(() => signRequest({ ...base, method: "" })).toThrow(/method required/);
    expect(() => signRequest({ ...base, url: "not a url" })).toThrow(/url required/);
    expect(() => signRequest({ ...base, credentials: { accessKeyId: "x" } })).toThrow(/credentials required/);
  });
});

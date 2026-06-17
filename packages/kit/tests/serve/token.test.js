// src/serve/framing/token.js の境界テスト。
// parseBearer は HTTP/WS/gRPC の Bearer 解析の単一実装 (grpc.js metaToken もこれを使う)。
// ReDoS 回帰: 旧 `^Bearer\s+(.+)$` は `Bearer ` + 大量空白でポリノミアル backtracking を起こした。
import { describe, it, expect } from "vitest";
import { parseBearer, extractToken, tokenMatches, generateToken } from "../../src/serve/framing/token.js";

describe("parseBearer", () => {
  it("Bearer scheme から token を取り出す", () => {
    expect(parseBearer("Bearer abc123")).toBe("abc123");
  });

  it("scheme は大文字小文字非区別 (HTTP の慣行)", () => {
    expect(parseBearer("bearer abc")).toBe("abc");
    expect(parseBearer("BEARER abc")).toBe("abc");
  });

  it("Bearer 以外の scheme / scheme 単独 / 非文字列は null", () => {
    expect(parseBearer("Basic abc")).toBeNull();
    expect(parseBearer("Bearer")).toBeNull(); // 空白なし = scheme 形式不成立
    expect(parseBearer("")).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer(123)).toBeNull();
  });

  it("scheme のみで token が空なら空文字 (null ではない)", () => {
    expect(parseBearer("Bearer ")).toBe("");
    expect(parseBearer("Bearer    ")).toBe("");
  });

  it("ReDoS 回帰: 大量空白の Authorization が線形時間で処理される", () => {
    // 旧 regex では 10 万空白で数秒〜ハングした。線形実装なら数 ms。
    const evil = "Bearer" + " ".repeat(100_000) + "x";
    const start = performance.now();
    expect(parseBearer(evil)).toBe("x");
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe("extractToken", () => {
  it("Authorization ヘッダを最優先で使う", () => {
    const req = { headers: { authorization: "Bearer headtoken" }, url: "/?token=querytoken" };
    expect(extractToken(req)).toBe("headtoken");
  });

  it("空 Bearer はクエリにフォールバックしない (空 Bearer の上書き防止)", () => {
    const req = { headers: { authorization: "Bearer " }, url: "/?token=querytoken" };
    expect(extractToken(req)).toBe("");
  });

  it("ヘッダ無しなら ?token= クエリ (ブラウザ専用フォールバック)", () => {
    expect(extractToken({ headers: {}, url: "/sub?token=qt" })).toBe("qt");
  });

  it("ヘッダもクエリも無ければ空文字", () => {
    expect(extractToken({ headers: {}, url: "/" })).toBe("");
    expect(extractToken({ headers: {} })).toBe("");
  });
});

describe("tokenMatches", () => {
  it("一致 / 不一致 / 長さ不一致 / 型不正", () => {
    const tok = generateToken();
    expect(tokenMatches(tok, tok)).toBe(true);
    expect(tokenMatches(tok, generateToken())).toBe(false);
    expect(tokenMatches("short", tok)).toBe(false); // 長さ不一致は即 false
    expect(tokenMatches(undefined, tok)).toBe(false);
    expect(tokenMatches(tok, null)).toBe(false);
  });
});

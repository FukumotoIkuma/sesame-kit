// ネットワーク系フレーミング (HTTP/WS/gRPC) 共通の loopback token 認証。
// 同一ユーザの UDS と違い TCP は他プロセス/ブラウザからも届くので、起動時に生成した
// 秘密 token を要求する (CSRF/他ユーザ対策)。比較は定数時間。
import { randomBytes, timingSafeEqual } from "node:crypto";

/** 32byte hex のランダム token。 */
export function generateToken() {
  return randomBytes(32).toString("hex");
}

/** 定数時間比較。長さ不一致は false。 */
export function tokenMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * HTTP リクエストから token を取り出す。**通常は `Authorization: Bearer` ヘッダ**を使うこと。
 * `?token=` クエリは **ブラウザ専用のフォールバック** (EventSource/WebSocket がヘッダを送れないため)。
 * クエリに載せると proxy ログ/履歴に残るので、ヘッダを送れるクライアントは必ずヘッダを使う。
 */
export function extractToken(req) {
  const auth = req.headers?.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1];
  try {
    return new URL(req.url, "http://localhost").searchParams.get("token") || "";
  } catch {
    return "";
  }
}

// ネットワーク系フレーミング (HTTP/WS/gRPC) 共通の loopback token 認証。
// 同一ユーザの UDS と違い TCP は他プロセス/ブラウザからも届くので、起動時に生成した
// 秘密 token を要求する (CSRF/他ユーザ対策)。比較は定数時間。
import { randomBytes, timingSafeEqual } from "node:crypto";

/** 32byte hex のランダム token。 */
export function generateToken() {
  return randomBytes(32).toString("hex");
}

/** 定数時間比較。長さ不一致は false。
 * @param {unknown} provided
 * @param {unknown} expected
 * @returns {boolean}
 */
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
/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {string}
 */
export function extractToken(req) {
  const auth = req.headers?.authorization || "";
  // prefix だけを正規表現で照合し、残りは slice+trim で取る。旧 `^Bearer\s+(.+)$` は
  // `\s+` と捕捉 `.+` の重なりで `Bearer ` + 大量空白に対しポリノミアル backtracking (ReDoS) を
  // 起こした。`\s+` 単体 (後続に重なる量指定子なし) は anchored で線形。Authorization は
  // リモート入力なので重要。
  const m = /^Bearer\s+/i.exec(auth);
  if (m) return auth.slice(m[0].length).trim();
  try {
    return new URL(req.url || "", "http://localhost").searchParams.get("token") || "";
  } catch {
    return "";
  }
}

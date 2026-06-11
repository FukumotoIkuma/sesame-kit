/** 32byte hex のランダム token。 */
export function generateToken(): string;
/** 定数時間比較。長さ不一致は false。
 * @param {unknown} provided
 * @param {unknown} expected
 * @returns {boolean}
 */
export function tokenMatches(provided: unknown, expected: unknown): boolean;
/**
 * Authorization 値から Bearer token を取り出す。HTTP/WS/gRPC の Bearer 解析はここに一本化する
 * (grpc.js が旧禁止 regex を再実装していた重複が修正漏れを生んだため — REFACTORING_PLAN P1-17)。
 * prefix だけを正規表現で照合し、残りは slice+trim で取る。旧 `^Bearer\s+(.+)$` は
 * `\s+` と捕捉 `.+` の重なりで `Bearer ` + 大量空白に対しポリノミアル backtracking (ReDoS) を
 * 起こした。`\s+` 単体 (後続に重なる量指定子なし) は anchored で線形。Authorization は
 * リモート入力なので重要。auth-scheme は HTTP の慣行どおり大文字小文字非区別 (`/i`)。
 * @param {unknown} raw Authorization ヘッダ/metadata の生値
 * @returns {string | null} Bearer scheme でなければ null。scheme のみで token が空なら ""。
 */
export function parseBearer(raw: unknown): string | null;
/**
 * HTTP リクエストから token を取り出す。**通常は `Authorization: Bearer` ヘッダ**を使うこと。
 * `?token=` クエリは **ブラウザ専用のフォールバック** (EventSource/WebSocket がヘッダを送れないため)。
 * クエリに載せると proxy ログ/履歴に残るので、ヘッダを送れるクライアントは必ずヘッダを使う。
 */
/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {string}
 */
export function extractToken(req: import("node:http").IncomingMessage): string;
//# sourceMappingURL=token.d.ts.map
/** 32byte hex のランダム token。 */
export function generateToken(): string;
/** 定数時間比較。長さ不一致は false。 */
export function tokenMatches(provided: any, expected: any): boolean;
/**
 * HTTP リクエストから token を取り出す。**通常は `Authorization: Bearer` ヘッダ**を使うこと。
 * `?token=` クエリは **ブラウザ専用のフォールバック** (EventSource/WebSocket がヘッダを送れないため)。
 * クエリに載せると proxy ログ/履歴に残るので、ヘッダを送れるクライアントは必ずヘッダを使う。
 */
export function extractToken(req: any): string;
//# sourceMappingURL=token.d.ts.map
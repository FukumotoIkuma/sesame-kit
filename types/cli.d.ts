export function run(argv?: string[]): Promise<void>;
/** cloud の device-status (stateInfo) を fmtMech と揃えた 1 行に整形。 */
export function fmtCloudStatus(st: any): any;
/** status 出力から秘匿値 (secretKey) を落とす。status は状態読み取りで鍵は不要。 */
export function sanitizeStatus(st: any): any;
/** config show 用に config を複製し secretKey を**ツリー全体で**マスクする (tokens と同じ扱い)。
 *  config には devices と派生 locks の双方に鍵が入る等、複数箇所に現れるため一律で潰す。
 *  生の鍵が要るときは `sesame devices` (意図的な全ダンプ口) を使う。 */
export function redactConfig(cfg: any): any;
//# sourceMappingURL=cli.d.ts.map
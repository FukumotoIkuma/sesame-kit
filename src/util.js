// モジュール横断の小さな共有ユーティリティ。
// WS op の応答 success 判定 / バリデーション例外 / async push 集約のライフサイクルは
// ほぼ全モジュールで重複していたので 1 箇所に集約する。

import { t } from "./i18n.js";
import { SesameError, ERR } from "./errors.js";

/**
 * WS 応答に共通して現れうるフィールド。op ごとに `data` 等が付くため index 可。
 * @typedef {{ success?: boolean, message?: string, code?: string|number|null }
 *   & Record<string, unknown>} OpResponse
 */

/**
 * WS op の応答 `resp` を検査し、失敗していれば例外を投げる。成功なら resp を返す。
 *
 * biz3 の応答には 2 系統あり、本ライブラリも両方を扱う:
 *   - lenient (既定): `success` フィールドが**明示的に false** の時だけ失敗扱い。
 *     `success` を持たない応答 (data だけ返る op、push 集約の完了通知など) は成功とみなす。
 *   - strict: `success === true` を要求し、欠落していても失敗扱い
 *     (常に success を返すと分かっている op 用)。
 *
 * 失敗時は {@link SesameError} (code=`rejected`) を投げる。これにより serve 層が
 * `error.data.kind=rejected` へ写像でき、ライブラリ直利用者も `err.code` で分岐できる
 * (上流が明示的に失敗を返した = 再試行しても無駄なので retryable=false)。
 *
 * @template {OpResponse|null|undefined} T
 * @param {T} resp           WS 応答メッセージ
 * @param {string} op        失敗時メッセージに使う op ラベル
 * @param {{strict?:boolean}} [opts]
 * @returns {T} 成功時はそのまま resp を返す (呼び出し側で resp.data 等を取り出せる)
 * @throws {SesameError} 失敗時 (code=rejected, `<op> failed: <message|JSON>`)
 */
export function assertSuccess(resp, op, { strict = false } = {}) {
  const failed = strict ? !resp?.success : !resp || resp.success === false;
  if (failed) {
    throw new SesameError(
      t("domain.util.opFailed", { op, detail: resp?.message || JSON.stringify(resp) }),
      { code: ERR.REJECTED, retryable: false, data: { upstreamCode: resp?.code ?? null } },
    );
  }
  return resp;
}

/**
 * 呼び出し側の不正 (引数欠落 / 不明な名前など) を表す {@link SesameError} を生成する。
 * ドメインモジュールのバリデーションで `throw new Error(t(...))` の代わりに使う。
 * serve 層は code=`bad_request` を JSON-RPC `INVALID_PARAMS` / kind=`bad_params` へ写像する。
 *
 * @param {string} key   i18n メッセージキー
 * @param {Record<string, string|number>} [vars] i18n 変数
 * @returns {SesameError}
 */
export function badRequest(key, vars) {
  return new SesameError(t(key, vars), { code: ERR.BAD_REQUEST, retryable: false });
}

/**
 * 応答待ちタイムアウトを表す {@link SesameError} を生成する (code=`timeout`, retryable=true)。
 * @param {string} message 既存文言をそのまま渡す (テスト互換のため caller が組み立てる)
 * @returns {SesameError}
 */
export function timeoutError(message) {
  return new SesameError(message, { code: ERR.TIMEOUT, retryable: true });
}

/**
 * 上流が明示的に失敗を返した等の「拒否」を表す {@link SesameError} を生成する
 * (code=`rejected`, retryable=false)。push 集約系で success:false を検出した時に使う。
 * @param {string} message
 * @param {object|null} [data] 付随情報 (upstreamCode 等)
 * @returns {SesameError}
 */
export function rejected(message, data = null) {
  return new SesameError(message, { code: ERR.REJECTED, retryable: false, data });
}

/**
 * 「フレーム送信 → async push を購読して集約 → 完了通知 or timeout で確定」という
 * biz3 のページング/集約パターンに共通する **ライフサイクル**だけを 1 箇所に集約する。
 *
 * 蓄積規則 (flat list / per-device map / page 置換 等) や完了判定は biz3 の op ごとに
 * 異なるため、ここでは抽象化せず購読ハンドラ (`subscriptions[].onMessage`) に委ねる。
 * 本関数が引き受けるのは「重複していた定型」:
 *   - Promise ラップ / 二重解決ガード (`done`)
 *   - 全購読の unsubscribe + clearTimeout を漏れなく行う cleanup
 *   - timeout 時の reject
 *   - 購読ハンドラ内 throw の捕捉 → reject
 *   - 確定時に `result()` で戻り値を組み立てて resolve
 *
 * 各 `onMessage(msg, finish)` は受信メッセージを自前のクロージャに蓄積し、完了条件を
 * 満たしたら `finish()` を、失敗を検出したら `finish(err)` を呼ぶ。`finish` 呼び出し後の
 * 後続メッセージは無視される (二重解決しない)。
 *
 * errorAction (P3-9, オプトイン): biz3 のハンドラは push op を見る前に **同 action の
 * `success:false` フレーム**を一律で失敗扱いする (useManageDevice.js:27-34 の
 * `if (!message.success)` / useManageEmployee.js:405-412)。push op だけを購読すると、
 * サーバの即時エラー応答 (要求 op で返る) を拾えず timeout に化けてメッセージが失われる。
 * `errorAction` を指定すると、client.onMessage (全受信) で同 action の success:false を
 * 観測した時点で `finish(err)` する。未指定なら従来挙動 (後方互換)。
 * client が onMessage を持たない (狭い fake 等) 場合は黙ってスキップする。
 *
 * partialOnTimeout (BIZ-14 / バックログ6, オプトイン): timeout 時に reject する代わりに、
 * その時点までの集約済み結果へ `partial: true` を付けて resolve する。参照 UI は chunk を
 * 受信のたびに state へ反映するため、完了通知が来なくても部分蓄積が表示され続ける
 * (useManageEmployee.js:70-88 の pubEmployees 蓄積は完了通知に依存しない)。CLI/ライブラリで
 * 同じ「取れた分は返す」を選べるようにする opt-in。既定 (false) は従来どおり reject
 * (後方互換)。このモードでは `result()` は **plain object** を返す契約 (spread で
 * `partial: true` を合成するため。各利用側がオプション指定時に object 形へ切り替える)。
 *
 * @template T
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {object} cfg
 * @param {import("./transport.js").WsFrame} cfg.sendFrame  購読開始のために送るフレーム
 * @param {Array<{key:string, onMessage:(msg:any, finish:(err?:Error)=>void)=>void}>} cfg.subscriptions
 *        dispatch key (`${action}:${op}`) と、その push を処理するハンドラの組。
 * @param {number} cfg.timeoutMs
 * @param {()=>Error} [cfg.onTimeout]                  timeout 時に投げる Error を生成 (既定: 汎用 timeout)
 * @param {string} [cfg.errorAction]                   この action の success:false フレームで finish(err) (オプトイン)
 * @param {boolean} [cfg.partialOnTimeout]             timeout 時に reject せず {partial:true, ...result()} で resolve (オプトイン)
 * @param {()=>T} cfg.result                           成功確定時に resolve する値を組み立てる
 * @returns {Promise<T>}
 */
export function subscribeChunks(client, { sendFrame, subscriptions, timeoutMs, onTimeout, errorAction, partialOnTimeout = false, result }) {
  return new Promise((resolve, reject) => {
    let done = false;
    /** @type {Array<() => void>} */
    const unsubs = [];
    const cleanup = () => {
      clearTimeout(to);
      for (const u of unsubs) {
        try { u(); } catch { /* unsubscribe は冪等扱い */ }
      }
    };
    /** @param {Error} [err] */
    const finish = (err) => {
      if (done) return;
      done = true;
      cleanup();
      if (err) reject(err);
      else resolve(result());
    };
    const to = setTimeout(() => {
      // BIZ-14 (バックログ6): partialOnTimeout 指定時は timeout を失敗にせず、集約済みの
      // 部分結果に partial:true を付けて resolve する (参照 UI は部分蓄積を表示し続ける —
      // useManageEmployee.js:70-88)。done ガード/cleanup は finish と同じ規律を踏む。
      if (partialOnTimeout) {
        if (done) return;
        done = true;
        cleanup();
        resolve(/** @type {T} */ (/** @type {unknown} */ ({ ...result(), partial: true })));
        return;
      }
      finish(onTimeout ? onTimeout() : timeoutError(t("domain.util.chunkTimeout")));
    }, timeoutMs);
    for (const sub of subscriptions) {
      unsubs.push(client.subscribe(sub.key, (msg) => {
        if (done) return;
        try { sub.onMessage(msg, finish); }
        catch (e) { finish(/** @type {Error} */ (e)); }
      }));
    }
    // P3-9: 同 action の success:false フレーム (要求 op で返る即時エラー) を検知して
    // timeout を待たずに失敗確定する (useManageDevice.js:27-34 の !message.success と同じ判定)。
    if (errorAction && typeof (/** @type {any} */ (client).onMessage) === "function") {
      unsubs.push(/** @type {any} */ (client).onMessage((/** @type {any} */ msg) => {
        if (done) return;
        if (msg?.action !== errorAction || msg?.success !== false) return;
        finish(rejected(
          t("domain.util.opFailed", { op: errorAction, detail: msg?.message || JSON.stringify(msg) }),
          { upstreamCode: msg?.code ?? null },
        ));
      }));
    }
    client.send(sendFrame);
  });
}

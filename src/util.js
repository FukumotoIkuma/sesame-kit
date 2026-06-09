// モジュール横断の小さな共有ユーティリティ。
// WS op の応答 success 判定 / バリデーション例外 / async push 集約のライフサイクルは
// ほぼ全モジュールで重複していたので 1 箇所に集約する。

import { t } from "./i18n.js";
import { SesameError, ERR } from "./errors.js";

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
 * @template T
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
 * @param {object} [vars] i18n 変数
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
 * @template T
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {object} cfg
 * @param {object} cfg.sendFrame                       購読開始のために送るフレーム
 * @param {Array<{key:string, onMessage:(msg:any, finish:(err?:Error)=>void)=>void}>} cfg.subscriptions
 *        dispatch key (`${action}:${op}`) と、その push を処理するハンドラの組。
 * @param {number} cfg.timeoutMs
 * @param {()=>Error} [cfg.onTimeout]                  timeout 時に投げる Error を生成 (既定: 汎用 timeout)
 * @param {()=>T} cfg.result                           成功確定時に resolve する値を組み立てる
 * @returns {Promise<T>}
 */
export function subscribeChunks(client, { sendFrame, subscriptions, timeoutMs, onTimeout, result }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const unsubs = [];
    const cleanup = () => {
      clearTimeout(to);
      for (const u of unsubs) {
        try { u(); } catch { /* unsubscribe は冪等扱い */ }
      }
    };
    const finish = (err) => {
      if (done) return;
      done = true;
      cleanup();
      if (err) reject(err);
      else resolve(result());
    };
    const to = setTimeout(
      () => finish(onTimeout ? onTimeout() : timeoutError(t("domain.util.chunkTimeout"))),
      timeoutMs,
    );
    for (const sub of subscriptions) {
      unsubs.push(client.subscribe(sub.key, (msg) => {
        if (done) return;
        try { sub.onMessage(msg, finish); }
        catch (e) { finish(e); }
      }));
    }
    client.send(sendFrame);
  });
}

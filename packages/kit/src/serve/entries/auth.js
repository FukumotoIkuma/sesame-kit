// エントリ: auth / account / cloud — 認証状態・アカウント情報・ping。
// `Record<string, MethodEntry>` を返す純関数として機械分割 (P5-2)。
// ハンドラ依存: requireAuth のみ (クラウド接続前提 op)。

import { CONTRACT_VERSION } from "@sesame-kit/core/jsonrpc";
import { requireAuth } from "../registry-helpers.js";
import { t } from "@sesame-kit/core/i18n";

/**
 * @returns {Record<string, import("../registry-helpers.js").MethodEntry>}
 */
export function authEntries() {
  return {
    "status": {
      summary: t("serve.sum.status"),
      params: [], result: "{ connected, authState, subUUID, apiVersion, contractVersion }",
      // apiVersion: API サーフェスの SemVer (canonical)。消費者が major 不一致を毎回 fail-fast
      // できるよう返す。contractVersion は後方互換のための deprecated 別名 (1.0 で削除予定)。
      handler: ({ hub, daemon }) => ({
        connected: hub.connected,
        authState: daemon.authState,
        subUUID: hub.subUUID,
        apiVersion: CONTRACT_VERSION,
        contractVersion: CONTRACT_VERSION,
      }),
    },
    // SURF-06: 実疎通の確認 (biz3KeepAlive 1 往復)。`status` は daemon のローカル状態を返すだけ
    // なので、RPC 消費者がクラウド接続の生存を実検証する手段としてこれを公開する。experimental。
    "cloud.ping": {
      summary: t("serve.sum.cloudPing"),
      params: [], result: "{ ok: true, rttMs }",
      handler: async ({ hub, daemon }) => {
        requireAuth(daemon);
        const t0 = Date.now();
        await hub.ping(); // keepalive ack 受信 = 生存。timeout は transport が reject する。
        return { ok: true, rttMs: Date.now() - t0 };
      },
    },
    "account.whoami": {
      summary: t("serve.sum.whoami"),
      params: [], result: t("serve.result.customerInfo"),
      handler: ({ hub, daemon }) => { requireAuth(daemon); return hub.getLoginUser(); },
    },
  };
}

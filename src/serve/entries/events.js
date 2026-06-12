// エントリ: events — イベント購読・解除。
// `Record<string, MethodEntry>` を返す純関数として機械分割 (P5-2)。

import { RpcError, RPC, KIND } from "../../jsonrpc.js";
import { asTopicList } from "../registry-helpers.js";
import { t } from "../../i18n.js";

/**
 * @param {{ TOPICS: readonly string[] }} opts
 * @returns {Record<string, import("../registry-helpers.js").MethodEntry>}
 */
export function eventsEntries({ TOPICS }) {
  return {
    "events.subscribe": {
      summary: t("serve.sum.eventsSubscribe", { topics: TOPICS.join("/") }),
      params: [{
        name: "topics",
        required: true,
        desc: t("serve.desc.subscribeTopics", { topics: TOPICS.join("/") }),
        // P4-8 (R2:SURF-34): SUBSCRIBABLE_TOPICS から enum を導出。生成系はこの schema を
        // SesameEventTopic の union 型 / Literal[] に変換するため SDK の引数型が絞り込まれる。
        schema: { type: "array", items: { type: "string", enum: [...TOPICS] } },
      }],
      result: "{ subscribed: string[] }",
      handler: ({ params, conn, daemon }) => {
        if (conn?.ephemeral) {
          throw new RpcError(t("serve.eventsNeedPersistent"),
            { code: RPC.INVALID_REQUEST, kind: KIND.BAD_PARAMS });
        }
        const topics = asTopicList(params.topics);
        const bad = topics.filter((tp) => !TOPICS.includes(tp));
        if (bad.length) throw new RpcError(t("serve.unknownTopics", { topics: bad.join(",") }), { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
        return daemon.subscribe(conn, topics);
      },
    },
    "events.unsubscribe": {
      summary: t("serve.sum.eventsUnsubscribe"),
      // P4-8 (R2:SURF-34): subscribe と対称に enum schema を付与。
      params: [{ name: "topics", required: true, schema: { type: "array", items: { type: "string", enum: [...TOPICS] } } }],
      result: "{ subscribed: string[] }",
      handler: ({ params, conn, daemon }) => {
        const topics = asTopicList(params.topics);
        return daemon.unsubscribe(conn, topics);
      },
    },
  };
}

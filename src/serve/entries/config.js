// エントリ: config — ConfigStore 同期・リモコン管理。
// `Record<string, MethodEntry>` を返す純関数として機械分割 (P5-2)。

import { requireAuth, requireConfigStore, need } from "../registry-helpers.js";
import { t } from "../../i18n.js";

const S = { type: "string" };
const N = { type: "number" };
const B = { type: "boolean" };

/**
 * @returns {Record<string, import("../registry-helpers.js").MethodEntry>}
 */
export function configEntries() {
  return {
    // SURF-07: devices → config 同期を RPC へ公開 (hub.sync*FromDevices / syncRemoteKeys 委譲)。
    // daemon の ConfigStore (= CLI と同じ ~/.config/sesame-kit/config.json) へ**書き込む**操作。
    // ConfigStore を持たない構成 (config/tokenStore 直渡しの埋め込み) では bad_params で明示拒否
    // する (hub 側の plain Error が internal に潰れるのを防ぐ)。いずれも experimental。
    "config.syncLocks": {
      summary: t("serve.sum.configSyncLocks"),
      params: [{ name: "prune", required: false, desc: t("serve.desc.syncPrune"), schema: B }],
      result: "{ added, updated, removed }",
      handler: ({ hub, params, daemon }) => {
        requireAuth(daemon); requireConfigStore(hub, "config.syncLocks");
        return hub.syncLocksFromDevices({ prune: !!params.prune });
      },
    },
    "config.syncHub3s": {
      summary: t("serve.sum.configSyncHub3s"),
      params: [{ name: "prune", required: false, desc: t("serve.desc.syncPrune"), schema: B }],
      result: "{ added, updated, removed }",
      handler: ({ hub, params, daemon }) => {
        requireAuth(daemon); requireConfigStore(hub, "config.syncHub3s");
        return hub.syncHub3sFromDevices({ prune: !!params.prune });
      },
    },
    "config.syncRemotes": {
      summary: t("serve.sum.configSyncRemotes"),
      params: [],
      result: "{ hub3: {added,updated,removed}, remotes: {added,updated} }",
      handler: ({ hub, daemon }) => {
        requireAuth(daemon); requireConfigStore(hub, "config.syncRemotes");
        return hub.syncRemotesFromDevices();
      },
    },
    "config.syncRemoteKeys": {
      summary: t("serve.sum.configSyncRemoteKeys"),
      params: [{ name: "remote", required: false, desc: t("serve.desc.syncRemoteName"), schema: S }],
      result: "{ name, keyCount }",
      handler: ({ hub, params, daemon }) => {
        requireAuth(daemon); requireConfigStore(hub, "config.syncRemoteKeys");
        return hub.syncRemoteKeys(params.remote ?? null);
      },
    },
    // P4-6 (R2:SURF-32): syncRemotesFromServer — server 経由の代替 sync (通常は config.syncRemotes で足りる)。
    // hub.syncRemotesFromServer(hub3Name, irType) に 1:1 委譲。
    // hub3Name は config 上の名前 (デバイス UUID ではなく設定名)、irType は整数。
    "config.syncRemotesFromServer": {
      summary: t("serve.sum.configSyncRemotesFromServer"),
      params: [
        { name: "hub3", required: true, desc: t("serve.desc.configSyncRemotesFromServerHub3"), schema: S },
        { name: "irType", required: true, desc: t("serve.desc.configSyncRemotesFromServerIrType"), schema: N },
      ],
      result: "{ added, updated }",
      handler: ({ hub, params, daemon }) => {
        requireAuth(daemon); requireConfigStore(hub, "config.syncRemotesFromServer");
        need(params, ["hub3", "irType"]);
        return hub.syncRemotesFromServer(params.hub3, Number(params.irType));
      },
    },
    // P4-6 (R2:SURF-32): listRemoteCandidates — devices 配下リモコン候補の読み取り専用一覧。
    // hub.listRemotesFromDevices() に委譲。対話 add の SDK 版で候補を見せる用途。
    // config 非書込み: ConfigStore 不要 (通常の requireAuth のみ)。
    "config.listRemoteCandidates": {
      summary: t("serve.sum.configListRemoteCandidates"),
      params: [],
      result: "Array<{ hub3DeviceUUID, hub3Name, uuid, type, alias }>",
      handler: ({ hub, daemon }) => {
        requireAuth(daemon);
        return hub.listRemotesFromDevices();
      },
    },
  };
}

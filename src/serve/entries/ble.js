// エントリ: ble — BLE スキャン・invoke・OTA・位置・WiFi・生体・登録。
// `Record<string, MethodEntry>` を返す純関数として機械分割 (P5-2)。

import { RpcError, RPC, KIND } from "../jsonrpc.js";
import { need } from "../registry-helpers.js";
import {
  SesameBle, SesameOS2Ble, createBleTransport,
} from "../../ble/index.js";
import { collectBiometricList, BIO_LIST } from "../../ble/biometric.js";
import { resolveRegisterTransport } from "../../devices.js";
import { t } from "../../i18n.js";

const S = { type: "string" };
const N = { type: "number" };
const B = { type: "boolean" };
const A = { type: "array" };

/**
 * @param {{
 *   invokePath: (root: any, path: string, args?: any[], allowlist?: readonly string[]) => Promise<any>,
 *   wifiViewOf: (ble: any, opts?: {companyId?: string}) => {type: "wm2"|"hub3", view: any},
 *   collectWifiScan: (view: any, opts?: {collectMs?: number}) => Promise<{ssids: Array<{ssid: string, rssi: number}>}>,
 *   bleCommandAck: (r: {resultCode: number}) => {resultCode: number, resultName: string},
 *   bleUseOptsFromParams: (hub: any, params: any) => any,
 *   scrubDiscovery: (d: Record<string, unknown>) => Record<string, unknown>,
 *   reviveJsonArg: (value: any) => any,
 *   BLE_RPC_ALLOWLIST: readonly string[],
 *   OS2_BLE_RPC_ALLOWLIST: readonly string[],
 * }} helpers
 * @returns {Record<string, import("../registry-helpers.js").MethodEntry>}
 */
export function bleEntries({
  invokePath,
  wifiViewOf,
  collectWifiScan,
  bleCommandAck,
  bleUseOptsFromParams,
  scrubDiscovery,
  reviveJsonArg,
  BLE_RPC_ALLOWLIST,
  OS2_BLE_RPC_ALLOWLIST,
}) {
  // ble.invoke / ble.* 専用 RPC 共通の対象指定群 (bleUseOptsFromParams が消費する単一の表)。
  const bleTargetParams = [
    { name: "deviceUUID", required: false, schema: S },
    { name: "address", required: false, schema: S },
    { name: "secretKey", required: true, schema: S },
    { name: "model", required: false, schema: S },
    { name: "scanTimeoutMs", required: false, schema: N },
    { name: "debug", required: false, schema: B },
    { name: "needAuthFromServer", required: false, schema: B },
    { name: "registerBaseUrl", required: false, schema: S },
  ];
  // ble.wifi.* は model で WM2 (専用 GATT) / Hub3 を判別するため model 必須。
  const bleTargetParamsModelRequired = bleTargetParams.map((p) => (
    p.name === "model" ? { ...p, required: true, desc: t("serve.desc.bleModelWifi") } : p
  ));

  // P1-8 (R2:SURF-26 + R2:SURF-39): 生体一覧 5 op の専用収集ハンドラ。
  // ble.wifi.scan (collectWifiScan) と同パターン: GET 要求 → publish(FIRST→NOTIFY×N→LAST) を
  // registerDelegate で収集し records 配列を返す。
  // これらは `bleOpEntries` が生成する "ack" 返しのハンドラ (ble.biometric.cardGet 等) を
  // topLevelEntries に明示し override する。override の理由: biometric.js の BIOMETRIC_RPC_OPS
  // では result:"ack" 宣言だが実際には publish 収集が必要で、ack だけ返しても消費者は実データを
  // 取得できない (P1-8 の問題の本質)。
  //
  // タイムアウト: ble.wifi.scan と同じ収集時間をデフォルトとする (collectMs param で上書き可)。
  // experimental (STABLE_METHODS 非掲載) — P4-1 の changelog に記載。

  /**
   * type (card/passcode/finger/face/palm) に対応する biometric view を SesameBle facade から選ぶ。
   * finger は Bike3 の fingerPrint view、それ以外は biometric view を使う。
   * CLI の biometricView (cli/ble.js) と同一判別ロジック。
   * @param {import("../../ble/index.js").SesameBle} ble
   * @param {string} type
   * @returns {Record<string, Function>}
   */
  function biometricViewOf(ble, type) {
    const caps = ble.capabilities;
    if (type === "finger" && caps.fingerprint && !caps.biometric) {
      return /** @type {Record<string, Function>} */ (/** @type {unknown} */ (ble.fingerPrint));
    }
    return /** @type {Record<string, Function>} */ (/** @type {unknown} */ (ble.biometric));
  }

  /** @param {string} type card|passcode|finger|face|palm */
  const bioListEntry = (type) => {
    const spec = BIO_LIST[/** @type {keyof typeof BIO_LIST} */ (type)];
    // op パスは BIOMETRIC_RPC_OPS / FINGERPRINT_RPC_OPS の getter 名に合わせる:
    //   card → biometric.cardGet
    //   passcode → biometric.passcodeGet
    //   face → biometric.faceListGet
    //   palm → biometric.palmListGet
    //   finger → fingerPrint.fingerPrints
    return {
      summary: t("serve.sum.bleBioListGet", { type }),
      params: [
        ...bleTargetParams,
        { name: "collectMs", required: false, desc: t("serve.desc.bleCollectMs"), schema: N },
      ],
      result: "{ records: Array<{id, name, type} | object> }",
      handler: async (/** @type {import("../registry-helpers.js").HandlerCtx} */ { hub, params }) => {
        const collectMs = typeof params.collectMs === "number" ? params.collectMs : 8_000;
        return SesameBle.use(bleUseOptsFromParams(hub, params), (ble) => {
          const cmds = biometricViewOf(ble, type);
          return collectBiometricList(cmds, spec, collectMs).then((records) => ({ records }));
        });
      },
    };
  };

  return {
    // P1-7 (R2:SURF-25): 近接 SESAME の発見一覧。BLE scan は鍵不要 (advertise のみ) で、
    // ble.register / ble.os2.register が要求する deviceUUID を RPC 消費者が自己解決できるようにする。
    // secretKey 不要・experimental (STABLE_METHODS 非掲載)。
    "ble.scan": {
      summary: t("serve.sum.bleScan"),
      params: [
        { name: "scanTimeoutMs", required: false, desc: t("serve.desc.bleScanTimeoutMs"), schema: N },
        { name: "includeUnknown", required: false, desc: t("serve.desc.bleScanIncludeUnknown"), schema: B },
      ],
      result: "{ ok: true, count, devices: [{deviceUUID, model, kind, productType, isRegistered, rssi, …}] }",
      handler: async ({ params }) => {
        const found = /** @type {Array<Record<string, unknown>>} */ (
          await SesameBle.listNearby({
            timeoutMs: params.scanTimeoutMs,
            includeUnknown: !!params.includeUnknown,
          })
        );
        return { ok: true, count: found.length, devices: found.map(scrubDiscovery) };
      },
    },
    "ble.invoke": {
      summary: t("serve.sum.bleInvoke"),
      params: [
        { name: "op", required: true, schema: S },
        { name: "args", required: false, schema: A },
        ...bleTargetParams,
      ],
      result: "BLE operation result",
      handler: async ({ hub, params }) => {
        need(params, ["op", "secretKey"]);
        // fail-closed (P4-2): 公開面 allowlist (ble/index.js BLE_RPC_ALLOWLIST) 非掲載 op は拒否。
        return SesameBle.use(bleUseOptsFromParams(hub, params),
          (ble) => invokePath(ble, params.op, params.args, BLE_RPC_ALLOWLIST));
      },
    },
    // ---- P4-1 段階2: 高価値 BLE op の専用 RPC (typed SDK に個別メソッドとして現れる) ----
    // いずれも experimental (STABLE_METHODS 非掲載)。対象指定は ble.invoke と同じ
    // {deviceUUID?, address?, secretKey, model?, …} (bleTargetParams / bleUseOptsFromParams)。
    "ble.updateFirmware": {
      summary: t("serve.sum.bleUpdateFirmware"),
      params: [...bleTargetParams, { name: "timeoutMs", required: false, schema: N }],
      result: "{ commandSent, resultCode|null, resultName|null }",
      handler: async ({ hub, params }) => SesameBle.use(bleUseOptsFromParams(hub, params), async (ble) => {
        // WM2 (OPEN_OTA_SERVER) / Hub3 (MOVE_TO) は応答 Promise、OS3 ロック系は SDK 同様
        // **コマンド無送信**で同期にハンドル返し (CHSesameOS3.kt:441-449。P1-7 の分岐をそのまま使う)。
        const r = /** @type {{resultCode?:number}} */ (
          await Promise.resolve(ble.updateFirmware({ timeoutMs: params.timeoutMs }))
        );
        const sent = typeof r?.resultCode === "number";
        return sent
          ? { commandSent: true, ...bleCommandAck(/** @type {{resultCode:number}} */ (r)) }
          : { commandSent: false, resultCode: null, resultName: null };
      }),
    },
    "ble.reset": {
      summary: t("serve.sum.bleReset"),
      params: [...bleTargetParams],
      result: "{ resultCode, resultName }",
      handler: async ({ hub, params }) => SesameBle.use(bleUseOptsFromParams(hub, params),
        async (ble) => bleCommandAck(await ble.reset())),
    },
    "ble.position": {
      summary: t("serve.sum.blePosition"),
      params: [
        ...bleTargetParams,
        { name: "lockPosition", required: true, desc: t("serve.desc.blePositionLock"), schema: N },
        { name: "unlockPosition", required: true, desc: t("serve.desc.blePositionUnlock"), schema: N },
      ],
      result: "{ resultCode, resultName }",
      handler: async ({ hub, params }) => {
        // 0 は有効な角度 (need() は 0 も欠落扱いするため undefined/null だけを明示チェック)。
        for (const k of ["lockPosition", "unlockPosition"]) {
          if (params[k] === undefined || params[k] === null) {
            throw new RpcError(t("serve.missingParam", { k }), { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
          }
        }
        return SesameBle.use(bleUseOptsFromParams(hub, params),
          async (ble) => bleCommandAck(await ble.configureLockPosition(params.lockPosition, params.unlockPosition)));
      },
    },
    "ble.wifi.scan": {
      summary: t("serve.sum.bleWifiScan"),
      params: [
        ...bleTargetParamsModelRequired,
        { name: "companyId", required: false, desc: t("serve.desc.bleCompanyId"), schema: S },
        { name: "collectMs", required: false, desc: t("serve.desc.bleCollectMs"), schema: N },
      ],
      result: "{ ssids: [{ssid, rssi}] }",
      handler: async ({ hub, params }) => {
        need(params, ["model"]); // WM2/Hub3 の判別 (GATT も異なる) に model が必須
        return SesameBle.use(bleUseOptsFromParams(hub, params), (ble) => {
          const { view } = wifiViewOf(ble, { companyId: params.companyId });
          return collectWifiScan(view, { collectMs: params.collectMs });
        });
      },
    },
    "ble.wifi.setSsid": {
      summary: t("serve.sum.bleWifiSetSsid"),
      params: [
        ...bleTargetParamsModelRequired,
        { name: "ssid", required: true, schema: S },
        { name: "companyId", required: false, desc: t("serve.desc.bleCompanyId"), schema: S },
      ],
      result: "{ resultCode, resultName }",
      handler: async ({ hub, params }) => {
        need(params, ["model", "ssid"]);
        return SesameBle.use(bleUseOptsFromParams(hub, params), async (ble) => {
          const { view } = wifiViewOf(ble, { companyId: params.companyId });
          return bleCommandAck(await view.setWifiSSID(params.ssid));
        });
      },
    },
    "ble.wifi.setPassword": {
      summary: t("serve.sum.bleWifiSetPassword"),
      params: [
        ...bleTargetParamsModelRequired,
        { name: "password", required: true, schema: S },
        { name: "companyId", required: false, desc: t("serve.desc.bleCompanyId"), schema: S },
      ],
      result: "{ resultCode, resultName }",
      handler: async ({ hub, params }) => {
        need(params, ["model", "password"]);
        return SesameBle.use(bleUseOptsFromParams(hub, params), async (ble) => {
          const { view } = wifiViewOf(ble, { companyId: params.companyId });
          return bleCommandAck(await view.setWifiPassword(params.password));
        });
      },
    },
    "ble.wifi.connect": {
      summary: t("serve.sum.bleWifiConnect"),
      params: [
        ...bleTargetParamsModelRequired,
        { name: "companyId", required: false, desc: t("serve.desc.bleCompanyId"), schema: S },
      ],
      result: "{ resultCode, resultName }",
      handler: async ({ hub, params }) => {
        need(params, ["model"]);
        return SesameBle.use(bleUseOptsFromParams(hub, params), async (ble) => {
          const { type, view } = wifiViewOf(ble, { companyId: params.companyId });
          // Hub3 に connect コマンドは存在しない (CHHub3Device.kt の Wi-Fi 系は SSID/Password の
          // 設定のみで、適用は本体側)。WM2 だけが CONNECT_WIFI(5) を持つ (CHWifiModule2Device.kt:355-365)。
          if (type !== "wm2") {
            throw new RpcError(t("serve.bleWifiConnectWm2Only"), { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
          }
          return bleCommandAck(await view.connectWifi());
        });
      },
    },
    "ble.biometric.cardGet":    bioListEntry("card"),
    "ble.biometric.passcodeGet": bioListEntry("passcode"),
    "ble.biometric.faceListGet": bioListEntry("face"),
    "ble.biometric.palmListGet": bioListEntry("palm"),
    "ble.fingerPrint.fingerPrints": bioListEntry("finger"),
    "ble.register": {
      summary: t("serve.sum.bleRegister"),
      params: [
        { name: "deviceUUID", required: true, schema: S },
        { name: "address", required: false, schema: S },
        { name: "model", required: false, schema: S },
        { name: "productType", required: false, schema: S },
        { name: "scanTimeoutMs", required: false, schema: N },
        { name: "debug", required: false, schema: B },
        { name: "nowMs", required: false, schema: N },
        { name: "registerBaseUrl", required: false, schema: S },
      ],
      result: "OS3 BLE registration result",
      handler: async ({ hub, params }) => {
        need(params, ["deviceUUID"]);
        // model は SesameBle コンストラクタ (能力テーブル参照) へ透過する。registerOnce の
        // 公開 opts 型には現れないが ...ctorOpts で受け渡されるため、型のみキャストで補う。
        return SesameBle.registerOnce(/** @type {Parameters<typeof SesameBle.registerOnce>[0] & {model?:string|null}} */ ({
          deviceUUID: params.deviceUUID,
          address: params.address,
          model: params.model ?? null,
          productType: params.productType ?? params.model ?? undefined,
          scanTimeoutMs: params.scanTimeoutMs,
          debug: !!params.debug,
          nowMs: params.nowMs,
          registerTransport: resolveRegisterTransport({
            baseUrl: typeof params.registerBaseUrl === "string" ? params.registerBaseUrl : undefined,
            config: hub.config,
            tokenStore: hub.tokenStore,
          }),
        }));
      },
    },
    "ble.os2.invoke": {
      summary: t("serve.sum.bleOs2Invoke"),
      params: [
        { name: "op", required: true, schema: S },
        { name: "args", required: false, schema: A },
        { name: "deviceUUID", required: false, schema: S },
        { name: "address", required: false, schema: S },
        { name: "secretKey", required: true, schema: S },
        { name: "keyIndex", required: true, schema: S },
        { name: "ssmPublicKey", required: true, schema: S },
        { name: "model", required: false, schema: S },
        { name: "scanTimeoutMs", required: false, schema: N },
        { name: "debug", required: false, schema: B },
      ],
      result: "BLE operation result",
      handler: async ({ params }) => {
        need(params, ["op", "secretKey", "keyIndex", "ssmPublicKey"]);
        const transport = createBleTransport({
          deviceUUID: params.deviceUUID,
          address: params.address,
          debug: !!params.debug,
          scanTimeoutMs: params.scanTimeoutMs,
        });
        return SesameOS2Ble.use({
          transport,
          deviceUUID: params.deviceUUID,
          secretKey: params.secretKey,
          keyIndex: params.keyIndex,
          ssmPublicKey: params.ssmPublicKey,
          model: params.model ?? null,
          debug: !!params.debug,
        // fail-closed (P4-2): OS2 公開面 allowlist (ble/index.js OS2_BLE_RPC_ALLOWLIST) で照合。
        }, (ble) => invokePath(ble, params.op, params.args, OS2_BLE_RPC_ALLOWLIST));
      },
    },
    "ble.os2.register": {
      summary: t("serve.sum.bleOs2Register"),
      params: [
        { name: "deviceUUID", required: true, schema: S },
        { name: "address", required: false, schema: S },
        { name: "model", required: false, schema: S },
        { name: "productType", required: false, schema: S },
        { name: "scanTimeoutMs", required: false, schema: N },
        { name: "debug", required: false, schema: B },
        { name: "localServerAuth", required: false, schema: B },
        { name: "ak", required: false, schema: { type: "object" } },
      ],
      result: "OS2 BLE registration result",
      handler: async ({ params }) => {
        need(params, ["deviceUUID"]);
        const transport = createBleTransport({
          deviceUUID: params.deviceUUID,
          address: params.address,
          debug: !!params.debug,
          scanTimeoutMs: params.scanTimeoutMs,
        });
        return SesameOS2Ble.registerOnce({
          transport,
          deviceUUID: params.deviceUUID,
          model: params.model ?? null,
          productType: params.productType ?? params.model ?? undefined,
          localServerAuth: params.localServerAuth !== false,
          debug: !!params.debug,
          ak: reviveJsonArg(params.ak),
        });
      },
    },
  };
}

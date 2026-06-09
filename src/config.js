// config.json の読み書き + ドメインモデル。
// 単一ファイルで Hub3 群 / リモコン群 / デフォルト指定を保持する。
//
// 形式 (例):
//   {
//     "companyID": "ch_CandyhouseMobile",
//     "wsUrl":     "wss://...",
//     "lang":      "ja",
//     "default":   { "remote": "ac" },
//     "hub3s":     { "<name>": { "deviceId": "...", "name?": "..." } },
//     "remotes":   { "<name>": {
//                      "hub3": "<hub3-name>",
//                      "irDeviceUUID": "...",
//                      "irType": 49152,
//                      "irOperation": "learnEmit",
//                      "alias?": "...",
//                      "keys": { "<キー名>": "<keyUUID>" }
//                    } }
//   }

import { existsSync, readFileSync } from "node:fs";
import { configPaths } from "./paths.js";
import { writeSecretJson } from "./secure-fs.js";
import { DEFAULT_IR_TYPE } from "./crypto.js";
import { t } from "./i18n.js";

/**
 * config に格納する SESAME device レコード。サーバ応答 (getCompanyDevice 等) を
 * ほぼ丸ごと保存するため未知フィールドも許容する。category はローカル注釈。
 * @typedef {Object} DeviceRecord
 * @property {string} [deviceUUID]
 * @property {string|null} [secretKey]
 * @property {string|null} [deviceModel]
 * @property {string|null} [deviceName]
 * @property {string} [category] ローカル注釈 ("lock"/"hub3" など)。view 分類の真実。
 * @property {*} [stateInfo] sanitize で除外されるが incoming では存在しうる。
 */

/**
 * locks{} の派生 view エントリ (旧 shape)。
 * @typedef {Object} LockView
 * @property {string|undefined} deviceUUID
 * @property {string|null|undefined} secretKey
 * @property {string|null} model
 * @property {string|null} alias
 */

/**
 * hub3s{} の派生 view エントリ (旧 shape)。
 * @typedef {Object} Hub3View
 * @property {string|undefined} deviceId
 * @property {string} name
 * @property {string} model
 * @property {string|null} secretKey
 */

/**
 * remotes{} のエントリ (IR リモコン定義)。
 * @typedef {Object} RemoteEntry
 * @property {string} hub3 親 Hub3 の config 名
 * @property {string} [irDeviceUUID]
 * @property {number} irType
 * @property {string} irOperation
 * @property {string|null} [alias]
 * @property {Record<string, string>} keys キー名 → keyUUID
 */

/**
 * default 指定。
 * @typedef {Object} ConfigDefault
 * @property {string|null} remote
 * @property {string|null} lock
 */

/**
 * config.json 全体のドメインモデル。
 * @typedef {Object} ConfigData
 * @property {string} [companyID]
 * @property {string} [wsUrl]
 * @property {string} [lang]
 * @property {"en"|"ja"} [uiLang]
 * @property {ConfigDefault} default
 * @property {Record<string, DeviceRecord>} devices 単一の真実: 全 SESAME device。
 * @property {Record<string, RemoteEntry>} remotes IR リモコン群 (device ではない子)。
 * @property {string|null} [apiKeyId]
 * @property {string} [biometricsBaseUrl] biometrics REST base URL (PERSISTED)。
 * @property {string} [registerBaseUrl] register REST base URL (biometrics fallback)。
 * @property {Record<string, LockView>} [locks] devices からの派生 view (保存しない)。
 * @property {Record<string, Hub3View>} [hub3s] devices からの派生 view (保存しない)。
 */

/**
 * `load()` 後の config。`load()` は `{...emptyConfig(), ...raw}` で穴埋めし、その後 `_reproject` を
 * 必ず走らせるため、emptyConfig が必ず与えるスカラ (companyID/wsUrl/lang) と派生 view (locks/hub3s)
 * は常に存在する。client.js など読み手はこの型を参照する。
 * @typedef {ConfigData & {
 *   companyID: string,
 *   wsUrl: string,
 *   lang: string,
 *   locks: Record<string, LockView>,
 *   hub3s: Record<string, Hub3View>,
 * }} LoadedConfig
 */

// WS ステージは `/public` が公式値:
//   - biz3 現行ソース (env_config.js:2) = `/public`
//   - 公式 BLE 実装の解析でも「公式は /public」と確認済み
// 旧既定の `/production` は web 実装由来の値で、web コード移植の流れで紛れ込んだもの
// (auth.js は consumer client を保ったのに、ここのエンドポイント保持を忘れていた)。公式は /public。
const DEFAULT_WS_URL =
  "wss://82q6nuplv0.execute-api.ap-northeast-1.amazonaws.com/public";
// 禁止エンドポイント (web 由来の誤値)。config に焼き付いていたら /public へ強制し使わせない。
const LEGACY_WS_URL =
  "wss://82q6nuplv0.execute-api.ap-northeast-1.amazonaws.com/production";
const DEFAULT_LANG = "ja";
const DEFAULT_COMPANY_ID = "ch_CandyhouseMobile";

/** @returns {ConfigData} */
function emptyConfig() {
  return {
    companyID: DEFAULT_COMPANY_ID,
    wsUrl: DEFAULT_WS_URL,
    lang: DEFAULT_LANG,
    default: { remote: null, lock: null },
    // 単一の真実: SESAME デバイス全部 (lock/bot/bike/hub3/...) を device レコード丸ごと格納する。
    // kind は deviceModel から導出。型ごとにコレクションを分けない (分割＋cherry-pick が
    // model/secretKey の取りこぼしバグの温床だった)。
    devices: {},
    remotes: {}, // IR リモコンは device ではない子エンティティ (親 hub3 + irType + 学習 keys)
    apiKeyId: null, // biz3 dev console で発行する REST WebAPI 用キー
  };
}

// 永続化する正準キー (locks/hub3s は派生 view なので保存しない)。
// これは意図的なハードホワイトリスト: ここに無いトップレベルキーは save() で落とす。
// 将来フィールドを足すときはこの配列にも必ず追加すること (追加し忘れると黙って消える)。
const PERSISTED_KEYS = ["companyID", "wsUrl", "lang", "uiLang", "default", "devices", "remotes", "apiKeyId", "biometricsBaseUrl"];

// device レコードのうち config ローカルにだけ存在する注釈キー (サーバ応答には無い)。
// sync 更新時にサーバ由来フィールドで丸ごと置き換えても、これらは引き継ぐ。
/** @type {Array<keyof DeviceRecord>} */
const LOCAL_ONLY_KEYS = ["category"];

/**
 * device レコードから lock view 用エントリ (旧 shape: deviceUUID/secretKey/model/alias)。
 * @param {DeviceRecord} rec
 * @returns {LockView}
 */
function lockView(rec) {
  return { deviceUUID: rec.deviceUUID, secretKey: rec.secretKey, model: rec.deviceModel || null, alias: rec.deviceName || null };
}
/**
 * device レコードから hub3 view 用エントリ (旧 shape: deviceId/name + model/secretKey も保持)。
 * @param {DeviceRecord} rec
 * @param {string} name
 * @returns {Hub3View}
 */
function hub3View(rec, name) {
  return { deviceId: rec.deviceUUID, name: rec.deviceName || name, model: rec.deviceModel || "hub_3", secretKey: rec.secretKey || null };
}

/**
 * config オブジェクトを実行時 shape に正規化する。
 * ConfigStore.load() を通らない embedded 利用でも、保存正準形 `devices` から
 * 互換 view の `locks` / `hub3s` を必ず再投影する。
 *
 * @param {Partial<ConfigData>} raw
 * @returns {LoadedConfig}
 */
export function normalizeConfig(raw = {}) {
  const cfg = /** @type {LoadedConfig} */ ({ ...emptyConfig(), ...(raw || {}) });
  if (!cfg.default) cfg.default = { remote: null, lock: null };
  if (cfg.default.remote === undefined) cfg.default.remote = null;
  if (cfg.default.lock === undefined) cfg.default.lock = null;
  if (!cfg.devices) cfg.devices = {};
  if (!cfg.remotes) cfg.remotes = {};
  if (cfg.wsUrl === LEGACY_WS_URL) cfg.wsUrl = DEFAULT_WS_URL;
  /** @param {unknown} uuid */
  const hasDevice = (uuid) => Object.values(cfg.devices || {}).some((r) => normalizeUuid(r?.deviceUUID) === normalizeUuid(uuid));
  // 旧 shape の locks/hub3s は派生 view より広い (deviceModel/deviceName/model/alias 等の
  // レガシーフィールドを持ちうる) ため、移行入力は緩い型で受ける。
  /** @typedef {Record<string, string|null|undefined>} LegacyEntry */
  const legacyLocks = /** @type {Record<string, LegacyEntry>} */ (raw?.locks || {});
  const legacyHub3s = /** @type {Record<string, LegacyEntry>} */ (raw?.hub3s || {});
  for (const [name, lock] of Object.entries(legacyLocks)) {
    if (!lock?.deviceUUID || hasDevice(lock.deviceUUID)) continue;
    const { model, alias, ...rest } = lock;
    cfg.devices[name] = {
      ...rest,
      deviceUUID: lock.deviceUUID,
      secretKey: lock.secretKey,
      deviceModel: lock.deviceModel ?? model ?? null,
      deviceName: lock.deviceName ?? alias ?? null,
      category: "lock",
    };
  }
  for (const [name, hub3] of Object.entries(legacyHub3s)) {
    const deviceUUID = hub3?.deviceUUID || hub3?.deviceId;
    if (!deviceUUID || hasDevice(deviceUUID)) continue;
    cfg.devices[name] = {
      ...hub3,
      deviceUUID,
      secretKey: hub3.secretKey || null,
      deviceModel: hub3.deviceModel || hub3.model || "hub_3",
      deviceName: hub3.deviceName || hub3.name || name,
      category: "hub3",
    };
  }
  cfg.locks = {};
  cfg.hub3s = {};
  for (const [name, rec] of Object.entries(cfg.devices || {})) {
    const cat = effectiveCategory(rec);
    if (cat === "lock") cfg.locks[name] = lockView(rec);
    else if (cat === "hub3") cfg.hub3s[name] = hub3View(rec, name);
  }
  return cfg;
}

export class ConfigStore {
  /**
   * @param {string} configPath 絶対パス
   */
  constructor(configPath) {
    if (!configPath) throw new Error(t("domain.config.configPathRequired"));
    this.configPath = configPath;
    /** @type {ConfigData|null} */
    this.data = null;
  }

  /**
   * @param {string} configDir
   * @returns {ConfigStore}
   */
  static fromConfigDir(configDir) {
    return new ConfigStore(configPaths(configDir).config);
  }

  exists() { return existsSync(this.configPath); }

  /**
   * ファイル不在時はメモリ上で空オブジェクトを返す (保存はしない)。
   * @returns {LoadedConfig}
   */
  load() {
    if (this.data) return /** @type {LoadedConfig} */ (this.data);
    if (!existsSync(this.configPath)) {
      this.data = emptyConfig();
      this._reproject();
      return /** @type {LoadedConfig} */ (this.data);
    }
    /** @type {Partial<ConfigData>} */
    const raw = JSON.parse(readFileSync(this.configPath, "utf8"));
    // 安全ガード: /production は接続経路として絶対に使わせない。どこから入った値でも
    // (古い既定・手書き) /public へ強制し、ファイルからも物理的に消す。後方互換ではなく
    // 「禁止エンドポイントを焼き付けさせない」防御。
    let forced = false;
    if (raw.wsUrl === LEGACY_WS_URL) forced = true;
    this.data = normalizeConfig(raw);
    if (forced) { try { this.save(); } catch { /* 読み取り専用環境では in-memory のみ */ } }
    return /** @type {LoadedConfig} */ (this.data);
  }

  /** devices{} から locks{}/hub3s{} の派生 view (旧 shape) を都度組み立てる。reader 互換用。 */
  _reproject() {
    const cfg = /** @type {ConfigData} */ (this.data);
    cfg.locks = {};
    cfg.hub3s = {};
    for (const [name, rec] of Object.entries(cfg.devices || {})) {
      const cat = effectiveCategory(rec);
      if (cat === "lock") cfg.locks[name] = lockView(rec);
      else if (cat === "hub3") cfg.hub3s[name] = hub3View(rec, name);
      // それ以外 (Touch/Face/Sensor 等) は view に出さない (操作対象でない)
    }
  }

  save() {
    if (!this.data) throw new Error(t("domain.config.nothingToSave"));
    this._reproject(); // 書き込み前に view を最新化 (読み手が直後に参照しても整合)
    // 永続化は正準キーのみ (派生 view の locks/hub3s は書かない)
    /** @type {Record<string, unknown>} */
    const persist = {};
    const data = /** @type {Record<string, unknown>} */ (this.data);
    for (const k of PERSISTED_KEYS) if (data[k] !== undefined) persist[k] = data[k];
    // config.json には ロックの secretKey (32hex 平文) が入るので tokens.json 同様
    // mode 0600 / 親 0700 でアトミックに保存する (secure-fs.js に一本化)。
    writeSecretJson(this.configPath, persist);
  }

  /**
   * 空スケルトンを書き出す。既存があれば触らない。
   * @param {{uiLang?: "en"|"ja", lang?: "en"|"ja"}} [overrides]
   *   init 時に確定している言語設定を焼き込む。`sesame --lang en init` の意図
   *   (UI を英語に) を config に永続化し、次回以降のセッションへ引き継ぐため。
   *   渡さなければ emptyConfig の既定 (lang:"ja", uiLang 未設定) のまま。
   * @returns {boolean} 新規作成したら true
   */
  init(overrides = {}) {
    if (existsSync(this.configPath)) return false;
    this.data = emptyConfig();
    if (overrides.uiLang) this.data.uiLang = overrides.uiLang;
    // データ言語 (cloud 応答のロケール) も UI 言語に合わせる: `--lang en init` で
    // config に lang:"ja" が残り「en を指定したのに ja」に見える混乱を解消する。
    if (overrides.lang) this.data.lang = overrides.lang;
    this.save();
    return true;
  }

  // ---- ドメイン操作 ----

  /**
   * name 省略時は default.remote、無ければ remotes が 1 つだけならそれ。
   * @param {string} [name]
   * @returns {{name: string, remote: RemoteEntry, hub3Name: string, hub3: Hub3View}}
   */
  resolveRemote(name) {
    const cfg = this.load();
    const remotes = cfg.remotes || {};
    const names = Object.keys(remotes);
    const chosen =
      name ||
      cfg.default?.remote ||
      (names.length === 1 ? names[0] : null);
    if (!chosen) {
      throw new Error(
        t("domain.config.noRemoteNoDefault", { names: names.join(", ") || "(none)" }),
      );
    }
    const remote = remotes[chosen];
    if (!remote) {
      throw new Error(t("domain.config.unknownRemote", { name: chosen, names: names.join(", ") || "(none)" }));
    }
    const hub3Name = remote.hub3;
    const hub3 = cfg.hub3s?.[hub3Name];
    if (!hub3) {
      throw new Error(t("domain.config.remoteRefMissingHub3", { name: chosen, hub3: hub3Name }));
    }
    return { name: chosen, remote, hub3Name, hub3 };
  }

  /**
   * @param {string} name
   * @param {{deviceId?: string, name?: string, model?: string, secretKey?: string|null}} hub3
   */
  addHub3(name, hub3) {
    const cfg = this.load();
    if (!name) throw new Error(t("domain.config.hub3NameRequired"));
    if (!hub3?.deviceId) throw new Error(t("domain.config.hub3DeviceIdRequired"));
    cfg.devices[name] = {
      deviceUUID: hub3.deviceId,
      deviceName: hub3.name || name,
      deviceModel: hub3.model || "hub_3",
      secretKey: hub3.secretKey || null,
      category: "hub3", // 明示追加 = Hub3 確定
    };
    this.save(); // save() が _reproject して cfg.hub3s view を更新する
  }

  /**
   * @param {string} name
   * @param {{hub3?: string, irDeviceUUID?: string, irType?: number|string,
   *          irOperation?: string, alias?: string|null, keys?: Record<string, string>}} remote
   */
  addRemote(name, remote) {
    const cfg = this.load();
    if (!name) throw new Error(t("domain.config.remoteNameRequired"));
    if (!remote?.hub3) throw new Error(t("domain.config.remoteHub3Required"));
    if (!cfg.hub3s[remote.hub3]) {
      throw new Error(t("domain.config.hub3NotRegisteredAddFirst", { hub3: remote.hub3 }));
    }
    cfg.remotes[name] = {
      hub3: remote.hub3,
      irDeviceUUID: remote.irDeviceUUID,
      irType: Number(remote.irType),
      irOperation: remote.irOperation || "learnEmit",
      alias: remote.alias || null,
      keys: remote.keys || {},
    };
    // 初回登録時はデフォルトに設定
    if (!cfg.default.remote) cfg.default.remote = name;
    this.save();
  }

  /** @param {string} name */
  setDefaultRemote(name) {
    const cfg = this.load();
    if (!cfg.remotes[name]) throw new Error(t("domain.config.unknownRemoteName", { name }));
    cfg.default.remote = name;
    this.save();
  }

  /**
   * @param {string} name
   * @param {Record<string, string>} keys
   */
  updateRemoteKeys(name, keys) {
    const cfg = this.load();
    const r = cfg.remotes[name];
    if (!r) throw new Error(t("domain.config.unknownRemoteName", { name }));
    r.keys = keys;
    this.save();
  }

  // ---- lock ----

  /**
   * name 省略時は default.lock、無ければ locks が 1 つだけならそれ。
   * @param {string} [name]
   * @returns {{name: string, lock: LockView}}
   */
  resolveLock(name) {
    const cfg = this.load();
    const locks = cfg.locks || {};
    const names = Object.keys(locks);
    const chosen = name || cfg.default?.lock || (names.length === 1 ? names[0] : null);
    if (!chosen) {
      throw new Error(t("domain.config.noLockNoDefault", { names: names.join(", ") || "(none)" }));
    }
    const lock = locks[chosen];
    if (!lock) throw new Error(t("domain.config.unknownLock", { name: chosen, names: names.join(", ") || "(none)" }));
    return { name: chosen, lock };
  }

  /**
   * @param {string} name
   * @param {{deviceUUID?: string, secretKey?: string, model?: string|null, alias?: string|null}} lock
   */
  addLock(name, lock) {
    const cfg = this.load();
    if (!name) throw new Error(t("domain.config.lockNameRequired"));
    if (!lock?.deviceUUID) throw new Error(t("domain.config.lockDeviceUUIDRequired"));
    if (!lock?.secretKey) throw new Error(t("domain.config.lockSecretKeyRequired"));
    cfg.devices[name] = {
      deviceUUID: lock.deviceUUID,
      secretKey: lock.secretKey,
      deviceModel: lock.model || null, // 省略時 null (kindForModel(null)→lock5 なので操作は可)
      deviceName: lock.alias || null,
      category: "lock", // 明示追加 = ロック確定 (model が未知/未指定でも view に出す)
    };
    if (!cfg.default.lock) cfg.default.lock = name;
    this.save();
  }

  /** @param {string} name */
  setDefaultLock(name) {
    const cfg = this.load();
    if (!cfg.locks[name]) throw new Error(t("domain.config.unknownLockName", { name }));
    cfg.default.lock = name;
    this.save();
  }

  /** @param {string} name */
  removeLock(name) {
    const cfg = this.load();
    if (!cfg.locks[name]) throw new Error(t("domain.config.unknownLockName", { name }));
    delete cfg.devices[name]; // devices が真実。view (cfg.locks) は save()→_reproject で更新
    if (cfg.default.lock === name) cfg.default.lock = null;
    this.save();
  }

  // ---- devices → config 同期 (ドメイン操作) ----
  // device レコードを **取捨選択せず丸ごと** devices{} に格納する共通コア。型ごとの差は
  // accept (受理条件) と prune の保護だけで、保存フィールドの cherry-pick はしない
  // (hub3 で model/secretKey を選び忘れて lock5 に化けた類のバグを構造的に防ぐ)。

  /**
   * @param {DeviceRecord[]} deviceList
   * @param {{ accept:(d:DeviceRecord)=>boolean, category:"lock"|"hub3", prune?:boolean,
   *           onFirstAdd?:((name:string)=>void)|null, pruneProtect?:((name:string)=>boolean)|null }} opts
   *   accept  受理条件 (取り込む incoming device の判定)
   *   category この sync が司る view。prune はこの view に属する device だけを対象にする
   * @returns {{added:string[], updated:string[], removed:string[]}}
   */
  _syncDevices(deviceList, { accept, category, prune = false, onFirstAdd = null, pruneProtect = null }) {
    const cfg = this.load();
    /** @type {{added:string[], updated:string[], removed:string[]}} */
    const result = { added: [], updated: [], removed: [] };
    /** @type {Set<string>} */
    const seen = new Set();

    for (const d of deviceList || []) {
      if (!accept(d)) continue;
      seen.add(normalizeUuid(d.deviceUUID));
      const rec = sanitizeDeviceRecord(d); // 巨大な stateInfo 以外は全フィールド保存

      const entry = Object.entries(cfg.devices).find(
        ([, r]) => normalizeUuid(r.deviceUUID) === normalizeUuid(d.deviceUUID),
      );
      if (entry) {
        const [name, existing] = entry;
        // サーバ応答 (rec) を真実としてフィールドを丸ごと置き換える: サーバ側で消えた
        // フィールドは追従して消す。ただしローカル注釈 (category) だけは引き継ぐ。
        const merged = { ...rec };
        for (const k of LOCAL_ONLY_KEYS) if (existing[k] !== undefined) merged[k] = existing[k];
        // 変更判定はキー順に依存しない正準形で比較 (手動追加→初回 sync で順序差だけの誤検知を防ぐ)。
        if (canonicalize(merged) !== canonicalize(existing)) {
          cfg.devices[name] = merged;
          result.updated.push(name);
        }
        continue;
      }

      const name = uniqueName(cfg.devices, baseName(d.deviceName, d.deviceUUID));
      cfg.devices[name] = rec;
      if (onFirstAdd) onFirstAdd(name);
      result.added.push(name);
    }

    if (prune) {
      // prune 対象はこの sync が司る view (category) に属する device だけ。判定は accept(model 依存)
      // ではなく view と同じ effectiveCategory で行う。これにより手動追加 (model 未指定で accept を
      // 通らないロック等) も対称に prune でき、locks の sync が hub3 を消すこともない。
      for (const [name, r] of Object.entries(cfg.devices)) {
        if (effectiveCategory(r) !== category) continue;
        if (seen.has(normalizeUuid(r.deviceUUID))) continue;
        if (pruneProtect && pruneProtect(name)) continue;
        delete cfg.devices[name];
        if (cfg.default.lock === name) cfg.default.lock = null;
        result.removed.push(name);
      }
    }

    this.save();
    return result;
  }

  /**
   * `devices` (getCompanyDevice 等) の結果からロックを取り込む (devices{} に丸ごと格納)。
   * @param {DeviceRecord[]} deviceList
   * @param {{prune?:boolean}} [opts]
   * @returns {{added:string[], updated:string[], removed:string[]}}
   */
  syncLocksFromDevices(deviceList, { prune = false } = {}) {
    return this._syncDevices(deviceList, {
      accept: (d) => isLockModel(d.deviceModel) && !!d.deviceUUID && !!d.secretKey,
      category: "lock",
      prune,
      onFirstAdd: (name) => {
        const data = /** @type {ConfigData} */ (this.data);
        if (!data.default.lock) data.default.lock = name;
      },
    });
  }

  /**
   * `devices` の結果から Hub3 を取り込む (deviceModel が hub_3 / hub_3_lte。devices{} に丸ごと格納)。
   * @param {DeviceRecord[]} deviceList
   * @param {{prune?:boolean}} [opts]
   * @returns {{added:string[], updated:string[], removed:string[]}}
   */
  syncHub3sFromDevices(deviceList, { prune = false } = {}) {
    return this._syncDevices(deviceList, {
      accept: (d) => isHub3Model(d.deviceModel) && !!d.deviceUUID,
      category: "hub3",
      prune,
      pruneProtect: (name) =>
        Object.values(/** @type {ConfigData} */ (this.data).remotes).some((r) => r.hub3 === name),
    });
  }

  /**
   * `devices` の応答だけからリモコンを取り込む (引数 irType 不要)。
   *
   * 各 Hub3 デバイスは `stateInfo.remoteList` に配下リモコンを
   * `{uuid, type, alias?}` 付きで持っているので、それを直接展開する。
   * 先に hub3s が登録済みである必要がある (syncHub3sFromDevices を先に呼ぶ)。
   *
   * @param {Array<DeviceRecord & {stateInfo?: {remoteList?: Array<{uuid?: string, irDeviceUUID?: string, type?: number|string, irType?: number|string, alias?: string|null, name?: string|null}>}}>} deviceList  getCompanyDevice / getUserDevice の応答
   * @returns {{added:string[], updated:string[]}}
   */
  syncRemotesFromDevices(deviceList) {
    const cfg = this.load();
    /** @type {{added:string[], updated:string[]}} */
    const result = { added: [], updated: [] };

    // deviceUUID → config 上の hub3 名 の逆引き
    /** @type {Map<string, string>} */
    const hub3ByUuid = new Map();
    for (const [name, h] of Object.entries(cfg.hub3s)) {
      hub3ByUuid.set(normalizeUuid(h.deviceId), name);
    }

    for (const d of deviceList || []) {
      if (!isHub3Model(d.deviceModel)) continue;
      const hub3Name = hub3ByUuid.get(normalizeUuid(d.deviceUUID));
      if (!hub3Name) continue; // この Hub3 が未登録ならスキップ (先に hub3 sync)
      const remoteList = d.stateInfo?.remoteList || [];

      for (const r of remoteList) {
        const irDeviceUUID = r.uuid || r.irDeviceUUID;
        if (!irDeviceUUID) continue;
        const irType = Number(r.type ?? r.irType);
        const alias = r.alias || r.name || null;

        const entry = Object.entries(cfg.remotes).find(
          ([, rm]) => normalizeUuid(rm.irDeviceUUID) === normalizeUuid(irDeviceUUID),
        );
        if (entry) {
          const [existingName, rm] = entry;
          let changed = false;
          if (Number.isFinite(irType) && rm.irType !== irType) { rm.irType = irType; changed = true; }
          if (alias && rm.alias !== alias) { rm.alias = alias; changed = true; }
          if (rm.hub3 !== hub3Name) { rm.hub3 = hub3Name; changed = true; }
          if (changed) result.updated.push(existingName);
          continue;
        }

        const name = uniqueName(cfg.remotes, baseName(alias, irDeviceUUID));
        cfg.remotes[name] = {
          hub3: hub3Name,
          irDeviceUUID,
          irType: Number.isFinite(irType) ? irType : DEFAULT_IR_TYPE,
          irOperation: "learnEmit",
          alias,
          keys: {},
        };
        if (!cfg.default.remote) cfg.default.remote = name;
        result.added.push(name);
      }
    }

    this.save();
    return result;
  }

  /**
   * server 側 (getRemoteList) のリモコン一覧から remote 定義を取り込む (上級/代替経路)。
   * 通常は syncRemotesFromDevices で足りる。company 横断の一覧が欲しい場合のみ。
   * @param {Array<{irDeviceUUID?: string, uuid?: string, type?: number|string, irType?: number|string, alias?: string|null, name?: string|null, irOperation?: string}>} remoteList  getRemoteList の応答 (irDeviceUUID/uuid, type, alias/name 等)
   * @param {string} hub3Name   これらのリモコンが属する Hub3 の config 名
   * @returns {{added:string[], updated:string[]}}
   */
  syncRemotesFromServer(remoteList, hub3Name) {
    const cfg = this.load();
    if (!cfg.hub3s[hub3Name]) {
      throw new Error(t("domain.config.hub3NotRegisteredSyncFirst", { hub3: hub3Name }));
    }
    /** @type {{added:string[], updated:string[]}} */
    const result = { added: [], updated: [] };

    for (const r of remoteList || []) {
      const irDeviceUUID = r.irDeviceUUID || r.uuid;
      if (!irDeviceUUID) continue;
      const irType = Number(r.type ?? r.irType);
      const alias = r.alias || r.name || null;

      const entry = Object.entries(cfg.remotes).find(
        ([, rm]) => normalizeUuid(rm.irDeviceUUID) === normalizeUuid(irDeviceUUID),
      );
      if (entry) {
        const [existingName, rm] = entry;
        let changed = false;
        if (Number.isFinite(irType) && rm.irType !== irType) { rm.irType = irType; changed = true; }
        if (alias && rm.alias !== alias) { rm.alias = alias; changed = true; }
        if (changed) result.updated.push(existingName);
        continue;
      }

      const name = uniqueName(cfg.remotes, baseName(alias, irDeviceUUID));
      cfg.remotes[name] = {
        hub3: hub3Name,
        irDeviceUUID,
        irType: Number.isFinite(irType) ? irType : DEFAULT_IR_TYPE,
        irOperation: r.irOperation || "learnEmit",
        alias,
        keys: {},
      };
      if (!cfg.default.remote) cfg.default.remote = name;
      result.added.push(name);
    }

    this.save();
    return result;
  }
}

// ---- model 分類 / 命名ヘルパ (config の同期で共有) ----

// biz3 の lockModelDevices ホワイトリスト (gUtils.js:279-294) と完全一致させる。
// 旧実装は prefix マッチ (sesame_/wm_2/ssmbot_/bot_/bike_) で判定していたが、これは誤り:
//   - sesame_face* / ssm_touch* (顔認証・タッチ = isSesameAccessControlDevice, gUtils.js:261)
//     を誤ってロック扱い、wm_2/bike_1 を誤判定、BLE_Connector_1 を取りこぼしていた。
// biz3 は「ロック」と「認証機」を別カテゴリとして明示的にリスト管理している。
const LOCK_MODELS = new Set([
  "sesame_2", "sesame_4", "sesame_5", "sesame_5_pro", "sesame_5_us",
  "bot_2", "bot_3", "ssmbot_1",
  "sesame_6", "sesame_6_pro", "sesame_6_pro_slidingdoor",
  "BLE_Connector_1", "bike_2", "bike_3",
]);

/**
 * ロック系 model か (biz3 lockModelDevices と完全一致, gUtils.js:279-294)。
 * @param {string|null|undefined} model
 * @returns {boolean}
 */
export function isLockModel(model) {
  return typeof model === "string" && LOCK_MODELS.has(model);
}

/**
 * Hub3 系 model か (hub_3 / hub_3_lte)。
 * @param {string|null|undefined} model
 * @returns {boolean}
 */
export function isHub3Model(model) {
  return model === "hub_3" || model === "hub_3_lte";
}

/**
 * device レコードを派生 view (lock / hub3) のどちらに出すかの既定分類。
 * device に明示 category が記録されていない場合 (sync 由来など) の fallback。
 *   - hub_3/hub_3_lte → "hub3"
 *   - lockModelDevices ホワイトリスト → "lock"
 *   - model 未指定 (null) → "lock" (機種不明の手動/旧ロック。kindForModel(null)→lock5 と整合)
 *   - それ以外 (Touch/Face/Sensor/未知文字列) → null (どの操作 view にも出さない)
 * @param {string|null|undefined} model
 * @returns {"lock"|"hub3"|null}
 */
function categoryForModel(model) {
  if (isHub3Model(model)) return "hub3";
  if (isLockModel(model)) return "lock";
  if (model == null) return "lock";
  return null;
}

/**
 * device レコードがどの操作 view (lock/hub3) に属するか。明示 category (手動 addLock/addHub3 や
 * 移行で記録) を真実とし、無ければ model から導出する。model 文字列だけでは分類できないケース
 * (機種未指定の手動ロック、未知の model 文字列) を取りこぼさないための単一の判定点。
 * _reproject (view 生成) と prune (対象選定) で共有する。
 * @param {{category?:string, deviceModel?:string|null}} rec
 * @returns {"lock"|"hub3"|null}
 */
function effectiveCategory(rec) {
  return /** @type {"lock"|"hub3"|null} */ (rec.category || categoryForModel(rec.deviceModel));
}

/**
 * キー順に依存しない正準 JSON 文字列。オブジェクトのキーを再帰的にソートして直列化する。
 * sync の変更判定で「値は同じだがキー順だけ違う」誤検知を防ぐために使う。
 * @param {unknown} value
 * @returns {string}
 */
function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const obj = /** @type {Record<string, unknown>} */ (value);
  return "{" + Object.keys(obj).sort()
    .map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]))
    .join(",") + "}";
}

/**
 * @param {unknown} s
 * @returns {string}
 */
function normalizeUuid(s) {
  return typeof s === "string" ? s.replace(/-/g, "").toLowerCase() : "";
}

/**
 * device レコードを config 保存用に整える。フィールドは取捨選択せず**ほぼ丸ごと**残すが、
 * 巨大なネスト (stateInfo の IR remoteList 等) だけは除外する (remotes 側で扱う・config 肥大回避)。
 * @param {DeviceRecord} d
 * @returns {DeviceRecord}
 */
function sanitizeDeviceRecord(d) {
  const { stateInfo, ...rest } = d; // eslint-disable-line no-unused-vars
  return { ...rest };
}

/**
 * デバイス名 (or UUID) から config キーの素を作る。
 * @param {string|null|undefined} displayName
 * @param {string|null|undefined} uuid
 * @returns {string}
 */
function baseName(displayName, uuid) {
  const src = (displayName || uuid || "device").toString();
  const slug = src.trim().replace(/\s+/g, "_").toLowerCase();
  return slug || "device";
}

/**
 * existing オブジェクトのキーと衝突しないユニーク名を返す (name, name-2, name-3...)。
 * @param {Record<string, unknown>} existing
 * @param {string} base
 * @returns {string}
 */
function uniqueName(existing, base) {
  if (!existing[base]) return base;
  let i = 2;
  while (existing[`${base}-${i}`]) i++;
  return `${base}-${i}`;
}

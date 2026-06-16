// `sesame access …` コマンド群 — SESAME Touch (Pro) の NFC カード / キーパッド暗証番号 (passcode)。
//
// 本体ロジックは src/access.js (biz3ManageAccessCtlAuthData)。ここは commander への配線と
// 入出力整形のみを担う。hub.access.* は companyID/subUUID 自動注入の namespace。
//
// ⚠️ 2層構造の注意 (本体 access.js / biz3 由来):
//   本モジュールの WS op は **サーバ DB 側の同期** を担う。カード/パスコードの実機ファーム
//   ウェアへの物理書き込み・削除は別系統 (BLE iotCmd) の責務であり、ここでは扱わない。
//   biz3 では BLE で実機を変更 → その ack 内で本 WS op を投げて DB を追従させる設計。
//   よって rm/post 系は「DB 同期のみ」であり、実機側とは別管理になりうる点に注意。
//
// 注: access の WS op (getCards/postCards/delCards/clearCards/update* 等) は送信フレームに
//     companyID も subUUID も載せない (本体 access.js 参照)。namespace が注入する値も各関数が
//     destructure しないため破棄される。よって refreshAccount() は不要で、**ctx.withHub** を使う
//     (schedule.js と同様。withAccount だと毎コマンド余分な biz3GetLoginUser 往復が発生する)。
//
// ctx 契約 (cli.js makeCtx が供給。schedule.js のコメント参照):
//   ctx.withHub(fn)     : connect → fn(hub, {opts}) → close。
//   ctx.out(json, humanFn, jsonObj) : --json 時は jsonObj、それ以外は humanFn()。
//   ctx.die(msg, code)  : エラー表示して exit。
//   ctx.canPrompt()     : TTY かつ --json なし。
//   ctx.prompts         : { selectFromList, promptText, confirm, promptLine }。
//   ctx.parseJson(raw, hint) : --json 文字列を JSON.parse (失敗時 die(...,2))。

import { t } from "@sesame-kit/core/i18n";
import { isUuidV4 } from "@sesame-kit/core/crypto";

// パスコード/カードの passwordID・cardID は biz3 サーバが採番する「レコード識別子」であり、
// 解錠 PIN such 秘密値ではない (一覧 API getPasscodes/getCards が返すのは識別子・名前・nameUUID
// のみで、暗証番号そのものは含まない)。表示前に文字列化し想定形式 (英数字/ハイフン) のみ通す
// ことで「公開 ID であってログ安全」をコード上で保証する (CodeQL js/clear-text-logging が
// フィールド名 'password*' を秘密と過検出するのを断つテイントバリアも兼ねる)。
/**
 * @param {unknown} id biz3 採番のレコード識別子 (passwordID/cardID 等)
 * @returns {string} 表示安全な公開 ID 文字列
 */
function publicRecordId(id) {
  const s = String(id ?? "").trim();
  return /^[\w-]+$/.test(s) ? s : "(no-id)";
}

/**
 * getCards の items 要素 (lib access.js:144 の集約結果)。表示で読むフィールドのみ宣言。
 * @typedef {object} CardItem
 * @property {string} [cardID]
 * @property {string} [name]
 * @property {number|string} [cardType]
 * @property {string[]} [uuids] 該当 deviceUUID 群 (idKey 集約で付与)
 */

/**
 * getPasscodes の items 要素 (lib access.js:165 の集約結果)。表示で読むフィールドのみ宣言。
 * @typedef {object} PasscodeItem
 * @property {string} [passwordID]
 * @property {string} [name]
 * @property {string[]} [uuids] 該当 deviceUUID 群 (idKey 集約で付与)
 */

/**
 * getCards / getPasscodes の戻り (lib access.js:68,143,164)。namespace getter は
 * これを unknown に erase するため CLI 側で cast に使う。
 * @template T
 * @typedef {{items: T[], byDevice: Record<string, object[]>}} AccessListResult
 */

/**
 * --device オプション値を deviceUUID 配列に正規化する。
 * commander の variadic / 繰り返し指定で配列になるが、各要素に "uuid1,uuid2" の
 * カンマ連結が混ざっても受けられるように分解する。
 * @param {string[]|string|undefined} raw
 * @returns {string[]}
 */
function normalizeDevices(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .flatMap((s) => String(s).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * deviceUUID 群を確定する。--device 指定があればそれを優先。
 * 未指定かつ対話可能なら listDevices() から選択させる (selectFromList は単一選択)。
 * 非対話なら die(...,2) で必須を案内。
 * @param {import("@sesame-kit/core/client").SesameHub3} hub
 * @param {import("../cli.js").CliCtx} ctx
 * @param {string[]} devices
 * @param {string} cmdHint die 時に出すコマンド例
 * @returns {Promise<string[]|null>} 確定できなければ null (die 済み)
 */
async function resolveDeviceUUIDs(hub, ctx, devices, cmdHint) {
  if (devices.length > 0) return devices;
  if (ctx.canPrompt()) {
    const list = await hub.listDevices();
    if (!Array.isArray(list) || list.length === 0) {
      // 対象未確定で操作が実行できない異常終了なので非 0 (2) で抜ける。
      ctx.die(t("access.err.noDevices"), 2);
      return null;
    }
    const picked = await ctx.prompts.selectFromList(
      t("access.prompt.pickDevice"),
      list,
      (d) => `${d.deviceName ?? "(no-name)"}  ${d.deviceUUID}`,
    );
    return picked?.deviceUUID ? [picked.deviceUUID] : null;
  }
  ctx.die(t("access.err.deviceRequired", { cmdHint }), 2);
  return null;
}

/**
 * BLE enroll (実機タップ/入力の即時収集 → クラウド DB 一括登録) の種別ごとの差分定義。
 * cards / passcodes で共通のフロー (cards enroll の実装) を再利用するための delegate 表
 * (SURF-04: passcode は onKeyBoardReceive / passcodeModeSet 系に差し替えるだけで同型)。
 * @typedef {object} EnrollKind
 * @property {string} cmdHint resolveDeviceUUIDs の die ヒント
 * @property {(bio: Record<string, unknown>) => boolean} hasCapability bioCaps 限定ビューに必要メソッドが生えているか
 * @property {string} notCapableKey 能力なし機種の die メッセージキー
 * @property {(collect: (id: string|undefined, record: object) => void) => object} delegateFor registerDelegate に渡す delegate
 * @property {(bio: any, mode: number) => Promise<void>} modeSet 登録モード切替 (1=REGISTER / 0=CONTROL)
 * @property {(hub: import("@sesame-kit/core/client").SesameHub3, deviceUUID: string, records: object[]) => Promise<unknown>} register クラウド DB 登録
 * @property {string} tapPromptKey 対話時のプロンプト文言キー
 * @property {string} waitingKey 非対話時の収集待ち文言キー
 * @property {string} collectedKey 収集結果文言キー
 * @property {string} noneKey 0 件文言キー
 * @property {string} registeredKey 登録完了文言キー
 * @property {string} recordsKey JSON 出力でレコード配列を入れるキー名
 */

/**
 * BLE enroll の共通フロー (cards enroll の実装を kind 差し替えで共有する。SURF-04)。
 *
 * BLE で対象機を register モードにし、タップ/入力された複数レコードを 1 件ずつ即時収集
 * (registerDelegate) → クラウド DB へ一括登録する。_LAST 待ちの onEnroll ではなく即時収集
 * なので、_LAST の到達順/解除順に依存して取りこぼさない。
 * ⚠️ 実機未検証: _FIRST/_NOTIFY/_LAST の到達順・cardName(hex) は HW で要確認 (biometric.js:839)。
 *
 * @param {import("../cli.js").CliCtx} ctx
 * @param {import("@sesame-kit/core/client").SesameHub3} hub
 * @param {Record<string, any>} opts withHub extra.opts (--json 等)
 * @param {{ device?: string[]|string, timeout?: string }} subOpts
 * @param {EnrollKind} kind
 */
async function runBleEnroll(ctx, hub, opts, subOpts, kind) {
  const devices = normalizeDevices(subOpts.device);
  const deviceUUIDs = await resolveDeviceUUIDs(hub, ctx, devices, kind.cmdHint);
  if (!deviceUUIDs) return;
  const deviceUUID = deviceUUIDs[0];

  // secretKey / model はクラウドの devices 一覧から解決 (Touch は lock config に無いことが多い)。
  const list = await hub.listDevices();
  const dev = Array.isArray(list) ? list.find((d) => d.deviceUUID === deviceUUID) : null;
  if (!dev) { ctx.die(t("access.err.cards.enroll.deviceNotFound", { deviceUUID }), 2); return; }
  if (!dev.secretKey) { ctx.die(t("access.err.cards.enroll.noSecretKey", { deviceUUID }), 2); return; }

  const ble = ctx.makeBle({ secretKey: dev.secretKey, deviceUUID, model: dev.deviceModel ?? null, debug: !!opts.debug });
  // 生体非対応機種なら明示エラー (biometric ゲッタが throw。op を捏造しない)。
  // さらに bioCaps の限定ビュー (P3-15) に当該 capability のメソッドが無い機種
  // (例: ssm_touch に passcode 系は無い) も明示エラーにする。
  // transport は遅延 (NobleTransport は connect() まで noble を開かない) ので構築済みでも leak しない。
  /** @type {any} */
  let bio;
  try { bio = ble.biometric; }
  catch { ctx.die(t(kind.notCapableKey, { deviceUUID, model: dev.deviceModel ?? "?" }), 2); return; }
  if (!kind.hasCapability(bio)) {
    ctx.die(t(kind.notCapableKey, { deviceUUID, model: dev.deviceModel ?? "?" }), 2);
    return;
  }

  const collected = new Map(); // id -> record (重複排除)
  try {
    await ble.connect();
    // 1 件ずつ即時収集する (createEnrollCollector は _LAST でしか flush しないため、
    // _LAST の到達タイミング/unsub 順に依存して取りこぼしうる — 実機未検証 biometric.js:839)。
    const unsub = bio.registerDelegate(kind.delegateFor((id, record) => {
      if (id) collected.set(id, record);
    }));
    try {
      await kind.modeSet(bio, 1); // MODE_REGISTER
      if (ctx.canPrompt()) {
        await ctx.prompts.promptText(t(kind.tapPromptKey), { required: false, defaultValue: "" });
      } else {
        const sec = Math.max(1, Number(subOpts.timeout) || 20);
        console.error(t(kind.waitingKey, { seconds: sec, deviceUUID }));
        await new Promise((r) => setTimeout(r, sec * 1000));
      }
    } finally {
      await kind.modeSet(bio, 0).catch(() => {}); // 先に register を抜け (抜ける際の publish も拾う)、
      unsub();                                    // その後に listener を解除する。
    }
  } catch (e) {
    // die() は process.exit するため finally の close は走らない。明示的に後始末してから die。
    await kind.modeSet(bio, 0).catch(() => {}); // best-effort で control へ戻す
    await ble.close().catch(() => {});
    ctx.die(t("access.err.cards.enroll.bleFailed", { error: /** @type {{message?:string}} */ (e)?.message || String(e) }), 1);
    return;
  } finally {
    await ble.close().catch(() => {});
  }

  const records = [...collected.values()];
  if (records.length === 0) {
    ctx.out(opts.json, () => console.log(t(kind.noneKey)), { ok: true, enrolled: 0, deviceUUID });
    return;
  }
  // クラウド DB へ登録 (cards: レコード毎の updateCardName 委譲 P3-11 / passcodes: postPasscodes 委譲)。
  const resp = await kind.register(hub, deviceUUID, records);
  ctx.out(opts.json, () => {
    console.log(t(kind.collectedKey, { count: records.length, ids: records.map((r) => /** @type {{cardID?:string}} */ (r).cardID).join(", ") }));
    console.log(t(kind.registeredKey, { count: records.length, deviceUUID }));
  }, { ok: true, enrolled: records.length, deviceUUID, [kind.recordsKey]: records, response: resp });
}

/**
 * @param {import("commander").Command} program
 * @param {import("../cli.js").CliCtx} ctx cli.js makeCtx() が供給する共有コンテキスト
 */
export function registerAccessCommands(program, ctx) {
  // --device オプション (variadic) のヘルプ文言。複数指定 or カンマ連結を受ける。
  // setLocale 後に register が呼ばれるため、ここ (実行時) で t() を解決する。
  const DEVICE_OPT_DESC = t("access.opt.device.variadic");
  const access = program
    .command("access")
    .description(t("access.cmd.access"));

  // ===== カード =====
  const cards = access.command("cards").description(t("access.cmd.cards"));

  // sesame access cards ls --device <uuid...>
  cards
    .command("ls")
    .description(t("access.cmd.cards.ls"))
    .option("-d, --device <uuid...>", DEVICE_OPT_DESC)
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        const devices = normalizeDevices(subOpts.device);
        const deviceUUIDs = await resolveDeviceUUIDs(hub, ctx, devices, "sesame access cards ls --device <uuid...>");
        if (!deviceUUIDs) return;
        // namespace getter は unknown を返すため、本体 getCards の戻り形へ cast。
        const { items, byDevice } = /** @type {AccessListResult<CardItem>} */ (
          await hub.access.getCards({ deviceUUIDs })
        );
        ctx.out(opts.json, () => {
          if (!Array.isArray(items) || items.length === 0) {
            console.log(t("access.noCards"));
            return;
          }
          console.log(t("access.foundCards", { count: items.length }));
          for (const c of items) {
            const id = c.cardID ?? "(no-id)";
            const nm = c.name ? ` ${c.name}` : "";
            const ty = c.cardType != null ? ` type=${c.cardType}` : "";
            console.log(`  ${id}${nm}${ty}\t[${(c.uuids || []).join(",")}]`);
          }
        }, { ok: true, count: Array.isArray(items) ? items.length : 0, items, byDevice });
      }),
    );

  // sesame access cards rm --json <items>
  cards
    .command("rm")
    .description(t("access.cmd.cards.rm"))
    .option("--json <items>", t("access.opt.cards.rm.json"))
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        // delCards は items 配列をトップレベルに置く構造。deviceUUID ではなく deviceID 注意。
        if (!subOpts.json) {
          ctx.die(t("access.err.cards.rm.jsonRequired"), 2);
          return;
        }
        const items = ctx.parseJson(subOpts.json, "items");
        if (items === undefined) return;
        if (!Array.isArray(items)) {
          ctx.die(t("access.err.items.notArray"), 2);
          return;
        }
        // 本体は boolean を返す (送信したら true、空配列なら false)。応答 op は来ない。
        const sent = hub.access.delCards({ items });
        ctx.out(opts.json, () => {
          console.log(sent ? t("access.cards.rm.sent", { count: items.length }) : t("access.rm.nothingSent"));
        }, { ok: true, sent, count: items.length });
      }),
    );

  // sesame access cards clear --device <uuid>
  cards
    .command("clear")
    .description(t("access.cmd.cards.clear"))
    .option("-d, --device <uuid>", t("access.opt.device.single"))
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        const devices = normalizeDevices(subOpts.device);
        // clearCards は単一 deviceUUID のみ。複数渡されても先頭を使う。
        const deviceUUIDs = await resolveDeviceUUIDs(hub, ctx, devices, "sesame access cards clear --device <uuid>");
        if (!deviceUUIDs) return;
        const deviceUUID = deviceUUIDs[0];
        if (ctx.canPrompt()) {
          const ok = await ctx.prompts.confirm(t("access.prompt.cards.clearConfirm", { deviceUUID }), { defaultYes: false });
          if (!ok) {
            console.error(t("access.aborted"));
            return;
          }
        }
        const resp = await hub.access.clearCards({ deviceUUID });
        ctx.out(opts.json, () => {
          console.log(t("access.cards.cleared", { deviceUUID }));
        }, { ok: true, deviceUUID, response: resp });
      }),
    );

  // sesame access cards name --json <item>
  cards
    .command("name")
    .description(t("access.cmd.cards.name"))
    .option("--json <item>", t("access.opt.cards.name.json"))
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        if (!subOpts.json) {
          ctx.die(t("access.err.cards.name.jsonRequired"), 2);
          return;
        }
        const item = ctx.parseJson(subOpts.json, "item");
        if (item === undefined) return;
        // P3-9: 非 v4 nameUUID の警告。
        // biz3 updateItemName (useManageAuthData.js:438-471) は isUUIDV4(uuidValue) を判定し、
        // 非 v4 なら BLE SSM_OS3_CARD_CHANGE(107) で v4 UUID をファームに書き込んだ後に更新する。
        // kit はオプトイン (BLE composite は別途必要)。非 v4 検出時は警告のみで処理継続。
        // @experimental 実機未検証 (参照: useManageAuthData.js:438-471)。§9 V17。
        const nameUUID = item.cardNameUUID ?? item.nameUUID;
        if (nameUUID && !isUuidV4(nameUUID)) {
          console.error(
            `[sesame] Warning: cardNameUUID "${nameUUID}" is not UUID v4. ` +
            "biz3 would run BLE SSM_OS3_CARD_CHANGE(107) to assign a v4 UUID first. " +
            "Run BLE cardChange with a new v4 UUID if your firmware requires it " +
            "(ref: useManageAuthData.js:438-471).",
          );
        }
        const resp = await hub.access.updateCardName({ item });
        ctx.out(opts.json, () => {
          console.log(t("access.cards.nameUpdated", { cardID: item.cardID ?? "?" }));
        }, { ok: true, item, response: resp });
      }),
    );

  // sesame access cards owner <cardID> [ownerSubUUID]
  cards
    .command("owner <cardID> [ownerSubUUID]")
    .description(t("access.cmd.cards.owner"))
    .action((cardID, ownerSubUUID) =>
      ctx.withHub(async (hub, { opts }) => {
        // biz3: 'ownerSubUUID' in item の時だけ送る。undefined は送らない。'' は送って解除。
        if (ownerSubUUID === undefined && ctx.canPrompt()) {
          ownerSubUUID = await ctx.prompts.promptText(
            t("access.prompt.ownerSubUUID"),
            { required: false, defaultValue: "" },
          );
        }
        if (ownerSubUUID === undefined) {
          ctx.die(t("access.err.ownerSubUUIDRequired"), 2);
          return;
        }
        const resp = await hub.access.updateCardOwner({ cardID, ownerSubUUID });
        ctx.out(opts.json, () => {
          console.log(t("access.cards.ownerUpdated", { cardID, ownerSubUUID: ownerSubUUID === "" ? t("access.ownerUnassigned") : ownerSubUUID }));
        }, { ok: true, cardID, ownerSubUUID, response: resp });
      }),
    );

  // sesame access cards post --device <uuid> --json <list>
  cards
    .command("post")
    .description(t("access.cmd.cards.post"))
    .option("-d, --device <uuid>", t("access.opt.cards.post.device"))
    .option("--json <list>", t("access.opt.cards.post.json"))
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        if (!subOpts.json) {
          ctx.die(t("access.err.cards.post.jsonRequired"), 2);
          return;
        }
        const list = ctx.parseJson(subOpts.json, "list");
        if (list === undefined) return;
        if (!Array.isArray(list)) {
          ctx.die(t("access.err.list.notArray"), 2);
          return;
        }
        const devices = normalizeDevices(subOpts.device);
        const deviceUUIDs = await resolveDeviceUUIDs(hub, ctx, devices, "sesame access cards post --device <uuid> --json <list>");
        if (!deviceUUIDs) return;
        const deviceUUID = deviceUUIDs[0];
        // 本体は list.length < 1 なら null を返す。
        const resp = await hub.access.postCards({ deviceUUID, list });
        ctx.out(opts.json, () => {
          console.log(resp === null ? t("access.post.emptyList") : t("access.cards.posted", { count: list.length, deviceUUID }));
        }, { ok: true, deviceUUID, count: list.length, response: resp });
      }),
    );

  // sesame access cards enroll --device <uuid>  (experimental, BLE 物理読み取り)
  //
  // BLE で Touch を register モード (MODE_REGISTER=1, SSMBiometricCard.kt:74) にし、タップされた
  // 複数カードを 1 枚ずつ収集 (registerDelegate.onCardReceive) → クラウド DB へ一括登録
  // (hub.registerCards = レコード毎の updateCardName 委譲、P3-11)。共通フローは runBleEnroll。
  cards
    .command("enroll")
    .description(t("access.cmd.cards.enroll"))
    .option("-d, --device <uuid>", t("access.opt.cards.enroll.device"))
    .option("--timeout <sec>", t("access.opt.cards.enroll.timeout"))
    .action((subOpts) =>
      ctx.withHub((hub, { opts }) => runBleEnroll(ctx, hub, opts, subOpts, {
        cmdHint: "sesame access cards enroll --device <uuid>",
        // bioCaps 限定ビュー (P3-15): card 能力が無い機種 (例 sesame_face_ai) では
        // cardModeSet が生えない → 明示エラー。
        hasCapability: (bio) => typeof bio.cardModeSet === "function",
        notCapableKey: "access.err.cards.enroll.notBiometric",
        delegateFor: (collect) => ({
          /** @param {string} cardID @param {string} cardName @param {number} cardType */
          onCardReceive: (cardID, cardName, cardType) => collect(cardID, { cardID, cardName, cardType }),
        }),
        modeSet: (bio, mode) => bio.cardModeSet(mode),
        register: (hub2, deviceUUID, records) => hub2.registerCards(deviceUUID, /** @type {any} */ (records)),
        tapPromptKey: "access.enroll.tapPrompt",
        waitingKey: "access.enroll.waiting",
        collectedKey: "access.enroll.collected",
        noneKey: "access.enroll.none",
        registeredKey: "access.enroll.registered",
        recordsKey: "cards",
      })),
    );

  // ===== パスコード =====
  const passcodes = access.command("passcodes").description(t("access.cmd.passcodes"));

  // sesame access passcodes ls --device <uuid...>
  passcodes
    .command("ls")
    .description(t("access.cmd.passcodes.ls"))
    .option("-d, --device <uuid...>", DEVICE_OPT_DESC)
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        const devices = normalizeDevices(subOpts.device);
        const deviceUUIDs = await resolveDeviceUUIDs(hub, ctx, devices, "sesame access passcodes ls --device <uuid...>");
        if (!deviceUUIDs) return;
        // namespace getter は unknown を返すため、本体 getPasscodes の戻り形へ cast。
        const { items, byDevice } = /** @type {AccessListResult<PasscodeItem>} */ (
          await hub.access.getPasscodes({ deviceUUIDs })
        );
        ctx.out(opts.json, () => {
          if (!Array.isArray(items) || items.length === 0) {
            console.log(t("access.noPasscodes"));
            return;
          }
          console.log(t("access.foundPasscodes", { count: items.length }));
          for (const p of items) {
            const id = publicRecordId(p.passwordID); // 公開レコード識別子 (PIN 値ではない)
            const nm = p.name ? ` ${p.name}` : "";
            console.log(`  ${id}${nm}\t[${(p.uuids || []).join(",")}]`);
          }
        }, { ok: true, count: Array.isArray(items) ? items.length : 0, items, byDevice });
      }),
    );

  // sesame access passcodes rm --json <items>
  passcodes
    .command("rm")
    .description(t("access.cmd.passcodes.rm"))
    .option("--json <items>", t("access.opt.passcodes.rm.json"))
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        if (!subOpts.json) {
          ctx.die(t("access.err.passcodes.rm.jsonRequired"), 2);
          return;
        }
        const items = ctx.parseJson(subOpts.json, "items");
        if (items === undefined) return;
        if (!Array.isArray(items)) {
          ctx.die(t("access.err.items.notArray"), 2);
          return;
        }
        const sent = hub.access.delPasscodes({ items });
        ctx.out(opts.json, () => {
          console.log(sent ? t("access.passcodes.rm.sent", { count: items.length }) : t("access.rm.nothingSent"));
        }, { ok: true, sent, count: items.length });
      }),
    );

  // sesame access passcodes clear --device <uuid>
  passcodes
    .command("clear")
    .description(t("access.cmd.passcodes.clear"))
    .option("-d, --device <uuid>", t("access.opt.device.single"))
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        const devices = normalizeDevices(subOpts.device);
        const deviceUUIDs = await resolveDeviceUUIDs(hub, ctx, devices, "sesame access passcodes clear --device <uuid>");
        if (!deviceUUIDs) return;
        const deviceUUID = deviceUUIDs[0];
        if (ctx.canPrompt()) {
          const ok = await ctx.prompts.confirm(t("access.prompt.passcodes.clearConfirm", { deviceUUID }), { defaultYes: false });
          if (!ok) {
            console.error(t("access.aborted"));
            return;
          }
        }
        const resp = await hub.access.clearPasscodes({ deviceUUID });
        ctx.out(opts.json, () => {
          console.log(t("access.passcodes.cleared", { deviceUUID }));
        }, { ok: true, deviceUUID, response: resp });
      }),
    );

  // sesame access passcodes name --json <item>
  passcodes
    .command("name")
    .description(t("access.cmd.passcodes.name"))
    .option("--json <item>", t("access.opt.passcodes.name.json"))
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        if (!subOpts.json) {
          ctx.die(t("access.err.passcodes.name.jsonRequired"), 2);
          return;
        }
        const item = ctx.parseJson(subOpts.json, "item");
        if (item === undefined) return;
        // P3-9 と対称: 非 v4 keyBoardPassCodeNameUUID の警告。
        // biz3 updateItemName (useManageAuthData.js:431-471) は isUUIDV4(uuidValue) で判定し、
        // card / password 両方に SSM_OS3_CARD_CHANGE / SSM_OS3_PASSCODE_CHANGE を適用する。
        // cards name (:330-338) と対称に、非 v4 検出時は警告のみで処理継続する。
        const nameUUID = item.keyBoardPassCodeNameUUID ?? item.nameUUID;
        if (nameUUID && !isUuidV4(nameUUID)) {
          console.error(
            `[sesame] Warning: keyBoardPassCodeNameUUID "${nameUUID}" is not UUID v4. ` +
            "biz3 would run BLE SSM_OS3_PASSCODE_CHANGE to assign a v4 UUID first. " +
            "Run BLE passcodeChange with a new v4 UUID if your firmware requires it " +
            "(ref: useManageAuthData.js:431-471).",
          );
        }
        const resp = await hub.access.updatePasscodeName({ item });
        ctx.out(opts.json, () => {
          console.log(t("access.passcodes.nameUpdated", { keyBoardPassCode: item.keyBoardPassCode ?? "?" }));
        }, { ok: true, item, response: resp });
      }),
    );

  // sesame access passcodes enroll --device <uuid>  (experimental, BLE 物理入力)
  //
  // SURF-04: cards enroll と対称。register モード (PASSCODE_MODE_SET=1) で入力された複数
  // パスコードを 1 件ずつ収集 (registerDelegate.onKeyBoardReceive — CHPassCodeEventHandlers.kt:28-37
  // と同じ publish) → hub.registerPasscodes (= syncEnrolledPasscodes → postPasscodes 委譲) で
  // クラウド DB へ一括登録する。
  // ⚠️ bioCaps ゲート: passcode 能力はキーパッド搭載機 (TOUCH_PRO 系等) のみ
  //    (CHSesameBiometricDevice.kt:44-57)。bioCaps に passcode が無い機種 (ssm_touch 等) では
  //    biometric 限定ビューに passcodeModeSet が生えず、明示エラーで止める (op を捏造しない)。
  // ⚠️ 実機未検証 (cards enroll と同じ注意。biometric.js:839)。
  passcodes
    .command("enroll")
    .description(t("access.cmd.passcodes.enroll"))
    .option("-d, --device <uuid>", t("access.opt.passcodes.enroll.device"))
    .option("--timeout <sec>", t("access.opt.cards.enroll.timeout"))
    .action((subOpts) =>
      ctx.withHub((hub, { opts }) => runBleEnroll(ctx, hub, opts, subOpts, {
        cmdHint: "sesame access passcodes enroll --device <uuid>",
        hasCapability: (bio) => typeof bio.passcodeModeSet === "function",
        notCapableKey: "access.err.passcodes.enroll.notCapable",
        delegateFor: (collect) => ({
          // passcode の publish delegate は onKeyBoardReceive (CHPassCodeEventHandlers.kt 系)。
          // record 形は card と同型 {cardID, cardName, cardType} (parseTouchCard 共通) で、
          // enrolledToPasscodeList が {passwordID, name, nameUUID} へ写像する (nameUUID 透過)。
          /** @param {string} cardID @param {string} cardName @param {number} cardType */
          onKeyBoardReceive: (cardID, cardName, cardType) => collect(cardID, { cardID, cardName, cardType }),
        }),
        modeSet: (bio, mode) => bio.passcodeModeSet(mode),
        register: (hub2, deviceUUID, records) => hub2.registerPasscodes(deviceUUID, /** @type {any} */ (records)),
        tapPromptKey: "access.enroll.passcodes.tapPrompt",
        waitingKey: "access.enroll.passcodes.waiting",
        collectedKey: "access.enroll.passcodes.collected",
        noneKey: "access.enroll.passcodes.none",
        registeredKey: "access.enroll.passcodes.registered",
        recordsKey: "passcodes",
      })),
    );

  // sesame access passcodes post --device <uuid> --json <list>
  passcodes
    .command("post")
    .description(t("access.cmd.passcodes.post"))
    .option("-d, --device <uuid>", t("access.opt.passcodes.post.device"))
    .option("--json <list>", t("access.opt.passcodes.post.json"))
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        if (!subOpts.json) {
          ctx.die(t("access.err.passcodes.post.jsonRequired"), 2);
          return;
        }
        const list = ctx.parseJson(subOpts.json, "list");
        if (list === undefined) return;
        if (!Array.isArray(list)) {
          ctx.die(t("access.err.list.notArray"), 2);
          return;
        }
        const devices = normalizeDevices(subOpts.device);
        const deviceUUIDs = await resolveDeviceUUIDs(hub, ctx, devices, "sesame access passcodes post --device <uuid> --json <list>");
        if (!deviceUUIDs) return;
        const deviceUUID = deviceUUIDs[0];
        const resp = await hub.access.postPasscodes({ deviceUUID, list });
        ctx.out(opts.json, () => {
          console.log(resp === null ? t("access.post.emptyList") : t("access.passcodes.posted", { count: list.length, deviceUUID }));
        }, { ok: true, deviceUUID, count: list.length, response: resp });
      }),
    );

  // ===== 生体 REST 直接操作 (auth-data) =====
  //
  // P4-4 (R2:SURF-30): SigV4 biometrics REST の 4 メソッドを CLI から叩けるようにする。
  // serve/registry.js:959-1003 の RPC 実装 (access.postAuthenticationData 等) と同じ
  // client.js メソッドに配線し、serve 未起動でも CLI 単体で到達できるようにする。
  // 全 op は @experimental (実機未検証)。
  const authData = access.command("auth-data").description(t("access.cmd.authData"));

  // sesame access auth-data post --operation <op> --device-id <id> --items <json>
  authData
    .command("post")
    .description(t("access.cmd.authData.post"))
    .option("--operation <op>", t("access.opt.authData.operation"))
    .option("--device-id <id>", t("access.opt.authData.deviceId"))
    .option("--items <json>", t("access.opt.authData.items"))
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        // operation/deviceID/items はすべて必須 (registry.js:961 の need() と同型)。
        if (!subOpts.operation) { ctx.die(t("access.err.authData.operationRequired"), 2); return; }
        if (!subOpts.deviceId) { ctx.die(t("access.err.authData.deviceIdRequired"), 2); return; }
        if (!subOpts.items) { ctx.die(t("access.err.authData.itemsRequired"), 2); return; }
        const items = ctx.parseJson(subOpts.items, "items");
        if (items === undefined) return;
        if (!Array.isArray(items)) { ctx.die(t("access.err.items.notArray"), 2); return; }
        const resp = await hub.postAuthenticationData({ operation: subOpts.operation, deviceID: subOpts.deviceId, items });
        ctx.out(opts.json, () => {
          console.log(t("access.authData.post.done", { operation: subOpts.operation, deviceId: subOpts.deviceId }));
        }, { ok: true, operation: subOpts.operation, deviceID: subOpts.deviceId, response: resp });
      }),
    );

  // sesame access auth-data put --operation <op> --device-id <id> --items <json>
  authData
    .command("put")
    .description(t("access.cmd.authData.put"))
    .option("--operation <op>", t("access.opt.authData.operation"))
    .option("--device-id <id>", t("access.opt.authData.deviceId"))
    .option("--items <json>", t("access.opt.authData.items"))
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        if (!subOpts.operation) { ctx.die(t("access.err.authData.operationRequired"), 2); return; }
        if (!subOpts.deviceId) { ctx.die(t("access.err.authData.deviceIdRequired"), 2); return; }
        if (!subOpts.items) { ctx.die(t("access.err.authData.itemsRequired"), 2); return; }
        const items = ctx.parseJson(subOpts.items, "items");
        if (items === undefined) return;
        if (!Array.isArray(items)) { ctx.die(t("access.err.items.notArray"), 2); return; }
        const resp = await hub.putAuthenticationData({ operation: subOpts.operation, deviceID: subOpts.deviceId, items });
        ctx.out(opts.json, () => {
          console.log(t("access.authData.put.done", { operation: subOpts.operation, deviceId: subOpts.deviceId }));
        }, { ok: true, operation: subOpts.operation, deviceID: subOpts.deviceId, response: resp });
      }),
    );

  // sesame access auth-data delete --operation <op> --device-id <id> --items <json>
  authData
    .command("delete")
    .description(t("access.cmd.authData.delete"))
    .option("--operation <op>", t("access.opt.authData.operation"))
    .option("--device-id <id>", t("access.opt.authData.deviceId"))
    .option("--items <json>", t("access.opt.authData.items"))
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        if (!subOpts.operation) { ctx.die(t("access.err.authData.operationRequired"), 2); return; }
        if (!subOpts.deviceId) { ctx.die(t("access.err.authData.deviceIdRequired"), 2); return; }
        if (!subOpts.items) { ctx.die(t("access.err.authData.itemsRequired"), 2); return; }
        const items = ctx.parseJson(subOpts.items, "items");
        if (items === undefined) return;
        if (!Array.isArray(items)) { ctx.die(t("access.err.items.notArray"), 2); return; }
        const resp = await hub.deleteAuthenticationData({ operation: subOpts.operation, deviceID: subOpts.deviceId, items });
        ctx.out(opts.json, () => {
          console.log(t("access.authData.delete.done", { operation: subOpts.operation, deviceId: subOpts.deviceId }));
        }, { ok: true, operation: subOpts.operation, deviceID: subOpts.deviceId, response: resp });
      }),
    );

  // sesame access auth-data name --kind <kind> [--json <fields>]
  // registry.js:977-1003 の access.updateAuthenticationName と同型。
  // kind は 'card'|'face'|'fingerPrint'|'palm'|'passcode' (access.js:94)。
  // 残りのフィールド (stpDeviceUUID/name/nameUUID/op 等) は --json <object> で渡す。
  authData
    .command("name")
    .description(t("access.cmd.authData.name"))
    .option("--kind <kind>", t("access.opt.authData.kind"))
    .option("--json <fields>", t("access.opt.authData.nameFields"))
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        // kind は省略可 (request 直指定の場合は --json に request ごと入れる)。
        // access.js:734 は kind が無くても request があれば動く。
        const extra = subOpts.json ? ctx.parseJson(subOpts.json, "fields") : {};
        if (extra === undefined) return;
        const params = { kind: subOpts.kind, .../** @type {object} */ (extra) };
        const resp = await hub.updateAuthenticationName(params);
        ctx.out(opts.json, () => {
          console.log(t("access.authData.name.done", { kind: subOpts.kind ?? "(none)" }));
        }, { ok: true, kind: subOpts.kind ?? null, response: resp });
      }),
    );
}

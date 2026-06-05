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
 * @param {object} hub
 * @param {object} ctx
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
      ctx.die("デバイスが見つかりません。", 2);
      return null;
    }
    const picked = await ctx.prompts.selectFromList(
      "対象デバイスを選択",
      list,
      (d) => `${d.deviceName ?? "(no-name)"}  ${d.deviceUUID}`,
    );
    return picked?.deviceUUID ? [picked.deviceUUID] : null;
  }
  ctx.die(`--device <uuid...> が必要です: ${cmdHint} (非対話モード)`, 2);
  return null;
}

/** --device オプション (variadic) のヘルプ文言。複数指定 or カンマ連結を受ける。 */
const DEVICE_OPT_DESC = "対象 deviceUUID (複数指定 or カンマ連結。省略時は対話選択)";

/**
 * @param {import("commander").Command} program
 * @param {object} ctx cli.js makeCtx() が供給する共有コンテキスト
 */
export function registerAccessCommands(program, ctx) {
  const access = program
    .command("access")
    .description("アクセス制御データ (NFC カード/暗証番号の WS DB 同期。実機書き込みは別系統 BLE)");

  // ===== カード =====
  const cards = access.command("cards").description("NFC カード (DB 同期)");

  // sesame access cards ls --device <uuid...>
  cards
    .command("ls")
    .description("対象デバイスのカード一覧 (getCards。pub*LinkedIDs の async push を集約して返す)")
    .option("-d, --device <uuid...>", DEVICE_OPT_DESC)
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        const devices = normalizeDevices(subOpts.device);
        const deviceUUIDs = await resolveDeviceUUIDs(hub, ctx, devices, "sesame access cards ls --device <uuid...>");
        if (!deviceUUIDs) return;
        const { items, byDevice } = await hub.access.getCards({ deviceUUIDs });
        ctx.out(opts.json, () => {
          if (!Array.isArray(items) || items.length === 0) {
            console.log("(no cards)");
            return;
          }
          console.log(`Found ${items.length} card(s):`);
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
    .description("カードを DB から削除 (delCards。fire-and-forget・応答 op なし)")
    .option("--json <items>", 'items 配列の JSON。要素は {deviceID, cardID} (deviceUUID ではない)。')
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        // delCards は items 配列をトップレベルに置く構造。deviceUUID ではなく deviceID 注意。
        if (!subOpts.json) {
          ctx.die('--json <items> が必要です: 要素は {deviceID, cardID} の配列。', 2);
          return;
        }
        const items = ctx.parseJson(subOpts.json, "items");
        if (items === undefined) return;
        if (!Array.isArray(items)) {
          ctx.die("items は配列である必要があります。", 2);
          return;
        }
        // 本体は boolean を返す (送信したら true、空配列なら false)。応答 op は来ない。
        const sent = hub.access.delCards({ items });
        ctx.out(opts.json, () => {
          console.log(sent ? `OK: sent delCards for ${items.length} item(s)` : "(no items — nothing sent)");
        }, { ok: true, sent, count: items.length });
      }),
    );

  // sesame access cards clear --device <uuid>
  cards
    .command("clear")
    .description("指定デバイスのカードを全削除 (clearCards。単一 deviceUUID)")
    .option("-d, --device <uuid>", "対象 deviceUUID (省略時は対話選択)")
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        const devices = normalizeDevices(subOpts.device);
        // clearCards は単一 deviceUUID のみ。複数渡されても先頭を使う。
        const deviceUUIDs = await resolveDeviceUUIDs(hub, ctx, devices, "sesame access cards clear --device <uuid>");
        if (!deviceUUIDs) return;
        const deviceUUID = deviceUUIDs[0];
        if (ctx.canPrompt()) {
          const ok = await ctx.prompts.confirm(`デバイス ${deviceUUID} のカードを全削除しますか?`, { defaultYes: false });
          if (!ok) {
            console.error("中止しました。");
            return;
          }
        }
        const resp = await hub.access.clearCards({ deviceUUID });
        ctx.out(opts.json, () => {
          console.log(`OK: cleared cards on ${deviceUUID}`);
        }, { ok: true, deviceUUID, response: resp });
      }),
    );

  // sesame access cards name --json <item>
  cards
    .command("name")
    .description("カード名 / nameUUID を更新 (updateCardName)")
    .option(
      "--json <item>",
      'item の JSON: { cardID, name, cardNameUUID, timestamp?, cardType?, stpDeviceUUID }。' +
        ' ⚠️ cardNameUUID が UUIDv4 でないと biz3 は BLE 前段を挟む。CLI は v4 を渡すこと。',
    )
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        if (!subOpts.json) {
          ctx.die('--json <item> が必要です: { cardID, name, cardNameUUID, stpDeviceUUID }。', 2);
          return;
        }
        const item = ctx.parseJson(subOpts.json, "item");
        if (item === undefined) return;
        const resp = await hub.access.updateCardName({ item });
        ctx.out(opts.json, () => {
          console.log(`OK: updated card name (cardID=${item.cardID ?? "?"})`);
        }, { ok: true, item, response: resp });
      }),
    );

  // sesame access cards owner <cardID> [ownerSubUUID]
  cards
    .command("owner <cardID> [ownerSubUUID]")
    .description("カードの所有者 (メンバー subUUID) を割当 (updateCardOwner)。省略で対話、空文字 '' で未割当解除")
    .action((cardID, ownerSubUUID) =>
      ctx.withHub(async (hub, { opts }) => {
        // biz3: 'ownerSubUUID' in item の時だけ送る。undefined は送らない。'' は送って解除。
        if (ownerSubUUID === undefined && ctx.canPrompt()) {
          ownerSubUUID = await ctx.prompts.promptText(
            "割当先 ownerSubUUID (空 Enter で未割当解除)",
            { required: false, defaultValue: "" },
          );
        }
        if (ownerSubUUID === undefined) {
          ctx.die("ownerSubUUID が必要です (非対話モード。'' で未割当解除): sesame access cards owner <cardID> <ownerSubUUID>", 2);
          return;
        }
        const resp = await hub.access.updateCardOwner({ cardID, ownerSubUUID });
        ctx.out(opts.json, () => {
          console.log(`OK: cardID=${cardID} owner -> ${ownerSubUUID === "" ? "(未割当)" : ownerSubUUID}`);
        }, { ok: true, cardID, ownerSubUUID, response: resp });
      }),
    );

  // sesame access cards post --device <uuid> --json <list>
  cards
    .command("post")
    .description("カードを DB に登録 (postCards。⚠️ DB 同期のみ。実機書き込みは別系統 BLE)")
    .option("-d, --device <uuid>", "登録先 deviceUUID (省略時は対話選択)")
    .option("--json <list>", 'list 配列の JSON。要素は { cardID, nameUUID, name, cardType, memberID? } 等。')
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        if (!subOpts.json) {
          ctx.die('--json <list> が必要です: カード要素の配列。', 2);
          return;
        }
        const list = ctx.parseJson(subOpts.json, "list");
        if (list === undefined) return;
        if (!Array.isArray(list)) {
          ctx.die("list は配列である必要があります。", 2);
          return;
        }
        const devices = normalizeDevices(subOpts.device);
        const deviceUUIDs = await resolveDeviceUUIDs(hub, ctx, devices, "sesame access cards post --device <uuid> --json <list>");
        if (!deviceUUIDs) return;
        const deviceUUID = deviceUUIDs[0];
        // 本体は list.length < 1 なら null を返す。
        const resp = await hub.access.postCards({ deviceUUID, list });
        ctx.out(opts.json, () => {
          console.log(resp === null ? "(empty list — nothing posted)" : `OK: posted ${list.length} card(s) to ${deviceUUID}`);
        }, { ok: true, deviceUUID, count: list.length, response: resp });
      }),
    );

  // ===== パスコード =====
  const passcodes = access.command("passcodes").description("キーパッド暗証番号 (DB 同期)");

  // sesame access passcodes ls --device <uuid...>
  passcodes
    .command("ls")
    .description("対象デバイスの暗証番号一覧 (getPasscodes。pubPasscodeLinkedIDs を集約して返す)")
    .option("-d, --device <uuid...>", DEVICE_OPT_DESC)
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        const devices = normalizeDevices(subOpts.device);
        const deviceUUIDs = await resolveDeviceUUIDs(hub, ctx, devices, "sesame access passcodes ls --device <uuid...>");
        if (!deviceUUIDs) return;
        const { items, byDevice } = await hub.access.getPasscodes({ deviceUUIDs });
        ctx.out(opts.json, () => {
          if (!Array.isArray(items) || items.length === 0) {
            console.log("(no passcodes)");
            return;
          }
          console.log(`Found ${items.length} passcode(s):`);
          for (const p of items) {
            const id = p.passwordID ?? "(no-id)";
            const nm = p.name ? ` ${p.name}` : "";
            console.log(`  ${id}${nm}\t[${(p.uuids || []).join(",")}]`);
          }
        }, { ok: true, count: Array.isArray(items) ? items.length : 0, items, byDevice });
      }),
    );

  // sesame access passcodes rm --json <items>
  passcodes
    .command("rm")
    .description("暗証番号を DB から削除 (delPasscodes。fire-and-forget・応答 op なし)")
    .option("--json <items>", 'items 配列の JSON。要素は {deviceID, passwordID}。')
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        if (!subOpts.json) {
          ctx.die('--json <items> が必要です: 要素は {deviceID, passwordID} の配列。', 2);
          return;
        }
        const items = ctx.parseJson(subOpts.json, "items");
        if (items === undefined) return;
        if (!Array.isArray(items)) {
          ctx.die("items は配列である必要があります。", 2);
          return;
        }
        const sent = hub.access.delPasscodes({ items });
        ctx.out(opts.json, () => {
          console.log(sent ? `OK: sent delPasscodes for ${items.length} item(s)` : "(no items — nothing sent)");
        }, { ok: true, sent, count: items.length });
      }),
    );

  // sesame access passcodes clear --device <uuid>
  passcodes
    .command("clear")
    .description("指定デバイスの暗証番号を全削除 (clearPasscodes。単一 deviceUUID)")
    .option("-d, --device <uuid>", "対象 deviceUUID (省略時は対話選択)")
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        const devices = normalizeDevices(subOpts.device);
        const deviceUUIDs = await resolveDeviceUUIDs(hub, ctx, devices, "sesame access passcodes clear --device <uuid>");
        if (!deviceUUIDs) return;
        const deviceUUID = deviceUUIDs[0];
        if (ctx.canPrompt()) {
          const ok = await ctx.prompts.confirm(`デバイス ${deviceUUID} の暗証番号を全削除しますか?`, { defaultYes: false });
          if (!ok) {
            console.error("中止しました。");
            return;
          }
        }
        const resp = await hub.access.clearPasscodes({ deviceUUID });
        ctx.out(opts.json, () => {
          console.log(`OK: cleared passcodes on ${deviceUUID}`);
        }, { ok: true, deviceUUID, response: resp });
      }),
    );

  // sesame access passcodes name --json <item>
  passcodes
    .command("name")
    .description("暗証番号名 / nameUUID を更新 (updatePasscodeName)")
    .option(
      "--json <item>",
      'item の JSON: { stpDeviceUUID, keyBoardPassCode, keyBoardPassCodeNameUUID, name }。' +
        ' ⚠️ keyBoardPassCodeNameUUID が UUIDv4 でないと biz3 は BLE 前段を挟む。CLI は v4 を渡すこと。',
    )
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        if (!subOpts.json) {
          ctx.die('--json <item> が必要です: { stpDeviceUUID, keyBoardPassCode, keyBoardPassCodeNameUUID, name }。', 2);
          return;
        }
        const item = ctx.parseJson(subOpts.json, "item");
        if (item === undefined) return;
        const resp = await hub.access.updatePasscodeName({ item });
        ctx.out(opts.json, () => {
          console.log(`OK: updated passcode name (keyBoardPassCode=${item.keyBoardPassCode ?? "?"})`);
        }, { ok: true, item, response: resp });
      }),
    );

  // sesame access passcodes post --device <uuid> --json <list>
  passcodes
    .command("post")
    .description("暗証番号を DB に登録 (postPasscodes。⚠️ DB 同期のみ。list 要素は未確認・実機検証要)")
    .option("-d, --device <uuid>", "登録先 deviceUUID (省略時は対話選択)")
    .option("--json <list>", 'list 配列の JSON。要素フィールドは biz3 上では未確認 (getPasscodes 応答 item と対応と推測)。')
    .action((subOpts) =>
      ctx.withHub(async (hub, { opts }) => {
        if (!subOpts.json) {
          ctx.die('--json <list> が必要です: 暗証番号要素の配列。', 2);
          return;
        }
        const list = ctx.parseJson(subOpts.json, "list");
        if (list === undefined) return;
        if (!Array.isArray(list)) {
          ctx.die("list は配列である必要があります。", 2);
          return;
        }
        const devices = normalizeDevices(subOpts.device);
        const deviceUUIDs = await resolveDeviceUUIDs(hub, ctx, devices, "sesame access passcodes post --device <uuid> --json <list>");
        if (!deviceUUIDs) return;
        const deviceUUID = deviceUUIDs[0];
        const resp = await hub.access.postPasscodes({ deviceUUID, list });
        ctx.out(opts.json, () => {
          console.log(resp === null ? "(empty list — nothing posted)" : `OK: posted ${list.length} passcode(s) to ${deviceUUID}`);
        }, { ok: true, deviceUUID, count: list.length, response: resp });
      }),
    );
}

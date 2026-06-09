// `sesame iot …` コマンド群。
//
// 本体ロジックは src/iot.js (biz3OperateIoT / op='cmd')。LED 調光 / LTE リレー /
// ファームウェア更新 / WiFi 設定クリア / Matter ペアリング / ぶら下がり Sesame の
// 追加・削除を Hub3 (WiFi/LTE) 経由で操作する。ここは commander への配線と
// 入出力整形のみを担う。
//
// ctx 契約 (cli.js makeCtx が供給。詳細は schedule.js のコメント):
//   ctx.withHub(fn)   : connect → fn(hub, {opts, paths}) → close。
//                       hub.iot.<op>(params) で本体を呼ぶ (companyID 不要な op が多いので
//                       基本 withHub。namespace は client を第1引数に注入する)。
//   ctx.out / die / canPrompt / prompts は schedule.js と同じ。
//   ctx.loadCtx().configStore.load() で config (hub3s/locks) を引いて補完に使う。
//
// iot op の引数は全て deviceId(対象 UUID) / secretKey(32hex, CMAC 署名用) / hub3Id(topic 用,
// 親 Hub3 または自身) を取る。これらは --device / --secret / --hub3 で受ける。省略時は
// config (hub3s/locks) や hub.listDevices() から補完を試み、不可なら die(...,2)。
//
// 重要 (本体 JSDoc 由来):
//   - LED(92) / Matter(137,153) は応答 push を待つ (sendIotCmdAwait)。
//   - RELAY(208) / WIFI_CLEAR(210) は biz3 web に応答コールバックが無く未確認のため
//     fire-and-forget。送信成功 = 受理ではない点に注意。
//   - firmware-update は長時間にわたり複数回 progress push が来る。versionTag があれば完了。

import { t } from "../i18n.js";

/**
 * iot サブコマンドの commander options (--device/--secret/--hub3 ほか)。
 * commander は値を string | undefined で渡す (boolean フラグは --get のみ)。
 * @typedef {{
 *   device?: string,
 *   secret?: string,
 *   hub3?: string,
 *   get?: boolean,
 *   wait?: string,
 *   sesame?: string,
 *   ssmSec?: string,
 *   nick?: string,
 *   model?: string,
 * }} IotOptions
 */

/**
 * resolveTarget / pickFromList / configCandidates が扱うデバイス候補。
 * server の listDevices と config 由来の両方をこの形に正規化する。
 * @typedef {{
 *   deviceUUID?: string,
 *   secretKey?: string|null,
 *   deviceModel?: string|null,
 *   deviceName?: string|null,
 * }} IotCandidate
 */

/**
 * resolveTarget / pickFromList の解決結果。
 * @typedef {{ deviceId: string|undefined, secretKey: string|undefined, hub3Id: string|undefined }} IotTarget
 */

/**
 * @param {import("commander").Command} program
 * @param {import("../cli.js").CliCtx} ctx cli.js makeCtx() が供給する共有コンテキスト
 */
export function registerIotCommands(program, ctx) {
  const iot = program
    .command("iot")
    .description(t("iot.cmd.desc"));

  // --- 全 iot サブコマンド共通: 対象デバイスの指定オプション ---
  // 各サブコマンドに付与する (commander は親に付けても子へ継承しないため個別に付ける)。
  /** @param {import("commander").Command} cmd */
  const withDeviceOpts = (cmd) =>
    cmd
      .option("--device <uuid>", t("iot.opt.device"))
      .option("--secret <hex>", t("iot.opt.secret"))
      .option("--hub3 <uuid>", t("iot.opt.hub3"));

  // ---- iot led <duty> ----
  // LED 調光 (cmdCode=92)。op=0x01 set / 0x02 get。get でも duty ダミーが要る (本体仕様)。
  withDeviceOpts(
    iot.command("led [duty]").description(t("iot.led.desc")),
  )
    .option("--get", t("iot.led.opt.get"))
    .action((duty, options) =>
      ctx.withHub(async (hub, { opts }) => {
        const { deviceId, secretKey, hub3Id } = await resolveTarget(ctx, hub, options, {
          needSecret: true,
        });
        const isGet = !!options.get;
        // get/set どちらも duty バイトが必要 (本体: get 時もダミー必須)。
        const dutyNum = duty === undefined ? 0 : Number(duty);
        if (!isGet && duty === undefined) {
          ctx.die(t("iot.led.needDuty"), 2);
          return;
        }
        if (!Number.isInteger(dutyNum) || dutyNum < 0 || dutyNum > 255) {
          ctx.die(t("iot.led.dutyRange"), 2);
          return;
        }
        // hub.iot.* は _bindNs で unknown を返す。本体 setHub3LedDuty の戻り形状にナロー化。
        const res = /** @type {{ ledDuty: number|undefined, message: unknown }} */ (
          await hub.iot.setHub3LedDuty({
            deviceId,
            secretKey,
            hub3Id,
            op: isGet ? 0x02 : 0x01,
            duty: dutyNum,
          })
        );
        ctx.out(opts.json, () => {
          if (isGet) console.log(t("iot.led.get", { ledDuty: res.ledDuty ?? "(no data)" }));
          else console.log(t("iot.led.set", { duty: dutyNum, ledDuty: res.ledDuty ?? "?" }));
        }, { ok: true, op: isGet ? "get" : "set", duty: isGet ? undefined : dutyNum, ledDuty: res.ledDuty });
      }),
    );

  // ---- iot relay <on|off> ----
  // LTE リレー開閉 (cmdCode=208)。応答 push 未確認のため fire-and-forget (送信のみ)。
  withDeviceOpts(
    iot.command("relay <state>")
      .description(t("iot.relay.desc"))
      .addHelpText("after", t("iot.relay.help")),
  ).action((state, options) =>
    ctx.withHub(async (hub, { opts }) => {
      const s = String(state).toLowerCase();
      if (s !== "on" && s !== "off") {
        ctx.die(t("iot.relay.badState"), 2);
        return;
      }
      const { deviceId, secretKey, hub3Id } = await resolveTarget(ctx, hub, options, {
        needSecret: true,
      });
      // 本体 hub3RelaySwitch の op は既定 0x01 (開閉操作)。on/off の値割当は本体仕様上
      // 未確認 (biz3: VIotSwitch は単純トグル) のため on=0x01 / off=0x00 を当てる。
      hub.iot.hub3RelaySwitch({ deviceId, secretKey, hub3Id, op: s === "on" ? 0x01 : 0x00 });
      ctx.out(opts.json, () => {
        console.log(t("iot.relay.sent", { state: s }));
      }, { ok: true, sent: true, state: s, note: "fire-and-forget (応答未確認)" });
    }),
  );

  // ---- iot firmware-update ----
  // DFU トリガ (cmdCode=0x03)。progress push を複数回受ける。versionTag で完了。
  withDeviceOpts(
    iot.command("firmware-update").description(t("iot.firmware.desc")),
  )
    .option("--wait <sec>", t("iot.firmware.opt.wait"), "120")
    .action((options) =>
      ctx.withHub(async (hub, { opts }) => {
        const { deviceId, secretKey, hub3Id } = await resolveTarget(ctx, hub, options, {
          needSecret: true,
        });
        const waitSec = Number(options.wait) || 120;
        /** @type {Array<{progress?:number, versionTag?:string, UUID?:string}>} */
        const events = [];
        // 進捗は長時間・複数回。--json 時は溜めて最後にまとめて出す。
        // hub.iot.startFirmwareUpdate は _bindNs 経由で unknown を返すが実体は unsub 関数。
        const unsub = /** @type {() => void} */ (hub.iot.startFirmwareUpdate({
          deviceId,
          hub3Id,
          secretKey,
          /** @param {{progress?:number, versionTag?:string, UUID?:string}} data */
          onProgress: (data) => {
            events.push(data);
            if (!opts.json) {
              const p = data?.progress;
              const v = data?.versionTag;
              const versionSuffix = v ? t("iot.firmware.versionSuffix", { versionTag: v }) : "";
              console.log(t("iot.firmware.progress", { progress: p ?? "?", versionSuffix }));
            }
          },
        }));
        if (!opts.json) console.log(t("iot.firmware.subscribing", { waitSec }));
        // versionTag を観測したら早期終了、なければ waitSec まで待つ。
        await waitForCompletion(events, waitSec * 1000);
        unsub();
        const done = events.some((e) => e?.versionTag);
        ctx.out(opts.json, () => {
          console.log(done ? t("iot.firmware.done") : t("iot.firmware.timeout"));
        }, { ok: true, completed: done, events });
      }),
    );

  // ---- iot wifi-clear ----
  // 保存 WiFi 設定クリア (cmdCode=210)。応答未確認の fire-and-forget。
  withDeviceOpts(
    iot.command("wifi-clear").description(t("iot.wifiClear.desc")),
  ).action((options) =>
    ctx.withHub(async (hub, { opts }) => {
      const { deviceId, secretKey, hub3Id } = await resolveTarget(ctx, hub, options, {
        needSecret: true,
      });
      hub.iot.clearHub3WifiSsid({ deviceId, secretKey, hub3Id });
      ctx.out(opts.json, () => {
        console.log(t("iot.wifiClear.sent"));
      }, { ok: true, sent: true, note: "fire-and-forget (応答未確認)" });
    }),
  );

  // ---- iot matter-code ----
  // Matter ペアリングコード取得 (cmdCode=137)。応答待ち。
  withDeviceOpts(
    iot.command("matter-code").description(t("iot.matterCode.desc")),
  ).action((options) =>
    ctx.withHub(async (hub, { opts }) => {
      const { deviceId, secretKey, hub3Id } = await resolveTarget(ctx, hub, options, {
        needSecret: true,
      });
      const res = /** @type {{ qrCode: string|undefined, manualCode: string|undefined, message: unknown }} */ (
        await hub.iot.getMatterPairingCode({ deviceId, secretKey, hub3Id })
      );
      ctx.out(opts.json, () => {
        console.log(t("iot.matterCode.qr", { qrCode: res.qrCode ?? "(none)" }));
        console.log(t("iot.matterCode.manual", { manualCode: res.manualCode ?? "(none)" }));
      }, { ok: true, qrCode: res.qrCode, manualCode: res.manualCode });
    }),
  );

  // ---- iot matter-open ----
  // Matter ペアリング窓を開く (cmdCode=153)。statusCode===0 で成功。
  withDeviceOpts(
    iot.command("matter-open").description(t("iot.matterOpen.desc")),
  ).action((options) =>
    ctx.withHub(async (hub, { opts }) => {
      const { deviceId, secretKey, hub3Id } = await resolveTarget(ctx, hub, options, {
        needSecret: true,
      });
      const res = /** @type {{ statusCode: number|undefined, message: unknown }} */ (
        await hub.iot.openMatterPairingWindow({ deviceId, secretKey, hub3Id })
      );
      // statusCode が無い応答 (フィールド名違い/省略の可能性。応答構造は実機未確認) は
      // 失敗と断定せず "不明" として区別する。
      const hasStatus = res.statusCode != null;
      const okStatus = res.statusCode === 0;
      ctx.out(opts.json, () => {
        if (!hasStatus) {
          console.log(t("iot.matterOpen.unknownStatus"));
        } else {
          console.log(okStatus ? t("iot.matterOpen.ok") : t("iot.matterOpen.failed", { statusCode: res.statusCode ?? "?" }));
        }
      }, { ok: hasStatus ? okStatus : null, statusCode: res.statusCode ?? null });
    }),
  );

  // ---- iot add-sesame ----
  // Hub3 にぶら下がり Sesame を追加 (cmdCode=101)。--hub3/--secret は親 Hub3、
  // --sesame/--ssm-sec/--model は追加する Sesame。
  iot
    .command("add-sesame")
    .description(t("iot.addSesame.desc"))
    .option("--hub3 <uuid>", t("iot.addSesame.opt.hub3"))
    .option("--secret <hex>", t("iot.addSesame.opt.secret"))
    .option("--sesame <uuid>", t("iot.addSesame.opt.sesame"))
    .option("--ssm-sec <hex>", t("iot.addSesame.opt.ssmSec"))
    .option("--nick <name>", t("iot.addSesame.opt.nick"))
    .option("--model <model>", t("iot.addSesame.opt.model"))
    .action((options) => runSesameItem(ctx, options, "add"));

  // ---- iot rm-sesame ----
  // Hub3 からぶら下がり Sesame を削除 (cmdCode=103)。payload は add と同形。
  iot
    .command("rm-sesame")
    .description(t("iot.rmSesame.desc"))
    .option("--hub3 <uuid>", t("iot.rmSesame.opt.hub3"))
    .option("--secret <hex>", t("iot.rmSesame.opt.secret"))
    .option("--sesame <uuid>", t("iot.rmSesame.opt.sesame"))
    .option("--ssm-sec <hex>", t("iot.rmSesame.opt.ssmSec"))
    .option("--nick <name>", t("iot.rmSesame.opt.nick"))
    .option("--model <model>", t("iot.rmSesame.opt.model"))
    .action((options) => runSesameItem(ctx, options, "remove"));
}

// ---------- ヘルパ ----------

/**
 * 対象デバイスの deviceId / secretKey / hub3Id を解決する。
 *
 * 優先順位:
 *   1. --device / --secret / --hub3 が指定されていればそれ。
 *   2. config (hub3s + locks。secretKey を持つのは locks のみ) と hub.listDevices()
 *      (secretKey 付き) を突き合わせ、対話可能なら選択、1 件なら自動採用。
 *   3. 不足かつ非対話なら die(...,2) で必須を案内。
 *
 * @param {import("../cli.js").CliCtx} ctx
 * @param {import("../client.js").SesameHub3} hub
 * @param {IotOptions} options
 * @param {{ needSecret: boolean }} flags
 * @returns {Promise<IotTarget>}
 */
async function resolveTarget(ctx, hub, options, { needSecret }) {
  let deviceId = options.device;
  let secretKey = options.secret;
  const hub3Id = options.hub3; // topic 用。未指定なら本体側が deviceId を流用。

  if (deviceId && (secretKey || !needSecret)) {
    return { deviceId, secretKey, hub3Id };
  }

  // 候補を集める: server の listDevices (secretKey 付き) を最優先。失敗時は config を使う。
  /** @type {import("../client.js").DeviceInfo[]} */
  let devices = [];
  try {
    devices = await hub.listDevices();
  } catch {
    devices = [];
  }

  // deviceId 指定済みで secretKey だけ足りない → 一覧から該当 UUID の secretKey を補完。
  if (deviceId && needSecret && !secretKey) {
    const hit = devices.find((d) => normUuid(d.deviceUUID) === normUuid(deviceId));
    if (hit?.secretKey) secretKey = hit.secretKey;
    if (!secretKey) {
      ctx.die(t("iot.resolve.secretUnresolvedDevice", { device: deviceId }), 2);
    }
    return { deviceId, secretKey, hub3Id };
  }

  // deviceId 未指定 → 一覧から選択 / 自動採用。
  if (!deviceId) {
    const candidates = devices.filter((d) => d.deviceUUID);
    if (candidates.length === 0) {
      // config fallback (secretKey を持つ locks のみ secretKey 補完可能)。
      const cfg = ctx.loadCtx().configStore.load();
      const fromCfg = configCandidates(cfg);
      if (fromCfg.length === 0) {
        ctx.die(t("iot.resolve.noDevice"), 2);
        return { deviceId, secretKey, hub3Id };
      }
      return pickFromList(ctx, fromCfg, needSecret, hub3Id);
    }

    if (candidates.length === 1) {
      deviceId = candidates[0].deviceUUID;
      secretKey = secretKey || candidates[0].secretKey || undefined;
    } else if (ctx.canPrompt()) {
      const picked = await ctx.prompts.selectFromList(
        t("iot.resolve.pickDevice"),
        candidates,
        (d) => `${d.deviceName || "(no name)"}\t${d.deviceModel || "?"}\t${d.deviceUUID}`,
      );
      deviceId = picked?.deviceUUID;
      secretKey = secretKey || picked?.secretKey || undefined;
    } else {
      const summary = candidates
        .map((d) => `  ${d.deviceUUID}\t${d.deviceModel || "?"}\t${d.deviceName || ""}`)
        .join("\n");
      ctx.die(t("iot.resolve.multiDevice", { summary }), 2);
      return { deviceId, secretKey, hub3Id };
    }
  }

  if (needSecret && !secretKey) {
    ctx.die(t("iot.resolve.secretUnresolved", { device: deviceId || "?" }), 2);
  }
  return { deviceId, secretKey, hub3Id };
}

/**
 * config の locks (secretKey 付き) と hub3s から候補配列を作る。
 * @param {import("../config.js").LoadedConfig} cfg
 * @returns {IotCandidate[]}
 */
function configCandidates(cfg) {
  /** @type {IotCandidate[]} */
  const out = [];
  for (const [name, l] of Object.entries(cfg.locks || {})) {
    out.push({ deviceUUID: l.deviceUUID, secretKey: l.secretKey, deviceModel: l.model, deviceName: l.alias || name });
  }
  for (const [name, h] of Object.entries(cfg.hub3s || {})) {
    // hub3s は secretKey を持たない (config 仕様)。secretKey 必須 op では別途 --secret が要る。
    out.push({ deviceUUID: h.deviceId, secretKey: undefined, deviceModel: "hub_3", deviceName: h.name || name });
  }
  return out;
}

/**
 * 候補配列から対話/自動選択し target を返す共通処理。
 * @param {import("../cli.js").CliCtx} ctx
 * @param {IotCandidate[]} candidates
 * @param {boolean} needSecret
 * @param {string|undefined} hub3Id
 * @returns {Promise<IotTarget>}
 */
async function pickFromList(ctx, candidates, needSecret, hub3Id) {
  /** @type {IotCandidate|undefined} */
  let chosen;
  if (candidates.length === 1) {
    chosen = candidates[0];
  } else if (ctx.canPrompt()) {
    chosen = await ctx.prompts.selectFromList(
      t("iot.resolve.pickDeviceConfig"),
      candidates,
      (d) => `${d.deviceName || "(no name)"}\t${d.deviceModel || "?"}\t${d.deviceUUID}`,
    );
  } else {
    const summary = candidates
      .map((d) => `  ${d.deviceUUID}\t${d.deviceModel || "?"}\t${d.deviceName || ""}`)
      .join("\n");
    ctx.die(t("iot.resolve.multiCandidate", { summary }), 2);
    return { deviceId: undefined, secretKey: undefined, hub3Id };
  }
  if (needSecret && !chosen?.secretKey) {
    ctx.die(t("iot.resolve.secretUnresolvedChosen", { device: chosen?.deviceUUID ?? "?" }), 2);
  }
  return { deviceId: chosen?.deviceUUID, secretKey: chosen?.secretKey ?? undefined, hub3Id };
}

/**
 * add-sesame / rm-sesame の共通処理。
 * @param {import("../cli.js").CliCtx} ctx
 * @param {IotOptions} options
 * @param {"add"|"remove"} mode
 */
function runSesameItem(ctx, options, mode) {
  return ctx.withHub(async (hub, { opts }) => {
    const hub3Id = options.hub3;
    const secretKey = options.secret;
    const sesameId = options.sesame;
    const ssmSecKa = options.ssmSec;
    const deviceModel = options.model;
    const nickName = options.nick;

    // いずれも署名鍵 (親 Hub3) や Sesame の鍵を含むため、対話補完はせず明示必須とする
    // (鍵を取り違えると別デバイスへ書き込む危険があるため安全側に倒す)。
    /** @type {string[]} */
    const missing = [];
    if (!hub3Id) missing.push(t("iot.sesame.missing.hub3"));
    if (!secretKey) missing.push(t("iot.sesame.missing.secret"));
    if (!sesameId) missing.push(t("iot.sesame.missing.sesame"));
    if (!ssmSecKa) missing.push(t("iot.sesame.missing.ssmSec"));
    if (!deviceModel) missing.push(t("iot.sesame.missing.model"));
    if (missing.length > 0) {
      ctx.die(t("iot.sesame.missing", { missing: missing.join(" ") }), 2);
      return;
    }

    const params = { hub3Id, secretKey, sesameId, ssmSecKa, nickName, deviceModel };
    // hub.iot.* は _bindNs で unknown を返す。add/removeSesameToHub3 の戻り形状にナロー化。
    const res = /** @type {{ ssks: unknown, message: unknown }} */ (
      mode === "add"
        ? await hub.iot.addSesameToHub3(params)
        : await hub.iot.removeSesameFromHub3(params)
    );
    ctx.out(opts.json, () => {
      console.log(t("iot.sesame.ok", { action: mode === "add" ? "added" : "removed", sesameId: sesameId ?? "", hub3Id: hub3Id ?? "" }));
      if (res.ssks !== undefined) console.log(t("iot.sesame.ssks", { ssks: JSON.stringify(res.ssks) }));
    }, { ok: true, mode, sesameId, hub3Id, ssks: res.ssks });
  });
}

/**
 * firmware progress の versionTag (完了) を待つ。完了 push を見たら即解決、
 * なければ maxMs まで待つ。events は onProgress が随時 push する共有配列。
 * @param {Array<{versionTag?:string}>} events
 * @param {number} maxMs
 * @returns {Promise<void>}
 */
function waitForCompletion(events, maxMs) {
  return new Promise((/** @type {() => void} */ resolve) => {
    const start = Date.now();
    const tick = setInterval(() => {
      if (events.some((e) => e?.versionTag) || Date.now() - start >= maxMs) {
        clearInterval(tick);
        resolve();
      }
    }, 250);
  });
}

/** @param {unknown} s */
function normUuid(s) {
  return typeof s === "string" ? s.replace(/-/g, "").toLowerCase() : "";
}

// `sesame preset-ir …` コマンド群。
//
// 本体ロジックは src/presetir.js (HXDCommandProcessor 移植 + emitAir/emitButton/sendIR)。
// ここは commander への配線と入出力整形のみを担う。
//
// プリセット IR は biz3 の 2 層構造を再現する:
//   1. HXDCommandProcessor がローカルで 16 byte の HEX command を生成 (純ビルダ)。
//   2. その HEX を既存 sendIR (op:'sendIR', operation:'remoteEmit') で Hub3 に発射。
//      presetIR 固有の新 WS op は無い (sendIR は learnIR 等と完全共通)。
//
// ⚠️ irType (= remote.type) は実値をそのまま渡す:
//   0xC000=エアコン, 0x8000=扇風機, 0xE000=ライト, 0x2000=TV (本体 IR_TYPE 参照)。
//   air は irType を本体側で IR_TYPE.AIR に固定するため CLI からは渡さない。
//   button/send は --irtype で実値を渡す。
//
// ⚠️ getAirKey の keyMap トラップ (本体 JSDoc 参照): air の状態 (温度/モード/風速/風向/電源)
//   は buildAirCommand が buf[4..10] に直接書き込むため key 値は発射動作にほぼ影響しない。
//   本 CLI は keyType を渡さず本体既定 (0x01) に委ねる。
//
// hub.presetir.* で呼べるのは NAMESPACE_OPS = [sendIR, emitAir, emitButton] のみ。
// 純ビルダ (buildAirCommandHex 等) は namespace に無い (本 CLI では未使用)。
//
// ctx 契約 (cli.js makeCtx が供給):
//   ctx.withHub(fn)  : connect → fn(hub, {opts}) → close。hub.presetir.* は
//                      companyID/subUUID を自動注入する namespace (companyID 注入済みなので
//                      companyID 必須の emitAir/emitButton/sendIR もそのまま呼べる)。
//   ctx.out(json, humanFn, jsonObj) : --json 時は jsonObj、それ以外は humanFn()。
//   ctx.die(msg, code) / ctx.canPrompt() / ctx.prompts (selectFromList 等)。

import { isHub3Model } from "@sesame-kit/core/config";
import { t } from "@sesame-kit/core/i18n";

/**
 * commander の option coerce 用 parseInt ラッパ。
 * 未指定 (undefined/null) は undefined を返す。値はあるが数値でない場合 ('--code abc' 等) は
 * throw して「未指定」と区別する (放置すると undefined になり『必要です』と誤誘導されるため)。
 * throw された Error は run() の parseAsync catch が die(1) で表示する。
 */
/**
 * @param {string|undefined|null} v
 * @returns {number|undefined}
 */
function toInt(v) {
  if (v == null) return undefined;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) {
    throw new Error(t("presetir.err.notANumber", { value: JSON.stringify(v) }));
  }
  return n;
}

/**
 * --device 未指定時の Hub3 UUID 解決。
 * 対話可能なら listDevices() の Hub3 (deviceModel が hub_3/hub_3_lte) から選択、
 * 不可なら die(...,2) で必須を案内する (schedule.js と同じ作法)。
 * @param {import("@sesame-kit/core/client").SesameHub3} hub
 * @param {import("../cli.js").CliCtx} ctx
 * @param {string|undefined} device
 * @returns {Promise<string|undefined>} Hub3 deviceUUID
 */
async function resolveDeviceId(hub, ctx, device) {
  if (device) return device;
  if (!ctx.canPrompt()) {
    ctx.die(t("presetir.err.deviceRequiredNonInteractive"), 2);
    return undefined;
  }
  const list = await hub.listDevices();
  const hub3s = (Array.isArray(list) ? list : []).filter(
    /** @param {import("@sesame-kit/core/client").DeviceInfo} d */ (d) => isHub3Model(d.deviceModel),
  );
  if (hub3s.length === 0) {
    ctx.die(t("presetir.err.noHub3Found"), 1);
    return undefined;
  }
  const picked = await ctx.prompts.selectFromList(
    t("presetir.prompt.selectHub3"),
    hub3s,
    (d) => `${d.deviceName || "(no-name)"}  ${d.deviceUUID}`,
  );
  return picked?.deviceUUID;
}

/**
 * `--remote <name>` の config 解決 (P3-8)。
 * config の remotes[name] から deviceId (親 Hub3) / code / irDeviceUUID / irType / state を引く。
 * sync (P3-8 で code/state を保存するようになった syncRemotesFromDevices) 済みのプリセット
 * リモコンなら --code 等を手で渡さずに発射できる。明示オプションが常に優先。
 *
 * @param {import("@sesame-kit/core/client").SesameHub3} hub
 * @param {import("../cli.js").CliCtx} ctx
 * @param {string|undefined} remoteName
 * @returns {{ deviceId?: string, code?: number, irDeviceUUID?: string, irType?: number, state?: string|null }|undefined}
 */
function resolveFromConfigRemote(hub, ctx, remoteName) {
  if (!remoteName) return {};
  const { remote, hub3 } = hub.resolveRemote(remoteName);
  const r = /** @type {{ irDeviceUUID?: string, irType?: number, code?: number|null, state?: string|null }} */ (remote);
  if (r.code == null) {
    // code 未保存 = 学習リモコン or 旧 config (sync 前)。preset-ir では code 必須。
    ctx.die(t("presetir.err.remoteNoCode", { name: remoteName }), 2);
    return undefined;
  }
  return {
    deviceId: /** @type {string|undefined} */ (hub3.deviceId),
    code: Number(r.code),
    irDeviceUUID: r.irDeviceUUID,
    irType: r.irType,
    state: r.state ?? null,
  };
}

/**
 * @param {import("commander").Command} program
 * @param {import("../cli.js").CliCtx} ctx cli.js makeCtx() が供給する共有コンテキスト
 */
export function registerPresetIrCommands(program, ctx) {
  const presetir = program
    .command("preset-ir")
    .description(t("presetir.cmd.parent.desc"));

  // sesame preset-ir air [--remote <name>] --device <hub3uuid> --code <n> [--power --temp <c> --mode <n> --fan <n> --wind <n> --swing]
  presetir
    .command("air")
    .description(t("presetir.cmd.air.desc"))
    .option("--remote <name>", t("presetir.opt.remote"))
    .option("--device <hub3uuid>", t("presetir.opt.device"))
    .option("--code <n>", t("presetir.opt.code"), toInt)
    .option("--power", t("presetir.opt.power"))
    .option("--temp <c>", t("presetir.opt.temp"), toInt)
    .option("--mode <n>", t("presetir.opt.mode"), toInt)
    .option("--fan <n>", t("presetir.opt.fan"), toInt)
    .option("--wind <n>", t("presetir.opt.wind"), toInt)
    .option("--swing", t("presetir.opt.swing"))
    .action((opts) =>
      ctx.withHub(async (hub, { opts: gopts }) => {
        // P3-8: --remote 指定時は config から deviceId/code/irDeviceUUID/state を解決 (明示優先)。
        const fromConfig = resolveFromConfigRemote(hub, ctx, opts.remote);
        if (!fromConfig) return;
        const deviceId = opts.device || fromConfig.deviceId || await resolveDeviceId(hub, ctx, undefined);
        if (!deviceId) return;
        const code = opts.code ?? fromConfig.code;
        if (code == null) {
          ctx.die(t("presetir.err.codeRequired"), 2);
          return;
        }
        // 指定されたものだけ params に載せ、エアコン状態の既定は本体に委ねる。
        // savedState (config remote.state) があれば emitAir が復元して既定値に使う (P3-2)。
        /**
         * @type {{ deviceId: string, code: number, power?: boolean,
         *   temperature?: number, mode?: number, fanSpeed?: number,
         *   windDirection?: number, autoSwing?: boolean,
         *   irDeviceUUID?: string, savedState?: string|null }}
         */
        const params = { deviceId, code };
        if (fromConfig.irDeviceUUID) params.irDeviceUUID = fromConfig.irDeviceUUID;
        if (fromConfig.state) params.savedState = fromConfig.state;
        if (opts.power) params.power = true;
        if (opts.temp != null) params.temperature = opts.temp;
        if (opts.mode != null) params.mode = opts.mode;
        if (opts.fan != null) params.fanSpeed = opts.fan;
        if (opts.wind != null) params.windDirection = opts.wind;
        if (opts.swing) params.autoSwing = true;

        // hub.presetir.* は _bindNs で unknown を返す。emitAir の実戻り値形状にナロー化。
        const { command, response } =
          /** @type {{ command: string, response: object }} */ (
            await hub.presetir.emitAir(params)
          );
        ctx.out(gopts.json, () => {
          console.log(t("presetir.out.airEmitted", { deviceId }));
          console.log(t("presetir.out.command", { command }));
        }, { ok: true, deviceId, command, response });
      }),
    );

  // sesame preset-ir button [--remote <name>] --device <hub3uuid> --code <n> --button <type> --irtype <n>
  presetir
    .command("button")
    .description(t("presetir.cmd.button.desc"))
    .option("--remote <name>", t("presetir.opt.remote"))
    .option("--device <hub3uuid>", t("presetir.opt.device"))
    .option("--code <n>", t("presetir.opt.code"), toInt)
    .option("--button <type>", t("presetir.opt.button"))
    .option("--irtype <n>", t("presetir.opt.irtypeButton"), toInt)
    .action((opts) =>
      ctx.withHub(async (hub, { opts: gopts }) => {
        // P3-8: --remote 指定時は config から deviceId/code/irType/irDeviceUUID を解決 (明示優先)。
        const fromConfig = resolveFromConfigRemote(hub, ctx, opts.remote);
        if (!fromConfig) return;
        const deviceId = opts.device || fromConfig.deviceId || await resolveDeviceId(hub, ctx, undefined);
        if (!deviceId) return;
        const code = opts.code ?? fromConfig.code;
        if (code == null) {
          ctx.die(t("presetir.err.codeRequired"), 2);
          return;
        }
        const irType = opts.irtype ?? fromConfig.irType;
        if (irType == null) {
          ctx.die(t("presetir.err.irtypeRequired"), 2);
          return;
        }
        if (!opts.button) {
          ctx.die(t("presetir.err.buttonRequired"), 2);
          return;
        }
        const { command, response } =
          /** @type {{ command: string, response: object }} */ (
            await hub.presetir.emitButton({
              deviceId,
              code,
              irType,
              buttonType: opts.button,
              ...(fromConfig.irDeviceUUID ? { irDeviceUUID: fromConfig.irDeviceUUID } : {}),
            })
          );
        ctx.out(gopts.json, () => {
          console.log(t("presetir.out.buttonEmitted", { deviceId }));
          console.log(t("presetir.out.command", { command }));
        }, { ok: true, deviceId, command, response });
      }),
    );

  // sesame preset-ir send [--remote <name>] --device <hub3uuid> --command <hex> --irtype <n>
  presetir
    .command("send")
    .description(t("presetir.cmd.send.desc"))
    .option("--remote <name>", t("presetir.opt.remote"))
    .option("--device <hub3uuid>", t("presetir.opt.device"))
    .option("--command <hex>", t("presetir.opt.command"))
    .option("--irtype <n>", t("presetir.opt.irtypeSend"), toInt)
    .action((opts) =>
      ctx.withHub(async (hub, { opts: gopts }) => {
        // P3-8: send は command を手で渡す前提なので code は不要 (deviceId/irType のみ解決)。
        // resolveFromConfigRemote は code 必須なので使わず、resolveRemote を直接引く。
        /** @type {{ deviceId?: string, irType?: number, irDeviceUUID?: string }} */
        let fromConfig = {};
        if (opts.remote) {
          const { remote, hub3 } = hub.resolveRemote(opts.remote);
          fromConfig = {
            deviceId: /** @type {string|undefined} */ (hub3.deviceId),
            irType: remote.irType,
            irDeviceUUID: remote.irDeviceUUID,
          };
        }
        const deviceId = opts.device || fromConfig.deviceId || await resolveDeviceId(hub, ctx, undefined);
        if (!deviceId) return;
        if (!opts.command) {
          ctx.die(t("presetir.err.commandOptRequired"), 2);
          return;
        }
        const irType = opts.irtype ?? fromConfig.irType;
        if (irType == null) {
          ctx.die(t("presetir.err.irtypeRequired"), 2);
          return;
        }
        const response = await hub.presetir.sendIR({
          deviceId,
          command: opts.command,
          irType,
          ...(fromConfig.irDeviceUUID ? { irDeviceUUID: fromConfig.irDeviceUUID } : {}),
        });
        ctx.out(gopts.json, () => {
          console.log(t("presetir.out.sent", { deviceId }));
        }, { ok: true, deviceId, command: opts.command, irType, response });
      }),
    );
}

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

import { isHub3Model } from "../config.js";
import { t } from "../i18n.js";

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
 * @param {import("../client.js").SesameHub3} hub
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
    /** @param {import("../client.js").DeviceInfo} d */ (d) => isHub3Model(d.deviceModel),
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
 * @param {import("commander").Command} program
 * @param {import("../cli.js").CliCtx} ctx cli.js makeCtx() が供給する共有コンテキスト
 */
export function registerPresetIrCommands(program, ctx) {
  const presetir = program
    .command("preset-ir")
    .description(t("presetir.cmd.parent.desc"));

  // sesame preset-ir air --device <hub3uuid> --code <n> [--power --temp <c> --mode <n> --fan <n> --wind <n> --swing]
  presetir
    .command("air")
    .description(t("presetir.cmd.air.desc"))
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
        const deviceId = await resolveDeviceId(hub, ctx, opts.device);
        if (!deviceId) return;
        if (opts.code == null) {
          ctx.die(t("presetir.err.codeRequired"), 2);
          return;
        }
        // 指定されたものだけ params に載せ、エアコン状態の既定は本体に委ねる。
        /**
         * @type {{ deviceId: string, code: number, power?: boolean,
         *   temperature?: number, mode?: number, fanSpeed?: number,
         *   windDirection?: number, autoSwing?: boolean }}
         */
        const params = { deviceId, code: opts.code };
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

  // sesame preset-ir button --device <hub3uuid> --code <n> --button <type> --irtype <n>
  presetir
    .command("button")
    .description(t("presetir.cmd.button.desc"))
    .option("--device <hub3uuid>", t("presetir.opt.device"))
    .option("--code <n>", t("presetir.opt.code"), toInt)
    .option("--button <type>", t("presetir.opt.button"))
    .option("--irtype <n>", t("presetir.opt.irtypeButton"), toInt)
    .action((opts) =>
      ctx.withHub(async (hub, { opts: gopts }) => {
        const deviceId = await resolveDeviceId(hub, ctx, opts.device);
        if (!deviceId) return;
        if (opts.code == null) {
          ctx.die(t("presetir.err.codeRequired"), 2);
          return;
        }
        if (opts.irtype == null) {
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
              code: opts.code,
              irType: opts.irtype,
              buttonType: opts.button,
            })
          );
        ctx.out(gopts.json, () => {
          console.log(t("presetir.out.buttonEmitted", { deviceId }));
          console.log(t("presetir.out.command", { command }));
        }, { ok: true, deviceId, command, response });
      }),
    );

  // sesame preset-ir send --device <hub3uuid> --command <hex> --irtype <n>
  presetir
    .command("send")
    .description(t("presetir.cmd.send.desc"))
    .option("--device <hub3uuid>", t("presetir.opt.device"))
    .option("--command <hex>", t("presetir.opt.command"))
    .option("--irtype <n>", t("presetir.opt.irtypeSend"), toInt)
    .action((opts) =>
      ctx.withHub(async (hub, { opts: gopts }) => {
        const deviceId = await resolveDeviceId(hub, ctx, opts.device);
        if (!deviceId) return;
        if (!opts.command) {
          ctx.die(t("presetir.err.commandOptRequired"), 2);
          return;
        }
        if (opts.irtype == null) {
          ctx.die(t("presetir.err.irtypeRequired"), 2);
          return;
        }
        const response = await hub.presetir.sendIR({
          deviceId,
          command: opts.command,
          irType: opts.irtype,
        });
        ctx.out(gopts.json, () => {
          console.log(t("presetir.out.sent", { deviceId }));
        }, { ok: true, deviceId, command: opts.command, irType: opts.irtype, response });
      }),
    );
}

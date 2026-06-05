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

/**
 * commander の option coerce 用 parseInt ラッパ。
 * 未指定 (undefined/null) は undefined を返す。値はあるが数値でない場合 ('--code abc' 等) は
 * throw して「未指定」と区別する (放置すると undefined になり『必要です』と誤誘導されるため)。
 * throw された Error は run() の parseAsync catch が die(1) で表示する。
 */
function toInt(v) {
  if (v == null) return undefined;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) {
    throw new Error(`数値を指定してください (受け取った値: ${JSON.stringify(v)})`);
  }
  return n;
}

/**
 * --device 未指定時の Hub3 UUID 解決。
 * 対話可能なら listDevices() の Hub3 (deviceModel が hub_3/hub_3_lte) から選択、
 * 不可なら die(...,2) で必須を案内する (schedule.js と同じ作法)。
 * @param {object} hub
 * @param {object} ctx
 * @param {string|undefined} device
 * @returns {Promise<string|undefined>} Hub3 deviceUUID
 */
async function resolveDeviceId(hub, ctx, device) {
  if (device) return device;
  if (!ctx.canPrompt()) {
    ctx.die("--device <hub3uuid> が必要です (非対話モード)", 2);
    return undefined;
  }
  const list = await hub.listDevices();
  const hub3s = (Array.isArray(list) ? list : []).filter((d) => isHub3Model(d.deviceModel));
  if (hub3s.length === 0) {
    ctx.die("利用可能な Hub3 が見つかりません。", 1);
    return undefined;
  }
  const picked = await ctx.prompts.selectFromList(
    "発射する Hub3 を選択",
    hub3s,
    (d) => `${d.deviceName || "(no-name)"}  ${d.deviceUUID}`,
  );
  return picked?.deviceUUID;
}

/**
 * @param {import("commander").Command} program
 * @param {object} ctx cli.js makeCtx() が供給する共有コンテキスト
 */
export function registerPresetIrCommands(program, ctx) {
  const presetir = program
    .command("preset-ir")
    .description("プリセット IR リモコン発射 (HXD command 生成 + remoteEmit)");

  // sesame preset-ir air --device <hub3uuid> --code <n> [--power --temp <c> --mode <n> --fan <n> --wind <n> --swing]
  presetir
    .command("air")
    .description("エアコン状態を発射 (emitAir)。指定したものだけ渡し、残りは本体既定に委ねる")
    .option("--device <hub3uuid>", "Hub3 deviceUUID (省略時は対話選択 / 非対話は必須)")
    .option("--code <n>", "プリセット remote.code (数値)", toInt)
    .option("--power", "電源 ON (省略時 OFF)")
    .option("--temp <c>", "温度 (UI 値, 例 25)", toInt)
    .option("--mode <n>", "mode index 0-4 {0:自動,1:制冷,2:除湿,3:送風,4:制熱}", toInt)
    .option("--fan <n>", "fanSpeed index 0-3 {0:自動,1:低,2:中,3:高}", toInt)
    .option("--wind <n>", "windDirection index 0-2 {0:上,1:中,2:下}", toInt)
    .option("--swing", "自動風向 ON (省略時 OFF)")
    .action((opts) =>
      ctx.withHub(async (hub, { opts: gopts }) => {
        const deviceId = await resolveDeviceId(hub, ctx, opts.device);
        if (!deviceId) return;
        if (opts.code == null) {
          ctx.die("--code <n> が必要です (プリセット remote.code)", 2);
          return;
        }
        // 指定されたものだけ params に載せ、エアコン状態の既定は本体に委ねる。
        const params = { deviceId, code: opts.code };
        if (opts.power) params.power = true;
        if (opts.temp != null) params.temperature = opts.temp;
        if (opts.mode != null) params.mode = opts.mode;
        if (opts.fan != null) params.fanSpeed = opts.fan;
        if (opts.wind != null) params.windDirection = opts.wind;
        if (opts.swing) params.autoSwing = true;

        const { command, response } = await hub.presetir.emitAir(params);
        ctx.out(gopts.json, () => {
          console.log(`OK: emitted air command to ${deviceId}`);
          console.log(`  command: ${command}`);
        }, { ok: true, deviceId, command, response });
      }),
    );

  // sesame preset-ir button --device <hub3uuid> --code <n> --button <type> --irtype <n>
  presetir
    .command("button")
    .description("非エアコン (TV/ライト/扇風機) のボタン押下を発射 (emitButton)")
    .option("--device <hub3uuid>", "Hub3 deviceUUID (省略時は対話選択 / 非対話は必須)")
    .option("--code <n>", "プリセット remote.code (数値)", toInt)
    .option("--button <type>", "ボタン種別 (例 POWER_STATUS_ON, VOLUME_UP, FAN_SPEED)")
    .option("--irtype <n>", "remote.type 実値 (TV:8192/0x2000, FAN:32768/0x8000, LIGHT:57344/0xE000)", toInt)
    .action((opts) =>
      ctx.withHub(async (hub, { opts: gopts }) => {
        const deviceId = await resolveDeviceId(hub, ctx, opts.device);
        if (!deviceId) return;
        if (opts.code == null) {
          ctx.die("--code <n> が必要です (プリセット remote.code)", 2);
          return;
        }
        if (opts.irtype == null) {
          ctx.die("--irtype <n> が必要です (remote.type 実値)", 2);
          return;
        }
        if (!opts.button) {
          ctx.die("--button <type> が必要です (ボタン種別)", 2);
          return;
        }
        const { command, response } = await hub.presetir.emitButton({
          deviceId,
          code: opts.code,
          irType: opts.irtype,
          buttonType: opts.button,
        });
        ctx.out(gopts.json, () => {
          console.log(`OK: emitted button command to ${deviceId}`);
          console.log(`  command: ${command}`);
        }, { ok: true, deviceId, command, response });
      }),
    );

  // sesame preset-ir send --device <hub3uuid> --command <hex> --irtype <n>
  presetir
    .command("send")
    .description("生成済み HEX command をそのまま発射 (sendIR)。低レベル用途")
    .option("--device <hub3uuid>", "Hub3 deviceUUID (省略時は対話選択 / 非対話は必須)")
    .option("--command <hex>", "発射する HEX command 文字列")
    .option("--irtype <n>", "remote.type 実値 (AIR:49152/0xC000, TV:8192/0x2000 等)", toInt)
    .action((opts) =>
      ctx.withHub(async (hub, { opts: gopts }) => {
        const deviceId = await resolveDeviceId(hub, ctx, opts.device);
        if (!deviceId) return;
        if (!opts.command) {
          ctx.die("--command <hex> が必要です (HEX command 文字列)", 2);
          return;
        }
        if (opts.irtype == null) {
          ctx.die("--irtype <n> が必要です (remote.type 実値)", 2);
          return;
        }
        const response = await hub.presetir.sendIR({
          deviceId,
          command: opts.command,
          irType: opts.irtype,
        });
        ctx.out(gopts.json, () => {
          console.log(`OK: sent IR command to ${deviceId}`);
        }, { ok: true, deviceId, command: opts.command, irType: opts.irtype, response });
      }),
    );
}

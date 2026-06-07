export default {
  en: {
    // src/cli/presetir.js — commands / options / output / errors / prompts
    "presetir.cmd.parent.desc": "Emit preset IR remote commands (HXD command generation + remoteEmit)",
    "presetir.cmd.air.desc": "Emit air conditioner state (emitAir). Only the specified fields are sent; the rest fall back to the device defaults",
    "presetir.cmd.button.desc": "Emit a non-air (TV/light/fan) button press (emitButton)",
    "presetir.cmd.send.desc": "Emit a pre-built HEX command as-is (sendIR). Low-level use",

    "presetir.opt.device": "Hub3 deviceUUID (interactive selection when omitted / required in non-interactive mode)",
    "presetir.opt.code": "Preset remote.code (number)",
    "presetir.opt.power": "Power ON (OFF when omitted)",
    "presetir.opt.temp": "Temperature (UI value, e.g. 25)",
    "presetir.opt.mode": "mode index 0-4 {0:auto,1:cool,2:dry,3:fan,4:heat}",
    "presetir.opt.fan": "fanSpeed index 0-3 {0:auto,1:low,2:medium,3:high}",
    "presetir.opt.wind": "windDirection index 0-2 {0:up,1:middle,2:down}",
    "presetir.opt.swing": "Auto swing ON (OFF when omitted)",
    "presetir.opt.button": "Button type (e.g. POWER_STATUS_ON, VOLUME_UP, FAN_SPEED)",
    "presetir.opt.irtypeButton": "remote.type actual value (TV:8192/0x2000, FAN:32768/0x8000, LIGHT:57344/0xE000)",
    "presetir.opt.command": "HEX command string to emit",
    "presetir.opt.irtypeSend": "remote.type actual value (AIR:49152/0xC000, TV:8192/0x2000, etc.)",

    "presetir.out.airEmitted": "OK: emitted air command to {deviceId}",
    "presetir.out.buttonEmitted": "OK: emitted button command to {deviceId}",
    "presetir.out.sent": "OK: sent IR command to {deviceId}",
    "presetir.out.command": "  command: {command}",

    "presetir.prompt.selectHub3": "Select the Hub3 to emit from",

    "presetir.err.notANumber": "Please specify a number (received value: {value})",
    "presetir.err.deviceRequiredNonInteractive": "--device <hub3uuid> is required (non-interactive mode)",
    "presetir.err.noHub3Found": "No available Hub3 found.",
    "presetir.err.codeRequired": "--code <n> is required (preset remote.code)",
    "presetir.err.irtypeRequired": "--irtype <n> is required (remote.type actual value)",
    "presetir.err.buttonRequired": "--button <type> is required (button type)",
    "presetir.err.commandOptRequired": "--command <hex> is required (HEX command string)",

    // src/presetir.js — sendIR validation guards
    "presetir.err.deviceIdRequired": "deviceId required (Hub3 deviceUUID)",
    "presetir.err.commandRequired": "command required (HEX 文字列)",
    "presetir.err.irTypeRequired": "irType required (remote.type 実値)",
    "presetir.err.companyIdRequired": "companyID required",
  },
  ja: {
    // src/cli/presetir.js — commands / options / output / errors / prompts
    "presetir.cmd.parent.desc": "プリセット IR リモコン発射 (HXD command 生成 + remoteEmit)",
    "presetir.cmd.air.desc": "エアコン状態を発射 (emitAir)。指定したものだけ渡し、残りは本体既定に委ねる",
    "presetir.cmd.button.desc": "非エアコン (TV/ライト/扇風機) のボタン押下を発射 (emitButton)",
    "presetir.cmd.send.desc": "生成済み HEX command をそのまま発射 (sendIR)。低レベル用途",

    "presetir.opt.device": "Hub3 deviceUUID (省略時は対話選択 / 非対話は必須)",
    "presetir.opt.code": "プリセット remote.code (数値)",
    "presetir.opt.power": "電源 ON (省略時 OFF)",
    "presetir.opt.temp": "温度 (UI 値, 例 25)",
    "presetir.opt.mode": "mode index 0-4 {0:自動,1:制冷,2:除湿,3:送風,4:制熱}",
    "presetir.opt.fan": "fanSpeed index 0-3 {0:自動,1:低,2:中,3:高}",
    "presetir.opt.wind": "windDirection index 0-2 {0:上,1:中,2:下}",
    "presetir.opt.swing": "自動風向 ON (省略時 OFF)",
    "presetir.opt.button": "ボタン種別 (例 POWER_STATUS_ON, VOLUME_UP, FAN_SPEED)",
    "presetir.opt.irtypeButton": "remote.type 実値 (TV:8192/0x2000, FAN:32768/0x8000, LIGHT:57344/0xE000)",
    "presetir.opt.command": "発射する HEX command 文字列",
    "presetir.opt.irtypeSend": "remote.type 実値 (AIR:49152/0xC000, TV:8192/0x2000 等)",

    "presetir.out.airEmitted": "OK: emitted air command to {deviceId}",
    "presetir.out.buttonEmitted": "OK: emitted button command to {deviceId}",
    "presetir.out.sent": "OK: sent IR command to {deviceId}",
    "presetir.out.command": "  command: {command}",

    "presetir.prompt.selectHub3": "発射する Hub3 を選択",

    "presetir.err.notANumber": "数値を指定してください (受け取った値: {value})",
    "presetir.err.deviceRequiredNonInteractive": "--device <hub3uuid> が必要です (非対話モード)",
    "presetir.err.noHub3Found": "利用可能な Hub3 が見つかりません。",
    "presetir.err.codeRequired": "--code <n> が必要です (プリセット remote.code)",
    "presetir.err.irtypeRequired": "--irtype <n> が必要です (remote.type 実値)",
    "presetir.err.buttonRequired": "--button <type> が必要です (ボタン種別)",
    "presetir.err.commandOptRequired": "--command <hex> が必要です (HEX command 文字列)",

    // src/presetir.js — sendIR validation guards
    "presetir.err.deviceIdRequired": "deviceId required (Hub3 deviceUUID)",
    "presetir.err.commandRequired": "command required (HEX 文字列)",
    "presetir.err.irTypeRequired": "irType required (remote.type 実値)",
    "presetir.err.companyIdRequired": "companyID required",
  },
};

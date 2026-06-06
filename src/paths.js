// 設定ディレクトリ解決。優先順位:
//   1. 明示渡し (overrideDir, CLI --config-dir)
//   2. env SESAME_KIT_HOME (アプリ専用)
//   3. env XDG_CONFIG_HOME → $XDG_CONFIG_HOME/sesame-kit
//   4. ~/.config/sesame-kit
import { homedir } from "node:os";
import { resolve } from "node:path";

const APP_DIRNAME = "sesame-kit";

export function resolveConfigDir(overrideDir) {
  if (overrideDir) return resolve(overrideDir);
  if (process.env.SESAME_KIT_HOME) return resolve(process.env.SESAME_KIT_HOME);
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return resolve(xdg, APP_DIRNAME);
  return resolve(homedir(), ".config", APP_DIRNAME);
}

export function configPaths(overrideDir) {
  const dir = resolveConfigDir(overrideDir);
  return {
    dir,
    config: resolve(dir, "config.json"),
    tokens: resolve(dir, "tokens.json"),
    loginState: resolve(dir, "login_state.json"),
    devices: resolve(dir, "devices.json"),
    // `sesame serve` の Unix domain socket (POSIX 専用。dir 自体が 0700)。
    socket: resolve(dir, "sesame.sock"),
  };
}

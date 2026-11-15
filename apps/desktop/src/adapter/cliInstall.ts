// CLI 布署接线面（design D5）：Tauri 壳收集环境事实、运行布署计划；决策归
// core/cliInstall。store 只依赖此接口，测试以假 adapter 注入。
import { invoke } from "@tauri-apps/api/core";

import type { CliDeployPlan, CliPlatform } from "../core/cliInstall";

/** Rust 壳一次收齐的环境事实（cli_install_probe）。 */
export interface CliInstallProbe {
  platform: CliPlatform;
  home: string | null;
  pathEnv: string;
  pathDelimiter: ":" | ";";
  bundledCliPath: string | null;
  appVersion: string;
  /** 已布署 CLI 的 --version 原始输出；null＝未侦测到。 */
  deployedVersionOutput: string | null;
  /** ~/.zprofile 现有内容（macOS；读不到或非 macOS 为 null）——PATH 幂等追加
   * 的判定输入（design D12）。 */
  zprofile: string | null;
}

export interface CliInstallAdapter {
  probe: () => Promise<CliInstallProbe>;
  deploy: (plan: Exclude<CliDeployPlan, { action: "none" }>) => Promise<void>;
  /** 追加一行至 ~/.zprofile（macOS PATH 自动设置；幂等判定归 core）。 */
  appendZprofile: (line: string) => Promise<void>;
}

export function tauriCliInstallAdapter(): CliInstallAdapter {
  return {
    probe: () => invoke<CliInstallProbe>("cli_install_probe"),
    deploy: (plan) => invoke("cli_deploy", { plan }),
    appendZprofile: (line) => invoke("cli_zprofile_append", { line }),
  };
}

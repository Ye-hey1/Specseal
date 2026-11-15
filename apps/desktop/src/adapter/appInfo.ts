// 关于页的版本信息（desktop-about-page design D1）：对 Tauri 命令 `app_info` 的单行委派。
// 引擎版号只有 Rust 端知道，前端不自行拼凑。
import { invoke } from "@tauri-apps/api/core";

export interface AppInfo {
  appVersion: string;
  /** 引擎版号（ASSET_VERSION，与 CLI `--version` 的 engine 同一个值）。 */
  engineVersion: string;
  /** 显示文本：macOS／Windows／Linux。 */
  platform: string;
  /** 显示文本：arm64／x64。 */
  arch: string;
}

export const loadAppInfo = (): Promise<AppInfo> => invoke<AppInfo>("app_info");

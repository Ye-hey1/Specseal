// updater 接线面（design D6）：Tauri 壳对 tauri-plugin-updater／plugin-process 的
// 单行委派，加上主窗口焦点事件的委派（前景重检的信号；update-recheck-on-focus
// design D1）。store 只依赖此接口，测试以假 adapter 注入。
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** app 自身版本（设置页软件更新卡的常驻现版号）。 */
export const appVersion = (): Promise<string> => getVersion();

/** check 找到的新版：版本号＋下载与安装两段（签章验证由 plugin 内置，失败即 reject）。
 * 分两段是为了「取消」：用户在下载中取消后，下载完成也不安装（desktop-app「取消下载回到闲置」）。 */
export interface PendingUpdate {
  version: string;
  download: () => Promise<void>;
  install: () => Promise<void>;
}

export interface UpdaterAdapter {
  /** 检查更新端点；回 null＝已是最新。脱机／端点不可达时 reject。 */
  check: () => Promise<PendingUpdate | null>;
  /** 套用更新后重启 app。 */
  relaunch: () => Promise<void>;
  /**
   * 订阅主窗口焦点变化（前景重检的信号；design D1）：handler 收到 true＝取得焦点。
   * 可选——既有假 adapter 与非 Tauri 环境不提供时，app 不订阅、不重检。
   * 回传取消订阅函数的 Promise。
   */
  onFocusChanged?: (handler: (focused: boolean) => void) => Promise<() => void>;
}

export function tauriUpdaterAdapter(): UpdaterAdapter {
  return {
    async check() {
      const update = await check();
      if (!update) return null;
      return {
        version: update.version,
        download: () => update.download(),
        install: () => update.install(),
      };
    },
    relaunch,
    // async：getCurrentWindow() 在非 Tauri 环境是同步抛错，包成 async 让它一律
    // 变成 reject，调用端只靠 .catch 即可静默。
    onFocusChanged: async (handler) =>
      getCurrentWindow().onFocusChanged(({ payload }) => handler(payload)),
  };
}

// 外观偏好（desktop-settings-mode design D4）：localStorage 单键，null 表跟随系统。明示浅色／
// 深色以根元素的 data-theme 属性触发 theme.css 的对应区块；server-web 不读此键、不设属性。

/** null＝跟随系统的浅色／深色偏好。 */
export type ThemePreference = "light" | "dark" | null;

/** 偏好键；desktop 的 index.html 开机脚本读同一个键（首次绘制前先套，避免先闪系统主题）。 */
export const THEME_STORAGE_KEY = "specseal.theme";

/** 读取偏好；缺键、非法值（手改 localStorage）或保存区不可用一律视为跟随系统。 */
export function readThemePreference(storage: Storage = localStorage): ThemePreference {
  try {
    const v = storage.getItem(THEME_STORAGE_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

/** 写入偏好；保存区不可用（停用、配额满）时静默略过——本次照常套用，只是不跨启动保留。 */
export function writeThemePreference(pref: ThemePreference, storage: Storage = localStorage): void {
  try {
    if (pref === null) storage.removeItem(THEME_STORAGE_KEY);
    else storage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    /* 见上 */
  }
}

/** 套用偏好：明示值设 data-theme，跟随系统移除属性（交回 prefers-color-scheme）。 */
export function applyThemePreference(
  pref: ThemePreference,
  root: HTMLElement = document.documentElement,
): void {
  if (pref === null) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

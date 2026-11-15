// UI 语言偏好：localStorage 单键，null 表跟随系统；与 config.yaml 的 locale
//（AI artifacts 产出语言）互不影响。
//
// 这四个函数与哪个 app 无关，Desktop 与 Server 两端都要用——抄第二份就是这类工具漂移
// 的起点，所以放在共用套件，Desktop 的 i18n/locale.ts 改为自此 re-export。
import type { UiLocale } from "./i18n";

/** null＝跟随系统语言。 */
export type LocalePreference = UiLocale | null;

const STORAGE_KEY = "specseal.uiLocale";

/** 系统语言判定：以 zh 开头 → zh-CN，其余（含未知）→ en。 */
export function detectSystemLocale(language: string | undefined): UiLocale {
  return language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/** 读取偏好；缺键或非法值（手改 localStorage）一律视为未设置。 */
export function readLocalePreference(storage: Storage = localStorage): LocalePreference {
  const v = storage.getItem(STORAGE_KEY);
  return v === "zh-CN" || v === "en" ? v : null;
}

export function writeLocalePreference(pref: LocalePreference, storage: Storage = localStorage): void {
  if (pref === null) storage.removeItem(STORAGE_KEY);
  else storage.setItem(STORAGE_KEY, pref);
}

/** 有效 UI 语言：明示偏好优先，null 跟随系统。 */
export function resolveUiLocale(pref: LocalePreference, systemLanguage: string | undefined): UiLocale {
  return pref ?? detectSystemLocale(systemLanguage);
}

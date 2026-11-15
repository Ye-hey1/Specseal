import { createContext, useContext, type ReactNode } from "react";
import type { LocalePreference, UiLocale } from "@specseal/ui";

// 语言偏好由 App 持有（它同时决定 I18nProvider 的 locale），帐号菜单与登录卡片下方的切换钮需要读写它。
// 只有这一组值，不值得引入状态管理；context 让「谁在改语言」在原代码里一眼可查。
type LocaleState = { pref: LocalePreference; setPref: (pref: LocalePreference) => void };

const LocaleContext = createContext<LocaleState | null>(null);

/** 接口语言选项（帐号菜单与登录卡片下方共用）。名称维持母语写法——把「English」翻成「英文」
 *  只会让看不懂当前语言的人找不到自己的语言；short 给空间窄的切换钮。 */
export const UI_LOCALES: { value: UiLocale; name: string; short: string }[] = [
  { value: "zh-CN", name: "繁体中文", short: "中文" },
  { value: "en", name: "English", short: "English" },
];

export function LocaleProvider({ value, children }: { value: LocaleState; children: ReactNode }) {
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocalePreference(): LocaleState {
  const ctx = useContext(LocaleContext);
  if (ctx === null) throw new Error("useLocalePreference 必须在 LocaleProvider 内使用");
  return ctx;
}

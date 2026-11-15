import { useState } from "react";
import { BrowserRouter, MemoryRouter } from "react-router-dom";
import {
  I18nProvider,
  readLocalePreference,
  resolveUiLocale,
  writeLocalePreference,
  type LocalePreference,
} from "@specseal/ui";
import type { WebClient } from "./api/client";
import { ClientProvider } from "./app/context";
import { LocaleProvider } from "./i18n/LocaleContext";
import { APP_MESSAGES } from "./i18n/messages";
import { AppRoutes } from "./routes/AppRoutes";

// Server Web Console 应用壳层。client 是唯一 HTTP 入口（测试注入 fake）；
// initialEntries 存在时用 MemoryRouter（测试），否则 BrowserRouter（正式）。
//
// UI 语言：明示偏好优先，未设置则跟随浏览器语言（zh 开头为 zh-CN，其余 en）。
// 与 Desktop 同一套机制与同一个 localStorage 键。
export function App({
  client,
  initialEntries,
}: {
  client: WebClient;
  initialEntries?: string[];
}) {
  const [pref, setPrefState] = useState<LocalePreference>(() => safeReadPreference());
  // 切换即时生效并持久化（header 的语言三选接这里）。
  const setPref = (next: LocalePreference) => {
    safeWritePreference(next);
    setPrefState(next);
  };
  const locale = resolveUiLocale(
    pref,
    typeof navigator !== "undefined" ? navigator.language : undefined,
  );

  const tree = (
    <I18nProvider locale={locale} messages={APP_MESSAGES}>
      <LocaleProvider value={{ pref, setPref }}>
        <ClientProvider client={client}>
          <AppRoutes />
        </ClientProvider>
      </LocaleProvider>
    </I18nProvider>
  );
  return initialEntries ? (
    <MemoryRouter initialEntries={initialEntries}>{tree}</MemoryRouter>
  ) : (
    <BrowserRouter>{tree}</BrowserRouter>
  );
}

// localStorage 在隐私模式或被停用时读写会丢例外。读失败＝视为未设置（跟随系统），
// 写失败＝不持久化，两者都不该让整个 app 起不来。
function safeReadPreference(): LocalePreference {
  try {
    return readLocalePreference();
  } catch {
    return null;
  }
}

function safeWritePreference(pref: LocalePreference): void {
  try {
    writeLocalePreference(pref);
  } catch {
    // 不持久化即可，本次切换照常生效。
  }
}

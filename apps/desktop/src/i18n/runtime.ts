// React 之外（zustand store）的 t 桥：App 于 Provider 内把当前 t 同步进来，
// store 组用户可见消息时经 appT 取字符串。切语言后既有瞬时消息不重译（可接受）。
import { MESSAGES } from "@specseal/ui";

import { APP_MESSAGES } from "./messages";

let currentT: (key: string) => string = (key) =>
  APP_MESSAGES["zh-CN"][key] ?? MESSAGES["zh-CN"][key] ?? key;

/** App 于 I18nProvider 内同步当前 t（useEffect）。 */
export function setAppT(t: (key: string) => string): void {
  currentT = t;
}

/** store 层取用户可见字符串。 */
export function appT(key: string): string {
  return currentT(key);
}

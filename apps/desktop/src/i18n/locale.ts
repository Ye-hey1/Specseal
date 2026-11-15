// UI 语言偏好（design D8）已提升到 @specseal/ui 供 Desktop 与 Server 共用。
// 此档保留为 re-export，让既有的 `../i18n/locale` import 面维持不变。
export {
  detectSystemLocale,
  readLocalePreference,
  writeLocalePreference,
  resolveUiLocale,
  type LocalePreference,
} from "@specseal/ui";

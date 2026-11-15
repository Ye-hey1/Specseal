// 更新日志的类型面（release-notes spec「更新日志 JSON 为唯一真相」）：JSON 由 Vite 原生
// 打包，这里只把 kind 由 string 收窄为三值字面联集、条目收窄为双语对象并导出常数；内容不在
// 这里手写。分组标题不在 JSON，由呈现端以 releaseNotes.kind.* 依接口语言决定。
import type { UiLocale } from "@specseal/ui";

import notes from "./release-notes.json";

export type ReleaseNotesKind = "features" | "fixes" | "improvements";

/** 一个条目的两种语言写法；键与接口语言 UiLocale 同字面，两种都必填。 */
export type ReleaseNotesItem = Record<UiLocale, string>;

export interface ReleaseNotesSection {
  kind: ReleaseNotesKind;
  items: ReleaseNotesItem[];
}

export interface ReleaseNotesEntry {
  /** 不带 v，与 tauri.conf.json 的 version 同字面。 */
  version: string;
  /** YYYY-MM-DD */
  date: string;
  sections: ReleaseNotesSection[];
}

/** 全部条目，最新在前。 */
export const RELEASE_NOTES = notes as ReleaseNotesEntry[];

/** 条目在该接口语言的文本（desktop-app spec「更新日志依接口语言呈现」）。 */
export function entryText(item: ReleaseNotesItem, locale: UiLocale): string {
  return item[locale];
}

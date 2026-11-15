// 面板内容卡的收合记忆（spec「面板内容卡收合」；design「收合状态记在面板本机、所有项目
// 共用一份」）：app 本机（localStorage）单一键，值为收合中分区 id 的 JSON 数组。收合是
// 个人阅读习惯、与项目无关，故不分项目；形状比照 promotedExpanded.ts。
import { STAGES, type Stage } from "@specseal/ui";

/** 可收合的四张内容卡：三个生命周期阶段（即 Stage 值）＋讨论。 */
export type TraySectionId = Stage | "discussions";

const SECTION_IDS: readonly TraySectionId[] = [...STAGES, "discussions"];

export const TRAY_COLLAPSED_SECTIONS_STORAGE_KEY = "specseal.tray.collapsedSections";

/** 键缺席、坏值或 localStorage 不可用一律视为全部展开（空集合），不抛错；未知 id 忽略。 */
export function readTrayCollapsedSections(): Set<TraySectionId> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TRAY_COLLAPSED_SECTIONS_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return new Set();
    return new Set(SECTION_IDS.filter((id) => parsed.includes(id)));
  } catch {
    return new Set();
  }
}

/** 以目前收合集合整份覆写；写入失败静默——记不住只是下次回到上次读得到的状态。 */
export function writeTrayCollapsedSections(sections: ReadonlySet<TraySectionId>): void {
  try {
    localStorage.setItem(
      TRAY_COLLAPSED_SECTIONS_STORAGE_KEY,
      JSON.stringify(SECTION_IDS.filter((id) => sections.has(id))),
    );
  } catch {
    // localStorage 不可用：不记忆。
  }
}

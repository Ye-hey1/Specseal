// 规格详情页阅读卡的推导（desktop-spec-manual-pages design D4）：数字砖、提示框条件与溯源砖，
// 全由需求段与 @trace 推出；形状缺席回 null、0 或空数组，不抛错。

import type { DocTile } from "./components/DetailShell";
import { PURPOSE_TBD_PREFIX, type SpecSections } from "./specSections";

/** 一个 @trace 时点：来源变更与 updated 原字符串（纯日期或 RFC 3339）。 */
export interface TracePoint {
  source: string;
  updated: string;
}

export interface SpecStats {
  /** `### Requirement:` 段数。 */
  requirements: number;
  /** 各需求段 Scenario 数加总。 */
  scenarios: number;
  /** 全文 @trace 来源变更去重数。 */
  sourceCount: number;
  /** 需求段尾 @trace 中最大／最小的 updated；全无 @trace 为 null。 */
  latest: TracePoint | null;
  earliest: TracePoint | null;
  /** 有 @trace 的需求数。 */
  traced: number;
  /** 没有 @trace 的需求标题（文档序）。 */
  untraced: string[];
  /** Purpose 以封存占位前缀起头。 */
  purposeTbd: boolean;
}

/** 先比前 10 字的日历日、同日再比全文——纯日期与 RFC 3339 混用时以日历日为准。 */
function compareUpdated(a: string, b: string): number {
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return cmp(a.slice(0, 10), b.slice(0, 10)) || cmp(a, b);
}

/** 数字砖、出处行与提示框的日期只取日历日。 */
export const calendarDay = (updated: string) => updated.slice(0, 10);

/** 需求段尾 @trace 中最大／最小的 updated；全无 @trace 或 `sections` 为 null 时皆 null。 */
export function traceSpan(sections: SpecSections | null): { latest: TracePoint | null; earliest: TracePoint | null } {
  let latest: TracePoint | null = null;
  let earliest: TracePoint | null = null;
  for (const r of sections?.requirements ?? []) {
    if (!r.trace?.updated) continue;
    const point = { source: r.trace.source, updated: r.trace.updated };
    if (!latest || compareUpdated(point.updated, latest.updated) > 0) latest = point;
    if (!earliest || compareUpdated(point.updated, earliest.updated) < 0) earliest = point;
  }
  return { latest, earliest };
}

/** `sourceCount` 为全文 @trace 来源去重数（页的溯源列长度）；`sections` 为 null＝规格没有需求标题。 */
export function specStats(sections: SpecSections | null, sourceCount: number): SpecStats {
  const requirements = sections?.requirements ?? [];
  return {
    requirements: requirements.length,
    scenarios: requirements.reduce((n, r) => n + r.scenarios.length, 0),
    sourceCount,
    ...traceSpan(sections),
    traced: requirements.filter((r) => r.trace).length,
    untraced: requirements.filter((r) => !r.trace).map((r) => r.title),
    purposeTbd: (sections?.purpose ?? "").trim().startsWith(PURPOSE_TBD_PREFIX),
  };
}

/** 「规格」文档的数字砖：需求、Scenario、溯源变更、最近更新（无 @trace 时缺席）；没有需求段时空数组。 */
export function specTiles(stats: SpecStats, t: (key: string) => string): DocTile[] {
  if (stats.requirements === 0) return [];
  const tiles: DocTile[] = [
    { value: stats.requirements, label: t("sdetail.tileRequirements") },
    { value: stats.scenarios, label: t("sdetail.tileScenarios") },
    { value: stats.sourceCount, label: t("sdetail.tileSources") },
  ];
  if (stats.latest) {
    tiles.push({
      value: calendarDay(stats.latest.updated),
      label: t("sdetail.tileUpdated").replace("{change}", stats.latest.source),
    });
  }
  return tiles;
}

/** 「溯源」文档的数字砖：来源变更、最早、最近、有来源的需求；没有来源变更时空数组。 */
export function traceTiles(stats: SpecStats, t: (key: string) => string): DocTile[] {
  if (stats.sourceCount === 0) return [];
  const point = (p: TracePoint | null, key: string): DocTile[] =>
    p ? [{ value: calendarDay(p.updated), label: t(key).replace("{change}", p.source) }] : [];
  return [
    { value: stats.sourceCount, label: t("sdetail.tileSourceCount") },
    ...point(stats.earliest, "sdetail.tileEarliest"),
    ...point(stats.latest, "sdetail.tileLatest"),
    { value: `${stats.traced} ／ ${stats.requirements}`, label: t("sdetail.tileTraced") },
  ];
}

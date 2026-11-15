// desktop-spec-manual-pages design D4：规格详情页的数字砖、提示框与溯源砖由需求段与 @trace 推出
//（spec「桌面 app 呈现 change 与 spec 的清单与内容」）。纯函数、形状缺席回 null／0／空数组。
import { describe, it, expect } from "vitest";

import { MESSAGES } from "../i18n";
import type { SpecRequirement, SpecSections } from "../specSections";
import { calendarDay, specStats, specTiles, traceSpan, traceTiles } from "../specSummary";

const t = (key: string) => MESSAGES["zh-CN"][key] ?? key;

type Trace = { source: string; updated: string } | null;

function req(title: string, scenarios: number, trace: Trace): SpecRequirement {
  return {
    title,
    body: "需求文",
    scenarios: Array.from({ length: scenarios }, (_, i) => ({ title: `s${i}`, body: "" })),
    trace,
  };
}

function sections(requirements: SpecRequirement[], purpose = "示范用的规格。"): SpecSections {
  return { purpose, intro: "", requirements, appendix: "" };
}

/** Scenario「规格文档的出处行、数字砖与状态栏」：15 条需求、74 个 scenario、9 个来源变更、
 * 最近更新 2026-10-12 来自 tray-panel-restyle。 */
const TRAY_SOURCES = [
  "tray-status-menu-init",
  "tray-quick-actions",
  "tray-project-switch",
  "tray-discussion-rows",
  "tray-remote-panel",
  "tray-quality-stamps",
  "tray-load-states",
  "tray-overflow-fold",
  "tray-panel-restyle",
];
const TRAY_UPDATED = [
  "2026-09-10",
  "2026-09-11",
  "2026-09-12",
  "2026-09-13",
  "2026-09-14",
  "2026-09-15",
  "2026-09-16",
  "2026-09-17",
  "2026-10-12",
];
function trayRequirements(untraced: string[] = []): SpecRequirement[] {
  return Array.from({ length: 15 }, (_, i) => {
    const title = untraced[i - 13] ?? `需求 ${i + 1}`;
    const k = i % 9;
    const trace = i >= 13 && untraced.length > 0 ? null : { source: TRAY_SOURCES[k], updated: TRAY_UPDATED[k] };
    // 14 条各 5 个、最后一条 4 个：加总 74。
    return req(title, i === 14 ? 4 : 5, trace);
  });
}

describe("specStats", () => {
  it("tray-status-menu：需求数、Scenario 加总、来源数、最早与最近", () => {
    const stats = specStats(sections(trayRequirements()), TRAY_SOURCES.length);
    expect(stats).toEqual({
      requirements: 15,
      scenarios: 74,
      sourceCount: 9,
      latest: { source: "tray-panel-restyle", updated: "2026-10-12" },
      earliest: { source: "tray-status-menu-init", updated: "2026-09-10" },
      traced: 15,
      untraced: [],
      purposeTbd: false,
    });
  });

  it("缺 @trace 的需求列入 untraced、不计入 traced", () => {
    const stats = specStats(
      sections(trayRequirements(["菜单内容与看板同源", "分区溢出折叠"])),
      TRAY_SOURCES.length,
    );
    expect(stats.traced).toBe(13);
    expect(stats.untraced).toEqual(["菜单内容与看板同源", "分区溢出折叠"]);
  });

  it("全文无 @trace：最早与最近为 null、全部需求列入 untraced", () => {
    const stats = specStats(sections([req("登录", 2, null), req("注销", 1, null)]), 0);
    expect(stats.latest).toBeNull();
    expect(stats.earliest).toBeNull();
    expect(stats.sourceCount).toBe(0);
    expect(stats.traced).toBe(0);
    expect(stats.untraced).toEqual(["登录", "注销"]);
  });

  it("纯日期与 RFC 3339 混用：先比日历日、同日再比全文", () => {
    const mixed = sections([
      req("a", 1, { source: "same-day-date", updated: "2026-10-12" }),
      req("b", 1, { source: "same-day-time", updated: "2026-10-12T16:18:33+08:00" }),
      req("c", 1, { source: "eve", updated: "2026-10-11T23:59:59+08:00" }),
      req("d", 1, { source: "next-day", updated: "2026-10-13" }),
    ]);
    const stats = specStats(mixed, 4);
    expect(stats.latest).toEqual({ source: "next-day", updated: "2026-10-13" });
    expect(stats.earliest).toEqual({ source: "eve", updated: "2026-10-11T23:59:59+08:00" });

    const sameDay = specStats(sections(mixed.requirements.slice(0, 2)), 0);
    expect(sameDay.latest).toEqual({ source: "same-day-time", updated: "2026-10-12T16:18:33+08:00" });
    expect(sameDay.earliest).toEqual({ source: "same-day-date", updated: "2026-10-12" });
  });

  it("purposeTbd 只认去头尾空白后的封存占位前缀", () => {
    const one = [req("登录", 1, null)];
    expect(specStats(sections(one, "\n  TBD - created by archiving change add-login. Update Purpose after archive."), 0).purposeTbd).toBe(
      true,
    );
    expect(specStats(sections(one, "说明里提到 TBD - created by archiving 但不是开头"), 0).purposeTbd).toBe(false);
    expect(specStats(sections(one, ""), 0).purposeTbd).toBe(false);
  });

  it("sections 为 null：计数为 0、无最早最近、无 untraced", () => {
    expect(specStats(null, 1)).toEqual({
      requirements: 0,
      scenarios: 0,
      sourceCount: 1,
      latest: null,
      earliest: null,
      traced: 0,
      untraced: [],
      purposeTbd: false,
    });
  });
});

describe("traceSpan 与 calendarDay", () => {
  it("traceSpan 取需求段尾 @trace 的最早与最近；全无 @trace 或 sections 为 null 时皆 null", () => {
    expect(traceSpan(sections(trayRequirements()))).toEqual({
      latest: { source: "tray-panel-restyle", updated: "2026-10-12" },
      earliest: { source: "tray-status-menu-init", updated: "2026-09-10" },
    });
    expect(traceSpan(sections([req("登录", 1, null)]))).toEqual({ latest: null, earliest: null });
    expect(traceSpan(null)).toEqual({ latest: null, earliest: null });
  });

  it("calendarDay 只取日历日：纯日期原样、RFC 3339 切前 10 字", () => {
    expect(calendarDay("2026-10-12")).toBe("2026-10-12");
    expect(calendarDay("2026-10-12T16:18:33+08:00")).toBe("2026-10-12");
  });
});

describe("specTiles", () => {
  it("四格：需求、Scenario、溯源变更、最近更新 · <变更>（值为日历日）", () => {
    const stats = specStats(sections(trayRequirements()), TRAY_SOURCES.length);
    expect(specTiles(stats, t)).toEqual([
      { value: 15, label: "需求" },
      { value: 74, label: "Scenario" },
      { value: 9, label: "溯源变更" },
      { value: "2026-10-12", label: "最近更新 · tray-panel-restyle" },
    ]);
  });

  it("最近更新为 RFC 3339 时砖值只取日历日", () => {
    const stats = specStats(sections([req("a", 1, { source: "x", updated: "2026-10-12T16:18:33+08:00" })]), 1);
    expect(specTiles(stats, t)[3]).toEqual({ value: "2026-10-12", label: "最近更新 · x" });
  });

  it("无 @trace 时三格（最近更新缺席）", () => {
    const stats = specStats(sections([req("登录", 2, null)]), 0);
    expect(specTiles(stats, t)).toEqual([
      { value: 1, label: "需求" },
      { value: 2, label: "Scenario" },
      { value: 0, label: "溯源变更" },
    ]);
  });

  it("sections 为 null 时空数组", () => {
    expect(specTiles(specStats(null, 1), t)).toEqual([]);
  });
});

describe("traceTiles", () => {
  it("四格：来源变更、最早 · <变更>、最近 · <变更>、有来源的需求", () => {
    const stats = specStats(sections(trayRequirements()), TRAY_SOURCES.length);
    expect(traceTiles(stats, t)).toEqual([
      { value: 9, label: "来源变更" },
      { value: "2026-09-10", label: "最早 · tray-status-menu-init" },
      { value: "2026-10-12", label: "最近 · tray-panel-restyle" },
      { value: "15 ／ 15", label: "有来源的需求" },
    ]);
  });

  it("两条需求缺 @trace 时「有来源的需求」为 13 ／ 15", () => {
    const stats = specStats(
      sections(trayRequirements(["菜单内容与看板同源", "分区溢出折叠"])),
      TRAY_SOURCES.length,
    );
    expect(traceTiles(stats, t)[3]).toEqual({ value: "13 ／ 15", label: "有来源的需求" });
  });

  it("sourceCount 为 0 时空数组", () => {
    expect(traceTiles(specStats(sections([req("登录", 2, null)]), 0), t)).toEqual([]);
  });
});

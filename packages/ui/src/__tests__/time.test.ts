// relativeDays（fix-english-status-labels-and-plurals）：翻译对象由调用端注入；英文 2 天以上用复数，
// 差 1 天固定写「昨天」——所以 time.daysAgo 的单数形不会出现（desktop-config「数量为 0 或 2 以上时用复数」）。
import { describe, it, expect } from "vitest";

import { translatorFor } from "../i18n";
import { relativeDays } from "../time";

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000 - 3_600_000).toISOString();

describe("relativeDays", () => {
  const en = translatorFor("en");

  it("英文 3 天前写「3 days ago」", () => {
    expect(relativeDays(daysAgo(3), en)).toBe("3 days ago");
  });

  it("差 1 天写「Yesterday」，不写「1 day ago」", () => {
    expect(relativeDays(daysAgo(1), en)).toBe(en.t("time.yesterday"));
  });

  it("繁中 3 天前用繁中字符串", () => {
    const zh = translatorFor("zh-CN");
    expect(relativeDays(daysAgo(3), zh)).toBe(zh.t("time.daysAgo").replace("{n}", "3"));
  });

  it("没有日期回 null，不可解析的字符串原样回传", () => {
    expect(relativeDays(null, en)).toBeNull();
    expect(relativeDays("not a date", en)).toBe("not a date");
  });
});

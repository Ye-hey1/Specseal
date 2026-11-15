// app 层字典的两语言 key 集合相等（比照 packages/ui 的 MESSAGES 测试）——
// t(key) 缺 key 时静默回传 key 本身，单边添加字符串若无此测试会默默漏译。
import { describe, it, expect } from "vitest";

import { dictionaryProblems, translatorFor } from "@specseal/ui";

import { APP_MESSAGES } from "../i18n/messages";

describe("APP_MESSAGES", () => {
  // 两语言键集合（.one 除外）、.one 只在英文、计数文案用 {n} 并有 .one——与 @specseal/ui 共用同一个检查。
  it("passes the shared dictionary check", () => {
    expect(dictionaryProblems(APP_MESSAGES)).toEqual([]);
    expect(Object.keys(APP_MESSAGES.en).length).toBeGreaterThan(0);
  });

  it("英文计数文案在 1 时用单数（desktop-config「英文计数文案依数量使用单数或复数」）", () => {
    const en = translatorFor("en", APP_MESSAGES);
    expect(en.tn("settings.rulesCount", 1)).toBe("1 rule");
    expect(en.tn("settings.rulesCount", 3)).toBe("3 rules");
    expect(en.tn("assets.card.staleDesc", 1)).toBe("Updating rewrites 1 file");
    expect(en.tn("migration.successCount", 1)).toBe("Migrated 1 document");
  });

  it("macOS 原生菜单的 menu.* 文案键两语系各 36 个且集合相等（desktop-native-menu design D2）", () => {
    const menuKeys = (locale: "zh-CN" | "en") =>
      Object.keys(APP_MESSAGES[locale])
        .filter((key) => key.startsWith("menu."))
        .sort();
    expect(menuKeys("zh-CN")).toHaveLength(36);
    expect(menuKeys("zh-CN")).toEqual(menuKeys("en"));
  });

  it("设置模式改版后没人用的旧键已自两语系移除", () => {
    for (const key of [
      "servers.title",
      "settings.rulesLabel",
      "settings.backToProject",
      "updater.checking",
      "updater.upToDate",
      "updater.checkFailed",
      "updater.available",
      // desktop-about-page design D7：一般页收敛后没人用的键。
      "settings.section.appearance",
      "settings.uiLocaleLabel",
      "updater.cardTitle",
      "updater.help",
    ]) {
      expect(APP_MESSAGES["zh-CN"]).not.toHaveProperty([key]);
      expect(APP_MESSAGES.en).not.toHaveProperty([key]);
    }
  });

  it("侧栏手册项的文案键存在于两语系（LANGUAGE.md 用语「手册」）", () => {
    expect(APP_MESSAGES["zh-CN"]["app.navManual"]).toBe("手册");
    expect(APP_MESSAGES.en["app.navManual"]).toBe("Manual");
  });

  it("zh-CN 文案不得含工程词 change——LANGUAGE.md 正典词是「变更」（worktree 为明文例外，change 不是）", () => {
    const offenders = Object.entries(APP_MESSAGES["zh-CN"])
      .filter(([, value]) => /\bchanges?\b/.test(value))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  it("zh-CN 文案不得含工程词 schema——LANGUAGE.md 正典词是「产出流程」（原页签标签例外已随分类栏退场）", () => {
    const offenders = Object.entries(APP_MESSAGES["zh-CN"])
      .filter(([, value]) => /\bschemas?\b/i.test(value))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });
});

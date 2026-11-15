// 外观偏好（desktop-settings-mode design D4）：localStorage 单键、null 表跟随系统；
// 明示浅色／深色以根元素的 data-theme 属性触发 theme.css 的对应区块。
import { describe, it, expect, beforeEach } from "vitest";

import {
  THEME_STORAGE_KEY,
  applyThemePreference,
  readThemePreference,
  writeThemePreference,
} from "../theme";

const KEY = "specseal.theme";
// 本套件的 jsdom 环境不挂 Web Storage：注入内存版 Storage（函数只用 get／set／remove）。
const entries = new Map<string, string>();
const storage = {
  getItem: (key: string) => entries.get(key) ?? null,
  setItem: (key: string, value: string) => void entries.set(key, String(value)),
  removeItem: (key: string) => void entries.delete(key),
  clear: () => entries.clear(),
} as unknown as Storage;

beforeEach(() => {
  storage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("外观偏好读写", () => {
  it.each([
    ["light", "light"],
    ["dark", "dark"],
  ] as const)("写入 %s 后读回 %s", (pref, expected) => {
    writeThemePreference(pref, storage);
    expect(storage.getItem(KEY)).toBe(pref);
    expect(readThemePreference(storage)).toBe(expected);
  });

  it("写入 null（跟随系统）即移除键，读回 null", () => {
    writeThemePreference("dark", storage);
    writeThemePreference(null, storage);
    expect(storage.getItem(KEY)).toBeNull();
    expect(readThemePreference(storage)).toBeNull();
  });

  it.each(["", "Dark", "system", "1", "null"])("坏值 %j 视为跟随系统", (bad) => {
    storage.setItem(KEY, bad);
    expect(readThemePreference(storage)).toBeNull();
  });

  it("保存区抛错（停用或配额满）时读为跟随系统、写入静默略过", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    expect(readThemePreference(broken)).toBeNull();
    expect(() => writeThemePreference("dark", broken)).not.toThrow();
    expect(() => writeThemePreference(null, broken)).not.toThrow();
  });

  it("键名对外导出（index.html 的开机脚本读同一个键）", () => {
    expect(THEME_STORAGE_KEY).toBe(KEY);
  });
});

// spec desktop-config Example「有效主题判定」：偏好经 applyThemePreference 落到根元素，
// 系统深色时看媒体查找区块的选择器、明示深色看 data-theme 区块的选择器（两个选择器
// 在 theme.css 的位置由 theme.test.ts 钉住）。
describe("有效主题判定", () => {
  const SYSTEM_DARK_SELECTOR = ':root:not([data-theme="light"])';
  const EXPLICIT_DARK_SELECTOR = ':root[data-theme="dark"]';
  const PREF = { 跟随系统: null, 浅色: "light", 深色: "dark" } as const;

  it.each([
    ["跟随系统", "浅色", "浅色"],
    ["跟随系统", "深色", "深色"],
    ["浅色", "深色", "浅色"],
    ["深色", "浅色", "深色"],
  ] as const)("偏好 %s、系统 %s → %s", (pref, system, effective) => {
    const root = document.documentElement;
    applyThemePreference(PREF[pref], root);
    const dark =
      (system === "深色" && root.matches(SYSTEM_DARK_SELECTOR)) || root.matches(EXPLICIT_DARK_SELECTOR);
    expect(dark ? "深色" : "浅色").toBe(effective);
  });
});

describe("applyThemePreference", () => {
  it("明示浅色／深色设 data-theme，跟随系统移除属性", () => {
    const root = document.documentElement;
    applyThemePreference("dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
    applyThemePreference("light");
    expect(root.getAttribute("data-theme")).toBe("light");
    applyThemePreference(null);
    expect(root.hasAttribute("data-theme")).toBe(false);
  });

  it("可指定套用的根元素", () => {
    const el = document.createElement("div");
    applyThemePreference("dark", el);
    expect(el.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

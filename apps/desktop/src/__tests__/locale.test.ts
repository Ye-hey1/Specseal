// design D8：UI 语言偏好存 localStorage 单键、null 表跟随系统；
// 系统语言以 zh 开头判 zh-CN 否则 en。
import { describe, it, expect } from "vitest";

import {
  detectSystemLocale,
  readLocalePreference,
  writeLocalePreference,
  resolveUiLocale,
} from "../i18n/locale";

describe("detectSystemLocale（spec Example「系统语言判定」）", () => {
  // | 系统语言 | UI 语言 |
  it.each([
    ["zh-CN", "zh-CN"],
    ["zh-CN", "zh-CN"],
    ["en-US", "en"],
    ["ja-JP", "en"],
  ] as const)("%s → %s", (system, ui) => {
    expect(detectSystemLocale(system)).toBe(ui);
  });

  it("undefined 系统语言退回 en", () => {
    expect(detectSystemLocale(undefined)).toBe("en");
  });
});

describe("locale preference（localStorage 单键）", () => {
  function memStorage(): Storage {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: () => null,
      get length() {
        return map.size;
      },
    } as Storage;
  }

  it("round-trips an explicit preference", () => {
    const st = memStorage();
    writeLocalePreference("en", st);
    expect(readLocalePreference(st)).toBe("en");
    writeLocalePreference("zh-CN", st);
    expect(readLocalePreference(st)).toBe("zh-CN");
  });

  it("null preference removes the key (follow system)", () => {
    const st = memStorage();
    writeLocalePreference("en", st);
    writeLocalePreference(null, st);
    expect(readLocalePreference(st)).toBeNull();
    expect(st.length).toBe(0);
  });

  it("garbage stored values read as null instead of crashing", () => {
    const st = memStorage();
    st.setItem("specseal.uiLocale", "fr");
    expect(readLocalePreference(st)).toBeNull();
  });
});

describe("resolveUiLocale", () => {
  it("explicit preference wins over the system language", () => {
    expect(resolveUiLocale("en", "zh-CN")).toBe("en");
    expect(resolveUiLocale("zh-CN", "en-US")).toBe("zh-CN");
  });

  it("null preference follows the system language", () => {
    expect(resolveUiLocale(null, "zh-CN")).toBe("zh-CN");
    expect(resolveUiLocale(null, "en-US")).toBe("en");
  });
});

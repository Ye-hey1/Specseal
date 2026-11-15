import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MESSAGES, dictionaryProblems } from "@specseal/ui";
import { App } from "../App";
import { APP_MESSAGES } from "../i18n/messages";
import { makeAdminClient, setViewport } from "./helpers/adminHarness";

// spec 需求「接口语言支持中文与英文」：未设置偏好时跟随浏览器语言（zh 开头为中文，
// 其余为英文）、侧栏底部帐号菜单提供三选切换、切换即时生效并在重新加载后维持、两语言
// 消息集合完全对应。语言选择不影响 artifacts 产出语言、CLI 或服务器回传的字符串。

const LANGUAGE_KEY = "specseal.uiLocale";


function setBrowserLanguage(language: string) {
  Object.defineProperty(navigator, "language", { value: language, configurable: true });
}

beforeEach(() => {
  setViewport(false);
  localStorage.clear();
  localStorage.setItem("specseal.tourSeen", "1");
});

afterEach(() => setBrowserLanguage("zh-CN"));

function renderAdmin() {
  return render(<App client={makeAdminClient() as never} initialEntries={["/admin"]} />);
}

describe("未设置偏好时跟随浏览器语言", () => {
  it("浏览器为 en-US 时管理面为英文", async () => {
    setBrowserLanguage("en-US");
    renderAdmin();
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Users" })).toBeTruthy();
    expect(screen.queryByText("总览")).toBeNull();
  });

  it("浏览器为 zh-CN 时管理面为中文", async () => {
    setBrowserLanguage("zh-CN");
    renderAdmin();
    expect(await screen.findByRole("heading", { level: 1, name: "总览" })).toBeTruthy();
    expect(screen.queryByText("Overview")).toBeNull();
  });

  it("浏览器语言未知时退回英文", async () => {
    setBrowserLanguage("de-DE");
    renderAdmin();
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
  });
});

describe("帐号菜单的语言切换", () => {
  it("切为 English 后管理面改为英文，刷新后维持", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { unmount } = renderAdmin();
    await screen.findByRole("heading", { level: 1, name: "总览" });

    await user.click(screen.getByRole("button", { name: /帐号菜单/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: "English" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
    expect(localStorage.getItem(LANGUAGE_KEY)).toBe("en");

    // 刷新：偏好留在浏览器，接口仍是英文（浏览器语言仍为 zh-CN，明示偏好优先）。
    unmount();
    renderAdmin();
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
  });

  it("切回跟随系统后清除偏好并回到浏览器语言", async () => {
    localStorage.setItem(LANGUAGE_KEY, "en");
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderAdmin();
    await screen.findByRole("heading", { level: 1, name: "Overview" });

    await user.click(screen.getByRole("button", { name: /Account menu/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Follow system" }));
    expect(await screen.findByRole("heading", { level: 1, name: "总览" })).toBeTruthy();
    expect(localStorage.getItem(LANGUAGE_KEY)).toBeNull();
  });
});

describe("两种语言的消息集合对应", () => {
  // 两语言键集合（.one 除外）、.one 只在英文、计数文案用 {n} 并有 .one——与 @specseal/ui 共用同一个检查。
  it("通过共用的字典检查", () => {
    expect(dictionaryProblems(APP_MESSAGES)).toEqual([]);
  });

  // app 字典与 @specseal/ui 内置字典合并：同 key 同值的条目只是重复定义，换字时两边要一起改。
  it("不重复定义与 @specseal/ui 内置字典同 key 同值的条目", () => {
    for (const locale of ["zh-CN", "en"] as const) {
      const shadowed = Object.entries(APP_MESSAGES[locale])
        .filter(([key, value]) => MESSAGES[locale][key] === value)
        .map(([key]) => key);
      expect(shadowed, locale).toEqual([]);
    }
  });

  it("每个 key 在两种语言都有非空字符串", () => {
    for (const locale of ["zh-CN", "en"] as const) {
      for (const [key, value] of Object.entries(APP_MESSAGES[locale])) {
        expect(typeof value, `${locale}/${key} 应为字符串`).toBe("string");
        expect(value.trim().length, `${locale}/${key} 不应为空`).toBeGreaterThan(0);
      }
    }
  });
});

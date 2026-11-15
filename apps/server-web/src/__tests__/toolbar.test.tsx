import { describe, it, expect, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import { makeAdminClient, renderAt, setViewport } from "./helpers/adminHarness";

// spec 需求「共用设计系统维持高密度可访问体验」的 Scenario「工具列控件高度一致」：
// 同一组工具列内的搜索框、下拉与日期输入高度相同，下拉是套用 theme 的 Select 原语而非
// 原生 <select>，且每个控件都有无障碍名称（工具列在页标题区，没有可见标签）。高度以 class
// 上的 h-* 比对——参差的成因就是两套原语的缺省高度不同，所以直接钉住「彼此相同」而非某个数值。

beforeEach(() => setViewport(false));

// Radix Select 在 <form> 内会额外渲染一个 aria-hidden 的原生 select 供表单送出使用。
// 那不是用户看得到或操作得到的控件，所以「不得有原生 select」指的是可见的那一种。
const VISIBLE_NATIVE_SELECT = "select:not([aria-hidden='true'])";

/** 该元素 class 上的 tailwind 高度 utility（例如 h-8）。 */
function heightClass(el: Element): string | undefined {
  return el.className.toString().split(/\s+/).find((c) => /^h-\d/.test(c));
}

describe("列表工具列的下拉是 Select 原语", () => {
  it("用户页的状态筛选是 combobox 而非原生 select", async () => {
    renderAt("/admin/users", makeAdminClient());
    const toolbar = await screen.findByRole("combobox", { name: /状态/ });
    expect(toolbar.tagName).not.toBe("SELECT");
    expect(document.querySelector(VISIBLE_NATIVE_SELECT)).toBeNull();
  });

  it("凭证页的状态筛选是 combobox 而非原生 select", async () => {
    renderAt("/admin/credentials", makeAdminClient());
    const trigger = await screen.findByRole("combobox", { name: /状态/ });
    expect(trigger.tagName).not.toBe("SELECT");
    expect(document.querySelector(VISIBLE_NATIVE_SELECT)).toBeNull();
  });
});

describe("工具列控件高度一致", () => {
  it("稽核页的搜索框、两个下拉与两个日期输入高度相同，各有无障碍名称，下拉不是原生 select", async () => {
    renderAt("/admin/audit", makeAdminClient());
    const search = await screen.findByRole("textbox", { name: "搜索" });
    const action = screen.getByRole("combobox", { name: "动作" });
    const source = screen.getByRole("combobox", { name: "来源" });
    const from = screen.getByLabelText("起始日期");
    const to = screen.getByLabelText("结束日期");

    const h = heightClass(search);
    expect(h, "搜索框应带明确的高度 class").toBeTruthy();
    for (const control of [action, source, from, to]) {
      expect(heightClass(control)).toBe(h);
    }
    expect(search.className).toContain("rounded-full");
    expect(action.tagName).not.toBe("SELECT");
    expect(source.tagName).not.toBe("SELECT");
    expect(document.querySelector(VISIBLE_NATIVE_SELECT)).toBeNull();
  });

  it("用户页的搜索框与状态下拉高度相同", async () => {
    renderAt("/admin/users", makeAdminClient());
    const search = await screen.findByRole("textbox", { name: "搜索" });
    const status = screen.getByRole("combobox", { name: /状态/ });
    expect(heightClass(status)).toBe(heightClass(search));
  });
});

describe("用户详情页的成员资格列使用 Select 原语", () => {
  it("每列的角色与加入项目的项目、角色选择皆为 combobox", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    renderAt("/admin/users/m1", makeAdminClient());

    await screen.findByRole("heading", { level: 1, name: "Member" });
    await user.click(screen.getByRole("tab", { name: /^成员资格/ }));
    const panel = screen.getByRole("tabpanel");

    expect(within(panel).getByRole("combobox", { name: "demo 的角色" })).toBeTruthy();
    expect(within(panel).getByRole("combobox", { name: "要加入的项目" })).toBeTruthy();
    expect(within(panel).getByRole("combobox", { name: "加入时的角色" })).toBeTruthy();
    expect(document.querySelector(VISIBLE_NATIVE_SELECT)).toBeNull();
  });
});

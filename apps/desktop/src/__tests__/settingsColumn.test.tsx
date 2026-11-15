// 设置模式的两种分类栏（desktop-settings-mode design D2；spec「侧栏导览结构」）。
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider } from "@specseal/ui";

import { SettingsColumn } from "../components/SettingsColumn";
import { ProjectSettingsColumn } from "../components/ProjectSettingsColumn";
import { APP_MESSAGES } from "../i18n/messages";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
    {children}
  </I18nProvider>
);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: zhWrapper });
const enWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="en" messages={APP_MESSAGES}>
    {children}
  </I18nProvider>
);

const navItems = (nav: HTMLElement) =>
  within(nav)
    .getAllByRole("button")
    .map((b) => b.textContent);

describe("SettingsColumn", () => {
  it("「应用进程」群组四项＋「关于」群组一项依序渲染，所在分类为作用中，点击回呼分类", () => {
    const onSelect = vi.fn();
    render(<SettingsColumn section="updates" onSelect={onSelect} />);
    const nav = screen.getByRole("navigation", { name: "设置分类" });
    expect(within(nav).getByText("应用进程")).toBeTruthy();
    expect(navItems(nav)).toEqual(["一般", "更新", "CLI", "服务器", "关于 Specseal"]);
    expect(within(nav).getByRole("button", { name: "更新" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(within(nav).getByRole("button", { name: "服务器" }));
    expect(onSelect).toHaveBeenCalledWith("servers");
  });

  it("「关于」群组在「应用进程」之后、唯一一项「关于 Specseal」；作用中与点击回呼", () => {
    const onSelect = vi.fn();
    const { rerender } = render(<SettingsColumn section="general" onSelect={onSelect} />);
    const nav = screen.getByRole("navigation", { name: "设置分类" });
    const headers = [within(nav).getByText("应用进程"), within(nav).getByText("关于")];
    expect(headers[0].compareDocumentPosition(headers[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const about = within(nav).getByRole("button", { name: "关于 Specseal" });
    expect(headers[1].compareDocumentPosition(about) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(about);
    expect(onSelect).toHaveBeenCalledWith("about");
    rerender(<SettingsColumn section="about" onSelect={onSelect} />);
    expect(within(nav).getByRole("button", { name: "关于 Specseal" }).getAttribute("aria-current")).toBe("page");
  });

  it("搜索只命中关于页时只剩「关于」群组；群组无命中时连标题一起隐藏", () => {
    render(<SettingsColumn section="general" onSelect={() => {}} />);
    const nav = screen.getByRole("navigation", { name: "设置分类" });
    fireEvent.change(within(nav).getByPlaceholderText("搜索设置"), { target: { value: "第三方" } });
    expect(navItems(nav)).toEqual(["关于 Specseal"]);
    expect(within(nav).queryByText("应用进程")).toBeNull();
    // 成为第一组时不带群组间的上方间距。
    expect(within(nav).getByText("关于").closest(".pb-1")?.classList.contains("pt-3")).toBe(false);
  });

  it("检查更新与更新日志只命中更新页（关于页不设这两列）", () => {
    render(<SettingsColumn section="general" onSelect={() => {}} />);
    const nav = screen.getByRole("navigation", { name: "设置分类" });
    const search = within(nav).getByPlaceholderText("搜索设置");
    for (const query of ["检查更新", "更新日志"]) {
      fireEvent.change(search, { target: { value: query } });
      expect(navItems(nav), query).toEqual(["更新"]);
    }
  });

  it("搜索「外观」只剩一般且「关于」群组标题隐藏；无命中显示提示；清空后五项还原", () => {
    render(<SettingsColumn section="general" onSelect={() => {}} />);
    const nav = screen.getByRole("navigation", { name: "设置分类" });
    const search = within(nav).getByPlaceholderText("搜索设置");
    fireEvent.change(search, { target: { value: "外观" } });
    expect(navItems(nav)).toEqual(["一般"]);
    expect(within(nav).queryByText("关于")).toBeNull();
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(within(nav).queryAllByRole("button")).toHaveLength(0);
    expect(within(nav).getByText("没有符合的设置")).toBeTruthy();
    fireEvent.change(search, { target: { value: "" } });
    expect(navItems(nav)).toHaveLength(5);
  });

  it("比对大小写不敏感（分类名与列标签）", () => {
    render(<SettingsColumn section="general" onSelect={() => {}} />);
    const nav = screen.getByRole("navigation", { name: "设置分类" });
    fireEvent.change(within(nav).getByPlaceholderText("搜索设置"), { target: { value: "cli" } });
    // CLI 页本身；Specseal 不再含 "cli" 字样（上游 Speclink 有），「关于」页不再命中。
    expect(navItems(nav)).toEqual(["CLI"]);
  });
});

describe("ProjectSettingsColumn", () => {
  // spec「设置页图形化读写两层设置」：组名与分类名一律用概念名，与应用进程设置的分类栏相同。
  it("local：「工作流程」组（品质关卡下有两个子项）与「项目」组 AI 工具，分类栏内不出现设置档文档名", () => {
    const onSelect = vi.fn();
    render(<ProjectSettingsColumn section="context" remote={false} configParseError={false} specsealParseError={false} onSelect={onSelect} />);
    const nav = screen.getByRole("navigation", { name: "项目设置分类" });
    const headers = [within(nav).getByText("工作流程"), within(nav).getByText("项目")];
    expect(headers[0].compareDocumentPosition(headers[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(navItems(nav)).toEqual(["项目说明", "产出规则", "品质关卡", "审查规则", "子代理模型", "产出流程", "AI 工具"]);
    expect(nav.textContent).not.toContain("config.yaml");
    expect(nav.textContent).not.toContain(".specseal.yaml");
    expect(within(nav).getByRole("button", { name: "项目说明" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(within(nav).getByRole("button", { name: "AI 工具" }));
    expect(onSelect).toHaveBeenCalledWith("specseal");
  });

  it("英文接口：组名为 Spec workflow、Project，最后一项为 AI tools", () => {
    rtlRender(
      <ProjectSettingsColumn section="context" remote={false} configParseError={false} specsealParseError={false} onSelect={() => {}} />,
      { wrapper: enWrapper },
    );
    const nav = screen.getByRole("navigation", { name: "Project settings categories" });
    expect(within(nav).getByText("Spec workflow")).toBeTruthy();
    const group = within(nav).getByRole("group", { name: "Quality gates" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Quality gates", "Review rules", "Sub-agent models"]);
    expect(within(nav).getByText("Project")).toBeTruthy();
    expect(navItems(nav).slice(-1)).toEqual(["AI tools"]);
  });

  it("remote：只有「工作流程」组，两个子项仍在，无「项目」组与 AI 工具", () => {
    render(<ProjectSettingsColumn section="context" remote configParseError={false} specsealParseError={false} onSelect={() => {}} />);
    const nav = screen.getByRole("navigation", { name: "项目设置分类" });
    expect(navItems(nav)).toEqual(["项目说明", "产出规则", "品质关卡", "审查规则", "子代理模型", "产出流程"]);
    expect(within(nav).getByText("工作流程")).toBeTruthy();
    expect(within(nav).queryByText("项目")).toBeNull();
  });

  it("config.yaml 解析失败时两个子项与其他 config 分类项带警示点、品质关卡不带；.specseal.yaml 解析失败时 AI 工具带警示点", () => {
    const { rerender } = render(
      <ProjectSettingsColumn section="context" remote={false} configParseError specsealParseError={false} onSelect={() => {}} />,
    );
    const warned = () =>
      screen.getAllByTestId("tab-warning").map((dot) => dot.closest("button")?.getAttribute("aria-label") ?? dot.closest("button")?.textContent);
    expect(warned()).toEqual(["项目说明", "产出规则", "审查规则", "子代理模型", "产出流程"]);
    rerender(
      <ProjectSettingsColumn section="context" remote={false} configParseError={false} specsealParseError onSelect={() => {}} />,
    );
    expect(warned()).toEqual(["AI 工具"]);
  });

  // desktop-subagent-model-page design「分类栏渲染两层与警示点」。
  it("上层分类「品质关卡」带图标、点击开审查规则页且自身不带选中；两个子项无图标、与它包在同一个群组", () => {
    const onSelect = vi.fn();
    const { rerender } = render(<ProjectSettingsColumn section="review" remote={false} configParseError={false} specsealParseError={false} onSelect={onSelect} />);
    const nav = screen.getByRole("navigation", { name: "项目设置分类" });
    const group = within(nav).getByRole("group", { name: "品质关卡" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["品质关卡", "审查规则", "子代理模型"]);
    const parent = within(group).getByRole("button", { name: "品质关卡" });
    expect(parent.querySelector("svg")).not.toBeNull();
    expect(parent.getAttribute("aria-current")).toBeNull();
    for (const name of ["审查规则", "子代理模型"]) {
      expect(within(group).getByRole("button", { name }).querySelector("svg")).toBeNull();
    }
    expect(within(group).getByRole("button", { name: "审查规则" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(parent);
    expect(onSelect).toHaveBeenLastCalledWith("review");
    fireEvent.click(within(group).getByRole("button", { name: "子代理模型" }));
    expect(onSelect).toHaveBeenLastCalledWith("subagent");
    rerender(<ProjectSettingsColumn section="subagent" remote={false} configParseError={false} specsealParseError={false} onSelect={onSelect} />);
    expect(within(group).getByRole("button", { name: "子代理模型" }).getAttribute("aria-current")).toBe("page");
    expect(within(group).getByRole("button", { name: "审查规则" }).getAttribute("aria-current")).toBeNull();
    expect(parent.getAttribute("aria-current")).toBeNull();
  });

  it("底部 notice 槽渲染提示卡", () => {
    render(
      <ProjectSettingsColumn
        section="context"
        remote={false}
        configParseError={false}
        specsealParseError={false}
        onSelect={() => {}}
        notice={<div>技能档是旧版</div>}
      />,
    );
    expect(screen.getByText("技能档是旧版")).toBeTruthy();
  });
});

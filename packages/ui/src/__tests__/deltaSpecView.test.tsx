// spec「规格分页 delta 区段以色标呈现」（desktop-change-doc-views design D6）。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";
import { CapabilityHeader, DeltaSpecView } from "../components/DeltaBadges";

const wrapper = ({ children }: { children: ReactNode }) => <I18nProvider locale="zh-CN">{children}</I18nProvider>;
const render = (ui: ReactElement) => rtlRender(ui, { wrapper });

const scenario = (title: string) => [`#### Scenario: ${title}`, "", `- **WHEN** ${title} 的动作`, `- **THEN** ${title} 的结果`, ""];

const DELTA_MD = [
  "## ADDED Requirements",
  "",
  "### Requirement: 新需求",
  "",
  "系统 SHALL 添加。",
  "",
  ...scenario("添加情境"),
  "## MODIFIED Requirements",
  "",
  "### Requirement: 面板样式（macOS）",
  "",
  "<!-- BEFORE: 旧说明。 -->",
  "",
  "第一段需求文。",
  "",
  "第二段需求文。",
  "",
  "第三段需求文。",
  "",
  "第四段需求文。",
  "",
  "第五段需求文。",
  "",
  ...["甲", "乙", "丙", "丁", "戊"].flatMap(scenario),
  "<!-- REMOVED-SCENARIO: ready workspace 的区块顺序与分割线 -->",
  "<!-- REMOVED-SCENARIO: 进度条依阶段深浅 -->",
  "",
  "### Requirement: 第二条修改",
  "",
  "第二条需求文。",
  "",
  ...scenario("二之一"),
  "### Requirement: 第三条修改",
  "",
  "第三条需求文。",
  "",
  ...scenario("三之一"),
].join("\n");

const requirement = (container: HTMLElement, title: string) =>
  Array.from(container.querySelectorAll("[data-requirement]")).find((r) => r.querySelector("h3")!.textContent === title)!;

describe("DeltaSpecView", () => {
  it("色标标头取代机器标题；每段第一条需求展开并带操作色条，其余收合但标题留在本页目录", () => {
    const { container } = render(<DeltaSpecView markdown={DELTA_MD} />);
    expect(Array.from(container.querySelectorAll("[data-delta-section]")).map((h) => h.textContent)).toEqual(["+添加", "~修改"]);
    expect(screen.queryByText(/MODIFIED Requirements/)).toBeNull();
    const first = requirement(container, "面板样式（macOS）");
    expect(first.className).toContain("border-status-warning");
    expect(first.querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
    for (const title of ["第二条修改", "第三条修改"]) {
      const row = requirement(container, title);
      expect(row.querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
      expect(row.textContent).toContain("1 个 scenario");
    }
    expect(screen.queryByText("第二条需求文。")).toBeNull();
    const headings = Array.from(container.querySelectorAll("[data-doc-heading]")).map((h) => h.textContent);
    expect(headings).toEqual(expect.arrayContaining(["新需求", "面板样式（macOS）", "第二条修改", "第三条修改"]));
    expect(requirement(container, "新需求").className).toContain("border-status-success");
  });

  it("收合列看得出可点：共用光标变量、滑过有淡底", () => {
    const { container } = render(<DeltaSpecView markdown={DELTA_MD} />);
    const toggle = requirement(container, "第二条修改").querySelector("button[aria-expanded]")!;
    expect(toggle.className).toContain("cursor-(--cursor-interaction)");
    expect(toggle.className).toContain("hover:bg-foreground/5");
  });

  it("REMOVED-SCENARIO 声明成 caution 提示框，列出删除线名称；注解原文不直出", () => {
    const { container } = render(<DeltaSpecView markdown={DELTA_MD} />);
    const box = container.querySelector("[data-removed-scenarios]")!;
    expect(box.textContent).toContain("本变更移除 2 个 scenario");
    expect(Array.from(box.querySelectorAll("del")).map((d) => d.textContent)).toEqual([
      "ready workspace 的区块顺序与分割线",
      "进度条依阶段深浅",
    ]);
    expect(container.textContent).not.toContain("REMOVED-SCENARIO");
    expect(container.textContent).not.toContain("旧说明");
    // 收合时列上带移除签。
    fireEvent.click(requirement(container, "面板样式（macOS）").querySelector("button")!);
    expect(requirement(container, "面板样式（macOS）").textContent).toContain("移除 2 个 scenario");
  });

  it("需求文超过三段只展开前三段，Scenario 超过三个只展开前三个；点钮后全部出现", () => {
    render(<DeltaSpecView markdown={DELTA_MD} />);
    expect(screen.getByText("第三段需求文。")).toBeTruthy();
    expect(screen.queryByText("第四段需求文。")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开其余 2 段需求文" }));
    expect(screen.getByText("第五段需求文。")).toBeTruthy();
    expect(screen.getByText(/丙 的结果/)).toBeTruthy();
    expect(screen.queryByText(/丁 的动作/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "还有 2 个 scenario" }));
    expect(screen.getByText(/戊 的结果/)).toBeTruthy();
  });

  it("Scenario 的 WHEN／THEN 成标签栏与内容栏两栏", () => {
    const { container } = render(<DeltaSpecView markdown={DELTA_MD} />);
    const steps = container.querySelector("[data-scenario-steps]")!;
    expect(steps.className).toContain("grid-cols-");
    expect(Array.from(steps.querySelectorAll("span")).map((s) => s.textContent)).toEqual(["WHEN", "THEN"]);
  });

  it("REMOVED 区段照 prose 排", () => {
    const md = "## REMOVED Requirements\n\n### Requirement: 旧需求\n\n**Reason**: 不再需要\n";
    const { container } = render(<DeltaSpecView markdown={md} />);
    expect(container.querySelector("[data-requirement]")).toBeNull();
    expect(screen.getByText(/不再需要/)).toBeTruthy();
  });

  it("无 delta 标题的文档整篇照常渲染", () => {
    const { container } = render(<DeltaSpecView markdown={"# 普通规格\n\n内文。\n"} />);
    expect(container.querySelector("[data-delta-section]")).toBeNull();
    expect(screen.getByText("内文。")).toBeTruthy();
  });
});

describe("CapabilityHeader", () => {
  it("等宽能力名＋计数徽章；有回呼时「看正式规格」开该能力的规格", () => {
    const onOpenSpec = vi.fn();
    const { container } = render(
      <CapabilityHeader cap="desktop-app" counts={{ added: 0, modified: 3, removed: 0, renamed: 0 }} onOpenSpec={onOpenSpec} />,
    );
    const header = container.querySelector("[data-capability-header]")!;
    expect(header.querySelector("[data-doc-heading]")!.textContent).toBe("desktop-app");
    expect(header.textContent).toContain("~3");
    fireEvent.click(screen.getByRole("button", { name: "看正式规格" }));
    expect(onOpenSpec).toHaveBeenCalledWith("desktop-app");
  });

  it("没有回呼时不渲染「看正式规格」", () => {
    render(<CapabilityHeader cap="desktop-app" counts={{ added: 1, modified: 0, removed: 0, renamed: 0 }} />);
    expect(screen.queryByRole("button", { name: "看正式规格" })).toBeNull();
  });
});

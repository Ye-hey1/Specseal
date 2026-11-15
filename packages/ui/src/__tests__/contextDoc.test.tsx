// spec「讨论详情页查看与转出变更」背景段的渲染器（desktop-discussion-doc-views design D4）。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";
import { ContextDoc, type ContextDocProps } from "../components/ContextDoc";
import { TooltipProvider } from "../components/ui/tooltip";
import { contextModel, type ContextNames } from "../discussionModel";

const wrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">
    <TooltipProvider>{children}</TooltipProvider>
  </I18nProvider>
);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper });

// spec Scenario「背景文档的引言、关联与记录列」。
const CONTEXT = [
  "用户要重做卡片，侦察命中 desktop-app 与 tray-status-menu。",
  "",
  "在途变更 add-copilot-tool 也碰到；已封存的 tray-panel-card-design 是前例。",
  "",
  "Related specs: desktop-app（79 条）、tray-status-menu",
  "Prior discussions: card-drawer-header-colors, admin-console-redesign",
  "Source doc: none",
].join("\n");

const NAMES: ContextNames = {
  specs: ["desktop-app", "tray-status-menu", "server-api"],
  active: ["add-copilot-tool"],
  archived: ["tray-panel-card-design"],
  discussions: ["card-redesign", "card-drawer-header-colors", "admin-console-redesign"],
  self: "card-redesign",
};

function props({ text = CONTEXT, ...over }: Partial<ContextDocProps> & { text?: string } = {}): ContextDocProps {
  return {
    model: contextModel(text, NAMES),
    created: "2026-10-08",
    createdBy: "MomoChen <momo@example.com>",
    kind: null,
    recordPath: "openspec/discussions/card-redesign.md",
    onOpenSpec: vi.fn(),
    onOpenChange: vi.fn(),
    onOpenArchivedChange: vi.fn(),
    onOpenDiscussion: vi.fn(),
    ...over,
  };
}

const section = (container: HTMLElement, key: string) =>
  container.querySelector(`[data-section="${key}"]`) as HTMLElement | null;
const rowValues = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-context-row]")).map((row) => [
    row.getAttribute("data-context-row"),
    row.querySelector("dd")!.textContent,
  ]);

describe("ContextDoc", () => {
  it("引言为灰底段、内文四颗名称签、收尾四行不在内文；关联五列、记录三列；点签分派到对应回呼", () => {
    const p = props();
    const { container } = render(<ContextDoc {...p} />);
    const intro = section(container, "context.intro")!;
    expect(intro.querySelector("[data-context-lead]")!.textContent).toBe(
      "用户要重做卡片，侦察命中 desktop-app 与 tray-status-menu。",
    );
    expect(Array.from(intro.querySelectorAll("[data-name-chip]")).map((c) => c.getAttribute("data-name-chip"))).toEqual([
      "spec:desktop-app",
      "spec:tray-status-menu",
      "change:add-copilot-tool",
      "archived:tray-panel-card-design",
    ]);
    for (const line of ["Related specs:", "Prior discussions:", "Source doc:"]) expect(intro.textContent).not.toContain(line);

    expect(rowValues(section(container, "context.relations")!)).toEqual([
      ["specs", "desktop-apptray-status-menu"],
      ["changes", "add-copilot-tool"],
      ["archived", "tray-panel-card-design"],
      ["prior", "card-drawer-header-colorsadmin-console-redesign"],
      ["source", "无"],
    ]);
    expect(rowValues(section(container, "context.record")!)).toEqual([
      ["created", "2026-10-08 · MomoChen"],
      ["kind", "一般讨论"],
      ["file", "openspec/discussions/card-redesign.md"],
    ]);
    expect(section(container, "context.record")!.querySelector('[data-context-row="file"] button')).toBeTruthy();

    fireEvent.click(intro.querySelector('[data-name-chip="spec:desktop-app"]')!);
    expect(p.onOpenSpec).toHaveBeenCalledWith("desktop-app");
    fireEvent.click(intro.querySelector('[data-name-chip="change:add-copilot-tool"]')!);
    expect(p.onOpenChange).toHaveBeenCalledWith("add-copilot-tool");
    fireEvent.click(intro.querySelector('[data-name-chip="archived:tray-panel-card-design"]')!);
    expect(p.onOpenArchivedChange).toHaveBeenCalledWith("tray-panel-card-design");
    // 关联列的签同样可点。
    fireEvent.click(section(container, "context.relations")!.querySelector('[data-context-row="prior"] button')!);
    expect(p.onOpenDiscussion).toHaveBeenCalledWith("card-drawer-header-colors");
    expect(Array.from(container.querySelectorAll("h2[data-doc-heading]")).map((h) => h.textContent)).toEqual([
      "起因与范围",
      "关联",
      "记录",
    ]);
  });

  it("Enter／空白键只在名称签上拦下并打开；内文链接上的按键照浏览器缺省", () => {
    const p = props({ text: "提到 desktop-app，详见 [说明](https://example.com/doc)。" });
    const { container } = render(<ContextDoc {...p} />);
    const intro = section(container, "context.intro")!;
    const link = intro.querySelector("a")!;
    expect(fireEvent.keyDown(link, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(link, { key: " " })).toBe(true);
    expect(p.onOpenSpec).not.toHaveBeenCalled();
    const chip = intro.querySelector('[data-name-chip="spec:desktop-app"]')!;
    expect(fireEvent.keyDown(chip, { key: "Enter" })).toBe(false);
    expect(p.onOpenSpec).toHaveBeenCalledWith("desktop-app");
  });

  it("无收尾行且零命中时无关联段、无签", () => {
    const { container } = render(<ContextDoc {...props({ text: "第一段散文。\n\n第二段散文。" })} />);
    expect(section(container, "context.relations")).toBeNull();
    expect(container.querySelector("[data-name-chip]")).toBeNull();
    expect(section(container, "context.intro")).toBeTruthy();
    expect(section(container, "context.record")).toBeTruthy();
  });

  it("kind improve 时种类为改进讨论；无 recordPath 时无文档列；没有回呼的种类不成签", () => {
    const { container } = render(
      <ContextDoc {...props({ kind: "improve", recordPath: null, onOpenArchivedChange: undefined })} />,
    );
    expect(rowValues(section(container, "context.record")!)).toEqual([
      ["created", "2026-10-08 · MomoChen"],
      ["kind", "改进讨论"],
    ]);
    expect(container.querySelector('[data-name-chip^="archived:"]')).toBeNull();
    expect(container.querySelector('[data-name-chip="spec:desktop-app"]')).toBeTruthy();
  });

  it("空内文显示空态文案", () => {
    const { container } = render(<ContextDoc {...props({ text: "\n\n" })} empty="（无背景）" />);
    expect(container.textContent).toBe("（无背景）");
    expect(container.querySelector("[data-section]")).toBeNull();
  });
});

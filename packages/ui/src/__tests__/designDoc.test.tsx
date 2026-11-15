// spec「提案与设计章节以中文标签呈现」设计侧（desktop-change-doc-views design D4）。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";
import { DesignDoc } from "../components/DesignDoc";

const wrapper = ({ children }: { children: ReactNode }) => <I18nProvider locale="zh-CN">{children}</I18nProvider>;
const render = (ui: ReactElement) => rtlRender(ui, { wrapper });

const DECISION_TITLES = ["面板底与卡片层", "卡片间距", "标题列", "状态色", "卷动", "深色模式"];

const DESIGN_MD = [
  "## Context",
  "",
  "- 现况一",
  "- 现况二",
  "",
  "## Goals / Non-Goals",
  "",
  "**Goals:**",
  "",
  ...["一", "二", "三", "四", "五"].map((n) => `- 目标${n}`),
  "",
  "**Non-Goals:**",
  "",
  ...["一", "二", "三"].map((n) => `- 非目标${n}`),
  "",
  "## Decisions",
  "",
  ...DECISION_TITLES.flatMap((title, i) => [`### D${i + 1} ${title}`, "", `- 决策 ${i + 1} 的第一点`, `- 决策 ${i + 1} 的第二点`, ""]),
  "## Implementation Contract",
  "",
  "- **Behavior**：开页看到卡",
  "- **Failure modes**：降级",
  "",
  "## Risks / Trade-offs",
  "",
  "- [风险一] → 对策一",
  "- [风险二] → 对策二",
  "- [风险三] → 对策三",
  "- 只有风险",
  "",
  "## Open Questions",
  "",
  "无。",
].join("\n");

const decisionCard = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-decision="${id}"]`)!.querySelector("button[aria-expanded]")!;

describe("DesignDoc", () => {
  it("决策段每个三级标题一张卡：缺省收合、D 签与列点数，标题留在本页目录", () => {
    const { container } = render(<DesignDoc content={DESIGN_MD} jump={null} onJumped={() => {}} />);
    const cards = container.querySelectorAll("[data-decision]");
    expect(cards).toHaveLength(6);
    for (const card of Array.from(cards)) {
      expect(card.querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
    }
    const tocTitles = Array.from(container.querySelectorAll("[data-doc-heading]")).map((h) => h.textContent);
    for (const title of DECISION_TITLES) expect(tocTitles).toContain(title);
    const head = decisionCard(container, "D1");
    expect(head.textContent).toContain("D1");
    expect(head.textContent).toContain("2 点");
    expect(screen.queryByText("决策 1 的第一点")).toBeNull();
    expect(head.className).toContain("cursor-(--cursor-interaction)");
    expect(head.className).toContain("hover:bg-foreground/5");
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("决策 1 的第一点")).toBeTruthy();
  });

  it("jump 命中的决策卡展开并回报完成", () => {
    const onJumped = vi.fn();
    const { container } = render(<DesignDoc content={DESIGN_MD} jump={{ id: "D3", seq: 1 }} onJumped={onJumped} />);
    expect(decisionCard(container, "D3").getAttribute("aria-expanded")).toBe("true");
    expect(decisionCard(container, "D1").getAttribute("aria-expanded")).toBe("false");
    expect(onJumped).toHaveBeenCalledTimes(1);
  });

  it("jump 没命中只回报完成", () => {
    const onJumped = vi.fn();
    const { container } = render(<DesignDoc content={DESIGN_MD} jump={{ id: "D9", seq: 1 }} onJumped={onJumped} />);
    expect(onJumped).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('[data-decision] button[aria-expanded="true"]')).toHaveLength(0);
  });

  it("风险与取舍逐条成 warning 提示框（「→」切标题与内文）", () => {
    const { container } = render(<DesignDoc content={DESIGN_MD} jump={null} onJumped={() => {}} />);
    const risks = container.querySelectorAll("[data-risk]");
    expect(risks).toHaveLength(4);
    expect(risks[0].className).toContain("border-l-4");
    expect(risks[0].textContent).toBe("风险一对策一");
    expect(risks[3].textContent).toBe("只有风险");
  });

  it("风险标题与决策标题的行内代码成等宽签、粗体不直出星号；风险的嵌套子项接在内文", () => {
    const md = [
      "## Decisions",
      "",
      "### D7 `RequirementBlock` 共用",
      "",
      "- 点",
      "",
      "## Risks / Trade-offs",
      "",
      "- [`parseSpecSections` 认 **二级标题** 为终点] → 先切 op 区段",
      "  - 子项说明",
    ].join("\n");
    const { container } = render(<DesignDoc content={md} jump={null} onJumped={() => {}} />);
    const h3 = container.querySelector("[data-decision] h3")!;
    expect(h3.querySelector("code")!.textContent).toBe("RequirementBlock");
    expect(h3.textContent).not.toContain("`");
    const risk = container.querySelector("[data-risk]")!;
    const title = risk.firstElementChild!;
    expect(title.querySelector("code")!.textContent).toBe("parseSpecSections");
    expect(title.querySelector("strong")!.textContent).toBe("二级标题");
    expect(title.textContent).toBe("parseSpecSections 认 二级标题 为终点");
    expect(risk.textContent).toContain("先切 op 区段");
    expect(risk.textContent).toContain("子项说明");
  });

  it("契约列的值为空时不画「无内容」占位", () => {
    const { container } = render(
      <DesignDoc content={"## Implementation Contract\n\n- **Behavior**：\n- **Failure modes**：降级\n"} jump={null} onJumped={() => {}} />,
    );
    expect(Array.from(container.querySelectorAll("dt")).map((d) => d.textContent)).toEqual(["Behavior", "Failure modes"]);
    expect(container.textContent).not.toContain("（无内容）");
  });

  it("目标与非目标两栏各自列点数，背景为细线列、契约为键值列", () => {
    const { container } = render(<DesignDoc content={DESIGN_MD} jump={null} onJumped={() => {}} />);
    const cols = container.querySelectorAll("[data-goals-column]");
    expect(Array.from(cols).map((c) => c.firstElementChild!.textContent)).toEqual(["目标 5", "非目标 3"]);
    expect(cols[0].querySelectorAll("li")).toHaveLength(5);
    expect(cols[1].querySelectorAll("li")).toHaveLength(3);
    expect(container.querySelectorAll('[data-section="sections.context"] [data-row-list] li')).toHaveLength(2);
    expect(Array.from(container.querySelectorAll('[data-section="sections.contract"] dt')).map((d) => d.textContent)).toEqual([
      "Behavior",
      "Failure modes",
    ]);
  });

  it("切不到 Goals／Non-Goals 标签时照 Markdown", () => {
    const { container } = render(<DesignDoc content={"## Goals / Non-Goals\n\n- 只写列点\n"} jump={null} onJumped={() => {}} />);
    expect(container.querySelector("[data-goals-column]")).toBeNull();
    expect(screen.getByText("只写列点")).toBeTruthy();
  });
});

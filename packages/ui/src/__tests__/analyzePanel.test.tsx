// spec 需求「桌面 app 提供动词操作面」的分析面板（design D1 两层结构）：
// 结构验证列＋繁中维度摘要卡（零＝无问题、非零＝N 个问题）＋发现卡
// （严重度、location、summary、recommendation 对应 --json 输出）。
import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, within, fireEvent } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";
import { AnalyzePanel } from "../components/AnalyzePanel";
import type { AnalyzeReport } from "../adapter";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

const report: AnalyzeReport = {
  change_id: "x",
  dimensions: [
    { dimension: "Coverage", status: "1 issue(s) found", finding_count: 1 },
    { dimension: "Consistency", status: "Clean", finding_count: 0 },
    { dimension: "Ambiguity", status: "18 issue(s) found", finding_count: 18 },
    { dimension: "Gaps", status: "Clean", finding_count: 0 },
  ],
  findings: [
    {
      id: "COV-1",
      dimension: "Coverage",
      severity: "Critical",
      location: "tasks.md",
      summary: "Requirement 'bar' not covered by tasks",
      recommendation: "add a task",
    },
    {
      id: "AMB-1",
      dimension: "Ambiguity",
      severity: "Suggestion",
      location: "specs/desktop-app/spec.md",
      summary: "Scenario 'foo' has no concrete examples",
      recommendation: "add example",
    },
    {
      id: "AMB-2",
      dimension: "Ambiguity",
      severity: "Warning",
      location: "specs/desktop-app/spec.md",
      summary: "Scenario 'bar' mixes two behaviors",
      recommendation: "split the scenario",
    },
  ],
  artifacts_analyzed: ["proposal", "specs", "tasks"],
  artifacts_missing: [],
};

const ok = { valid: true, errors: [] };
const dim = (name: string) => document.querySelector(`[data-dimension="${name}"]`) as HTMLElement;

describe("AnalyzePanel（结构验证列＋维度摘要卡＋发现卡）", () => {
  it("维度摘要卡以繁中名呈现；零发现呈「无问题」、非零呈「N 个问题」", () => {
    render(<AnalyzePanel report={report} validate={ok} />);
    expect(within(dim("Coverage")).getByText("覆盖度")).toBeTruthy();
    expect(within(dim("Consistency")).getByText("一致性")).toBeTruthy();
    expect(within(dim("Ambiguity")).getByText("模糊度")).toBeTruthy();
    expect(within(dim("Gaps")).getByText("缺漏")).toBeTruthy();
    expect(within(dim("Ambiguity")).getByText("18 个问题")).toBeTruthy();
    expect(within(dim("Coverage")).getByText("1 个问题")).toBeTruthy();
    expect(within(dim("Consistency")).getByText("无问题")).toBeTruthy();
    expect(within(dim("Gaps")).getByText("无问题")).toBeTruthy();
  });

  it("Warning 严重度徽章为琥珀警示，与同维度摘要同语意同色（不借主色表状态）", () => {
    // spec「接口状态语意色分层」：警示＝琥珀。徽章与 Ambiguity 维度摘要讲同一件事，
    // 两处必须同色——旧实作徽章走主色、摘要走琥珀，同页自相矛盾。
    render(<AnalyzePanel report={report} validate={ok} />);
    const warn = document.querySelector('[data-finding="AMB-2"]') as HTMLElement;
    const badge = within(warn).getByText("Warning");
    expect(badge.className).toContain("status-warning");
    expect(badge.className).not.toContain("primary");
    expect(within(dim("Ambiguity")).getByText("18 个问题").className).toContain("status-warning");
  });

  it("验证通过列与零问题维度为中性，不以主色表达状态", () => {
    // 主色保留给链接／交互／进度；「没问题」是静态结果，走中性。
    render(<AnalyzePanel report={report} validate={ok} />);
    const row = document.querySelector("[data-validate-row]") as HTMLElement;
    expect(row.className).toContain("text-muted-foreground");
    expect(row.className).not.toContain("text-primary");
    const zero = within(dim("Consistency")).getByText("无问题");
    expect(zero.className).toContain("text-muted-foreground");
    expect(zero.className).not.toContain("text-primary");
  });

  it("发现卡呈现严重度徽章、来源档、摘要与建议行", () => {
    render(<AnalyzePanel report={report} validate={ok} />);
    const cards = document.querySelectorAll("[data-finding]");
    expect(cards.length).toBe(3);
    const first = cards[0] as HTMLElement;
    expect(within(first).getByText("Critical")).toBeTruthy();
    expect(within(first).getByText("tasks.md")).toBeTruthy();
    expect(within(first).getByText(/not covered by tasks/)).toBeTruthy();
    expect(within(first).getByText(/add a task/)).toBeTruthy();
  });

  it("结构验证通过呈单列通过标示", () => {
    render(<AnalyzePanel report={report} validate={ok} />);
    expect(screen.getByText("结构验证通过")).toBeTruthy();
  });

  it("结构验证失败呈错误数并逐条列出错误", () => {
    render(
      <AnalyzePanel
        report={report}
        validate={{ valid: false, errors: ["proposal.md 缺 Why", "tasks.md 无任务"] }}
      />,
    );
    expect(screen.getByText(/结构验证 2 个错误/)).toBeTruthy();
    expect(screen.getByText(/proposal\.md 缺 Why/)).toBeTruthy();
    expect(screen.getByText(/tasks\.md 无任务/)).toBeTruthy();
  });

  it("关闭钮触发 onClose", () => {
    const onClose = vi.fn();
    render(<AnalyzePanel report={report} validate={ok} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "关闭分析结果" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("IPC 边界防御：findings 与 dimensions 缺席时不崩溃、四卡仍呈现", () => {
    const malformed = { change_id: "x" } as unknown as AnalyzeReport;
    render(<AnalyzePanel report={malformed} validate={ok} />);
    for (const d of ["Coverage", "Consistency", "Ambiguity", "Gaps"]) {
      expect(dim(d)).toBeTruthy();
    }
    expect(within(dim("Coverage")).getByText("无问题")).toBeTruthy();
  });
});

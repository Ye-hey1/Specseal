// 状态签原语（design D5）：圆角全圆、语意色淡底深字。章签、讨论状态签与衍生
// 变更阶段签共用；色只走 theme token，不写原生色阶。
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { StatusPill, type StatusPillTone } from "../components/ui/status-pill";
import { REVIEW_PILL_TONE } from "../components/reviewStyle";
import { VERIFY_PILL_TONE } from "../components/verifyStyle";

afterEach(cleanup);

const TONE_CLASSES: [StatusPillTone, string[]][] = [
  ["neutral", ["bg-muted", "text-muted-foreground"]],
  ["primary", ["bg-primary/12", "text-primary"]],
  ["progress", ["bg-status-progress/12", "text-status-progress"]],
  ["success", ["bg-status-success/12", "text-status-success"]],
  ["warning", ["bg-status-warning/12", "text-status-warning"]],
  ["destructive", ["bg-destructive/12", "text-destructive"]],
  ["stamp", ["bg-stamp/12", "text-stamp"]],
  ["improve", ["bg-improve/12", "text-improve"]],
  ["manual", ["bg-status-manual/12", "text-status-manual"]],
];

describe("StatusPill", () => {
  it.each(TONE_CLASSES)("tone %s 渲染对应 token 淡底深字", (tone, classes) => {
    render(<StatusPill tone={tone}>签</StatusPill>);
    const pill = screen.getByText("签");
    for (const cls of classes) expect(pill.className.split(/\s+/)).toContain(cls);
    expect(pill.className).toContain("rounded-full");
    expect(pill.className).toContain("h-5");
    expect(pill.className).toContain("px-2");
    expect(pill.className).toContain("text-[11px]");
  });

  it("任何 tone 都不出现原生色阶字面", () => {
    for (const [tone] of TONE_CLASSES) {
      const { container, unmount } = render(<StatusPill tone={tone}>x</StatusPill>);
      expect(container.innerHTML).not.toMatch(/-(?:red|blue|green|amber|violet|purple|gray|slate|zinc)-\d{2,3}\b/);
      unmount();
    }
  });

  it("icon 槽渲染于文本之前", () => {
    render(
      <StatusPill tone="stamp" icon={<svg data-testid="pill-icon" />}>
        已审查
      </StatusPill>,
    );
    const pill = screen.getByText("已审查");
    const icon = screen.getByTestId("pill-icon");
    expect(pill.contains(icon)).toBe(true);
    expect(pill.firstElementChild).toBe(icon);
  });

  it("className 并入而不取代基底", () => {
    render(
      <StatusPill tone="neutral" className="line-through">
        已删除
      </StatusPill>,
    );
    const pill = screen.getByText("已删除");
    expect(pill.className).toContain("line-through");
    expect(pill.className).toContain("rounded-full");
  });
});

describe("章签 tone 对照", () => {
  it("审查四态：已审查 stamp、进行中 progress、过期 warning、未通过 destructive", () => {
    expect(REVIEW_PILL_TONE).toEqual({
      inReview: "progress",
      reviewed: "stamp",
      reviewedStale: "warning",
      reviewedNotPassed: "destructive",
    });
  });

  it("验证四态与审查同一语意", () => {
    expect(VERIFY_PILL_TONE).toEqual({
      inVerify: "progress",
      verified: "stamp",
      verifiedStale: "warning",
      verifiedNotPassed: "destructive",
    });
  });
});

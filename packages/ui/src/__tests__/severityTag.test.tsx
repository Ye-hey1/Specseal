// 严重度色章（审查／验证工单、分析面板、desktop 审查规则页共用；review-rules-config 品质关卡 R4）。
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import { SeverityTag } from "../components/SeverityTag";

const tagOf = (ui: Parameters<typeof render>[0]) => render(ui).container.firstElementChild!;

describe("SeverityTag", () => {
  it("三级同语意同色、大小写不拘；未知严重度走中性", () => {
    expect(tagOf(<SeverityTag severity="CRITICAL" />).className).toContain("text-destructive");
    expect(tagOf(<SeverityTag severity="Critical" />).className).toContain("text-destructive");
    expect(tagOf(<SeverityTag severity="Warning" />).className).toContain("status-warning");
    expect(tagOf(<SeverityTag severity="SUGGESTION" />).className).toContain("text-muted-foreground");
    expect(tagOf(<SeverityTag severity="INFO" />).className).toContain("text-muted-foreground");
  });

  it("缺省显示严重度名称；可换成自订内容并带 data 属性", () => {
    expect(tagOf(<SeverityTag severity="CRITICAL" />).textContent).toBe("CRITICAL");
    const tag = tagOf(
      <SeverityTag severity="WARNING" data-ticket-count="WARNING">
        WARNING 3
      </SeverityTag>,
    );
    expect(tag.textContent).toBe("WARNING 3");
    expect(tag.getAttribute("data-ticket-count")).toBe("WARNING");
  });
});

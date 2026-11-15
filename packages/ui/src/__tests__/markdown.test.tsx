// 共用 Markdown 的名称签插件（desktop-discussion-doc-views design D10）：`nameChips` 有值时，文本节点中与名单
// 完全相同的字词（D1 matchNames 同一条边界）换成 `span.name-chip[data-name-chip="<kind>:<name>"]`；
// 行内 code、代码区块与链接内不处理；缺席时管线与输出不变。
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";

import { I18nProvider } from "../i18n";
import { Markdown } from "../components/Markdown";

const wrapper = ({ children }: { children: ReactNode }) => <I18nProvider locale="zh-CN">{children}</I18nProvider>;

const chips = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("[data-name-chip]")).map((el) => [
    el.getAttribute("data-name-chip"),
    el.textContent,
    el.className,
  ]);

describe("Markdown 名称签", () => {
  it("内文提到 desktop-app 与 add-copilot-tool，传入两颗签后各成一个 [data-name-chip] 且文本不变", () => {
    const content = "侦察命中 desktop-app，在途变更 add-copilot-tool 也碰到 desktop-app。";
    const { container } = render(
      <Markdown
        content={content}
        nameChips={[
          { kind: "spec", name: "desktop-app" },
          { kind: "change", name: "add-copilot-tool" },
        ]}
      />,
      { wrapper },
    );
    expect(chips(container)).toEqual([
      ["spec:desktop-app", "desktop-app", "name-chip"],
      ["change:add-copilot-tool", "add-copilot-tool", "name-chip"],
      ["spec:desktop-app", "desktop-app", "name-chip"],
    ]);
    expect(container.querySelector(".markdown")!.textContent).toBe(content);
  });

  it("反引号内、代码区块内、链接内与 desktop-app-x 这类前缀不命中", () => {
    const { container } = render(
      <Markdown
        content={"`desktop-app` 与 desktop-app-x、[desktop-app](https://example.com)\n\n```\ndesktop-app\n```"}
        nameChips={[{ kind: "spec", name: "desktop-app" }]}
      />,
      { wrapper },
    );
    expect(chips(container)).toEqual([]);
  });

  it("不传 nameChips 时输出 HTML 与传空数组相同", () => {
    const content = "提到 desktop-app 与 **粗体**。\n\n- 列点 SHALL 照常";
    const a = render(<Markdown content={content} />, { wrapper }).container.innerHTML;
    const b = render(<Markdown content={content} nameChips={[]} />, { wrapper }).container.innerHTML;
    expect(b).toBe(a);
    expect(a).not.toContain("data-name-chip");
  });
});

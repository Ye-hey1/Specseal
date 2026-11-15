// spec desktop-manual-page「Markdown 的 GitHub Alert 提示框」（design：共用 Markdown
// 组件的内置 remark 转换）：四型 blockquote 呈现为带类型 class 与类型标签的提示框、
// 标记文本消失、其余内容保留；首段不以标记开头的 blockquote 维持原样；配色取接口
// 状态语意色 token。渲染管线为 Streamdown（desktop-design-foundation D10）：提示框
// 的 class 必须通过它的 sanitize，所以这里逐案验证输出的 class。
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";

import { I18nProvider, type UiLocale } from "../i18n";
import { Markdown } from "../components/Markdown";
import { CALLOUT_BOX_CLS, CALLOUT_TITLE_CLS, Callout } from "../components/ui/callout";
import { SEMANTIC_SURFACE, SEMANTIC_TONE } from "../tone";

function renderMd(content: string, locale: UiLocale = "zh-CN") {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nProvider locale={locale}>{children}</I18nProvider>
  );
  return render(<Markdown content={content} />, { wrapper });
}

const alertBox = (container: HTMLElement, type: string) =>
  container.querySelector(`.markdown-alert.markdown-alert-${type}`) as HTMLElement | null;

describe("Markdown GitHub Alert 提示框", () => {
  it.each([
    ["NOTE", "note", "注意", "inProgress"],
    ["TIP", "tip", "提示", "success"],
    ["WARNING", "warning", "警告", "warning"],
    ["CAUTION", "caution", "小心", "danger"],
  ] as const)("`> [!%s]` 呈现为 %s 提示框：类型标签、标记消失、其余内容保留、语意色分层", (marker, type, label, tone) => {
    // spec Scenario「四型提示框」。
    const { container } = renderMd(`> [!${marker}]\n> 第一行内容\n> 第二行 **粗体**\n\n一般段落。`);
    const box = alertBox(container, type);
    expect(box).toBeTruthy();
    expect(box!.tagName).not.toBe("BLOCKQUOTE");
    // 类型标签（LANGUAGE 用语）＋语意色（状态色 token，不占主色）。
    const title = box!.querySelector(".markdown-alert-title") as HTMLElement;
    expect(title.textContent).toBe(label);
    for (const cls of SEMANTIC_TONE[tone].split(" ")) expect(title.className).toContain(cls);
    for (const cls of SEMANTIC_SURFACE[tone].split(" ")) expect(box!.className).toContain(cls);
    // 标记文本不出现，blockquote 内其余文本完整显示（含行内格式）。
    expect(container.textContent).not.toContain(`[!${marker}]`);
    expect(box!.textContent).toContain("第一行内容");
    expect(box!.textContent).toContain("第二行");
    // Streamdown 以带 data-streamdown="strong" 的元素呈现粗体。
    expect(box!.querySelector('[data-streamdown="strong"]')?.textContent).toBe("粗体");
    // 提示框外的内容照常。
    expect(container.textContent).toContain("一般段落。");
    expect(container.querySelector("blockquote")).toBeNull();
  });

  it("类型标签跟随接口语言（en）", () => {
    const { container } = renderMd("> [!WARNING]\n> 内容", "en");
    expect(alertBox(container, "warning")!.querySelector(".markdown-alert-title")!.textContent).toBe(
      "Warning",
    );
  });

  it("小写标记同样转换（GitHub 也接受）", () => {
    const { container } = renderMd("> [!note]\n> 小写内容");
    const box = alertBox(container, "note")!;
    expect(box.querySelector(".markdown-alert-title")!.textContent).toBe("注意");
    expect(box.textContent).toContain("小写内容");
    expect(container.textContent).not.toContain("[!note]");
  });

  it("标记行以硬换行结尾（行尾两空格）时，提示框内文不以 <br> 起头", () => {
    const { container } = renderMd("> [!TIP]  \n> 第一行\n> 第二行");
    const box = alertBox(container, "tip")!;
    const first = box.querySelector("p") as HTMLElement;
    expect(first.innerHTML.startsWith("<br")).toBe(false);
    expect(first.textContent).toContain("第一行");
    expect(first.textContent).toContain("第二行");
  });

  it("标记之后的多段内容全部保留在提示框内", () => {
    const { container } = renderMd("> [!TIP]\n> 第一段\n>\n> 第二段\n>\n> - 清单项");
    const box = alertBox(container, "tip")!;
    expect(box.querySelectorAll("p").length).toBe(2);
    expect(box.querySelector("li")?.textContent).toBe("清单项");
    expect(box.textContent).toContain("第一段");
    expect(box.textContent).toContain("第二段");
  });

  it("首段不以四种标记开头的 blockquote 维持原样（不转换、标记文本照常显示）", () => {
    // spec Scenario「一般引言不受影响」：一般引言、标记不在首段行首、标记与文本
    // 同行（GitHub 不视为 alert）、未知类型、非 blockquote 的标记文本。
    const md = [
      "> 一般引言\n> 第二行",
      "> 前导文本\n> [!NOTE]",
      "> [!NOTE] 同行文本",
      "> [!IMPORTANT]\n> 未支持的类型",
      "> **粗体** [!TIP]",
      "[!NOTE] 不在 blockquote 内",
      "> 第一段\n>\n> [!WARNING]\n> 第二段才有标记",
    ].join("\n\n");
    const { container } = renderMd(md);
    const quotes = container.querySelectorAll("blockquote");
    expect(quotes.length).toBe(6);
    expect(container.querySelector(".markdown-alert")).toBeNull();
    expect(quotes[2].textContent).toContain("[!NOTE] 同行文本");
    expect(quotes[3].textContent).toContain("[!IMPORTANT]");
    expect(quotes[5].textContent).toContain("[!WARNING]");
    expect(container.textContent).toContain("[!NOTE] 不在 blockquote 内");
  });

  it("无 blockquote 的一般文档不出现提示框", () => {
    const md = "# 标题\n\n段落一\n换行\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- [ ] 任务";
    const { container } = renderMd(md);
    expect(container.querySelector(".markdown-alert")).toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("标题");
    expect(container.querySelector("table")).toBeTruthy();
  });
});

// design D6：提示框样式抽成 Callout 原语，Markdown 的四型与详情页阅读卡的提示框槽共用。
describe("Callout 原语", () => {
  it("tip 型：外框为共用提示框 class＋success 语意色，标题列带 success 字色", () => {
    const { container } = render(
      <Callout tone="tip" title="x">
        y
      </Callout>,
    );
    const box = container.firstElementChild as HTMLElement;
    for (const cls of CALLOUT_BOX_CLS.split(" ")) expect(box.className).toContain(cls);
    for (const cls of SEMANTIC_SURFACE.success.split(" ")) expect(box.className).toContain(cls);
    const title = box.firstElementChild as HTMLElement;
    expect(title.textContent).toBe("x");
    for (const cls of CALLOUT_TITLE_CLS.split(" ")) expect(title.className).toContain(cls);
    for (const cls of SEMANTIC_TONE.success.split(" ")) expect(title.className).toContain(cls);
    expect(box.textContent).toBe("xy");
  });
});

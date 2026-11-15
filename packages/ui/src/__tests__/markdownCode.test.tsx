// 代码区块上色与拷贝钮（desktop-design-foundation D10）：Streamdown 的 code 插件以
// Shiki 上色（浅色 github-light、深色 github-dark），区块右上有拷贝钮，按下后写入原文并
// 声明「已拷贝」；语言未加载时以无上色的等宽文本呈现、不抛错。
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { I18nProvider } from "../i18n";
import { Markdown } from "../components/Markdown";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
const CODE = "const answer: number = 42;\nconsole.log(answer);";

afterEach(cleanup);

describe("Markdown 代码区块", () => {
  it("拷贝钮写入原文，按下后声明「已拷贝」并换成勾号", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Markdown content={"```ts\n" + CODE + "\n```"} />, { wrapper: zhWrapper });
    const button = screen.getByRole("button", { name: "拷贝代码" });
    fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    // Streamdown 拷贝的是 fence 内原文（尾端带 fence 前的换行）。
    expect((writeText.mock.calls[0][0] as string).replace(/\n$/, "")).toBe(CODE);
    expect(await screen.findByText("已拷贝")).toBeTruthy();
    expect(button.querySelector("svg.lucide-check")).toBeTruthy();
  });

  it("拷贝钮依共用光标规则：取用光标变量、停用为箭头、滑过有淡底（spec desktop-app「可点元素的光标与 hover 回馈」）", () => {
    const { container } = render(<Markdown content={"```ts\n" + CODE + "\n```"} />, { wrapper: zhWrapper });
    const button = screen.getByRole("button", { name: "拷贝代码" });
    // Streamdown 在按钮上写死 cursor-pointer／disabled:cursor-not-allowed（utilities 层，盖过 base 层全域规则）；
    // Markdown 容器的任意变体选择器权重较高，把它们盖回共用设置。
    const root = container.firstElementChild as HTMLElement;
    expect(root.contains(button)).toBe(true);
    const cls = root.className.split(/\s+/);
    expect(button.closest('[data-streamdown="code-block-actions"]')).toBeTruthy();
    expect(cls).toEqual(
      expect.arrayContaining([
        "[&_button]:cursor-(--cursor-interaction)",
        "[&_button:disabled]:cursor-default",
        "[&_[data-streamdown=code-block-actions]_button]:rounded-md",
        "[&_[data-streamdown=code-block-actions]_button:enabled]:hover:bg-foreground/5",
      ]),
    );
    // 淡底只给代码区块的控制钮：图片下载钮自带底色与 hover 底色，不得被盖成近透明。
    expect(cls.filter((c) => c.startsWith("[&_button") && c.includes("hover:"))).toEqual([]);
  });

  it("以 Shiki 上色：关键字带 github-light 与 github-dark 两套色", async () => {
    const { container } = render(<Markdown content={"```ts\n" + CODE + "\n```"} />, {
      wrapper: zhWrapper,
    });
    // 上色完成后 Streamdown 会换掉整个 <pre>：每次都重新查，不能抓住第一次 render 的节点。
    await waitFor(
      () => {
        const keyword = [...container.querySelectorAll("pre span[style]")].find(
          (s) => s.textContent === "const",
        ) as HTMLElement | undefined;
        expect(keyword).toBeTruthy();
        const style = keyword!.getAttribute("style")!.toUpperCase();
        expect(style).toContain("#D73A49"); // github-light keyword
        expect(style).toContain("#F97583"); // github-dark keyword
      },
      { timeout: 5000 },
    );
  });

  it("未知语言以等宽原文呈现、不抛错", async () => {
    const { container } = render(<Markdown content={"```nosuchlang\nplain <b>text</b>\n```"} />, {
      wrapper: zhWrapper,
    });
    const pre = container.querySelector("pre") as HTMLElement;
    expect(pre.textContent).toContain("plain <b>text</b>");
    expect(screen.getByRole("button", { name: "拷贝代码" })).toBeTruthy();
  });
});

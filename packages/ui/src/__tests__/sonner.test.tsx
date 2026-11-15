import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { toast, type ToasterProps } from "sonner";

import { I18nProvider } from "../i18n";
import { Toaster } from "../components/ui/sonner";

const TOAST_ID = "desktop-failure";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  });
});

function renderToaster(props: ToasterProps = {}) {
  return render(
    <I18nProvider locale="zh-CN">
      <Toaster {...props} />
    </I18nProvider>,
  );
}

afterEach(() => {
  act(() => toast.dismiss());
  vi.useRealTimers();
});

describe("Toaster", () => {
  it("沿用主接口 tokens，并以 destructive 局部标示 error toast", async () => {
    renderToaster();

    act(() => {
      toast.error("设计 token 失败", { id: TOAST_ID });
    });

    const toastNode = (await screen.findByText("设计 token 失败")).closest("[data-sonner-toast]");
    const toaster = toastNode?.closest<HTMLElement>("[data-sonner-toaster]");
    expect(toaster).toBeTruthy();
    expect(toaster?.style.getPropertyValue("--normal-bg")).toBe("var(--card)");
    expect(toaster?.style.getPropertyValue("--normal-text")).toBe("var(--card-foreground)");
    expect(toaster?.style.getPropertyValue("--normal-border")).toBe("var(--border)");
    // 圆角走 Tailwind 缺省四阶（design D2）：不再引用已移除的自订圆角 token。
    expect(toaster?.style.getPropertyValue("--border-radius")).toBe("");
    expect(toaster?.style.fontFamily).toBe("inherit");

    expect(toastNode?.getAttribute("data-rich-colors")).toBeNull();
    expect(toastNode?.className).toContain("!shadow-lg");
    expect(toastNode?.className).toContain("!rounded-xl");
    expect(toastNode?.className).toContain("!border-destructive/40");
    expect(toastNode?.className).toContain("[&_[data-icon]]:text-destructive");
    expect(toastNode?.className).not.toContain("bg-destructive");

    const closeButton = screen.getByRole("button", { name: "关闭通知" });
    expect(closeButton.className).toContain("!bg-card");
    expect(closeButton.className).toContain("!border-border");
    expect(closeButton.className).toContain("!text-muted-foreground");
  });

  it("合并调用端 root style、toast style 与逐类型 classNames", async () => {
    renderToaster({
      style: { letterSpacing: "0.123em" },
      toastOptions: {
        style: { opacity: 0.75 },
        classNames: {
          toast: "consumer-toast",
          error: "consumer-error",
        },
      },
    });

    act(() => {
      toast.error("自订样式失败", { id: TOAST_ID });
    });

    const toastNode = (await screen.findByText("自订样式失败")).closest<HTMLElement>(
      "[data-sonner-toast]",
    );
    const toaster = toastNode?.closest<HTMLElement>("[data-sonner-toaster]");
    expect(toaster?.style.letterSpacing).toBe("0.123em");
    expect(toaster?.style.getPropertyValue("--normal-bg")).toBe("var(--card)");
    expect(toastNode?.style.opacity).toBe("0.75");
    expect(toastNode?.className).toContain("!shadow-lg");
    expect(toastNode?.className).toContain("consumer-toast");
    expect(toastNode?.className).toContain("!border-destructive/40");
    expect(toastNode?.className).toContain("consumer-error");
  });

  it("显示消息与关闭钮，且同 id 的新消息取代旧消息", async () => {
    renderToaster();

    act(() => {
      toast.error("第一则失败", { id: TOAST_ID });
    });
    expect(await screen.findByText("第一则失败")).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭通知" })).toBeTruthy();

    act(() => {
      toast.error("第二则失败", { id: TOAST_ID });
    });
    expect(await screen.findByText("第二则失败")).toBeTruthy();
    expect(screen.queryByText("第一则失败")).toBeNull();
  });

  it("6000 毫秒后自动消失", async () => {
    vi.useFakeTimers();
    renderToaster();

    act(() => {
      toast.error("逾时失败", { id: TOAST_ID });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const toastNode = screen.getByText("逾时失败").closest("[data-sonner-toast]");
    expect(toastNode).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(toastNode?.getAttribute("data-removed")).toBe("true");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.queryByText("逾时失败")).toBeNull();
  });

  it("点按关闭钮立即消失", async () => {
    renderToaster();

    act(() => {
      toast.error("手动关闭失败", { id: TOAST_ID });
    });
    fireEvent.click(await screen.findByRole("button", { name: "关闭通知" }));

    await waitFor(() => {
      expect(screen.queryByText("手动关闭失败")).toBeNull();
    });
  });

  it("HTML-like 消息以纯文本呈现，不创建可运行元素", async () => {
    renderToaster();
    const htmlLikeMessage = '<img src="x" onerror="globalThis.pwned=true">';

    act(() => {
      toast.error(htmlLikeMessage, { id: TOAST_ID });
    });

    expect(await screen.findByText(htmlLikeMessage)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });
});

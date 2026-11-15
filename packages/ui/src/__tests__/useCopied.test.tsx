import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

import { useCopied } from "../components/useCopied";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Probe() {
  const [copied, markCopied] = useCopied();
  return <button onClick={markCopied}>{copied ? "copied" : "idle"}</button>;
}

describe("useCopied", () => {
  it("触发后亮起，1.5 秒自动复原", () => {
    vi.useFakeTimers();
    render(<Probe />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").textContent).toBe("copied");
    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(screen.getByRole("button").textContent).toBe("copied");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("button").textContent).toBe("idle");
  });

  it("重复触发重新计时，不被前一次的到期提早熄灯", () => {
    vi.useFakeTimers();
    render(<Probe />);
    fireEvent.click(screen.getByRole("button"));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    fireEvent.click(screen.getByRole("button"));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("button").textContent).toBe("copied");
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole("button").textContent).toBe("idle");
  });

  it("unmount 取消未到期的计时器，不留晚于拆除触发的 setState", () => {
    vi.useFakeTimers();
    const { unmount } = render(<Probe />);
    fireEvent.click(screen.getByRole("button"));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

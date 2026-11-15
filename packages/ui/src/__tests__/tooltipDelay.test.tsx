import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";

// spec「主题化提示统一延迟」：延迟缺省下沉共用组件层（300ms），个别接口不得再自订。
const DELAY_MS = 300;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const hoverTrigger = () => {
  render(
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button>触发</button>
        </TooltipTrigger>
        <TooltipContent>提示内容</TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  );
  fireEvent.pointerMove(screen.getByRole("button", { name: "触发" }), { pointerType: "mouse" });
};

describe("主题化提示统一延迟", () => {
  it("停留未达 300ms 不显示、达 300ms 显示", () => {
    vi.useFakeTimers();
    hoverTrigger();

    act(() => {
      vi.advanceTimersByTime(DELAY_MS - 1);
    });
    // 气泡以 [data-side] 辨识（与 ui.test.tsx 同惯例）——打开时 Radix 另渲染一份
    // 供辅助技术朗读的同文本节点，用文本查找会撞到两个。
    expect(document.querySelector("[data-side]")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(document.querySelector("[data-side]")?.textContent).toContain("提示内容");
  });
});

// 纯文件系统断言：以测试档自身路径推出 repo root（jsdom 环境下 import.meta.url
// 会被换成 http location，fileURLToPath 失败——见 theme.test.ts 的同款注记）。
const REPO_ROOT = resolve(dirname(expect.getState().testPath ?? ""), "../../../..");
const SCAN_ROOTS = ["packages/ui/src", "apps/desktop/src", "apps/server-web/src"];
/** 唯一得持有延迟值的文件：共用组件层自己。 */
const DELAY_OWNER = "packages/ui/src/components/ui/tooltip.tsx";

const scannedSources = () => {
  const files: string[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === "__tests__" || entry.name === "dist" || entry.name === "node_modules")
        continue;
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push(child);
    }
  };
  for (const root of SCAN_ROOTS) walk(`${REPO_ROOT}/${root}`);
  return files.map((f) => [f.slice(REPO_ROOT.length + 1), readFileSync(f, "utf8")] as const);
};

describe("延迟覆写守门", () => {
  it("共用组件层以外没有任何 delayDuration 覆写", () => {
    const overrides = scannedSources()
      .filter(([file, source]) => file !== DELAY_OWNER && source.includes("delayDuration"))
      .map(([file]) => file);
    expect(overrides).toEqual([]);
  });

  it("共用组件层钉住 300ms 缺省", () => {
    const source = readFileSync(`${REPO_ROOT}/${DELAY_OWNER}`, "utf8");
    expect(source).toContain("delayDuration = 300");
  });
});

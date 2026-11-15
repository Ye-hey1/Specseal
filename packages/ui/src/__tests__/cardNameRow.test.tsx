// 卡片名称列（spec「看板卡片统一解剖学」）：名称恒单行不换行，拷贝钮与名称同一
// 列尾随不被挤到次行；名称过长截断时以省略号收尾——淡出被读成花屏，且全系统其余
// 截断皆省略号，统一为单一收尾（翻案 card-name-single-line-fade，2026-08-04）。
// 变更卡与讨论卡共用同一列，两者行为必须一致。
import { describe, it, expect, afterEach, vi } from "vitest";
import { render as rtlRender, screen, cleanup } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";
import { ChangeCard } from "../components/ChangeCard";
import { DiscussionColumn } from "../components/DiscussionColumn";
import type { ChangeItem, DiscussionItem } from "../adapter";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

const base: ChangeItem = {
  name: "worktree-parallel-apply",
  status: "in-progress",
  totalTasks: 14,
  completedTasks: 0,
};

/**
 * jsdom 的 scrollWidth/clientWidth 恒为 0：以 getter stub 假造「名称溢出」。
 * 收尾改省略号后这里不再驱动任何条件样式——留着正是为了证明「就算量到溢出，
 * 也不得再长出遮罩或量测标记」。
 */
function stubWidths(scroll: number, client: number) {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(scroll);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(client);
}

/** 省略号收尾＋无淡出残迹：长短名称、变更卡与讨论卡共用同一组断言。 */
function expectEllipsisTruncation(name: HTMLElement) {
  // Tailwind truncate＝overflow-hidden + text-ellipsis + whitespace-nowrap。
  expect(name.className).toContain("truncate");
  expect(name.dataset.fade).toBeUndefined();
  expect(name.style.maskImage).toBe("");
  expect(name.style.webkitMaskImage ?? "").toBe("");
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("ChangeCard 名称列", () => {
  it("名称不换行，拷贝钮与名称在同一列容器内", () => {
    render(<ChangeCard change={base} />);
    const name = document.querySelector("[data-name]") as HTMLElement;
    const copy = screen.getByLabelText("拷贝名称");
    // truncate 一并带入 white-space: nowrap——单行由它保证。
    expect(name.className).toContain("truncate");
    expect(name.parentElement).toBe(copy.parentElement);
    // 名称被压缩、拷贝钮保持原宽（不被挤到次行的必要条件）。
    expect(name.className).toContain("min-w-0");
    expect(copy.className).toContain("shrink-0");
  });

  it("名称溢出时以省略号收尾，不再套渐层淡出遮罩", () => {
    stubWidths(320, 160);
    render(<ChangeCard change={base} />);
    const name = document.querySelector("[data-name]") as HTMLElement;
    expectEllipsisTruncation(name);
    // 拷贝钮仍同列尾随。
    expect(name.parentElement).toBe(screen.getByLabelText("拷贝名称").parentElement);
  });

  it("名称未溢出时完整显示，同样无遮罩与量测标记", () => {
    stubWidths(120, 160);
    render(<ChangeCard change={{ ...base, name: "short" }} />);
    const name = document.querySelector("[data-name]") as HTMLElement;
    expect(name.textContent).toBe("short");
    expectEllipsisTruncation(name);
    // 短名称路径也钉住同列关系（长名称由上一条验）。
    expect(name.parentElement).toBe(screen.getByLabelText("拷贝名称").parentElement);
  });

  it("长名称挤压时 meta icons 不被挤出卡外", () => {
    stubWidths(320, 160);
    render(
      <ChangeCard
        change={{ ...base, createdBy: "Momo Chen <m@example.com>", fromDiscussions: ["some-topic"] }}
      />,
    );
    const name = document.querySelector("[data-name]") as HTMLElement;
    // jsdom 量不到版面，class 是唯一可钉的层次：只有名称列吸收挤压，
    // meta icons 各自固定宽度。任一边被拿掉都会让 icons 被挤出卡外。
    expect(name.parentElement?.className).toContain("flex-1");
    expect(name.parentElement?.className).toContain("min-w-0");
    expect(screen.getByLabelText("Momo Chen <m@example.com>").className).toContain("shrink-0");
    expect(screen.getByLabelText("来自讨论").className).toContain("shrink-0");
  });
});

const discussion: DiscussionItem = {
  slug: "cross-station-staleness",
  topic: "跨站陈旧",
  status: "open",
  rounds: 3,
  created: "2026-07-01",
  promotedTo: [],
};

describe("DiscussionColumn 全卡的 slug 列（与变更卡同骨架）", () => {
  it("slug 不换行，拷贝钮与 slug 在同一列容器内", () => {
    render(<DiscussionColumn discussions={[discussion]} changes={[]} archived={[]} />);
    const name = document.querySelector("[data-name]") as HTMLElement;
    const copy = screen.getByLabelText("拷贝 slug");
    expect(name.className).toContain("truncate");
    // slug 过长不再 break-all 折行——单行截断才留得住尾随的拷贝钮。
    expect(name.className).not.toContain("break-all");
    expect(name.parentElement).toBe(copy.parentElement);
  });

  it("slug 溢出时与变更卡同一收尾：省略号，不套遮罩", () => {
    stubWidths(320, 160);
    render(<DiscussionColumn discussions={[discussion]} changes={[]} archived={[]} />);
    const name = document.querySelector("[data-name]") as HTMLElement;
    expectEllipsisTruncation(name);
    expect(name.parentElement).toBe(screen.getByLabelText("拷贝 slug").parentElement);
  });
});

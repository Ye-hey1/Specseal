// 改进标示（spec desktop-app「看板讨论卡片的改进标示」「讨论抽屉的改进标示」；
// change add-improve-flow）：kind 为 improve 的讨论在卡片、已封存侧与抽屉各显示
// 同一枚小章，一般讨论不长出任何新元素；标示随 kind 恒定，不随生命周期变化。
import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider, MESSAGES } from "../i18n";

const wrapWith = (locale: "zh-CN" | "en") =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <I18nProvider locale={locale}>{children}</I18nProvider>;
  };
function render(ui: ReactElement, locale: "zh-CN" | "en" = "zh-CN") {
  return rtlRender(ui, { wrapper: wrapWith(locale) });
}

import { DiscussionCard, DiscussionColumn } from "../components/DiscussionColumn";
import { DiscussionDetailPage } from "../components/DiscussionDetailPage";
import { ArchivedList } from "../components/ArchivedList";
import { ArchivedDetailPage } from "../components/ArchivedDetailPage";
import type { DiscussionItem } from "../adapter";
import { discussionDoc } from "./engineCuts";

const IMPROVE_TW = "改进讨论";
const IMPROVE_EN = MESSAGES.en["discussion.kindImprove"];

const plain: DiscussionItem = {
  slug: "board-search-bar",
  topic: "看板搜索列",
  status: "open",
  rounds: 2,
  created: "2026-08-01",
  promotedTo: [],
};
const improve: DiscussionItem = {
  slug: "improve-store-layer",
  topic: "store 层结构改进",
  status: "open",
  rounds: 1,
  created: "2026-08-07",
  kind: "improve",
  promotedTo: [],
};

/** DiscussionDetailPage 的最小 props（标示以外的相依一律给空替身）。 */
function pageProps(discussion: DiscussionItem) {
  return {
    discussion,
    changes: [],
    archivedChanges: [],
    loadDocument: vi.fn(async () => discussionDoc("## Rounds\n")),
  };
}

describe("看板讨论卡片的改进标示", () => {
  it("kind 为 improve 的卡片出现小章，tooltip 为「改进讨论」", () => {
    render(<DiscussionCard d={improve} />);
    expect(screen.getByLabelText(IMPROVE_TW)).toBeTruthy();
  });

  it("一般讨论（无 kind）不出现任何添加元素", () => {
    render(<DiscussionCard d={plain} />);
    expect(screen.queryByLabelText(IMPROVE_TW)).toBeNull();
  });

  it("已转出的改进讨论维持标示（标示随 kind 恒定，不随生命周期变化）", () => {
    // 走真实路径：promoted 讨论被 DiscussionColumn 分流到收合列（PromotedRow），
    // 不会经过 DiscussionCard——展开收合列后小章必须在列上。
    render(
      <DiscussionColumn
        discussions={[{ ...improve, status: "promoted", promotedTo: ["cut-a"] }]}
        changes={[]}
        archived={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /已转出/ }));
    const row = document.querySelector('[data-discussion="improve-store-layer"]') as HTMLElement;
    expect(within(row).getByLabelText(IMPROVE_TW)).toBeTruthy();
  });

  it("en 接口使用对应英文词条，不落回中文", () => {
    render(<DiscussionCard d={improve} />, "en");
    expect(screen.getByLabelText(IMPROVE_EN)).toBeTruthy();
    expect(screen.queryByLabelText(IMPROVE_TW)).toBeNull();
  });

  it("小章 tooltip 打开后显示「改进讨论」状态词", async () => {
    // Scenario 说 tooltip SHALL 显示状态词——aria-label 之外，把 TooltipContent
    // 这一半也实际打开验掉（模式同 richDrawer 的可见 tooltip 测试）。
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<DiscussionCard d={improve} />);
    const trigger = screen.getByLabelText(IMPROVE_TW);
    await user.hover(trigger);
    await waitFor(() => expect(trigger.getAttribute("data-state")).toContain("open"));
    expect(document.querySelector("[data-radix-popper-content-wrapper]")?.textContent).toContain(
      IMPROVE_TW,
    );
  });
});

describe("已封存侧的改进标示", () => {
  it("已封存的改进讨论仍显示小章，一般讨论不显示", () => {
    render(
      <ArchivedList
        archived={[]}
        query=""
        onQuery={() => {}}
        archivedDiscussions={[improve, plain]}
        onOpen={() => {}}
      />,
    );
    // 已封存页缺省停在「变更」子页签；讨论节要切过去才渲染。
    fireEvent.mouseDown(screen.getByRole("tab", { name: /已封存的讨论/ }));
    const card = (slug: string) =>
      document.querySelector(`[data-archived-discussion="${slug}"]`) as HTMLElement;
    expect(within(card("improve-store-layer")).getByLabelText(IMPROVE_TW)).toBeTruthy();
    expect(within(card("board-search-bar")).queryByLabelText(IMPROVE_TW)).toBeNull();
  });
});

describe("已封存讨论详情页的改进标示", () => {
  const archivedPageBase = {
    loadDocument: vi.fn(async () => null),
    loadCapabilities: vi.fn(async () => []),
    loadDiscussionDocument: vi.fn(async () => null),
  };

  it("discussionKind 为 improve 时显示标示", () => {
    render(
      <ArchivedDetailPage
        {...archivedPageBase}
        target={{ kind: "discussion", slug: "improve-store-layer" }}
        discussionKind="improve"
      />,
    );
    const badge = document.querySelector("[data-discussion-kind]") as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain(IMPROVE_TW);
  });

  it("一般封存讨论不显示标示", () => {
    render(
      <ArchivedDetailPage
        {...archivedPageBase}
        target={{ kind: "discussion", slug: "board-search-bar" }}
      />,
    );
    expect(document.querySelector("[data-discussion-kind]")).toBeNull();
  });
});

describe("讨论详情页的改进标示", () => {
  it("kind 为 improve 时显示标示", () => {
    render(<DiscussionDetailPage {...(pageProps(improve) as never)} />);
    const badge = document.querySelector("[data-discussion-kind]") as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain(IMPROVE_TW);
  });

  it("一般讨论的详情页不显示标示", () => {
    render(<DiscussionDetailPage {...(pageProps(plain) as never)} />);
    expect(document.querySelector("[data-discussion-kind]")).toBeNull();
  });

  it("en 接口的详情页标示使用英文词条", () => {
    render(<DiscussionDetailPage {...(pageProps(improve) as never)} />, "en");
    const badge = document.querySelector("[data-discussion-kind]") as HTMLElement;
    expect(badge.textContent).toContain(IMPROVE_EN);
  });
});

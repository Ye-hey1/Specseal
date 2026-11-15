// 审查标示（spec desktop-app「看板卡片的审查标示」「详情抽屉的审查信息列」
// 「已封存侧的审查标示」「封存入口的未结工单三选项」；design D6）：卡片行内
// 小章四态、抽屉信息列、封存侧结局标示、三选项对话框未选择不封存。
import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, fireEvent, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";

// 既有中文断言包 I18nProvider locale zh-CN 后照旧断言（i18n 抽 key 的回归保护）。
const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

// 拦截 TaskList（jsdom 不需要真任务清单；沿 richDrawer.test 惯例）。
vi.mock("../components/TaskList", () => ({
  TaskList: () => <div data-testid="tasklist-stub" />,
}));

import { ChangeCard } from "../components/ChangeCard";
import { ChangeDetailPage } from "../components/ChangeDetailPage";
import { ArchivedList } from "../components/ArchivedList";
import { ArchivedDetailPage } from "../components/ArchivedDetailPage";
import { ReviewArchiveDialog } from "../components/ReviewArchiveDialog";
import type { ArchivedItem, ChangeItem } from "../adapter";

const base: ChangeItem = { name: "c", status: "in-progress", totalTasks: 2, completedTasks: 1 };

const REVIEW_LABELS = ["审查中", "已审查", "已审查·其后有变动"];

/** ChangeDetailPage 的最小 props（审查信息列以外的相依一律给空替身）。 */
function drawerProps(change: ChangeItem) {
  return {
    change,
    loadDocument: vi.fn(async () => "# doc"),
    loadCapabilities: vi.fn(async () => [] as string[]),
    loadMeta: vi.fn(async () => null),
    onRunVerb: vi.fn(),
    onDelete: vi.fn(),
  };
}

describe("ChangeCard 审查章（四态）", () => {
  it("reviewed 显示「已审查」章", () => {
    render(
      <ChangeCard
        change={{ ...base, reviewStatus: "reviewed", reviewedAt: "2026-08-01", reviewedBy: "Rev <r@example.com>" }}
      />,
    );
    expect(screen.getByLabelText("已审查")).toBeTruthy();
  });

  it("reviewedStale 显示降级章「已审查·其后有变动」", () => {
    render(
      <ChangeCard
        change={{ ...base, reviewStatus: "reviewedStale", reviewedAt: "2026-08-01", reviewedBy: "Rev <r@example.com>" }}
      />,
    );
    expect(screen.getByLabelText("已审查·其后有变动")).toBeTruthy();
  });

  it("inReview 显示「审查中」章", () => {
    render(<ChangeCard change={{ ...base, reviewStatus: "inReview" }} />);
    expect(screen.getByLabelText("审查中")).toBeTruthy();
  });

  it("none（含缺席）无任何审查相关元素", () => {
    // spec Scenario「无审查痕迹」：卡片维持极简，不因字段存在而长出空壳。
    for (const change of [{ ...base, reviewStatus: "none" as const }, base]) {
      const { unmount } = render(<ChangeCard change={change} />);
      for (const label of REVIEW_LABELS) {
        expect(screen.queryByLabelText(label)).toBeNull();
      }
      unmount();
    }
  });
});

/** 章签只在「状态」区的「品质关卡」列，身分区没有（spec「变更详情页的标头与状态卡」）。 */
function qualityStamp(mark: string) {
  const row = document.querySelector(mark) as HTMLElement;
  expect(row).toBeTruthy();
  expect(row.closest("[data-status-quality]")).toBeTruthy();
  expect(row.closest("[data-detail-identity]")).toBeNull();
  return row;
}

describe("ChangeDetailPage 审查章签", () => {
  it("reviewed 章签落在品质关卡列：状态词＋盖章日期，审查者收进提示", () => {
    // 含 email 的完整识别不直出，收进主题化提示（提示内容由 changeDetailPage.test.tsx 验）。
    render(
      <ChangeDetailPage
        {...(drawerProps({
          ...base,
          reviewStatus: "reviewed",
          reviewedAt: "2026-08-01",
          reviewedBy: "Rev <r@example.com>",
        }) as never)}
      />,
    );
    const row = qualityStamp("[data-review-row]");
    expect(within(row).getByText(/已审查/)).toBeTruthy();
    expect(row.textContent).toContain("2026-08-01");
    expect(row.textContent).not.toContain("r@example.com");
  });

  it("inReview 仅显示状态词，无时间与审查者", () => {
    render(<ChangeDetailPage {...(drawerProps({ ...base, reviewStatus: "inReview" }) as never)} />);
    const row = qualityStamp("[data-review-row]");
    expect(within(row).getByText(/审查中/)).toBeTruthy();
    expect(row.textContent).not.toContain("2026-");
  });

  it("none 不渲染信息列", () => {
    render(<ChangeDetailPage {...(drawerProps({ ...base, reviewStatus: "none" }) as never)} />);
    expect(document.querySelector("[data-review-row]")).toBeNull();
  });
});

describe("已封存侧审查结局标示", () => {
  const plain: ArchivedItem = { datedName: "2026-07-04-plain", date: "2026-07-04", name: "plain" };
  const passed: ArchivedItem = {
    datedName: "2026-07-05-passed",
    date: "2026-07-05",
    name: "passed",
    reviewStatus: "reviewed",
  };
  const carried: ArchivedItem = {
    datedName: "2026-07-06-carried",
    date: "2026-07-06",
    name: "carried",
    reviewStatus: "reviewedNotPassed",
  };

  function renderList() {
    return render(
      <ArchivedList
        archived={[plain, passed, carried]}
        query=""
        onQuery={() => {}}
        archivedDiscussions={[]}
        onOpen={() => {}}
      />,
    );
  }

  it("清单卡依结局标示：带章＝已审查、化石工单＝曾审查未通过、皆无＝无标示", () => {
    renderList();
    const card = (name: string) =>
      document.querySelector(`[data-archived="${name}"]`) as HTMLElement;
    expect(within(card("2026-07-05-passed")).getByLabelText("已审查")).toBeTruthy();
    expect(within(card("2026-07-06-carried")).getByLabelText("曾审查未通过")).toBeTruthy();
    for (const label of ["已审查", "曾审查未通过"]) {
      expect(within(card("2026-07-04-plain")).queryByLabelText(label)).toBeNull();
    }
  });

  it("已封存详情页显示「曾审查未通过」标示", () => {
    render(
      <ArchivedDetailPage
        target={{ kind: "change", datedName: "2026-07-06-carried" }}
        reviewStatus="reviewedNotPassed"
        loadDocument={async () => null}
        loadCapabilities={async () => []}
        loadDiscussionDocument={async () => null}
      />,
    );
    expect(document.querySelector("[data-review-outcome]")!.textContent).toContain("曾审查未通过");
  });
});

describe("审查标示配色（四态各自可辨识，不落回灰阶）", () => {
  const archivedItems: ArchivedItem[] = [
    { datedName: "2026-07-05-passed", date: "2026-07-05", name: "passed", reviewStatus: "reviewed" },
    {
      datedName: "2026-07-06-carried",
      date: "2026-07-06",
      name: "carried",
      reviewStatus: "reviewedNotPassed",
    },
  ];

  it("卡片章：审查中＝蓝、已审查＝紫（深浅主题皆非主色）、其后有变动＝琥珀", () => {
    const tones: Array<[ChangeItem["reviewStatus"], string, string]> = [
      ["inReview", "审查中", "text-status-progress"],
      ["reviewed", "已审查", "text-stamp"],
      ["reviewedStale", "已审查·其后有变动", "text-status-warning"],
    ];
    for (const [reviewStatus, label, cls] of tones) {
      const { unmount } = render(<ChangeCard change={{ ...base, reviewStatus }} />);
      const stamp = screen.getByLabelText(label);
      expect(stamp.className).toContain(cls);
      expect(stamp.className).not.toContain("text-muted-foreground");
      unmount();
    }
  });

  it("抽屉信息列：状态词依状态上色", () => {
    const tones: Array<[ChangeItem["reviewStatus"], string]> = [
      ["inReview", "text-status-progress"],
      ["reviewed", "text-stamp"],
      ["reviewedStale", "text-status-warning"],
    ];
    for (const [reviewStatus, cls] of tones) {
      const { unmount } = render(
        <ChangeDetailPage {...(drawerProps({ ...base, reviewStatus }) as never)} />,
      );
      const tone = document.querySelector("[data-review-row] [data-review-tone]") as HTMLElement;
      expect(tone).toBeTruthy();
      expect(tone.className).toContain(cls);
      unmount();
    }
  });

  it("已封存清单：已审查＝紫、曾审查未通过＝红", () => {
    render(
      <ArchivedList
        archived={archivedItems}
        query=""
        onQuery={() => {}}
        archivedDiscussions={[]}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByLabelText("已审查").className).toContain("text-stamp");
    expect(screen.getByLabelText("曾审查未通过").className).toContain("text-destructive");
  });

  it("已封存详情页：已审查＝紫、曾审查未通过＝红", () => {
    for (const [reviewStatus, cls] of [
      ["reviewed", "text-stamp"],
      ["reviewedNotPassed", "text-destructive"],
    ] as const) {
      const { unmount } = render(
        <ArchivedDetailPage
          target={{ kind: "change", datedName: "2026-07-06-x" }}
          reviewStatus={reviewStatus}
          loadDocument={async () => null}
          loadCapabilities={async () => []}
          loadDiscussionDocument={async () => null}
        />,
      );
      const outcome = document.querySelector("[data-review-outcome]") as HTMLElement;
      expect(outcome.className).toContain(cls);
      expect(outcome.className).not.toContain("text-muted-foreground");
      unmount();
    }
  });

  it("「照样带走」按钮用危险动作的红（destructive；未通过章的 rose 只属标示）", () => {
    render(
      <ReviewArchiveDialog
        open
        change="demo"
        onOpenChange={vi.fn()}
        onGoStamp={vi.fn()}
        onDiscardReview={vi.fn()}
        onCarryReview={vi.fn()}
      />,
    );
    // 危险动作（按钮）走 destructive（错误与危险共用一个 token，不另设红系）。
    expect(screen.getByText("照样带走").className).toContain("text-destructive");
  });
});

describe("封存入口的未结工单三选项（ReviewArchiveDialog）", () => {
  function dialogProps() {
    return {
      open: true,
      change: "demo",
      onOpenChange: vi.fn(),
      onGoStamp: vi.fn(),
      onDiscardReview: vi.fn(),
      onCarryReview: vi.fn(),
    };
  }

  it("弹出三选项且未选择前不触发任何处置", () => {
    // spec Scenario「封存审查中的 change」：未选择前不运行封存。
    const p = dialogProps();
    render(<ReviewArchiveDialog {...p} />);
    expect(screen.getByText("前往完成盖章")).toBeTruthy();
    expect(screen.getByText("放弃审查")).toBeTruthy();
    expect(screen.getByText("照样带走")).toBeTruthy();
    expect(p.onGoStamp).not.toHaveBeenCalled();
    expect(p.onDiscardReview).not.toHaveBeenCalled();
    expect(p.onCarryReview).not.toHaveBeenCalled();
    // 照样带走的永久标示警语（spec：说明将永久显示「曾审查未通过」）。
    expect(screen.getByText(/曾审查未通过/)).toBeTruthy();
  });

  it("各选项触发对应处置", () => {
    const p = dialogProps();
    render(<ReviewArchiveDialog {...p} />);
    fireEvent.click(screen.getByText("前往完成盖章"));
    expect(p.onGoStamp).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("放弃审查"));
    expect(p.onDiscardReview).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("照样带走"));
    expect(p.onCarryReview).toHaveBeenCalledTimes(1);
  });
});

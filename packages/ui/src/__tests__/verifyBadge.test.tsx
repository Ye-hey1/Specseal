// 验证标示（spec desktop-app「看板卡片的验证标示」「详情抽屉的验证信息列」
// 「已封存侧的验证标示」「封存入口三选项扩及验证工单」；design D5）：卡片第二
// 颗行内小章与审查章并排、抽屉验证信息列、封存侧结局标示、站别化三选项对话框。
import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, fireEvent, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

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
const VERIFY_LABELS = ["验证中", "已验证", "已验证·其后有变动"];

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

describe("ChangeCard 验证章（四态）", () => {
  it("verified 显示「已验证」章", () => {
    render(
      <ChangeCard
        change={{
          ...base,
          verifyStatus: "verified",
          verifiedAt: "2026-08-02",
          verifiedBy: "Ver <v@example.com>",
        }}
      />,
    );
    expect(screen.getByLabelText("已验证")).toBeTruthy();
  });

  it("verifiedStale 显示降级章「已验证·其后有变动」", () => {
    render(<ChangeCard change={{ ...base, verifyStatus: "verifiedStale" }} />);
    expect(screen.getByLabelText("已验证·其后有变动")).toBeTruthy();
  });

  it("inVerify 显示「验证中」章", () => {
    render(<ChangeCard change={{ ...base, verifyStatus: "inVerify" }} />);
    expect(screen.getByLabelText("验证中")).toBeTruthy();
  });

  it("none（含缺席）无任何验证相关元素", () => {
    for (const change of [{ ...base, verifyStatus: "none" as const }, base]) {
      const { unmount } = render(<ChangeCard change={change} />);
      for (const label of VERIFY_LABELS) {
        expect(screen.queryByLabelText(label)).toBeNull();
      }
      unmount();
    }
  });

  it("两章并排且顺序固定（审查章在前、验证章在后）", () => {
    // spec Scenario「两章并排」：两站互不屏蔽，顺序固定才不会每次刷新换位。
    render(
      <ChangeCard change={{ ...base, reviewStatus: "reviewed", verifyStatus: "verified" }} />,
    );
    const review = screen.getByLabelText("已审查");
    const verify = screen.getByLabelText("已验证");
    expect(
      review.compareDocumentPosition(verify) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("仅验证章时不长出审查元素", () => {
    // spec Scenario「仅验证章」。
    render(
      <ChangeCard change={{ ...base, reviewStatus: "none", verifyStatus: "verifiedStale" }} />,
    );
    expect(screen.getByLabelText("已验证·其后有变动")).toBeTruthy();
    for (const label of ["审查中", "已审查", "已审查·其后有变动"]) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
  });
});

describe("两站同状态同色、异形可辨（design D5）", () => {
  it("同为盖章态时配色同值，图标分属徽章形与盾牌形", () => {
    // spec Scenario「两站同状态同色、异形可辨」：色承载状态、形承载站别。
    render(
      <ChangeCard change={{ ...base, reviewStatus: "reviewed", verifyStatus: "verified" }} />,
    );
    const review = screen.getByLabelText("已审查");
    const verify = screen.getByLabelText("已验证");
    expect(verify.className).toBe(review.className);
    // lucide 以 class 标记图标身分：徽章形 vs 盾牌形必须不同。
    const iconClass = (el: HTMLElement) => el.querySelector("svg")?.getAttribute("class") ?? "";
    expect(iconClass(verify)).toContain("shield");
    expect(iconClass(review)).not.toContain("shield");
  });

  it("三个 active 态的验证章配色与审查章对应态同值", () => {
    const pairs: Array<[ChangeItem["reviewStatus"], string, ChangeItem["verifyStatus"], string]> = [
      ["inReview", "审查中", "inVerify", "验证中"],
      ["reviewed", "已审查", "verified", "已验证"],
      ["reviewedStale", "已审查·其后有变动", "verifiedStale", "已验证·其后有变动"],
    ];
    for (const [reviewStatus, reviewLabel, verifyStatus, verifyLabel] of pairs) {
      const { unmount } = render(
        <ChangeCard change={{ ...base, reviewStatus, verifyStatus }} />,
      );
      expect(screen.getByLabelText(verifyLabel).className).toBe(
        screen.getByLabelText(reviewLabel).className,
      );
      expect(screen.getByLabelText(verifyLabel).className).not.toContain("text-muted-foreground");
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

describe("ChangeDetailPage 验证章签", () => {
  it("verified 章签落在品质关卡列：状态词＋盖章日期，验证者收进提示", () => {
    // 含 email 的完整识别不直出，收进主题化提示（提示内容由 changeDetailPage.test.tsx 验）。
    render(
      <ChangeDetailPage
        {...(drawerProps({
          ...base,
          verifyStatus: "verified",
          verifiedAt: "2026-08-02",
          verifiedBy: "Ver <v@example.com>",
        }) as never)}
      />,
    );
    const row = qualityStamp("[data-verify-row]");
    expect(within(row).getByText(/已验证/)).toBeTruthy();
    expect(row.textContent).toContain("2026-08-02");
    expect(row.textContent).not.toContain("v@example.com");
  });

  it("inVerify 仅显示状态词，无时间与验证者", () => {
    render(<ChangeDetailPage {...(drawerProps({ ...base, verifyStatus: "inVerify" }) as never)} />);
    const row = qualityStamp("[data-verify-row]");
    expect(within(row).getByText(/验证中/)).toBeTruthy();
    expect(row.textContent).not.toContain("2026-");
  });

  it("none 不渲染信息列", () => {
    render(<ChangeDetailPage {...(drawerProps({ ...base, verifyStatus: "none" }) as never)} />);
    expect(document.querySelector("[data-verify-row]")).toBeNull();
  });

  it("两站信息列同构并列", () => {
    render(
      <ChangeDetailPage
        {...(drawerProps({
          ...base,
          reviewStatus: "reviewed",
          reviewedAt: "2026-08-01",
          verifyStatus: "verified",
          verifiedAt: "2026-08-02",
        }) as never)}
      />,
    );
    const review = document.querySelector("[data-review-row]") as HTMLElement;
    const verify = document.querySelector("[data-verify-row]") as HTMLElement;
    expect(review && verify).toBeTruthy();
    expect(verify.className).toBe(review.className);
    expect(
      review.compareDocumentPosition(verify) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("已封存侧验证结局标示", () => {
  const plain: ArchivedItem = { datedName: "2026-08-04-plain", date: "2026-08-04", name: "plain" };
  const passed: ArchivedItem = {
    datedName: "2026-08-05-passed",
    date: "2026-08-05",
    name: "passed",
    verifyStatus: "verified",
  };
  const carried: ArchivedItem = {
    datedName: "2026-08-06-carried",
    date: "2026-08-06",
    name: "carried",
    reviewStatus: "reviewed",
    verifyStatus: "verifiedNotPassed",
  };

  it("清单卡依结局标示，且与审查结局并存", () => {
    // spec Scenario「曾验证未通过」＋「与审查结局标示可并存」。
    render(
      <ArchivedList
        archived={[plain, passed, carried]}
        query=""
        onQuery={() => {}}
        archivedDiscussions={[]}
        onOpen={() => {}}
      />,
    );
    const card = (name: string) =>
      document.querySelector(`[data-archived="${name}"]`) as HTMLElement;
    expect(within(card("2026-08-05-passed")).getByLabelText("已验证")).toBeTruthy();
    const both = card("2026-08-06-carried");
    expect(within(both).getByLabelText("曾验证未通过")).toBeTruthy();
    expect(within(both).getByLabelText("已审查")).toBeTruthy();
    for (const label of ["已验证", "曾验证未通过"]) {
      expect(within(card("2026-08-04-plain")).queryByLabelText(label)).toBeNull();
    }
    expect(screen.getByLabelText("曾验证未通过").className).toContain("text-destructive");
  });

  it("已封存详情页显示「曾验证未通过」标示", () => {
    render(
      <ArchivedDetailPage
        target={{ kind: "change", datedName: "2026-08-06-carried" }}
        verifyStatus="verifiedNotPassed"
        loadDocument={async () => null}
        loadCapabilities={async () => []}
        loadDiscussionDocument={async () => null}
      />,
    );
    const outcome = document.querySelector("[data-verify-outcome]") as HTMLElement;
    expect(outcome).toBeTruthy();
    expect(outcome.textContent).toContain("曾验证未通过");
    expect(outcome.className).toContain("text-destructive");
  });
});

describe("封存入口三选项扩及验证工单（ReviewArchiveDialog station=verify）", () => {
  function dialogProps() {
    return {
      open: true,
      change: "demo",
      station: "verify" as const,
      onOpenChange: vi.fn(),
      onGoStamp: vi.fn(),
      onDiscardReview: vi.fn(),
      onCarryReview: vi.fn(),
    };
  }

  it("弹出验证站文案的三选项且未选择前不触发任何处置", () => {
    // spec Scenario「封存验证中的 change」：未选择前不运行封存。
    const p = dialogProps();
    render(<ReviewArchiveDialog {...p} />);
    expect(screen.getByText("前往完成验证盖章")).toBeTruthy();
    expect(screen.getByText("放弃验证")).toBeTruthy();
    expect(screen.getByText("照样带走")).toBeTruthy();
    expect(screen.getByText(/曾验证未通过/)).toBeTruthy();
    expect(p.onGoStamp).not.toHaveBeenCalled();
    expect(p.onDiscardReview).not.toHaveBeenCalled();
    expect(p.onCarryReview).not.toHaveBeenCalled();
  });

  it("各选项触发对应处置", () => {
    const p = dialogProps();
    render(<ReviewArchiveDialog {...p} />);
    fireEvent.click(screen.getByText("前往完成验证盖章"));
    expect(p.onGoStamp).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("放弃验证"));
    expect(p.onDiscardReview).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("照样带走"));
    expect(p.onCarryReview).toHaveBeenCalledTimes(1);
  });

  it("station 缺省为审查站（既有调用端行为不变）", () => {
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
    expect(screen.getByText("前往完成盖章")).toBeTruthy();
    expect(screen.getByText("放弃审查")).toBeTruthy();
  });
});

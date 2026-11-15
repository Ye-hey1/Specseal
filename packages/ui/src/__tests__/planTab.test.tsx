// 详情页的调度分页（spec desktop-app「详情页的调度分页」；plan-requirement-overlap-desktop
// design「调度分页卡片化，阻挡并入前置卡的状态徽章」）：四张边框卡片（波次、前置、重叠、
// 封存顺序）、前置卡的状态徽章、前置的添加与移除经 onSetDepends、无 onSetDepends
// （capability 假）时不长编辑控制项、缺 wave 时只剩一句说明。
import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, waitFor, fireEvent, within, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider, translatorFor } from "../i18n";
import { ChangeDetailPage, type ChangeDetailPageProps } from "../components/ChangeDetailPage";
import type { ChangeItem, DeltaOperation } from "../adapter";
import { DELTA_COLORS } from "../components/DeltaBadges";
import { planSummary } from "../components/PlanDoc";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

afterEach(() => cleanup());

const base = { status: "proposed", totalTasks: 3, completedTasks: 0 };
/** add-c 与 add-b 同动 desktop-app 的「看板与任务」（双方 MODIFIED，不冲突）。 */
const boardRow = {
  change: "add-b",
  capability: "desktop-app",
  requirement: "看板与任务",
  ownOperation: "MODIFIED",
  otherOperation: "MODIFIED",
  conflict: false,
} as const;
/** Scenario「可开工徽章与同名冲突标签」的数据：add-c 与 add-x 都 ADDED auth 的「登录」。 */
const clash: ChangeItem = {
  name: "add-c",
  ...base,
  wave: 1,
  blockedBy: [],
  dependsOn: [],
  overlaps: [],
  requirementOverlap: [
    { change: "add-x", capability: "auth", requirement: "登录", ownOperation: "ADDED", otherOperation: "ADDED", conflict: true },
  ],
  archiveAfter: [],
};
/** 四个作用中变更：add-c 是抽屉主角（Scenario「调度分页四段」的数据：第 2 波、前置
 * add-a、与 add-b 同动一个 requirement、排在 add-b 之后封存）。 */
const changes: ChangeItem[] = [
  { name: "add-a", ...base, wave: 1, blockedBy: [], dependsOn: [], overlaps: [], requirementOverlap: [], archiveAfter: [] },
  {
    name: "add-b",
    ...base,
    wave: 2,
    blockedBy: ["add-a"],
    dependsOn: ["add-a"],
    overlaps: [{ change: "add-c", capabilities: ["desktop-app"] }],
    requirementOverlap: [{ ...boardRow, change: "add-c" }],
    archiveAfter: [],
  },
  {
    name: "add-c",
    ...base,
    wave: 2,
    dependsOn: ["add-a"],
    blockedBy: ["add-a"],
    overlaps: [{ change: "add-b", capabilities: ["desktop-app"] }],
    requirementOverlap: [boardRow],
    archiveAfter: ["add-b"],
  },
  { name: "add-d", ...base, wave: 3, blockedBy: ["add-c"], dependsOn: ["add-c"], overlaps: [], requirementOverlap: [], archiveAfter: [] },
];

function makeProps(over: Partial<ChangeDetailPageProps> = {}): ChangeDetailPageProps {
  return {
    change: changes[2],
    changes,
    loadDocument: vi.fn(async () => "# doc"),
    loadCapabilities: vi.fn(async () => ["desktop-app"]),
    loadMeta: vi.fn(async () => null),
    onSetDepends: vi.fn(),
    ...over,
  };
}

async function openPlanTab(props: ChangeDetailPageProps) {
  render(<ChangeDetailPage {...props} />);
  await waitFor(() => screen.getByRole("tab", { name: /调度/ }));
  fireEvent.mouseDown(screen.getByRole("tab", { name: /调度/ }));
  await waitFor(() => screen.getByRole("tabpanel"));
}

const section = (name: string) =>
  document.querySelector(`[data-plan-section="${name}"]`) as HTMLElement;
/** 卡片的标题列（PlanCard 的 data 锚点，不靠 DOM 位置）。 */
const header = (name: string) => section(name).querySelector("[data-plan-card-header]") as HTMLElement;

describe("调度分页", () => {
  it("分页在规格分页之后，四张边框卡片依序：波次、前置（附移除钮与添加下拉）、重叠、封存顺序", async () => {
    // Scenario「调度分页四段」的卡片骨架；重叠卡与封存顺序卡的内容另有专测。
    const props = makeProps();
    await openPlanTab(props);
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent ?? "");
    expect(tabs.findIndex((t) => t.includes("调度"))).toBe(tabs.findIndex((t) => t.includes("规格")) + 1);

    const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-plan-section]"));
    expect(cards.map((c) => c.dataset.planSection)).toEqual(["wave", "depends", "overlaps", "archive"]);
    // 与审查／验证分页同一种边框卡片：标题列带卡片标题、内容区以分隔线分格。
    const titles = ["波次", "前置", "重叠", "封存顺序"];
    cards.forEach((card, i) => {
      expect(card.className).toContain("rounded-md border border-border/60 bg-muted/20");
      expect(within(header(card.dataset.planSection!)).getByText(titles[i])).toBeTruthy();
      expect(card.querySelector("[data-plan-card-body]")?.className).toContain("border-t border-border/60");
    });

    const wave = section("wave");
    expect(within(wave).getByText("第 2 波")).toBeTruthy();
    expect(within(wave).getByText("add-b")).toBeTruthy(); // 同波伙伴
    expect(within(wave).queryByText("add-c")).toBeNull(); // 不列自己

    const depends = section("depends");
    expect(within(depends).getByText("add-a")).toBeTruthy();
    expect(within(depends).getByRole("button", { name: "移除前置 add-a" })).toBeTruthy();
    expect(within(depends).getByRole("combobox", { name: "添加前置" })).toBeTruthy();
    expect(within(section("overlaps")).queryByRole("button")).toBeNull(); // 唯读
  });

  it("depends_card_badge_ready_and_waiting：前置卡标题列的状态徽章，blockedBy 空为「可以开工」、非空为「等 N 项」且 title 列出前置名", async () => {
    const waitingOn: ChangeItem = { ...changes[2], dependsOn: ["add-a", "add-c"], blockedBy: ["add-a", "add-c"] };
    await openPlanTab(makeProps({ change: waitingOn }));
    const waiting = within(header("depends")).getByText("等 2 项");
    expect(waiting.getAttribute("title")).toBe("等待：add-a、add-c");
    expect(waiting.className).not.toContain("bg-secondary"); // outline
    expect(within(section("depends")).queryByText("可以开工")).toBeNull();
    cleanup();

    await openPlanTab(makeProps({ change: changes[0] }));
    const ready = within(header("depends")).getByText("可以开工");
    expect(ready.className).toContain("bg-muted"); // secondary
    expect(within(section("depends")).queryByText(/等 \d+ 项/)).toBeNull();
  });

  it("overlaps_card_lists_requirement_level_rows：重叠卡每列对方名、`capability › requirement` 与双方操作两枚标签，不显示目录级 overlaps", async () => {
    // Scenario「调度分页四段」的重叠卡；目录级 overlaps 另有 add-d（tray-status-menu），不得出现。
    const item: ChangeItem = {
      ...changes[2],
      overlaps: [...(changes[2].overlaps ?? []), { change: "add-d", capabilities: ["tray-status-menu"] }],
    };
    await openPlanTab(makeProps({ change: item }));
    const overlaps = section("overlaps");
    const rows = within(overlaps).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("add-b")).toBeTruthy();
    expect(within(rows[0]).getByText("desktop-app › 看板与任务")).toBeTruthy();
    // 操作标签与规格分页的 delta 区段同一套用词与配色（MODIFIED → 「修改」）。
    const ops = within(rows[0]).getAllByText("修改");
    expect(ops.map((op) => op.getAttribute("title"))).toEqual(["add-c", "add-b"]); // 本变更在前、对方在后
    for (const op of ops) {
      expect(op.className).toContain("rounded border border-border/60 px-1 py-0.5 text-[10px]");
      expect(op.className).toContain(DELTA_COLORS.modified);
    }
    expect(within(rows[0]).queryByText("同名冲突")).toBeNull();
    expect(within(overlaps).queryByText("add-d")).toBeNull();
    expect(within(overlaps).queryByText("tray-status-menu")).toBeNull();
    expect(within(overlaps).queryByRole("button")).toBeNull(); // 唯读
    cleanup();

    await openPlanTab(makeProps({ change: changes[0] }));
    expect(within(section("overlaps")).getByText("无重叠")).toBeTruthy();
  });

  it("conflict_row_shows_name_conflict_tag：conflict 为 true 的重叠列多一枚 destructive 色「同名冲突」标签", async () => {
    // Scenario「可开工徽章与同名冲突标签」：两者都 ADDED auth 的「登录」。
    await openPlanTab(makeProps({ change: clash, changes: [clash] }));
    expect(within(header("depends")).getByText("可以开工")).toBeTruthy();
    const row = within(section("overlaps")).getByRole("listitem");
    expect(within(row).getByText("add-x")).toBeTruthy();
    expect(within(row).getByText("auth › 登录")).toBeTruthy();
    expect(within(row).getAllByText("添加")).toHaveLength(2);
    expect(within(row).getByText("同名冲突").className).toContain("text-destructive");
  });

  it("archive_card_lists_names_and_hint：封存顺序卡列 archiveAfter 的变更名，下方一句提示", async () => {
    // Scenario「调度分页四段」的封存顺序卡：add-b 与提示句。
    await openPlanTab(makeProps());
    const archive = section("archive");
    expect(within(archive).getByText("add-b")).toBeTruthy();
    expect(within(archive).getByText("先封存它们，再对照正式规格重写同名 requirement 后封存本变更")).toBeTruthy();
    expect(within(archive).queryByText("可直接封存")).toBeNull();
  });

  it("archive_card_empty_state：archiveAfter 为空时显示「可直接封存」、不出提示句", async () => {
    // 需求本文：archiveAfter 为空且无同名冲突时「可直接封存」（有冲突时改显示警示，见
    // archive_card_warns_name_conflict）。
    await openPlanTab(makeProps({ change: changes[0] }));
    const archive = section("archive");
    expect(within(archive).getByText("可直接封存")).toBeTruthy();
    expect(within(archive).queryByText(/先封存它们/)).toBeNull();
  });

  it("archive_card_warns_name_conflict：有同名冲突列时封存卡显示冲突警示，不显示「可直接封存」", async () => {
    // Scenario「可开工徽章与同名冲突标签」的封存顺序卡：两者都 ADDED「登录」，引擎不把对方
    // 列进 archiveAfter，但较晚封存的一方一定被拒。
    await openPlanTab(makeProps({ change: clash, changes: [clash] }));
    const archive = section("archive");
    const warning = within(archive).getByText("与 add-x 同名冲突：先改掉其中一边，较晚封存的一方才不会被拒");
    expect(warning.className).toContain("text-destructive");
    expect(within(archive).queryByText("可直接封存")).toBeNull();
  });

  it("archive_card_warns_mutual_wait：与对方互相列入 archiveAfter 时封存卡显示互相等待警示", async () => {
    // Scenario「互相等待时封存卡警示」：add-a 要等 add-b 带进的「R1」，add-b 要等 add-a
    // 修改完才能拿走「R2」——两边都得先等对方封存。
    const row = (change: string, requirement: string, own: DeltaOperation, other: DeltaOperation) => ({
      change,
      capability: "desktop-app",
      requirement,
      ownOperation: own,
      otherOperation: other,
      conflict: false,
    });
    const a: ChangeItem = {
      name: "add-a",
      ...base,
      wave: 1,
      blockedBy: [],
      dependsOn: [],
      overlaps: [{ change: "add-b", capabilities: ["desktop-app"] }],
      requirementOverlap: [row("add-b", "R1", "MODIFIED", "ADDED"), row("add-b", "R2", "MODIFIED", "REMOVED")],
      archiveAfter: ["add-b"],
    };
    const b: ChangeItem = {
      ...a,
      name: "add-b",
      overlaps: [{ change: "add-a", capabilities: ["desktop-app"] }],
      requirementOverlap: [row("add-a", "R1", "ADDED", "MODIFIED"), row("add-a", "R2", "REMOVED", "MODIFIED")],
      archiveAfter: ["add-a"],
    };
    await openPlanTab(makeProps({ change: a, changes: [a, b] }));
    const archive = section("archive");
    expect(within(archive).getByText("add-b")).toBeTruthy();
    const warning = within(archive).getByText("与 add-b 互相等待：两边都要先等对方封存，须调整拆分");
    expect(warning.className).toContain("text-destructive");
    cleanup();

    // 单向的封存顺序不出警示。
    await openPlanTab(makeProps());
    expect(within(section("archive")).queryByText(/互相等待/)).toBeNull();
  });

  it("old_server_missing_fields_show_empty_states：带 wave 但缺 requirementOverlap 与 archiveAfter（旧 server）时两卡显示空态", async () => {
    // Scenario「旧 server 缺新字段的空态」：其余两卡照常。
    const old: ChangeItem = { name: "add-c", ...base, wave: 2, blockedBy: ["add-a"], dependsOn: ["add-a"], overlaps: [] };
    await openPlanTab(makeProps({ change: old, changes: [changes[0], old] }));
    expect(within(section("overlaps")).getByText("无重叠")).toBeTruthy();
    expect(within(section("archive")).getByText("可直接封存")).toBeTruthy();
    expect(within(section("wave")).getByText("第 2 波")).toBeTruthy();
    expect(within(section("depends")).getByText("等 1 项")).toBeTruthy();
  });

  it("old_server_overlap_waits_listed_in_depends_card：blockedBy 含 dependsOn 以外的名称（旧 server 依重叠判定阻挡）时，前置卡以唯读列列出，徽章数字与内容一致", async () => {
    // Scenario「旧 server 的重叠阻挡列在前置卡」：0.7.0 server 的 blockedBy＝声明前置 ∪
    // 先配置、共用 capability 的变更，且没有 requirementOverlap 与 archiveAfter。
    const old: ChangeItem = {
      name: "add-c",
      ...base,
      wave: 2,
      blockedBy: ["add-a"],
      dependsOn: [],
      overlaps: [{ change: "add-a", capabilities: ["desktop-app"] }],
    };
    await openPlanTab(makeProps({ change: old, changes: [changes[0], old] }));
    const depends = section("depends");
    expect(within(header("depends")).getByText("等 1 项")).toBeTruthy();
    expect(within(depends).getByText("尚无前置")).toBeTruthy();
    const waits = depends.querySelector("[data-plan-undeclared-waits]") as HTMLElement;
    expect(within(waits).getByText("另需等待（server 依重叠判定）：")).toBeTruthy();
    expect(within(waits).getByText("add-a")).toBeTruthy();
    expect(within(depends).queryByRole("button", { name: "移除前置 add-a" })).toBeNull(); // 没声明，无从移除
    cleanup();

    // 新 server 与本机：blockedBy 只含声明前置，不出现这一列。
    await openPlanTab(makeProps());
    expect(within(section("depends")).queryByText(/另需等待/)).toBeNull();
  });

  it("no_blocked_section_rendered：阻挡并入前置卡徽章，页面不存在 data-plan-section=\"blocked\"", async () => {
    await openPlanTab(makeProps());
    expect(section("blocked")).toBeNull();
    expect(screen.queryByText("阻挡")).toBeNull();
    expect(within(section("depends")).getByText("等 1 项")).toBeTruthy();
  });

  it("下拉只列其他作用中变更（排除自己与既有前置），选择即 onSetDepends(change, [name], false)", async () => {
    // Scenario「添加前置写回」的触发面。
    const props = makeProps();
    await openPlanTab(props);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole("combobox", { name: "添加前置" }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["add-b", "add-d"]);
    await user.click(screen.getByRole("option", { name: "add-d" }));
    expect(props.onSetDepends).toHaveBeenCalledWith("add-c", ["add-d"], false);
  });

  it("数据源提供名册查找时，候选以查找结果为准（worktree 映射时的副本名册）", async () => {
    // Scenario「worktree 映射时候选来自副本名册」的 UI 面：清单有 add-b、add-d，
    // 名册只有 add-a、add-b——add-a 已是前置、add-d 不在名册，下拉只剩 add-b。
    const loadDependsCandidates = vi.fn(async () => ["add-a", "add-b"]);
    const props = makeProps({ loadDependsCandidates });
    await openPlanTab(props);
    expect(loadDependsCandidates).toHaveBeenCalledWith("add-c");
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(await screen.findByRole("combobox", { name: "添加前置" }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["add-b"]);
  });

  it("名册查找未完成时不长添加下拉，失败时退回自清单派生", async () => {
    const pending = makeProps({ loadDependsCandidates: vi.fn(() => new Promise<string[]>(() => {})) });
    await openPlanTab(pending);
    expect(within(section("depends")).getByText("add-a")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "添加前置" })).toBeNull();
    cleanup();

    const failing = makeProps({ loadDependsCandidates: vi.fn(async () => Promise.reject(new Error("boom"))) });
    await openPlanTab(failing);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(await screen.findByRole("combobox", { name: "添加前置" }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["add-b", "add-d"]);
  });

  it("重新加载时名册查找失败，沿用上一次的名册，不退回自清单派生", async () => {
    // 首载取得名册 add-a、add-b；刷新世代前进后查找失败——候选仍只有 add-b（add-d 不在名册）。
    const loadDependsCandidates = vi
      .fn<(change: string) => Promise<string[]>>()
      .mockResolvedValueOnce(["add-a", "add-b"])
      .mockRejectedValue(new Error("boom"));
    const props = makeProps({ loadDependsCandidates, refreshGen: 0 });
    const { rerender } = render(<ChangeDetailPage {...props} />);
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /调度/ }));
    await screen.findByRole("combobox", { name: "添加前置" });
    rerender(<ChangeDetailPage {...props} refreshGen={1} />);
    await waitFor(() => expect(loadDependsCandidates).toHaveBeenCalledTimes(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(await screen.findByRole("combobox", { name: "添加前置" }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["add-b"]);
  });

  it("移除钮触发 onSetDepends(change, [name], true)", async () => {
    const props = makeProps();
    await openPlanTab(props);
    fireEvent.click(screen.getByRole("button", { name: "移除前置 add-a" }));
    expect(props.onSetDepends).toHaveBeenCalledWith("add-c", ["add-a"], true);
  });

  it("无 onSetDepends（capability 为假）时不渲染移除钮与下拉，四卡照常", async () => {
    // Scenario「remote 分页唯读」。
    const props = makeProps({ onSetDepends: undefined });
    await openPlanTab(props);
    expect(within(section("depends")).getByText("add-a")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /移除前置/ })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "添加前置" })).toBeNull();
    for (const name of ["wave", "depends", "overlaps", "archive"]) {
      expect(section(name)).toBeTruthy();
    }
  });

  it("同波无他人显示「本波只有这个变更」", async () => {
    const solo: ChangeItem = { name: "add-a", ...base, wave: 1, blockedBy: [], dependsOn: [], overlaps: [] };
    const props = makeProps({ change: solo, changes: [solo, changes[3]] });
    await openPlanTab(props);
    expect(within(section("wave")).getByText("本波只有这个变更")).toBeTruthy();
  });

  it("cycle_renders_only_depends_card_without_badge：plan 成环（缺 wave 但带 dependsOn）时一句成环说明＋只有前置卡，无徽章、无下拉", async () => {
    // Scenario「成环时可移除前置」：payload 成环时 dependsOn 仍为 meta 原文，分页只给
    // 解环的出口（移除钮），不长状态徽章与添加下拉，也不长波次／重叠／封存顺序卡。
    const cyc: ChangeItem = { name: "add-c", ...base, dependsOn: ["add-a"] };
    const props = makeProps({ change: cyc, changes: [cyc, { name: "add-a", ...base, dependsOn: ["add-c"] }] });
    await openPlanTab(props);
    expect(within(screen.getByRole("tabpanel")).getByText("依赖成环，先移除一条前置才有调度信息")).toBeTruthy();
    expect(within(screen.getByRole("tabpanel")).queryByText("此模式尚未提供调度信息")).toBeNull();
    const depends = section("depends");
    expect(within(depends).getByText("add-a")).toBeTruthy();
    fireEvent.click(within(depends).getByRole("button", { name: "移除前置 add-a" }));
    expect(props.onSetDepends).toHaveBeenCalledWith("add-c", ["add-a"], true);
    expect(screen.queryByRole("combobox", { name: "添加前置" })).toBeNull();
    expect(within(depends).queryByText(/可以开工|等 \d+ 项/)).toBeNull();
    expect(Array.from(document.querySelectorAll<HTMLElement>("[data-plan-section]")).map((c) => c.dataset.planSection)).toEqual([
      "depends",
    ]);
  });

  it("plan 成环时环外的变更（dependsOn 为空）前置卡显示「尚无前置」，不是空框", async () => {
    // local 任一处成环，环外每个有效项都带 dependsOn: []（query.rs 以 meta 声明原文填）。
    const outside: ChangeItem = { name: "add-e", ...base, dependsOn: [] };
    await openPlanTab(makeProps({ change: outside, changes: [outside] }));
    expect(within(screen.getByRole("tabpanel")).getByText("依赖成环，先移除一条前置才有调度信息")).toBeTruthy();
    expect(within(section("depends")).getByText("尚无前置")).toBeTruthy();
    expect(within(section("depends")).queryByRole("button", { name: /移除前置/ })).toBeNull();
  });

  it("plan 成环且 capability 为假：前置卡唯读（无移除钮）", async () => {
    const cyc: ChangeItem = { name: "add-c", ...base, dependsOn: ["add-a"] };
    const props = makeProps({ change: cyc, changes: [cyc], onSetDepends: undefined });
    await openPlanTab(props);
    expect(within(section("depends")).getByText("add-a")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /移除前置/ })).toBeNull();
  });

  it("缺 wave 且缺 dependsOn（remote 摘要）时只显示一句说明，不渲染四卡", async () => {
    const bare: ChangeItem = { name: "add-c", ...base };
    const props = makeProps({ change: bare, changes: [bare] });
    await openPlanTab(props);
    expect(within(screen.getByRole("tabpanel")).getByText("此模式尚未提供调度信息")).toBeTruthy();
    expect(document.querySelector("[data-plan-section]")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "添加前置" })).toBeNull();
  });
});

// spec「详情页的调度分页」的签槽、数字砖与两态提示框（desktop-change-doc-views design D7）。
describe("调度文档的签、数字砖与提示框", () => {
  const i18n = translatorFor("zh-CN");
  const show = (node: ReactNode) => render(<>{node}</>).container;
  const empty: ChangeItem = {
    name: "add-z",
    ...base,
    wave: 1,
    blockedBy: [],
    dependsOn: [],
    overlaps: [],
    requirementOverlap: [],
    archiveAfter: [],
  };

  it("调度分页四段的数据：签「等 1 项」、砖 2／1／1／1、warning 标题「等 1 项前置，封存前要等 1 个变更」并列出名称", () => {
    const summary = planSummary(changes[2], i18n);
    expect(show(summary.badges).textContent).toBe("等 1 项");
    expect(summary.tiles.map((x) => [x.label, x.value])).toEqual([
      ["波次", 2],
      ["声明的前置", 1],
      ["同名需求重叠", 1],
      ["封存前要等", 1],
    ]);
    cleanup();
    const callout = show(summary.callout);
    expect(callout.querySelector(".markdown-alert-title")!.textContent).toBe("等 1 项前置，封存前要等 1 个变更");
    expect(callout.firstElementChild!.className).toContain("bg-status-warning/10");
    expect(callout.textContent).toContain("add-a");
    expect(callout.textContent).toContain("add-b");
    expect(callout.textContent).toContain("调度会在看板刷新时重算。");
  });

  it("全空数据：签「可以开工」、tip 标题「可以开工，也可直接封存」", () => {
    const summary = planSummary(empty, i18n);
    expect(show(summary.badges).textContent).toBe("可以开工");
    expect(summary.tiles.map((x) => x.value)).toEqual([1, 0, 0, 0]);
    cleanup();
    const callout = show(summary.callout);
    expect(callout.querySelector(".markdown-alert-title")!.textContent).toBe("可以开工，也可直接封存");
    expect(callout.firstElementChild!.className).toContain("bg-status-success/10");
  });

  // Example「提示框标题的两个子句」。
  it.each([
    [[], [], false, "可以开工，也可直接封存", "success"],
    [["add-a"], [], false, "等 1 项前置，可直接封存", "warning"],
    [[], ["add-b"], false, "可以开工，封存前要等 1 个变更", "warning"],
    [["add-a"], ["add-b"], false, "等 1 项前置，封存前要等 1 个变更", "warning"],
    [[], [], true, "可以开工，有同名冲突要先改", "warning"],
  ])("blockedBy %j、archiveAfter %j、冲突 %s → %s", (blockedBy, archiveAfter, conflict, title, tone) => {
    const item: ChangeItem = {
      ...empty,
      blockedBy,
      dependsOn: blockedBy,
      archiveAfter,
      requirementOverlap: conflict ? clash.requirementOverlap : [],
    };
    const callout = show(planSummary(item, i18n).callout);
    expect(callout.querySelector(".markdown-alert-title")!.textContent).toBe(title);
    expect(callout.firstElementChild!.className).toContain(`bg-status-${tone}/10`);
  });

  it("缺 wave 时签、砖与提示框皆空；页上无 data-doc-tiles 与 data-doc-callout", async () => {
    const bare: ChangeItem = { name: "add-c", ...base };
    expect(planSummary(bare, i18n)).toEqual({ badges: null, tiles: [], callout: null });
    await openPlanTab(makeProps({ change: bare, changes: [bare] }));
    expect(document.querySelector("[data-doc-tiles]")).toBeNull();
    expect(document.querySelector("[data-doc-callout]")).toBeNull();
  });

  it("四张卡头为 16px 粗体标题并进本页目录；重叠卡与封存顺序卡右端附笔数签", async () => {
    await openPlanTab(makeProps());
    for (const name of ["wave", "depends", "overlaps", "archive"]) {
      const heading = header(name).querySelector("h3[data-doc-heading]") as HTMLElement;
      expect(heading.className).toContain("text-base");
      expect(heading.className).toContain("font-semibold");
    }
    expect(header("overlaps").lastElementChild!.textContent).toBe("1");
    expect(header("archive").lastElementChild!.textContent).toBe("1");
  });
});

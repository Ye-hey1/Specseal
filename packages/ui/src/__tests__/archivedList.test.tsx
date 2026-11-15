// spec 需求「已封存页含讨论节」（页标题区搜索、卡片标头式分页、两节列式清单、点列
// 开抽屉、搜索同时过滤）＋「规格与封存卡片收合信息」（封存变更列与封存讨论列）：
// 行内展开全数移除（正典「已封存变更可展开查看」依 delta 移除，查看由抽屉承接）。
import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";
import { ArchivedList } from "../components/ArchivedList";
import type { ArchivedItem, DiscussionItem } from "../adapter";

// 既有中文断言包 I18nProvider locale zh-CN 后照旧断言（i18n 抽 key 的回归保护）。
const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

// spec Example「封存变更卡任务徽章配色分级」：20/21 未全完成（警示）＋48/48 全完成。
const WARN: ArchivedItem = {
  datedName: "2026-07-03-incomplete-change",
  date: "2026-07-03",
  name: "incomplete-change",
  tasksTotal: 21,
  tasksDone: 20,
  specCount: 3,
  createdBy: "MomoChen <momo@example.com>",
  fromDiscussions: ["alpha-ux", "beta-flow"],
  whyExcerpt: "已封存页停留在旧设计，与看板既有的呈现脱节。",
};

const FULL: ArchivedItem = {
  datedName: "2026-07-05-desktop-shell-and-browser",
  date: "2026-07-05",
  name: "desktop-shell-and-browser",
  tasksTotal: 48,
  tasksDone: 48,
  specCount: 1,
  createdBy: null,
  fromDiscussions: [],
};

const BARE: ArchivedItem = {
  datedName: "2026-07-01-no-tasks",
  date: "2026-07-01",
  name: "no-tasks",
  specCount: 0,
  createdBy: null,
  fromDiscussions: [],
};

const DISCUSSION: DiscussionItem = {
  slug: "old-topic",
  topic: "Old settled topic",
  status: "promoted",
  rounds: 2,
  created: "2026-06-30",
  promotedTo: ["first-cut"],
};

function renderList(
  items: ArchivedItem[] = [WARN, FULL, BARE],
  over: Record<string, unknown> = {},
) {
  const onOpen = vi.fn();
  render(
    <ArchivedList
      archived={items}
      query=""
      onQuery={() => {}}
      archivedDiscussions={[DISCUSSION]}
      onOpen={onOpen}
      {...(over as object)}
    />,
  );
  return onOpen;
}

const card = (sel: string) => document.querySelector(sel) as HTMLElement;

describe("ArchivedList（封存变更卡）", () => {
  it("点列触发 onOpen（change target）；列为共用 ListRow（日期在最左、等宽标题、› 收尾）、无行内展开", () => {
    const onOpen = renderList();
    fireEvent.click(screen.getByText("desktop-shell-and-browser"));
    expect(onOpen).toHaveBeenCalledWith({
      kind: "change",
      datedName: "2026-07-05-desktop-shell-and-browser",
    });
    const clicked = card('[data-archived="2026-07-05-desktop-shell-and-browser"]');
    expect(clicked.getAttribute("role")).toBe("button");
    expect(clicked.firstElementChild!.textContent).toBe("2026-07-05");
    expect(within(clicked).getByText("desktop-shell-and-browser").className).toContain("font-mono");
    expect(clicked.querySelector(".lucide-chevron-right")).toBeTruthy();
    // 行内展开移除：列内不出现分页（页面级「变更／讨论」分页除外）、无 chevron-down、无 aria-expanded。
    expect(within(clicked).queryByRole("tab")).toBeNull();
    expect(clicked.querySelector(".lucide-chevron-down")).toBeNull();
    expect(clicked.querySelector("[aria-expanded]")).toBeNull();
  });

  it("任务徽章配色分级：未全完成琥珀警示、全完成一般样式、无 tasks.md 不显示", () => {
    renderList();
    // spec Example：前者警示样式显示 20/21，后者一般样式显示 48/48。
    const warnBadge = screen.getByText("20/21");
    expect(warnBadge.className).toContain("status-warning");
    const fullBadge = screen.getByText("48/48");
    expect(fullBadge.className).not.toContain("status-warning");
    // 任务数徽章维持 pill（状态徽章例外，design D7 增补）。
    expect(warnBadge.className).toContain("rounded-full");
    expect(fullBadge.className).toContain("rounded-full");
    // 无 tasks.md 的封存项不显示徽章。
    const bare = card('[data-archived="2026-07-01-no-tasks"]');
    expect(bare).toBeTruthy();
    expect(within(bare).queryByText(/\d+\/\d+/)).toBeNull();
  });

  it("卡片收合信息：触及规格数、createdBy 头像圆点 tooltip、来源讨论标记缺席不显示", () => {
    renderList();
    const warn = card('[data-archived="2026-07-03-incomplete-change"]');
    // 触及规格数。
    expect(within(warn).getByLabelText("触及 3 份规格")).toBeTruthy();
    // createdBy 头像圆点（与 ChangeCard 同款：首字母圆标、aria-label 全名）。
    const avatar = within(warn).getByLabelText("MomoChen <momo@example.com>");
    expect(avatar.textContent).toBe("M");
    // 静态 metadata 走中性（与变更卡、讨论卡同款）。
    expect(avatar.className).toContain("bg-muted");
    expect(avatar.className).not.toContain("bg-primary");
    // 来源讨论 icon（tooltip 列 slug）。
    expect(within(warn).getByLabelText("来自讨论")).toBeTruthy();
    // 缺席语意：无 createdBy／无来源讨论的卡不显示对应标记。
    const full = card('[data-archived="2026-07-05-desktop-shell-and-browser"]');
    expect(within(full).queryByLabelText("来自讨论")).toBeNull();
    // specCount 0 → 触及规格标记缺席。
    const bare = card('[data-archived="2026-07-01-no-tasks"]');
    expect(within(bare).queryByLabelText(/触及/)).toBeNull();
  });

  it("拷贝钮位于标题群组内，点击拷贝封存名称且不开抽屉", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onOpen = renderList();
    const full = card('[data-archived="2026-07-05-desktop-shell-and-browser"]');
    const group = full.querySelector("[data-title-group]") as HTMLElement;
    expect(group).toBeTruthy();
    expect(within(group).getByText("desktop-shell-and-browser")).toBeTruthy();
    fireEvent.click(within(group).getByLabelText("拷贝封存名称"));
    expect(writeText).toHaveBeenCalledWith("2026-07-05-desktop-shell-and-browser");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("描述列显示 Why 首句一行截断；whyExcerpt 缺席时整列缺席（与看板变更卡同构）", () => {
    // spec Example「封存变更卡显示 Why 首句描述列」：可得者标题下方一行截断，
    // 缺席者描述列整列缺席、卡片退回单行。
    renderList();
    const warn = card('[data-archived="2026-07-03-incomplete-change"]');
    const desc = warn.querySelector("[data-desc]") as HTMLElement;
    expect(desc).toBeTruthy();
    expect(desc.textContent).toBe("已封存页停留在旧设计，与看板既有的呈现脱节。");
    expect(desc.className).toContain("truncate");

    const full = card('[data-archived="2026-07-05-desktop-shell-and-browser"]');
    expect(full.querySelector("[data-desc]")).toBeNull();
  });
});

// 讨论卡活在「讨论」子页签下（design D3）——先切子页签（Radix TabsTrigger 以
// mousedown 触发）再断言卡片。
const toDiscussionsTab = () =>
  fireEvent.mouseDown(screen.getByRole("tab", { name: /已封存的讨论/ }));

describe("ArchivedList（封存讨论卡）", () => {
  it("点卡触发 onOpen（discussion target）；卡显示日期＋slug 标题＋topic 描述＋轮数＋衍生变更数", () => {
    const onOpen = renderList();
    toDiscussionsTab();
    const disc = card('[data-archived-discussion="old-topic"]');
    expect(disc).toBeTruthy();
    expect(within(disc).getByText("2026-06-30")).toBeTruthy();
    expect(within(disc).getByText("Old settled topic")).toBeTruthy();
    expect(within(disc).getByText("2 轮")).toBeTruthy();
    // 衍生变更数自既有 promotedTo 长度派生；计数 meta 统一「裸 icon＋数字」
    //（design D7 增补）：非 Badge 圆圈、带 icon。
    const promoted = within(disc).getByLabelText("衍生 1 个变更");
    expect(promoted.className).not.toContain("rounded-full");
    expect(promoted.querySelector("svg")).toBeTruthy();
    fireEvent.click(screen.getByText("Old settled topic"));
    expect(onOpen).toHaveBeenCalledWith({ kind: "discussion", slug: "old-topic" });
    // 行内展开移除：区段标题不出现在清单。
    expect(screen.queryByText("讨论过程")).toBeNull();
  });

  it("拷贝 slug 钮写入剪贴板且不开抽屉", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onOpen = renderList();
    toDiscussionsTab();
    const disc = card('[data-archived-discussion="old-topic"]');
    fireEvent.click(within(disc).getByLabelText("拷贝 slug"));
    expect(writeText).toHaveBeenCalledWith("old-topic");
    expect(onOpen).not.toHaveBeenCalled();
    // 共用 CopyButton：成功以 status 声明「已拷贝」，拷贝钮名称维持不变。
    await waitFor(() => expect(within(disc).getByRole("status").textContent).toBe("已拷贝"));
  });

  it("slug 为等宽强调标题、topic 降为描述列一行截断（与看板讨论卡同构）", () => {
    // spec Example「封存讨论卡以 slug 为标题」：slug 于标题位等宽强调、紧跟拷贝钮；
    // topic 于标题下方的描述列一行截断。
    renderList();
    toDiscussionsTab();
    const disc = card('[data-archived-discussion="old-topic"]');
    const group = disc.querySelector("[data-title-group]") as HTMLElement;
    expect(group).toBeTruthy();
    const title = within(group).getByText("old-topic");
    expect(title.className).toContain("font-mono");
    expect(title.className).toContain("truncate");
    // 拷贝钮紧跟标题（同一群组内）。
    expect(within(group).getByLabelText("拷贝 slug")).toBeTruthy();
    // topic 降为描述列——不再位于标题群组内。
    expect(within(group).queryByText("Old settled topic")).toBeNull();
    const desc = disc.querySelector("[data-desc]") as HTMLElement;
    expect(desc).toBeTruthy();
    expect(desc.textContent).toBe("Old settled topic");
    expect(desc.className).toContain("truncate");
  });
});

// spec 需求「已封存页含讨论节」（子页签＋笔数徽章）与「清单最新在前与换页浏览」
//（datedName／created 降幂、每页 20 笔、页码独立、搜索回第 1 页）。
describe("ArchivedList（子页签、排序与换页）", () => {
  const mkChange = (datedName: string): ArchivedItem => ({
    datedName,
    date: datedName.slice(0, 10),
    name: datedName.slice(11),
    specCount: 0,
    createdBy: null,
    fromDiscussions: [],
  });
  const mkDisc = (slug: string, created: string, topic = `topic ${slug}`): DiscussionItem => ({
    slug,
    topic,
    status: "promoted",
    rounds: 1,
    created,
    promotedTo: [],
  });
  const changeOrder = () =>
    Array.from(document.querySelectorAll("[data-archived]")).map((el) => el.getAttribute("data-archived"));
  const discOrder = () =>
    Array.from(document.querySelectorAll("[data-archived-discussion]")).map((el) =>
      el.getAttribute("data-archived-discussion"),
    );

  it("初次回报两节全量顺序、搜索后回报各自过滤后顺序且不受换页影响（详情页 ‹ › 的串行）", () => {
    // 21 笔封存变更（跨两页）＋2 笔封存讨论；传入顺序刻意打乱，回报的是呈现顺序。
    const many = Array.from({ length: 21 }, (_, i) => mkChange(`2026-06-${String(i + 1).padStart(2, "0")}-c${i + 1}`));
    const onVisibleOrderChange = vi.fn();
    render(
      <ArchivedList
        archived={many}
        query=""
        onQuery={() => {}}
        archivedDiscussions={[mkDisc("older", "2026-01-01"), mkDisc("newer", "2026-02-01")]}
        onOpen={vi.fn()}
        onVisibleOrderChange={onVisibleOrderChange}
      />,
    );
    expect(onVisibleOrderChange).toHaveBeenLastCalledWith({
      changes: [...many].reverse().map((a) => a.datedName),
      discussions: ["newer", "older"],
    });
    const calls = onVisibleOrderChange.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(onVisibleOrderChange.mock.calls.length).toBe(calls);
  });

  it("搜索字符串过滤后回报两节各自的命中顺序", () => {
    const onVisibleOrderChange = vi.fn();
    const props = {
      archived: [mkChange("2026-06-01-alpha"), mkChange("2026-06-02-beta")],
      onQuery: () => {},
      archivedDiscussions: [mkDisc("alpha-talk", "2026-01-01"), mkDisc("other", "2026-01-02")],
      onOpen: vi.fn(),
      onVisibleOrderChange,
    };
    const { rerender } = render(<ArchivedList {...props} query="" />);
    rerender(<ArchivedList {...props} query="alpha" />);
    expect(onVisibleOrderChange).toHaveBeenLastCalledWith({
      changes: ["2026-06-01-alpha"],
      discussions: ["alpha-talk"],
    });
  });

  it("呈现「变更」「讨论」两分页且缺省显示变更；讨论列不在缺省分页出现", () => {
    renderList();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(screen.getByRole("tab", { name: /已封存的变更/ }).getAttribute("data-state")).toBe("active");
    expect(screen.getByText("desktop-shell-and-browser")).toBeTruthy();
    expect(screen.queryByText("Old settled topic")).toBeNull();
  });

  it("分页列为卡片标头式（card variant：rounded-t-2xl）且是列表卡顶部；内容卡 rounded-t-none 接在其下", () => {
    renderList();
    const tabsBar = screen.getByRole("tablist").parentElement as HTMLElement;
    expect(tabsBar.className).toContain("rounded-t-2xl");
    const listCard = document.querySelector("[data-list-card]") as HTMLElement;
    expect(listCard.className).toContain("rounded-t-none");
    expect(listCard.className).toContain("border-t-0");
    // 分页列与内容卡相邻：分页列在前、内容卡紧接。
    expect(tabsBar.nextElementSibling).toBe(listCard);
    // 列在内容卡的卷动容器内。
    const scroll = document.querySelector("[data-list-scroll]") as HTMLElement;
    expect(scroll.contains(card('[data-archived="2026-07-05-desktop-shell-and-browser"]'))).toBe(true);
  });

  it("archivedDiscussions 未提供时子页签列缺席、仅显示变更清单", () => {
    renderList([WARN, FULL, BARE], { archivedDiscussions: undefined });
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByText("desktop-shell-and-browser")).toBeTruthy();
    expect(screen.queryByText("Old settled topic")).toBeNull();
  });

  it("封存变更依 datedName 字典序降幂（封存日期新→旧）", () => {
    // spec Scenario「封存变更最新在前」Example 值；传入顺序刻意打乱。
    renderList([
      mkChange("2026-07-04-oldest"),
      mkChange("2026-07-11-newest"),
      mkChange("2026-07-08-middle"),
    ]);
    expect(changeOrder()).toEqual(["2026-07-11-newest", "2026-07-08-middle", "2026-07-04-oldest"]);
  });

  it("封存讨论依 created 降幂、同日以 slug 字母升幂决胜", () => {
    renderList([WARN], {
      archivedDiscussions: [
        mkDisc("beta-flow", "2026-07-10"),
        mkDisc("zulu-late", "2026-07-12"),
        mkDisc("alpha-ux", "2026-07-10"),
      ],
    });
    toDiscussionsTab();
    expect(discOrder()).toEqual(["zulu-late", "alpha-ux", "beta-flow"]);
  });

  it("搜索仅命中讨论时：「变更」徽章 0＋无结果空状态、「讨论」徽章 3，切换即见命中", () => {
    renderList([WARN, FULL, BARE], {
      query: "settled",
      archivedDiscussions: [
        mkDisc("t1", "2026-06-30", "First settled topic"),
        mkDisc("t2", "2026-06-29", "Second settled topic"),
        mkDisc("t3", "2026-06-28", "Third settled topic"),
      ],
    });
    const changesTab = screen.getByRole("tab", { name: /已封存的变更/ });
    const discussionsTab = screen.getByRole("tab", { name: /已封存的讨论/ });
    expect(within(changesTab).getByText("0")).toBeTruthy();
    expect(within(discussionsTab).getByText("3")).toBeTruthy();
    // 变更子页签（缺省）显示无结果空状态。
    expect(screen.getByText("没有已封存的变更")).toBeTruthy();
    toDiscussionsTab();
    expect(discOrder()).toHaveLength(3);
  });

  // c-01 最新 … c-21 最旧；t-01 最新 … t-21 最旧（两侧各两页）。
  const MANY_CHANGES = Array.from({ length: 21 }, (_, i) =>
    mkChange(`2026-06-${String(22 - (i + 1)).padStart(2, "0")}-c-${String(i + 1).padStart(2, "0")}`),
  );
  const MANY_DISCS = Array.from({ length: 21 }, (_, i) =>
    mkDisc(`t-${String(i + 1).padStart(2, "0")}`, `2026-05-${String(22 - (i + 1)).padStart(2, "0")}`),
  );

  it("两分页页码互相独立：变更翻到第 2 页不影响讨论页码", () => {
    renderList(MANY_CHANGES, { archivedDiscussions: MANY_DISCS });
    // 变更分页第 1 页 20 笔，翻到第 2 页。
    expect(changeOrder()).toHaveLength(20);
    expect(screen.getByText("第 1–20 笔，共 21 笔")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByText("第 21–21 笔，共 21 笔")).toBeTruthy();
    expect(screen.getByText("c-21")).toBeTruthy();
    // 讨论分页仍在第 1 页。
    toDiscussionsTab();
    expect(screen.getByText("第 1–20 笔，共 21 笔")).toBeTruthy();
    expect(discOrder()).toHaveLength(20);
    expect(screen.queryByText(/t-21/)).toBeNull();
    // 切回变更：其页码保持第 2 页。
    fireEvent.mouseDown(screen.getByRole("tab", { name: /已封存的变更/ }));
    expect(screen.getByText("第 21–21 笔，共 21 笔")).toBeTruthy();
  });

  it("两分页的跳页输入互相独立：变更节打了页码未提交，切到讨论节时输入框为空", () => {
    renderList(MANY_CHANGES, { archivedDiscussions: MANY_DISCS });
    fireEvent.change(screen.getByRole("spinbutton", { name: "跳到第几页" }), { target: { value: "2" } });
    toDiscussionsTab();
    expect((screen.getByRole("spinbutton", { name: "跳到第几页" }) as HTMLInputElement).value).toBe("");
  });

  it("spec Example「改每页笔数钳制页码」：45 笔于第 3 页改每页 50 → 单页 45 笔、页码钮消失；改回 20 回第 1 页", async () => {
    const user = userEvent.setup();
    const forty5 = Array.from({ length: 45 }, (_, i) =>
      mkChange(`2026-0${i < 30 ? 6 : 7}-${String(30 - (i % 30)).padStart(2, "0")}-k-${String(i + 1).padStart(2, "0")}`),
    );
    renderList(forty5, { archivedDiscussions: [] });
    expect(screen.getByText("第 1–20 笔，共 45 笔")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "第 3 页" }));
    expect(screen.getByText("第 41–45 笔，共 45 笔")).toBeTruthy();
    await user.click(screen.getByRole("combobox", { name: "每页 20 个" }));
    await user.click(await screen.findByRole("option", { name: "每页 50 个" }));
    expect(changeOrder()).toHaveLength(45);
    expect(screen.getByText("第 1–45 笔，共 45 笔")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^第 \d+ 页$/ })).toBeNull();
    await user.click(screen.getByRole("combobox", { name: "每页 50 个" }));
    await user.click(await screen.findByRole("option", { name: "每页 20 个" }));
    expect(screen.getByText("第 1–20 笔，共 45 笔")).toBeTruthy();
    expect(changeOrder()).toHaveLength(20);
  });

  it("搜索字符串变更后两侧页码皆回第 1 页", () => {
    const onOpen = vi.fn();
    const props = {
      archived: MANY_CHANGES,
      onQuery: () => {},
      archivedDiscussions: MANY_DISCS,
      onOpen,
    };
    const { rerender } = render(<ArchivedList {...props} query="" />);
    // 变更翻到第 2 页 → 切讨论翻到第 2 页。
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    toDiscussionsTab();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByText("第 21–21 笔，共 21 笔")).toBeTruthy();
    // 查找 "-" 两侧皆命中全部 21 笔（仍两页）——页码必须重设回第 1 页。
    rerender(<ArchivedList {...props} query="-" />);
    expect(screen.getByText("第 1–20 笔，共 21 笔")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("tab", { name: /已封存的变更/ }));
    expect(screen.getByText("第 1–20 笔，共 21 笔")).toBeTruthy();
    expect(screen.getByText("c-01")).toBeTruthy();
  });
});

// spec 需求「清单最新在前与换页浏览」（填满高度增补）：版面填满窗口高度、
// 卡片清单于内部容器卷动、换页控制列沉底常驻（不卷动即可换页）、换页后
// 内部卷动容器卷回顶部。
describe("ArchivedList（填满高度版面与换页控制列沉底）", () => {
  const mkChange = (datedName: string): ArchivedItem => ({
    datedName,
    date: datedName.slice(0, 10),
    name: datedName.slice(11),
    specCount: 0,
    createdBy: null,
    fromDiscussions: [],
  });
  const mkDisc = (slug: string, created: string): DiscussionItem => ({
    slug,
    topic: `topic ${slug}`,
    status: "promoted",
    rounds: 1,
    created,
    promotedTo: [],
  });
  // 两侧各 21 笔（两页）使换页控制列出现。
  const MANY_CHANGES = Array.from({ length: 21 }, (_, i) =>
    mkChange(`2026-06-${String(22 - (i + 1)).padStart(2, "0")}-c-${String(i + 1).padStart(2, "0")}`),
  );
  const MANY_DISCS = Array.from({ length: 21 }, (_, i) =>
    mkDisc(`t-${String(i + 1).padStart(2, "0")}`, `2026-05-${String(22 - (i + 1)).padStart(2, "0")}`),
  );
  const renderMany = (over: Record<string, unknown> = {}) =>
    render(
      <ArchivedList
        archived={MANY_CHANGES}
        query=""
        onQuery={() => {}}
        archivedDiscussions={MANY_DISCS}
        onOpen={vi.fn()}
        {...(over as object)}
      />,
    );
  const scrollEl = () => document.querySelector("[data-list-scroll]") as HTMLElement;

  it("根容器为填满高度 flex 直栏；列于列表卡内卷动；工具列在卷动容器外的卡底", () => {
    const { container } = renderMany();
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("h-full");
    expect(root.className).toContain("flex-col");
    const scroll = scrollEl();
    expect(scroll).toBeTruthy();
    expect(scroll.className).toContain("overflow-y-auto");
    expect(scroll.className).toContain("flex-1");
    expect(scroll.className).toContain("min-h-0");
    // 工具列是卷动容器的手足（卡底），不被清单内容卷走。
    const nextBtn = screen.getByRole("button", { name: "下一页" });
    expect(scroll.contains(nextBtn)).toBe(false);
    expect(scroll.parentElement!.contains(nextBtn)).toBe(true);
  });

  it("换页后内部卷动容器卷回顶部（两子页签各自归位）", () => {
    renderMany();
    // 变更子页签：仿真卷到中段后换页。
    scrollEl().scrollTop = 150;
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(scrollEl().scrollTop).toBe(0);
    // 讨论子页签：自有卷动容器，同样换页归位。
    fireEvent.mouseDown(screen.getByRole("tab", { name: /已封存的讨论/ }));
    scrollEl().scrollTop = 150;
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(scrollEl().scrollTop).toBe(0);
  });

  it("无分页兼容路径（archivedDiscussions 未提供）同样填满高度且清单内部卷动；列表卡维持完整圆角", () => {
    const { container } = renderMany({ archivedDiscussions: undefined });
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("h-full");
    const scroll = scrollEl();
    expect(scroll).toBeTruthy();
    expect(scroll.className).toContain("overflow-y-auto");
    const nextBtn = screen.getByRole("button", { name: "下一页" });
    expect(scroll.contains(nextBtn)).toBe(false);
    const listCard = document.querySelector("[data-list-card]") as HTMLElement;
    expect(listCard.className).not.toContain("rounded-t-none");
  });
});

// spec 需求「已封存页含讨论节」（页标题区）：标题「已封存」、灰字说明与全圆搜索框在
// 列表卡之上；未传 title 时只有搜索框。搜索框为外部受控（query／onQuery）。
describe("ArchivedList（页标题区）", () => {
  it("传 title 与 description 时出现 h2、说明与全圆搜索框，输入经 onQuery 回呼", () => {
    const onQuery = vi.fn();
    render(
      <ArchivedList
        archived={[WARN]}
        query=""
        onQuery={onQuery}
        archivedDiscussions={[DISCUSSION]}
        onOpen={vi.fn()}
        title="已封存"
        description="封存的变更与讨论。"
      />,
    );
    const header = document.querySelector("[data-page-header]") as HTMLElement;
    expect(within(header).getByRole("heading", { level: 2 }).textContent).toBe("已封存");
    expect(header.textContent).toContain("封存的变更与讨论。");
    const input = within(header).getByPlaceholderText("搜索已封存的变更与讨论…");
    expect(input.className).toContain("rounded-full");
    fireEvent.change(input, { target: { value: "x" } });
    expect(onQuery).toHaveBeenCalledWith("x");
  });

  it("未传 title 时无页标题区，搜索框仍在", () => {
    renderList();
    expect(document.querySelector("[data-page-header]")).toBeNull();
    expect(screen.getByPlaceholderText("搜索已封存的变更与讨论…").className).toContain("rounded-full");
  });
});

// desktop-list-pages-reskin design D7：两节的每页笔数各自可受控（桌面 store 记住并传入）。
describe("ArchivedList（受控每页笔数）", () => {
  const mkChange = (n: number): ArchivedItem => ({
    datedName: `2026-06-${String(22 - n).padStart(2, "0")}-k-${String(n).padStart(2, "0")}`,
    date: `2026-06-${String(22 - n).padStart(2, "0")}`,
    name: `k-${String(n).padStart(2, "0")}`,
    specCount: 0,
    createdBy: null,
    fromDiscussions: [],
  });
  const mkDisc = (n: number): DiscussionItem => ({
    slug: `d-${String(n).padStart(2, "0")}`,
    topic: `topic ${n}`,
    status: "promoted",
    rounds: 1,
    created: `2026-05-${String(22 - n).padStart(2, "0")}`,
    promotedTo: [],
  });
  const CHANGES = Array.from({ length: 21 }, (_, i) => mkChange(i + 1));
  const DISCS = Array.from({ length: 21 }, (_, i) => mkDisc(i + 1));

  it("changesPageSize={50} 只影响变更节，讨论节仍为每页 20", () => {
    render(
      <ArchivedList
        archived={CHANGES}
        query=""
        onQuery={() => {}}
        archivedDiscussions={DISCS}
        onOpen={vi.fn()}
        changesPageSize={50}
        onChangesPageSizeChange={vi.fn()}
      />,
    );
    expect(document.querySelectorAll("[data-archived]")).toHaveLength(21);
    expect(screen.getByText("第 1–21 笔，共 21 笔")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("tab", { name: /已封存的讨论/ }));
    expect(document.querySelectorAll("[data-archived-discussion]")).toHaveLength(20);
    expect(screen.getByText("第 1–20 笔，共 21 笔")).toBeTruthy();
  });

  it("在各节改每页笔数只调用该节的回呼", async () => {
    const user = userEvent.setup();
    const onChanges = vi.fn();
    const onDiscussions = vi.fn();
    render(
      <ArchivedList
        archived={CHANGES}
        query=""
        onQuery={() => {}}
        archivedDiscussions={DISCS}
        onOpen={vi.fn()}
        changesPageSize={20}
        onChangesPageSizeChange={onChanges}
        discussionsPageSize={20}
        onDiscussionsPageSizeChange={onDiscussions}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "每页 20 个" }));
    await user.click(await screen.findByRole("option", { name: "每页 50 个" }));
    expect(onChanges).toHaveBeenCalledWith(50);
    expect(onDiscussions).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: /已封存的讨论/ }));
    await user.click(screen.getByRole("combobox", { name: "每页 20 个" }));
    await user.click(await screen.findByRole("option", { name: "每页 100 个" }));
    expect(onDiscussions).toHaveBeenCalledWith(100);
    expect(onChanges).toHaveBeenCalledTimes(1);
  });
});

// spec「已封存页的流程成本摘要」：摘要在页标题区与列表卡之间，以全部封存变更计算。
describe("ArchivedList（流程成本摘要）", () => {
  const COSTED: ArchivedItem[] = [
    { ...WARN, docLines: 100, leadDays: 0 },
    { ...FULL, docLines: 200, leadDays: 0 },
    { ...BARE, docLines: 400, leadDays: 3 },
  ];

  function renderCosted(query: string) {
    render(
      <ArchivedList
        archived={COSTED}
        query={query}
        onQuery={() => {}}
        archivedDiscussions={[DISCUSSION]}
        onOpen={vi.fn()}
        title="已封存"
      />,
    );
  }

  it("sits between the page header and the list card", () => {
    renderCosted("");
    const header = document.querySelector("[data-page-header]")!;
    const summary = document.querySelector("[data-process-cost]")!;
    const card = document.querySelector("[data-list-card]")!;
    expect(header.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(summary.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(header.contains(summary) || summary.contains(card)).toBe(false);
  });

  it("is absent when no archived change carries a process cost field", () => {
    renderList();
    expect(document.querySelector("[data-process-cost]")).toBeNull();
    expect(document.querySelector("[data-list-card]")).not.toBeNull();
  });

  it("keeps the numbers of every archived change when a search narrows the list", () => {
    // Scenario「搜索不改变摘要数字」。
    renderCosted("no-tasks");
    expect(document.querySelectorAll("[data-archived]")).toHaveLength(1);
    const first = document.querySelector("[data-process-cost] [data-doc-tile]")!;
    expect([...first.children].map((el) => el.textContent)).toEqual(["200", "文档行数（3 笔） · P90 400"]);
  });
});

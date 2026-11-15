// spec 需求「规格页提供清单、搜索与展开查看」（列式容器卡、页标题区搜索、点列开
// 查看、无行内展开）＋「规格与封存卡片收合信息」（规格列）：收合信息字段、
// 名称搜索（维持现状）、拷贝名称回馈、空状态。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";
import { SpecList } from "../components/SpecList";
import type { SpecItem } from "../adapter";

// 既有中文断言包 I18nProvider locale zh-CN（与 archivedList.test 同型）。
const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

// spec Scenario「规格卡收合信息」的主角：7 条 Requirement、Purpose 已填写、溯源自
// 3 个变更；desktop-config 为缺 Purpose／零溯源的容错样本；node-sdk 为占位样本。
const SPECS: SpecItem[] = [
  {
    id: "desktop-app",
    modifiedAt: "2026-07-08",
    requirementCount: 7,
    purposeExcerpt: "桌面 app 的行为契约。",
    purposeTbd: false,
    traceCount: 3,
  },
  {
    id: "desktop-config",
    modifiedAt: "2026-07-07",
    requirementCount: 2,
    purposeExcerpt: null,
    purposeTbd: false,
    traceCount: 0,
  },
  {
    id: "node-sdk",
    modifiedAt: "2026-07-05",
    requirementCount: 1,
    purposeExcerpt: "TBD - created by archiving change 'old'. Update Purpose after archive.",
    purposeTbd: true,
    traceCount: 1,
  },
];

function renderList(specs: SpecItem[] = SPECS, onOpen = vi.fn()) {
  render(<SpecList specs={specs} onOpen={onOpen} />);
  return onOpen;
}

const card = (id: string) => document.querySelector(`[data-spec="${id}"]`) as HTMLElement;

describe("SpecList（规格页清单）", () => {
  beforeEach(() => {
    // 仅假造 Date 固定相对时间基准；timer 保持真实让 waitFor 照常运作。
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-08T04:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("卡片于收合状态显示需求数、溯源变更数、相对时间与 Purpose 摘要一行截断", () => {
    renderList();
    const app = card("desktop-app");
    // spec Example 值：需求数 7、溯源变更数 3、今天修改。
    const reqCount = within(app).getByLabelText("7 条需求");
    expect(reqCount).toBeTruthy();
    // 计数 meta 统一「裸 icon＋数字」（design D7 增补）：无 pill 底色、带 icon。
    expect(reqCount.className).not.toContain("rounded-full");
    expect(reqCount.className).not.toContain("bg-muted");
    expect(reqCount.querySelector("svg")).toBeTruthy();
    const traceCount = within(app).getByLabelText("溯源自 3 个变更");
    expect(traceCount.className).not.toContain("rounded-full");
    expect(traceCount.querySelector("svg")).toBeTruthy();
    expect(within(app).getByText("今天")).toBeTruthy();
    // Purpose 摘要独立成描述列、一行截断。
    const excerpt = within(app).getByText("桌面 app 的行为契约。");
    expect(excerpt.className).toContain("truncate");
    // 容错样本：无 Purpose → 描述列缺席；零溯源 → 溯源标记缺席；需求数照常。
    const config = card("desktop-config");
    expect(within(config).getByLabelText("2 条需求")).toBeTruthy();
    expect(within(config).queryByLabelText(/溯源自/)).toBeNull();
    expect(within(config).getByText("昨天")).toBeTruthy();
  });

  it("modifiedAt 缺席时相对时间该行不渲染", () => {
    renderList([{ id: "bare-cap", requirementCount: 0, purposeExcerpt: null, purposeTbd: false, traceCount: 0 }]);
    const bare = card("bare-cap");
    expect(bare).toBeTruthy();
    expect(within(bare).queryByText(/今天|昨天|天前/)).toBeNull();
  });

  it("Purpose 占位时以琥珀警示显示「Purpose 待补」，不显示占位原文", () => {
    renderList();
    const sdk = card("node-sdk");
    const hint = within(sdk).getByText("Purpose 待补");
    expect(hint.className).toContain("status-warning");
    expect(within(sdk).queryByText(/TBD - created by archiving/)).toBeNull();
  });

  it("点整列触发 onOpen 开查看；列为共用 ListRow（等宽标题、› 收尾）、无行内展开", () => {
    const onOpen = renderList();
    fireEvent.click(screen.getByText("desktop-app"));
    expect(onOpen).toHaveBeenCalledWith("desktop-app");
    // 列本身不展开内容（加载语意已搬进抽屉）。
    expect(screen.queryByText("加载中…")).toBeNull();
    const app = card("desktop-app");
    expect(app.getAttribute("role")).toBe("button");
    expect(within(app).getByText("desktop-app").className).toContain("font-mono");
    expect(app.querySelector(".lucide-chevron-right")).toBeTruthy();
    // 行内展开的 chevron-down 与 aria-expanded 全数移除（列内断言：工具列的每页下拉自带 chevron-down）。
    expect(app.querySelector(".lucide-chevron-down")).toBeNull();
    expect(app.querySelector("[aria-expanded]")).toBeNull();
  });

  it("拷贝钮位于标题群组内（标题后紧跟、hover 显现），点击写入剪贴板且不开抽屉", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onOpen = renderList();
    const app = card("desktop-app");
    // 标题与拷贝钮同属一个标题群组（design D7：标题＋拷贝钮成群组、meta 靠右）。
    const group = app.querySelector("[data-title-group]") as HTMLElement;
    expect(group).toBeTruthy();
    expect(within(group).getByText("desktop-app")).toBeTruthy();
    const copyBtn = within(group).getByLabelText("拷贝名称");
    // hover 显现：缺省透明、group-hover 显示。
    expect(copyBtn.className).toContain("opacity-0");
    expect(copyBtn.className).toContain("group-hover:opacity-100");
    fireEvent.click(copyBtn);
    expect(writeText).toHaveBeenCalledWith("desktop-app");
    // 共用 CopyButton：成功以 status 声明「已拷贝」，拷贝钮名称维持不变。
    await waitFor(() => expect(within(app).getByRole("status").textContent).toBe("已拷贝"));
    expect(within(group).getByLabelText("拷贝名称")).toBe(copyBtn);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("搜索以名称子字符串过滤（大小写不敏感）、无结果显示空状态、清空还原", () => {
    renderList();
    const input = screen.getByPlaceholderText("搜索规格…");
    // Example 列 1：desktop → desktop-app、desktop-config
    fireEvent.change(input, { target: { value: "desktop" } });
    expect(screen.getByText("desktop-app")).toBeTruthy();
    expect(screen.getByText("desktop-config")).toBeTruthy();
    expect(screen.queryByText("node-sdk")).toBeNull();
    // Example 列 2：SDK → node-sdk（大小写不敏感）
    fireEvent.change(input, { target: { value: "SDK" } });
    expect(screen.getByText("node-sdk")).toBeTruthy();
    expect(screen.queryByText("desktop-app")).toBeNull();
    // Example 列 3：zzz → 无结果空状态
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.queryByText("node-sdk")).toBeNull();
    expect(screen.getByText("没有符合的规格")).toBeTruthy();
    // 清空输入 → 清单还原
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByText("desktop-app")).toBeTruthy();
    expect(screen.getByText("desktop-config")).toBeTruthy();
    expect(screen.getByText("node-sdk")).toBeTruthy();
    expect(screen.queryByText("没有符合的规格")).toBeNull();
  });

  it("无 spec 项目显示空状态文案", () => {
    renderList([]);
    expect(screen.getByText("此项目尚无正式规格")).toBeTruthy();
  });
});

// spec 需求「清单最新在前与换页浏览」：规格依 modifiedAt 新→旧、缺席者殿后
// 且依名称字母升幂；每页 20 笔换页、搜索字符串变更回第 1 页。
describe("SpecList（最新在前与换页）", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-08T04:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const bare = (id: string, modifiedAt?: string): SpecItem => ({
    id,
    modifiedAt: modifiedAt ?? null,
    requirementCount: 0,
    purposeExcerpt: null,
    purposeTbd: false,
    traceCount: 0,
  });

  const cardOrder = () =>
    Array.from(document.querySelectorAll("[data-spec]")).map((el) => el.getAttribute("data-spec"));

  it("modifiedAt 新→旧排序；缺席者排最后且彼此依名称字母升幂", () => {
    // spec Scenario「规格修改时间缺席排最后」Example 值：beta 今天、alpha 3 天前、
    // zeta 与 delta 无 modifiedAt → 顺序 beta、alpha、delta、zeta。传入顺序刻意打乱。
    renderList([bare("zeta"), bare("alpha", "2026-07-05"), bare("delta"), bare("beta", "2026-07-08")]);
    expect(cardOrder()).toEqual(["beta", "alpha", "delta", "zeta"]);
  });

  // s01 最新 … s21 最旧：排序后 s01–s20 落第 1 页、s21 落第 2 页。
  const MANY: SpecItem[] = Array.from({ length: 21 }, (_, i) => {
    const n = i + 1;
    const day = String(22 - n).padStart(2, "0");
    return bare(`s${String(n).padStart(2, "0")}`, `2026-06-${day}`);
  });

  it("21 笔时第 1 页仅 20 笔且工具列有页码，点下一页显示第 21 笔", () => {
    renderList(MANY);
    expect(cardOrder()).toHaveLength(20);
    expect(screen.getByText("s01")).toBeTruthy();
    expect(screen.queryByText("s21")).toBeNull();
    expect(screen.getByText("第 1–20 笔，共 21 笔")).toBeTruthy();
    expect(screen.getByRole("button", { name: "第 2 页" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByText("s21")).toBeTruthy();
    expect(screen.queryByText("s01")).toBeNull();
    expect(screen.getByText("第 21–21 笔，共 21 笔")).toBeTruthy();
  });

  it("初次回报全量顺序、搜索后回报过滤后顺序且不受换页影响（详情页 ‹ › 的串行）", () => {
    const onVisibleOrderChange = vi.fn();
    render(<SpecList specs={MANY} onOpen={vi.fn()} onVisibleOrderChange={onVisibleOrderChange} />);
    // 全部页的顺序，不只第 1 页的 20 笔。
    expect(onVisibleOrderChange).toHaveBeenLastCalledWith(MANY.map((s) => s.id));
    const calls = onVisibleOrderChange.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(onVisibleOrderChange.mock.calls.length).toBe(calls);
    fireEvent.change(screen.getByPlaceholderText("搜索规格…"), { target: { value: "s1" } });
    expect(onVisibleOrderChange).toHaveBeenLastCalledWith([
      "s10", "s11", "s12", "s13", "s14", "s15", "s16", "s17", "s18", "s19",
    ]);
  });

  it("13 笔时工具列只有笔数范围与每页笔数：无页码钮、无 ‹ ›、无跳页输入", () => {
    renderList(MANY.slice(0, 13));
    expect(cardOrder()).toHaveLength(13);
    expect(screen.getByText("第 1–13 笔，共 13 笔")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "每页 20 个" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "下一页" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^第 \d+ 页$/ })).toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  it("于第 2 页修改搜索字符串后回到第 1 页", () => {
    renderList(MANY);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByText("第 21–21 笔，共 21 笔")).toBeTruthy();
    // 查找 "s" 命中全部 21 笔（仍两页）——页码必须重设回第 1 页。
    fireEvent.change(screen.getByPlaceholderText("搜索规格…"), { target: { value: "s" } });
    expect(screen.getByText("第 1–20 笔，共 21 笔")).toBeTruthy();
    expect(screen.getByText("s01")).toBeTruthy();
    expect(screen.queryByText("s21")).toBeNull();
  });

  it("每页改 50 后 21 笔单页显示、页码钮消失；改回 20 回到第 1 页", async () => {
    const user = userEvent.setup();
    renderList(MANY);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByText("s21")).toBeTruthy();
    await user.click(screen.getByRole("combobox", { name: "每页 20 个" }));
    await user.click(await screen.findByRole("option", { name: "每页 50 个" }));
    expect(cardOrder()).toHaveLength(21);
    expect(screen.getByText("第 1–21 笔，共 21 笔")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^第 \d+ 页$/ })).toBeNull();
    // 改回 20：页码已被钳制成第 1 页，不回到先前的第 2 页。
    await user.click(screen.getByRole("combobox", { name: "每页 50 个" }));
    await user.click(await screen.findByRole("option", { name: "每页 20 个" }));
    expect(screen.getByText("第 1–20 笔，共 21 笔")).toBeTruthy();
    expect(screen.getByText("s01")).toBeTruthy();
  });
});

// spec 需求「清单最新在前与换页浏览」（填满高度增补）：版面填满窗口高度、
// 卡片清单于内部容器卷动、换页控制列沉底常驻、换页后内部卷动容器卷回顶部。
describe("SpecList（填满高度版面与换页控制列沉底）", () => {
  const bare = (id: string, modifiedAt: string): SpecItem => ({
    id,
    modifiedAt,
    requirementCount: 0,
    purposeExcerpt: null,
    purposeTbd: false,
    traceCount: 0,
  });
  // 21 笔（两页）使换页控制列出现。
  const MANY: SpecItem[] = Array.from({ length: 21 }, (_, i) =>
    bare(`s${String(i + 1).padStart(2, "0")}`, `2026-06-${String(22 - (i + 1)).padStart(2, "0")}`),
  );
  const scrollEl = () => document.querySelector("[data-list-scroll]") as HTMLElement;
  const renderMany = () => render(<SpecList specs={MANY} onOpen={vi.fn()} />);

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
    // 列在列表卡内；工具列是卷动容器的手足（卡底），不被清单内容卷走。
    const listCard = document.querySelector("[data-list-card]") as HTMLElement;
    expect(listCard.contains(scroll)).toBe(true);
    expect(listCard.className).toContain("rounded-2xl");
    const nextBtn = screen.getByRole("button", { name: "下一页" });
    expect(scroll.contains(nextBtn)).toBe(false);
    expect(scroll.parentElement!.contains(nextBtn)).toBe(true);
  });

  it("换页后内部卷动容器卷回顶部", () => {
    renderMany();
    scrollEl().scrollTop = 150;
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(scrollEl().scrollTop).toBe(0);
  });
});

// spec 需求「规格页提供清单、搜索与展开查看」（页标题区）：标题、灰字说明与全圆搜索框
// 在列表卡之上；未传 title 时只有搜索框。
describe("SpecList（页标题区）", () => {
  it("传 title 与 description 时出现 h2、说明与全圆搜索框", () => {
    render(<SpecList specs={SPECS} onOpen={vi.fn()} title="规格" description="正式规格一览。" />);
    const header = document.querySelector("[data-page-header]") as HTMLElement;
    expect(within(header).getByRole("heading", { level: 2 }).textContent).toBe("规格");
    expect(header.textContent).toContain("正式规格一览。");
    const input = within(header).getByPlaceholderText("搜索规格…");
    expect(input.className).toContain("rounded-full");
    expect(document.querySelector("[data-list-card]")!.contains(header)).toBe(false);
  });

  it("未传 title 时无页标题区，搜索框仍在", () => {
    render(<SpecList specs={SPECS} onOpen={vi.fn()} />);
    expect(document.querySelector("[data-page-header]")).toBeNull();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(screen.getByPlaceholderText("搜索规格…").className).toContain("rounded-full");
  });
});

// desktop-list-pages-reskin design D7：每页笔数可受控（桌面 store 记住并传入）；值与回呼
// 都给时以 prop 为准，改下拉只调用回呼。
describe("SpecList（受控每页笔数）", () => {
  const MANY21: SpecItem[] = Array.from({ length: 21 }, (_, i) => ({
    id: `c${String(i + 1).padStart(2, "0")}`,
    modifiedAt: `2026-06-${String(22 - (i + 1)).padStart(2, "0")}`,
    requirementCount: 0,
    purposeExcerpt: null,
    purposeTbd: false,
    traceCount: 0,
  }));

  it("传 pageSize={50} 时 21 笔单页显示；选每页 100 调用 onPageSizeChange(100)，值仍以 prop 为准", async () => {
    const user = userEvent.setup();
    const onPageSizeChange = vi.fn();
    render(<SpecList specs={MANY21} onOpen={vi.fn()} pageSize={50} onPageSizeChange={onPageSizeChange} />);
    expect(document.querySelectorAll("[data-spec]")).toHaveLength(21);
    expect(screen.getByText("第 1–21 笔，共 21 笔")).toBeTruthy();
    await user.click(screen.getByRole("combobox", { name: "每页 50 个" }));
    await user.click(await screen.findByRole("option", { name: "每页 100 个" }));
    expect(onPageSizeChange).toHaveBeenCalledWith(100);
    expect(screen.getByRole("combobox", { name: "每页 50 个" })).toBeTruthy();
  });
});

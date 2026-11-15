// 面板样式呈现层（spec「面板样式」；design D5）：以主窗口推送的
// TraySnapshot 薄渲染——分区与内容和原生菜单同源；jsdom 只测结构与回调，
// 原生质感（不抢焦点、贴齐、失焦收合）由 4.4 真窗口手动验证。
import { beforeEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, render as rtlRender, screen, fireEvent, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import {
  I18nProvider,
  DISCUSSION_TONE,
  REVIEW_TONE,
  SEMANTIC_SURFACE,
  SEMANTIC_TONE,
  STAGE_BADGE,
  STAGE_BAR,
  STAGE_ICON,
  VERIFY_TONE,
  type ChangeItem,
} from "@specseal/ui";

import { TrayPanel } from "../panel/TrayPanel";
import { RAIL_SQUARE } from "../components/projectTile";
import {
  TRAY_PROMOTED_EXPANDED_STORAGE_KEY,
  readTrayPromotedExpanded,
  writeTrayPromotedExpanded,
} from "../panel/promotedExpanded";
import {
  TRAY_COLLAPSED_SECTIONS_STORAGE_KEY,
  readTrayCollapsedSections,
  writeTrayCollapsedSections,
} from "../panel/sectionCollapse";
import { tabRevealScrollLeft } from "../panel/tabStrip";
import { EDGE_FADE_PX, edgeFade, edgeFadeMask } from "../panel/edgeFade";
import { APP_MESSAGES } from "../i18n/messages";
import type { TraySnapshot } from "../tray";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
    {children}
  </I18nProvider>
);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: zhWrapper });

// 已转出卡的展开记忆与内容卡收合记忆都存 localStorage：每题从「未记忆」起跑，
// 前一题的展开／收合不外溢。
beforeEach(() => {
  localStorage.removeItem(TRAY_PROMOTED_EXPANDED_STORAGE_KEY);
  localStorage.removeItem(TRAY_COLLAPSED_SECTIONS_STORAGE_KEY);
});

/** b 在 a 之后（文档顺序）。 */
const follows = (a: Element, b: Element) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
/** 分区卡（panel-section-<id>，id 为 proposed、discussions、promoted 等）。 */
const card = (id: string) => screen.getByTestId(`panel-section-${id}`);
/** 内容卡标题的收合触发区（包住整条分区标题）。 */
const sectionToggle = (id: string) => within(screen.getByTestId(id)).getByTestId("panel-section-toggle");
/** 分区卡的标头（收合触发区内的 SectionHeader）。 */
const sectionHeader = (id: string) => sectionToggle(id).firstElementChild as HTMLElement;
/** 收合触发内箭头的 class token（以空白切开，才分得出 rotate-90 与 -rotate-90）。 */
const chevronTokens = (toggle: HTMLElement) =>
  (toggle.querySelector("svg.lucide-chevron-right")?.getAttribute("class") ?? "").split(/\s+/);
/** jsdom 没有版面：注入可卷区的卷动量测（scrollTop／scrollHeight…）。 */
function injectMetrics(el: HTMLElement, metrics: Record<string, number>) {
  for (const [prop, value] of Object.entries(metrics)) {
    Object.defineProperty(el, prop, { configurable: true, value });
  }
}
/** 注入卷动量测后触发卷动事件。 */
function scrollWith(el: HTMLElement, metrics: Record<string, number>) {
  injectMetrics(el, metrics);
  act(() => {
    fireEvent.scroll(el);
  });
}

function change(over: Partial<ChangeItem> & { name: string }): ChangeItem {
  return { status: "", totalTasks: 0, completedTasks: 0, ...over };
}

function snapshot(over: Partial<TraySnapshot> = {}): TraySnapshot {
  return {
    tabs: [
      { key: "local:/proj/one", name: "one", source: "local", status: "ready" },
      { key: "local:/proj/two", name: "two", source: "local", status: "ready" },
    ],
    activeKey: "local:/proj/one",
    changes: [
      change({ name: "prop", totalTasks: 5, completedTasks: 0 }), // proposed
      change({ name: "inprog", totalTasks: 12, completedTasks: 3 }), // in-progress
      change({ name: "rdy", totalTasks: 4, completedTasks: 4 }), // ready
    ],
    discussions: [{ slug: "d1", topic: "讨论一", promoted: false }],
    pendingTabKey: null,
    workspaceLoading: false,
    workspaceLoadFailed: false,
    ...over,
  };
}

/** 6 个本机项目 tab（p1…p6）：tab 条总宽超出可卷区的情境。 */
const six = Array.from({ length: 6 }, (_, i) => ({
  key: `local:/proj/p${i + 1}`,
  name: `p${i + 1}`,
  source: "local" as const,
  status: "ready" as const,
}));

function renderPanel(over: Partial<Parameters<typeof TrayPanel>[0]> = {}) {
  const handlers = {
    onOpenChange: vi.fn(),
    onOpenDiscussion: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenApp: vi.fn(),
    onOpenProjectSettings: vi.fn(),
    onOpenSettings: vi.fn(),
    onQuit: vi.fn(),
    onCopy: vi.fn(),
    onAddProject: vi.fn(),
    onRetryWorkspace: vi.fn(),
    onOpenRecovery: vi.fn(),
    onOpenServerSettings: vi.fn(),
    onReauthenticate: vi.fn(),
  };
  const props = { snapshot: snapshot(), platform: "macos" as const, ...handlers, ...over };
  const { rerender } = render(<TrayPanel {...props} />);
  return {
    ...handlers,
    /** 送入新快照（仿真主窗口推送），其余 props 不变。 */
    pushSnapshot: (next: TraySnapshot) => rerender(<TrayPanel {...props} snapshot={next} />),
  };
}

describe("TrayPanel 渲染（与原生菜单同源的分区内容）", () => {
  it("active no-session error 以精简复原卡取代旧数据，retry 原地而详情／登录走明确回调", () => {
    const key = "remote:c1/demo/backend";
    const h = renderPanel({
      snapshot: snapshot({
        tabs: [
          {
            key,
            name: "Demo/backend",
            source: "remote",
            status: "error",
            failureKind: "needs-reauth",
            connectionId: "c1",
            serverLabel: "Team Server",
            serverOrigin: "https://spec.example.test",
          },
        ],
        activeKey: key,
        changes: [change({ name: "previous-workspace-change", totalTasks: 2, completedTasks: 1 })],
        discussions: [{ slug: "previous-workspace-discussion", topic: "旧数据", promoted: false }],
      } as unknown as Partial<TraySnapshot>),
    });

    const card = screen.getByTestId("panel-recovery-card");
    expect(card.textContent).toContain("需要重新登录");
    expect(card.textContent).toContain("Demo/backend");
    expect(card.textContent).toContain("Team Server");
    expect(screen.queryByText("previous-workspace-change")).toBeNull();
    expect(screen.queryByText("previous-workspace-discussion")).toBeNull();
    expect(screen.queryByTestId("panel-section-proposed")).toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: "重新登录" }));
    fireEvent.click(within(card).getByRole("button", { name: "查看问题" }));
    expect(h.onReauthenticate).toHaveBeenCalledWith("c1");
    expect(h.onOpenRecovery).toHaveBeenCalledWith(key);
    for (const button of within(card).getAllByRole("button")) {
      expect(button.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("active restoring 显示进度且不可重复 retry，offline session 则保留 stale 内容", () => {
    const key = "remote:c1/demo/backend";
    const { rerender } = rtlRender(
      <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
        <TrayPanel
          snapshot={snapshot({
            tabs: [
              {
                key,
                name: "Demo/backend",
                source: "remote",
                status: "restoring",
                connectionId: "c1",
                serverLabel: "Team Server",
              },
            ],
            activeKey: key,
          } as unknown as Partial<TraySnapshot>)}
          platform="macos"
          onOpenProject={vi.fn()}
          onOpenChange={vi.fn()}
          onOpenDiscussion={vi.fn()}
          onOpenApp={vi.fn()}
          onOpenProjectSettings={vi.fn()}
          onOpenSettings={vi.fn()}
          onQuit={vi.fn()}
          onCopy={vi.fn()}
          onAddProject={vi.fn()}
          onRetryWorkspace={vi.fn()}
          onOpenRecovery={vi.fn()}
          onOpenServerSettings={vi.fn()}
          onReauthenticate={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(screen.getByTestId("panel-recovery-card").textContent).toContain("正在连接");
    expect(screen.queryByRole("button", { name: "重新连接" })).toBeNull();

    rerender(
      <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
        <TrayPanel
          snapshot={snapshot({
            tabs: [
              {
                key,
                name: "Demo/backend",
                source: "remote",
                status: "offline",
                connectionId: "c1",
                serverLabel: "Team Server",
              },
            ],
            activeKey: key,
            changes: [change({ name: "offline-stale-change", totalTasks: 2, completedTasks: 1 })],
          } as unknown as Partial<TraySnapshot>)}
          platform="macos"
          onOpenProject={vi.fn()}
          onOpenChange={vi.fn()}
          onOpenDiscussion={vi.fn()}
          onOpenApp={vi.fn()}
          onOpenProjectSettings={vi.fn()}
          onOpenSettings={vi.fn()}
          onQuit={vi.fn()}
          onCopy={vi.fn()}
          onAddProject={vi.fn()}
          onRetryWorkspace={vi.fn()}
          onOpenRecovery={vi.fn()}
          onOpenServerSettings={vi.fn()}
          onReauthenticate={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(screen.getByTestId("panel-stale-status").textContent).toContain("脱机");
    expect(screen.getByText("offline-stale-change")).toBeTruthy();
    expect(screen.queryByTestId("panel-recovery-card")).toBeNull();
  });

  it("active unreachable 的 Panel retry 只走原地回调，不误触主窗口详情", () => {
    const key = "remote:c1/demo/backend";
    const h = renderPanel({
      snapshot: snapshot({
        tabs: [
          {
            key,
            name: "Demo/backend",
            source: "remote",
            status: "error",
            failureKind: "unreachable",
            connectionId: "c1",
            serverLabel: "Team Server",
          },
        ],
        activeKey: key,
      } as unknown as Partial<TraySnapshot>),
    });
    fireEvent.click(
      within(screen.getByTestId("panel-recovery-card")).getByRole("button", {
        name: "重新连接",
      }),
    );
    expect(h.onRetryWorkspace).toHaveBeenCalledWith(key);
    expect(h.onOpenRecovery).not.toHaveBeenCalled();
    expect(h.onOpenApp).not.toHaveBeenCalled();
  });

  it("依生命周期分区渲染变更（含进度数）与讨论清单（slug 为题、topic 为描述）", () => {
    renderPanel();
    // 生命周期分区 header
    for (const label of ["提案中", "进行中", "已就绪", "讨论"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // 变更列：名称与 n/m 进度数
    const inprog = screen.getByTestId("panel-change-inprog");
    expect(within(inprog).getByText("inprog")).toBeTruthy();
    expect(within(inprog).getByText("3/12")).toBeTruthy();
    // 讨论列：slug 为题、topic 为描述（识别锚点惯例）
    const disc = screen.getByTestId("panel-discussion-d1");
    expect(within(disc).getByText("d1")).toBeTruthy();
    expect(within(disc).getByText("讨论一")).toBeTruthy();
  });

  it("项目区列出分页且作用中标示、点非作用中项目回调切换", () => {
    const h = renderPanel();
    const one = screen.getByTestId("panel-project-local:/proj/one");
    const two = screen.getByTestId("panel-project-local:/proj/two");
    expect(one.getAttribute("data-active")).toBe("true");
    expect(two.getAttribute("data-active")).toBe("false");
    fireEvent.click(two);
    expect(h.onOpenProject).toHaveBeenCalledWith("local:/proj/two");
  });

  it("点 remote 项目 tab 以 locator key 回调切换，不因空 root 静默", () => {
    const remoteKey = "remote:conn-1/demo/backend";
    const h = renderPanel({
      snapshot: snapshot({
        tabs: [
          { key: "local:/proj/one", name: "one", source: "local", status: "ready" },
          {
            key: remoteKey,
            name: "Demo/backend",
            source: "remote",
            status: "ready",
            connectionId: "conn-1",
            serverLabel: "Team Server",
          },
        ],
      }),
    });
    fireEvent.click(screen.getByTestId(`panel-project-${remoteKey}`));
    expect(h.onOpenProject).toHaveBeenCalledWith(remoteKey);
  });

  it("全无变更时三个生命周期分区常驻：各带计数 0 空状态卡、无占位卡（D8 同构）", () => {
    renderPanel({ snapshot: snapshot({ changes: [], discussions: [] }) });
    // 占位卡不再存在（spec「面板样式」常驻分区行为）
    expect(screen.queryByTestId("panel-empty-changes")).toBeNull();
    expect(screen.queryByText("尚无进行中变更")).toBeNull();
    for (const id of ["panel-section-proposed", "panel-section-in-progress", "panel-section-ready"]) {
      const card = screen.getByTestId(id);
      expect(card.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-h-12", "justify-center"]));
      expect(within(card).getByTestId("section-count").textContent).toBe("0");
    }
    const disc = screen.getByTestId("panel-section-discussions");
    expect(disc.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-h-12", "justify-center"]));
    expect(within(disc).getByText("讨论")).toBeTruthy();
    expect(within(disc).getByTestId("section-count").textContent).toBe("0");
  });

  it("部分有数据时空阶段分区仍常驻：计数 0/1/0、顺序固定提案中→进行中→已就绪", () => {
    renderPanel({
      snapshot: snapshot({
        changes: [change({ name: "solo", totalTasks: 12, completedTasks: 3 })], // in-progress
        discussions: [],
      }),
    });
    const ids = ["panel-section-proposed", "panel-section-in-progress", "panel-section-ready"];
    const counts = ids.map(
      (id) => within(screen.getByTestId(id)).getByTestId("section-count").textContent,
    );
    expect(counts).toEqual(["0", "1", "0"]);
    expect(within(screen.getByTestId("panel-section-in-progress")).getByTestId("panel-change-solo")).toBeTruthy();
    const [proposed, inProgress, ready] = ids.map((id) => screen.getByTestId(id));
    expect(proposed.compareDocumentPosition(inProgress) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(inProgress.compareDocumentPosition(ready) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("讨论分流：已转出讨论列于「讨论」卡正下方的独立「已转出」卡（不在讨论卡内、无旧收合列）", () => {
    renderPanel({
      snapshot: snapshot({
        discussions: [
          { slug: "open-d", topic: "讨论中的", promoted: false },
          { slug: "prom-d", topic: "已转出的", promoted: true },
        ],
      }),
    });
    const discussions = screen.getByTestId("panel-section-discussions");
    const promoted = screen.getByTestId("panel-section-promoted");
    expect(within(discussions).getByTestId("panel-discussion-open-d")).toBeTruthy();
    // 讨论卡 → 已转出卡 → 页脚；已转出卡是兄弟卡，不是讨论卡的子节点。
    expect(discussions.contains(promoted)).toBe(false);
    expect(follows(discussions, promoted)).toBe(true);
    expect(follows(promoted, screen.getByTestId("panel-footer"))).toBe(true);
    expect(screen.queryByTestId("panel-promoted-toggle")).toBeNull();
    expect(screen.queryByTestId("panel-promoted-rows")).toBeNull();
    expect(within(promoted).getByTestId("section-count").textContent).toBe("1");
    fireEvent.click(sectionToggle("panel-section-promoted"));
    expect(within(promoted).getByTestId("panel-discussion-prom-d")).toBeTruthy();
    expect(within(promoted).queryByTestId("panel-discussion-open-d")).toBeNull();
    expect(within(discussions).queryByTestId("panel-discussion-prom-d")).toBeNull();
    expect(screen.queryByTestId("panel-promoted-rows")).toBeNull();
  });

  it("零已转出时无已转出卡", () => {
    renderPanel();
    expect(screen.queryByTestId("panel-section-promoted")).toBeNull();
    expect(screen.queryByText(/已转出/)).toBeNull();
  });

  it("区块顺序：提案中→进行中→已就绪→讨论→已转出五张卡、动作区块卡最末", () => {
    renderPanel({
      snapshot: snapshot({
        discussions: [
          { slug: "open-d", topic: "讨论中的", promoted: false },
          { slug: "prom-d", topic: "已转出的", promoted: true },
        ],
      }),
    });
    const proposed = screen.getByTestId("panel-section-proposed");
    const inProgress = screen.getByTestId("panel-section-in-progress");
    const ready = screen.getByTestId("panel-section-ready");
    const discussions = screen.getByTestId("panel-section-discussions");
    const promoted = screen.getByTestId("panel-section-promoted");
    const actions = screen.getByTestId("panel-actions-card");
    expect(follows(proposed, inProgress)).toBe(true);
    expect(follows(inProgress, ready)).toBe(true);
    expect(follows(ready, discussions)).toBe(true);
    expect(follows(discussions, promoted)).toBe(true);
    expect(follows(promoted, actions)).toBe(true);
    expect(within(actions).getByText("打开 Specseal")).toBeTruthy();
  });

  it("区块之间只以间距分隔：无任何分割线", () => {
    renderPanel();
    expect(screen.queryAllByTestId("panel-divider")).toHaveLength(0);
    expect(document.querySelector("hr")).toBeNull();
  });

  it("分区逾 5 笔：面板显示前 5＋「还有 N 个…」，点击展开、再点收合", () => {
    const eight = Array.from({ length: 8 }, (_, i) =>
      change({ name: `c${i}`, totalTasks: 2, completedTasks: 1 }),
    );
    renderPanel({ snapshot: snapshot({ changes: eight, discussions: [] }) });
    expect(screen.getByTestId("panel-change-c4")).toBeTruthy();
    expect(screen.queryByTestId("panel-change-c5")).toBeNull();
    fireEvent.click(screen.getByText("还有 3 个…"));
    expect(screen.getByTestId("panel-change-c7")).toBeTruthy();
    fireEvent.click(screen.getByText("收合"));
    expect(screen.queryByTestId("panel-change-c5")).toBeNull();
  });

  it("五笔以下不出现溢出列", () => {
    renderPanel();
    expect(screen.queryByText(/还有 \d+ 个…/)).toBeNull();
  });
});

describe("TrayPanel 项目 tab 条（spec「面板样式」；design D1）", () => {
  it("每个 tab 含项目名首字母 avatar 与项目名", () => {
    renderPanel();
    const one = screen.getByTestId("panel-project-local:/proj/one");
    expect(within(one).getByText("O")).toBeTruthy();
    expect(within(one).getByText("one")).toBeTruthy();
    const two = screen.getByTestId("panel-project-local:/proj/two");
    expect(within(two).getByText("T")).toBeTruthy();
    expect(within(two).getByText("two")).toBeTruthy();
  });

  const tile = (el: HTMLElement) => el.querySelector("[data-project-tile]") as HTMLElement;

  it("作用中 tab 的方块实心主色、非作用中方块灰底；tab 本体不涂主色、hover 为灰底", () => {
    renderPanel();
    const one = screen.getByTestId("panel-project-local:/proj/one");
    const two = screen.getByTestId("panel-project-local:/proj/two");
    expect(tile(one).className.split(/\s+/)).toEqual(expect.arrayContaining(["bg-primary", "text-primary-foreground"]));
    expect(tile(two).className.split(/\s+/)).toEqual(expect.arrayContaining(["bg-muted", "text-muted-foreground"]));
    expect(tile(two).className.split(/\s+/)).not.toContain("bg-primary");
    for (const tab of [one, two]) {
      expect(tab.className).not.toContain("primary");
      expect(tab.className.split(/\s+/)).toContain("hover:bg-foreground/5");
    }
  });

  it("tab 方块与图标列同形：classList 含 RAIL_SQUARE 全部 token，项目名列于方块之下", () => {
    renderPanel();
    const one = screen.getByTestId("panel-project-local:/proj/one");
    for (const token of RAIL_SQUARE.split(" ")) expect(tile(one).classList.contains(token)).toBe(true);
    const name = within(one).getByText("one");
    expect(tile(one).compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("tab 以 title 带出项目全名（名称在方块下会截断）", () => {
    renderPanel({
      snapshot: snapshot({
        tabs: [{ key: "local:/proj/long", name: "specseal-desktop", source: "local", status: "ready" }],
        activeKey: "local:/proj/long",
      }),
    });
    expect(screen.getByTestId("panel-project-local:/proj/long").getAttribute("title")).toBe("specseal-desktop");
  });

  it("首字母与图标列同一规则：去头尾空白后取第一个字", () => {
    renderPanel({
      snapshot: snapshot({
        tabs: [{ key: "local:/proj/sp", name: " 规格", source: "local", status: "ready" }],
        activeKey: "local:/proj/sp",
      }),
    });
    expect(tile(screen.getByTestId("panel-project-local:/proj/sp")).textContent).toBe("规");
  });

  it("「加入项目」与项目 tab 同构：虚线框「＋」方块（与图标列的「＋」同形）其下为「加入项目」文本", () => {
    renderPanel();
    const add = screen.getByTestId("panel-add-project");
    const square = add.querySelector("[data-project-tile]") as HTMLElement;
    for (const token of RAIL_SQUARE.split(" ")) expect(square.classList.contains(token)).toBe(true);
    expect(square.className.split(/\s+/)).toEqual(expect.arrayContaining(["border-dashed", "border-border"]));
    const label = within(add).getByText("加入项目");
    expect(follows(square, label)).toBe(true);
    // 文本不截断（英文「Add project」比项目 tab 宽），宽度至少与项目 tab 对齐。
    expect(label.className.split(/\s+/)).toContain("whitespace-nowrap");
    expect(add.className.split(/\s+/)).toContain("min-w-16");
  });

  it("「加入项目」固定在 tab 条卡右端、不在可卷区内，带名称且点击触发 onAddProject 而非 onOpenProject（D7）", () => {
    const h = renderPanel();
    const card = screen.getByTestId("panel-project-card");
    const strip = screen.getByTestId("panel-project-tabs");
    const add = within(card).getByTestId("panel-add-project");
    expect(strip.contains(add)).toBe(false);
    expect(follows(strip, add)).toBe(true);
    expect(add.getAttribute("aria-label")).toBe("加入项目");
    expect(add.getAttribute("title")).toBe("加入项目");
    fireEvent.click(add);
    expect(h.onAddProject).toHaveBeenCalled();
    expect(h.onOpenProject).not.toHaveBeenCalled();
  });

  it("tab 容器横向卷动且隐藏滚动条", () => {
    renderPanel();
    const strip = screen.getByTestId("panel-project-tabs");
    const classes = strip.className.split(/\s+/);
    expect(classes).toContain("overflow-x-auto");
    expect(classes).toContain("[scrollbar-width:none]");
    expect(classes).toContain("[&::-webkit-scrollbar]:hidden");
  });
});

// spec「面板样式」的边缘淡出（design「项目 tab 条：「＋」固定右端、边缘淡出、卷到作用中」
// 「中段上下缘淡出：与 tab 条共用边缘淡出」）：淡出判断与遮罩是 edgeFade.ts 的纯函数、tab 条与中段
// 共用——start＝左／上、end＝右／下。
describe("面板可卷区的边缘淡出", () => {
  // spec Example「淡出的侧边」（tab 条）：可卷区宽 250、tab 总宽 500（未超出那列为 250）。
  it.each([
    { position: "最左端", scrollLeft: 0, scrollWidth: 500, fade: "end" },
    { position: "中间", scrollLeft: 100, scrollWidth: 500, fade: "both" },
    { position: "最右端", scrollLeft: 250, scrollWidth: 500, fade: "start" },
    { position: "tab 总宽未超出", scrollLeft: 0, scrollWidth: 250, fade: "none" },
  ])("tab 条：$position → $fade", ({ scrollLeft, scrollWidth, fade }) => {
    expect(edgeFade({ position: scrollLeft, scrollSize: scrollWidth, viewportSize: 250 })).toBe(fade);
  });

  // spec Example「中段淡出的边缘」：中段可视高 400、内容高 900（未超限那列为 400）。
  it.each([
    { position: "最上方", scrollTop: 0, scrollHeight: 900, fade: "end" },
    { position: "中间", scrollTop: 250, scrollHeight: 900, fade: "both" },
    { position: "最下方", scrollTop: 500, scrollHeight: 900, fade: "start" },
    { position: "内容未超限", scrollTop: 0, scrollHeight: 400, fade: "none" },
  ])("中段：$position → $fade", ({ scrollTop, scrollHeight, fade }) => {
    expect(edgeFade({ position: scrollTop, scrollSize: scrollHeight, viewportSize: 400 })).toBe(fade);
  });

  it("容差 1px：小数卷动位置差不到 1px 视为已到尽头", () => {
    expect(edgeFade({ position: 0.6, scrollSize: 500, viewportSize: 250 })).toBe("end");
    expect(edgeFade({ position: 249.5, scrollSize: 500, viewportSize: 250 })).toBe("start");
  });

  it("遮罩：不淡出时不挂遮罩；横向沿 to right、纵向沿 to bottom，淡出侧渐到透明", () => {
    expect(edgeFadeMask("x", "none")).toBeUndefined();
    expect(edgeFadeMask("y", "none")).toBeUndefined();
    expect(edgeFadeMask("x", "start")).toBe(`linear-gradient(to right, transparent, black ${EDGE_FADE_PX}px, black)`);
    expect(edgeFadeMask("y", "end")).toBe(
      `linear-gradient(to bottom, black, black calc(100% - ${EDGE_FADE_PX}px), transparent)`,
    );
    expect(edgeFadeMask("y", "both")).toBe(
      `linear-gradient(to bottom, transparent, black ${EDGE_FADE_PX}px, black calc(100% - ${EDGE_FADE_PX}px), transparent)`,
    );
  });

  it("中段卷动后上下缘淡出随是否还有内容改变；固定页眉与页脚不带淡出", () => {
    renderPanel();
    const scroll = screen.getByTestId("panel-scroll");
    const scrollTo = (scrollTop: number, scrollHeight = 900) =>
      scrollWith(scroll, { scrollTop, scrollHeight, clientHeight: 400 });
    expect(scroll.getAttribute("data-fade")).toBe("none");
    scrollTo(0);
    expect(scroll.getAttribute("data-fade")).toBe("end");
    scrollTo(250);
    expect(scroll.getAttribute("data-fade")).toBe("both");
    scrollTo(500);
    expect(scroll.getAttribute("data-fade")).toBe("start");
    scrollTo(0, 400);
    expect(scroll.getAttribute("data-fade")).toBe("none");
    for (const id of ["panel-header", "panel-footer"]) {
      expect(screen.getByTestId(id).getAttribute("data-fade")).toBeNull();
      expect(screen.getByTestId(id).getAttribute("style")).toBeNull();
    }
  });

  it("尺寸改变时重算淡出：中段内容 wrapper 变高、tab 清单改变，不必等卷动事件", () => {
    // 可手动触发的 ResizeObserver 替身（全域 stub 是 no-op）：记下每个观察者与它观察的元素。
    const observers: Array<{ callback: () => void; targets: Element[] }> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private entry: { callback: () => void; targets: Element[] };
        constructor(callback: () => void) {
          this.entry = { callback, targets: [] };
          observers.push(this.entry);
        }
        observe(el: Element) {
          this.entry.targets.push(el);
        }
        unobserve() {}
        disconnect() {
          this.entry.targets = [];
        }
      },
    );
    try {
      const h = renderPanel({ snapshot: snapshot({ tabs: six.slice(0, 3), activeKey: six[0].key }) });
      // 中段：内容 wrapper 变高到超出可视高（收合展开、快照增减）→ 下缘淡出。
      const scroll = screen.getByTestId("panel-scroll");
      const content = screen.getByTestId("panel-scroll-content");
      injectMetrics(scroll, { scrollTop: 0, scrollHeight: 900, clientHeight: 400 });
      expect(scroll.getAttribute("data-fade")).toBe("none");
      act(() => {
        for (const o of observers) if (o.targets.includes(content)) o.callback();
      });
      expect(scroll.getAttribute("data-fade")).toBe("end");
      // tab 条：tab 清单由 3 个变 6 个、总宽超出可卷区 → 右侧淡出。
      const strip = screen.getByTestId("panel-project-tabs");
      injectMetrics(strip, { scrollLeft: 0, scrollWidth: 416, clientWidth: 250 });
      // 注入尺寸本身不触发重算（jsdom 挂载时的值沿用）；tab 清单改变才重算。
      expect(strip.getAttribute("data-fade")).not.toBe("end");
      h.pushSnapshot(snapshot({ tabs: six, activeKey: six[0].key }));
      expect(strip.getAttribute("data-fade")).toBe("end");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// spec「面板样式」的项目 tab 条卷动（design「项目 tab 条：「＋」固定右端、边缘淡出、
// 卷到作用中」）：露出目标是 tabStrip.ts 的纯函数；jsdom 没有版面，组件测试以注入尺寸验证接线。
describe("面板项目 tab 条的淡出与卷到作用中", () => {

  // 露出目标：tab 宽 64、可卷区宽 250。结果要让 tab 完整落在可视范围内。
  const fullyVisible = (tabLeft: number, scrollLeft: number) =>
    tabLeft >= scrollLeft && tabLeft + 64 <= scrollLeft + 250;

  it("露出目标：已完整可见 → 不动", () => {
    expect(tabRevealScrollLeft({ tabLeft: 74, tabWidth: 64, scrollLeft: 0, viewportWidth: 250 })).toBe(0);
    expect(tabRevealScrollLeft({ tabLeft: 142, tabWidth: 64, scrollLeft: 60, viewportWidth: 250 })).toBe(60);
  });

  it("露出目标：在右侧外 → 往右卷到它完整可见", () => {
    const next = tabRevealScrollLeft({ tabLeft: 346, tabWidth: 64, scrollLeft: 0, viewportWidth: 250 });
    expect(next).toBeGreaterThan(0);
    expect(fullyVisible(346, next)).toBe(true);
  });

  it("露出目标：在左侧外 → 往左卷到它完整可见，且不小于 0", () => {
    const next = tabRevealScrollLeft({ tabLeft: 74, tabWidth: 64, scrollLeft: 150, viewportWidth: 250 });
    expect(next).toBeLessThan(150);
    expect(next).toBeGreaterThanOrEqual(0);
    expect(fullyVisible(74, next)).toBe(true);
    expect(tabRevealScrollLeft({ tabLeft: 6, tabWidth: 64, scrollLeft: 150, viewportWidth: 250 })).toBe(0);
  });

  it("卷动事件后可卷区的遮罩随左右是否还有隐藏的 tab 改变", () => {
    renderPanel({ snapshot: snapshot({ tabs: six, activeKey: six[0].key }) });
    const strip = screen.getByTestId("panel-project-tabs");
    const scrollTo = (scrollLeft: number, scrollWidth = 500) =>
      scrollWith(strip, { scrollLeft, scrollWidth, clientWidth: 250 });
    scrollTo(0);
    expect(strip.getAttribute("data-fade")).toBe("end");
    scrollTo(100);
    expect(strip.getAttribute("data-fade")).toBe("both");
    scrollTo(250);
    expect(strip.getAttribute("data-fade")).toBe("start");
    scrollTo(0, 250);
    expect(strip.getAttribute("data-fade")).toBe("none");
  });

  it("6 个项目、作用中为第 6 个：打开时卷到它完整可见、左侧淡出；面板再次取得焦点时重新卷回", () => {
    // 版面注入：tab 宽 64、间距 4、可卷区内距 6、可卷区宽 250（第 4 个起超出）。
    const tabLeft = (el: Element) => {
      const n = /^panel-project-local:\/proj\/p(\d)$/.exec(el.getAttribute("data-testid") ?? "")?.[1];
      return n === undefined ? null : 6 + (Number(n) - 1) * 68;
    };
    const isStrip = (el: Element) => el.getAttribute("data-testid") === "panel-project-tabs";
    const scrollLefts = new WeakMap<Element, number>();
    const stubs: Array<[object, string, PropertyDescriptor]> = [
      [HTMLElement.prototype, "offsetLeft", { get(this: Element) { return tabLeft(this) ?? 0; } }],
      [HTMLElement.prototype, "offsetWidth", { get(this: Element) { return tabLeft(this) === null ? 0 : 64; } }],
      [Element.prototype, "clientWidth", { get(this: Element) { return isStrip(this) ? 250 : 0; } }],
      [Element.prototype, "scrollWidth", { get(this: Element) { return isStrip(this) ? 416 : 0; } }],
      [
        Element.prototype,
        "scrollLeft",
        {
          get(this: Element) { return scrollLefts.get(this) ?? 0; },
          set(this: Element, v: number) { scrollLefts.set(this, v); },
        },
      ],
    ];
    const originals = stubs.map(([proto, name]) => [proto, name, Object.getOwnPropertyDescriptor(proto, name)] as const);
    for (const [proto, name, desc] of stubs) Object.defineProperty(proto, name, { configurable: true, ...desc });
    try {
      renderPanel({ snapshot: snapshot({ tabs: six, activeKey: six[5].key }) });
      const strip = screen.getByTestId("panel-project-tabs");
      const sixthLeft = 6 + 5 * 68;
      expect(strip.scrollLeft).toBeGreaterThan(0);
      expect(fullyVisible(sixthLeft, strip.scrollLeft)).toBe(true);
      // 卷到作用中 tab 后左侧有隐藏的 tab、右侧已到尽头：只淡左（spec 情境「打开面板时卷到作用中项目」）。
      expect(strip.getAttribute("data-fade")).toBe("start");
      // 用户把 tab 条卷回最左后关闭面板；再次打开（面板窗口取得焦点）时卷回作用中 tab。
      strip.scrollLeft = 0;
      act(() => {
        fireEvent.focus(window);
      });
      expect(fullyVisible(sixthLeft, strip.scrollLeft)).toBe(true);
    } finally {
      for (const [proto, name, desc] of originals) {
        if (desc) Object.defineProperty(proto, name, desc);
        else delete (proto as Record<string, unknown>)[name];
      }
    }
  });
});

describe("TrayPanel 分区卡片化与主色（spec「面板样式」；design D2／D3）", () => {
  const discBoth = [
    { slug: "open-d", topic: "讨论中的", promoted: false },
    { slug: "prom-d", topic: "已转出的", promoted: true },
  ];

  it("tab 条、各分区（含已转出卡）与动作区各自为白底细框 12px 圆角卡", () => {
    renderPanel({ snapshot: snapshot({ discussions: discBoth }) });
    for (const id of [
      "panel-project-card",
      "panel-section-proposed",
      "panel-section-in-progress",
      "panel-section-ready",
      "panel-section-discussions",
      "panel-section-promoted",
      "panel-actions-card",
    ]) {
      const classes = screen.getByTestId(id).className.split(/\s+/);
      expect(classes).toEqual(expect.arrayContaining(["bg-card", "border", "border-border", "rounded-xl"]));
    }
  });

  it("生命周期与讨论分区图标各取所属色相，已转出卡标头为中性灰的讨论图标", () => {
    // spec「生命周期四栏各一色相」：系统匣分区与看板四栏同色，同一来源（stage.ts）；
    // 已转出不是生命周期阶段：图标与计数徽章维持中性（desktop-app「接口状态语意色分层」）。
    renderPanel({ snapshot: snapshot({ discussions: discBoth }) });
    const iconClasses = (id: string) =>
      (screen.getByTestId(id).querySelector("svg")?.getAttribute("class") ?? "").split(/\s+/);
    expect(iconClasses("panel-section-proposed")).toContain(STAGE_ICON.proposed);
    expect(iconClasses("panel-section-in-progress")).toContain(STAGE_ICON["in-progress"]);
    expect(iconClasses("panel-section-ready")).toContain(STAGE_ICON.ready);
    expect(STAGE_ICON.proposed).toBe("text-stage-proposed");
    expect(STAGE_ICON["in-progress"]).toBe("text-stage-in-progress");
    expect(STAGE_ICON.ready).toBe("text-stage-ready");
    expect(iconClasses("panel-section-discussions")).toContain(DISCUSSION_TONE.icon);
    expect(DISCUSSION_TONE.icon).toBe("text-stage-discussion");
    // 已转出卡：与「讨论」卡同款图标，但灰色；不用页脚「打开 Specseal」的箭头图标。
    const promoted = screen.getByTestId("panel-section-promoted");
    expect(iconClasses("panel-section-discussions")).toContain("lucide-message-square-text");
    expect(iconClasses("panel-section-promoted")).toContain("lucide-message-square-text");
    expect(iconClasses("panel-section-promoted")).toContain("text-muted-foreground");
    expect(iconClasses("panel-section-promoted")).not.toContain(DISCUSSION_TONE.icon);
    // 计数徽章沿用 Badge 的 secondary 变体（中性灰底），调用端不以 className 覆写颜色。
    const badge = within(promoted).getByTestId("section-count").className.split(/\s+/);
    expect(badge).toEqual(expect.arrayContaining(["bg-muted", "text-foreground"]));
    expect(badge).not.toContain("text-muted-foreground");
    for (const token of DISCUSSION_TONE.badge.split(/\s+/)) expect(badge).not.toContain(token);
    expect(promoted.querySelector("svg.lucide-arrow-up-right")).toBeNull();
    // 展开后已转出列不另加底色：列的祖先节点都没有旧收合列的 bg-muted/40。
    fireEvent.click(sectionToggle("panel-section-promoted"));
    for (let el = screen.getByTestId("panel-discussion-prom-d").parentElement; el; el = el.parentElement) {
      expect((el.getAttribute("class") ?? "").split(/\s+/)).not.toContain("bg-muted/40");
    }
  });

  it("根容器以毛玻璃同半径圆角裁切（wash 不得画出 vibrancy 圆角外）", () => {
    renderPanel();
    const root = screen.getByTestId("panel-root");
    expect(root.className.split(/\s+/)).toContain("rounded-[13px]");
  });

  it("根层不叠渐层、以侧栏面色约六成补光，白卡维持不透明", () => {
    // 主色留给选取与主要操作；渐层 wash 随卡片化移除。补光层调回约六成，毛玻璃才从
    // 外框与卡片缝隙透得出来；卡片本身维持不透明白底（卡内亮度锚定卡片面色）。
    renderPanel({ snapshot: snapshot({ discussions: discBoth }) });
    const root = screen.getByTestId("panel-root");
    expect(root.className).not.toContain("bg-linear-to-b");
    expect(root.className).not.toContain("from-");
    expect(root.className.split(/\s+/)).toContain("bg-sidebar/60");
    expect(root.className.split(/\s+/)).not.toContain("bg-sidebar/90");
    for (const id of [
      "panel-project-card",
      "panel-section-proposed",
      "panel-section-in-progress",
      "panel-section-ready",
      "panel-section-discussions",
      "panel-actions-card",
    ]) {
      expect(screen.getByTestId(id).className.split(/\s+/)).toContain("bg-card");
    }
  });

  it("卡内的列以细线分隔、hover 为半透明前景色灰底，不以主色实心反白", () => {
    const eight = Array.from({ length: 8 }, (_, i) =>
      change({ name: `c${i}`, totalTasks: 2, completedTasks: 1 }),
    );
    renderPanel({ snapshot: snapshot({ changes: eight, discussions: discBoth }) });
    const rows = [
      screen.getByTestId("panel-change-c0"),
      screen.getByTestId("panel-discussion-open-d"),
      screen.getByText("还有 3 个…").parentElement!,
    ];
    for (const row of rows) {
      const classes = row.className.split(/\s+/);
      expect(classes).toEqual(expect.arrayContaining(["hover:bg-foreground/5", "border-b", "last:border-b-0"]));
      // 列内已无 group-hover 配色，列不必是 group。
      expect(classes).not.toContain("group");
      expect(row.className).not.toContain("hover:bg-primary");
      expect(row.className).not.toMatch(/rounded/);
    }
    // 列内任何元素都不挂 hover 反白配色（站章、波次、任务数、topic、进度条、动作图标、拷贝钮）。
    expect(document.body.innerHTML).not.toContain("group-hover:text-primary-foreground");
    expect(document.body.innerHTML).not.toContain("group-hover:bg-primary-foreground");
  });

  it("有内容的卡标头下有细线，空状态卡标头无", () => {
    renderPanel({ snapshot: snapshot({ changes: [change({ name: "solo", totalTasks: 2, completedTasks: 1 })] }) });
    // 进行中有一列、讨论有一则：标头下有线。
    for (const id of ["panel-section-in-progress", "panel-section-discussions"]) {
      expect(sectionHeader(id).className.split(/\s+/)).toEqual(expect.arrayContaining(["border-b", "px-3", "py-2"]));
    }
    // 提案中、已就绪为空状态卡：标头下无线。
    for (const id of ["panel-section-proposed", "panel-section-ready"]) {
      expect(sectionHeader(id).className.split(/\s+/)).not.toContain("border-b");
    }
  });

  it("加载中与加载失败的卡标头下有细线（其下有骨架或失败提示）", () => {
    renderPanel({ snapshot: snapshot({ workspaceLoading: true, changes: [], discussions: [] }) });
    for (const id of ["panel-section-proposed", "panel-section-discussions"]) {
      expect(sectionHeader(id).className.split(/\s+/)).toContain("border-b");
    }
    cleanup();
    renderPanel({ snapshot: snapshot({ workspaceLoadFailed: true, changes: [], discussions: [] }) });
    for (const id of ["panel-section-proposed", "panel-section-discussions"]) {
      expect(sectionHeader(id).className.split(/\s+/)).toContain("border-b");
    }
  });

  it("进度条填色依阶段套用共用色阶（STAGE_BAR）", () => {
    renderPanel();
    const fillClasses = (name: string) =>
      (
        screen
          .getByTestId(`panel-change-${name}`)
          .querySelector('[data-testid="panel-progress-fill"]')?.className ?? ""
      ).split(/\s+/);
    expect(fillClasses("prop")).toContain(STAGE_BAR.proposed);
    expect(fillClasses("inprog")).toContain(STAGE_BAR["in-progress"]);
    expect(fillClasses("rdy")).toContain(STAGE_BAR.ready);
    // 三阶各一色相（与看板同源），互不相同。
    expect(new Set([STAGE_BAR.proposed, STAGE_BAR["in-progress"], STAGE_BAR.ready]).size).toBe(3);
  });
});

describe("面板根层的平台外观（spec「面板样式」平台差异；tray-panel-windows design D2）", () => {
  it("Windows：不透明侧栏底色、不画圆角、不铺半透明补光", () => {
    renderPanel({ platform: "windows" });
    const classes = screen.getByTestId("panel-root").className.split(/\s+/);
    expect(classes).toContain("bg-sidebar");
    expect(classes).not.toContain("rounded-[13px]");
    expect(classes).not.toContain("bg-sidebar/60");
  });

  it("macOS：维持 13px 圆角与约六成补光层", () => {
    renderPanel({ platform: "macos" });
    const classes = screen.getByTestId("panel-root").className.split(/\s+/);
    expect(classes).toContain("rounded-[13px]");
    expect(classes).toContain("bg-sidebar/60");
    expect(classes).not.toContain("bg-sidebar");
  });
});

describe("TrayPanel 分区计数（spec「面板样式」；design D8）", () => {
  it("各分区标题带项目计数徽章（STAGE_BADGE 同语汇；讨论分区取看板讨论栏同款，只计讨论中）", () => {
    renderPanel({
      snapshot: snapshot({
        discussions: [
          { slug: "open-d", topic: "讨论中的", promoted: false },
          { slug: "prom-d", topic: "已转出的", promoted: true },
        ],
      }),
    });
    const count = (id: string) =>
      screen.getByTestId(id).querySelector('[data-testid="section-count"]')!;
    for (const id of [
      "panel-section-proposed",
      "panel-section-in-progress",
      "panel-section-ready",
      "panel-section-discussions",
    ]) {
      expect(count(id).textContent).toBe("1");
    }
    expect(count("panel-section-proposed").className.split(/\s+/)).toEqual(
      expect.arrayContaining(STAGE_BADGE.proposed.split(/\s+/)),
    );
    expect(count("panel-section-ready").className.split(/\s+/)).toEqual(
      expect.arrayContaining(STAGE_BADGE.ready.split(/\s+/)),
    );
    // 讨论分区计数取桃紫（与看板讨论栏同款）；已转出不是生命周期阶段，维持中性。
    expect(count("panel-section-discussions").className.split(/\s+/)).toEqual(
      expect.arrayContaining(DISCUSSION_TONE.badge.split(/\s+/)),
    );
  });
});

describe("TrayPanel 状态语意色（spec「接口状态语意色分层」）", () => {
  const remoteTab = (over: Record<string, unknown>) => ({
    key: "remote:c1/demo/backend",
    name: "Demo/backend",
    source: "remote",
    connectionId: "c1",
    serverLabel: "Team Server",
    ...over,
  });

  const renderTab = (over: Record<string, unknown>) =>
    renderPanel({
      snapshot: snapshot({
        tabs: [remoteTab(over)],
        activeKey: "remote:c1/demo/backend",
      } as unknown as Partial<TraySnapshot>),
    });

  it("复原卡依状态分色：还原中为蓝、错误为红、需重新登录维持琥珀", () => {
    const iconWrap = () =>
      screen.getByTestId("panel-recovery-card").querySelector("span") as HTMLElement;

    renderTab({ status: "restoring" });
    expect(iconWrap().className).toContain(SEMANTIC_TONE.inProgress);
    cleanup();

    renderTab({ status: "error", failureKind: "unreachable" });
    expect(iconWrap().className).toContain("destructive");
    cleanup();

    renderTab({ status: "error", failureKind: "needs-reauth" });
    expect(iconWrap().className).toContain("status-warning");
  });

  it.each([
    { status: "restoring", failureKind: undefined, label: "正在连接", tone: SEMANTIC_TONE.inProgress },
    { status: "error", failureKind: "unreachable", label: "无法连接", tone: SEMANTIC_TONE.danger },
  ])("作用中 $status 分页：方块同为实心主色标示选取，状态由状态字的语意色承载", ({ status, failureKind, label, tone }) => {
    renderTab({ status, failureKind });
    const tab = screen.getByTestId("panel-project-remote:c1/demo/backend");
    // 选取只由方块承载（与图标列一致），tab 本体不画主色外框、不涂琥珀。
    const square = tab.querySelector("[data-project-tile]") as HTMLElement;
    expect(square.className.split(/\s+/)).toContain("bg-primary");
    expect(tab.className).not.toContain("border-primary");
    expect(tab.className).not.toContain("status-warning");
    // 状态文本自己带语意色：还原中＝蓝、连不上＝红。
    expect(within(tab).getByText(label).className).toContain(tone);
  });

  it("stale 列为琥珀淡底卡，「重新登录」钮为中性 outline、不与琥珀警示抢注意力", () => {
    renderTab({ status: "needs-reauth" });
    const stale = screen.getByTestId("panel-stale-status");
    expect(stale.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["rounded-xl", "border", ...SEMANTIC_SURFACE.warning.split(" ")]),
    );
    const button = within(stale).getByRole("button", { name: "重新登录" });
    expect(button.className).toContain("border");
    expect(button.className).not.toContain("status-warning");
    expect(button.getAttribute("tabindex")).toBe("-1");
  });

  it("复原卡为白底卡＋语意色边框，信息区淡灰底，动作钮为共用 Button（主要实心、次要 outline）", () => {
    renderTab({ status: "error", failureKind: "unreachable" });
    const card = screen.getByTestId("panel-recovery-card");
    const classes = card.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["rounded-xl", "border", "bg-card", "border-destructive/40"]));
    // 语意色只留边框：淡红底被白卡盖掉。
    expect(classes).not.toContain("bg-destructive/10");
    expect(card.querySelector("dl")!.className.split(/\s+/)).toContain("bg-muted/50");
    const retry = within(card).getByRole("button", { name: "重新连接" });
    expect(retry.className.split(/\s+/)).toEqual(expect.arrayContaining(["bg-primary", "col-span-2", "h-7"]));
    for (const name of ["查看问题", "服务器设置"]) {
      const button = within(card).getByRole("button", { name });
      expect(button.className.split(/\s+/)).toEqual(expect.arrayContaining(["border", "border-input", "h-7"]));
    }
    for (const button of within(card).getAllByRole("button")) {
      expect(button.getAttribute("tabindex")).toBe("-1");
    }
  });
});

describe("TrayPanel 交互（打开与 hover 拷贝）", () => {
  it("点击变更列本体发出打开事件（携带 change name）", () => {
    const h = renderPanel();
    fireEvent.click(screen.getByTestId("panel-change-inprog"));
    expect(h.onOpenChange).toHaveBeenCalledWith("inprog");
  });

  it("点击讨论列本体发出打开事件（携带 slug）", () => {
    const h = renderPanel();
    fireEvent.click(screen.getByTestId("panel-discussion-d1"));
    expect(h.onOpenDiscussion).toHaveBeenCalledWith("d1");
  });

  it("变更列拷贝钮回调 name（不含进度字符）且不触发打开", () => {
    const h = renderPanel();
    const row = screen.getByTestId("panel-change-inprog");
    fireEvent.click(within(row).getByRole("button", { name: "拷贝名称" }));
    expect(h.onCopy).toHaveBeenCalledWith("inprog");
    expect(h.onOpenChange).not.toHaveBeenCalled();
  });

  it("讨论列拷贝钮回调 slug 且不触发打开", () => {
    const h = renderPanel();
    const row = screen.getByTestId("panel-discussion-d1");
    fireEvent.click(within(row).getByRole("button", { name: "拷贝 slug" }));
    expect(h.onCopy).toHaveBeenCalledWith("d1");
    expect(h.onOpenDiscussion).not.toHaveBeenCalled();
  });

  it("底部「打开 Specseal」回调打开主窗口", () => {
    const h = renderPanel();
    fireEvent.click(screen.getByText("打开 Specseal"));
    expect(h.onOpenApp).toHaveBeenCalled();
  });

  it("动作区块卡为单列：「打开 Specseal」文本钮在前，其后依序为「项目设置」「设置」「结束」三颗图标钮", () => {
    const h = renderPanel();
    const actions = screen.getByTestId("panel-actions-card");
    const open = within(actions).getByText("打开 Specseal");
    const iconButtons = within(actions)
      .getAllByRole("button")
      .filter((b) => b.textContent === "");
    expect(iconButtons.map((b) => b.getAttribute("aria-label"))).toEqual(["项目设置", "设置", "结束"]);
    const [projectSettings, settings, quit] = iconButtons;
    for (const b of iconButtons) {
      // 名称提示走原生 title（面板无焦点，不挂 Radix Tooltip）；图标钮退出 Tab 顺序。
      expect(b.getAttribute("title")).toBe(b.getAttribute("aria-label"));
      expect(b.getAttribute("tabindex")).toBe("-1");
      expect(b.getAttribute("type")).toBe("button");
      expect(follows(open, b)).toBe(true);
    }
    // 文本钮与图标钮的 hover 为半透明前景色灰底，不以主色反白。
    for (const b of [open.closest("button")!, ...iconButtons]) {
      expect(b.className.split(/\s+/)).toContain("hover:bg-foreground/5");
      expect(b.className).not.toContain("hover:bg-primary");
    }
    // 「设置」与「结束」之间以细直线分隔符隔开防误按：间距由分隔符两侧外距承担，钮本身不带左外距。
    const separator = within(actions).getByTestId("panel-action-separator");
    expect(separator.getAttribute("aria-hidden")).toBe("true");
    expect(follows(settings, separator)).toBe(true);
    expect(follows(separator, quit)).toBe(true);
    expect(follows(projectSettings, separator)).toBe(true);
    for (const b of [open.closest("button")!, ...iconButtons]) {
      expect(b.className).not.toMatch(/(^|\s)ml-\d/);
    }
    // 四颗钮同在一列（同一个父节点）。
    expect(new Set([open.closest("button")!, ...iconButtons].map((b) => b.parentElement)).size).toBe(1);
    fireEvent.click(projectSettings);
    expect(h.onOpenProjectSettings).toHaveBeenCalled();
    expect(h.onOpenSettings).not.toHaveBeenCalled();
    fireEvent.click(settings);
    expect(h.onOpenSettings).toHaveBeenCalled();
    expect(h.onOpenApp).not.toHaveBeenCalled();
    fireEvent.click(quit);
    expect(h.onQuit).toHaveBeenCalled();
  });

  it("拷贝钮退出 tab 顺序（tabIndex=-1）且点击仍拷贝（design D4 焦点修复）", () => {
    const h = renderPanel();
    const discBtn = within(screen.getByTestId("panel-discussion-d1")).getByRole("button", {
      name: "拷贝 slug",
    });
    const changeBtn = within(screen.getByTestId("panel-change-inprog")).getByRole("button", {
      name: "拷贝名称",
    });
    expect(discBtn.getAttribute("tabindex")).toBe("-1");
    expect(changeBtn.getAttribute("tabindex")).toBe("-1");
    // 列 hover 为灰底、不反白：拷贝钮维持本色，不带反白配色。
    for (const b of [discBtn, changeBtn]) expect(b.className).not.toContain("group-hover:text-primary-foreground");
    fireEvent.click(discBtn);
    expect(h.onCopy).toHaveBeenCalledWith("d1");
  });

  it("拷贝回馈：点击后图标短暂转勾号、1.5 秒后复原（共用 CopyButton）", () => {
    vi.useFakeTimers();
    const h = renderPanel();
    const row = screen.getByTestId("panel-discussion-d1");
    const btn = within(row).getByRole("button", { name: "拷贝 slug" });
    expect(btn.querySelector("svg.lucide-check")).toBeNull();
    fireEvent.click(btn);
    expect(h.onCopy).toHaveBeenCalledWith("d1");
    expect(btn.querySelector("svg.lucide-check")).toBeTruthy();
    expect(btn.querySelector("svg.lucide-copy")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect(btn.querySelector("svg.lucide-check")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(btn.querySelector("svg.lucide-check")).toBeNull();
    expect(btn.querySelector("svg.lucide-copy")).toBeTruthy();
    vi.useRealTimers();
  });
});

describe("三段式版面（spec「面板样式」：固定页眉／可卷中段／固定页脚）", () => {
  it("页眉为 tab 条卡、中段含分区卡并带纵向卷动样式、页脚为动作单列卡；无分割线", () => {
    renderPanel();
    const header = screen.getByTestId("panel-header");
    const scroll = screen.getByTestId("panel-scroll");
    const footer = screen.getByTestId("panel-footer");
    // 页眉＝tab 条卡；中段＝生命周期与讨论分区卡；页脚＝动作单列卡
    expect(within(within(header).getByTestId("panel-project-card")).getByTestId("panel-project-tabs")).toBeTruthy();
    expect(within(scroll).getByTestId("panel-section-discussions")).toBeTruthy();
    expect(within(scroll).getByTestId("panel-section-proposed")).toBeTruthy();
    expect(within(scroll).getByTestId("panel-section-ready")).toBeTruthy();
    const actions = within(footer).getByTestId("panel-actions-card");
    expect(within(actions).getByText("打开 Specseal")).toBeTruthy();
    for (const name of ["项目设置", "设置", "结束"]) {
      expect(within(actions).getByRole("button", { name })).toBeTruthy();
    }
    // 卷动样式只挂中段
    expect(scroll.className).toContain("overflow-y-auto");
    expect(header.className).not.toContain("overflow-y-auto");
    expect(footer.className).not.toContain("overflow-y-auto");
    expect(screen.queryAllByTestId("panel-divider")).toHaveLength(0);
  });

  it("中段隐藏原生滚动条（不占版面宽度）——原生滚动条在此环境常驻且占宽，改由指示条自绘", () => {
    renderPanel();
    const scroll = screen.getByTestId("panel-scroll");
    expect(scroll.className).toContain("[scrollbar-width:none]");
    expect(scroll.className).toContain("[&::-webkit-scrollbar]:hidden");
  });

  it("卷动指示条：内容未溢出不渲染；卷动时浮现，停止约 0.8 秒后淡出", () => {
    vi.useFakeTimers();
    renderPanel();
    const scroll = screen.getByTestId("panel-scroll");
    // jsdom 无版面计算：以量测值仿真「内容溢出」，指示条的几何与显隐皆由此推导
    expect(screen.queryByTestId("panel-scroll-indicator")).toBeNull();
    for (const [prop, value] of [
      ["clientHeight", 200],
      ["scrollHeight", 600],
      ["scrollTop", 0],
    ] as const) {
      Object.defineProperty(scroll, prop, { configurable: true, value });
    }
    act(() => {
      fireEvent.scroll(scroll);
    });
    const indicator = screen.getByTestId("panel-scroll-indicator");
    expect(indicator.getAttribute("data-active")).toBe("true");
    expect(indicator.className).toContain("opacity-100");
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(screen.getByTestId("panel-scroll-indicator").getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("panel-scroll-indicator").className).toContain("opacity-0");
    vi.useRealTimers();
  });

  it("毛玻璃补光层：root 带侧栏面色半透明基底（随深浅模式，亮度锚定侧栏面色）", () => {
    renderPanel();
    // 浓度约六成、真机可微调——只断言补光层存在（bg-sidebar/<n>）
    expect(screen.getByTestId("panel-root").className).toMatch(/bg-sidebar\/\d+/);
  });

  it("recovery 排列下复原卡归中段、页眉页脚结构不分支", () => {
    const key = "remote:c1/demo/backend";
    renderPanel({
      snapshot: snapshot({
        tabs: [
          {
            key,
            name: "Demo/backend",
            source: "remote",
            status: "error",
            connectionId: "c1",
            serverLabel: "Team Server",
          },
        ],
        activeKey: key,
      } as unknown as Partial<TraySnapshot>),
    });
    const header = screen.getByTestId("panel-header");
    const scroll = screen.getByTestId("panel-scroll");
    const footer = screen.getByTestId("panel-footer");
    expect(within(header).getByTestId("panel-project-card")).toBeTruthy();
    expect(within(scroll).getByTestId("panel-recovery-card")).toBeTruthy();
    expect(within(within(footer).getByTestId("panel-actions-card")).getByRole("button", { name: "结束" })).toBeTruthy();
    expect(screen.queryAllByTestId("panel-divider")).toHaveLength(0);
  });
});

// --- 面板变更列的品质站章（spec tray-status-menu「面板变更列的品质站章」；
// design D7）：两章并排、顺序固定，图标／色调／tooltip 与看板卡片共用同一组
// 样式表与 i18n 词条；非站章的行内符号不进 tray。
describe("面板变更列的品质站章", () => {
  function rowOf(name: string): HTMLElement {
    return screen.getByTestId(`panel-change-${name}`);
  }

  it("两章并排且顺序固定（审查章在前、验证章在后）", () => {
    // spec Scenario「面板两章并排」。
    renderPanel({
      snapshot: snapshot({
        changes: [
          change({
            name: "inprog",
            totalTasks: 12,
            completedTasks: 3,
            reviewStatus: "reviewed",
            verifyStatus: "verified",
          }),
        ],
      }),
    });
    const row = rowOf("inprog");
    const review = within(row).getByLabelText("已审查");
    const verify = within(row).getByLabelText("已验证");
    expect(review.compareDocumentPosition(verify) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 章落在名称与任务数之间。
    const count = within(row).getByText("3/12");
    expect(verify.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("单章情境只渲染该站的章", () => {
    // spec Scenario「仅验证章」。
    renderPanel({
      snapshot: snapshot({
        changes: [
          change({
            name: "inprog",
            totalTasks: 12,
            completedTasks: 3,
            reviewStatus: "none",
            verifyStatus: "inVerify",
          }),
        ],
      }),
    });
    const row = rowOf("inprog");
    expect(within(row).getByLabelText("验证中")).toBeTruthy();
    for (const label of ["审查中", "已审查", "已审查·其后有变动"]) {
      expect(within(row).queryByLabelText(label)).toBeNull();
    }
  });

  it("两站皆 none 时零站章，且列不长出其他行内符号", () => {
    // spec Scenario「无章时列组成不变」＋design D7：头像／讨论泡／restale／
    // metaError 明文不进 tray——那是看板的阅读脉络，一瞥接口上是杂讯。
    renderPanel({
      snapshot: snapshot({
        changes: [
          change({
            name: "inprog",
            totalTasks: 12,
            completedTasks: 3,
            reviewStatus: "none",
            verifyStatus: "none",
            createdBy: "Someone <s@example.com>",
            fromDiscussions: ["alpha"],
            restaleFrom: ["alpha"],
            metaError: "bad yaml",
          }),
        ],
      }),
    });
    const row = rowOf("inprog");
    for (const label of ["审查中", "已审查", "已审查·其后有变动", "验证中", "已验证", "已验证·其后有变动"]) {
      expect(within(row).queryByLabelText(label)).toBeNull();
    }
    expect(row.textContent).not.toContain("Someone");
    expect(row.textContent).not.toContain("alpha");
    expect(row.textContent).not.toContain("bad yaml");
    expect(within(row).queryByLabelText("S")).toBeNull();
  });

  it("hover 灰底时章色调不变：只取共用色调表、不挂 hover 改色", () => {
    // spec Scenario「hover 灰底时章色调不变」：列 hover 为半透明前景色灰底，
    // 章的对比不受影响，hover 期间维持与看板卡片共用的色调。
    renderPanel({
      snapshot: snapshot({
        changes: [
          change({
            name: "inprog",
            totalTasks: 12,
            completedTasks: 3,
            reviewStatus: "reviewed",
            verifyStatus: "verified",
          }),
        ],
      }),
    });
    const row = rowOf("inprog");
    const review = within(row).getByLabelText("已审查");
    const verify = within(row).getByLabelText("已验证");
    for (const badge of [review, verify]) {
      expect(badge.className).not.toContain("group-hover:");
    }
    expect(review.className).toContain(REVIEW_TONE.reviewed);
    expect(verify.className).toContain(VERIFY_TONE.verified);
  });

  it("章的样式与词条与看板卡片同源（不另建第二份对照）", () => {
    renderPanel({
      snapshot: snapshot({
        changes: [
          change({
            name: "inprog",
            totalTasks: 12,
            completedTasks: 3,
            reviewStatus: "reviewedStale",
            verifyStatus: "verifiedStale",
          }),
        ],
      }),
    });
    const row = rowOf("inprog");
    const review = within(row).getByLabelText("已审查·其后有变动");
    const verify = within(row).getByLabelText("已验证·其后有变动");
    expect(review.className).toContain(REVIEW_TONE.reviewedStale);
    expect(verify.className).toContain(VERIFY_TONE.verifiedStale);
    expect(VERIFY_TONE.verifiedStale).toBe(REVIEW_TONE.reviewedStale);
  });

  it("worktree 挂着时渲染 worktree 标记，样式与词条与看板卡片同源", () => {
    // worktree 挂着＝工作正于副本进行中，与站章同属影响收尾动作的状态；
    // 色调与 tooltip 沿看板卡片（SEMANTIC_TONE.inProgress＋card.worktree 词条）。
    renderPanel({
      snapshot: snapshot({
        changes: [
          change({
            name: "inprog",
            totalTasks: 12,
            completedTasks: 3,
            reviewStatus: "reviewed",
            verifyStatus: "verified",
            worktree: { branch: "specseal/inprog", path: "/w/inprog" },
          }),
        ],
      }),
    });
    const row = rowOf("inprog");
    const badge = within(row).getByLabelText("worktree");
    expect(badge.getAttribute("title")).toBe("在 worktree specseal/inprog 中进行");
    expect(badge.className).toContain(SEMANTIC_TONE.inProgress);
    // hover 灰底期间维持本色，与站章同规则。
    expect(badge.className).not.toContain("group-hover:");
    // 位置固定：站章之后、任务数之前。
    const verify = within(row).getByLabelText("已验证");
    const count = within(row).getByText("3/12");
    expect(verify.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(badge.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("无 worktree 时不渲染 worktree 标记", () => {
    renderPanel({
      snapshot: snapshot({
        changes: [
          change({ name: "inprog", totalTasks: 12, completedTasks: 3, worktree: null }),
        ],
      }),
    });
    expect(within(rowOf("inprog")).queryByLabelText("worktree")).toBeNull();
  });
});

// spec「面板分页切换中回馈」「面板分区首访 skeleton」（design D5）：
// 两个状态自 TraySnapshot 导出，面板纯渲染。
describe("面板加载回馈", () => {
  it("切换中 → 目标分页出 spinner，分区维持原 workspace 内容", () => {
    renderPanel({ snapshot: snapshot({ pendingTabKey: "local:/proj/two" }) });
    const target = screen.getByTestId("panel-project-local:/proj/two");
    expect(target.querySelector('[data-tab-pending="true"]')).toBeTruthy();
    // 分区照常显示既有数据——切换尚未发生。
    expect(screen.getByText("inprog")).toBeTruthy();
  });

  it("切换中 → 非目标分页不出 spinner", () => {
    renderPanel({ snapshot: snapshot({ pendingTabKey: "local:/proj/two" }) });
    const other = screen.getByTestId("panel-project-local:/proj/one");
    expect(other.querySelector('[data-tab-pending="true"]')).toBeNull();
  });

  it("无切换 → 全部分页无 spinner", () => {
    renderPanel();
    expect(document.querySelector('[data-tab-pending="true"]')).toBeNull();
  });

  it("首访未加载 → 分区标题照常、内容为占位列", () => {
    renderPanel({ snapshot: snapshot({ workspaceLoading: true, changes: [], discussions: [] }) });
    expect(screen.getByText("进行中")).toBeTruthy();
    expect(screen.getByText("讨论")).toBeTruthy();
    expect(document.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThan(0);
  });

  it("首访未加载 → 不显示分区计数（不谎报 0 笔）", () => {
    renderPanel({ snapshot: snapshot({ workspaceLoading: true, changes: [], discussions: [] }) });
    expect(document.querySelector('[data-testid="section-count"]')).toBeNull();
  });

  it("首访未加载 → 不显示空状态文案", () => {
    renderPanel({ snapshot: snapshot({ workspaceLoading: true, changes: [], discussions: [] }) });
    expect(screen.queryByText("尚无进行中变更")).toBeNull();
  });

  it("已加载 → 照常显示数据，无占位列", () => {
    renderPanel();
    expect(screen.getByText("inprog")).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  // 骨架条件整条由 store 导出（design D3）：零分页、探测失败、读取失败等
  // 「不会有加载发生」的情境一律为 false，面板不必自行辨识——旧版面板自组
  // 三栏旗标时，正是这几条让骨架永久挂着。
  it("零分页 → 不出占位列，走既有空状态卡", () => {
    renderPanel({
      snapshot: snapshot({
        tabs: [],
        activeKey: null,
        changes: [],
        discussions: [],
      }),
    });
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.getByTestId("panel-section-discussions")).toBeTruthy();
  });

  it("有分页但无活跃 workspace → 不出占位列", () => {
    renderPanel({
      snapshot: snapshot({
        activeKey: null,
        changes: [],
        discussions: [],
      }),
    });
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("remote 复原态屏蔽数据时 → 不出占位列（复原呈现优先）", () => {
    const key = "remote:c1/demo/backend";
    renderPanel({
      snapshot: snapshot({
        tabs: [
          {
            key,
            name: "Demo/backend",
            source: "remote",
            status: "error",
            failureKind: "unreachable",
            connectionId: "c1",
            serverLabel: "Team Server",
          },
        ],
        activeKey: key,
        workspaceLoading: true,
        changes: [],
        discussions: [],
      }),
    });
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  // spec「面板分区加载失败终态」：读不到 ≠ 确认是空的，两者不得同貌。
  it("首访加载失败 → 分区显示失败提示，非骨架、非空态", () => {
    renderPanel({
      snapshot: snapshot({ workspaceLoadFailed: true, changes: [], discussions: [] }),
    });
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.queryByText("尚无进行中变更")).toBeNull();
    expect(screen.getAllByTestId("panel-section-load-failed").length).toBeGreaterThan(0);
  });

  it("加载中优先于失败提示（重试在途时不留旧提示）", () => {
    renderPanel({
      snapshot: snapshot({
        workspaceLoading: true,
        workspaceLoadFailed: true,
        changes: [],
        discussions: [],
      }),
    });
    expect(document.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThan(0);
    expect(screen.queryByTestId("panel-section-load-failed")).toBeNull();
  });

  it("remote 复原态屏蔽数据时 → 不显示失败提示（复原呈现优先）", () => {
    const key = "remote:c1/demo/backend";
    renderPanel({
      snapshot: snapshot({
        tabs: [
          {
            key,
            name: "Demo/backend",
            source: "remote",
            status: "error",
            failureKind: "unreachable",
            connectionId: "c1",
            serverLabel: "Team Server",
          },
        ],
        activeKey: key,
        workspaceLoadFailed: true,
        changes: [],
        discussions: [],
      }),
    });
    expect(screen.queryByTestId("panel-section-load-failed")).toBeNull();
    expect(screen.getByTestId("panel-recovery-card")).toBeTruthy();
  });
});

// --- 变更列的波次标示与顺序同源（spec tray-status-menu「变更列的波次标示与顺序
// 同源」；add-change-plan-desktop design D7）：列首波次数字（tooltip 与看板卡片
// 共用 card.wave）、被挡列整列降透明度且 tooltip 列前置、缺 wave 时列不变。
describe("面板变更列的波次标示", () => {
  const rowOf = (name: string) => screen.getByTestId(`panel-change-${name}`);
  const planned = [
    change({ name: "add-a", totalTasks: 4, completedTasks: 1, wave: 1, blockedBy: [], dependsOn: [], overlaps: [] }),
    change({ name: "add-b", totalTasks: 4, completedTasks: 1, wave: 2, blockedBy: ["add-a"], dependsOn: ["add-a"], overlaps: [] }),
  ];

  it("列依 payload 顺序、列首为波次数字（名称之前），被挡列降透明度且 tooltip 列出前置", () => {
    // spec Scenario「面板列首波次与被挡变淡」。
    renderPanel({ snapshot: snapshot({ changes: planned, discussions: [] }) });
    const section = screen.getByTestId("panel-section-in-progress");
    const rows = within(section).getAllByTestId(/^panel-change-/).map((el) => el.dataset.testid);
    expect(rows).toEqual(["panel-change-add-a", "panel-change-add-b"]);

    const a = rowOf("add-a");
    const waveA = within(a).getByLabelText("第 1 波");
    expect(waveA.textContent).toBe("1");
    expect(waveA.compareDocumentPosition(within(a).getByText("add-a")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(a.className).not.toMatch(/opacity-/);
    expect(a.getAttribute("title")).toBeNull();

    const b = rowOf("add-b");
    expect(within(b).getByLabelText("第 2 波").textContent).toBe("2");
    expect(b.className).toMatch(/opacity-/);
    // 淡化落在列的内容上：列本身不降透明度，底部分隔线与其他列同色。
    expect(b.className.split(/\s+/)).toContain("[&>*]:opacity-60");
    expect(b.className.split(/\s+/)).not.toContain("opacity-60");
    expect(b.getAttribute("title")).toBe("等待：add-a");
  });

  it("hover 灰底期间波次数字维持主色、不改色", () => {
    renderPanel({ snapshot: snapshot({ changes: planned, discussions: [] }) });
    const wave = within(rowOf("add-a")).getByLabelText("第 1 波");
    expect(wave.className).toContain("text-primary");
    expect(wave.className).not.toContain("group-hover:");
  });

  it("缺 wave（remote 或 plan 成环）时列无波次数字、不变淡、无 tooltip", () => {
    // spec Scenario「缺字段不变」。
    renderPanel();
    const row = rowOf("inprog");
    expect(within(row).queryByLabelText(/^第 \d+ 波$/)).toBeNull();
    expect(row.className).not.toMatch(/opacity-/);
    expect(row.getAttribute("title")).toBeNull();
  });
});

// spec「讨论列表」面板的已转出卡展开记忆（design D4）：app 本机一键、与看板的记忆分开；
// 缺席或坏值视为收合，localStorage 不可用时读写都不抛错。
describe("面板已转出卡的展开记忆", () => {
  it("键缺席 → 收合", () => {
    localStorage.removeItem(TRAY_PROMOTED_EXPANDED_STORAGE_KEY);
    expect(readTrayPromotedExpanded()).toBe(false);
  });

  it("坏值（\"yes\"）→ 收合", () => {
    localStorage.setItem(TRAY_PROMOTED_EXPANDED_STORAGE_KEY, "yes");
    expect(readTrayPromotedExpanded()).toBe(false);
    localStorage.removeItem(TRAY_PROMOTED_EXPANDED_STORAGE_KEY);
  });

  it("写入 true 后读回 true，键与看板的记忆键分开", () => {
    writeTrayPromotedExpanded(true);
    expect(TRAY_PROMOTED_EXPANDED_STORAGE_KEY).toBe("specseal.tray.promotedExpanded");
    expect(localStorage.getItem(TRAY_PROMOTED_EXPANDED_STORAGE_KEY)).toBe("true");
    expect(readTrayPromotedExpanded()).toBe(true);
    localStorage.removeItem(TRAY_PROMOTED_EXPANDED_STORAGE_KEY);
  });

  it("localStorage 不可用时读回收合、写入不抛错", () => {
    // vitest.setup 挂的 localStorage 来自另一个 jsdom window，全域 Storage.prototype 拦不到；
    // spy 要落在该实例的 prototype（同 App.test 的做法）。
    const proto = Object.getPrototypeOf(localStorage) as Storage;
    localStorage.setItem(TRAY_PROMOTED_EXPANDED_STORAGE_KEY, "true");
    const get = vi.spyOn(proto, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const set = vi.spyOn(proto, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    try {
      // 键里明明是 "true"：读回 false 只可能来自 catch。
      expect(readTrayPromotedExpanded()).toBe(false);
      expect(() => writeTrayPromotedExpanded(true)).not.toThrow();
      expect(get).toHaveBeenCalled();
      expect(set).toHaveBeenCalled();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});

// spec「面板内容卡收合」（design「收合触发沿用已转出收合列的模式」「收合中的卡只留标题一行、
// 不自动展开」）：四张内容卡的整条标题是收合触发区；收合后只剩标题一行，计数照常更新。
describe("面板内容卡收合", () => {
  const SECTIONS = ["proposed", "in-progress", "ready", "discussions"] as const;
  const toggle = (id: string) => sectionToggle(`panel-section-${id}`);
  const threeInProgress = [
    change({ name: "ip1", totalTasks: 4, completedTasks: 1 }),
    change({ name: "ip2", totalTasks: 4, completedTasks: 2 }),
    change({ name: "ip3", totalTasks: 4, completedTasks: 3 }),
  ];

  it("(a) 点「进行中」标题收合：列消失、aria-expanded 为 false、计数仍为 3、箭头朝右；再点恢复", () => {
    renderPanel({ snapshot: snapshot({ changes: threeInProgress }) });
    expect(toggle("in-progress").getAttribute("aria-expanded")).toBe("true");
    expect(chevronTokens(toggle("in-progress"))).toContain("rotate-90");
    fireEvent.click(toggle("in-progress"));
    expect(toggle("in-progress").getAttribute("aria-expanded")).toBe("false");
    expect(within(card("in-progress")).queryByTestId(/^panel-change-/)).toBeNull();
    expect(within(card("in-progress")).getByTestId("section-count").textContent).toBe("3");
    expect(within(card("in-progress")).getByText("进行中")).toBeTruthy();
    expect(chevronTokens(toggle("in-progress"))).not.toContain("rotate-90");
    // 其他卡不受影响。
    expect(toggle("proposed").getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle("in-progress"));
    expect(toggle("in-progress").getAttribute("aria-expanded")).toBe("true");
    expect(within(card("in-progress")).getAllByTestId(/^panel-change-/)).toHaveLength(3);
    expect(chevronTokens(toggle("in-progress"))).toContain("rotate-90");
  });

  it("(b) 收合「讨论」后重开面板、再切到另一个项目仍收合；记忆值为含 discussions 的 JSON 数组", () => {
    renderPanel({
      snapshot: snapshot({
        discussions: [
          { slug: "w1", topic: "一", promoted: false },
          { slug: "w2", topic: "二", promoted: false },
          { slug: "w3", topic: "三", promoted: false },
        ],
      }),
    });
    fireEvent.click(toggle("discussions"));
    expect(JSON.parse(localStorage.getItem(TRAY_COLLAPSED_SECTIONS_STORAGE_KEY)!)).toContain("discussions");
    // 重新挂载＝关闭再打开面板、重启 app。
    cleanup();
    const h = renderPanel({
      snapshot: snapshot({ discussions: [{ slug: "w1", topic: "一", promoted: false }] }),
    });
    expect(toggle("discussions").getAttribute("aria-expanded")).toBe("false");
    // 主窗口推送另一个作用中项目的快照（2 则讨论）：仍收合、计数换成新项目的。
    h.pushSnapshot(
      snapshot({
        activeKey: "local:/proj/two",
        discussions: [
          { slug: "s1", topic: "甲", promoted: false },
          { slug: "s2", topic: "乙", promoted: false },
        ],
      }),
    );
    expect(toggle("discussions").getAttribute("aria-expanded")).toBe("false");
    expect(within(card("discussions")).getByTestId("section-count").textContent).toBe("2");
    expect(within(card("discussions")).queryByTestId(/^panel-discussion-/)).toBeNull();
  });

  it("spec Example「收起讨论后切换项目」：wadpilot 8 则收起后点 specseal（2 则）→ 只剩一行「讨论」与计数 2，箭头朝右", () => {
    const wadpilot = { key: "local:/proj/wadpilot", name: "wadpilot", source: "local" as const, status: "ready" as const };
    const specseal = { key: "local:/proj/specseal", name: "specseal", source: "local" as const, status: "ready" as const };
    const topics = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ slug: `${prefix}-${i}`, topic: `${prefix} ${i}`, promoted: false }));
    const h = renderPanel({
      snapshot: snapshot({ tabs: [wadpilot, specseal], activeKey: wadpilot.key, discussions: topics("w", 8) }),
    });
    fireEvent.click(toggle("discussions"));
    // 点 specseal 的项目 tab：面板回调切换，主窗口推送 specseal 的快照。
    fireEvent.click(screen.getByTestId(`panel-project-${specseal.key}`));
    expect(h.onOpenProject).toHaveBeenCalledWith(specseal.key);
    h.pushSnapshot(snapshot({ tabs: [wadpilot, specseal], activeKey: specseal.key, discussions: topics("s", 2) }));
    expect(toggle("discussions").getAttribute("aria-expanded")).toBe("false");
    expect(card("discussions").children).toHaveLength(1);
    expect(within(card("discussions")).getByText("讨论")).toBeTruthy();
    expect(within(card("discussions")).getByTestId("section-count").textContent).toBe("2");
    expect(chevronTokens(toggle("discussions"))).not.toContain("rotate-90");
    expect(chevronTokens(toggle("discussions"))).not.toContain("-rotate-90");
  });

  it("(c) 记忆存坏值时四张卡全部展开、不显示错误", () => {
    for (const raw of ["not json", '{"proposed":true}']) {
      localStorage.setItem(TRAY_COLLAPSED_SECTIONS_STORAGE_KEY, raw);
      renderPanel();
      for (const id of SECTIONS) expect(toggle(id).getAttribute("aria-expanded")).toBe("true");
      expect(screen.queryByRole("alert")).toBeNull();
      cleanup();
    }
  });

  it("(d) 收合「已就绪」后送入多一笔已就绪变更的快照：卡仍收合、计数由 0 变 1", () => {
    const base = [change({ name: "prop", totalTasks: 5, completedTasks: 0 })];
    const h = renderPanel({ snapshot: snapshot({ changes: base }) });
    expect(within(card("ready")).getByTestId("section-count").textContent).toBe("0");
    fireEvent.click(toggle("ready"));
    h.pushSnapshot(snapshot({ changes: [...base, change({ name: "rdy", totalTasks: 4, completedTasks: 4 })] }));
    expect(toggle("ready").getAttribute("aria-expanded")).toBe("false");
    expect(within(card("ready")).getByTestId("section-count").textContent).toBe("1");
    expect(screen.queryByTestId("panel-change-rdy")).toBeNull();
  });

  it("(e) 收合的卡只剩标题一行：空状态卡不带最小高度、标题下没有细线", () => {
    renderPanel({ snapshot: snapshot({ changes: threeInProgress }) });
    fireEvent.click(toggle("ready")); // 计数 0 的空状态卡
    fireEvent.click(toggle("in-progress")); // 有 3 列的卡
    for (const id of ["ready", "in-progress"]) {
      expect(card(id).className.split(/\s+/)).not.toContain("min-h-12");
      expect(sectionHeader(`panel-section-${id}`).className.split(/\s+/)).not.toContain("border-b");
      // 卡内只剩收合触发区一个子节点。
      expect(card(id).children).toHaveLength(1);
    }
  });

  it("(e) 收合的卡在加载中与加载失败时也只剩标题（不渲染骨架、失败提示）", () => {
    renderPanel();
    fireEvent.click(toggle("in-progress"));
    fireEvent.click(toggle("discussions"));
    cleanup();
    renderPanel({ snapshot: snapshot({ workspaceLoading: true, changes: [], discussions: [] }) });
    for (const id of ["in-progress", "discussions"]) {
      expect(card(id).querySelector('[aria-busy="true"]')).toBeNull();
      expect(card(id).children).toHaveLength(1);
    }
    expect(card("proposed").querySelector('[aria-busy="true"]')).toBeTruthy();
    cleanup();
    renderPanel({ snapshot: snapshot({ workspaceLoadFailed: true, changes: [], discussions: [] }) });
    for (const id of ["in-progress", "discussions"]) {
      expect(within(card(id)).queryByTestId("panel-section-load-failed")).toBeNull();
    }
    expect(within(card("proposed")).getByTestId("panel-section-load-failed")).toBeTruthy();
  });

  it("(f) 讨论卡收起再展开：「还有 N 个…」溢出列回到未展开，「已转出」卡全程照常呈现且维持展开", () => {
    const openEight = Array.from({ length: 8 }, (_, i) => ({ slug: `open-${i}`, topic: `讨论 ${i}`, promoted: false }));
    const promotedThree = Array.from({ length: 3 }, (_, i) => ({ slug: `prom-${i}`, topic: `已转出 ${i}`, promoted: true }));
    renderPanel({ snapshot: snapshot({ discussions: [...openEight, ...promotedThree] }) });
    const promotedRows = () => within(card("promoted")).getAllByTestId(/^panel-discussion-/);
    fireEvent.click(screen.getByText("还有 3 个…"));
    fireEvent.click(toggle("promoted"));
    expect(screen.getByTestId("panel-discussion-open-7")).toBeTruthy();
    fireEvent.click(toggle("discussions"));
    expect(screen.queryByText("还有 3 个…")).toBeNull();
    expect(toggle("promoted").getAttribute("aria-expanded")).toBe("true");
    expect(promotedRows()).toHaveLength(3);
    fireEvent.click(toggle("discussions"));
    expect(screen.getByText("还有 3 个…")).toBeTruthy();
    expect(screen.queryByTestId("panel-discussion-open-5")).toBeNull();
    expect(toggle("promoted").getAttribute("aria-expanded")).toBe("true");
    expect(promotedRows()).toHaveLength(3);
  });

  it("收起讨论卡时已转出卡照常呈现：仍在其下、收合状态与计数不变", () => {
    const promotedThree = Array.from({ length: 3 }, (_, i) => ({ slug: `prom-${i}`, topic: `已转出 ${i}`, promoted: true }));
    renderPanel({ snapshot: snapshot({ discussions: [{ slug: "d1", topic: "讨论一", promoted: false }, ...promotedThree] }) });
    expect(toggle("promoted").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle("discussions"));
    expect(card("discussions").children).toHaveLength(1);
    expect(toggle("promoted").getAttribute("aria-expanded")).toBe("false");
    expect(within(card("promoted")).getByTestId("section-count").textContent).toBe("3");
    expect(follows(card("discussions"), card("promoted"))).toBe(true);
  });

  it("没有收合记忆时四张卡展开、已转出卡收合（收合集合坏值、已转出记忆缺席）", () => {
    localStorage.setItem(TRAY_COLLAPSED_SECTIONS_STORAGE_KEY, "not json");
    const promotedTwo = Array.from({ length: 2 }, (_, i) => ({ slug: `prom-${i}`, topic: `已转出 ${i}`, promoted: true }));
    renderPanel({ snapshot: snapshot({ discussions: promotedTwo }) });
    for (const id of SECTIONS) expect(toggle(id).getAttribute("aria-expanded")).toBe("true");
    expect(toggle("promoted").getAttribute("aria-expanded")).toBe("false");
    expect(within(card("promoted")).getByTestId("section-count").textContent).toBe("2");
    expect(chevronTokens(toggle("promoted"))).not.toContain("rotate-90");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("切换已转出卡不写入收合集合（展开状态只存已转出自己的记忆）", () => {
    const promotedTwo = Array.from({ length: 2 }, (_, i) => ({ slug: `prom-${i}`, topic: `已转出 ${i}`, promoted: true }));
    renderPanel({ snapshot: snapshot({ discussions: promotedTwo }) });
    // 写入端会滤掉未知 id，看集合内容验不出来；改验收合集合的记忆键根本没被写入。
    fireEvent.click(toggle("promoted"));
    fireEvent.click(toggle("promoted"));
    expect(localStorage.getItem(TRAY_PROMOTED_EXPANDED_STORAGE_KEY)).toBe("false");
    expect(localStorage.getItem(TRAY_COLLAPSED_SECTIONS_STORAGE_KEY)).toBeNull();
    // 收合集合已有内容时也一样：收起「提案中」后再切换已转出，不再写收合集合。
    fireEvent.click(toggle("proposed"));
    const set = vi.spyOn(Object.getPrototypeOf(localStorage) as Storage, "setItem");
    try {
      fireEvent.click(toggle("promoted"));
      expect(set).toHaveBeenCalledWith(TRAY_PROMOTED_EXPANDED_STORAGE_KEY, "true");
      expect(set.mock.calls.map(([key]) => key)).not.toContain(TRAY_COLLAPSED_SECTIONS_STORAGE_KEY);
    } finally {
      set.mockRestore();
    }
  });

  it("(g) 项目 tab 条卡、动作区块卡、复原卡、stale 状态栏没有收合触发；点其空白处不收起内容", () => {
    renderPanel();
    for (const id of ["panel-project-card", "panel-actions-card"]) {
      const el = screen.getByTestId(id);
      expect(within(el).queryByTestId("panel-section-toggle")).toBeNull();
      expect(el.querySelector("[aria-expanded]")).toBeNull();
      fireEvent.click(el);
    }
    for (const id of SECTIONS) expect(toggle(id).getAttribute("aria-expanded")).toBe("true");
    cleanup();

    const remote = (status: string) =>
      snapshot({
        tabs: [
          {
            key: "remote:c1/demo/backend",
            name: "Demo/backend",
            source: "remote",
            status,
            failureKind: "unreachable",
            connectionId: "c1",
            serverLabel: "Team Server",
          },
        ],
        activeKey: "remote:c1/demo/backend",
      } as unknown as Partial<TraySnapshot>);
    renderPanel({ snapshot: remote("error") });
    expect(screen.getByTestId("panel-recovery-card").querySelector("[aria-expanded]")).toBeNull();
    expect(screen.queryAllByTestId("panel-section-toggle")).toHaveLength(0);
    cleanup();
    renderPanel({ snapshot: remote("offline") });
    const stale = screen.getByTestId("panel-stale-status");
    expect(stale.querySelector("[aria-expanded]")).toBeNull();
    expect(stale.getAttribute("aria-expanded")).toBeNull();
  });

  it("(h) 收合触发为 role=button、tabIndex 为 -1，Enter／Space 可切换", () => {
    renderPanel();
    for (const id of SECTIONS) {
      expect(toggle(id).getAttribute("role")).toBe("button");
      expect(toggle(id).getAttribute("tabindex")).toBe("-1");
    }
    fireEvent.keyDown(toggle("proposed"), { key: "Enter" });
    expect(toggle("proposed").getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(toggle("proposed"), { key: " " });
    expect(toggle("proposed").getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(toggle("proposed"), { key: "a" });
    expect(toggle("proposed").getAttribute("aria-expanded")).toBe("true");
    // 按住不放的自动重复不再切换（原生 button 按住也只触发一次）。
    fireEvent.keyDown(toggle("proposed"), { key: "Enter" });
    for (const key of ["Enter", " "]) {
      fireEvent.keyDown(toggle("proposed"), { key, repeat: true });
      expect(toggle("proposed").getAttribute("aria-expanded")).toBe("false");
    }
    expect(JSON.parse(localStorage.getItem(TRAY_COLLAPSED_SECTIONS_STORAGE_KEY)!)).toEqual(["proposed"]);
  });
});

// spec「面板内容卡收合」的记忆（design「收合状态记在面板本机、所有项目共用一份」）：
// 单一键、值为收合中分区 id 的 JSON 数组；读不到或读到坏值一律全部展开，写入失败静默。
describe("面板内容卡的收合记忆", () => {
  it("键缺席 → 空集合（全部展开）", () => {
    expect(TRAY_COLLAPSED_SECTIONS_STORAGE_KEY).toBe("specseal.tray.collapsedSections");
    expect(readTrayCollapsedSections().size).toBe(0);
  });

  it.each([
    ["非 JSON", "not json"],
    ["非数组（对象）", '{"proposed":true}'],
    ["非数组（字符串）", '"proposed"'],
    ["null", "null"],
  ])("坏值（%s）→ 空集合", (_label, raw) => {
    localStorage.setItem(TRAY_COLLAPSED_SECTIONS_STORAGE_KEY, raw);
    expect(readTrayCollapsedSections().size).toBe(0);
  });

  it("数组中的未知 id 与非字符串元素被忽略", () => {
    localStorage.setItem(
      TRAY_COLLAPSED_SECTIONS_STORAGE_KEY,
      JSON.stringify(["ready", "bogus", 3, null, "discussions"]),
    );
    expect([...readTrayCollapsedSections()].sort()).toEqual(["discussions", "ready"]);
  });

  it("写入以 JSON 数组整份覆写，读回同一集合", () => {
    writeTrayCollapsedSections(new Set(["proposed", "in-progress"]));
    writeTrayCollapsedSections(new Set(["discussions"]));
    const raw = localStorage.getItem(TRAY_COLLAPSED_SECTIONS_STORAGE_KEY)!;
    expect(JSON.parse(raw)).toEqual(["discussions"]);
    expect([...readTrayCollapsedSections()]).toEqual(["discussions"]);
    writeTrayCollapsedSections(new Set());
    expect(JSON.parse(localStorage.getItem(TRAY_COLLAPSED_SECTIONS_STORAGE_KEY)!)).toEqual([]);
  });

  it("localStorage 不可用时读回空集合、写入不抛错", () => {
    // spy 落在 localStorage 实例的 prototype（同「已转出卡的展开记忆」的做法）。
    const proto = Object.getPrototypeOf(localStorage) as Storage;
    localStorage.setItem(TRAY_COLLAPSED_SECTIONS_STORAGE_KEY, JSON.stringify(["ready"]));
    const get = vi.spyOn(proto, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const set = vi.spyOn(proto, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    try {
      // 键里明明有 ready：读回空集合只可能来自 catch。
      expect(readTrayCollapsedSections().size).toBe(0);
      expect(() => writeTrayCollapsedSections(new Set(["ready"]))).not.toThrow();
      expect(get).toHaveBeenCalled();
      expect(set).toHaveBeenCalled();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});

// spec「讨论列表」面板的已转出卡：「讨论」卡正下方的独立卡，收合外观与交互同其他内容卡
// （同一个 SectionCard）；缺省收合、展开状态沿用既有本机记忆，有料才现。
describe("面板的已转出卡", () => {
  const promoted = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ slug: `prom-${i}`, topic: `已转出 ${i}`, promoted: true }));
  const openN = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ slug: `open-${i}`, topic: `讨论中 ${i}`, promoted: false }));
  const toggle = () => sectionToggle("panel-section-promoted");

  it("缺省收合：「讨论」卡只列讨论中，「已转出」卡只剩标头（「已转出」、计数 3、箭头朝右）", () => {
    renderPanel({ snapshot: snapshot({ discussions: [...openN(2), ...promoted(3)] }) });
    expect(within(card("discussions")).getByTestId("section-count").textContent).toBe("2");
    expect(toggle().getAttribute("role")).toBe("button");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().getAttribute("tabindex")).toBe("-1");
    expect(within(toggle()).getByText("已转出")).toBeTruthy();
    expect(within(card("promoted")).getByTestId("section-count").textContent).toBe("3");
    expect(chevronTokens(toggle())).not.toContain("rotate-90");
    expect(chevronTokens(toggle())).not.toContain("-rotate-90");
    // 卡内只剩标头一个子节点，已转出列不在 DOM。
    expect(card("promoted").children).toHaveLength(1);
    expect(screen.queryByTestId("panel-discussion-prom-0")).toBeNull();
  });

  it("点标头在标头下方展开（箭头朝下）并写入记忆，再点收合", () => {
    renderPanel({ snapshot: snapshot({ discussions: [...openN(2), ...promoted(3)] }) });
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    // 与其他内容卡同一规则：展开朝下（rotate-90），不再沿用旧收合列的朝上（-rotate-90）。
    expect(chevronTokens(toggle())).toContain("rotate-90");
    expect(chevronTokens(toggle())).not.toContain("-rotate-90");
    const rows = within(card("promoted")).getAllByTestId(/^panel-discussion-/);
    expect(rows).toHaveLength(3);
    expect(follows(toggle(), rows[0])).toBe(true);
    expect(localStorage.getItem(TRAY_PROMOTED_EXPANDED_STORAGE_KEY)).toBe("true");
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(within(card("promoted")).queryByTestId(/^panel-discussion-/)).toBeNull();
    expect(chevronTokens(toggle())).not.toContain("rotate-90");
    expect(localStorage.getItem(TRAY_PROMOTED_EXPANDED_STORAGE_KEY)).toBe("false");
  });

  it("标头可用 Enter／Space 开合（与 role=button 一致）", () => {
    renderPanel({ snapshot: snapshot({ discussions: promoted(2) }) });
    fireEvent.keyDown(toggle(), { key: "Enter" });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(toggle(), { key: " " });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(toggle(), { key: "a" });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    // 按住不放的自动重复不再切换。
    fireEvent.keyDown(toggle(), { key: " ", repeat: true });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("重新挂载（面板重开、app 重启）读回展开", () => {
    renderPanel({ snapshot: snapshot({ discussions: [...openN(2), ...promoted(3)] }) });
    fireEvent.click(toggle());
    cleanup();
    renderPanel({ snapshot: snapshot({ discussions: [...openN(2), ...promoted(3)] }) });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(within(card("promoted")).getAllByTestId(/^panel-discussion-/)).toHaveLength(3);
  });

  it("记忆坏值视为收合", () => {
    localStorage.setItem(TRAY_PROMOTED_EXPANDED_STORAGE_KEY, "yes");
    renderPanel({ snapshot: snapshot({ discussions: promoted(2) }) });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("讨论中 0、已转出 2：「讨论」卡为计数 0 的空状态卡，其下为计数 2 的「已转出」卡", () => {
    renderPanel({ snapshot: snapshot({ discussions: promoted(2) }) });
    expect(within(card("discussions")).getByTestId("section-count").textContent).toBe("0");
    expect(card("discussions").className.split(/\s+/)).toContain("min-h-12");
    expect(sectionHeader("panel-section-discussions").className.split(/\s+/)).not.toContain("border-b");
    expect(within(card("promoted")).getByTestId("section-count").textContent).toBe("2");
    expect(follows(card("discussions"), card("promoted"))).toBe(true);
  });

  it("已转出 7 则展开：卡内直列前 5、尾端「还有 2 个…」", () => {
    renderPanel({ snapshot: snapshot({ discussions: promoted(7) }) });
    fireEvent.click(toggle());
    expect(within(card("promoted")).getAllByTestId(/^panel-discussion-/)).toHaveLength(5);
    fireEvent.click(within(card("promoted")).getByText("还有 2 个…"));
    expect(within(card("promoted")).getAllByTestId(/^panel-discussion-/)).toHaveLength(7);
  });

  it("spec「已转出卡与讨论卡以间距分开」：讨论中 11、已转出 3 → 讨论卡最后一列为「还有 6 个…」、卡内无已转出列", () => {
    renderPanel({ snapshot: snapshot({ discussions: [...openN(11), ...promoted(3)] }) });
    const discussions = card("discussions");
    expect(within(discussions).getAllByTestId(/^panel-discussion-open-/)).toHaveLength(5);
    expect(discussions.lastElementChild?.textContent).toBe("还有 6 个…");
    expect(within(discussions).queryByTestId(/^panel-discussion-prom-/)).toBeNull();
    fireEvent.click(toggle());
    expect(within(discussions).queryByTestId(/^panel-discussion-prom-/)).toBeNull();
    expect(within(card("promoted")).getAllByTestId(/^panel-discussion-prom-/)).toHaveLength(3);
  });

  it("零已转出、加载中、加载失败都不渲染已转出卡；后两者由「讨论」卡呈现占位列或失败提示", () => {
    renderPanel({ snapshot: snapshot({ discussions: openN(2) }) });
    expect(screen.queryByTestId("panel-section-promoted")).toBeNull();
    cleanup();
    renderPanel({ snapshot: snapshot({ workspaceLoading: true, discussions: promoted(2) }) });
    expect(screen.queryByTestId("panel-section-promoted")).toBeNull();
    expect(card("discussions").querySelector('[aria-busy="true"]')).toBeTruthy();
    cleanup();
    renderPanel({ snapshot: snapshot({ workspaceLoadFailed: true, discussions: promoted(2) }) });
    expect(screen.queryByTestId("panel-section-promoted")).toBeNull();
    expect(screen.queryByTestId("panel-promoted-toggle")).toBeNull();
    expect(within(card("discussions")).getByTestId("panel-section-load-failed")).toBeTruthy();
  });

  it("同一面板内已转出卡消失再出现（加载中、零笔）时保留展开状态", () => {
    const h = renderPanel({ snapshot: snapshot({ discussions: [...openN(2), ...promoted(3)] }) });
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    h.pushSnapshot(snapshot({ workspaceLoading: true, discussions: [] }));
    expect(screen.queryByTestId("panel-section-promoted")).toBeNull();
    h.pushSnapshot(snapshot({ discussions: openN(2) }));
    expect(screen.queryByTestId("panel-section-promoted")).toBeNull();
    h.pushSnapshot(snapshot({ discussions: [...openN(2), ...promoted(3)] }));
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(within(card("promoted")).getAllByTestId(/^panel-discussion-prom-/)).toHaveLength(3);
  });
});

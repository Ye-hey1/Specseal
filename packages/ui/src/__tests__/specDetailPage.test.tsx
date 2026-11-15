// 规格详情页（spec「桌面 app 呈现 change 与 spec 的清单与内容」；desktop-spec-manual-pages
// design D1–D5）：三栏骨架——左栏身分区、「文档」节点规格／溯源、「状态」三列；阅读卡标题区
// （需求数签、搜索需求、「打开 ▾」、出处行）、数字砖、提示框、Purpose 引言段、需求段（第一条
// 展开、其余收合）；右栏本页目录；溯源文档的出处行、数字砖与列。缺件空态、世代重载不清空、
// latest-wins、换目标清空重载与 skeleton 三态沿用既有行为。
import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, waitFor, fireEvent, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";
import { SpecDetailPage } from "../components/SpecDetailPage";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

const SPEC_MD = `# desktop-app Specification

## Purpose

桌面 app 的行为。

## Requirements

### Requirement: 显示清单

清单内文。

<!-- @trace
source: change-one
updated: 2026-07-01
code:
  - a.rs
-->

### Requirement: 其他

其他内文。

<!-- @trace
source: change-two
updated: 2026-07-02
code:
  - b.rs
-->

<!-- @trace
source: change-one
updated: 2026-07-03
code:
  - c.rs
-->
`;

/** 三段需求，各带两个 Scenario 与 @trace（spec Scenario「选定 spec 以详情页显示需求分段」）。 */
const THREE_MD = `# demo Specification

## Purpose

示范规格。

## Requirements

### Requirement: 登录
用户 SHALL 能登录。

#### Scenario: 正确密码
- **WHEN** 输入正确密码
- **THEN** 进入首页

#### Scenario: 错误密码
- **WHEN** 输入错误密码
- **THEN** 显示错误

<!-- @trace
source: add-login
updated: 2026-07-05
-->

---
### Requirement: 注销
用户 MUST 能注销。

#### Scenario: 点注销
- **WHEN** 点注销
- **THEN** 回登录页

#### Scenario: 逾时注销
- **WHEN** 闲置逾时
- **THEN** 回登录页

<!-- @trace
source: add-logout
updated: 2026-08-01T10:00:00+08:00
-->

---
### Requirement: 记住帐号
系统 SHALL NOT 在未勾选时记住帐号。

#### Scenario: 未勾选
- **WHEN** 未勾选记住我
- **THEN** 下次需重新输入

#### Scenario: 已勾选
- **WHEN** 勾选记住我
- **THEN** 下次带入帐号

<!-- @trace
source: add-login
updated: 2026-07-20
-->
`;

const NO_TRACE_MD = `# plain Specification

## Purpose

无溯源内文。

## Requirements

### Requirement: 唯一

唯一内文。
`;

/** 封存清单 fixture：change-two 较晚封存、change-one 较早——与文档出现序相反，验证排序取日期。 */
const ARCHIVED = [
  { datedName: "2026-07-02-change-two", date: "2026-07-02", name: "change-two" },
  { datedName: "2026-07-01-change-one", date: "2026-07-01", name: "change-one" },
];

function makeProps(over: Record<string, unknown> = {}) {
  return {
    capability: "desktop-app",
    loadDocument: vi.fn(async () => SPEC_MD),
    archivedChanges: ARCHIVED,
    onOpenArchivedChange: vi.fn(),
    // 缺省 spec 目录：core 解析出的相对路径与契约缺省版面同字。
    locateDocument: vi.fn(async (doc: { spec?: string }) => ({ relative: `openspec/specs/${doc.spec}/spec.md` })),
    ...over,
  };
}

/** Scenario「规格文档的出处行、数字砖与状态栏」：15 条需求、74 个 scenario、9 个 `@trace` 来源变更、
 * 最近更新 2026-10-12 来自 tray-panel-restyle。`untraced` 给的标题取代最后几条需求、且不带 @trace。 */
const TRAY_SOURCES = [
  "tray-status-menu-init",
  "tray-quick-actions",
  "tray-project-switch",
  "tray-discussion-rows",
  "tray-remote-panel",
  "tray-quality-stamps",
  "tray-load-states",
  "tray-overflow-fold",
  "tray-panel-restyle",
];
const TRAY_UPDATED = [
  "2026-09-10",
  "2026-09-11",
  "2026-09-12",
  "2026-09-13",
  "2026-09-14",
  "2026-09-15",
  "2026-09-16",
  "2026-09-17",
  "2026-10-12T16:18:33+08:00",
];
function trayMd({ untraced = [] as string[], purpose = "系统匣菜单的行为。" } = {}): string {
  const reqs = Array.from({ length: 15 }, (_, i) => {
    const bare = i >= 15 - untraced.length;
    const title = bare ? untraced[i - (15 - untraced.length)] : `需求 ${i + 1}`;
    // 14 条各 5 个、最后一条 4 个：加总 74。
    const scenarios = Array.from(
      { length: i === 14 ? 4 : 5 },
      (_, j) => `#### Scenario: 情境 ${i + 1}-${j + 1}\n- **WHEN** 甲\n- **THEN** 乙\n`,
    ).join("\n");
    const k = i % 9;
    const trace = bare ? "" : `<!-- @trace\nsource: ${TRAY_SOURCES[k]}\nupdated: ${TRAY_UPDATED[k]}\n-->\n`;
    return `### Requirement: ${title}\n\n系统 SHALL 做事 ${i + 1}。\n\n${scenarios}\n${trace}`;
  });
  return `# tray-status-menu Specification\n\n## Purpose\n\n${purpose}\n\n## Requirements\n\n${reqs.join("\n---\n")}`;
}

const identityRow = () => document.querySelector("[data-identity-provenance]") as HTMLElement | null;
const docProvenance = () => document.querySelector("[data-doc-provenance]") as HTMLElement | null;
const tiles = () => Array.from(document.querySelectorAll<HTMLElement>("[data-doc-tile]")).map((el) => el.textContent);
const callout = (kind: string) => document.querySelector(`[data-callout="${kind}"]`) as HTMLElement | null;
const tab = (name: RegExp) => screen.getByRole("tab", { name });
const sections = () => Array.from(document.querySelectorAll<HTMLElement>("section[data-requirement]"));
const toc = () => document.querySelector("[data-detail-toc] [data-manual-toc]") as HTMLElement | null;
const tocAnchors = () => Array.from(toc()?.querySelectorAll("[data-manual-anchor]") ?? []).map((a) => a.textContent);
/** 需求段标题列的收合钮（有 collapse 时）。 */
const toggleOf = (s: HTMLElement) => s.querySelector("button[aria-expanded]") as HTMLElement;
const traceRows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-trace-row]"));
const openTraceTab = async () => {
  await waitFor(() => screen.getByRole("tab", { name: /溯源/ }));
  fireEvent.mouseDown(screen.getByRole("tab", { name: /溯源/ }));
};
const clipboard = () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
};

describe("SpecDetailPage（左栏与阅读卡标题）", () => {
  it("打开加载正典全文：三栏骨架、身分区标题与「正式规格」签、文档节点「规格 2」「溯源 2」、阅读卡标题「规格」", async () => {
    const props = makeProps();
    render(<SpecDetailPage {...(props as never)} />);
    await waitFor(() => expect(screen.getByText("清单内文。")).toBeTruthy());
    expect(props.loadDocument).toHaveBeenCalledWith("desktop-app");
    expect(document.querySelector("[data-spec-detail][data-detail-shell]")).toBeTruthy();
    const identity = document.querySelector("[data-detail-identity]") as HTMLElement;
    expect(within(identity).getByRole("heading", { level: 1, name: "desktop-app" })).toBeTruthy();
    expect(within(identity).getByText("正式规格")).toBeTruthy();
    // 第二条需求缺省收合：标题在、内文不出。
    expect(screen.getByRole("heading", { level: 2, name: "其他" })).toBeTruthy();
    expect(screen.queryByText("其他内文。")).toBeNull();
    expect(tab(/规格/).textContent).toContain("2");
    expect(tab(/溯源/).textContent).toContain("2");
    expect(tab(/规格/).getAttribute("aria-selected")).toBe("true");
    const header = document.querySelector("[data-doc-header]") as HTMLElement;
    expect(within(header).getByRole("heading", { level: 2 }).textContent).toBe("规格");
    expect(within(header).getByText("2")).toBeTruthy();
    expect(within(header).getByPlaceholderText("搜索需求…")).toBeTruthy();
  });

  it("身分区出身行、溯源关联列与状态三列：N 条需求 · M 个 scenario · 最近更新 日期", async () => {
    render(<SpecDetailPage {...(makeProps({ loadDocument: vi.fn(async () => THREE_MD) }) as never)} />);
    await waitFor(() => expect(sections()).toHaveLength(3));
    expect(identityRow()!.textContent).toBe("3 条需求·6 个 scenario·最近更新 2026-08-01");
    const relation = document.querySelector("[data-relation-trace]") as HTMLElement;
    expect(relation.textContent).toBe("溯源add-login+1");
    expect(document.querySelector("[data-status-requirements]")!.textContent).toBe("需求3");
    expect(document.querySelector("[data-status-sources]")!.textContent).toBe("溯源2");
    const updated = document.querySelector("[data-status-updated]") as HTMLElement;
    expect(updated.textContent).toContain("2026-08-01");
    expect(updated.textContent).toContain("add-logout");
    expect(docProvenance()!.textContent).toBe(
      "openspec/specs/desktop-app/spec.md·正式规格·最近更新 2026-08-01（add-logout）",
    );
  });

  it("无 @trace 时身分区无最近更新段与溯源关联列、状态栏无最近更新、需求段无锚点、溯源徽章 0 并显示空态", async () => {
    render(<SpecDetailPage {...(makeProps({ loadDocument: vi.fn(async () => NO_TRACE_MD) }) as never)} />);
    await waitFor(() => expect(screen.getByText("唯一内文。")).toBeTruthy());
    expect(identityRow()!.textContent).toBe("1 条需求·0 个 scenario");
    expect(document.querySelector("[data-relation-trace]")).toBeNull();
    expect(document.querySelector("[data-status-updated]")).toBeNull();
    expect(document.querySelector("[data-trace-anchor]")).toBeNull();
    expect(tab(/溯源/).textContent).toContain("0");
    await openTraceTab();
    await waitFor(() => expect(screen.getByText("此规格没有来源变更")).toBeTruthy());
    expect(traceRows()).toHaveLength(0);
  });

  it("拷贝名称钮写入 capability 名并显示已拷贝回馈", async () => {
    const writeText = clipboard();
    render(<SpecDetailPage {...(makeProps() as never)} />);
    await waitFor(() => expect(screen.getByText("清单内文。")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("拷贝名称"));
    expect(writeText).toHaveBeenCalledWith("desktop-app");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("已拷贝"));
  });

  it("「打开 ▾」收到正式规格的文档参照与已加载原文，渲染在阅读卡标题列", async () => {
    const renderDocumentActions = vi.fn(() => <button type="button">打开 ▾</button>);
    render(<SpecDetailPage {...(makeProps({ renderDocumentActions }) as never)} />);
    await waitFor(() => expect(screen.getByText("清单内文。")).toBeTruthy());
    expect(renderDocumentActions).toHaveBeenLastCalledWith({ doc: { spec: "desktop-app" }, content: SPEC_MD });
    const header = document.querySelector("[data-doc-header]") as HTMLElement;
    expect(within(header).getByRole("button", { name: "打开 ▾" })).toBeTruthy();
  });

  it("文档缺席显示空状态而非错误，身分区出身行缺席", async () => {
    render(<SpecDetailPage {...(makeProps({ loadDocument: vi.fn(async () => null) }) as never)} />);
    await waitFor(() => expect(screen.getByText("（无内容）")).toBeTruthy());
    expect(identityRow()).toBeNull();
  });

  it("出处行、四格砖与状态栏三列（Scenario「规格文档的出处行、数字砖与状态栏」数据）", async () => {
    render(
      <SpecDetailPage
        {...(makeProps({ capability: "tray-status-menu", loadDocument: vi.fn(async () => trayMd()) }) as never)}
      />,
    );
    await waitFor(() => expect(sections()).toHaveLength(15));
    expect(docProvenance()!.textContent).toBe(
      "openspec/specs/tray-status-menu/spec.md·正式规格·最近更新 2026-10-12（tray-panel-restyle）",
    );
    expect(tiles()).toEqual(["15需求", "74Scenario", "9溯源变更", "2026-10-12最近更新 · tray-panel-restyle"]);
    expect(document.querySelector("[data-status-requirements]")!.textContent).toBe("需求15");
    expect(document.querySelector("[data-status-sources]")!.textContent).toBe("溯源9");
    expect(document.querySelector("[data-status-updated]")!.textContent).toContain("2026-10-12");
    expect(document.querySelector("[data-doc-callout]")).toBeNull();
  });

  it("点溯源关联列后溯源节点作用中、溯源文档的出处行与四格砖", async () => {
    render(
      <SpecDetailPage
        {...(makeProps({ capability: "tray-status-menu", loadDocument: vi.fn(async () => trayMd()) }) as never)}
      />,
    );
    await waitFor(() => expect(sections()).toHaveLength(15));
    const relation = document.querySelector("[data-relation-trace]") as HTMLElement;
    // 「+N」签本身是灰底：滑过换主色淡底，不是更淡的灰。
    expect(within(relation).getByRole("button", { name: "+8" }).className).toContain("hover:bg-accent");
    fireEvent.click(within(relation).getByRole("button", { name: "+8" }));
    await waitFor(() => expect(tab(/溯源/).getAttribute("aria-selected")).toBe("true"));
    const header = document.querySelector("[data-doc-header]") as HTMLElement;
    expect(within(header).getByRole("heading", { level: 2 }).textContent).toBe("溯源");
    expect(docProvenance()!.textContent).toBe(
      "自全文的 @trace 注解推导，不是文档·封存清单命中者在前、依封存日期升幂",
    );
    expect(tiles()).toEqual([
      "9来源变更",
      "2026-09-10最早 · tray-status-menu-init",
      "2026-10-12最近 · tray-panel-restyle",
      "15 ／ 15有来源的需求",
    ]);
    expect(traceRows()).toHaveLength(9);
    // 首颗变更签同样切到溯源文档。
    fireEvent.mouseDown(tab(/规格/));
    await waitFor(() => expect(tab(/规格/).getAttribute("aria-selected")).toBe("true"));
    fireEvent.click(within(document.querySelector("[data-relation-trace]") as HTMLElement).getByRole("button", { name: "tray-status-menu-init" }));
    await waitFor(() => expect(tab(/溯源/).getAttribute("aria-selected")).toBe("true"));
  });

  it("Purpose 以 TBD 前缀起头时 warning 提示框含路径；两条需求无 @trace 时 note 提示框列出标题且溯源砖为 13 ／ 15", async () => {
    const md = trayMd({
      untraced: ["菜单内容与看板同源", "分区溢出折叠"],
      purpose: "TBD - created by archiving change tray-status-menu. Update Purpose after archive.",
    });
    render(
      <SpecDetailPage {...(makeProps({ capability: "tray-status-menu", loadDocument: vi.fn(async () => md) }) as never)} />,
    );
    await waitFor(() => expect(sections()).toHaveLength(15));
    const tbd = callout("purpose-tbd")!;
    const untraced = callout("untraced")!;
    expect(tbd.textContent).toContain("Purpose 待补");
    expect(tbd.textContent).toContain("openspec/specs/tray-status-menu/spec.md");
    expect(untraced.textContent).toContain("2 条需求没有来源变更");
    expect(untraced.textContent).toContain("菜单内容与看板同源、分区溢出折叠");
    // 两者都在提示框槽内、Purpose 待补在前；Purpose 引言段仍呈现占位原文。
    const slot = document.querySelector("[data-doc-callout]") as HTMLElement;
    expect(slot.contains(tbd) && slot.contains(untraced)).toBe(true);
    expect(tbd.compareDocumentPosition(untraced) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector("[data-purpose]")!.textContent).toContain("TBD - created by archiving");
    const [, , , , , , , , , , , , , bare1, bare2] = sections();
    expect(bare1.querySelector("[data-trace-anchor]")).toBeNull();
    expect(bare2.querySelector("[data-trace-anchor]")).toBeNull();
    await openTraceTab();
    await waitFor(() => expect(tiles()[3]).toBe("13 ／ 15有来源的需求"));
  });

  it("项目改过 spec 目录名：出处行与 Purpose 待补提示框都用 core 解析出的实际相对路径", async () => {
    const locateDocument = vi.fn(async () => ({ relative: "docs/specs/specs/tray-status-menu/spec.md" }));
    const md = trayMd({ purpose: "TBD - created by archiving change tray-status-menu. Update Purpose after archive." });
    render(
      <SpecDetailPage
        {...(makeProps({ capability: "tray-status-menu", loadDocument: vi.fn(async () => md), locateDocument }) as never)}
      />,
    );
    await waitFor(() => expect(sections()).toHaveLength(15));
    await waitFor(() =>
      expect(docProvenance()!.textContent).toBe(
        "docs/specs/specs/tray-status-menu/spec.md·正式规格·最近更新 2026-10-12（tray-panel-restyle）",
      ),
    );
    expect(locateDocument).toHaveBeenCalledWith({ spec: "tray-status-menu" });
    expect(callout("purpose-tbd")!.textContent).toContain("docs/specs/specs/tray-status-menu/spec.md");
    expect(callout("purpose-tbd")!.textContent).not.toContain("openspec/specs");
  });

  it("没有可定位的文档（remote 无 checkout）：出处行不列路径、Purpose 待补提示框改用不带路径的说法", async () => {
    const md = trayMd({ purpose: "TBD - created by archiving change tray-status-menu. Update Purpose after archive." });
    render(
      <SpecDetailPage
        {...(makeProps({
          capability: "tray-status-menu",
          loadDocument: vi.fn(async () => md),
          locateDocument: undefined,
        }) as never)}
      />,
    );
    await waitFor(() => expect(sections()).toHaveLength(15));
    expect(docProvenance()!.textContent).toBe("正式规格·最近更新 2026-10-12（tray-panel-restyle）");
    const tbd = callout("purpose-tbd")!;
    expect(tbd.textContent).toContain("直接编辑这份规格档的 Purpose 段即可");
    expect(tbd.textContent).not.toContain("spec.md");
  });

  it("无 @trace 时无最近更新段、无溯源关联列、note 提示框列出全部需求、溯源文档无砖", async () => {
    render(<SpecDetailPage {...(makeProps({ loadDocument: vi.fn(async () => NO_TRACE_MD) }) as never)} />);
    await waitFor(() => expect(sections()).toHaveLength(1));
    expect(docProvenance()!.textContent).toBe("openspec/specs/desktop-app/spec.md·正式规格");
    expect(tiles()).toEqual(["1需求", "0Scenario", "0溯源变更"]);
    expect(callout("untraced")!.textContent).toContain("1 条需求没有来源变更");
    expect(callout("untraced")!.textContent).toContain("唯一");
    expect(callout("purpose-tbd")).toBeNull();
    await openTraceTab();
    await waitFor(() => expect(screen.getByText("此规格没有来源变更")).toBeTruthy());
    expect(document.querySelector("[data-doc-tiles]")).toBeNull();
  });
});

describe("SpecDetailPage（需求分段）", () => {
  it("三段需求各有 Requirement 小标、[data-doc-heading] 标题、来源锚点、SHALL 灰底与 Scenario 缩进区块", async () => {
    render(<SpecDetailPage {...(makeProps({ loadDocument: vi.fn(async () => THREE_MD) }) as never)} />);
    await waitFor(() => expect(sections()).toHaveLength(3));
    const [login, logout, remember] = sections();
    // 第二、三段缺省收合：展开后再看内文。
    fireEvent.click(toggleOf(logout));
    fireEvent.click(toggleOf(remember));
    for (const s of sections()) {
      expect(s.querySelector("[data-requirement-label]")!.textContent).toBe("Requirement");
      expect(s.querySelector("[data-scenario]")!.className).toContain("border-l-2");
      expect(s.querySelector("[data-doc-heading]")!.tagName).toBe("H2");
      expect(s.querySelector("[data-doc-heading]")!.className).toContain("text-base font-semibold");
    }
    expect(login.querySelector("[data-doc-heading]")!.textContent).toBe("登录");
    expect(login.querySelector("[data-trace-anchor]")!.textContent).toBe("来自 add-login · 2026-07-05");
    expect(logout.querySelector("[data-trace-anchor]")!.textContent).toBe("来自 add-logout · 2026-08-01");
    expect(login.querySelector("code.spec-kw")!.textContent).toBe("SHALL");
    expect(logout.querySelector("code.spec-kw")!.textContent).toBe("MUST");
    expect(remember.querySelector("code.spec-kw")!.textContent).toBe("SHALL NOT");
    expect(login.querySelector("[data-scenario]")!.textContent).toContain("Scenario：正确密码");
    // Purpose 段在需求段之前、为 h2。
    expect(screen.getByRole("heading", { level: 2, name: "Purpose" })).toBeTruthy();
    expect(screen.getByText("示范规格。")).toBeTruthy();
    // 分隔线与 @trace 注解不入内文。
    expect(document.querySelector("[data-doc-body] hr")).toBeNull();
  });

  it("第一段展开、第二第三段收合为一列带「2 个 scenario」签；点列切换；点收合列上的锚点只开封存变更", async () => {
    const props = makeProps({
      loadDocument: vi.fn(async () => THREE_MD),
      archivedChanges: [{ datedName: "2026-08-01-add-logout", date: "2026-08-01", name: "add-logout" }],
    });
    render(<SpecDetailPage {...(props as never)} />);
    await waitFor(() => expect(sections()).toHaveLength(3));
    const [login, logout, remember] = sections();
    expect(toggleOf(login).getAttribute("aria-expanded")).toBe("true");
    expect(login.querySelectorAll("[data-scenario]")).toHaveLength(2);
    expect(login.textContent).not.toContain("2 个 scenario");
    for (const s of [logout, remember]) {
      expect(toggleOf(s).getAttribute("aria-expanded")).toBe("false");
      expect(s.querySelector("[data-scenario]")).toBeNull();
      expect(s.textContent).toContain("2 个 scenario");
      expect(s.querySelector("[data-doc-heading]")).toBeTruthy();
    }
    // 收合列看得出可点：共用光标变量（网页手指、桌面箭头），滑过整列（含锚点）有淡底。
    expect(toggleOf(logout).className).toContain("cursor-(--cursor-interaction)");
    expect(toggleOf(logout).parentElement!.className).toContain("hover:bg-foreground/5");
    // 收合列上的可点锚点：开该封存变更，不切换收合。
    fireEvent.click(within(logout).getByRole("button", { name: /add-logout/ }));
    expect(props.onOpenArchivedChange).toHaveBeenCalledWith("2026-08-01-add-logout");
    expect(toggleOf(logout).getAttribute("aria-expanded")).toBe("false");
    // 点列展开、第一段维持展开；再点收合。
    fireEvent.click(toggleOf(logout));
    expect(toggleOf(logout).getAttribute("aria-expanded")).toBe("true");
    expect(logout.querySelectorAll("[data-scenario]")).toHaveLength(2);
    expect(toggleOf(login).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggleOf(logout));
    expect(toggleOf(logout).getAttribute("aria-expanded")).toBe("false");
  });

  it("锚点在封存清单命中时可点，点击以 datedName 打开；未命中时为纯文本", async () => {
    const props = makeProps({
      loadDocument: vi.fn(async () => THREE_MD),
      archivedChanges: [{ datedName: "2026-07-05-add-login", date: "2026-07-05", name: "add-login" }],
    });
    render(<SpecDetailPage {...(props as never)} />);
    await waitFor(() => expect(sections()).toHaveLength(3));
    const [login, logout] = sections();
    fireEvent.click(within(login).getByRole("button", { name: /add-login/ }));
    expect(props.onOpenArchivedChange).toHaveBeenCalledWith("2026-07-05-add-login");
    expect(within(logout).queryByRole("button", { name: /add-logout/ })).toBeNull();
  });

  it("右栏本页目录列出 Purpose 与全部需求，且只在主区宽 ≥1200px 的容器下显示", async () => {
    render(<SpecDetailPage {...(makeProps({ loadDocument: vi.fn(async () => THREE_MD) }) as never)} />);
    await waitFor(() => expect(sections()).toHaveLength(3));
    await waitFor(() => expect(toc()).toBeTruthy());
    expect(tocAnchors()).toEqual(["Purpose", "登录", "注销", "记住帐号"]);
    // jsdom 不跑容器查找：只能断言显示条件的 class，版面在真机验收。
    const aside = document.querySelector("[data-detail-toc]") as HTMLElement;
    expect(aside.className).toContain("hidden");
    expect(aside.className).toContain("@min-[1200px]:flex");
    expect(document.querySelector("[data-spec-detail]")!.className).toContain("@container");
  });

  it("目录高亮跟着包住内文的祖先卷动容器移动，其他元素的卷动不理会", async () => {
    render(
      <div>
        <div data-testid="scroller">
          <SpecDetailPage {...(makeProps({ loadDocument: vi.fn(async () => THREE_MD) }) as never)} />
        </div>
        <div data-testid="elsewhere" />
      </div>,
    );
    await waitFor(() => expect(toc()).toBeTruthy());
    const anchor = (text: string) =>
      Array.from(toc()!.querySelectorAll("[data-manual-anchor]")).find((a) => a.textContent === text)!;
    expect(anchor("Purpose").getAttribute("aria-current")).toBe("location");
    // 页层顶缘 100px：Purpose、登录、注销已卷过顶缘下 12px 线，记住帐号还在下方。
    const scroller = screen.getByTestId("scroller");
    const rect = (top: number) => () => ({ top }) as DOMRect;
    scroller.getBoundingClientRect = rect(100);
    const heads = Array.from(document.querySelectorAll<HTMLElement>("[data-doc-heading]"));
    heads.forEach((h, i) => (h.getBoundingClientRect = rect(i < 3 ? 50 : 400)));
    fireEvent.scroll(screen.getByTestId("elsewhere"));
    expect(anchor("Purpose").getAttribute("aria-current")).toBe("location");
    fireEvent.scroll(scroller);
    expect(anchor("注销").getAttribute("aria-current")).toBe("location");
    expect(anchor("Purpose").getAttribute("aria-current")).toBeNull();
  });

  it("展开或收合需求段触发目录重扫时，高亮留在原本的目前段；搜索换掉标题时才回到第一项", async () => {
    render(
      <div data-testid="scroller">
        <SpecDetailPage {...(makeProps({ loadDocument: vi.fn(async () => THREE_MD) }) as never)} />
      </div>,
    );
    await waitFor(() => expect(sections()).toHaveLength(3));
    await waitFor(() => expect(toc()).toBeTruthy());
    const anchor = (text: string) =>
      Array.from(toc()!.querySelectorAll("[data-manual-anchor]")).find((a) => a.textContent === text)!;
    // 卷到「注销」为目前段（同上一题的量测替身）。
    const scroller = screen.getByTestId("scroller");
    const rect = (top: number) => () => ({ top }) as DOMRect;
    scroller.getBoundingClientRect = rect(100);
    const heads = Array.from(document.querySelectorAll<HTMLElement>("[data-doc-heading]"));
    heads.forEach((h, i) => (h.getBoundingClientRect = rect(i < 3 ? 50 : 400)));
    fireEvent.scroll(scroller);
    expect(anchor("注销").getAttribute("aria-current")).toBe("location");
    // 点开「注销」：展开不卷动，高亮不得跳回 Purpose。
    fireEvent.click(toggleOf(sections()[1]));
    await waitFor(() => expect(toggleOf(sections()[1]).getAttribute("aria-expanded")).toBe("true"));
    expect(anchor("注销").getAttribute("aria-current")).toBe("location");
    expect(anchor("Purpose").getAttribute("aria-current")).toBeNull();
    fireEvent.click(toggleOf(sections()[1]));
    await waitFor(() => expect(toggleOf(sections()[1]).getAttribute("aria-expanded")).toBe("false"));
    expect(anchor("注销").getAttribute("aria-current")).toBe("location");
    // 搜索只留「记住帐号」：原本的目前段不在了，回到第一项。
    fireEvent.change(screen.getByPlaceholderText("搜索需求…"), { target: { value: "记住" } });
    await waitFor(() => expect(tocAnchors()).toEqual(["Purpose", "记住帐号"]));
    expect(anchor("Purpose").getAttribute("aria-current")).toBe("location");
  });

  it("搜索需求只留标题命中的段，目录随之缩减；无命中显示空态；清空还原", async () => {
    render(<SpecDetailPage {...(makeProps({ loadDocument: vi.fn(async () => THREE_MD) }) as never)} />);
    await waitFor(() => expect(sections()).toHaveLength(3));
    const search = screen.getByPlaceholderText("搜索需求…");
    fireEvent.change(search, { target: { value: "注销" } });
    expect(sections().map((s) => s.querySelector("h2")!.textContent)).toEqual(["注销"]);
    expect(screen.getByRole("heading", { level: 2, name: "Purpose" })).toBeTruthy();
    await waitFor(() => expect(tocAnchors()).toEqual(["Purpose", "注销"]));
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(sections()).toHaveLength(0);
    expect(screen.getByText("没有符合的需求")).toBeTruthy();
    fireEvent.change(search, { target: { value: "" } });
    expect(sections()).toHaveLength(3);
  });

  it("搜索大小写不敏感", async () => {
    const md = "## Purpose\n\np\n\n### Requirement: Login Flow\nA.\n\n### Requirement: Other\nB.\n";
    render(<SpecDetailPage {...(makeProps({ loadDocument: vi.fn(async () => md) }) as never)} />);
    await waitFor(() => expect(sections()).toHaveLength(2));
    fireEvent.change(screen.getByPlaceholderText("搜索需求…"), { target: { value: "login" } });
    expect(sections().map((s) => s.querySelector("h2")!.textContent)).toEqual(["Login Flow"]);
  });

  it("无需求标题时整篇 Markdown、无砖、无提示框、无锚点", async () => {
    const md = "# x\n\n## Purpose\n\n只有目的。\n\n## 其他\n\n杂项。\n";
    render(<SpecDetailPage {...(makeProps({ loadDocument: vi.fn(async () => md) }) as never)} />);
    await waitFor(() => expect(screen.getByText("杂项。")).toBeTruthy());
    expect(sections()).toHaveLength(0);
    expect(document.querySelector("[data-doc-tiles]")).toBeNull();
    expect(document.querySelector("[data-doc-callout]")).toBeNull();
    // 整篇的 `## ` 标题也不成锚点。
    await new Promise((r) => setTimeout(r, 0));
    expect(toc()).toBeNull();
  });

  it("搜索后只剩命中段且该段展开、右栏锚点只剩 Purpose 与命中标题", async () => {
    render(<SpecDetailPage {...(makeProps({ loadDocument: vi.fn(async () => THREE_MD) }) as never)} />);
    await waitFor(() => expect(sections()).toHaveLength(3));
    fireEvent.change(screen.getByPlaceholderText("搜索需求…"), { target: { value: "记住" } });
    expect(sections()).toHaveLength(1);
    expect(sections()[0].querySelector("[data-doc-heading]")!.textContent).toBe("记住帐号");
    expect(toggleOf(sections()[0]).getAttribute("aria-expanded")).toBe("true");
    expect(sections()[0].querySelectorAll("[data-scenario]")).toHaveLength(2);
    await waitFor(() => expect(tocAnchors()).toEqual(["Purpose", "记住帐号"]));
    // 清空还原：第一条展开、其余收合。
    fireEvent.change(screen.getByPlaceholderText("搜索需求…"), { target: { value: "" } });
    expect(sections().map((s) => toggleOf(s).getAttribute("aria-expanded"))).toEqual(["true", "false", "false"]);
  });

  it("需求段之外的内容照样呈现：引言在 Purpose 之后、其他 `## ` 区段在需求之后", async () => {
    const md = [
      "# x Specification",
      "## Purpose",
      "目的。",
      "## Requirements",
      "这些需求适用于所有平台。",
      "### Requirement: A",
      "A 内文。",
      "## 附录",
      "补充说明。",
    ].join("\n\n");
    render(<SpecDetailPage {...(makeProps({ loadDocument: vi.fn(async () => md) }) as never)} />);
    await waitFor(() => expect(sections()).toHaveLength(1));
    const intro = document.querySelector("[data-spec-intro]") as HTMLElement;
    const appendix = document.querySelector("[data-spec-appendix]") as HTMLElement;
    expect(intro.textContent).toContain("这些需求适用于所有平台。");
    expect(appendix.textContent).toContain("补充说明。");
    // 文档顺序：Purpose → 引言 → 需求 → 附录。
    const order = [document.querySelector("[data-purpose]")!, intro, sections()[0], appendix];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // 「附录」列入本页目录。
    await waitFor(() => expect(tocAnchors()).toContain("附录"));
  });

  it("收合的需求段展开后，内文的子标题补进本页目录；再收合即移除", async () => {
    const md = [
      "# x Specification",
      "## Purpose",
      "目的。",
      "## Requirements",
      "### Requirement: A",
      "A 内文。",
      "### Requirement: B",
      "B 内文。",
      "### 补充细节",
      "细节内文。",
    ].join("\n\n");
    render(<SpecDetailPage {...(makeProps({ loadDocument: vi.fn(async () => md) }) as never)} />);
    await waitFor(() => expect(sections()).toHaveLength(2));
    await waitFor(() => expect(tocAnchors()).toEqual(["Purpose", "A", "B"]));
    fireEvent.click(toggleOf(sections()[1]));
    await waitFor(() => expect(tocAnchors()).toEqual(["Purpose", "A", "B", "补充细节"]));
    fireEvent.click(toggleOf(sections()[1]));
    await waitFor(() => expect(tocAnchors()).toEqual(["Purpose", "A", "B"]));
  });
});

describe("SpecDetailPage（溯源分页）", () => {
  it("溯源列依封存日期升幂、副标为封存日期（spec Example「三个来源变更的排序」）", async () => {
    const doc = [
      "# x\n\n## Requirements\n\n### Requirement: a\n\n内文 a。\n",
      "<!-- @trace\nsource: drawer-polish\nupdated: 2026-08-04\n-->\n",
      "### Requirement: b\n\n内文 b。\n",
      "<!-- @trace\nsource: spec-archive-drawer\nupdated: 2026-07-11\n-->\n",
      "### Requirement: c\n\n内文 c。\n",
      "<!-- @trace\nsource: desktop-archived-parity\nupdated: 2026-08-11\n-->\n",
    ].join("\n");
    const props = makeProps({
      loadDocument: vi.fn(async () => doc),
      renderDocumentActions: () => <button type="button">打开 ▾</button>,
      archivedChanges: [
        { datedName: "2026-08-04-drawer-polish", date: "2026-08-04", name: "drawer-polish" },
        { datedName: "2026-07-11-spec-archive-drawer", date: "2026-07-11", name: "spec-archive-drawer" },
        { datedName: "2026-08-11-desktop-archived-parity", date: "2026-08-11", name: "desktop-archived-parity" },
      ],
    });
    render(<SpecDetailPage {...(props as never)} />);
    await waitFor(() => expect(screen.getByText("内文 a。")).toBeTruthy());
    expect(screen.getByRole("tab", { name: /溯源/ }).textContent).toContain("3");
    await openTraceTab();
    await waitFor(() => expect(traceRows()).toHaveLength(3));
    expect(traceRows().map((r) => r.textContent)).toEqual([
      expect.stringContaining("spec-archive-drawer"),
      expect.stringContaining("drawer-polish"),
      expect.stringContaining("desktop-archived-parity"),
    ]);
    expect(traceRows()[0].textContent).toContain("2026-07-11");
    expect(traceRows()[1].textContent).toContain("2026-08-04");
    expect(traceRows()[2].textContent).toContain("2026-08-11");
    // 阅读卡标题「溯源」带签 3；推导文档不对应文档、无「打开 ▾」。
    const header = document.querySelector("[data-doc-header]") as HTMLElement;
    expect(within(header).getByRole("heading", { level: 2 }).textContent).toBe("溯源");
    expect(within(header).getByText("3")).toBeTruthy();
    expect(within(header).queryByRole("button", { name: "打开 ▾" })).toBeNull();
  });

  it("点命中列以 datedName 调用 onOpenArchivedChange", async () => {
    const props = makeProps();
    render(<SpecDetailPage {...(props as never)} />);
    await openTraceTab();
    await waitFor(() => expect(traceRows()).toHaveLength(2));
    fireEvent.click(traceRows()[0]);
    expect(props.onOpenArchivedChange).toHaveBeenCalledWith("2026-07-01-change-one");
    fireEvent.click(traceRows()[1]);
    expect(props.onOpenArchivedChange).toHaveBeenCalledWith("2026-07-02-change-two");
  });

  it("无封存记录的来源排在后、副标「无封存记录」、aria-disabled 且点击不调用", async () => {
    const props = makeProps({ archivedChanges: [ARCHIVED[1]] }); // 只有 change-one 有封存记录
    render(<SpecDetailPage {...(props as never)} />);
    await openTraceTab();
    await waitFor(() => expect(traceRows()).toHaveLength(2));
    const [hit, ghost] = traceRows();
    expect(hit.textContent).toContain("change-one");
    expect(ghost.textContent).toContain("change-two");
    expect(ghost.textContent).toContain("无封存记录");
    expect(ghost.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(ghost);
    expect(props.onOpenArchivedChange).not.toHaveBeenCalled();
  });
});

describe("SpecDetailPage（加载）", () => {
  it("refreshGen 世代重载不清空，回应到达后单次替换", async () => {
    const pending: Array<(v: string | null) => void> = [];
    let hang = false;
    const loadDocument = vi.fn((_cap: string) =>
      hang ? new Promise<string | null>((r) => pending.push(r)) : Promise.resolve<string | null>(SPEC_MD),
    );
    const props = makeProps({ loadDocument });
    const { rerender } = render(<SpecDetailPage {...(props as never)} refreshGen={0} />);
    await waitFor(() => expect(screen.getByText("清单内文。")).toBeTruthy());
    hang = true;
    rerender(<SpecDetailPage {...(props as never)} refreshGen={1} />);
    await waitFor(() => expect(pending.length).toBe(1));
    expect(screen.getByText("清单内文。")).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    pending[0]("# 新版\n\n更新后内文。\n");
    await waitFor(() => expect(screen.getByText("更新后内文。")).toBeTruthy());
    expect(screen.queryByText("清单内文。")).toBeNull();
  });

  it("latest-wins：旧世代回应晚到不覆盖新世代内容", async () => {
    const pending: Array<(v: string | null) => void> = [];
    const loadDocument = vi.fn(() => new Promise<string | null>((r) => pending.push(r)));
    const props = makeProps({ loadDocument });
    const { rerender } = render(<SpecDetailPage {...(props as never)} refreshGen={0} />);
    await waitFor(() => expect(pending.length).toBe(1));
    rerender(<SpecDetailPage {...(props as never)} refreshGen={1} />);
    await waitFor(() => expect(pending.length).toBe(2));
    pending[1]("# v2\n\nv2 内文。\n");
    await waitFor(() => expect(screen.getByText("v2 内文。")).toBeTruthy());
    pending[0]("# v1\n\nv1-stale 内文。\n");
    await new Promise((r) => setTimeout(r, 25));
    expect(screen.queryByText("v1-stale 内文。")).toBeNull();
    expect(screen.getByText("v2 内文。")).toBeTruthy();
  });

  it("换目标时清空并全量重载，搜索字符串归零", async () => {
    const loadDocument = vi.fn(async (cap: string) =>
      cap === "desktop-app" ? SPEC_MD : "# 另一份\n\n另一份内文。\n",
    );
    const props = makeProps({ loadDocument });
    const { rerender } = render(<SpecDetailPage {...(props as never)} />);
    await waitFor(() => expect(screen.getByText("清单内文。")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("搜索需求…"), { target: { value: "清单" } });
    rerender(<SpecDetailPage {...(props as never)} capability="desktop-config" />);
    await waitFor(() => expect(screen.getByText("另一份内文。")).toBeTruthy());
    expect(loadDocument).toHaveBeenCalledWith("desktop-config");
    expect(screen.queryByText("清单内文。")).toBeNull();
    expect((screen.getByPlaceholderText("搜索需求…") as HTMLInputElement).value).toBe("");
  });

  it("内文在阅读卡的 DocBody 内：15px、行宽以卡栏为上限", async () => {
    render(<SpecDetailPage {...(makeProps() as never)} />);
    await waitFor(() => expect(screen.getByText("清单内文。")).toBeTruthy());
    const body = document.querySelector("[data-doc-body]") as HTMLElement;
    expect(body.className).toContain("text-[15px]");
    expect(body.className).toContain("[&_.markdown]:max-w-none");
    expect(body.textContent).toContain("清单内文。");
    expect((document.querySelector("[data-detail-reading] > div") as HTMLElement).className).toContain("max-w-[768px]");
  });
});

// spec「详情页文档加载以 skeleton 呈现」：三态分流。
describe("规格详情页文档三态", () => {
  it("加载中 → 文档骨架，不出空态文案", async () => {
    render(<SpecDetailPage {...(makeProps({ loadDocument: vi.fn(() => new Promise<never>(() => {})) }) as never)} />);
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeTruthy());
    expect(screen.queryByText("（无内容）")).toBeNull();
  });

  it("加载完成且不存在 → 空态文案，无骨架", async () => {
    render(<SpecDetailPage {...(makeProps({ loadDocument: vi.fn(async () => null) }) as never)} />);
    await waitFor(() => expect(screen.getByText("（无内容）")).toBeTruthy());
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("首载失败 → 落到空态文案，不停在骨架", async () => {
    const props = makeProps({ loadDocument: vi.fn().mockRejectedValue(new Error("offline")) });
    render(<SpecDetailPage {...(props as never)} />);
    await waitFor(() => expect(screen.getByText("（无内容）")).toBeTruthy());
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });
});

// fix-english-status-labels-and-plurals：英文接口数量为 1 时用单数（desktop-config「英文计数文案依数量使用单数或复数」）。
describe("英文接口的计数单复数", () => {
  const ONE_SCENARIO_MD = `# plain Specification

## Purpose

One requirement with one scenario.

## Requirements

### Requirement: Only

The system SHALL work.

#### Scenario: Works

- **WHEN** a reader opens it
- **THEN** it works
`;
  const enWrapper = ({ children }: { children: ReactNode }) => (
    <I18nProvider locale="en">{children}</I18nProvider>
  );

  it("身分区出身行为「1 requirement · 1 scenario」，不出现「1 scenarios」", async () => {
    rtlRender(<SpecDetailPage {...(makeProps({ loadDocument: vi.fn(async () => ONE_SCENARIO_MD) }) as never)} />, {
      wrapper: enWrapper,
    });
    await waitFor(() => expect(identityRow()?.textContent).toBe("1 requirement·1 scenario"));
    expect(document.body.textContent).not.toContain("1 scenarios");
  });
});

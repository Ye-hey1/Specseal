import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";

// 既有中文断言包 I18nProvider locale zh-CN 后照旧断言（i18n 抽 key 的回归保护）。
const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

import { TaskList } from "../components/TaskList";
import { SECTION_HEADING_CLS } from "../components/DocParts";
import { parseTaskDoc, parseTasks, resolveDropTarget } from "../tasks";

const MD = "## 1. Group A\n\n- [ ] 1.1 first\n- [x] 1.2 second\n\n## 2. Group B\n\n- [ ] 2.1 third\n";

describe("parseTaskDoc", () => {
  it("yields groups and ordinal-numbered tasks", () => {
    const items = parseTaskDoc(MD);
    expect(items).toEqual([
      { kind: "group", text: "1. Group A" },
      { kind: "task", ordinal: 1, done: false, text: "1.1 first" },
      { kind: "task", ordinal: 2, done: true, text: "1.2 second" },
      { kind: "group", text: "2. Group B" },
      { kind: "task", ordinal: 3, done: false, text: "2.1 third" },
    ]);
  });

  // spec task-identity「UI 剥离 ID 注解并以 stable ID 操作」：行首标记前缀剥离,
  // `[M]` 落 manual 旗标、历史遗留的 `[P]` 只剥不承载。
  it("strips leading markers and flags only [M] as manual", () => {
    const items = parseTaskDoc(
      "- [ ] [M] 手动验证导入结果\n- [ ] [M] 至外部服务放置密钥\n- [x] [P] 旧任务\n- [x] [P] [M] 混用\n- [ ] 无标记\n",
    );
    expect(items).toEqual([
      { kind: "task", ordinal: 1, done: false, text: "手动验证导入结果", manual: true },
      // 非测试类的手动任务同样解析——标记语意不判读描述内容。
      { kind: "task", ordinal: 2, done: false, text: "至外部服务放置密钥", manual: true },
      { kind: "task", ordinal: 3, done: true, text: "旧任务" },
      { kind: "task", ordinal: 4, done: true, text: "混用", manual: true },
      { kind: "task", ordinal: 5, done: false, text: "无标记" },
    ]);
  });

  // 与引擎同构(crates/engine/specseal-core/src/lifecycle/tasks.rs 的 parse/strip_markers 案例表
  // 对齐):checkbox 后恰一个空格才进标记槽,多余空白不被吃掉;剥离后修剪与
  // display.trim() 一致。
  it("checkbox 后多一个空格不进标记槽——与引擎同构", () => {
    // `- [ ]  [M] x`(两空格):引擎判非 manual、描述带字面 [M],UI 必须一致,
    // 否则徽章与计数/闸门互相矛盾。
    expect(parseTaskDoc("- [ ]  [M] 手测\n")[0]).toEqual({
      kind: "task",
      ordinal: 1,
      done: false,
      text: "[M] 手测",
    });
    expect(parseTasks("- [ ]  [M] 手测\n")[0]).toEqual({ done: false, text: "[M] 手测" });
  });

  it("标记剥离后修剪前后空白——与引擎 display.trim() 同构", () => {
    expect(parseTaskDoc("- [ ] [M]  双空格描述\n")[0]).toEqual({
      kind: "task",
      ordinal: 1,
      done: false,
      text: "双空格描述",
      manual: true,
    });
  });

  it("strips each marker at most once and keeps ID comments out of the text", () => {
    // 至多一次：第二个 [P] 是描述的一部分,不被吃掉。
    expect(parseTaskDoc("- [ ] [P] [P] 两个\n")[0]).toEqual({
      kind: "task",
      ordinal: 1,
      done: false,
      text: "[P] 两个",
    });
    // 前缀剥离与行尾 ID 注解剥离两者并存。
    expect(parseTaskDoc("- [ ] [M] 手测 <!-- specseal-task:tsk_A -->\n")[0]).toEqual({
      kind: "task",
      ordinal: 1,
      done: false,
      text: "手测",
      stableId: "tsk_A",
      manual: true,
    });
  });
});

describe("TaskList", () => {
  it("renders groups, checked state and fires onToggle with ordinal", () => {
    const onToggle = vi.fn();
    render(<TaskList markdown={MD} onToggle={onToggle} />);
    expect(screen.getByText("Group A")).toBeTruthy();
    const first = screen.getByRole("checkbox", { name: "任务 1" });
    const second = screen.getByRole("checkbox", { name: "任务 2" });
    expect(first.getAttribute("aria-checked")).toBe("false");
    expect(second.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(first);
    expect(onToggle).toHaveBeenCalledWith(1, true, undefined);
    fireEvent.click(second);
    expect(onToggle).toHaveBeenCalledWith(2, false, undefined);
  });

  it("renders a drag handle per task and no step buttons", () => {
    // spec 需求「任务清单拖放排序与自动重编号」：把手取代上下箭头。
    render(<TaskList markdown={MD} onReorder={vi.fn()} />);
    expect(screen.getByLabelText("拖曳任务 1")).toBeTruthy();
    expect(screen.getByLabelText("拖曳任务 2")).toBeTruthy();
    expect(screen.getByLabelText("拖曳任务 3")).toBeTruthy();
    expect(screen.queryByLabelText("上移任务 1")).toBeNull();
    expect(screen.queryByLabelText("下移任务 1")).toBeNull();
  });

  it("uses 15px type for task text", () => {
    // spec「markdown 内容保留文档结构呈现」：阅读卡内任务列文本 15px 与内文对齐。
    render(<TaskList markdown={MD} />);
    expect(screen.getByText("first").className).toContain("text-[15px]");
  });

  it("群组卡头与章节标题同款式（spec「任务群组标题与章节标签同款式」，design D5）", () => {
    const { container } = render(<TaskList markdown={MD} />);
    const heading = screen.getByText("Group A");
    // 16px 粗体章节标题（共用常数 SECTION_HEADING_CLS）。
    for (const cls of SECTION_HEADING_CLS.split(" ")) expect(heading.className).toContain(cls);
    for (const stale of ["text-xl", "text-xs", "uppercase", "tracking-wider", "text-muted-foreground"]) {
      expect(heading.className).not.toContain(stale);
    }
    // 标题文本照来源（序号拆成左端序号签，不含序号后的空白），不翻译不改写。
    expect(heading.tagName).toBe("H3");
    expect(heading.textContent).toBe("Group A");
    expect(heading.previousElementSibling!.textContent).toBe("1");
    // 本页目录锚点（desktop-detail-doc-tree design D5）。
    expect(heading.hasAttribute("data-doc-heading")).toBe(true);
    expect(container.querySelectorAll("[data-task-group]")).toHaveLength(2);
  });

  // spec desktop-app「任务列的手动任务徽章」（desktop-change-doc-views design D14：整列淡底＋列尾徽章）
  describe("手动任务徽章", () => {
    const MARKED = "- [ ] [M] 3.2 手动验证导入结果\n- [x] 3.1 跑全套测试\n";
    const rowOf = (text: string) => screen.getByText(text).closest("label") as HTMLElement;

    it("`[M]` 列整列淡底、徽章在标题列尾；勾选框与序号起始栏与无标记列同位", () => {
      // Scenario「手动任务列的徽章呈现」。
      render(<TaskList markdown={MARKED} />);
      const badge = screen.getByLabelText("手动");
      // 精确比对：文案退回「手动测试」等任何形变都会被抓到，不需模糊反向网。
      expect(badge.textContent).toBe("手动");
      expect(screen.getAllByLabelText("手动")).toHaveLength(1);
      const marked = rowOf("手动验证导入结果");
      const plain = rowOf("跑全套测试");
      expect(marked.hasAttribute("data-task-manual")).toBe(true);
      expect(marked.className).toContain("bg-status-manual/12");
      expect(plain.hasAttribute("data-task-manual")).toBe(false);
      expect(plain.className).not.toContain("bg-status-manual");
      // 徽章在标题那一行的列尾（展开钮之前），不在文本流里、不独占一行。
      const titleRow = badge.parentElement as HTMLElement;
      expect(titleRow.hasAttribute("data-task-title-row")).toBe(true);
      expect(titleRow.firstElementChild!.textContent).toBe("3.2");
      expect(titleRow.children[1].textContent).toBe("手动验证导入结果");
      expect(Array.from(titleRow.children).indexOf(badge)).toBeGreaterThan(1);
      // 两列结构相同：描述栏只有标题那一行（没有徽章行），且紧接 checkbox。
      for (const row of [marked, plain]) {
        const col = row.querySelector("[data-task-title-row]")!.parentElement as HTMLElement;
        expect(col.firstElementChild!.hasAttribute("data-task-title-row")).toBe(true);
        expect(col.previousElementSibling?.getAttribute("role")).toBe("checkbox");
      }
    });

    it("徽章配色取手动语意色（暖黄），不是 muted 灰阶、也不是进行中蓝", () => {
      render(<TaskList markdown={MARKED} />);
      const badge = screen.getByLabelText("手动");
      expect(badge.className).toContain("text-status-manual");
      expect(badge.className).not.toContain("bg-muted");
      expect(badge.className).not.toContain("status-progress");
    });

    it("长描述换行时徽章仍在标题列尾、不占描述的行", () => {
      // Scenario「长描述换行不动徽章」：jsdom 量不到实际换行，以结构为准。
      const long = `- [ ] [M] ${"很长的描述".repeat(40)}\n`;
      render(<TaskList markdown={long} />);
      const badge = screen.getByLabelText("手动");
      expect((badge.parentElement as HTMLElement).hasAttribute("data-task-title-row")).toBe(true);
      expect(badge.className).toContain("shrink-0");
    });

    it("勾完文本划线、整列淡底退掉，徽章保留且不划线", () => {
      // Scenario「勾完徽章保留」。
      render(<TaskList markdown={"- [x] [M] 3.2 手动验证导入结果\n"} />);
      expect(screen.getByText("手动验证导入结果").className).toContain("line-through");
      expect(rowOf("手动验证导入结果").className).not.toContain("bg-status-manual");
      const badge = screen.getByLabelText("手动");
      expect(badge.className).not.toContain("line-through");
    });

    it("旧 `[P]` 行剥离后无徽章、无淡底", () => {
      // Scenario「旧 [P] 行无徽章」。
      render(<TaskList markdown={"- [x] [P] 旧任务\n"} />);
      expect(screen.queryByLabelText("手动")).toBeNull();
      const row = rowOf("旧任务");
      expect(row.hasAttribute("data-task-manual")).toBe(false);
      expect(row.className).not.toContain("bg-status-manual");
    });

    it("无 `[M]` 任务的清单不长徽章与淡底", () => {
      const { container } = render(<TaskList markdown={MD} />);
      expect(screen.queryByLabelText("手动")).toBeNull();
      expect(container.querySelector("[data-task-manual]")).toBeNull();
    });

    it("可拖排时手动列同样整列淡底", () => {
      render(<TaskList markdown={MARKED} onToggle={vi.fn()} onReorder={vi.fn()} />);
      expect(rowOf("手动验证导入结果").className).toContain("bg-status-manual/12");
    });

    it("en 徽章文案为 Manual（放宽后不提 test）", () => {
      // 语意自「手动测试」放宽为「需用户亲手操作的任务」——两语系的文案
      // 都不得再把标记说成只限测试。
      rtlRender(
        <I18nProvider locale="en">
          <TaskList markdown={MARKED} />
        </I18nProvider>,
      );
      const badge = screen.getByLabelText("Manual");
      // 精确比对：退回 "Manual test"／"Manual Test" 任何大小写形变都会被抓到。
      expect(badge.textContent).toBe("Manual");
    });
  });

  it("readOnly renders neither handles nor interactive checkboxes", () => {
    render(<TaskList markdown={MD} readOnly />);
    expect(screen.queryByLabelText("拖曳任务 1")).toBeNull();
    expect((screen.getByRole("checkbox", { name: "任务 1" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("无 onReorder 时不渲染把手（remote capability 停用），勾选与工具列照常", () => {
    // remote-workspace-data spec「capability 驱动停用且不伪造缺口」：拖排写回
    // 缺席即整段不挂——绝不渲染点了没事的假把手。
    const onToggle = vi.fn();
    const onSetAll = vi.fn();
    render(<TaskList markdown={MD} onToggle={onToggle} onSetAll={onSetAll} />);
    expect(screen.queryByLabelText("拖曳任务 1")).toBeNull();
    // 勾选照常交互。
    fireEvent.click(screen.getByRole("checkbox", { name: "任务 1" }));
    expect(onToggle).toHaveBeenCalledWith(1, true, undefined);
    // 批量工具列照常（setAllTasks 在 remote 是组合实作、仍支持）。
    fireEvent.click(screen.getByRole("button", { name: /全部已完成/ }));
    expect(onSetAll).toHaveBeenCalledWith(true);
  });
});

// spec「任务群组标题与章节标签同款式」（desktop-change-doc-views design D5）：群组卡与三层任务列。
describe("TaskList 群组卡与三层任务列", () => {
  const LAYERED =
    "## 1. 解析器\n\n" +
    "- [ ] 1.1 添加 `a.ts`（design D3）：导出 x；验证：npm test\n" +
    "- [ ] 1.2 对齐导出\n";

  it("三层切分：标题层有序号、标题与 D 签；展开时标题下方有内文与验证，点列尾钮收起", () => {
    const { container } = render(<TaskList markdown={LAYERED} onToggle={vi.fn()} />);
    const titleRow = container.querySelector("[data-task-title-row]")!;
    expect(titleRow.querySelector("[data-task-title]")!.textContent).toBe("添加 a.ts");
    expect(titleRow.querySelector("[data-task-title] code")!.textContent).toBe("a.ts");
    expect(titleRow.querySelector("[data-task-decision]")!.textContent).toBe("D3");
    expect(screen.getByText("导出 x；")).toBeTruthy();
    expect(screen.getByText("验证")).toBeTruthy();
    expect(screen.getByText("npm test")).toBeTruthy();
    const btn = titleRow.querySelector("[data-task-expand]")!;
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("导出 x；")).toBeNull();
    expect(screen.queryByText("npm test")).toBeNull();
  });

  it.each([
    ["可拖排", true],
    ["无拖排", false],
  ])("%s：点展开钮与 D 签不切换勾选，D 签回报决策编号", (_label, sortable) => {
    const onToggle = vi.fn();
    const onJumpDecision = vi.fn();
    const { container } = render(
      <TaskList
        markdown={LAYERED}
        onToggle={onToggle}
        onReorder={sortable ? vi.fn() : undefined}
        onJumpDecision={onJumpDecision}
      />,
    );
    // 列尾钮来回各点一次，之后点 D 签与内文。
    const btn = container.querySelector("[data-task-expand]")!;
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(container.querySelector("[data-task-decision]")!);
    fireEvent.click(screen.getByText("导出 x；"));
    expect(onJumpDecision).toHaveBeenCalledWith("D3");
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("两个群组成两张卡，卡头右端为各自的小进度", () => {
    const md =
      "## 1. 甲\n\n- [x] 1.1 a\n- [x] 1.2 b\n\n" +
      "## 2. 乙\n\n- [x] 2.1 c\n- [x] 2.2 d\n- [x] 2.3 e\n- [ ] 2.4 f\n- [ ] 2.5 g\n";
    const { container } = render(<TaskList markdown={md} />);
    const cards = Array.from(container.querySelectorAll("[data-task-group]"));
    expect(cards.map((c) => c.querySelector("[data-task-group-progress]")!.textContent)).toEqual(["2/2", "3/5"]);
    expect(cards.map((c) => c.querySelector("h3")!.textContent)).toEqual(["甲", "乙"]);
  });

  it("第一个群组之前的任务以无卡头清单呈现", () => {
    const { container } = render(<TaskList markdown={"- [ ] 前导任务\n\n## 1. 甲\n\n- [ ] 1.1 a\n"} />);
    expect(container.querySelectorAll("[data-task-group]")).toHaveLength(1);
    expect(screen.getByText("前导任务").closest("[data-task-group]")).toBeNull();
  });

  it("唯读时列尾钮可用、勾选框 disabled", () => {
    const { container } = render(<TaskList markdown={LAYERED} readOnly />);
    expect((screen.getByRole("checkbox", { name: "任务 1" }) as HTMLButtonElement).disabled).toBe(true);
    const btn = container.querySelector("[data-task-expand]") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    const before = btn.getAttribute("aria-expanded");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).not.toBe(before);
  });

  it("拖曳时浮起的列只画标题层：原列展开中，浮起列也不带内文与验证", async () => {
    render(<TaskList markdown={LAYERED} onToggle={vi.fn()} onReorder={vi.fn()} />);
    const handle = screen.getByLabelText("拖曳任务 1");
    handle.focus();
    fireEvent.keyDown(handle, { code: "Space", key: " " });
    // 浮起列与原列同时在画面上：1.1 的标题有两份，内文与验证仍只有原列那一份。
    expect(screen.getAllByText("a.ts")).toHaveLength(2);
    expect(document.querySelectorAll("[data-task-detail]")).toHaveLength(1);
    // 结束拖曳：键盘传感器下一个 tick 才挂按键监听，不收掉会吃掉后面题目的空白键。
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.keyDown(handle, { code: "Escape", key: "Escape" });
  });

  // spec「任务群组标题与章节标签同款式」：缺省展开看勾选状态，勾选状态一变就跟着翻，
  // 手动切换维持到该任务的勾选状态下次改变。
  /** 以标题找该列的列尾钮；没有列尾钮时为 null。 */
  const expandBtn = (title: string) =>
    screen.getByText(title).closest("[data-task-title-row]")!.querySelector("[data-task-expand]");
  const expandedOf = (title: string) => expandBtn(title)?.getAttribute("aria-expanded") ?? null;
  const clickExpand = (title: string) => fireEvent.click(expandBtn(title)!);
  /** 任务行：行文、勾选状态与稳定 ID（行尾注解格式同本档任务）。 */
  type Row = { line: string; done: boolean; id?: string };
  const t31 = (done: boolean): Row => ({ line: "3.1 甲任务：甲内文", done, id: "tsk_01ARZ3NDEKTSV4RRFFQ69G5FA1" });
  const t32 = (done: boolean): Row => ({ line: "3.2 乙任务：乙内文", done, id: "tsk_01ARZ3NDEKTSV4RRFFQ69G5FA2" });
  const t33 = (done: boolean): Row => ({ line: "3.3 丙任务", done, id: "tsk_01ARZ3NDEKTSV4RRFFQ69G5FA3" });
  const t34 = (done: boolean): Row => ({ line: "3.4 丁任务：丁内文", done, id: "tsk_01ARZ3NDEKTSV4RRFFQ69G5FA4" });
  const withoutId = (row: Row): Row => ({ ...row, id: undefined });
  /** 一个群组的 markdown；跨群组的题目串接多段。 */
  const group = (heading: string, ...rows: Row[]) =>
    `## ${heading}\n\n` +
    rows.map((r) => `- [${r.done ? "x" : " "}] ${r.line}${r.id ? ` <!-- specseal-task:${r.id} -->` : ""}\n`).join("") +
    "\n";
  const list = (md: string) => <TaskList markdown={md} onToggle={vi.fn()} onReorder={vi.fn()} />;

  it.each([
    ["可写", false],
    ["唯读", true],
  ])("%s：依勾选状态决定缺省展开——未勾展开、已勾收合、无内文没有列尾钮", (_label, readOnly) => {
    render(<TaskList markdown={group("3. 丙", t31(false), t32(true), t33(false))} onToggle={vi.fn()} readOnly={readOnly} />);
    expect(expandedOf("甲任务")).toBe("true");
    expect(screen.getByText("甲内文")).toBeTruthy();
    expect(expandedOf("乙任务")).toBe("false");
    expect(screen.queryByText("乙内文")).toBeNull();
    expect(expandedOf("丙任务")).toBeNull();
  });

  it("勾选状态改变时展开跟着翻（列勾选、工具列批量、写回回滚与重新加载都以新 markdown 重绘）", () => {
    const { rerender } = render(list(group("3. 丙", t31(false), t32(true), t33(false))));
    expect(expandedOf("甲任务")).toBe("true");
    rerender(list(group("3. 丙", t31(true), t32(true), t33(false))));
    expect(expandedOf("甲任务")).toBe("false");
    expect(screen.queryByText("甲内文")).toBeNull();
    rerender(list(group("3. 丙", t31(false), t32(true), t33(false))));
    expect(expandedOf("甲任务")).toBe("true");
    rerender(list(group("3. 丙", t31(true), t32(true), t33(true))));
    expect([expandedOf("甲任务"), expandedOf("乙任务"), expandedOf("丙任务")]).toEqual(["false", "false", null]);
    rerender(list(group("3. 丙", t31(false), t32(false), t33(false))));
    expect([expandedOf("甲任务"), expandedOf("乙任务"), expandedOf("丙任务")]).toEqual(["true", "true", null]);
  });

  it("手动展开收合维持到勾选状态改变：重新加载与组内排序不重设，跟着稳定 ID 走", () => {
    const { rerender, unmount } = render(list(group("3. 丙", t31(false), t32(true), t34(false))));
    clickExpand("甲任务");
    clickExpand("乙任务");
    expect([expandedOf("甲任务"), expandedOf("乙任务")]).toEqual(["false", "true"]);
    // 别的任务勾选状态改变而重新加载：两列的手动选择不变。
    rerender(list(group("3. 丙", t31(false), t32(true), t34(true))));
    expect([expandedOf("甲任务"), expandedOf("乙任务"), expandedOf("丁任务")]).toEqual(["false", "true", "false"]);
    // 组内排序后（稳定 ID 不变）手动选择跟着各自的任务。
    rerender(list(group("3. 丙", t32(true), t31(false), t34(true))));
    expect([expandedOf("甲任务"), expandedOf("乙任务")]).toEqual(["false", "true"]);
    // 勾选状态一变，手动选择就作废。只翻一次时手动选择刚好等于新的缺省、分不出来，
    // 所以两列都来回翻一次再断言：手动选择还在的话，甲会停在收合、乙会停在展开。
    rerender(list(group("3. 丙", t32(false), t31(true), t34(true))));
    rerender(list(group("3. 丙", t32(true), t31(false), t34(true))));
    expect([expandedOf("甲任务"), expandedOf("乙任务")]).toEqual(["true", "false"]);
    // 离开再回来：依勾选状态重新决定。
    clickExpand("乙任务");
    expect(expandedOf("乙任务")).toBe("true");
    unmount();
    render(list(group("3. 丙", t32(true), t31(false), t34(true))));
    expect(expandedOf("乙任务")).toBe("false");
  });

  it("手动选择不因群组卡重建而重设：拖到别的群组、前面的群组增减一行", () => {
    const { rerender } = render(list(group("2. 乙组", t31(false)) + group("3. 丙组", t32(true), t34(false))));
    clickExpand("甲任务");
    clickExpand("乙任务");
    // 甲任务拖到丙组：甲换了群组卡，丙组卡头在清单里的位置也跟着位移。
    rerender(list(group("2. 乙组") + group("3. 丙组", t32(true), t31(false), t34(false))));
    expect([expandedOf("甲任务"), expandedOf("乙任务"), expandedOf("丁任务")]).toEqual(["false", "true", "true"]);
    // 外部重新加载在前面的群组加一行：后面群组卡的位置位移。
    rerender(list(group("2. 乙组", t33(false)) + group("3. 丙组", t32(true), t31(false), t34(false))));
    expect([expandedOf("甲任务"), expandedOf("乙任务")]).toEqual(["false", "true"]);
  });

  it("没有稳定 ID 的任务以序数识别：排序后手动选择留在原位置", () => {
    const { rerender } = render(list(group("3. 丙", withoutId(t31(false)), withoutId(t32(false)))));
    clickExpand("甲任务");
    expect([expandedOf("甲任务"), expandedOf("乙任务")]).toEqual(["false", "true"]);
    rerender(list(group("3. 丙", withoutId(t32(false)), withoutId(t31(false)))));
    // 第 1 个位置（现在是乙任务）留着收合，甲任务回到依勾选状态决定。
    expect([expandedOf("乙任务"), expandedOf("甲任务")]).toEqual(["false", "true"]);
  });
});

// spec「任务群组标题与章节标签同款式」Scenario「手动提示框前往任务列」（design D14）：页的「前往」经 locate 定位。
describe("TaskList 定位（locate）", () => {
  it.each([
    ["可写", false],
    ["唯读", true],
  ])("%s：locate 命中时卷到该列、短暂高亮并回报完成，勾选不变", (_label, readOnly) => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    const onLocated = vi.fn();
    const onToggle = vi.fn();
    render(
      <TaskList markdown={MD} readOnly={readOnly} onToggle={onToggle} locate={{ ordinal: 3, seq: 1 }} onLocated={onLocated} />,
    );
    expect(scrollSpy).toHaveBeenCalled();
    expect(screen.getByText("third").closest("[data-highlight]")?.getAttribute("data-highlight")).toBe("true");
    expect(screen.getByText("first").closest("[data-highlight]")?.getAttribute("data-highlight")).toBe("false");
    expect(onLocated).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });
});

// spec「表单控制项与按钮以主题化组件呈现」（desktop-shadcn-controls）
describe("TaskList 勾选框主题化", () => {
  it("勾选框为 checkbox 角色的非 input 元素，aria-checked 反映完成态", () => {
    render(<TaskList markdown={MD} onToggle={vi.fn()} />);
    const first = screen.getByRole("checkbox", { name: "任务 1" });
    const second = screen.getByRole("checkbox", { name: "任务 2" });
    expect(first.tagName).not.toBe("INPUT");
    expect(first.getAttribute("aria-checked")).toBe("false");
    expect(second.getAttribute("aria-checked")).toBe("true");
  });

  it("空白键切换触发与点击相同的 onToggle", async () => {
    const onToggle = vi.fn();
    render(<TaskList markdown={MD} onToggle={onToggle} />);
    const first = screen.getByRole("checkbox", { name: "任务 1" });
    // 主题化原语（button 元素）——原生 input 在此守卫即红。
    expect(first.tagName).not.toBe("INPUT");
    first.focus();
    await userEvent.keyboard(" ");
    expect(onToggle).toHaveBeenCalledWith(1, true, undefined);
    fireEvent.click(first);
    // 点击与空白键走同一回呼、同一参数。
    expect(onToggle).toHaveBeenNthCalledWith(2, 1, true, undefined);
  });

  it("readOnly 时勾选框不可交互", () => {
    const onToggle = vi.fn();
    render(<TaskList markdown={MD} readOnly onToggle={onToggle} />);
    const first = screen.getByRole("checkbox", { name: "任务 1" });
    expect(first.tagName).not.toBe("INPUT");
    expect((first as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(first);
    expect(onToggle).not.toHaveBeenCalled();
  });
});

// spec「任务列整列可点」（design D8）：整列为勾选框的 label；把手不切换；唯读与
// 批量写回中（busy）不回应；拖曳仍只由把手启动。
describe("TaskList 整列可点", () => {
  const rowOf = (text: string) => screen.getByText(text).closest("label") as HTMLLabelElement;

  it.each([
    ["可拖排", true],
    ["无拖排", false],
  ])("%s：点任务文本调用 onToggle 一次，效果与点勾选框相同", (_label, sortable) => {
    const onToggle = vi.fn();
    render(<TaskList markdown={MD} onToggle={onToggle} onReorder={sortable ? vi.fn() : undefined} />);
    const row = rowOf("first");
    expect(row).toBeTruthy();
    const checkbox = screen.getByRole("checkbox", { name: "任务 1" });
    expect(row.htmlFor).toBe(checkbox.id);
    expect(row.className).toContain("cursor-(--cursor-interaction)");
    expect(row.className).toContain("hover:bg-foreground/5");
    fireEvent.click(screen.getByText("first"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(1, true, undefined);
  });

  it("点拖曳把手不切换", () => {
    const onToggle = vi.fn();
    render(<TaskList markdown={MD} onToggle={onToggle} onReorder={vi.fn()} />);
    const handle = screen.getByLabelText("拖曳任务 1");
    fireEvent.pointerDown(handle);
    fireEvent.click(handle);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("唯读列点击不切换，label 无 htmlFor、光标缺省且没有 hover 底色", () => {
    const onToggle = vi.fn();
    render(<TaskList markdown={MD} readOnly onToggle={onToggle} />);
    const row = rowOf("first");
    expect(row.htmlFor).toBe("");
    expect(row.className).toContain("cursor-default");
    expect(row.className).not.toContain("hover:");
    fireEvent.click(screen.getByText("first"));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it.each([
    ["可拖排", true],
    ["无拖排", false],
  ])("%s：批量写回中（busy）点列不切换", (_label, sortable) => {
    const onToggle = vi.fn();
    render(
      <TaskList markdown={MD} busy onToggle={onToggle} onReorder={sortable ? vi.fn() : undefined} />,
    );
    const row = rowOf("first");
    expect(row.htmlFor).toBe("");
    expect(row.className).toContain("cursor-default");
    fireEvent.click(screen.getByText("first"));
    fireEvent.click(screen.getByRole("checkbox", { name: "任务 1" }));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("拖曳仍只由把手启动：sortable 属性只在把手上，列本身没有", () => {
    render(<TaskList markdown={MD} onToggle={vi.fn()} onReorder={vi.fn()} />);
    const row = rowOf("first");
    expect(row.getAttribute("aria-roledescription")).toBeNull();
    expect(screen.getByLabelText("拖曳任务 1").getAttribute("aria-roledescription")).toBe("sortable");
  });

  it("有写入能力时工具列附灰字提示；没有把手时不提把手；唯读时没有", () => {
    const { unmount } = render(
      <TaskList markdown={MD} onToggle={vi.fn()} onReorder={vi.fn()} onSetAll={vi.fn()} />,
    );
    const hint = screen.getByText("点整列即可勾选；拖曳把手改顺序");
    expect(hint.className).toContain("text-muted-foreground");
    expect(hint.className).toContain("text-xs");
    unmount();
    const plain = render(<TaskList markdown={MD} onToggle={vi.fn()} onSetAll={vi.fn()} />);
    expect(screen.getByText("点整列即可勾选")).toBeTruthy();
    expect(screen.queryByText(/拖曳把手/)).toBeNull();
    plain.unmount();
    render(<TaskList markdown={MD} readOnly />);
    expect(screen.queryByText(/点整列即可勾选/)).toBeNull();
  });

  it.each([
    ["可拖排", true],
    ["无拖排", false],
  ])("%s：拖选文本后的 click 不切换；直接点勾选框不受影响", (_label, sortable) => {
    const onToggle = vi.fn();
    render(<TaskList markdown={MD} onToggle={onToggle} onReorder={sortable ? vi.fn() : undefined} />);
    const selection = vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "first" } as Selection);
    fireEvent.click(screen.getByText("first"));
    expect(onToggle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "任务 1" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    selection.mockRestore();
  });

  it("双击任务文本选字：两下点击互相抵销，勾选状态不变", () => {
    const onToggle = vi.fn();
    const reorder = vi.fn();
    const { rerender } = render(<TaskList markdown={MD} onToggle={onToggle} onReorder={reorder} />);
    fireEvent.click(screen.getByText("first"), { detail: 1 });
    // 宿主乐观改写 tasks.md；第二下按下时浏览器已选取该字。
    rerender(<TaskList markdown={MD.replace("- [ ] 1.1", "- [x] 1.1")} onToggle={onToggle} onReorder={reorder} />);
    const text = screen.getByText("first");
    const selection = vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "first" } as Selection);
    fireEvent.click(text, { detail: 2 });
    selection.mockRestore();
    expect(onToggle.mock.calls).toEqual([
      [1, true, undefined],
      [1, false, undefined],
    ]);
  });

  it("拖曳进行中按 Esc 标为已处理：只取消拖曳，不让详情页的 Esc 关页", () => {
    const onDragActiveChange = vi.fn();
    render(
      <TaskList markdown={MD} onToggle={vi.fn()} onReorder={vi.fn()} onDragActiveChange={onDragActiveChange} />,
    );
    expect(fireEvent.keyDown(window, { key: "Escape" })).toBe(true);
    const handle = screen.getByLabelText("拖曳任务 1");
    handle.focus();
    fireEvent.keyDown(handle, { code: "Space", key: " " });
    expect(onDragActiveChange).toHaveBeenLastCalledWith(true);
    expect(fireEvent.keyDown(window, { key: "Escape" })).toBe(false);
  });
});

// spec「任务分页提供批量操作工具列」（desktop-task-interactions）
describe("TaskList 工具列", () => {
  it("renders the three batch actions and fires onSetAll", () => {
    const onSetAll = vi.fn();
    render(<TaskList markdown={MD} onSetAll={onSetAll} />);
    fireEvent.click(screen.getByRole("button", { name: "全部已完成" }));
    expect(onSetAll).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "重置任务" }));
    expect(onSetAll).toHaveBeenCalledWith(false);
  });

  it("disables 全部已完成 and 下一个未完成 when everything is done", () => {
    const allDone = "## 1. G\n\n- [x] 1.1 a\n- [x] 1.2 b\n";
    render(<TaskList markdown={allDone} onSetAll={vi.fn()} />);
    expect((screen.getByRole("button", { name: "全部已完成" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /下一个未完成/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "重置任务" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("readOnly hides the toolbar", () => {
    render(<TaskList markdown={MD} readOnly />);
    expect(screen.queryByRole("button", { name: "全部已完成" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重置任务" })).toBeNull();
  });

  it("下一个未完成 scrolls the first unchecked task into view and highlights it", () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    render(<TaskList markdown={MD} onSetAll={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /下一个未完成/ }));
    expect(scrollSpy).toHaveBeenCalled();
    // 第一个未完成＝任务 1（1.1 first），其列带短暂高亮标记。
    const row = screen.getByText("first").closest("[data-highlight]");
    expect(row?.getAttribute("data-highlight")).toBe("true");
  });

  it("n key triggers the same next-undone locate, but not while typing", () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    const { container } = render(
      <div>
        <input aria-label="其他输入框" />
        <TaskList markdown={MD} onSetAll={vi.fn()} />
      </div>,
    );
    fireEvent.keyDown(window, { key: "n" });
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    // 输入框打字不触发定位。
    fireEvent.keyDown(container.querySelector("input")!, { key: "n" });
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });
});

describe("resolveDropTarget（拖放落点解析，design D6）", () => {
  // items: [g-0(群组1), task1, task2, g-3(群组2), task3, g-5(空群组)]
  const items = parseTaskDoc(
    "## 1. A\n\n- [ ] 1.1 a\n- [ ] 1.2 b\n\n## 2. B\n\n- [ ] 2.1 c\n\n## 3. 空的\n",
  );

  it("落点为任务：转发 ordinal、侧别留给方向推断", () => {
    expect(resolveDropTarget(items, 1, 3)).toEqual({ to: 3 });
  });

  it("落点为群组标题：解析为组首任务 ordinal＋before=true", () => {
    expect(resolveDropTarget(items, 1, "g-3")).toEqual({ to: 3, before: true });
  });

  it("落点为空群组标题：无效落点回 null（不触发 onReorder）", () => {
    expect(resolveDropTarget(items, 1, "g-5")).toBeNull();
  });

  it("落点为自己：回 null", () => {
    expect(resolveDropTarget(items, 2, 2)).toBeNull();
  });

  // spec Example「标题落点双向」——标题是组界槽，依 active 相对位置解析。
  describe("双向标题落点", () => {
    // ## 1. 前段: 1.1 甲(1)、1.2 乙(2)；## 2. 后段: 2.1 丙(3)、2.2 丁(4)
    const twoGroups = parseTaskDoc(
      "## 1. 前段\n\n- [ ] 1.1 甲\n- [ ] 1.2 乙\n\n## 2. 后段\n\n- [ ] 2.1 丙\n- [ ] 2.2 丁\n",
    );

    it("上方来→成为组首（before=true）", () => {
      expect(resolveDropTarget(twoGroups, 2, "g-3")).toEqual({ to: 3, before: true });
    });

    it("下方来（含组首自己）→移到标题之前、锚定上一群组末任务（before=false）", () => {
      // 乙已成 2.1 后拖回「## 2」标题：## 1: 甲(1)；## 2: 乙(2)、丙(3)、丁(4)
      const afterPromote = parseTaskDoc(
        "## 1. 前段\n\n- [ ] 1.1 甲\n\n## 2. 后段\n\n- [ ] 2.1 乙\n- [ ] 2.2 丙\n- [ ] 2.3 丁\n",
      );
      expect(resolveDropTarget(afterPromote, 2, "g-2")).toEqual({ to: 1, before: false });
      // 更深处的任务拖到标题也走同一规则（丙 → 上一组末＝甲）
      expect(resolveDropTarget(afterPromote, 3, "g-2")).toEqual({ to: 1, before: false });
    });

    it("标题之前无任务可锚定（档首标题）→ null", () => {
      const headFirst = parseTaskDoc("## 1. X\n\n- [ ] 1.1 a\n- [ ] 1.2 b\n");
      expect(resolveDropTarget(headFirst, 2, "g-0")).toBeNull();
    });
  });
});

// --- stable task ID（spec task-identity「UI 剥离 ID 注解并以 stable ID 操作」）---

import { setTaskMark, taskKey } from "../tasks";

const TID_A = "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TID_B = "tsk_01BX5ZZKBKACTAV9WEVGEMMVRZ";
const MD_IDS = `## 1. Group A\n\n- [ ] 1.1 first <!-- specseal-task:${TID_A} -->\n- [x] 1.2 second <!-- specseal-task:${TID_B} -->\n`;

describe("stable task IDs", () => {
  it("parseTaskDoc 剥离标记入 stableId，显示文本与无注解时相同", () => {
    const withIds = parseTaskDoc(MD_IDS).filter((i) => i.kind === "task");
    const without = parseTaskDoc("## 1. Group A\n\n- [ ] 1.1 first\n- [x] 1.2 second\n").filter(
      (i) => i.kind === "task",
    );
    expect(withIds.map((t) => (t.kind === "task" ? t.text : ""))).toEqual(
      without.map((t) => (t.kind === "task" ? t.text : "")),
    );
    expect(withIds[0]).toMatchObject({ ordinal: 1, stableId: TID_A });
    expect(withIds[1]).toMatchObject({ ordinal: 2, stableId: TID_B });
    expect(without.every((t) => t.kind === "task" && t.stableId === undefined)).toBe(true);
  });

  it("taskKey 以 stable ID 为 key、无 ID 退回 ordinal", () => {
    expect(taskKey({ kind: "task", ordinal: 3, done: false, text: "x", stableId: TID_A })).toBe(
      TID_A,
    );
    expect(taskKey({ kind: "task", ordinal: 3, done: false, text: "x" })).toBe("3");
  });

  it("清单显示不含标记、勾选请求携 stable ID（无 ID 走 ordinal 兼容）", () => {
    const onToggle = vi.fn();
    const stamped = render(<TaskList markdown={MD_IDS} onToggle={onToggle} />);
    expect(screen.getByText("first")).toBeTruthy();
    expect(document.body.textContent).not.toContain("specseal-task");
    fireEvent.click(screen.getByRole("checkbox", { name: "任务 1" }));
    expect(onToggle).toHaveBeenCalledWith(1, true, TID_A);
    stamped.unmount();
    // 无 ID 任务：stableId 缺席 → ordinal 兼容路径。
    const bare = vi.fn();
    render(<TaskList markdown={"- [ ] 1.1 solo\n"} onToggle={bare} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "任务 1" }));
    expect(bare).toHaveBeenCalledWith(1, true, undefined);
  });

  it("setTaskMark 乐观就地改写保留行尾注解原文", () => {
    const next = setTaskMark(`- [ ] 1.1 first <!-- specseal-task:${TID_A} -->\n`, 1, true);
    expect(next).toBe(`- [x] 1.1 first <!-- specseal-task:${TID_A} -->\n`);
  });

  // spec task-identity Scenario「标记前缀剥离且写回保留」：显示剥离只影响呈现,
  // 写回是行级改写——`[M] ` 前缀在文档里原样留着。
  it("setTaskMark 保留行首标记前缀原文", () => {
    expect(setTaskMark("- [ ] [M] 手动验证导入结果\n", 1, true)).toBe(
      "- [x] [M] 手动验证导入结果\n",
    );
    expect(setTaskMark("- [x] [P] 旧任务\n", 1, false)).toBe("- [ ] [P] 旧任务\n");
  });
});

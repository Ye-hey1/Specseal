// spec desktop-manual-page（design「侧栏树、搜索与上下页在前端由索引推导」）：
// 「手册页的侧栏树与阅读序」「手册页的搜索列」「内页渲染与出处跳规格」
// 「可能过期与未入册的标示」「无手册与 remote 模式的空状态」。索引由 props 注入
// （已依阅读序排好），组件只做分组、过滤、上下页与内文加载。
import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";
import { ManualPage } from "../components/ManualPage";
import { TREE_NODE_CLS } from "../components/ui/tabs";
import { countHeadings } from "../manualDoc";
import { SEMANTIC_SURFACE, SEMANTIC_TONE } from "../tone";
import type { ManualIndex, ManualPageItem } from "../adapter";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

function page(over: Partial<ManualPageItem> & { slug: string }): ManualPageItem {
  return {
    title: over.slug,
    section: null,
    order: null,
    keywords: [],
    sources: [],
    generated: null,
    stale: false,
    ...over,
  };
}

/** 索引 fixture：四个分区（开始使用×2、文档协作、附录）＋缺栏页（orphan）＋坏页
 * （broken）——后两者 section 为 null、order 为 null、已由 core 置于阅读序末端。 */
const INDEX: ManualIndex = {
  present: true,
  reason: null,
  pages: [
    page({ slug: "index", title: "手册", section: "开始使用", order: 10, generated: "2026-09-01" }),
    page({
      slug: "first-login",
      title: "第一次登录",
      section: "开始使用",
      order: 20,
      keywords: ["登录", "github", "审核"],
      sources: ["github-oauth", "user-pending-blocked-pages"],
      generated: "2026-09-01",
      stale: true,
    }),
    page({
      slug: "editor",
      title: "认识画面",
      section: "文档协作",
      order: 30,
      sources: ["editor"],
      generated: "2026-09-01",
    }),
    page({ slug: "about", title: "本手册的来源", section: "附录", order: 40 }),
    page({ slug: "orphan" }),
    page({ slug: "broken" }),
  ],
  uncoveredNew: [],
  malformed: ["broken"],
};

const BODIES: Record<string, string> = {
  index: "# 手册\n\n欢迎。",
  "first-login": "# 第一次登录\n\n用 GitHub 登录。\n\n**出处**：`github-oauth`、`user-pending-blocked-pages`\n",
  editor: "# 认识画面\n\n> [!NOTE]\n> 提示内容\n\n**出处**：`editor`",
  about: "# 本手册的来源\n\n取材范围。",
  orphan: "没有字段的页",
  broken: "---\ntitle: [unclosed\n---\n坏页全文",
};

function loader(over: Record<string, () => Promise<string | null>> = {}) {
  return vi.fn(async (slug: string) => (slug in over ? over[slug]() : (BODIES[slug] ?? null)));
}

function renderManual(
  props: Partial<Parameters<typeof ManualPage>[0]> = {},
  loadPage = loader(),
) {
  const onOpenSpec = vi.fn();
  const view = render(
    <ManualPage
      index={INDEX}
      loadPage={loadPage}
      onOpenSpec={onOpenSpec}
      capabilities={["github-oauth", "editor"]}
      // 缺省 spec 目录：core 解析出的相对路径与契约缺省版面同字。
      locateDocument={async (doc) => ("manual" in doc ? { relative: `openspec/manual/${doc.manual}.md` } : null)}
      {...props}
    />,
  );
  return { ...view, onOpenSpec, loadPage };
}

const tree = () => document.querySelector("[data-manual-tree]") as HTMLElement;
const sections = () =>
  Array.from(tree().querySelectorAll("[data-manual-section]")).map((s) =>
    s.getAttribute("data-manual-section"),
  );
const rows = () =>
  Array.from(tree().querySelectorAll("[data-manual-page]")).map((r) => r.getAttribute("data-manual-page"));
const row = (slug: string) => tree().querySelector(`[data-manual-page="${slug}"]`) as HTMLElement;
const content = () => document.querySelector("[data-manual-content]") as HTMLElement;
const docHeader = () => content().querySelector("[data-doc-header]") as HTMLElement;
const docProvenance = () => content().querySelector("[data-doc-provenance]") as HTMLElement | null;
const tiles = () => Array.from(content().querySelectorAll<HTMLElement>("[data-doc-tile]")).map((el) => el.textContent);
const staleCallout = () => content().querySelector('[data-callout="stale"]') as HTMLElement | null;
const prevButton = () => screen.queryByRole("button", { name: "上一页" });
const nextButton = () => screen.queryByRole("button", { name: "下一页" });
/** 上一页／下一页按钮标的 slug（data hook）；缺席＝无该方向的页。 */
const prevTarget = () => document.querySelector("[data-manual-prev]")?.getAttribute("data-manual-prev") ?? null;
const nextTarget = () => document.querySelector("[data-manual-next]")?.getAttribute("data-manual-next") ?? null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ManualPage 侧栏树与阅读序", () => {
  it("依阅读序分区与列序；缺 section 的页归「其他」；坏页以文档名列出", async () => {
    // spec Scenario「依 order 排序并依 section 分组」Example＋「缺字段的页宽容降级」
    // ＋「frontmatter 坏掉的页仍可开」。
    renderManual();
    await screen.findByText("欢迎。");
    expect(sections()).toEqual(["开始使用", "文档协作", "附录", "其他"]);
    expect(rows()).toEqual(["index", "first-login", "editor", "about", "orphan", "broken"]);
    expect(row("first-login").textContent).toContain("第一次登录");
    expect(row("orphan").textContent).toContain("orphan");
    expect(row("broken").textContent).toContain("broken");
    expect(document.querySelector("[data-manual-no-results]")).toBeNull();
  });

  it("缺省打开首页；上一页／下一页沿阅读序，首页无上一页、末页无下一页", async () => {
    const { loadPage } = renderManual();
    await screen.findByText("欢迎。");
    expect(loadPage).toHaveBeenCalledWith("index");
    expect(row("index").getAttribute("aria-current")).toBe("page");
    expect(prevButton()).toBeNull();
    expect(nextButton()).toBeTruthy();

    fireEvent.click(nextButton()!);
    await screen.findByText("用 GitHub 登录。");
    expect(row("first-login").getAttribute("aria-current")).toBe("page");
    expect(row("index").getAttribute("aria-current")).toBeNull();
    expect(prevButton()).toBeTruthy();
    fireEvent.click(prevButton()!);
    await screen.findByText("欢迎。");

    fireEvent.click(row("broken"));
    await screen.findByText("坏页全文");
    expect(nextButton()).toBeNull();
    expect(prevButton()).toBeTruthy();
  });

  it("spec Example「排序与分组」四页逐列：侧字段置、上一页、下一页", async () => {
    // spec Scenario「依 order 排序并依 section 分组」Example 表，逐列以同值断言。
    const example: ManualIndex = {
      ...INDEX,
      pages: [
        page({ slug: "index", title: "手册", section: "开始使用", order: 10 }),
        page({ slug: "first-login", title: "第一次登录", section: "开始使用", order: 20 }),
        page({ slug: "editor", title: "编辑器", section: "文档协作", order: 30 }),
        page({ slug: "about", title: "本手册的来源", section: "附录", order: 40 }),
      ],
      malformed: [],
    };
    const table: Array<[string, string, number, string | null, string | null]> = [
      ["index", "开始使用", 0, null, "first-login"],
      ["first-login", "开始使用", 1, "index", "editor"],
      ["editor", "文档协作", 0, "first-login", "about"],
      ["about", "附录", 0, "editor", null],
    ];
    renderManual({ index: example }, loader({}));
    await waitFor(() => expect(row("index").getAttribute("aria-current")).toBe("page"));
    expect(sections()).toEqual(["开始使用", "文档协作", "附录"]);
    for (const [slug, section, at, prev, next] of table) {
      fireEvent.click(row(slug));
      expect(row(slug).getAttribute("aria-current")).toBe("page");
      const rowsInSection = Array.from(
        tree().querySelectorAll(`[data-manual-section="${section}"] [data-manual-page]`),
      ).map((r) => r.getAttribute("data-manual-page"));
      expect(rowsInSection[at]).toBe(slug);
      expect(prevTarget()).toBe(prev);
      expect(nextTarget()).toBe(next);
      if (prev) expect(prevButton()!.textContent).toContain(example.pages.find((p) => p.slug === prev)!.title);
      else expect(prevButton()).toBeNull();
      if (next) expect(nextButton()!.textContent).toContain(example.pages.find((p) => p.slug === next)!.title);
      else expect(nextButton()).toBeNull();
    }
    // 沿下一页逐页走完整个阅读序。
    fireEvent.click(row("index"));
    for (const expected of ["first-login", "editor", "about"]) {
      fireEvent.click(nextButton()!);
      expect(row(expected).getAttribute("aria-current")).toBe("page");
    }
    expect(nextButton()).toBeNull();
  });

  it("外部添加一页（order 落于既有两页之间）后侧栏于对应位置出现，其余顺序不变", async () => {
    // spec Scenario「外部添加页后侧栏出现」：索引换新（已由 core 依 order 排好）→ 侧栏跟着变。
    const { rerender, loadPage } = renderManual();
    await screen.findByText("欢迎。");
    const inserted: ManualIndex = {
      ...INDEX,
      pages: [
        ...INDEX.pages.slice(0, 2),
        page({ slug: "shortcuts", title: "快捷键", section: "开始使用", order: 25 }),
        ...INDEX.pages.slice(2),
      ],
    };
    rerender(
      <ManualPage index={inserted} loadPage={loadPage} onOpenSpec={vi.fn()} capabilities={[]} />,
    );
    expect(rows()).toEqual(["index", "first-login", "shortcuts", "editor", "about", "orphan", "broken"]);
    expect(row("index").getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("欢迎。")).toBeTruthy();
  });

  it("索引清空（切换 workspace）时丢弃旧内文与选页，新索引到达前只显示骨架", async () => {
    // review R1：手册页开着时切换分页，index 先变 null；新 workspace 的首页 slug 同名
    // （契约规定都叫 index）时，不得把旧 workspace 的内文当成新页显示。
    const gate = deferred<string | null>();
    const calls: string[] = [];
    const loadPage = vi.fn(async (slug: string) => {
      calls.push(slug);
      return calls.length <= 2 ? BODIES[slug] : gate.promise;
    });
    const { rerender } = renderManual({}, loadPage);
    await screen.findByText("欢迎。");
    fireEvent.click(row("editor"));
    await screen.findByText("提示内容");
    rerender(<ManualPage index={null} loadPage={loadPage} onOpenSpec={vi.fn()} capabilities={[]} />);
    expect(screen.queryByText("提示内容")).toBeNull();
    const other: ManualIndex = {
      ...INDEX,
      pages: [
        page({ slug: "index", title: "另一份手册", section: "开始使用", order: 10 }),
        page({ slug: "editor", title: "另一个编辑器", section: "文档协作", order: 20 }),
      ],
      malformed: [],
    };
    rerender(<ManualPage index={other} loadPage={loadPage} onOpenSpec={vi.fn()} capabilities={[]} />);
    // 新 workspace 从首页开始（不沿用旧选页），且旧内文不得出现。
    expect(row("index").getAttribute("aria-current")).toBe("page");
    expect(calls[calls.length - 1]).toBe("index");
    expect(screen.queryByText("提示内容")).toBeNull();
    expect(screen.queryByText("欢迎。")).toBeNull();
    expect(content().querySelector('[aria-busy="true"]')).toBeTruthy();
    gate.resolve("# 另一份手册\n\n新 workspace 内文。");
    await screen.findByText("新 workspace 内文。");
  });

  it("索引清空时，在途的旧加载回应不得写回（切分页瞬间的竞态）", async () => {
    // review R1 第 2 轮残留：切分页当下若 loadPage 在途，回应落地时索引已是 null 或
    // 已换成新 workspace（首页同名 index），旧内文不得写回。
    const old = deferred<string | null>();
    const fresh = deferred<string | null>();
    const loadPage = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const { rerender } = renderManual({}, loadPage);
    expect(loadPage).toHaveBeenCalledTimes(1);
    rerender(<ManualPage index={null} loadPage={loadPage} onOpenSpec={vi.fn()} capabilities={[]} />);
    // 旧回应落在索引为 null 的窗口内。
    old.resolve("# 旧 workspace\n\n旧 workspace 内文。");
    await new Promise((r) => setTimeout(r, 0));
    const other: ManualIndex = {
      ...INDEX,
      pages: [page({ slug: "index", title: "另一份手册", section: "开始使用", order: 10 })],
      malformed: [],
    };
    rerender(<ManualPage index={other} loadPage={loadPage} onOpenSpec={vi.fn()} capabilities={[]} />);
    expect(loadPage).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("旧 workspace 内文。")).toBeNull();
    expect(content().querySelector('[aria-busy="true"]')).toBeTruthy();
    fresh.resolve("# 另一份手册\n\n新 workspace 内文。");
    await screen.findByText("新 workspace 内文。");
  });

  it("坏页与缺栏页点击可开，画面无错误提示", async () => {
    renderManual();
    await screen.findByText("欢迎。");
    fireEvent.click(row("orphan"));
    await screen.findByText("没有字段的页");
    fireEvent.click(row("broken"));
    await screen.findByText("坏页全文");
    expect(screen.queryByText("内文加载失败")).toBeNull();
  });

  it("索引重载后目前页仍在则维持；消失则回首页", async () => {
    const { rerender, loadPage } = renderManual();
    await screen.findByText("欢迎。");
    fireEvent.click(row("editor"));
    await screen.findByText("提示内容");
    const kept = { ...INDEX, pages: INDEX.pages.slice(0, 4) };
    rerender(
      <ManualPage index={kept} loadPage={loadPage} onOpenSpec={vi.fn()} capabilities={[]} />,
    );
    expect(row("editor").getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("提示内容")).toBeTruthy();
    const withoutEditor = { ...INDEX, pages: INDEX.pages.filter((p) => p.slug !== "editor") };
    rerender(
      <ManualPage index={withoutEditor} loadPage={loadPage} onOpenSpec={vi.fn()} capabilities={[]} />,
    );
    await screen.findByText("欢迎。");
    expect(row("index").getAttribute("aria-current")).toBe("page");
  });
});

describe("ManualPage 搜索列", () => {
  it("大小写不敏感比对 title 与 keywords，只留命中页及其分区；清空还原", async () => {
    // spec Scenario「以标题或关键字过滤」。
    renderManual();
    await screen.findByText("欢迎。");
    const input = screen.getByPlaceholderText("搜索手册…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "GitHub" } });
    expect(rows()).toEqual(["first-login"]);
    expect(sections()).toEqual(["开始使用"]);
    fireEvent.change(input, { target: { value: "认识" } });
    expect(rows()).toEqual(["editor"]);
    expect(sections()).toEqual(["文档协作"]);
    fireEvent.change(input, { target: { value: "" } });
    expect(rows()).toEqual(["index", "first-login", "editor", "about", "orphan", "broken"]);
  });

  it("无命中显示无结果文案，内容区维持目前页；搜索不比对内文", async () => {
    // spec Scenario「无命中显示无结果」。
    renderManual();
    await screen.findByText("欢迎。");
    const input = screen.getByPlaceholderText("搜索手册…") as HTMLInputElement;
    // 「欢迎」只出现在内文，不在任何 title／keywords。
    fireEvent.change(input, { target: { value: "欢迎" } });
    expect(rows()).toEqual([]);
    expect(document.querySelector("[data-manual-no-results]")?.textContent).toContain("没有符合的页面");
    expect(screen.getByText("欢迎。")).toBeTruthy();
  });
});

describe("ManualPage 过期与未入册标示", () => {
  it("stale 页列尾为警示色面的「过期」签，其他页无", async () => {
    // spec Scenario「来源更新后标示可能过期」。
    renderManual();
    await screen.findByText("欢迎。");
    const marker = row("first-login").querySelector("[data-manual-stale]") as HTMLElement;
    expect(marker.textContent).toBe("过期");
    expect(marker.className).toContain("rounded-full");
    expect(marker.className).toContain(SEMANTIC_SURFACE.warning);
    expect(marker.className).toContain(SEMANTIC_TONE.warning);
    expect(row("index").querySelector("[data-manual-stale]")).toBeNull();
  });

  it("uncoveredNew 非空时侧栏底部显示计数提示；空时提示缺席", async () => {
    // spec Scenario「生成后添加的规格计入未入册」。
    const { rerender, loadPage } = renderManual();
    await screen.findByText("欢迎。");
    expect(document.querySelector("[data-manual-uncovered]")).toBeNull();
    rerender(
      <ManualPage
        index={{ ...INDEX, uncoveredNew: ["billing", "tray-menu"] }}
        loadPage={loadPage}
        onOpenSpec={vi.fn()}
        capabilities={[]}
      />,
    );
    const hint = document.querySelector("[data-manual-uncovered]") as HTMLElement;
    expect(hint.textContent).toContain("2");
    expect(hint.textContent).toContain("未入册");
  });
});

describe("ManualPage 内页渲染与出处", () => {
  it("出处 capability：正典存在者可点并触发 onOpenSpec，不存在者为纯文本；出处行不重复进内文", async () => {
    // spec Scenario「点出处跳规格页展开」＋「不存在的出处不可点」。
    const { onOpenSpec } = renderManual();
    await screen.findByText("欢迎。");
    fireEvent.click(row("first-login"));
    await screen.findByText("用 GitHub 登录。");
    const sources = document.querySelector("[data-manual-sources]") as HTMLElement;
    const link = within(sources).getByRole("button", { name: "github-oauth" });
    fireEvent.click(link);
    expect(onOpenSpec).toHaveBeenCalledWith("github-oauth");
    expect(within(sources).queryByRole("button", { name: "user-pending-blocked-pages" })).toBeNull();
    expect(sources.textContent).toContain("user-pending-blocked-pages");
    // 内文的 `**出处**：` 行已抽成页脚出处列，不在 Markdown 内重复呈现。
    expect(content().querySelector(".markdown code")).toBeNull();
    expect(onOpenSpec).toHaveBeenCalledTimes(1);
  });

  it("带 Requirement 锚定的 sources：出处列只列井号前的 capability、去重且可点", async () => {
    // manual-pages「frontmatter 六栏」Scenario「带 Requirement 锚定的 sources」：
    // `["desktop-app#看板与任务", "desktop-app#系统匣菜单", policy-config]` → 出处只列 desktop-app 与 policy-config 各一次。
    const index: ManualIndex = {
      ...INDEX,
      pages: [
        ...INDEX.pages,
        page({
          slug: "board",
          title: "看板与任务",
          section: "桌面 app",
          order: 35,
          // 第三项刻意带空白：Rust 读取端接受并回原字符串，前端切完 `#` 也要 trim 才不会多一颗 chip。
          sources: ["desktop-app#看板与任务", "desktop-app#系统匣菜单", " desktop-app # 项目分页 ", "policy-config"],
          generated: "2026-09-05",
        }),
      ],
    };
    const { onOpenSpec } = renderManual(
      { index, capabilities: ["github-oauth", "editor", "desktop-app"] },
      loader({ board: async () => "# 看板与任务\n\n看板。" }),
    );
    await screen.findByText("欢迎。");
    fireEvent.click(row("board"));
    await screen.findByText("看板。");
    const sources = document.querySelector("[data-manual-sources]") as HTMLElement;
    expect(sources.textContent).not.toContain("#");
    expect(within(sources).getAllByText("desktop-app")).toHaveLength(1);
    fireEvent.click(within(sources).getByRole("button", { name: "desktop-app" }));
    expect(onOpenSpec).toHaveBeenCalledWith("desktop-app");
    expect(within(sources).queryByRole("button", { name: "policy-config" })).toBeNull();
    expect(sources.textContent).toContain("policy-config");
    // 阅读卡出处行同样只有一颗可点的 desktop-app、policy-config 为纯文本；数字砖「出处规格」为 2。
    const provenance = docProvenance()!;
    expect(within(provenance).getAllByText("desktop-app")).toHaveLength(1);
    expect(within(provenance).getByRole("button", { name: "desktop-app" })).toBeTruthy();
    expect(within(provenance).queryByRole("button", { name: "policy-config" })).toBeNull();
    expect(provenance.textContent).toContain("policy-config");
    expect(tiles()[3]).toBe("2出处规格");
  });

  it("出处列以索引 sources 为准：内文没有出处行时照样列出", async () => {
    const { onOpenSpec } = renderManual({}, loader({ editor: async () => "# 认识画面\n\n没有出处行。" }));
    await screen.findByText("欢迎。");
    fireEvent.click(row("editor"));
    await screen.findByText("没有出处行。");
    const sources = document.querySelector("[data-manual-sources]") as HTMLElement;
    fireEvent.click(within(sources).getByRole("button", { name: "editor" }));
    expect(onOpenSpec).toHaveBeenCalledWith("editor");
  });

  it("GitHub Alert 在手册内文呈现为提示框、内文在 768px 置中阅读卡内渲染", async () => {
    renderManual();
    await screen.findByText("欢迎。");
    fireEvent.click(row("editor"));
    await screen.findByText("提示内容");
    expect(content().querySelector(".markdown-alert-note")).toBeTruthy();
    const body = content().querySelector("[data-manual-body]") as HTMLElement;
    expect(body.querySelector(".max-w-\\[768px\\]")).toBeTruthy();
    // 内文包在白底阅读卡内（design D5）。
    const readingCard = body.querySelector("[data-manual-card]") as HTMLElement;
    expect(readingCard.className).toContain("bg-card");
    expect(readingCard.contains(body.querySelector(".markdown")!)).toBe(true);
  });

  it("标题在阅读卡标题区、卷动区外无页眉、底列固定、内文不重复 H1、无 H1 时退回索引 title", async () => {
    renderManual();
    await screen.findByText("欢迎。");
    const body = content().querySelector("[data-manual-body]") as HTMLElement;
    const card = body.querySelector("[data-manual-card]") as HTMLElement;
    const footer = content().querySelector("[data-manual-footer]") as HTMLElement;
    expect(card.contains(docHeader())).toBe(true);
    expect(within(docHeader()).getByRole("heading", { level: 2 }).textContent).toBe("手册");
    expect(content().querySelector("h1")).toBeNull();
    // 卷动区外只剩固定底列：没有页眉。
    expect(Array.from(body.parentElement!.children)).toEqual([body, footer]);
    expect(body.contains(footer)).toBe(false);
    expect(footer.contains(nextButton()!)).toBe(true);
    fireEvent.click(row("first-login"));
    await screen.findByText("用 GitHub 登录。");
    expect(footer.contains(document.querySelector("[data-manual-sources]")!)).toBe(true);
    fireEvent.click(row("orphan"));
    await screen.findByText("没有字段的页");
    expect(within(docHeader()).getByRole("heading", { level: 2 }).textContent).toBe("orphan");
  });

  it("右侧锚点列列出内文 h2／h3、首项为目前段；点击卷至该标题；无标题时锚点列缺席", async () => {
    // spyOn＋finally 还原：全域 prototype 覆写不得外溢到同档后续测试。
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    try {
      renderManual(
        {},
        loader({
          editor: async () => "# 认识画面\n\n## 看板\n\n段一。\n\n### 卡片\n\n段二。\n\n## 抽屉\n\n段三。",
        }),
      );
      await screen.findByText("欢迎。");
      expect(document.querySelector("[data-manual-toc]")).toBeNull();
      fireEvent.click(row("editor"));
      await screen.findByText("段一。");
      const toc = await waitFor(() => {
        const el = document.querySelector("[data-manual-toc]") as HTMLElement;
        expect(el).toBeTruthy();
        return el;
      });
      expect(toc.className).toContain("w-[200px]");
      const anchors = Array.from(toc.querySelectorAll("[data-manual-anchor]"));
      expect(anchors.map((a) => a.textContent)).toEqual(["看板", "卡片", "抽屉"]);
      expect(anchors[0].getAttribute("aria-current")).toBe("location");
      expect(anchors[2].getAttribute("aria-current")).toBeNull();
      fireEvent.click(anchors[2]);
      expect(scrollSpy).toHaveBeenCalledTimes(1);
      expect((scrollSpy.mock.contexts[0] as HTMLElement).textContent).toBe("抽屉");
      // 切到无 h2／h3 的页：锚点列消失。
      fireEvent.click(row("about"));
      await screen.findByText("取材范围。");
      await waitFor(() => expect(document.querySelector("[data-manual-toc]")).toBeNull());
    } finally {
      scrollSpy.mockRestore();
    }
  });

  it("内文的相对文档名链接在手册内切页；连到不存在的页只挡下导航", async () => {
    // manual-pages 契约「内文惯例」跨页链接为相对文档名；WebView 直接导航会整页离开 app。
    renderManual({}, loader({ index: async () => "# 手册\n\n看[认识画面](editor.md)与[失联](nope.md)。" }));
    const good = await screen.findByRole("link", { name: "认识画面" });
    // fireEvent 回传 false＝preventDefault 已调用（导航被挡下）。
    expect(fireEvent.click(good)).toBe(false);
    await screen.findByText("提示内容");
    expect(row("editor").getAttribute("aria-current")).toBe("page");
    fireEvent.click(row("index"));
    const bad = await screen.findByRole("link", { name: "失联" });
    expect(fireEvent.click(bad)).toBe(false);
    expect(row("index").getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "认识画面" })).toBeTruthy();
  });

  it("内文加载失败显示失败文案，侧栏照常、其他页仍可开", async () => {
    // spec Scenario「内文加载失败」。
    renderManual({}, loader({ editor: () => Promise.reject(new Error("io")) }));
    await screen.findByText("欢迎。");
    fireEvent.click(row("editor"));
    await screen.findByText("内文加载失败");
    expect(content().querySelector("[data-manual-load-failed]")).toBeTruthy();
    expect(rows().length).toBe(6);
    fireEvent.click(row("about"));
    await screen.findByText("取材范围。");
    expect(screen.queryByText("内文加载失败")).toBeNull();
  });

  it("加载中以 skeleton 占位", async () => {
    const gate = deferred<string | null>();
    renderManual({}, loader({ index: () => gate.promise }));
    expect(content().querySelector('[aria-busy="true"]')).toBeTruthy();
    gate.resolve("# 手册\n\n欢迎。");
    await screen.findByText("欢迎。");
    expect(content().querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("refreshGen 变动重载目前页；交错回应以最新为准", async () => {
    // spec「手册页随外部变更即时更新」的组件半边：外部重生一页后内容更新。
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    let call = 0;
    const loadPage = vi.fn(async () => (call++ === 0 ? first.promise : second.promise));
    const { rerender } = renderManual({ refreshGen: 1 }, loadPage);
    expect(loadPage).toHaveBeenCalledTimes(1);
    rerender(
      <ManualPage index={INDEX} loadPage={loadPage} onOpenSpec={vi.fn()} capabilities={[]} refreshGen={2} />,
    );
    await waitFor(() => expect(loadPage).toHaveBeenCalledTimes(2));
    second.resolve("最新内文");
    await screen.findByText("最新内文");
    first.resolve("过时内文");
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("过时内文")).toBeNull();
    expect(screen.getByText("最新内文")).toBeTruthy();
  });
});

describe("ManualPage React key", () => {
  it("明写 section「其他」与缺 section 的组不相邻、索引 sources 重复列名时，不产生 React key 警告", async () => {
    // review R4：分区以位置为 key、出处名去重（出处列以索引 sources 为单一真相）。
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const index: ManualIndex = {
      ...INDEX,
      pages: [
        page({ slug: "misc", title: "杂项", section: "其他", order: 10, sources: ["github-oauth", "github-oauth"] }),
        page({ slug: "index", title: "手册", section: "开始使用", order: 20 }),
        page({ slug: "orphan" }),
      ],
      malformed: [],
    };
    renderManual(
      { index },
      loader({ misc: async () => "# 杂项\n\n内文。\n\n**出处**：`github-oauth`、`github-oauth`" }),
    );
    await screen.findByText("内文。");
    expect(sections()).toEqual(["其他", "开始使用", "其他"]);
    const sources = document.querySelector("[data-manual-sources]") as HTMLElement;
    expect(within(sources).getAllByRole("button", { name: "github-oauth" })).toHaveLength(1);
    expect(errors.mock.calls.filter((c) => String(c[0]).includes("key"))).toEqual([]);
    errors.mockRestore();
  });
});

describe("ManualPage 空状态", () => {
  it("索引加载中显示骨架", () => {
    renderManual({ index: null });
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(document.querySelector("[data-manual-tree]")).toBeNull();
  });

  it("present false 显示尚无手册的空状态（可用手册技能生成）", () => {
    // spec Scenario「无手册目录」。
    const { loadPage } = renderManual({
      index: { present: false, reason: null, pages: [], uncoveredNew: [], malformed: [] },
    });
    expect(screen.getByText("尚无手册")).toBeTruthy();
    expect(screen.getByText(/手册技能/)).toBeTruthy();
    expect(document.querySelector("[data-manual-empty]")?.getAttribute("data-manual-empty")).toBe("none");
    expect(document.querySelector("[data-manual-tree]")).toBeNull();
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("reason remote 显示 remote 模式尚不支持手册的空状态", () => {
    // spec Scenario「remote 分页」。
    const { loadPage } = renderManual({
      index: { present: false, reason: "remote", pages: [], uncoveredNew: [], malformed: [] },
    });
    expect(screen.getByText("remote 模式尚不支持手册")).toBeTruthy();
    expect(document.querySelector("[data-manual-empty]")?.getAttribute("data-manual-empty")).toBe("remote");
    expect(loadPage).not.toHaveBeenCalled();
  });
});

// spec desktop-manual-page「内页渲染与出处跳规格」（desktop-list-pages-reskin design D5）：
// 三栏宽度（240／768 置中／200）、页眉 24px 标题与产生时间行、白底上缘细线的固定底列
// 对齐 768px、出处签与带目标页标题的上一页／下一页框线钮。
describe("ManualPage 三栏版面与固定底列", () => {
  it("目录树容器为 240px 淡灰底；页列与文档树节点同款（30px、圆角、hover 淡底、作用中主色淡底与主色字）", async () => {
    renderManual();
    await screen.findByText("欢迎。");
    const aside = tree().closest("aside") as HTMLElement;
    expect(aside.className).toContain("w-60");
    expect(aside.className).toContain("bg-sidebar");
    // 同款＝直接共用文档树节点的 class；作用中与否只看 data-state。
    for (const slug of ["index", "first-login"]) expect(row(slug).className).toBe(TREE_NODE_CLS);
    expect(TREE_NODE_CLS).toContain("h-[30px]");
    expect(TREE_NODE_CLS).toContain("hover:bg-foreground/5");
    expect(TREE_NODE_CLS).toContain("data-[state=active]:bg-primary/12");
    expect(row("index").getAttribute("data-state")).toBe("active");
    expect(row("index").getAttribute("aria-current")).toBe("page");
    expect(row("first-login").getAttribute("data-state")).toBe("inactive");
    // 树的搜索框为全圆。
    expect(screen.getByPlaceholderText("搜索手册…").className).toContain("rounded-full");
  });

  it("阅读卡标题为 24px 一般字重；出处行为灰字路径与「产生于 {generated}」；generated 缺席时该段缺席", async () => {
    renderManual();
    await screen.findByText("欢迎。");
    const title = within(docHeader()).getByRole("heading", { level: 2 });
    expect(title.className).toContain("text-2xl");
    expect(title.className).toContain("font-normal");
    expect(docProvenance()!.className).toContain("text-muted-foreground");
    expect(docProvenance()!.textContent).toBe("openspec/manual/index.md·产生于 2026-09-01");
    expect(docProvenance()!.querySelector("[data-manual-generated]")).toBeTruthy();
    fireEvent.click(row("about"));
    await screen.findByText("取材范围。");
    expect(docProvenance()!.textContent).toBe("openspec/manual/about.md");
    expect(content().querySelector("[data-manual-generated]")).toBeNull();
  });

  it("底列固定：白底、上缘细线、内容对齐 768px；左出处签为框线签、右为带小字标签与目标页标题的框线钮", async () => {
    renderManual();
    await screen.findByText("欢迎。");
    fireEvent.click(row("first-login"));
    await screen.findByText("用 GitHub 登录。");
    const footer = content().querySelector("[data-manual-footer]") as HTMLElement;
    expect(footer.className).toContain("bg-card");
    expect(footer.className).toContain("border-t");
    expect(footer.className).toContain("shrink-0");
    expect(footer.querySelector(".max-w-\\[768px\\]")).toBeTruthy();
    // 出处签：存在者为可点 button 的框线签（等宽字）、不存在者纯文本。
    const sources = footer.querySelector("[data-manual-sources]") as HTMLElement;
    const chip = within(sources).getByRole("button", { name: "github-oauth" });
    expect(chip.className).toContain("font-mono");
    expect(chip.className).toContain("border");
    expect(within(sources).queryByRole("button", { name: "user-pending-blocked-pages" })).toBeNull();
    // 上一页／下一页：框线钮、小字标签＋目标页标题；无障碍名称维持「上一页」「下一页」。
    const prev = prevButton()!;
    const next = nextButton()!;
    expect(footer.contains(prev)).toBe(true);
    expect(prev.className).toContain("border");
    expect(prev.textContent).toContain("上一页");
    expect(prev.textContent).toContain("手册");
    expect(next.textContent).toContain("下一页");
    expect(next.textContent).toContain("认识画面");
    expect(prevTarget()).toBe("index");
    expect(nextTarget()).toBe("editor");
  });
});

describe("countHeadings", () => {
  it("只数围栏外的 ATX h2／h3", () => {
    const md = [
      "# 页标题",
      "## 原生菜单",
      "### 变更列",
      "#### 更深一层",
      "  ### 缩进三格内仍是标题",
      "##没有空白不是标题",
      "```md",
      "## 围栏内",
      "### 围栏内",
      "```",
      "Setext 标题",
      "---",
      "## 分区太长时 ##",
      "###",
    ].join("\n");
    expect(countHeadings(md)).toEqual({ h2: 2, h3: 3 });
  });

  it("空内文为 0", () => {
    expect(countHeadings("")).toEqual({ h2: 0, h3: 0 });
  });
});

/** 〈系统匣菜单〉（Scenario「阅读卡标题区、出处行与数字砖」）：3 个 h2、11 个 h3、7 个关键字、1 个出处。 */
const TRAY_PAGE = page({
  slug: "tray",
  title: "系统匣菜单",
  section: "桌面 app",
  order: 360,
  keywords: ["系统匣", "菜单列", "面板", "进度", "拷贝名称", "拷贝 slug", "保留在途"],
  sources: ["tray-status-menu"],
  generated: "2026-09-17T16:05:41+08:00",
});
const TRAY_BODY = [
  "# 系统匣菜单",
  "开头。",
  "## 原生菜单（Windows、Linux）",
  ...["变更列", "讨论列", "项目切换", "动作区"].map((h) => `### ${h}`),
  "## 面板（macOS）",
  ...["项目分页条", "内容区", "品质关卡章", "remote 项目", "加载中", "鼠标操作", "创建失败"].map((h) => `### ${h}`),
  "```md",
  "## 围栏内不算",
  "```",
  "## 分区太长时",
  "**出处**：`tray-status-menu`",
].join("\n\n");

/** 规格 x：最近的 @trace 为 2026-09-05（change-x），另一条较旧。 */
const X_SPEC = [
  "# x Specification",
  "## Purpose",
  "x。",
  "## Requirements",
  "### Requirement: 甲",
  "甲 SHALL 做事。",
  "<!-- @trace\nsource: change-old\nupdated: 2026-08-01\n-->",
  "### Requirement: 乙",
  "乙 SHALL 做事。",
  "<!-- @trace\nsource: change-x\nupdated: 2026-09-05T10:00:00+08:00\n-->",
].join("\n\n");

const STALE_INDEX: ManualIndex = {
  present: true,
  reason: null,
  pages: [
    page({ slug: "stale-page", title: "过期页", section: "开始使用", order: 10, sources: ["x"], generated: "2026-09-01", stale: true }),
    page({ slug: "fresh", title: "新鲜页", section: "开始使用", order: 20, sources: ["y"], generated: "2026-09-01" }),
  ],
  uncoveredNew: [],
  malformed: [],
};
const STALE_BODIES = { "stale-page": async () => "# 过期页\n\n过期内文。", fresh: async () => "# 新鲜页\n\n新鲜内文。" };

describe("ManualPage 阅读卡标题区、出处行、数字砖与提示框", () => {
  it("〈系统匣菜单〉数据：分区签、出处行三段、四格砖 3／11／7／1", async () => {
    const { onOpenSpec } = renderManual(
      { index: { ...INDEX, pages: [TRAY_PAGE] }, capabilities: ["tray-status-menu"] },
      loader({ tray: async () => TRAY_BODY }),
    );
    await screen.findByText("开头。");
    expect(within(docHeader()).getByRole("heading", { level: 2 }).textContent).toBe("系统匣菜单");
    expect(docHeader().querySelector("[data-doc-badges]")!.textContent).toBe("桌面 app");
    expect(content().querySelector("[data-manual-stale-pill]")).toBeNull();
    expect(docProvenance()!.textContent).toBe("openspec/manual/tray.md·产生于 2026-09-17T16:05:41+08:00·出处tray-status-menu");
    fireEvent.click(within(docProvenance()!).getByRole("button", { name: "tray-status-menu" }));
    expect(onOpenSpec).toHaveBeenCalledWith("tray-status-menu");
    expect(tiles()).toEqual(["3章节", "11小节", "7关键字", "1出处规格"]);
    expect(staleCallout()).toBeNull();
  });

  it("出处行的路径取 core 解析的实际位置：改过 spec 目录名时照实显示；没有可定位的文档时不列路径", async () => {
    const locateDocument = vi.fn(async () => ({ relative: "docs/specs/manual/tray.md" }));
    const view = renderManual(
      { index: { ...INDEX, pages: [TRAY_PAGE] }, capabilities: ["tray-status-menu"], locateDocument },
      loader({ tray: async () => TRAY_BODY }),
    );
    await screen.findByText("开头。");
    await waitFor(() =>
      expect(docProvenance()!.textContent).toBe("docs/specs/manual/tray.md·产生于 2026-09-17T16:05:41+08:00·出处tray-status-menu"),
    );
    expect(locateDocument).toHaveBeenCalledWith({ manual: "tray" });
    view.unmount();
    renderManual(
      { index: { ...INDEX, pages: [TRAY_PAGE] }, capabilities: ["tray-status-menu"], locateDocument: undefined },
      loader({ tray: async () => TRAY_BODY }),
    );
    await screen.findByText("开头。");
    expect(docProvenance()!.textContent).toBe("产生于 2026-09-17T16:05:41+08:00·出处tray-status-menu");
  });

  it("切换项目后同名页的出处行不沿用前一个项目的路径：新位置查到前该段缺席", async () => {
    const gate = deferred<{ relative: string } | null>();
    let call = 0;
    const locateDocument = vi.fn(() => (call++ === 0 ? Promise.resolve({ relative: "a/manual/index.md" }) : gate.promise));
    const props = { onOpenSpec: vi.fn(), capabilities: [], loadPage: loader(), locateDocument };
    const { rerender } = render(<ManualPage index={INDEX} {...props} />);
    await screen.findByText("欢迎。");
    await waitFor(() => expect(docProvenance()!.textContent).toContain("a/manual/index.md"));
    rerender(<ManualPage index={null} {...props} />);
    rerender(<ManualPage index={INDEX} {...props} />);
    await screen.findByText("欢迎。");
    await waitFor(() => expect(locateDocument).toHaveBeenCalledTimes(2));
    expect(docProvenance()!.textContent).not.toContain("a/manual");
    gate.resolve({ relative: "b/manual/index.md" });
    await waitFor(() => expect(docProvenance()!.textContent).toContain("b/manual/index.md"));
  });

  it("缺 section 的页分区签为「其他」", async () => {
    renderManual();
    await screen.findByText("欢迎。");
    fireEvent.click(row("orphan"));
    await screen.findByText("没有字段的页");
    expect(docHeader().querySelector("[data-doc-badges]")!.textContent).toBe("其他");
  });

  it("stale 页：签槽「可能过期」签、提示框列出出处的最近 @trace 与「本页产生于」；非 stale 页无签无提示框", async () => {
    const loadSpec = vi.fn(async (cap: string) => (cap === "x" ? X_SPEC : null));
    renderManual({ index: STALE_INDEX, capabilities: ["x", "y"], loadSpec }, loader(STALE_BODIES));
    await screen.findByText("过期内文。");
    expect(docHeader().querySelector("[data-manual-stale-pill]")!.textContent).toBe("可能过期");
    await waitFor(() => expect(staleCallout()!.textContent).toContain("出处 x 于 2026-09-05 由变更 change-x 更新"));
    expect(loadSpec).toHaveBeenCalledWith("x");
    expect(staleCallout()!.textContent).toContain("本页产生于 2026-09-01");
    expect(staleCallout()!.textContent).toContain("/specseal-manual");
    // 提示框在数字砖与内文之间。
    const slot = content().querySelector("[data-doc-callout]") as HTMLElement;
    expect(slot.contains(staleCallout())).toBe(true);
    const order = [content().querySelector("[data-doc-tiles]")!, slot, content().querySelector("[data-doc-body]")!];
    expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1].compareDocumentPosition(order[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(row("fresh"));
    await screen.findByText("新鲜内文。");
    expect(content().querySelector("[data-manual-stale-pill]")).toBeNull();
    expect(staleCallout()).toBeNull();
    expect(loadSpec).not.toHaveBeenCalledWith("y");
  });

  it("loadSpec reject 或规格无 @trace 时该行为「在本页产生后更新过」，签照常", async () => {
    const noTrace = "# x Specification\n\n## Requirements\n\n### Requirement: 甲\n\n甲 SHALL 做事。";
    const cases: [string, () => Promise<string | null>][] = [
      ["reject", () => Promise.reject(new Error("io"))],
      ["缺件", async () => null],
      ["无 @trace", async () => noTrace],
    ];
    for (const [, read] of cases) {
      const view = renderManual({ index: STALE_INDEX, capabilities: ["x"], loadSpec: vi.fn(read) }, loader(STALE_BODIES));
      await screen.findByText("过期内文。");
      await waitFor(() => expect(staleCallout()!.textContent).toContain("出处 x 在本页产生后更新过"));
      expect(staleCallout()!.textContent).not.toContain("由变更");
      expect(docHeader().querySelector("[data-manual-stale-pill]")).toBeTruthy();
      view.unmount();
    }
  });

  it("切换项目后同名的过期页不沿用前一个项目的出处日期：新规格读完前提示框不出现", async () => {
    const gate = deferred<string | null>();
    let call = 0;
    const loadSpec = vi.fn(() => (call++ === 0 ? Promise.resolve(X_SPEC) : gate.promise));
    const props = { onOpenSpec: vi.fn(), capabilities: ["x"], loadSpec, loadPage: loader(STALE_BODIES) };
    const { rerender } = render(<ManualPage index={STALE_INDEX} {...props} />);
    await waitFor(() => expect(staleCallout()!.textContent).toContain("由变更 change-x 更新"));
    rerender(<ManualPage index={null} {...props} />);
    rerender(<ManualPage index={STALE_INDEX} {...props} />);
    await screen.findByText("过期内文。");
    await waitFor(() => expect(loadSpec).toHaveBeenCalledTimes(2));
    expect(staleCallout()).toBeNull();
    gate.resolve(X_SPEC.replace("source: change-x", "source: change-b"));
    await waitFor(() => expect(staleCallout()!.textContent).toContain("由变更 change-b 更新"));
    expect(staleCallout()!.textContent).not.toContain("change-x");
  });

  it("换页作废在途的规格读取：晚到的旧回应不覆盖最新一次", async () => {
    const reads = [deferred<string | null>(), deferred<string | null>()];
    let call = 0;
    const loadSpec = vi.fn(() => reads[call++].promise);
    renderManual({ index: STALE_INDEX, capabilities: ["x", "y"], loadSpec }, loader(STALE_BODIES));
    await screen.findByText("过期内文。");
    // 过期页 → 新鲜页 → 过期页：第一次读取在途时就换页。
    fireEvent.click(row("fresh"));
    await screen.findByText("新鲜内文。");
    fireEvent.click(row("stale-page"));
    await screen.findByText("过期内文。");
    await waitFor(() => expect(loadSpec).toHaveBeenCalledTimes(2));
    reads[1].resolve(X_SPEC);
    await waitFor(() => expect(staleCallout()!.textContent).toContain("由变更 change-x 更新"));
    reads[0].resolve(X_SPEC.replace("source: change-x", "source: change-late").replace("2026-09-05T10:00:00+08:00", "2026-12-01"));
    await new Promise((r) => setTimeout(r, 0));
    expect(staleCallout()!.textContent).toContain("由变更 change-x 更新");
    expect(staleCallout()!.textContent).not.toContain("change-late");
  });

  it("renderDocumentActions 收到 { manual: slug } 与已加载原文并渲染在标题列；未传时无动作", async () => {
    const renderDocumentActions = vi.fn(() => <button type="button">打开 ▾</button>);
    const view = renderManual({ renderDocumentActions });
    await screen.findByText("欢迎。");
    expect(renderDocumentActions).toHaveBeenLastCalledWith({ doc: { manual: "index" }, content: BODIES.index });
    expect(within(docHeader()).getByRole("button", { name: "打开 ▾" })).toBeTruthy();
    view.unmount();
    renderManual();
    await screen.findByText("欢迎。");
    expect(within(docHeader()).queryByRole("button", { name: "打开 ▾" })).toBeNull();
  });

  it("加载失败时无砖无提示框，签照常", async () => {
    const loadSpec = vi.fn(async () => X_SPEC);
    renderManual(
      { index: STALE_INDEX, capabilities: ["x"], loadSpec },
      loader({ "stale-page": () => Promise.reject(new Error("io")) }),
    );
    await screen.findByText("内文加载失败");
    expect(content().querySelector("[data-doc-tiles]")).toBeNull();
    expect(staleCallout()).toBeNull();
    expect(docHeader().querySelector("[data-manual-stale-pill]")).toBeTruthy();
  });

  it("DocBody 容器 class 含 15px 与 h2／h3 覆盖", async () => {
    renderManual();
    await screen.findByText("欢迎。");
    const body = content().querySelector("[data-manual-card] [data-doc-body]") as HTMLElement;
    expect(body.className).toContain("text-[15px]");
    expect(body.className).toContain("leading-[1.75]");
    const wrapper = body.parentElement as HTMLElement;
    expect(wrapper.className).toContain("[&_.markdown_h2]:text-base");
    expect(wrapper.className).toContain("[&_.markdown_h2]:font-semibold");
    expect(wrapper.className).toContain("[&_.markdown_h3]:text-sm");
    expect(wrapper.className).toContain("[&_.markdown_h3]:font-semibold");
    expect(body.textContent).toContain("欢迎。");
  });
});

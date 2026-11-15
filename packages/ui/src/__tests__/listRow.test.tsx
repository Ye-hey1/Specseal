// 共用列、列表卡与搜索框（desktop-list-pages-reskin design D1、D3）：规格页与已封存
// 页三种列共用 ListRow（整列可点、标题＋hover 拷贝钮、描述列、meta 槽、› 收尾、
// Enter／Space 触发、拷贝不冒泡）；ListCard 的 header／footer 落点与内容卷动容器；
// SearchField 为全圆 280px 搜索框。
import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, fireEvent, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";
import { ListRow } from "../components/ListRow";
import { ListCard } from "../components/ListCard";
import { SearchField } from "../components/SearchField";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

const row = () => document.querySelector("[data-row]") as HTMLElement;

describe("ListRow（共用列）", () => {
  it("disabled：aria-disabled、不可聚焦、无 ›，点击与 Enter 都不触发", () => {
    const onClick = vi.fn();
    render(<ListRow data-row="a" title="gone-change" description="无封存记录" disabled onClick={onClick} />);
    const el = row();
    expect(el.getAttribute("aria-disabled")).toBe("true");
    expect(el.getAttribute("tabindex")).toBe("-1");
    expect(el.className).not.toContain("cursor-(--cursor-interaction)");
    expect(el.querySelector(".lucide-chevron-right")).toBeNull();
    fireEvent.click(el);
    fireEvent.keyDown(el, { key: "Enter" });
    expect(onClick).not.toHaveBeenCalled();
  });

  it("渲染等宽标题、描述列、meta 槽、leading 槽与 › 收尾；整列可点且可聚焦", () => {
    const onClick = vi.fn();
    render(
      <ListRow
        data-row="a"
        title="desktop-app"
        description="桌面 app 的行为契约。"
        leading={<span data-lead>2026-07-08</span>}
        meta={<span data-meta>7</span>}
        onClick={onClick}
      />,
    );
    const el = row();
    expect(el.getAttribute("role")).toBe("button");
    expect(el.getAttribute("tabindex")).toBe("0");
    // 朗读名称只取标题（不把描述、meta 串进来）；键盘聚焦有明显外框。
    expect(screen.getByRole("button", { name: "desktop-app" })).toBe(el);
    expect(el.className).toContain("focus-visible:ring-2");
    // 滑过淡底与文档树节点、收合列同深度。
    expect(el.className).toContain("cursor-(--cursor-interaction)");
    expect(el.className).toContain("hover:bg-foreground/5");
    // 标题等宽强调、一行截断；与拷贝钮同属标题群组。
    const title = within(el).getByText("desktop-app");
    expect(title.className).toContain("font-mono");
    expect(title.className).toContain("truncate");
    expect(el.querySelector("[data-title-group]")!.contains(title)).toBe(true);
    // 描述列一行截断。
    const desc = el.querySelector("[data-desc]") as HTMLElement;
    expect(desc.textContent).toBe("桌面 app 的行为契约。");
    expect(desc.className).toContain("truncate");
    // leading 在最左、meta 在右端、› 收尾。
    expect(el.firstElementChild!.querySelector("[data-lead]")).toBeTruthy();
    expect(el.querySelector("[data-meta]")).toBeTruthy();
    expect(el.lastElementChild!.classList.contains("lucide-chevron-right")).toBe(true);
    fireEvent.click(el);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("无描述时描述列缺席、列退回单行", () => {
    render(<ListRow data-row="b" title="bare" onClick={() => {}} />);
    expect(row().querySelector("[data-desc]")).toBeNull();
  });

  it("Enter 与 Space 触发 onClick；其他键不触发", () => {
    const onClick = vi.fn();
    render(<ListRow data-row="c" title="k" onClick={onClick} />);
    fireEvent.keyDown(row(), { key: "Enter" });
    fireEvent.keyDown(row(), { key: " " });
    fireEvent.keyDown(row(), { key: "a" });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("拷贝钮 hover 才显现，点击写入 copy.value 且不触发 onClick；Enter 在拷贝钮上也不开列", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onClick = vi.fn();
    render(
      <ListRow data-row="d" title="old-topic" copy={{ value: "old-topic", label: "拷贝 slug" }} onClick={onClick} />,
    );
    const copyBtn = within(row()).getByLabelText("拷贝 slug");
    expect(copyBtn.className).toContain("opacity-0");
    expect(copyBtn.className).toContain("group-hover:opacity-100");
    fireEvent.click(copyBtn);
    expect(writeText).toHaveBeenCalledWith("old-topic");
    fireEvent.keyDown(copyBtn, { key: "Enter" });
    expect(onClick).not.toHaveBeenCalled();
  });

  it("未给 copy 时无拷贝钮；children 落在标题旁", () => {
    render(
      <ListRow data-row="e" title="t" onClick={() => {}}>
        <span data-stamp>章</span>
      </ListRow>,
    );
    expect(within(row()).queryByRole("button", { name: /拷贝/ })).toBeNull();
    expect(row().querySelector("[data-title-group] [data-stamp]")).toBeTruthy();
  });

  it("拷贝钮紧跟标题、children（章）排在拷贝钮之后（spec「规格与封存卡片收合信息」；与看板讨论卡同序）", () => {
    render(
      <ListRow data-row="f" title="old-topic" copy={{ value: "old-topic", label: "拷贝 slug" }} onClick={() => {}}>
        <span data-stamp>章</span>
      </ListRow>,
    );
    const group = row().querySelector("[data-title-group]") as HTMLElement;
    const title = within(group).getByText("old-topic");
    const copyBtn = within(group).getByLabelText("拷贝 slug");
    const stamp = group.querySelector("[data-stamp]") as HTMLElement;
    // 文档顺序：标题 → 拷贝钮 → 章。
    expect(title.compareDocumentPosition(copyBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(copyBtn.compareDocumentPosition(stamp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // server-web-list-pages design D1：不给 onClick 是静态列（凭证列、邀请列、窄屏幕稽核列）。
  it("不给 onClick：没有 role=button 与 tabindex、没有 ›、没有 hover 底色与手指光标，点击与按 Enter 无作用", () => {
    render(<ListRow data-row="s" title="CI 密钥" description="slk_ab12 · 用户 u1" meta={<span data-meta>有效</span>} />);
    const el = row();
    expect(el.getAttribute("role")).toBeNull();
    expect(el.getAttribute("tabindex")).toBeNull();
    expect(el.querySelector(".lucide-chevron-right")).toBeNull();
    expect(el.className).not.toContain("hover:bg-foreground/5");
    expect(el.className).not.toContain("cursor-(--cursor-interaction)");
    // 版面不变：描述与 meta 照旧。
    expect((el.querySelector("[data-desc]") as HTMLElement).textContent).toBe("slk_ab12 · 用户 u1");
    expect(el.querySelector("[data-meta]")).toBeTruthy();
    fireEvent.click(el);
    fireEvent.keyDown(el, { key: "Enter" });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("mono={false} 时标题改一般字（仍 14px semibold）；未给时照旧等宽", () => {
    render(<ListRow data-row="m" title="王小明" mono={false} onClick={() => {}} />);
    const title = within(row()).getByText("王小明");
    expect(title.className).not.toContain("font-mono");
    expect(title.className).toContain("text-sm");
    expect(title.className).toContain("font-semibold");
  });

  it("静态列的 actions 槽在 meta 之后、列的最后；槽内按钮照常可按", () => {
    const onRevoke = vi.fn();
    render(
      <ListRow data-row="x" title="t" meta={<span data-meta>m</span>} actions={<button onClick={onRevoke}>撤销</button>} />,
    );
    const btn = within(row()).getByRole("button", { name: "撤销" });
    const meta = row().querySelector("[data-meta]") as HTMLElement;
    expect(meta.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row().lastElementChild!.contains(btn)).toBe(true);
    fireEvent.click(btn);
    expect(onRevoke).toHaveBeenCalledTimes(1);
  });

  // actions 只给静态列：可点的列是 role=button，槽内再放按钮就成了嵌套交互元素（axe nested-interactive）。
  // 类型挡下两者并用；这个函数不会运行，只让 tsc 确认挡得住。
  it("actions 与 onClick 在类型上互斥", () => {
    const misuse = () => (
      // @ts-expect-error actions 只给不带 onClick 的静态列
      <ListRow title="t" onClick={() => {}} actions={<button>撤销</button>} />
    );
    expect(typeof misuse).toBe("function");
  });

  it("actions 为 false 或 null（`有效 && <钮 />` 的写法）时不留空的动作槽", () => {
    const { unmount } = render(<ListRow data-row="y" title="t" meta={<span data-meta>m</span>} actions={false} />);
    expect(row().lastElementChild!.querySelector("[data-meta]")).toBeTruthy();
    unmount();
    render(<ListRow data-row="z" title="t" meta={<span data-meta>m</span>} actions={null} />);
    expect(row().lastElementChild!.querySelector("[data-meta]")).toBeTruthy();
  });
});

describe("ListCard（列表卡）", () => {
  it("header 在顶部、children 在 data-list-scroll 卷动容器内、footer 在卷动容器外的底部", () => {
    render(
      <ListCard header={<div data-head>头</div>} footer={<div data-foot>脚</div>}>
        <div data-body>列</div>
      </ListCard>,
    );
    const scroll = document.querySelector("[data-list-scroll]") as HTMLElement;
    expect(scroll.className).toContain("overflow-y-auto");
    expect(scroll.className).toContain("flex-1");
    expect(scroll.className).toContain("min-h-0");
    expect(scroll.querySelector("[data-body]")).toBeTruthy();
    const head = document.querySelector("[data-head]") as HTMLElement;
    const foot = document.querySelector("[data-foot]") as HTMLElement;
    expect(scroll.contains(head)).toBe(false);
    expect(scroll.contains(foot)).toBe(false);
    // 文档顺序：header → 卷动容器 → footer。
    expect(head.compareDocumentPosition(scroll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(scroll.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 有 header 时内容卡以 rounded-t-none border-t-0 接在分页列下（Tabs card variant 接法）。
    const card = document.querySelector("[data-list-card]") as HTMLElement;
    expect(card.className).toContain("rounded-t-none");
    expect(card.className).toContain("border-t-0");
    expect(card.contains(head)).toBe(false);
    expect(card.contains(foot)).toBe(true);
    // footer 槽本身不画分隔线：分隔线属工具列（ListPager），工具列回 null 时卡底不留空线。
    expect((document.querySelector("[data-list-footer]") as HTMLElement).className).not.toContain("border-t");
  });

  it("无 header 时内容卡维持完整圆角；无 footer 时底列缺席", () => {
    render(
      <ListCard>
        <div>列</div>
      </ListCard>,
    );
    const card = document.querySelector("[data-list-card]") as HTMLElement;
    expect(card.className).toContain("rounded-2xl");
    expect(card.className).not.toContain("rounded-t-none");
    expect(document.querySelector("[data-list-footer]")).toBeNull();
  });

  it("scrollRef 指向卷动容器", () => {
    const ref = { current: null as HTMLDivElement | null };
    render(
      <ListCard scrollRef={ref}>
        <div>列</div>
      </ListCard>,
    );
    expect(ref.current).toBe(document.querySelector("[data-list-scroll]"));
  });
});

describe("SearchField（全圆搜索框）", () => {
  it("输入框 class 含 rounded-full 与 280px 宽，带搜索图标；输入以字符串回呼 onChange", () => {
    const onChange = vi.fn();
    render(<SearchField value="" onChange={onChange} placeholder="搜索规格…" />);
    const input = screen.getByPlaceholderText("搜索规格…") as HTMLInputElement;
    expect(input.className).toContain("rounded-full");
    expect(input.className).toContain("w-[280px]");
    expect(input.parentElement!.querySelector(".lucide-search")).toBeTruthy();
    fireEvent.change(input, { target: { value: "desk" } });
    expect(onChange).toHaveBeenCalledWith("desk");
  });

  it("label 为输入框的无障碍名称；未给时没有 aria-label", () => {
    const { unmount } = render(
      <SearchField value="" onChange={() => {}} label="搜索" placeholder="搜索名称或 email" />,
    );
    expect(screen.getByRole("textbox", { name: "搜索" })).toBeTruthy();
    unmount();
    render(<SearchField value="" onChange={() => {}} placeholder="搜索规格…" />);
    expect(screen.getByPlaceholderText("搜索规格…").getAttribute("aria-label")).toBeNull();
  });
});

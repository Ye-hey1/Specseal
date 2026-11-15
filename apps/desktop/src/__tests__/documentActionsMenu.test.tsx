// 详情页内容卡标头的「打开 ▾」（spec desktop-app「详情页的文档动作」；design D4）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider, type DocumentTarget } from "@specseal/ui";

import { DocumentActionsMenu } from "../components/DocumentActionsMenu";
import type { DocumentLocation } from "../adapter/fsActions";
import { APP_MESSAGES } from "../i18n/messages";
import type { Platform } from "../platform";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
    {children}
  </I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

afterEach(cleanup);

const DOC = { change: "add-auth", artifact: "proposal.md" };
const LOC: DocumentLocation = {
  path: "/work/app/specseal/changes/add-auth/proposal.md",
  relative: "specseal/changes/add-auth/proposal.md",
};

function setup({
  target = { doc: DOC, content: "# 提案" } as DocumentTarget | null,
  local = true,
  platform = "macos" as Platform,
  locate = vi.fn().mockResolvedValue(LOC),
} = {}) {
  const callbacks = {
    locate,
    onOpenDefault: vi.fn(),
    onReveal: vi.fn(),
    onCopyPath: vi.fn(),
    onCopyContent: vi.fn(),
  };
  const view = render(<DocumentActionsMenu target={target} local={local} platform={platform} {...callbacks} />);
  return { ...callbacks, view };
}

const user = () => userEvent.setup();
const openMenu = async (u: ReturnType<typeof userEvent.setup>) =>
  u.click(screen.getByRole("button", { name: /打开/ }));
const itemNames = () => screen.getAllByRole("menuitem").map((item) => item.textContent);

describe("DocumentActionsMenu", () => {
  it("本机：展开时向宿主查位置，首列为等宽灰字相对路径，其后三项（macOS 标签为 Finder）", async () => {
    const u = user();
    const cb = setup();
    await openMenu(u);
    const label = await screen.findByText(LOC.relative);
    expect(cb.locate).toHaveBeenCalledWith(DOC);
    expect(label.className).toContain("font-mono");
    expect(label.className).toContain("text-muted-foreground");
    expect(itemNames()).toEqual(["以缺省 App 打开", "在 Finder 显示", "拷贝路径"]);
  });

  it("首列与动作采宿主回报的实际位置（已封存讨论的日期文档名）", async () => {
    const u = user();
    const archived = {
      path: "/work/app/specseal/discussions/archive/2026-01-03-old-topic.md",
      relative: "specseal/discussions/archive/2026-01-03-old-topic.md",
    };
    const cb = setup({
      target: { doc: { discussion: "old-topic" }, content: "# 记录" },
      locate: vi.fn().mockResolvedValue(archived),
    });
    await openMenu(u);
    await screen.findByText(archived.relative);
    await u.click(screen.getByRole("menuitem", { name: "拷贝路径" }));
    expect(cb.locate).toHaveBeenCalledWith({ discussion: "old-topic" });
    expect(cb.onCopyPath).toHaveBeenCalledWith(archived);
  });

  it("位置查找中或查不到时三项停用、无首列", async () => {
    const u = user();
    setup({ locate: vi.fn().mockResolvedValue(null) });
    await openMenu(u);
    const item = await screen.findByRole("menuitem", { name: "拷贝路径" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByText(LOC.relative)).toBeNull();
  });

  it("Windows 标签为文档总管", async () => {
    const u = user();
    setup({ platform: "windows" });
    await openMenu(u);
    expect(itemNames()).toContain("在文档总管显示");
  });

  it("各项以实际位置调用对应 callback", async () => {
    const u = user();
    const cb = setup();
    await openMenu(u);
    await screen.findByText(LOC.relative);
    await u.click(screen.getByRole("menuitem", { name: "以缺省 App 打开" }));
    await openMenu(u);
    await screen.findByText(LOC.relative);
    await u.click(screen.getByRole("menuitem", { name: "在 Finder 显示" }));
    await openMenu(u);
    await screen.findByText(LOC.relative);
    await u.click(screen.getByRole("menuitem", { name: "拷贝路径" }));
    expect(cb.onOpenDefault).toHaveBeenCalledWith(LOC);
    expect(cb.onReveal).toHaveBeenCalledWith(LOC);
    expect(cb.onCopyPath).toHaveBeenCalledWith(LOC);
    expect(cb.onCopyContent).not.toHaveBeenCalled();
  });

  it("remote 无本机 checkout：只有「拷贝内容」且无路径首列、不查位置，选后写入原文", async () => {
    const u = user();
    const cb = setup({ local: false, target: { doc: { discussion: "alpha" }, content: "# 讨论原文" } });
    await openMenu(u);
    expect(itemNames()).toEqual(["拷贝内容"]);
    expect(cb.locate).not.toHaveBeenCalled();
    await u.click(screen.getByRole("menuitem", { name: "拷贝内容" }));
    expect(cb.onCopyContent).toHaveBeenCalledWith("# 讨论原文");
  });

  it("remote 且原文未载完：「拷贝内容」停用", async () => {
    const u = user();
    setup({ local: false, target: { doc: DOC, content: null } });
    await openMenu(u);
    const item = screen.getByRole("menuitem", { name: "拷贝内容" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("remote 且分页不载原文（工单）时不渲染", () => {
    const { view } = setup({ local: false, target: { doc: { change: "add-auth", artifact: "review.md" } } });
    expect(view.container.innerHTML).toBe("");
  });

  it("本机但目标不带文档（已封存讨论）：只有「拷贝内容」、不查位置", async () => {
    const u = user();
    const cb = setup({ target: { doc: null, content: "# 封存讨论原文" } });
    await openMenu(u);
    expect(itemNames()).toEqual(["拷贝内容"]);
    expect(cb.locate).not.toHaveBeenCalled();
    await u.click(screen.getByRole("menuitem", { name: "拷贝内容" }));
    expect(cb.onCopyContent).toHaveBeenCalledWith("# 封存讨论原文");
  });

  it("正式规格与封存变更的文档参照原样交给宿主查位置", async () => {
    const u = user();
    const spec = { path: "/work/app/specseal/specs/auth/spec.md", relative: "specseal/specs/auth/spec.md" };
    const cb = setup({ target: { doc: { spec: "auth" }, content: "# spec" }, locate: vi.fn().mockResolvedValue(spec) });
    await openMenu(u);
    await screen.findByText(spec.relative);
    expect(cb.locate).toHaveBeenCalledWith({ spec: "auth" });
    cb.view.unmount();
    const archived = setup({ target: { doc: { archived: "2026-07-04-old", artifact: "design.md" }, content: "# d" } });
    await openMenu(u);
    expect(archived.locate).toHaveBeenCalledWith({ archived: "2026-07-04-old", artifact: "design.md" });
  });

  it("分页没有对应文档（target 为 null）时不渲染", () => {
    const { view } = setup({ target: null });
    expect(view.container.innerHTML).toBe("");
  });
});

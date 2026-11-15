// 最近打开清单组件（workspace-chooser「最近打开清单」，design D7）：对话框第一步与
// 零项目空状态共用同一份；两个 variant 只差外框。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider } from "@specseal/ui";

import { RecentList, type RecentListProps } from "../components/RecentList";
import type { ConnectionView } from "../adapter/connections";
import { APP_MESSAGES } from "../i18n/messages";
import type { RecentEntry } from "../recents";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
    {children}
  </I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

const CONNECTION: ConnectionView = {
  id: "conn_1",
  origin: "https://spec.example.test",
  name: "团队 Server",
  loggedIn: true,
};
const LOCAL: RecentEntry = { locator: { kind: "local", root: "/work/specseal" }, name: "specseal" };
const REMOTE: RecentEntry = {
  locator: { kind: "remote", connectionId: "conn_1", projectId: "prj_1", repoId: "repo_1" },
  name: "Specseal/Desktop",
};

function renderList(over: Partial<RecentListProps> = {}) {
  const props: RecentListProps = {
    variant: "dialog",
    entries: [LOCAL, REMOTE],
    connections: [CONNECTION],
    connectionsReady: true,
    errors: {},
    onOpen: vi.fn(),
    onRemove: vi.fn(),
    ...over,
  };
  const { unmount } = render(<RecentList {...props} />);
  return { ...props, unmount };
}

describe("RecentList", () => {
  it("dialog：小标「最近打开」与计数，列放在细框卡内", () => {
    renderList();
    const section = document.querySelector('[data-recent-list="dialog"]') as HTMLElement;
    expect(section.textContent).toContain("最近打开");
    expect(section.textContent).toContain("2");
    const box = section.querySelector("[data-recent-rows]") as HTMLElement;
    expect(box.className).toContain("rounded-xl");
    expect(box.className).toContain("border");
  });

  it("card：整段包在卡片底色内（空状态用）", () => {
    renderList({ variant: "card" });
    const section = document.querySelector('[data-recent-list="card"]') as HTMLElement;
    expect(section.className).toContain("bg-card");
    expect(section.className).toContain("rounded-xl");
  });

  it("本机列显示名称与路径；remote 列显示显示名、连接名称与「远程」签", () => {
    renderList();
    const local = screen.getByRole("button", { name: /\/work\/specseal/ });
    expect(local.textContent).toContain("specseal");
    expect(local.textContent).not.toContain("远程");
    const remote = screen.getByRole("button", { name: /团队 Server/ });
    expect(remote.textContent).toContain("Specseal/Desktop");
    expect(remote.textContent).toContain("远程");
  });

  it("点列以该条目调用 onOpen", () => {
    const { onOpen } = renderList();
    fireEvent.click(screen.getByRole("button", { name: /\/work\/specseal/ }));
    expect(onOpen).toHaveBeenCalledWith(LOCAL);
  });

  it("打开失败的错误态：显示原因、仍可再点重试，× 仍以该条目调用 onRemove", () => {
    const { onOpen, onRemove } = renderList({ errors: { "local:/work/specseal": "目录不存在" } });
    const row = screen.getByRole("button", { name: /目录不存在/ }) as HTMLButtonElement;
    expect(row.disabled).toBe(false);
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith(LOCAL);
    fireEvent.click(screen.getByRole("button", { name: "自最近打开移除 specseal" }));
    expect(onRemove).toHaveBeenCalledWith(LOCAL);
  });

  it("连接清单就绪且连接已移除时 remote 列为错误态；未就绪时不判定", () => {
    const { unmount } = rtlRender(
      <RecentList
        variant="dialog"
        entries={[REMOTE]}
        connections={[]}
        connectionsReady
        errors={{}}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
      />,
      { wrapper: zhWrapper },
    );
    expect(screen.getByText("连接已移除")).toBeTruthy();
    unmount();
    renderList({ entries: [REMOTE], connections: [], connectionsReady: false });
    expect(screen.queryByText("连接已移除")).toBeNull();
  });

  it("打开进行中（busy）：列外层无 hover 底色、列按钮停用光标为箭头（design D4）", () => {
    const { unmount } = renderList({ entries: [LOCAL] });
    const idle = screen.getByRole("button", { name: /\/work\/specseal/ });
    expect(idle.parentElement!.className).toContain("hover:bg-foreground/5");
    unmount();

    renderList({ entries: [LOCAL], busy: true });
    const row = screen.getByRole("button", { name: /\/work\/specseal/ }) as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.className).toContain("disabled:cursor-default");
    expect(row.parentElement!.className).not.toContain("hover:");
  });

  it("无条目时不渲染任何区段", () => {
    renderList({ entries: [] });
    expect(document.querySelector("[data-recent-list]")).toBeNull();
    expect(screen.queryByText("最近打开")).toBeNull();
  });
});

// 零项目空状态（desktop-config「零分页时显示空状态引导页」、workspace-chooser「零项目空状态
// 列出同一份最近打开」，design D7）。
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider } from "@specseal/ui";

import { EmptyWorkspace, type EmptyWorkspaceProps } from "../components/EmptyWorkspace";
import { APP_MESSAGES } from "../i18n/messages";
import type { RecentEntry } from "../recents";

const zh = APP_MESSAGES["zh-CN"];
const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
    {children}
  </I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

const LOCAL: RecentEntry = { locator: { kind: "local", root: "/work/specseal" }, name: "specseal" };

async function renderEmpty(over: Partial<EmptyWorkspaceProps> = {}) {
  const props: EmptyWorkspaceProps = {
    recents: [],
    connections: [],
    onRefreshConnections: vi.fn().mockResolvedValue(true),
    workspace: { openProject: vi.fn().mockResolvedValue({ status: "project", root: "/work/specseal", name: "specseal" }) },
    connectionAdapter: { inspectCheckout: vi.fn() },
    onOpenLocal: vi.fn().mockResolvedValue(undefined),
    onOpenRemote: vi.fn().mockResolvedValue(undefined),
    onRemoveRecent: vi.fn(),
    onOpenChooser: vi.fn(),
    ...over,
  };
  render(<EmptyWorkspace {...props} />);
  await act(async () => {});
  return props;
}

describe("EmptyWorkspace", () => {
  it("字标、标题、含初始化提示的说明与底部 CLI 提示", async () => {
    await renderEmpty();
    // 字标深浅两版以 dark: 切换（与深色 token 同一套触发，明示外观也跟得上）。
    const [wordmark, dark] = screen.getAllByAltText("Specseal");
    expect(wordmark.className).toContain("h-10");
    expect(wordmark.className).toContain("dark:hidden");
    expect(dark.getAttribute("src")).toContain("data:image/svg+xml");
    expect(screen.getByRole("heading", { level: 2, name: "打开一个项目开始" })).toBeTruthy();
    // 新项目的说明写缺省规格文档夹 specseal/（spec「画面依实际规格文档夹与数据文档名显示」）。
    expect(screen.getByText(zh["app.emptyDesc"]).textContent).toContain("specseal/");
    expect(screen.getByText(zh["app.emptyCli"])).toBeTruthy();
  });

  it("「添加项目」开对话框；「连接 Server」带 initialStep: \"server\"", async () => {
    const { onOpenChooser } = await renderEmpty();
    fireEvent.click(screen.getByRole("button", { name: zh["app.newProject"] }));
    expect(onOpenChooser).toHaveBeenLastCalledWith();
    fireEvent.click(screen.getByRole("button", { name: zh["app.connectServer"] }));
    expect(onOpenChooser).toHaveBeenLastCalledWith({ initialStep: "server" });
    expect(onOpenChooser).toHaveBeenCalledTimes(2);
  });

  it("有最近打开记录时显卡片；点本机条目走与对话框相同的探测与打开", async () => {
    const props = await renderEmpty({ recents: [LOCAL] });
    expect(document.querySelector('[data-recent-list="card"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /\/work\/specseal/ }));
    await waitFor(() => expect(props.onOpenLocal).toHaveBeenCalledWith("/work/specseal"));
    expect(props.workspace.openProject).toHaveBeenCalledWith("/work/specseal");
    fireEvent.click(screen.getByRole("button", { name: "自最近打开移除 specseal" }));
    expect(props.onRemoveRecent).toHaveBeenCalledWith("local:/work/specseal");
  });

  it("remote 条目打开失败后可再点重试：重试开始即清掉错误态，成功就打开（服务器暂时脱机的情境）", async () => {
    const REMOTE: RecentEntry = {
      locator: { kind: "remote", connectionId: "conn_1", projectId: "prj_1", repoId: "repo_1" },
      name: "Demo/api",
    };
    const onOpenRemote = vi
      .fn()
      .mockRejectedValueOnce(new Error("server unreachable"))
      .mockResolvedValueOnce(undefined);
    await renderEmpty({
      recents: [REMOTE],
      connections: [{ id: "conn_1", name: "团队 Server", origin: "https://s", loggedIn: true } as never],
      onOpenRemote,
    });
    fireEvent.click(screen.getByRole("button", { name: /^Demo\/api/ }));
    await waitFor(() => expect(screen.getByText(/server unreachable/)).toBeTruthy());
    const row = screen.getByRole("button", { name: /^Demo\/api/ }) as HTMLButtonElement;
    expect(row.disabled).toBe(false);
    fireEvent.click(row);
    await waitFor(() => expect(onOpenRemote).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/server unreachable/)).toBeNull());
  });

  it("挂载时读一次连接清单", async () => {
    const props = await renderEmpty();
    expect(props.onRefreshConnections).toHaveBeenCalledTimes(1);
  });

  it("无记录时不渲染最近打开区段", async () => {
    await renderEmpty();
    expect(document.querySelector("[data-recent-list]")).toBeNull();
    expect(screen.queryByText("最近打开")).toBeNull();
  });
});

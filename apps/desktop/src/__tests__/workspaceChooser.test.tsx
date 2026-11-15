import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nProvider } from "@specseal/ui";

import { WorkspaceChooser } from "../components/WorkspaceChooser";
import { RemoteConflictDialog } from "../components/RemoteConflictDialog";
import { APP_MESSAGES } from "../i18n/messages";
import { createAppStore, type AppState } from "../store";
import type { ConnectionsAdapter, ConnectionView, LoginPhase, LoginResult } from "../adapter/connections";
import type { WorkspaceAdapter } from "../adapter/workspace";
import type { UseBoundStore, StoreApi } from "zustand";
import type { WorkspaceSession } from "../session";
import type { RecentEntry } from "../recents";
import { expectToolCheckboxes } from "./helpers/toolCheckboxes";

const CONNECTION: ConnectionView = {
  id: "conn_1",
  origin: "https://spec.example.test",
  name: "团队 Server",
  lastActorDisplay: "Momo",
  loggedIn: true,
};

const SCOPES = {
  projects: [
    {
      id: "prj_1",
      key: "specseal",
      name: "Specseal",
      repos: [
        { id: "repo_1", key: "desktop", name: "Desktop" },
        { id: "repo_2", key: "server", name: "Server" },
      ],
    },
  ],
};

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
    {children}
  </I18nProvider>
);

/** 元素 class 中的 hover token（含 enabled:hover: 这类组合变体）。 */
const hoverClasses = (el: HTMLElement) => el.className.split(/\s+/).filter((c) => c.includes("hover:"));
/** 停用时不给 hover（spec desktop-app「可点元素的光标与 hover 回馈」；design D4）：hover token 全挂在
 * enabled: 之下，停用的 button 不命中。 */
function expectHoverOnlyWhenEnabled(el: HTMLElement) {
  const hovers = hoverClasses(el);
  expect(hovers.length).toBeGreaterThan(0);
  expect(hovers.filter((c) => !c.startsWith("enabled:"))).toEqual([]);
}

function fakeConnections(over: Partial<ConnectionsAdapter> = {}): ConnectionsAdapter {
  return {
    list: vi.fn().mockResolvedValue([CONNECTION]),
    add: vi.fn().mockResolvedValue(CONNECTION),
    remove: vi.fn().mockResolvedValue(undefined),
    loginStart: vi.fn().mockResolvedValue({ status: "loggedIn", display: "Momo" }),
    loginCancel: vi.fn().mockResolvedValue(undefined),
    patLogin: vi.fn().mockResolvedValue({ status: "loggedIn", display: "Momo" }),
    logout: vi.fn().mockResolvedValue({ revokedOnServer: true, patNotice: false }),
    scopes: vi.fn().mockResolvedValue(SCOPES),
    inspectCheckout: vi
      .fn()
      .mockImplementation(async (path: string) => ({ root: path, tools: ["claude"] })),
    bindCheckout: vi.fn().mockImplementation(async (path: string) => path),
    ...over,
  };
}

/** 走到 checkout 步骤并选好本机文档夹（inspect 完成后显示工具 checkbox）。 */
async function reachCheckoutFolder() {
  fireEvent.click(screen.getByRole("radio", { name: /选择本机文档夹/ }));
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: /claude/i })).toBeTruthy(),
  );
}

function fakeWorkspace(over: Partial<WorkspaceAdapter> = {}): WorkspaceAdapter {
  return {
    openProject: vi.fn(),
    initProject: vi.fn(),
    startupDir: vi.fn(),
    projectStats: vi.fn(),
    watchWorkspace: vi.fn(),
    pickFolder: vi.fn().mockResolvedValue(null),
    ...over,
  };
}

async function renderChooser({
  adapter = fakeConnections(),
  workspace = fakeWorkspace(),
  connections = [CONNECTION],
  onOpenRemote = vi.fn().mockResolvedValue(undefined),
  onOpenLocal = vi.fn().mockResolvedValue(undefined),
  onRequestMigration = vi.fn().mockResolvedValue(undefined),
  onAddServer = vi.fn().mockResolvedValue(undefined),
  recents = [],
  onRemoveRecent = vi.fn(),
  onRefreshConnections = vi.fn().mockResolvedValue(true),
  initialConnectionId,
  initialScope,
  initialCheckoutPath,
  initialStep,
  initialServerUrl,
  defaultConnectionId,
}: {
  adapter?: ConnectionsAdapter;
  workspace?: WorkspaceAdapter;
  connections?: ConnectionView[];
  onOpenRemote?: ReturnType<typeof vi.fn>;
  onOpenLocal?: ReturnType<typeof vi.fn>;
  onRequestMigration?: ReturnType<typeof vi.fn>;
  onAddServer?: ReturnType<typeof vi.fn>;
  recents?: RecentEntry[];
  onRemoveRecent?: ReturnType<typeof vi.fn>;
  onRefreshConnections?: ReturnType<typeof vi.fn>;
  initialConnectionId?: string;
  initialScope?: { projectKey: string; repoKey: string };
  initialCheckoutPath?: string;
  initialStep?: "server";
  initialServerUrl?: string;
  defaultConnectionId?: string;
} = {}) {
  const onOpenChange = vi.fn();
  render(
    <WorkspaceChooser
      open
      onOpenChange={onOpenChange}
      connections={connections}
      connectionAdapter={adapter}
      workspace={workspace}
      onOpenLocal={onOpenLocal}
      onRequestMigration={onRequestMigration}
      onAddServer={onAddServer}
      phases={{}}
      onCancelLogin={vi.fn()}
      onSubmitPat={vi.fn()}
      onRefreshConnections={onRefreshConnections}
      onOpenRemote={onOpenRemote}
      recents={recents}
      onRemoveRecent={onRemoveRecent}
      initialConnectionId={initialConnectionId}
      initialScope={initialScope}
      initialCheckoutPath={initialCheckoutPath}
      initialStep={initialStep}
      initialServerUrl={initialServerUrl}
      defaultConnectionId={defaultConnectionId}
    />,
    { wrapper: zhWrapper },
  );
  // 挂载时的连接重整是唯一的异步 setState——先冲干净，否则每个案例都喷
  // "not wrapped in act(...)"，且错误态的判定会在断言之后才落定。
  await act(async () => {});
  return {
    adapter,
    workspace,
    onOpenRemote,
    onOpenLocal,
    onRequestMigration,
    onAddServer,
    onRemoveRecent,
    onOpenChange,
  };
}

/** 第一步：选取来源卡后按页脚主要钮（design D8：点卡只选取）。 */
function chooseSource(source: "local" | "server") {
  fireEvent.click(screen.getByRole("button", { name: source === "local" ? /本机文档夹/ : /^Server/ }));
  fireEvent.click(screen.getByRole("button", { name: source === "local" ? "选择文档夹…" : "下一步" }));
}

/** 最近打开列的打开钮（移除钮带 aria-label，打开钮没有）。 */
function recentOpenButton(name: RegExp): HTMLButtonElement {
  const found = screen
    .getAllByRole("button", { name })
    .filter((el) => !el.getAttribute("aria-label"));
  expect(found).toHaveLength(1);
  return found[0] as HTMLButtonElement;
}

async function chooseDesktopRepo() {
  chooseSource("server");
  fireEvent.click(screen.getByRole("radio", { name: /团队 Server/ }));
  await waitFor(() => expect(screen.getByRole("radio", { name: /Desktop/ })).toBeTruthy());
  fireEvent.click(screen.getByRole("radio", { name: /Desktop/ }));
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
}

describe("WorkspaceChooser", () => {
  it("对话框标题为「添加项目」（en「New project」），用户可见文案不出现 Workspace", async () => {
    await renderChooser({ recents: [] });
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: "添加项目" })).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/workspace/i);
    expect(APP_MESSAGES.en["chooser.sourceTitle"]).toBe("New project");
    // 说明先讲清楚：本机文档夹没有 specseal/ 时会先问要不要初始化。
    expect(within(dialog).getByText(APP_MESSAGES["zh-CN"]["chooser.sourceDesc"]).textContent).toContain(
      "specseal/",
    );
    expect(APP_MESSAGES.en["chooser.sourceDesc"]).toContain("specseal/");
  });

  // 来源卡不绑产品品牌：卡名与其下一步标题都只称 Server。定位锚在开头，
  // 否则会连最近打开的 remote 列（显示名含 Server）一起命中。
  it("第一步来源卡称「Server」，点入后标题为「选择 Server」", async () => {
    await renderChooser({ recents: [] });

    const source = screen.getByRole("button", { name: /^Server/ });
    expect(source.textContent).toContain("Server");
    expect(source.textContent).not.toContain("Specseal Server");

    fireEvent.click(source);
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByText("选择 Server")).toBeTruthy();
  });

  it("来源→已登录 server→scopes 分组单选→略过 checkout 打开 spec-only 分页", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const { adapter, onOpenChange } = await renderChooser({ onOpenRemote: open });

    await chooseDesktopRepo();
    fireEvent.click(screen.getByRole("radio", { name: /略过（规格模式）/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开项目" }));

    await waitFor(() =>
      expect(open).toHaveBeenCalledWith("conn_1", "specseal/desktop", undefined),
    );
    expect(adapter.scopes).toHaveBeenCalledWith("conn_1");
    expect(screen.queryByPlaceholderText("project 或 project/repo")).toBeNull();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // spec/design「Desktop IPC and UI contract」：先 inspect（零写入的先检查）
  it("选择 checkout 会先走 inspect marker 验证，拒绝消息指出 marker 指向且不显示工具选集", async () => {
    const inspect = vi.fn().mockRejectedValue(
      new Error(
        "此文档夹的 remote marker 指向 https://other.example.test / api，与所选不一致",
      ),
    );
    const bind = vi.fn();
    const adapter = fakeConnections({ inspectCheckout: inspect, bindCheckout: bind });
    const workspace = fakeWorkspace({ pickFolder: vi.fn().mockResolvedValue("/work/desktop") });
    const open = vi.fn().mockResolvedValue(undefined);
    await renderChooser({ adapter, workspace, onOpenRemote: open });

    await chooseDesktopRepo();
    fireEvent.click(screen.getByRole("radio", { name: /选择本机文档夹/ }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "https://other.example.test / api",
      ),
    );
    expect(inspect).toHaveBeenCalledWith(
      "/work/desktop",
      "https://spec.example.test",
      "specseal",
      "desktop",
    );
    expect(bind).not.toHaveBeenCalled();
    expect(screen.queryByRole("checkbox", { name: /claude/i })).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  // spec/design「Desktop IPC and UI contract」：inspect 后显示既有选集，
  // submit 依序 bind（带选集）后才 openRemote（带 checkoutRoot）。
  it("folder mode：inspect 预选既有工具，打开时先 bind 后 openRemote", async () => {
    const inspect = vi
      .fn()
      .mockResolvedValue({ root: "/work/desktop", tools: ["codex"] });
    const bind = vi.fn().mockResolvedValue("/work/desktop");
    const adapter = fakeConnections({ inspectCheckout: inspect, bindCheckout: bind });
    const workspace = fakeWorkspace({ pickFolder: vi.fn().mockResolvedValue("/work/desktop") });
    const open = vi.fn().mockResolvedValue(undefined);
    const { onOpenChange } = await renderChooser({ adapter, workspace, onOpenRemote: open });

    await chooseDesktopRepo();
    await reachCheckoutFolder();

    // checkout 步骤的五个勾选依 claude、codex、copilot、pi、cursor 顺序出现；
    // inspect 回传 codex → 只有 codex 勾选。
    expectToolCheckboxes(document.body, ["codex"]);
    // inspect 回传 codex → codex 勾选、claude 与 copilot 未勾。
    expect(
      (screen.getByRole("checkbox", { name: /codex/i }) as HTMLInputElement).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    expect(
      (screen.getByRole("checkbox", { name: /copilot/i }) as HTMLInputElement).getAttribute(
        "aria-checked",
      ),
    ).toBe("false");
    expect(
      (screen.getByRole("checkbox", { name: /claude/i }) as HTMLInputElement).getAttribute(
        "aria-checked",
      ),
    ).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "打开项目" }));

    await waitFor(() =>
      expect(bind).toHaveBeenCalledWith(
        "/work/desktop",
        "https://spec.example.test",
        "specseal",
        "desktop",
        ["codex"],
      ),
    );
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith("conn_1", "specseal/desktop", "/work/desktop"),
    );
    // 同步成功才打开：bind 先于 openRemote。
    expect(bind.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("folder mode：空工具选集时「打开项目」停用且不 bind", async () => {
    const inspect = vi.fn().mockResolvedValue({ root: "/work/desktop", tools: [] });
    const bind = vi.fn();
    const adapter = fakeConnections({ inspectCheckout: inspect, bindCheckout: bind });
    const workspace = fakeWorkspace({ pickFolder: vi.fn().mockResolvedValue("/work/desktop") });
    await renderChooser({ adapter, workspace });

    await chooseDesktopRepo();
    await reachCheckoutFolder();

    expect(
      (screen.getByRole("button", { name: "打开项目" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // 勾一个工具后激活。
    fireEvent.click(screen.getByRole("checkbox", { name: /claude/i }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "打开项目" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(bind).not.toHaveBeenCalled();
  });

  it("folder mode：bind 失败保留 path 与工具选集且不 openRemote", async () => {
    const inspect = vi
      .fn()
      .mockResolvedValue({ root: "/work/desktop", tools: ["claude", "codex"] });
    const bind = vi.fn().mockRejectedValue(new Error("同步技能时发生文档系统错误"));
    const adapter = fakeConnections({ inspectCheckout: inspect, bindCheckout: bind });
    const workspace = fakeWorkspace({ pickFolder: vi.fn().mockResolvedValue("/work/desktop") });
    const open = vi.fn().mockResolvedValue(undefined);
    const { onOpenChange } = await renderChooser({ adapter, workspace, onOpenRemote: open });

    await chooseDesktopRepo();
    await reachCheckoutFolder();
    fireEvent.click(screen.getByRole("button", { name: "打开项目" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("同步技能时发生文档系统错误"),
    );
    expect(open).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // 选集与 path 留存：checkbox 仍在、仍勾选，可重试。
    expect(
      (screen.getByRole("checkbox", { name: /claude/i }) as HTMLInputElement).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
  });

  // spec「缺少工具选集时导向 checkout 选择」：intent 直达 checkout 步骤并预填 scope／path
  it("缺选集 intent：直达 checkout 步骤、依 scope inspect 预填 path 并要求明示选择", async () => {
    const inspect = vi.fn().mockResolvedValue({ root: "/work/desktop", tools: [] });
    const adapter = fakeConnections({ inspectCheckout: inspect });
    const open = vi.fn().mockResolvedValue(undefined);
    await renderChooser({
      adapter,
      onOpenRemote: open,
      initialConnectionId: "conn_1",
      initialScope: { projectKey: "specseal", repoKey: "desktop" },
      initialCheckoutPath: "/work/desktop",
    });

    // 直达 checkout 步骤并以预填 path inspect（不必再走 source→server→scopes）。
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: /claude/i })).toBeTruthy(),
    );
    expect(inspect).toHaveBeenCalledWith(
      "/work/desktop",
      "https://spec.example.test",
      "specseal",
      "desktop",
    );
    // 缺选集 → Open 停用，需用户明示勾选。
    expect(
      (screen.getByRole("button", { name: "打开项目" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("folder mode：bind 进行中不得重复送出", async () => {
    let release: (value: string) => void = () => {};
    const inspect = vi
      .fn()
      .mockResolvedValue({ root: "/work/desktop", tools: ["claude"] });
    const bind = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const adapter = fakeConnections({ inspectCheckout: inspect, bindCheckout: bind });
    const workspace = fakeWorkspace({ pickFolder: vi.fn().mockResolvedValue("/work/desktop") });
    await renderChooser({ adapter, workspace });

    await chooseDesktopRepo();
    await reachCheckoutFolder();
    const openButton = screen.getByRole("button", { name: "打开项目" });
    fireEvent.click(openButton);
    await waitFor(() => expect((openButton as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(openButton);
    fireEvent.click(openButton);

    expect(bind).toHaveBeenCalledTimes(1);
    release("/work/desktop");
  });

  it("initialStep: \"server\" 起始于 Server 步骤（空状态「连接 Server」入口）", async () => {
    await renderChooser({ initialStep: "server" });
    expect(screen.getByText("选择 Server")).toBeTruthy();
    expect(screen.getByText("步骤 2 / 4")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /本机文档夹/ })).toBeNull();
  });

  it("第一步未选来源卡时页脚主要钮停用；「取消」为 ghost", async () => {
    await renderChooser();
    const primary = screen.getByRole("button", { name: "选择来源" }) as HTMLButtonElement;
    expect(primary.disabled).toBe(true);
    const local = screen.getByRole("button", { name: /本机文档夹/ });
    expect(local.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "取消" }).className).not.toContain("border");
  });

  it("选本机卡：卡片为选取态、主要钮为「选择文档夹…」，按下才开文档夹选择器", async () => {
    const workspace = fakeWorkspace();
    await renderChooser({ workspace });
    const local = screen.getByRole("button", { name: /本机文档夹/ });
    fireEvent.click(local);
    expect(local.getAttribute("aria-pressed")).toBe("true");
    expect(local.className).toContain("border-primary");
    expect(workspace.pickFolder).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "选择文档夹…" }));
    await waitFor(() => expect(workspace.pickFolder).toHaveBeenCalledTimes(1));
  });

  it("选 Server 卡：主要钮为「下一步」，按下进 Server 步骤，清单为整列单选", async () => {
    await renderChooser();
    fireEvent.click(screen.getByRole("button", { name: /^Server/ }));
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByText("选择 Server")).toBeTruthy();
    const group = screen.getByRole("radiogroup");
    const row = within(group).getByRole("radio", { name: /团队 Server/ });
    expect(row.getAttribute("aria-checked")).toBe("false");
  });

  it("checkout 步骤的两个选项是单选列", async () => {
    await renderChooser();
    await chooseDesktopRepo();
    const skip = await screen.findByRole("radio", { name: /略过/ });
    fireEvent.click(skip);
    expect(skip.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /选择本机文档夹/ }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("scopes 没有 membership 时显示繁中空清单说明", async () => {
    const adapter = fakeConnections({ scopes: vi.fn().mockResolvedValue({ projects: [] }) });
    await renderChooser({ adapter });

    chooseSource("server");
    fireEvent.click(screen.getByRole("radio", { name: /团队 Server/ }));

    expect((await screen.findByTestId("scopes-empty")).textContent).toContain(
      "此帐号目前没有任何 Project／Repo membership",
    );
    expect((screen.getByRole("button", { name: "下一步" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("server 清单可就地添加并登录，完成后回到清单步骤", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    await renderChooser({ connections: [], onAddServer: add });

    chooseSource("server");
    expect(screen.getByText(/目前没有已登录的 server/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "添加 server" }));
    fireEvent.change(screen.getByLabelText("服务器地址（http://…）"), {
      target: { value: "https://new.example.test" },
    });
    fireEvent.change(screen.getByLabelText("显示名"), { target: { value: "新 Server" } });
    fireEvent.click(screen.getByRole("button", { name: "添加并登录" }));

    await waitFor(() =>
      expect(add).toHaveBeenCalledWith("https://new.example.test", "新 Server"),
    );
    // add 被调用≠完成：status 消息在 promise resolve 后才渲染，须异步等。
    expect((await screen.findByRole("status")).textContent).toContain("连接已添加");
  });

  it("本机文档夹分流沿用既有打开流程", async () => {
    const local = vi.fn().mockResolvedValue(undefined);
    const workspace = fakeWorkspace({
      pickFolder: vi.fn().mockResolvedValue("/work/local"),
      openProject: vi.fn().mockResolvedValue({
        status: "project",
        root: "/work/local",
        name: "Local",
      }),
    });
    const { onOpenChange } = await renderChooser({ workspace, onOpenLocal: local });

    chooseSource("local");
    fireEvent.click(await screen.findByRole("button", { name: "打开本机" }));

    await waitFor(() => expect(local).toHaveBeenCalledWith("/work/local"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("选到含 openspec 的本机项目后提供迁移到 server 次要动作", async () => {
    const migrate = vi.fn().mockResolvedValue(undefined);
    const workspace = fakeWorkspace({
      pickFolder: vi.fn().mockResolvedValue("/work/local"),
      openProject: vi.fn().mockResolvedValue({
        status: "project",
        root: "/work/local",
        name: "Local",
      }),
    });
    const { onOpenChange } = await renderChooser({
      workspace,
      onRequestMigration: migrate,
    });

    chooseSource("local");
    fireEvent.click(await screen.findByRole("button", { name: "迁移到 Server…" }));

    await waitFor(() => expect(migrate).toHaveBeenCalledWith("/work/local"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// 停用的选择卡与单选列为箭头且无 hover（spec desktop-app「可点元素的光标与 hover 回馈」；design D4）。
describe("打开项目画面停用态", () => {
  it("最近打开列打开中，停用的本机选择卡为箭头且无 hover", async () => {
    const workspace = fakeWorkspace({ openProject: vi.fn(() => new Promise(() => {})) });
    await renderChooser({
      workspace,
      recents: [{ locator: { kind: "local", root: "/work/specseal" }, name: "specseal" }],
    });
    fireEvent.click(screen.getByRole("button", { name: /\/work\/specseal/ }));
    const card = screen.getByRole("button", { name: /本机文档夹/ }) as HTMLButtonElement;
    await waitFor(() => expect(card.disabled).toBe(true));
    expectHoverOnlyWhenEnabled(card);
    expect(card.className).toContain("cursor-default");
  });

  it("bind 进行中，停用的「选择本机文档夹」单选列为箭头且无 hover", async () => {
    const adapter = fakeConnections({ bindCheckout: vi.fn(() => new Promise<string>(() => {})) });
    const workspace = fakeWorkspace({ pickFolder: vi.fn().mockResolvedValue("/work/desktop") });
    await renderChooser({ adapter, workspace });
    await chooseDesktopRepo();
    await reachCheckoutFolder();
    fireEvent.click(screen.getByRole("button", { name: "打开项目" }));
    const row = screen.getByRole("radio", { name: /选择本机文档夹/ }) as HTMLButtonElement;
    await waitFor(() => expect(row.disabled).toBe(true));
    // 已选中的单选列本来就没有 hover；只确认没有未受 enabled: 约束的 hover token。
    expect(hoverClasses(row).filter((c) => !c.startsWith("enabled:"))).toEqual([]);
    expect(row.className).toContain("cursor-default");
  });
});

describe("remote marker 与本机 openspec 并存", () => {
  it("强制呈现继续本机、以 server 为准、迁移本机内容三个出口", async () => {
    const continueLocal = vi.fn().mockResolvedValue(undefined);
    const useServer = vi.fn().mockResolvedValue(undefined);
    const migrateLocal = vi.fn();
    render(
      <RemoteConflictDialog
        conflict={{
          path: "/work/coexists",
          url: "https://spec.example.test/api/specseal/v1/projects/demo",
          repo: "backend",
        }}
        onContinueLocal={continueLocal}
        onUseServer={useServer}
        onMigrateLocal={migrateLocal}
      />,
      { wrapper: zhWrapper },
    );

    expect(screen.getByText(/备份后弃用本机内容.*不会上传或合并/)).toBeTruthy();
    // 三个出口是平等的选择，不是状态：语汇统一为中性卡，颜色不暗示「哪个比较对」。
    for (const name of [/^继续本机/, /^以 Server 为准/, /^迁移本机内容/]) {
      const cls = screen.getByRole("button", { name }).className;
      expect(cls).toContain("border-border");
      expect(cls).not.toContain("status-warning");
      expect(cls).not.toContain("bg-primary");
    }
    fireEvent.click(screen.getByRole("button", { name: /^继续本机/ }));
    fireEvent.click(screen.getByRole("button", { name: /^以 Server 为准/ }));
    await waitFor(() => expect(useServer).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /^迁移本机内容/ }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: /^迁移本机内容/ }));

    await waitFor(() => expect(continueLocal).toHaveBeenCalledTimes(1));
    expect(migrateLocal).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });

  it("处理中三张卡停用：无 hover 底色（spec desktop-app「可点元素的光标与 hover 回馈」；design D4）", async () => {
    render(
      <RemoteConflictDialog
        conflict={{ path: "/work/coexists", url: "https://spec.example.test/api/specseal/v1/projects/demo", repo: "backend" }}
        onContinueLocal={vi.fn().mockResolvedValue(undefined)}
        onUseServer={vi.fn(() => new Promise<void>(() => {}))}
        onMigrateLocal={vi.fn()}
      />,
      { wrapper: zhWrapper },
    );
    const names = [/^继续本机/, /^以 Server 为准/, /^迁移本机内容/];
    fireEvent.click(screen.getByRole("button", { name: names[1] }));
    for (const name of names) {
      const card = screen.getByRole("button", { name }) as HTMLButtonElement;
      await waitFor(() => expect(card.disabled).toBe(true));
      expectHoverOnlyWhenEnabled(card);
    }
  });
});

// --- chooser 内就地登录回馈（规格「device login 缺省与 PAT fallback」的
// 「从工作区选择器发起登录同样呈现等待授权面」；design 决策三）：真 store 驱动
// ——添加并登录后，等待授权面／PAT 输入就在选择器的 server 步骤渲染。 ---

describe("WorkspaceChooser 登录回馈", () => {
  const APPROVAL: LoginPhase = {
    kind: "awaitingApproval",
    userCode: "ABCD-EFGH",
    verificationUri: "http://localhost:8080/activate",
    expiresAt: Date.now() + 900_000,
  };
  const BROWSER: LoginPhase = {
    kind: "awaitingBrowser",
    url: "https://id.example.com/authorize?response_type=code&state=s1&code_challenge=c1&code_challenge_method=S256",
    expiresAt: Date.now() + 300_000,
  };

  /** 停在等待面的登录：送出阶段后一直等，直到 loginCancel 或测试代为完成。 */
  function waitingLogin(phase: LoginPhase) {
    let resolve: (result: LoginResult) => void = () => {};
    const loginStart = vi.fn(
      (_origin: string, onPhase: (p: LoginPhase) => void) =>
        new Promise<LoginResult>((r) => {
          resolve = r;
          onPhase(phase);
        }),
    );
    const loginCancel = vi.fn(async () => resolve({ status: "cancelled" }));
    return { loginStart, loginCancel, finish: (result: LoginResult) => resolve(result) };
  }

  /** 假 adapter：in-memory registry；启动段行为由测试覆写。 */
  function storeAdapter(over: Partial<ConnectionsAdapter> = {}): ConnectionsAdapter {
    const entries: Array<Omit<ConnectionView, "loggedIn">> = [];
    const loggedIn = new Set<string>();
    return {
      list: async () => entries.map((e) => ({ ...e, loggedIn: loggedIn.has(e.origin) })),
      add: async (baseUrl, name) => {
        const origin = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
        const entry = { id: `conn_${entries.length + 1}`, origin, name };
        entries.push(entry);
        return { ...entry, loggedIn: false };
      },
      remove: async () => {},
      ...waitingLogin(APPROVAL),
      patLogin: async (origin) => {
        loggedIn.add(origin);
        const entry = entries.find((e) => e.origin === origin);
        if (entry) entry.lastActorDisplay = "Momo";
        return { status: "loggedIn", display: "Momo" };
      },
      logout: async () => ({ revokedOnServer: true, patNotice: false }),
      scopes: async () => SCOPES,
      inspectCheckout: async (path) => ({ root: path, tools: [] }),
      bindCheckout: async (path) => path,
      ...over,
    };
  }

  function ChooserHarness({ useStore }: { useStore: UseBoundStore<StoreApi<AppState>> }) {
    const s = useStore();
    return (
      <WorkspaceChooser
        open
        onOpenChange={() => {}}
        connections={s.connections}
        phases={s.connectionPhases}
        connectionAdapter={fakeConnections()}
        workspace={fakeWorkspace()}
        onOpenLocal={async () => {}}
        onAddServer={s.addConnection}
        onCancelLogin={s.cancelLogin}
        onSubmitPat={s.submitPat}
        onRefreshConnections={s.refreshConnections}
        onOpenRemote={async () => {}}
        recents={[]}
        onRemoveRecent={vi.fn()}
      />
    );
  }

  function renderWithStore(adapter: ConnectionsAdapter) {
    const useStore = createAppStore({
      createSession: () => ({}) as WorkspaceSession,
      connections: adapter,
    });
    render(<ChooserHarness useStore={useStore} />, { wrapper: zhWrapper });
    return useStore;
  }

  /** 走到 server 步骤并送出添加并登录。 */
  function addAndLogin() {
    chooseSource("server");
    fireEvent.click(screen.getByRole("button", { name: "添加 server" }));
    fireEvent.change(screen.getByLabelText("服务器地址（http://…）"), {
      target: { value: "http://localhost:8080" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加并登录" }));
  }

  it("添加并登录后选择器内就地显示等待授权面", async () => {
    renderWithStore(storeAdapter());
    addAndLogin();

    const waiting = await screen.findByTestId("awaiting-approval-http://localhost:8080");
    expect(waiting.textContent).toContain("ABCD-EFGH");
    expect(waiting.textContent).toContain("http://localhost:8080/activate");
    expect(waiting.textContent).toMatch(/\d+:\d{2}/);
    expect(screen.getByRole("button", { name: "取消登录" })).toBeTruthy();
  });

  it("取消即调用取消、面消失且停留在 server 步骤", async () => {
    const login = waitingLogin(APPROVAL);
    renderWithStore(storeAdapter(login));
    addAndLogin();
    await screen.findByTestId("awaiting-approval-http://localhost:8080");

    fireEvent.click(screen.getByRole("button", { name: "取消登录" }));
    await waitFor(() =>
      expect(screen.queryByTestId("awaiting-approval-http://localhost:8080")).toBeNull(),
    );
    expect(login.loginCancel).toHaveBeenCalledWith("http://localhost:8080");
    // 仍在 server 步骤（添加 server 的开关还在）。
    expect(screen.getByRole("button", { name: "添加 server" })).toBeTruthy();
  });

  it("添加并登录声明浏览器登录的 server 时就地显示等待浏览器登录面，完成后出现在已登录清单", async () => {
    const login = waitingLogin(BROWSER);
    const adapter = storeAdapter(login);
    let signedIn = false;
    renderWithStore({
      ...adapter,
      list: async () =>
        (await adapter.list()).map((entry) => ({ ...entry, loggedIn: signedIn, lastActorDisplay: signedIn ? "Momo" : null })),
    });
    addAndLogin();

    const waiting = await screen.findByTestId("awaiting-browser-http://localhost:8080");
    expect(waiting.textContent).toContain(BROWSER.kind === "awaitingBrowser" ? BROWSER.url : "");
    expect(waiting.textContent).toMatch(/\d+:\d{2}/);
    expect(screen.queryByTestId("awaiting-approval-http://localhost:8080")).toBeNull();

    signedIn = true;
    act(() => login.finish({ status: "loggedIn", display: "Momo" }));
    await waitFor(() => expect(screen.queryByTestId("awaiting-browser-http://localhost:8080")).toBeNull());
    await waitFor(() => expect(screen.getByText(/Momo/)).toBeTruthy());
  });

  it("需要访问密钥时选择器内就地现 PAT 输入并可完成登录", async () => {
    renderWithStore(
      storeAdapter({ loginStart: async () => ({ status: "patRequired" }) }),
    );
    addAndLogin();

    const patInput = await screen.findByPlaceholderText("spk_pat_…");
    fireEvent.change(patInput, { target: { value: "spk_pat_good" } });
    fireEvent.click(screen.getByRole("button", { name: "以 PAT 登录" }));
    // 登录完成：连接出现在已登录清单（ChoiceCard 标题）。
    await waitFor(() => expect(screen.getByText(/Momo/)).toBeTruthy());
  });
});

describe("最近打开清单（spec 需求「最近打开清单」；design D3 显示期过滤、D4 点击打开与失效错误态）", () => {
  const LOCAL_RECENT: RecentEntry = {
    locator: { kind: "local", root: "/work/specseal" },
    name: "specseal",
  };
  const REMOTE_RECENT: RecentEntry = {
    locator: {
      kind: "remote",
      connectionId: "conn_1",
      projectId: "prj_1",
      repoId: "repo_1",
      checkoutRoot: "/work/desktop",
    },
    name: "Specseal/Desktop",
  };

  it("recents 为空时第一步没有「最近打开」区段", () => {
    renderChooser();
    expect(screen.queryByText("最近打开")).toBeNull();
    expect(screen.getByRole("button", { name: /本机文档夹/ })).toBeTruthy();
  });

  it("本机列显示名称与路径、remote 列显示连接名称与显示名", async () => {
    await renderChooser({ recents: [LOCAL_RECENT, REMOTE_RECENT] });
    expect(screen.getByText("最近打开")).toBeTruthy();
    const local = screen.getByRole("button", { name: /\/work\/specseal/ });
    expect(local.textContent).toContain("specseal");
    const remote = screen.getByRole("button", { name: /团队 Server/ });
    expect(remote.textContent).toContain("Specseal/Desktop");
    // 既有两张来源卡仍在，且可及性名称不变。
    expect(screen.getByRole("button", { name: /本机文档夹/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Server/ })).toBeTruthy();
  });

  it("点本机列先探测再沿既有本机打开流程并关闭 chooser（spec Scenario 点本机条目直接打开）", async () => {
    const workspace = fakeWorkspace({
      openProject: vi
        .fn()
        .mockResolvedValue({ status: "project", root: "/work/specseal", name: "specseal" }),
    });
    const { onOpenLocal, onOpenChange } = await renderChooser({
      workspace,
      recents: [LOCAL_RECENT],
    });
    fireEvent.click(screen.getByRole("button", { name: /\/work\/specseal/ }));
    await waitFor(() => expect(onOpenLocal).toHaveBeenCalledWith("/work/specseal"));
    expect(workspace.openProject).toHaveBeenCalledWith("/work/specseal");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // 不走首次选文档夹的「打开本机／迁移」子画面。
    expect(screen.queryByRole("button", { name: "打开本机" })).toBeNull();
  });

  it("探测抛错时该列转错误态并显示原因，不打开（spec Scenario 本机文档夹已消失时转错误态）", async () => {
    const workspace = fakeWorkspace({
      openProject: vi.fn().mockRejectedValue(new Error("cannot open '/work/specseal'")),
    });
    const { onOpenLocal, onOpenChange } = await renderChooser({
      workspace,
      recents: [LOCAL_RECENT],
    });
    fireEvent.click(screen.getByRole("button", { name: /\/work\/specseal/ }));
    await waitFor(() =>
      expect(screen.getByText(/cannot open '\/work\/specseal'/)).toBeTruthy(),
    );
    expect(onOpenLocal).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // 错误态的列仍可再点重试，也仍可移除。
    expect(
      (screen.getByRole("button", { name: /\/work\/specseal/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.getByRole("button", { name: "自最近打开移除 specseal" })).toBeTruthy();
  });

  it("点 remote 列以原 connection、projectId/repoId 与 checkoutRoot 打开（spec Scenario 点 remote 条目以原绑定打开）", async () => {
    const { onOpenRemote } = await renderChooser({ recents: [REMOTE_RECENT] });
    fireEvent.click(screen.getByRole("button", { name: /团队 Server/ }));
    await waitFor(() =>
      expect(onOpenRemote).toHaveBeenCalledWith("conn_1", "prj_1/repo_1", "/work/desktop"),
    );
  });

  it("remote handshake 抛错时该列显示原因", async () => {
    const onOpenRemote = vi.fn().mockRejectedValue(new Error("access denied — no access"));
    await renderChooser({ recents: [REMOTE_RECENT], onOpenRemote });
    fireEvent.click(screen.getByRole("button", { name: /团队 Server/ }));
    await waitFor(() => expect(screen.getByText(/access denied/)).toBeTruthy());
  });

  it("连接已移除的 remote 列直接呈现错误态、打开停用、可移除（spec Scenario remote 连接已移除时直接呈现错误态）", async () => {
    const gone: RecentEntry = {
      ...REMOTE_RECENT,
      locator: { ...REMOTE_RECENT.locator, connectionId: "conn_gone" } as RecentEntry["locator"],
    };
    const { onRemoveRecent, onOpenRemote } = await renderChooser({ recents: [gone] });
    await waitFor(() => expect(screen.getByText("连接已移除")).toBeTruthy());
    const row = screen.getByRole("button", { name: /连接已移除/ }) as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    fireEvent.click(row);
    expect(onOpenRemote).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "自最近打开移除 Specseal/Desktop" }));
    expect(onRemoveRecent).toHaveBeenCalledWith("remote:conn_gone/prj_1/repo_1");
  });

  it("移除钮以 locator key 调用 onRemoveRecent（spec Scenario 移除条目后重启不再出现）", async () => {
    const { onRemoveRecent, onOpenLocal } = await renderChooser({ recents: [LOCAL_RECENT] });
    fireEvent.click(screen.getByRole("button", { name: "自最近打开移除 specseal" }));
    expect(onRemoveRecent).toHaveBeenCalledWith("local:/work/specseal");
    expect(onOpenLocal).not.toHaveBeenCalled();
  });
});

describe("最近打开清单的补强（review／verify 第 1 轮 WARNING）", () => {
  const LOCAL: RecentEntry = {
    locator: { kind: "local", root: "/work/specseal" },
    name: "specseal",
  };
  const REMOTE: RecentEntry = {
    locator: {
      kind: "remote",
      connectionId: "conn_1",
      projectId: "prj_1",
      repoId: "repo_1",
      checkoutRoot: "/work/desktop",
    },
    name: "Specseal/Desktop",
  };

  it("点未初始化文档夹的条目仍转交既有打开流程（spec Scenario 点未初始化文档夹的条目仍走 init 确认）", async () => {
    const workspace = fakeWorkspace({
      openProject: vi.fn().mockResolvedValue({ status: "uninitialized", dir: "/work/specseal" }),
    });
    const { onOpenLocal, onOpenChange } = await renderChooser({ workspace, recents: [LOCAL] });
    fireEvent.click(screen.getByRole("button", { name: /\/work\/specseal/ }));
    // 探测成功即交给既有 openProjectAt——init 确认框由它负责，chooser 不自行写入。
    await waitFor(() => expect(onOpenLocal).toHaveBeenCalledWith("/work/specseal"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("button", { name: "打开本机" })).toBeNull();
  });

  it("连接已注销时该列以错误态呈现且停用打开", async () => {
    const loggedOut: ConnectionView = { ...CONNECTION, loggedIn: false };
    await renderChooser({ recents: [REMOTE], connections: [loggedOut] });
    await waitFor(() => expect(screen.getByText("连接已注销")).toBeTruthy());
    expect(
      (screen.getByRole("button", { name: /连接已注销/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("点 remote 列先验证 checkout 绑定，失败即转错误态不打开", async () => {
    const inspect = vi.fn().mockRejectedValue(new Error("找不到 checkout 文档夹 /work/desktop"));
    const adapter = fakeConnections({ inspectCheckout: inspect });
    const { onOpenRemote } = await renderChooser({ adapter, recents: [REMOTE] });
    fireEvent.click(screen.getByRole("button", { name: /团队 Server/ }));
    await waitFor(() =>
      expect(screen.getByText(/找不到 checkout 文档夹/)).toBeTruthy(),
    );
    expect(inspect).toHaveBeenCalledWith(
      "/work/desktop",
      "https://spec.example.test",
      "prj_1",
      "repo_1",
    );
    expect(onOpenRemote).not.toHaveBeenCalled();
  });

  it("无 checkout 绑定的 remote 列不做 inspect，直接打开", async () => {
    const specOnly: RecentEntry = {
      ...REMOTE,
      locator: { ...REMOTE.locator, checkoutRoot: undefined } as RecentEntry["locator"],
    };
    const adapter = fakeConnections();
    const { onOpenRemote } = await renderChooser({ adapter, recents: [specOnly] });
    fireEvent.click(screen.getByRole("button", { name: /团队 Server/ }));
    await waitFor(() =>
      expect(onOpenRemote).toHaveBeenCalledWith("conn_1", "prj_1/repo_1", undefined),
    );
    expect(adapter.inspectCheckout).not.toHaveBeenCalled();
  });
});

describe("连接清单加载结果决定错误态（review 第 2 轮 WARNING）", () => {
  const REMOTE_ROW: RecentEntry = {
    locator: {
      kind: "remote",
      connectionId: "conn_1",
      projectId: "prj_1",
      repoId: "repo_1",
      checkoutRoot: "/work/desktop",
    },
    name: "Specseal/Desktop",
  };

  it("连接清单读取失败时不把 remote 列判成已移除", async () => {
    const onRefreshConnections = vi.fn().mockResolvedValue(false);
    await renderChooser({ recents: [REMOTE_ROW], connections: [], onRefreshConnections });
    await waitFor(() => expect(onRefreshConnections).toHaveBeenCalled());
    expect(screen.queryByText("连接已移除")).toBeNull();
    expect(recentOpenButton(/Specseal\/Desktop/).disabled).toBe(false);
  });

  it("读取成功且清单真的空时才判成已移除", async () => {
    const onRefreshConnections = vi.fn().mockResolvedValue(true);
    await renderChooser({ recents: [REMOTE_ROW], connections: [], onRefreshConnections });
    await waitFor(() => expect(screen.getByText("连接已移除")).toBeTruthy());
    expect(
      (screen.getByRole("button", { name: /连接已移除/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("重整仍在进行中时 remote 列不判为已移除（尚未 settle 的窗口）", async () => {
    let release: (value: boolean) => void = () => {};
    const pending = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    await renderChooser({
      recents: [REMOTE_ROW],
      connections: [],
      onRefreshConnections: vi.fn().mockReturnValue(pending),
    });
    // renderChooser 的 act 冲洗不会让一个尚未 resolve 的 promise 落定。
    expect(screen.queryByText("连接已移除")).toBeNull();
    expect(recentOpenButton(/Specseal\/Desktop/).disabled).toBe(false);
    await act(async () => {
      release(true);
    });
    // 读取成功且清单真的空——此时才判定。
    await waitFor(() => expect(screen.getByText("连接已移除")).toBeTruthy());
  });

  it("清单未就绪时规格模式的 remote 列照样开得起来", async () => {
    const specOnly: RecentEntry = {
      ...REMOTE_ROW,
      locator: { ...REMOTE_ROW.locator, checkoutRoot: undefined } as RecentEntry["locator"],
    };
    const onOpenRemote = vi.fn().mockResolvedValue(undefined);
    await renderChooser({
      recents: [specOnly],
      connections: [],
      onRefreshConnections: vi.fn().mockResolvedValue(false),
      onOpenRemote,
    });
    fireEvent.click(recentOpenButton(/Specseal\/Desktop/));
    await waitFor(() =>
      expect(onOpenRemote).toHaveBeenCalledWith("conn_1", "prj_1/repo_1", undefined),
    );
    expect(screen.queryByText("连接已移除")).toBeNull();
  });

  it("清单未就绪时点 checkout 绑定的 remote 列不留下带 Error 前缀的消息", async () => {
    const onRefreshConnections = vi.fn().mockResolvedValue(false);
    const onOpenRemote = vi.fn().mockResolvedValue(undefined);
    const adapter = fakeConnections();
    await renderChooser({
      adapter,
      recents: [REMOTE_ROW],
      connections: [],
      onRefreshConnections,
      onOpenRemote,
    });
    fireEvent.click(recentOpenButton(/Specseal\/Desktop/));
    await waitFor(() => expect(screen.getByText("连接已移除")).toBeTruthy());
    expect(screen.queryByText(/^Error: /)).toBeNull();
    expect(adapter.inspectCheckout).not.toHaveBeenCalled();
    expect(onOpenRemote).not.toHaveBeenCalled();
  });
});

// 服务器页「缺省」卡（desktop-settings-mode design D7；spec「缺省连接于添加项目预选」）。
describe("添加远程项目时缺省使用的连接", () => {
  const OTHER: ConnectionView = { ...CONNECTION, id: "conn_2", origin: "https://b.example.test", name: "备援 Server" };

  it("指向已登录连接时 Server 步骤预选该列（仍可改选）、不自动前进", async () => {
    await renderChooser({ connections: [CONNECTION, OTHER], defaultConnectionId: "conn_2" });
    chooseSource("server");
    expect(screen.getByRole("radio", { name: /备援 Server/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /团队 Server/ }).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("radio", { name: /Desktop/ })).toBeNull();
  });

  it("带入口意图（marker 指向的服务器、未登录的连接）打开时不预选缺省连接", async () => {
    // remote marker 指向尚未登录的服务器：预选缺省连接会让「下一步」把文档夹绑到错的服务器。
    await renderChooser({
      connections: [CONNECTION, OTHER],
      defaultConnectionId: "conn_2",
      initialServerUrl: "https://marker.example.test",
    });
    expect(screen.getByRole("radio", { name: /备援 Server/ }).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("button", { name: "下一步" })).toBeNull();
  });

  it("指向已注销或不存在的连接时不预选", async () => {
    await renderChooser({
      connections: [CONNECTION, { ...OTHER, loggedIn: false }],
      defaultConnectionId: "conn_2",
    });
    chooseSource("server");
    expect(screen.getByRole("radio", { name: /团队 Server/ }).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("radio", { name: /备援 Server/ })).toBeNull();
  });
});

// 图标列（design D3；desktop-config「项目分页列存于 app 本机」、desktop-app「分页切换中
// 即时回馈」）：品牌标记、每项目一个首字母方块、「＋」、底部齿轮。原 projectTabs.test.tsx
// 的案例逐条搬过来（方块取代分页），再补 tooltip、角落状态点、错误菜单与齿轮。
import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider, SEMANTIC_TONE } from "@specseal/ui";

import { ProjectRail, type ProjectRailProps } from "../components/ProjectRail";
import type { ProjectActions } from "../components/ProjectActionsMenu";
import { APP_MESSAGES } from "../i18n/messages";
import type { ProjectTab } from "../tabs";
import type { RemoteWorkspaceRecoveryState, WorkspaceLocator } from "../session";

const zh = APP_MESSAGES["zh-CN"];
const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
    {children}
  </I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

const local = (root: string): WorkspaceLocator => ({ kind: "local", root });
const KEY_ALPHA = "local:C:\\proj\\alpha";
const KEY_BETA = "local:C:\\proj\\beta";

const tabs: ProjectTab[] = [
  { locator: local("C:\\proj\\alpha"), name: "alpha" },
  { locator: local("C:\\proj\\beta"), name: "beta" },
];

function fakeActions(): ProjectActions {
  return {
    reveal: vi.fn(),
    openTerminal: vi.fn(),
    openEditor: vi.fn(),
    copyPath: vi.fn(),
    refresh: vi.fn(),
    close: vi.fn(),
  };
}

function renderRail(over: Partial<ProjectRailProps> = {}) {
  const props: ProjectRailProps = {
    tabs,
    activeKey: KEY_ALPHA,
    tabErrors: {},
    platform: "macos",
    actions: fakeActions(),
    ...over,
  };
  render(<ProjectRail {...props} />);
  return props;
}

const square = (key: string) =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-tab]")).find(
    (el) => el.getAttribute("data-tab") === key,
  ) as HTMLElement;

describe("ProjectRail", () => {
  it("品牌标记在顶、方块依序一个项目一个、作用中为主色底", () => {
    renderRail();
    const rail = document.querySelector("[data-project-rail]") as HTMLElement;
    expect(rail.firstElementChild?.getAttribute("aria-label")).toBe("Specseal");
    const list = screen.getByRole("tablist", { name: zh["app.projectRail"] });
    const squares = within(list).getAllByRole("tab");
    expect(squares.map((s) => s.textContent)).toEqual(["A", "B"]);
    expect(squares[0].getAttribute("aria-selected")).toBe("true");
    expect(squares[0].className).toContain("bg-primary");
    expect(squares[1].getAttribute("aria-selected")).toBe("false");
    expect(squares[1].className).not.toContain("bg-primary");
    expect(squares[1].className).toContain("bg-muted");
  });

  it("方块无任何计数徽章（spec「分页不显示计数徽章」）", () => {
    renderRail();
    expect(document.querySelector("[data-badge]")).toBeNull();
    for (const tab of screen.getAllByRole("tab")) expect(tab.textContent).toMatch(/^[A-Z]$/);
  });

  it("CJK 显示名取第一个字", () => {
    renderRail({ tabs: [{ locator: local("/w/规格"), name: "规格中心" }], activeKey: null });
    expect(screen.getByRole("tab").textContent).toBe("规");
  });

  it("点背景方块以其 locator key 调用 onActivate；点作用中方块不动作", () => {
    const onActivate = vi.fn();
    renderRail({ onActivate });
    fireEvent.click(square(KEY_BETA));
    fireEvent.click(square(KEY_ALPHA));
    expect(onActivate.mock.calls).toEqual([[KEY_BETA]]);
  });

  it("右键方块弹出项目动作菜单；「关闭项目」以该 key 调用 close、不切换", () => {
    const onActivate = vi.fn();
    const { actions } = renderRail({ onActivate });
    fireEvent.contextMenu(square(KEY_BETA));
    expect(screen.getAllByRole("menuitem")).toHaveLength(6);
    fireEvent.click(screen.getByRole("menuitem", { name: /^关闭项目/ }));
    expect(actions.close).toHaveBeenCalledWith(KEY_BETA);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("「＋」虚线方块调用 onOpen", () => {
    const onOpen = vi.fn();
    renderRail({ onOpen });
    const plus = screen.getByRole("button", { name: zh["app.newProject"] });
    expect(plus.className).toContain("border-dashed");
    fireEvent.click(plus);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("底部齿轮调用 onOpenSettings，settingsActive 时为主色底", () => {
    const onOpenSettings = vi.fn();
    renderRail({ onOpenSettings, settingsActive: true });
    const gear = screen.getByRole("button", { name: zh["app.navSettings"] });
    expect(gear.className).toContain("bg-primary");
    fireEvent.click(gear);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("齿轮非作用中时无主色底", () => {
    renderRail({ settingsActive: false });
    expect(screen.getByRole("button", { name: zh["app.navSettings"] }).className).not.toContain(
      "bg-primary",
    );
  });

  it("路径失效的本机方块：角落红点、点击开错误菜单（消息＋自项目列移除）而不切换", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const { actions } = renderRail({ onActivate, tabErrors: { [KEY_BETA]: "目录不存在" } });
    const beta = square(KEY_BETA);
    expect(beta.getAttribute("data-error")).toBe("true");
    expect(beta.querySelector("[data-tab-dot]")?.className).toContain("bg-destructive");
    await user.click(beta);
    expect(onActivate).not.toHaveBeenCalled();
    expect(screen.getByText("目录不存在")).toBeTruthy();
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([zh["app.removeTab"]]);
    await user.click(screen.getByRole("menuitem", { name: zh["app.removeTab"] }));
    expect(actions.close).toHaveBeenCalledWith(KEY_BETA);
  });

  it("路径失效的本机方块按右键：同样弹出错误变体（消息＋自项目列移除）", () => {
    const { actions } = renderRail({ tabErrors: { [KEY_BETA]: "目录不存在" } });
    fireEvent.contextMenu(square(KEY_BETA));
    expect(screen.getByText("目录不存在")).toBeTruthy();
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([zh["app.removeTab"]]);
    fireEvent.click(screen.getByRole("menuitem", { name: zh["app.removeTab"] }));
    expect(actions.close).toHaveBeenCalledWith(KEY_BETA);
  });

  it("本机方块 tooltip 显示显示名与完整路径", async () => {
    renderRail();
    fireEvent.focus(square(KEY_BETA));
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toContain("beta");
    expect(tip.textContent).toContain("C:\\proj\\beta");
  });

  it("remote 有 checkout：tooltip 明示连接的 checkout 路径", async () => {
    renderRail({
      tabs: [
        {
          locator: {
            kind: "remote",
            connectionId: "c1",
            projectId: "demo",
            repoId: "backend",
            checkoutRoot: "/work/backend",
          },
          name: "Demo/backend",
        },
      ],
      activeKey: "remote:c1/demo/backend",
    });
    fireEvent.focus(screen.getByRole("tab"));
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toContain("Demo/backend");
    expect(tip.textContent).toContain("已连接 checkout：/work/backend");
  });

  it("remote 无 checkout：tooltip 显示连接名称加 Project/Repo", async () => {
    renderRail({
      tabs: [
        {
          locator: { kind: "remote", connectionId: "c1", projectId: "demo", repoId: "api" },
          name: "Demo/api",
        },
      ],
      activeKey: null,
      connectionNames: { c1: "公司 Server" },
    });
    fireEvent.focus(screen.getByRole("tab"));
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toContain("公司 Server · demo/api");
  });

  it("remote 复原错误仍是可选的目的地：红点、tooltip 只给精简状态不露技术细节", async () => {
    const onActivate = vi.fn();
    const recoveryStates: Record<string, RemoteWorkspaceRecoveryState> = {
      "remote:c1/demo/backend": {
        status: "error",
        failure: {
          kind: "unreachable",
          message: "server unreachable — technical detail only",
          reason: null,
          status: null,
        },
      },
    };
    renderRail({
      tabs: [
        {
          locator: { kind: "remote", connectionId: "c1", projectId: "demo", repoId: "backend" },
          name: "Demo/backend",
        },
      ],
      activeKey: null,
      tabErrors: { "remote:c1/demo/backend": "server unreachable — technical detail only" },
      recoveryStates,
      onActivate,
    });
    const tab = screen.getByRole("tab", { name: /Demo\/backend/ });
    expect(tab.getAttribute("data-status")).toBe("error");
    // spec「错误态以红呈现」：连不上是错误，不能与 offline／需重新登录的琥珀同色。
    const dot = tab.querySelector("[data-tab-dot]") as HTMLElement;
    expect(dot.className).toContain("bg-destructive");
    expect(dot.className).not.toContain("status-warning");
    fireEvent.click(tab);
    expect(onActivate).toHaveBeenCalledWith("remote:c1/demo/backend");
    fireEvent.focus(tab);
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toContain("无法连接");
    expect(tip.textContent).not.toContain("technical detail");
  });

  it("remote 脱机或需重新登录：角落琥珀点", () => {
    renderRail({
      tabs: [
        {
          locator: { kind: "remote", connectionId: "c1", projectId: "demo", repoId: "api" },
          name: "Demo/api",
        },
        {
          locator: { kind: "remote", connectionId: "c1", projectId: "demo", repoId: "web" },
          name: "Demo/web",
        },
      ],
      activeKey: null,
      connectionStates: {
        "remote:c1/demo/api": { connectionId: "c1", state: "offline", message: null },
        "remote:c1/demo/web": { connectionId: "c1", state: "needs-reauth", message: null },
      },
    });
    for (const key of ["remote:c1/demo/api", "remote:c1/demo/web"]) {
      expect(square(key).querySelector("[data-tab-dot]")?.className).toContain("bg-status-warning");
    }
  });

  it("assetPrompts 有值的背景方块：角落琥珀点、tooltip 附「技能档需要处理」（spec「其他项目的状况以琥珀点提示」）", async () => {
    renderRail({
      assetPrompts: {
        [KEY_ALPHA]: null,
        [KEY_BETA]: { kind: "stale", fileCount: 2, version: "v1.3.0", projectVersion: "v0.9.0" },
      },
    });
    // 与 remote 脱机点同一颗、同色；无状况的方块无点。
    expect(square(KEY_BETA).querySelector("[data-tab-dot]")?.className).toContain("bg-status-warning");
    expect(square(KEY_ALPHA).querySelector("[data-tab-dot]")).toBeNull();
    expect(square(KEY_BETA).getAttribute("aria-label")).toContain("技能档需要处理");
    fireEvent.focus(square(KEY_BETA));
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toContain("技能档需要处理");
    // 文案不含版号：背景分页的点是上次看过时的状态。
    expect(tip.textContent).not.toContain("v1.3.0");
  });

  it("背景复原中的方块：鼠标与键盘皆可激活，还原 spinner 为进行中色", () => {
    const onActivate = vi.fn();
    renderRail({
      tabs: [
        {
          locator: { kind: "remote", connectionId: "c1", projectId: "demo", repoId: "backend" },
          name: "Demo/backend",
        },
      ],
      activeKey: null,
      recoveryStates: { "remote:c1/demo/backend": { status: "restoring", failure: null } },
      onActivate,
    });
    const tab = screen.getByRole("tab", { name: /Demo\/backend/ });
    fireEvent.keyDown(tab, { key: "Enter" });
    fireEvent.click(tab);
    expect(onActivate).toHaveBeenCalledTimes(2);
    expect(tab.getAttribute("data-status")).toBe("restoring");
    expect(tab.querySelector('[data-tab-status="restoring"]')?.getAttribute("class")).toContain(
      SEMANTIC_TONE.inProgress,
    );
  });
});

// spec「分页切换中即时回馈」（design D1）：探测挡在翻页前，目标方块先出 spinner。
describe("切换中方块 spinner", () => {
  it("pendingKey 指向的方块以 spinner 取代首字母，aria-label 含「正在切换」", () => {
    renderRail({ pendingKey: KEY_BETA });
    const beta = square(KEY_BETA);
    expect(beta.textContent).toBe("");
    expect(beta.querySelector('[data-tab-status="pending"]')?.getAttribute("class")).toContain(
      "animate-spin",
    );
    expect(beta.getAttribute("aria-label")).toContain(zh["app.tabSwitching"]);
  });

  it("spinner 带切换中语意的无障碍标签", () => {
    renderRail({ pendingKey: KEY_BETA });
    expect(screen.getByLabelText(zh["app.tabSwitching"])).toBeTruthy();
  });

  it("非 pending 的方块不出 spinner", () => {
    renderRail({ pendingKey: KEY_BETA });
    expect(square(KEY_ALPHA).querySelector('[data-tab-status="pending"]')).toBeNull();
    expect(square(KEY_ALPHA).textContent).toBe("A");
  });

  it("未给 pendingKey → 全部方块照旧，无 spinner", () => {
    renderRail();
    expect(document.querySelector('[data-tab-status="pending"]')).toBeNull();
  });

  // 错误方块经快捷键重探：仍在错误态但正在重探，切换中回馈优先，红点照旧。
  it("重探错误方块时 spinner 盖过首字母，错误红点照旧", () => {
    renderRail({ tabErrors: { [KEY_BETA]: "目录不存在" }, pendingKey: KEY_BETA });
    const beta = square(KEY_BETA);
    expect(beta.querySelectorAll("[data-tab-status]")).toHaveLength(1);
    expect(beta.querySelector('[data-tab-status="pending"]')).toBeTruthy();
    expect(beta.getAttribute("data-error")).toBe("true");
    expect(beta.querySelector("[data-tab-dot]")?.className).toContain("bg-destructive");
  });
});

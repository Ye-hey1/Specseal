// ServersPanel（规格「服务器管理最小面」＋「device login 缺省与 PAT fallback」
// 的前端面；client-browser-login D7、D9）：假 adapter 驱动真 store——添加→清单
// 即现、需要访问密钥→PAT 输入现身、登录成功→显示身分、注销→回未登录、拒绝→
// 可读状态、等待浏览器登录或设备核准→就地的等待面。等待的循环在 Rust；假
// adapter 以 onPhase 送出阶段、以 loginCancel 结束等待。credential 全程不出现在
// 任何断言面（TS 只见状态与显示名）。
import { describe, it, expect, vi } from "vitest";
import { cleanup, render as rtlRender, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { I18nProvider } from "@specseal/ui";

import { ServersPanel } from "../components/ServersPanel";
import { createAppStore, type AppState } from "../store";
import { APP_MESSAGES } from "../i18n/messages";
import type {
  ConnectionsAdapter,
  ConnectionView,
  LoginPhase,
  LoginResult,
} from "../adapter/connections";
import type { UseBoundStore, StoreApi } from "zustand";
import type { WorkspaceSession } from "../session";

const DISPLAY = "Dev <dev@example.com>";

/** 等待设备核准的阶段（Rust 送来的样子）。 */
const APPROVAL: LoginPhase = {
  kind: "awaitingApproval",
  userCode: "ABCD-EFGH",
  verificationUri: "http://localhost:8080/activate",
  expiresAt: Date.now() + 900_000,
};

/** 等待浏览器登录的阶段：授权网址只带 state 与 challenge。 */
const BROWSER: LoginPhase = {
  kind: "awaitingBrowser",
  url: "https://id.example.com/authorize?response_type=code&client_id=specseal&state=s1&code_challenge=c1&code_challenge_method=S256",
  expiresAt: Date.now() + 300_000,
};

/** 停在等待面的登录：送出阶段后一直等，直到 loginCancel 才以 cancelled 结束；
 * `finish` 让测试代替用户完成登录。 */
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

const { writeText } = vi.hoisted(() => ({ writeText: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText }));

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
    {children}
  </I18nProvider>
);

/** 假 adapter：in-memory registry＋可覆写的登录行为。 */
function fakeAdapter(over: Partial<ConnectionsAdapter> = {}) {
  const entries: Array<Omit<ConnectionView, "loggedIn">> = [];
  const loggedIn = new Set<string>();
  const adapter: ConnectionsAdapter = {
    list: async () =>
      entries.map((e) => ({ ...e, loggedIn: loggedIn.has(e.origin) })),
    add: async (baseUrl, name) => {
      const origin = baseUrl.trim().replace(/\/+$/, "");
      const existing = entries.find((e) => e.origin === origin);
      if (existing) {
        existing.name = name;
        return { ...existing, loggedIn: loggedIn.has(origin) };
      }
      const entry = { id: `conn_${entries.length + 1}`, origin, name };
      entries.push(entry);
      return { ...entry, loggedIn: false };
    },
    remove: async (id) => {
      const idx = entries.findIndex((e) => e.id === id);
      if (idx >= 0) {
        loggedIn.delete(entries[idx].origin);
        entries.splice(idx, 1);
      }
    },
    loginStart: async (origin): Promise<LoginResult> => {
      loggedIn.add(origin);
      const entry = entries.find((e) => e.origin === origin);
      if (entry) entry.lastActorDisplay = DISPLAY;
      return { status: "loggedIn", display: DISPLAY };
    },
    loginCancel: async () => {},
    patLogin: async (origin, pat) => {
      if (pat !== "spk_pat_good") throw new Error("PAT 无效或已被撤销");
      loggedIn.add(origin);
      const entry = entries.find((e) => e.origin === origin);
      if (entry) entry.lastActorDisplay = DISPLAY;
      return { status: "loggedIn", display: DISPLAY };
    },
    logout: async (origin) => {
      loggedIn.delete(origin);
      const entry = entries.find((e) => e.origin === origin);
      if (entry) entry.lastActorDisplay = null;
      return { revokedOnServer: true, patNotice: false };
    },
    scopes: async () => ({ projects: [] }),
    inspectCheckout: async (path) => ({ root: path, tools: [] }),
    bindCheckout: async (path) => path,
    ...over,
  };
  return adapter;
}

/** 真 store＋面板：面板 props 全数接线 store 的 connections 分片。 */
function Harness({
  useStore,
  onOpenWorkspace,
}: {
  useStore: UseBoundStore<StoreApi<AppState>>;
  onOpenWorkspace?: (id: string) => void;
}) {
  const s = useStore();
  return (
    <ServersPanel
      connections={s.connections}
      phases={s.connectionPhases}
      onAdd={s.addConnection}
      onLogin={s.loginConnection}
      onCancelLogin={s.cancelLogin}
      onSubmitPat={s.submitPat}
      onLogout={s.logoutConnection}
      onRemove={s.removeConnection}
      onRefresh={s.refreshConnections}
      onOpenWorkspace={onOpenWorkspace}
      // 服务器页的添加卡由页标题「添加连接」展开；此处直接展开以走添加表单。
      addOpen
    />
  );
}

/** 连接列：状态签「已登录」与身分显示名（desktop-settings-mode design D7）。 */
async function expectLoggedInAs(display: string) {
  await waitFor(() => expect(screen.getByText(display)).toBeTruthy());
  expect(screen.getByText("已登录")).toBeTruthy();
}

/** 连接列的「⋯」菜单动作。 */
async function rowMenu(item: string) {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.click(screen.getByRole("button", { name: "更多动作" }));
  await user.click(await screen.findByRole("menuitem", { name: item }));
}

function renderPanel(adapter: ConnectionsAdapter) {
  const useStore = createAppStore({
    createSession: () => ({}) as WorkspaceSession,
    connections: adapter,
  });
  rtlRender(<Harness useStore={useStore} />, { wrapper: zhWrapper });
  return useStore;
}

/** 走添加表单：填 URL＋显示名、按添加。 */
function addServer(url: string, name: string) {
  fireEvent.change(screen.getByPlaceholderText("服务器地址（http://…）"), {
    target: { value: url },
  });
  fireEvent.change(screen.getByPlaceholderText("显示名"), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "添加" }));
}

describe("ServersPanel", () => {
  it("添加后清单即时反映并进入登录流程，登录成功显示身分", async () => {
    renderPanel(fakeAdapter());
    addServer("http://localhost:8080/", "本地");

    // 清单即现条目（显示名＋范式 origin）。
    await waitFor(() => expect(screen.getByText("本地")).toBeTruthy());
    expect(screen.getByText("http://localhost:8080")).toBeTruthy();

    // 随即登录成功：呈现已登录与身分显示名。
    await expectLoggedInAs(DISPLAY);
  });

  it("server 只收访问密钥（或没有 device flow）时就地现 PAT 输入，有效 PAT 完成登录", async () => {
    const adapter = fakeAdapter();
    renderPanel({ ...adapter, loginStart: async () => ({ status: "patRequired" }) });
    addServer("http://legacy.example", "旧机");

    // 需要访问密钥 → PAT 输入直接现身，没有任何等待面。
    const patInput = await screen.findByPlaceholderText("spk_pat_…");
    expect(screen.queryByTestId("awaiting-approval-http://legacy.example")).toBeNull();
    expect(screen.queryByTestId("awaiting-browser-http://legacy.example")).toBeNull();
    fireEvent.change(patInput, { target: { value: "spk_pat_good" } });
    fireEvent.click(screen.getByRole("button", { name: "以 PAT 登录" }));

    await expectLoggedInAs(DISPLAY);
  });

  it("无效 PAT 拒绝并留在输入面", async () => {
    const adapter = fakeAdapter();
    renderPanel({
      ...adapter,
      loginStart: async () => ({ status: "patRequired" }),
    });
    addServer("http://legacy.example", "旧机");

    const patInput = await screen.findByPlaceholderText("spk_pat_…");
    fireEvent.change(patInput, { target: { value: "spk_pat_bad" } });
    fireEvent.click(screen.getByRole("button", { name: "以 PAT 登录" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("PAT 无效或已被撤销"),
    );
    // 输入面仍在，可重试。
    expect(screen.getByPlaceholderText("spk_pat_…")).toBeTruthy();
  });

  it("注销后回未登录", async () => {
    renderPanel(fakeAdapter());
    addServer("http://localhost:8080", "本地");
    await expectLoggedInAs(DISPLAY);

    fireEvent.click(screen.getByRole("button", { name: "注销" }));
    await waitFor(() => expect(screen.getByText("未登录")).toBeTruthy());
    expect(screen.queryByText(DISPLAY)).toBeNull();
  });

  it("浏览器拒绝授权呈现可读状态", async () => {
    const adapter = fakeAdapter();
    renderPanel({
      ...adapter,
      loginStart: async (_origin, onPhase) => {
        onPhase(APPROVAL);
        return { status: "denied", method: "device" };
      },
    });
    addServer("http://localhost:8080", "本地");

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("已在浏览器拒绝授权"));
    // 可读状态取代状态行；绝不呈现已登录。
    expect(screen.queryByText(/已登录/)).toBeNull();
  });

  it("探索失败显示连接错误，不出现 PAT 输入", async () => {
    const adapter = fakeAdapter();
    renderPanel({
      ...adapter,
      loginStart: async () => {
        throw new Error("server unavailable — check the connection url");
      },
    });
    addServer("http://localhost:8080", "本地");

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("server unavailable"));
    expect(screen.queryByPlaceholderText("spk_pat_…")).toBeNull();
  });

  // --- 等待授权面（规格「device login 缺省与 PAT fallback」的等待授权要求） ---

  /** 停在等待面的面板：登录送出 `phase` 后一直等，直到取消或测试代为完成。 */
  function renderAwaiting(phase: LoginPhase = APPROVAL) {
    const adapter = fakeAdapter();
    const login = waitingLogin(phase);
    const useStore = createAppStore({
      createSession: () => ({}) as WorkspaceSession,
      connections: { ...adapter, loginStart: login.loginStart, loginCancel: login.loginCancel },
    });
    rtlRender(<Harness useStore={useStore} />, { wrapper: zhWrapper });
    addServer("http://localhost:8080", "本地");
    return login;
  }

  it("等待授权时显示设备码、验证网址、倒数与取消", async () => {
    renderAwaiting();
    const waiting = await screen.findByTestId("awaiting-approval-http://localhost:8080");
    expect(waiting.textContent).toContain("ABCD-EFGH");
    expect(waiting.textContent).toContain("http://localhost:8080/activate");
    // 倒数（分:秒）与取消操作就在同一面。
    expect(waiting.textContent).toMatch(/\d+:\d{2}/);
    expect(screen.getByRole("button", { name: "取消登录" })).toBeTruthy();
  });

  it("设备码与验证网址各附拷贝，拷贝后剪贴板即为该内容", async () => {
    writeText.mockClear();
    renderAwaiting();
    await screen.findByTestId("awaiting-approval-http://localhost:8080");

    fireEvent.click(screen.getByRole("button", { name: "拷贝设备码" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ABCD-EFGH"));
    fireEvent.click(screen.getByRole("button", { name: "拷贝验证网址" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("http://localhost:8080/activate"));
  });

  it("取消等待即调用取消并回未登录", async () => {
    const login = renderAwaiting();
    await screen.findByTestId("awaiting-approval-http://localhost:8080");

    fireEvent.click(screen.getByRole("button", { name: "取消登录" }));
    await waitFor(() => expect(screen.getByText("未登录")).toBeTruthy());
    expect(login.loginCancel).toHaveBeenCalledWith("http://localhost:8080");
    expect(screen.queryByTestId("awaiting-approval-http://localhost:8080")).toBeNull();
  });

  // --- 等待浏览器登录面（client-browser-login D9） ---

  it("等待浏览器登录时就地显示说明、可拷贝的授权网址、倒数与取消，没有设备码", async () => {
    writeText.mockClear();
    renderAwaiting(BROWSER);
    const waiting = await screen.findByTestId("awaiting-browser-http://localhost:8080");
    expect(waiting.textContent).toContain("等待浏览器登录");
    expect(waiting.textContent).toContain(BROWSER.kind === "awaitingBrowser" ? BROWSER.url : "");
    expect(waiting.textContent).toMatch(/\d+:\d{2}/);
    expect(waiting.textContent).not.toContain("设备码");
    expect(screen.queryByTestId("awaiting-approval-http://localhost:8080")).toBeNull();
    // 状态签是等待授权。
    expect(screen.getByText("等待授权")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "拷贝登录网址" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(BROWSER.kind === "awaitingBrowser" ? BROWSER.url : ""),
    );
  });

  it("等待浏览器登录时取消即调用取消并回未登录", async () => {
    const login = renderAwaiting(BROWSER);
    await screen.findByTestId("awaiting-browser-http://localhost:8080");

    fireEvent.click(screen.getByRole("button", { name: "取消登录" }));
    await waitFor(() => expect(screen.getByText("未登录")).toBeTruthy());
    expect(login.loginCancel).toHaveBeenCalledWith("http://localhost:8080");
    expect(screen.queryByTestId("awaiting-browser-http://localhost:8080")).toBeNull();
  });

  it("浏览器登录被拒绝与逾时各有可读状态", async () => {
    for (const [status, message] of [
      ["denied", "已在登录服务拒绝登录"],
      ["expired", "浏览器登录逾时"],
    ] as const) {
      const login = renderAwaiting(BROWSER);
      await screen.findByTestId("awaiting-browser-http://localhost:8080");
      login.finish({ status, method: "browser" });
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(message));
      expect(screen.queryByTestId("awaiting-browser-http://localhost:8080")).toBeNull();
      cleanup();
    }
  });

  // --- 登录成功的行动呼吁（规格「服务器管理最小面」：聚焦打开工作区入口） ---

  it("登录成功后打开工作区入口取得键盘焦点，且不自动打开工作区选择器——三种方式都是", async () => {
    for (const method of ["browser", "device", "pat"] as const) {
      const open = vi.fn();
      const adapter = fakeAdapter();
      const loginStart: ConnectionsAdapter["loginStart"] =
        method === "pat"
          ? async () => ({ status: "patRequired" })
          : async (origin, onPhase) => {
              onPhase(method === "browser" ? BROWSER : APPROVAL);
              const done = await adapter.loginStart(origin, onPhase);
              return done;
            };
      const useStore = createAppStore({
        createSession: () => ({}) as WorkspaceSession,
        connections: { ...adapter, loginStart },
      });
      rtlRender(<Harness useStore={useStore} onOpenWorkspace={open} />, { wrapper: zhWrapper });
      addServer("http://localhost:8080", "本地");
      if (method === "pat") {
        fireEvent.change(await screen.findByPlaceholderText("spk_pat_…"), { target: { value: "spk_pat_good" } });
        fireEvent.click(screen.getByRole("button", { name: "以 PAT 登录" }));
      }

      const entry = await screen.findByTestId("open-workspace-http://localhost:8080");
      await waitFor(() => expect(document.activeElement).toBe(entry), { timeout: 2000 });
      expect(open).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("移除连接后清单消失", async () => {
    renderPanel(fakeAdapter());
    addServer("http://localhost:8080", "本地");
    await waitFor(() => expect(screen.getByText("本地")).toBeTruthy());

    await rowMenu("移除");
    await waitFor(() => expect(screen.queryByText("本地")).toBeNull());
    expect(screen.getByTestId("servers-empty")).toBeTruthy();
  });

  // --- 打开 workspace：退役文本输入，汇流至统一 chooser ---

  function renderLoggedInPanel(onOpenWorkspace: (id: string) => void) {
    rtlRender(
      <ServersPanel
        connections={[
          {
            id: "conn_1",
            origin: "http://localhost:8080",
            name: "本地",
            lastActorDisplay: DISPLAY,
            loggedIn: true,
          },
        ]}
        phases={{}}
        onAdd={async () => {}}
        onLogin={() => {}}
        onSubmitPat={() => {}}
        onLogout={() => {}}
        onRemove={() => {}}
        onOpenWorkspace={onOpenWorkspace}
      />,
      { wrapper: zhWrapper },
    );
  }

  // 既有已登录条目的打开项目在「⋯」菜单；行动呼吁按钮只给刚完成的登录。
  const openWorkspaceChooser = () => rowMenu("打开项目");

  it("已登录条目打开统一 chooser 并预选该 connection", async () => {
    const open = vi.fn();
    renderLoggedInPanel(open);

    await openWorkspaceChooser();
    expect(open).toHaveBeenCalledWith("conn_1");
    expect(screen.queryByPlaceholderText("project 或 project/repo")).toBeNull();
  });

  it("不再呈现临时 repo 文本输入表单", async () => {
    const open = vi.fn();
    renderLoggedInPanel(open);

    await openWorkspaceChooser();
    expect(screen.queryByTestId("workspace-form-http://localhost:8080")).toBeNull();
    expect(screen.queryByPlaceholderText("project 或 project/repo")).toBeNull();
  });
});

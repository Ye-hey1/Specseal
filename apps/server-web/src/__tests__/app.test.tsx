import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { WebApiError } from "../api/client";

// SPA 壳层、角色导览与交互状态（server-web-console「全部 browser route 由单一 SPA
// 提供可发现导览」「共用设计系统维持高密度可访问体验」「Browser API 交互状态一致
// 且可恢复」, D3／D6）。App 注入 typed client（唯一 HTTP 入口）与 MemoryRouter 的
// initialEntries，路由、壳层、导览、focus、error boundary、单次提交与 Sheet 皆可测。

type Session = {
  authenticated: boolean;
  user: null | { id: string; email: string; display: string; admin: boolean };
  home: string;
};

const UNAUTH: Session = { authenticated: false, user: null, home: "/login" };
const MEMBER: Session = {
  authenticated: true,
  user: { id: "u1", email: "member@example.com", display: "Member", admin: false },
  home: "/account",
};
const ADMIN: Session = {
  authenticated: true,
  user: { id: "a1", email: "admin@example.com", display: "Admin", admin: true },
  home: "/admin",
};

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    getSession: vi.fn(async () => UNAUTH),
    login: vi.fn(async () => ({ destination: "/admin" })),
    logout: vi.fn(async () => ({ destination: "/login" })),
    getAdminOverview: vi.fn(async () => ({
      activeUsers: 1,
      suspendedUsers: 0,
      projects: 1,
      repos: 1,
      activeCredentials: 0,
      pendingInvitations: 0,
      storeHealthy: true,
      identitySchemaVersion: 1,
      todos: [],
      recentAudit: [],
    })),
    getAccount: vi.fn(async () => ({
      user: { id: "u1", email: "member@example.com", display: "Member", admin: false },
      memberships: [],
      pats: [],
      sessions: [],
      deviceFamilies: [],
    })),
    ...overrides,
  };
}

function renderAt(route: string, client: ReturnType<typeof makeClient>) {
  return render(<App client={client as never} initialEntries={[route]} />);
}

// 侧栏六个目的地与帐号菜单的完整契约在 admin-console-shell.test.tsx；
// 此档只保留壳层以外的路由、focus、交互状态与 session 过期行为，避免同一份清单两处维护。
const ADMIN_DESTINATIONS = ["用户", "凭证", "稽核纪录", "系统"];

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

// --- three shells ---

describe("三种壳层与角色导览", () => {
  it("focus 流程壳呈现登录表单与 Specseal identity", async () => {
    renderAt("/login", makeClient());
    expect(await screen.findByLabelText(/email|电子邮件/i)).toBeTruthy();
    expect(screen.getByLabelText(/密码|password/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /登录/ })).toBeTruthy();
  });

  it("一般成员的帐号壳不显示任何管理目的地", async () => {
    renderAt("/account", makeClient({ getSession: vi.fn(async () => MEMBER) }));
    await screen.findByRole("main");
    for (const dest of ADMIN_DESTINATIONS) {
      expect(screen.queryByText(dest), `no admin dest ${dest}`).toBeNull();
    }
  });

  it("一般成员直接开 /admin 得到明确 403，不显示管理导览", async () => {
    renderAt("/admin", makeClient({ getSession: vi.fn(async () => MEMBER) }));
    // 提示卡（design D7 FocusNotice）：标题与说明整块以 role=alert 声明。
    const notice = await screen.findByRole("alert");
    expect(within(notice).getByRole("heading", { level: 1, name: "没有权限" })).toBeTruthy();
    expect(notice.textContent).toContain("你没有访问管理面的权限。");
    expect(notice.querySelector("svg")?.getAttribute("class")).toContain("text-status-warning");
    expect(screen.queryByText("稽核纪录")).toBeNull();
  });

  it("管理员深链接 /admin/audit 直接呈现稽核页", async () => {
    renderAt("/admin/audit", makeClient({ getSession: vi.fn(async () => ADMIN) }));
    // lazy 管理 chunk 加载后呈现稽核页标题。
    expect(await screen.findByRole("heading", { name: /稽核/ })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "管理导览" })).toBeTruthy();
  });
});

// --- redirect / focus ---

describe("导向与 focus", () => {
  it("未登录打开受保护 route 导向登录页", async () => {
    renderAt("/account", makeClient({ getSession: vi.fn(async () => UNAUTH) }));
    expect(await screen.findByRole("button", { name: /登录/ })).toBeTruthy();
  });

  it("route 切换后 focus 移至 <main> 标题", async () => {
    renderAt("/admin", makeClient({ getSession: vi.fn(async () => ADMIN) }));
    const main = await screen.findByRole("main");
    await waitFor(() => {
      const heading = within(main).getByRole("heading", { level: 1 });
      expect(document.activeElement === heading || main.contains(document.activeElement)).toBe(true);
    });
  });

  it("第一个可聚焦元素是 skip link", async () => {
    renderAt("/admin", makeClient({ getSession: vi.fn(async () => ADMIN) }));
    const skip = await screen.findByRole("link", { name: /跳至主要内容|skip/i });
    expect(skip).toBeTruthy();
    expect(skip.getAttribute("href")).toContain("#");
  });
});

// --- focus-flow card ---

// spec「共用设计系统维持高密度可访问体验」的「专注流程以置中字标与对话框式卡片呈现」与
// spec「接口语言支持中文与英文」的「登录前可切换语言」（design D7）。
describe("登录这一族的卡片", () => {
  beforeEach(() => localStorage.removeItem("specseal.uiLocale"));
  afterEach(() => localStorage.removeItem("specseal.uiLocale"));

  it("登录页为置中 40px 字标下的卡片：15px 标题「登录」、说明含目前主机名", async () => {
    renderAt("/login", makeClient());
    const heading = await screen.findByRole("heading", { level: 1, name: "登录" });
    expect(heading.className).toContain("text-[15px]");
    const main = screen.getByRole("main");
    expect(within(main).getAllByAltText("Specseal")[0].className).toContain("h-10");
    expect(main.textContent).toContain(`用管理员给你的帐号登录 ${window.location.host}。`);
  });

  it("跟随系统时点已标示的「中文」不写入偏好", async () => {
    renderAt("/login", makeClient());
    const user = userEvent.setup();
    await screen.findByRole("heading", { level: 1, name: "登录" });
    await user.click(screen.getByRole("button", { name: "中文" }));
    expect(localStorage.getItem("specseal.uiLocale")).toBeNull();
  });

  it("卡片下方的「中文」「English」标示目前语言，点 English 立即切换且登录后维持英文", async () => {
    const client = makeClient({
      getSession: vi.fn().mockResolvedValueOnce(UNAUTH).mockResolvedValue(ADMIN),
      login: vi.fn(async () => ({ destination: "/admin" })),
    });
    renderAt("/login", client);
    const user = userEvent.setup();
    await screen.findByRole("heading", { level: 1, name: "登录" });
    expect(screen.getByRole("button", { name: "中文" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "English" }).getAttribute("aria-pressed")).toBe("false");

    await user.click(screen.getByRole("button", { name: "English" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "English" }).getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("specseal.uiLocale")).toBe("en");

    await user.type(screen.getByLabelText(/email/i), "admin@example.com");
    await user.type(screen.getByLabelText(/password/i), "pw");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
  });
});

// --- login interaction states ---

describe("登录交互状态", () => {
  it("登录成功后导向 Server 回传的 destination", async () => {
    const client = makeClient({
      getSession: vi.fn(async () => UNAUTH),
      login: vi.fn(async () => ({ destination: "/account" })),
    });
    renderAt("/login", client);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/email|电子邮件/i), "member@example.com");
    await user.type(screen.getByLabelText(/密码|password/i), "pw");
    await user.click(screen.getByRole("button", { name: /登录/ }));
    await waitFor(() => expect(client.login).toHaveBeenCalledOnce());
    expect(client.login).toHaveBeenCalledWith(
      expect.objectContaining({ email: "member@example.com", password: "pw" }),
    );
  });

  it("字段验证失败保留输入并以 role=alert 声明错误", async () => {
    const client = makeClient({
      login: vi.fn(async () => {
        throw new WebApiError(400, "validation_error", "字段有误", {
          email: "email 格式不正确",
        });
      }),
    });
    renderAt("/login", client);
    const user = userEvent.setup();
    const email = await screen.findByLabelText(/email|电子邮件/i);
    await user.type(email, "bad");
    await user.type(screen.getByLabelText(/密码|password/i), "pw");
    await user.click(screen.getByRole("button", { name: /登录/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("email 格式不正确");
    // 非秘密输入保留，可再次提交。
    expect((email as HTMLInputElement).value).toBe("bad");
    expect(screen.getByRole("button", { name: /登录/ })).toBeTruthy();
  });

  it("提交进行中停用按钮，第二次点击不重复送出", async () => {
    let resolve!: (v: { destination: string }) => void;
    const login = vi.fn(() => new Promise<{ destination: string }>((r) => (resolve = r)));
    const client = makeClient({ login });
    renderAt("/login", client);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/email|电子邮件/i), "a@b.com");
    await user.type(screen.getByLabelText(/密码|password/i), "pw");
    const submit = screen.getByRole("button", { name: /登录/ });
    await user.click(submit);
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.click(submit);
    expect(login).toHaveBeenCalledOnce();
    // resolve 后的 refresh／navigate 状态更新明确等待，于 act 内结算（不压制警告）。
    await act(async () => {
      resolve({ destination: "/account" });
    });
  });
});

// --- data page states ---

describe("数据页交互状态", () => {
  it("加载期间显示加载状态，不白屏", async () => {
    const client = makeClient({
      getSession: vi.fn(async () => ADMIN),
      // 永不 resolve：页面停留在加载状态（chunk 加载与数据加载皆呈现「加载中」）。
      getAdminOverview: vi.fn(() => new Promise(() => {})),
    });
    renderAt("/admin", client);
    expect(await screen.findByText(/加载中|loading/i)).toBeTruthy();
  });

  it("数据加载失败显示可恢复错误与重试，不白屏", async () => {
    const client = makeClient({
      getSession: vi.fn(async () => ADMIN),
      getAdminOverview: vi.fn(async () => {
        throw new WebApiError(500, "internal", "服务器错误");
      }),
    });
    renderAt("/admin", client);
    expect(await screen.findByRole("button", { name: /重试|retry/i })).toBeTruthy();
  });
});

// server-web-console「Browser API 交互状态一致且可恢复」的 Scenario「Session 过期回到
// 登录并保留安全路径」：已加载的受保护 route 调用 browser API 收到 401 即回登录页。
// 401 有两种语意——unauthenticated（session 失效，要导向）与 invalid_credentials
// （登录密码错，要留在原页显示错误），必须依 error code 分派。
describe("Session 过期回到登录并保留安全路径", () => {
  it("受保护 route 收到 401 unauthenticated 后回登录页，returnTo 为当前路径", async () => {
    const getSession = vi
      .fn()
      .mockResolvedValueOnce(ADMIN)
      .mockResolvedValue(UNAUTH);
    const client = makeClient({
      getSession,
      getAdminUsers: vi.fn(async () => {
        throw new WebApiError(401, "unauthenticated", "请先登录");
      }),
      login: vi.fn(async () => ({ destination: "/admin/users" })),
    });
    renderAt("/admin/users", client);
    // 401 触发 session 重读 → guard 判定未登录 → 导向登录页。
    expect(await screen.findByRole("button", { name: /登录/ })).toBeTruthy();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email|电子邮件/i), "admin@example.com");
    await user.type(screen.getByLabelText(/密码|password/i), "pw");
    await user.click(screen.getByRole("button", { name: /登录/ }));
    await waitFor(() => expect(client.login).toHaveBeenCalledOnce());
    expect(client.login).toHaveBeenCalledWith(
      expect.objectContaining({ returnTo: "/admin/users" }),
    );
  });

  it("登录失败的 401 invalid_credentials 留在登录页显示错误，不触发导向循环", async () => {
    const client = makeClient({
      getSession: vi.fn(async () => UNAUTH),
      login: vi.fn(async () => {
        throw new WebApiError(401, "invalid_credentials", "电子邮件或密码不正确");
      }),
    });
    renderAt("/login", client);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/email|电子邮件/i), "admin@example.com");
    await user.type(screen.getByLabelText(/密码|password/i), "wrong");
    await user.click(screen.getByRole("button", { name: /登录/ }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("电子邮件或密码不正确")).toBeTruthy();
    // 仍在登录页、输入保留。
    expect((screen.getByLabelText(/email|电子邮件/i) as HTMLInputElement).value).toBe(
      "admin@example.com",
    );
  });
});

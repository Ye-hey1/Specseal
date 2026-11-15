import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeAdminClient, renderAt, setViewport } from "./helpers/adminHarness";

// 管理总览（server-web-console「总览提供可行动入口与待办」；server-web-list-pages design D10）：
// 768px 置中栏；顶端四格数字砖（与 desktop 阅读卡同款、每格可点进对应页），其下「需要处理」
// 「系统健康」「最近活动」三张设置型卡。没有待处理事项时整张卡不渲染——空标题与空清单只是
// 视觉噪音。识别数据结构版本属系统健康摘要，不是独立数字砖。

const HEALTHY = {
  activeUsers: 2,
  suspendedUsers: 1,
  projects: 3,
  repos: 4,
  activeCredentials: 5,
  pendingInvitations: 1,
  storeHealthy: true,
  identitySchemaVersion: 6,
  todos: [],
  recentAudit: [
    {
      id: "e1",
      actorId: "a1",
      action: "user-invited",
      subject: "new@example.com",
      source: "web",
      createdAt: "2026-01-03T10:00:00Z",
    },
  ],
};

beforeEach(() => setViewport(false));

/** 主内容区内的数字砖（侧栏也有「用户」等链接，查找限定在主内容区）。 */
const tiles = () => Array.from(screen.getByRole("main").querySelectorAll<HTMLElement>("[data-doc-tile]"));

describe("总览数字砖与版面", () => {
  it("四格数字砖皆为链接，目的地依序为用户、项目、凭证与邀请中分页，标签带次要计数", async () => {
    renderAt("/admin", makeAdminClient({ getAdminOverview: vi.fn(async () => HEALTHY) }));
    // 标题在数据闸门之外就渲染，不能当等待锚点——等一个依赖数据的区块。
    await screen.findByRole("region", { name: "系统健康" });
    expect(tiles().map((tile) => tile.tagName)).toEqual(["A", "A", "A", "A"]);
    expect(tiles().map((tile) => tile.getAttribute("href"))).toEqual([
      "/admin/users",
      "/admin/registry",
      "/admin/credentials",
      "/admin/users?tab=pending",
    ]);
    expect(tiles().map((tile) => tile.textContent)).toEqual([
      "2用户 · 停权 1",
      "3项目 · 保存库 4",
      "5凭证 · 有效",
      "1待激活 · 邀请未使用",
    ]);
  });

  it("点待激活数字砖直接看到用户页的邀请中分页", async () => {
    renderAt("/admin", makeAdminClient({ getAdminOverview: vi.fn(async () => HEALTHY) }));
    await screen.findByRole("region", { name: "系统健康" });
    const user = userEvent.setup();
    await user.click(tiles()[3]);
    const pending = await screen.findByRole("tab", { name: /^邀请中/ });
    expect(pending.getAttribute("aria-selected")).toBe("true");
  });

  it("内容栏 768px 置中", async () => {
    renderAt("/admin", makeAdminClient({ getAdminOverview: vi.fn(async () => HEALTHY) }));
    await screen.findByRole("region", { name: "系统健康" });
    const column = screen
      .getByRole("heading", { level: 1, name: "总览" })
      .closest("[data-page-header]")?.parentElement as HTMLElement;
    expect(column.className).toContain("max-w-[768px]");
    expect(column.className).toContain("mx-auto");
  });

  it("识别数据结构版本呈现于系统健康摘要，而非独立数字砖", async () => {
    renderAt("/admin", makeAdminClient({ getAdminOverview: vi.fn(async () => HEALTHY) }));
    const health = await screen.findByRole("region", { name: "系统健康" });
    const schema = within(health).getByRole("group", { name: "数据结构版本" });
    expect(schema.textContent).toContain("v6");
    expect(tiles()).toHaveLength(4);
    expect(screen.queryByRole("link", { name: /数据结构版本/ })).toBeNull();
  });

  it("系统健康与最近活动的标头各自提供前往系统与稽核的入口", async () => {
    renderAt("/admin", makeAdminClient({ getAdminOverview: vi.fn(async () => HEALTHY) }));
    const health = await screen.findByRole("region", { name: "系统健康" });
    expect(within(health).getByRole("link", { name: /系统/ }).getAttribute("href")).toBe(
      "/admin/system",
    );
    const activity = screen.getByRole("region", { name: "最近活动" });
    expect(within(activity).getByRole("link", { name: /稽核/ }).getAttribute("href")).toBe(
      "/admin/audit",
    );
  });

  it("最近活动一列含动作名称、对象、日期与操作者", async () => {
    renderAt("/admin", makeAdminClient({ getAdminOverview: vi.fn(async () => HEALTHY) }));
    const activity = await screen.findByRole("region", { name: "最近活动" });
    const row = within(activity).getByRole("group", { name: "邀请用户 new@example.com" });
    expect(row.textContent).toContain("2026-01-03 · a1");
  });
});

describe("总览待办区块", () => {
  it("无待处理事项时整块不渲染", async () => {
    renderAt("/admin", makeAdminClient({ getAdminOverview: vi.fn(async () => HEALTHY) }));
    await screen.findByRole("region", { name: "系统健康" });
    expect(screen.queryByRole("region", { name: "需要处理" })).toBeNull();
  });

  it("无有效凭证时呈现该事项并提供创建访问密钥入口", async () => {
    renderAt(
      "/admin",
      makeAdminClient({
        getAdminOverview: vi.fn(async () => ({
          ...HEALTHY,
          activeCredentials: 0,
          todos: [{ kind: "no-active-credentials", destination: "/account", count: 0 }],
        })),
      }),
    );
    const todos = await screen.findByRole("region", { name: "需要处理" });
    expect(todos.textContent).toContain("凭证");
    expect(within(todos).getByRole("link", { name: /创建访问密钥/ }).getAttribute("href")).toBe(
      "/account",
    );
  });

  it("有待激活邀请时呈现该事项并连往用户页的邀请中分页", async () => {
    renderAt(
      "/admin",
      makeAdminClient({
        getAdminOverview: vi.fn(async () => ({
          ...HEALTHY,
          todos: [{ kind: "pending-invitations", destination: "/admin/users", count: 2 }],
        })),
      }),
    );
    const todos = await screen.findByRole("region", { name: "需要处理" });
    expect(todos.textContent).toContain("2");
    expect(within(todos).getByRole("link", { name: /查看邀请/ }).getAttribute("href")).toBe(
      "/admin/users?tab=pending",
    );
  });
  // fix-english-status-labels-and-plurals：英文接口数量为 1 时用单数（server-web-console「后台英文计数文案依数量使用单数或复数」）。
  it("英文接口只有 1 位待激活时写「1 user has not activated yet.」", async () => {
    localStorage.setItem("specseal.uiLocale", "en");
    try {
      renderAt(
        "/admin",
        makeAdminClient({
          getAdminOverview: vi.fn(async () => ({
            ...HEALTHY,
            todos: [{ kind: "pending-invitations", destination: "/admin/users", count: 1 }],
          })),
        }),
      );
      const todos = await screen.findByRole("region", { name: "Needs attention" });
      expect(todos.textContent).toContain("1 user has not activated yet.");
      expect(todos.textContent).not.toContain("1 users");
    } finally {
      localStorage.removeItem("specseal.uiLocale");
    }
  });

  it("英文接口只有 1 个保存库时，项目计数卡写「1 repository」", async () => {
    localStorage.setItem("specseal.uiLocale", "en");
    try {
      renderAt("/admin", makeAdminClient({ getAdminOverview: vi.fn(async () => ({ ...HEALTHY, projects: 1, repos: 1 })) }));
      const projectTile = await screen.findByText(/1 repository/);
      expect(projectTile.textContent).not.toContain("repositories");
    } finally {
      localStorage.removeItem("specseal.uiLocale");
    }
  });
});

// server-setup「完成 setup 即可邀请与连接」要求导向 /admin?welcome=1 显示连接信息；
// server-admin「Store 不健康时 identity 管理仍可用」要求 overview 明确显示 storeHealthy:false。
describe("总览的欢迎区块与保存后端健康", () => {
  const CONNECTION = {
    publicUrl: "https://specseal.example",
    projectKey: "demo",
    repoKey: "backend",
  };

  it("welcome=1 呈现初始设置完成的连接信息三字段且可拷贝", async () => {
    renderAt(
      "/admin?welcome=1",
      makeAdminClient({
        getAdminOverview: vi.fn(async () => ({ ...HEALTHY, connection: CONNECTION })),
      }),
    );
    const welcome = await screen.findByRole("region", { name: /开始使用/ });
    expect(within(welcome).getByText(CONNECTION.publicUrl)).toBeTruthy();
    expect(within(welcome).getByText(CONNECTION.projectKey)).toBeTruthy();
    expect(within(welcome).getByText(CONNECTION.repoKey)).toBeTruthy();
    expect(within(welcome).getAllByRole("button", { name: /拷贝/ }).length).toBe(3);
  });

  it("无 welcome 参数时不呈现欢迎区块", async () => {
    renderAt(
      "/admin",
      makeAdminClient({
        getAdminOverview: vi.fn(async () => ({ ...HEALTHY, connection: CONNECTION })),
      }),
    );
    await screen.findByRole("region", { name: "系统健康" });
    expect(screen.queryByRole("region", { name: /开始使用/ })).toBeNull();
  });

  it("storeHealthy:false 时以 role=alert 呈现降级状态与可公开错误", async () => {
    renderAt(
      "/admin",
      makeAdminClient({
        getAdminOverview: vi.fn(async () => ({
          ...HEALTHY,
          storeHealthy: false,
          storeHealthError: "store unreachable",
        })),
      }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("store unreachable");
    // spec「保存健康徽章」：徽章与同页的降级警示语意一致——异常为红系，
    // 不能与正常一样压成灰（同页上下文一红一灰讲同一件事，读起来自相矛盾）。
    expect(screen.getByText("异常").className).toContain("destructive");
  });

  it("保存健康徽章：正常为绿系，与异常的红系一眼可辨", async () => {
    renderAt("/admin", makeAdminClient({ getAdminOverview: vi.fn(async () => HEALTHY) }));
    const badge = await screen.findByText("正常");
    expect(badge.className).toContain("status-success");
  });
});

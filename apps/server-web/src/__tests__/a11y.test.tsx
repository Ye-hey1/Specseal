import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { App } from "../App";
import { ADMIN_SESSION, makeAdminClient, setViewport } from "./helpers/adminHarness";

// 可访问性基线（server-web-console D6）：壳层无 axe 违规。jsdom 无法计算色彩对比，
// color-contrast 停用，对比／zoom／reduced-motion 由手动 viewport 验收涵盖（7.3）。
const AXE = { rules: { "color-contrast": { enabled: false } } };

const ADMIN = {
  authenticated: true,
  user: { id: "a1", email: "admin@example.com", display: "Admin", admin: true },
  home: "/admin",
};

function client(overrides: Record<string, unknown> = {}) {
  return {
    getSession: vi.fn(async () => ({ authenticated: false, user: null, home: "/login" })),
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
    ...overrides,
  } as never;
}

describe("可访问性（axe）", () => {
  it("登录页无 axe 违规", async () => {
    const { container } = render(<App client={client()} initialEntries={["/login"]} />);
    await screen.findByRole("button", { name: /登录/ });
    const results = await axe(container, AXE);
    expect(results.violations).toEqual([]);
  });

  it("管理壳无 axe 违规", async () => {
    const { container } = render(
      <App client={client({ getSession: vi.fn(async () => ADMIN) })} initialEntries={["/admin"]} />,
    );
    // 壳有两个 nav landmark（侧栏导览与面包屑），以名称区分；axe 也检查两者名称不重复。
    await screen.findByRole("navigation", { name: "管理导览" });
    await screen.findByRole("heading", { name: /总览/ });
    const results = await axe(container, AXE);
    expect(results.violations).toEqual([]);
  });

  // server-web-list-pages：列表卡、分页、数字砖与设置型卡换上之后，三个代表页仍无违规。
  it("用户页无 axe 违规", async () => {
    const { container } = render(
      <App client={makeAdminClient() as never} initialEntries={["/admin/users"]} />,
    );
    await screen.findByRole("button", { name: "Member" });
    const results = await axe(container, AXE);
    expect(results.violations).toEqual([]);
  });

  it("总览无 axe 违规", async () => {
    const { container } = render(<App client={makeAdminClient() as never} initialEntries={["/admin"]} />);
    await screen.findByRole("region", { name: "系统健康" });
    const results = await axe(container, AXE);
    expect(results.violations).toEqual([]);
  });

  it("帐号页无 axe 违规", async () => {
    const account = {
      user: ADMIN_SESSION.user,
      memberships: [{ projectKey: "demo", projectName: "Demo", role: "editor" }],
      pats: [
        {
          id: "p1",
          prefix: "slk_abc",
          name: "cli",
          createdAt: "2026-01-01T00:00:00Z",
          expiresAt: null,
          lastUsedAt: null,
          revokedAt: null,
        },
      ],
      sessions: [
        { id: "s1", createdAt: "2026-01-01T00:00:00Z", expiresAt: "2026-02-01T00:00:00Z", revokedAt: null },
      ],
      deviceFamilies: [],
    };
    const { container } = render(
      <App
        client={makeAdminClient({ getAccount: vi.fn(async () => account) }) as never}
        initialEntries={["/account"]}
      />,
    );
    await screen.findByRole("region", { name: "访问密钥" });
    const results = await axe(container, AXE);
    expect(results.violations).toEqual([]);
  });

  // server-web-detail-pages：详情页（页标题接状态签、卡片标头分页、顶列 ‹ n / m ›）与置中对话框。
  it("用户详情页无 axe 违规", async () => {
    const { container } = render(
      <App client={makeAdminClient() as never} initialEntries={["/admin/users/m1"]} />,
    );
    await screen.findByRole("heading", { level: 1, name: "Member" });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /^凭证/ }).querySelector("[data-tab-count]")).not.toBeNull(),
    );
    const results = await axe(container, AXE);
    expect(results.violations).toEqual([]);
  });

  // 对话框 portal 到 body，所以扫整个 body（同窄屏幕一题的理由，不传 documentElement）。
  it("开着的邀请对话框无 axe 违规", async () => {
    render(<App client={makeAdminClient() as never} initialEntries={["/admin/users"]} />);
    await screen.findByRole("button", { name: "Member" });
    await userEvent.setup().click(screen.getByRole("button", { name: "邀请用户" }));
    await screen.findByRole("alertdialog", { name: "邀请用户" });
    const results = await axe(document.body, AXE);
    expect(results.violations).toEqual([]);
  });

  // 窄屏幕没有固定侧栏、顶列多一颗「打开导览」钮：检查内容都落在 landmark 内（axe 的 region
  // 规则，这里明确打开）。region 只在扫描范围含 body 时适用，对 container 跑会判为不适用，所以
  // 这一题扫整个 body；不传 documentElement——jest-axe 会把 body 外的元素拷贝进 body 再扫，
  // 活的画面会被换成静态复本。
  it("窄屏幕管理壳无 axe 违规，且内容都在 landmark 内", async () => {
    setViewport(true);
    try {
      render(
        <App client={client({ getSession: vi.fn(async () => ADMIN) })} initialEntries={["/admin"]} />,
      );
      await screen.findByRole("button", { name: "打开导览" });
      await screen.findByRole("heading", { name: /总览/ });
      const results = await axe(document.body, {
        rules: { ...AXE.rules, region: { enabled: true } },
      });
      expect(results.violations).toEqual([]);
    } finally {
      setViewport(false);
    }
  });
});

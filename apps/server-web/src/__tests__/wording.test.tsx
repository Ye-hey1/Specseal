import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { render } from "@testing-library/react";
import { App } from "../App";
import { makeAdminClient, renderAt, setViewport } from "./helpers/adminHarness";

// 用户可见文案（proposal「兼容性影响：用户可见文案」与 openspec/LANGUAGE.md）：
// 工程词退场，改用中文正典词。这是一份对照清单而非个别页面的行为测试——文案漂移最容易
// 在改版时无声发生，所以由一支测试把六个管理目的地与帐号页一起钉住。
//
// 多语系后这批中文正典词只在 zh-CN 成立，因此各测试明示语言：中文版断言正典词出现，
// 英文版断言同一批中文词完全不出现（只翻一半的页面会在这里露馅）。

// 退场的工程词：出现在任何用户可见文本里都算退化。
const RETIRED = [
  "创建 project",
  "Project key",
  "Repo key",
  "Personal Access Tokens",
  "PAT",
  "Web Sessions",
  "Schema 版本",
  "Outbox backlog",
];

const MEMBER_SESSION = {
  authenticated: true,
  user: { id: "u1", email: "member@example.com", display: "Member", admin: false },
  home: "/account",
};

const ACCOUNT = {
  user: { id: "u1", email: "member@example.com", display: "Member", admin: false },
  memberships: [{ projectKey: "alpha", projectName: "Alpha 项目", role: "editor" }],
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
    {
      id: "s1",
      createdAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-02-01T00:00:00Z",
      revokedAt: null,
    },
  ],
  deviceFamilies: [],
};

const ADMIN_DESTINATIONS = [
  "/admin",
  "/admin/users",
  "/admin/registry",
  "/admin/credentials",
  "/admin/system",
  "/admin/audit",
];

/** 中文正典词——英文版不得出现任何一个。 */
const ZH_CANONICAL = [
  "项目代号",
  "保存库代号",
  "访问密钥",
  "登录工作阶段",
  "数据结构版本",
  "待送队列",
  "创建项目",
];

beforeEach(() => {
  setViewport(false);
  localStorage.clear();
  localStorage.setItem("specseal.tourSeen", "1");
});

function setLanguage(locale: "zh-CN" | "en") {
  localStorage.setItem("specseal.uiLocale", locale);
}

/** 该画面目前的全部可见文本。 */
function visibleText(): string {
  return document.body.textContent ?? "";
}

describe("用户可见文案不含工程词（zh-CN）", () => {
  it.each(ADMIN_DESTINATIONS)("%s 不出现退场的工程词", async (route) => {
    setLanguage("zh-CN");
    const { unmount } = renderAt(route, makeAdminClient());
    await screen.findByRole("heading", { level: 1 });
    // 等数据层渲染完成，才不会只验到加载中的骨架。
    await waitFor(() => expect(screen.queryByText("加载中…")).toBeNull());
    const text = visibleText();
    for (const term of RETIRED) {
      expect(text, `${route} 不应出现「${term}」`).not.toContain(term);
    }
    unmount();
  });

  it("帐号页不出现退场的工程词", async () => {
    setLanguage("zh-CN");
    render(
      <App
        client={
          {
            getSession: vi.fn(async () => MEMBER_SESSION),
            logout: vi.fn(async () => ({ destination: "/login" })),
            getAccount: vi.fn(async () => ACCOUNT),
            createPat: vi.fn(),
            revokePat: vi.fn(),
            revokeDevice: vi.fn(),
          } as never
        }
        initialEntries={["/account"]}
      />,
    );
    await screen.findByRole("heading", { level: 1, name: "帐号" });
    const text = visibleText();
    for (const term of RETIRED) {
      expect(text, `帐号页不应出现「${term}」`).not.toContain(term);
    }
  });
});

describe("中文正典词出现在对应画面（zh-CN）", () => {
  beforeEach(() => setLanguage("zh-CN"));

  it("项目与保存库页使用项目代号与保存库代号", async () => {
    renderAt("/admin/registry", makeAdminClient());
    await screen.findByText("Demo");
    expect(visibleText()).toContain("代号");
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /创建项目/ }));
    await screen.findByRole("alertdialog", { name: /创建项目/ });
    expect(screen.getByLabelText(/项目代号/)).toBeTruthy();
  });

  it("凭证页使用访问密钥", async () => {
    renderAt("/admin/credentials", makeAdminClient());
    // 分页标签后带计数签，名称以「访问密钥」开头。
    expect(await screen.findByRole("tab", { name: /^访问密钥/ })).toBeTruthy();
  });

  it("系统页使用数据结构版本与待送队列", async () => {
    renderAt("/admin/system", makeAdminClient());
    // 系统页的 h1 在加载中就已渲染，两个词都在数据回来后的区段里——等区段而非标题，
    // 否则慢机器（Windows runner）会读到「加载中…」就断言。
    await screen.findByRole("region", { name: "运行环境" });
    const text = visibleText();
    expect(text).toContain("数据结构版本");
    expect(text).toContain("待送队列");
  });

  it("帐号页使用访问密钥与登录工作阶段", async () => {
    render(
      <App
        client={
          {
            getSession: vi.fn(async () => MEMBER_SESSION),
            logout: vi.fn(async () => ({ destination: "/login" })),
            getAccount: vi.fn(async () => ACCOUNT),
            createPat: vi.fn(),
            revokePat: vi.fn(),
            revokeDevice: vi.fn(),
          } as never
        }
        initialEntries={["/account"]}
      />,
    );
    await screen.findByRole("heading", { level: 1, name: "帐号" });
    const text = visibleText();
    expect(text).toContain("访问密钥");
    expect(text).toContain("登录工作阶段");
  });

  it("初始设置页使用项目代号与保存库代号", async () => {
    render(
      <App
        client={
          {
            getSession: vi.fn(async () => ({ authenticated: false, user: null, home: "/login" })),
            getSetupState: vi.fn(async () => ({
              step: "registry",
              store: {
                driver: "sqlite",
                contractVersion: 3,
                level: "full",
                capabilities: [],
                healthy: true,
                identitySchemaVersion: 6,
              },
            })),
            submitSetupRegistry: vi.fn(),
          } as never
        }
        initialEntries={["/setup?token=t"]}
      />,
    );
    expect(await screen.findByLabelText(/项目代号/)).toBeTruthy();
    expect(screen.getByLabelText(/保存库代号/)).toBeTruthy();
    expect(visibleText()).not.toContain("Project key");
    expect(visibleText()).not.toContain("Repo key");
  });
});

describe("英文版不残留中文正典词（en）", () => {
  beforeEach(() => setLanguage("en"));

  it.each(ADMIN_DESTINATIONS)("%s 不出现任何中文正典词", async (route) => {
    const { unmount } = renderAt(route, makeAdminClient());
    await screen.findByRole("heading", { level: 1 });
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    const text = visibleText();
    for (const term of ZH_CANONICAL) {
      expect(text, `${route} 的英文版不应出现「${term}」`).not.toContain(term);
    }
    unmount();
  });

  it("帐号页不出现任何中文正典词", async () => {
    render(
      <App
        client={
          {
            getSession: vi.fn(async () => MEMBER_SESSION),
            logout: vi.fn(async () => ({ destination: "/login" })),
            getAccount: vi.fn(async () => ACCOUNT),
            createPat: vi.fn(),
            revokePat: vi.fn(),
            revokeDevice: vi.fn(),
          } as never
        }
        initialEntries={["/account"]}
      />,
    );
    await screen.findByRole("heading", { level: 1, name: "Account" });
    const text = visibleText();
    for (const term of ZH_CANONICAL) {
      expect(text, `帐号页的英文版不应出现「${term}」`).not.toContain(term);
    }
  });
});

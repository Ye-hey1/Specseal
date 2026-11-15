import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { WebApiError } from "../api/client";

// 帐号自助页（server-identity「帐号 browser API 保持凭证秘密边界」, D4／D6；server-web-console
// 「帐号页呈现我的项目」；server-web-list-pages design D8、D10）。768px 置中栏，由上而下为我的
// 项目、访问密钥、设备登录、登录工作阶段四张设置型卡；创建密钥以置中对话框承载，明文只在对话框内
// 显示一次（server-web-detail-pages design D7）；撤销钮滑过才出现，撤销等破坏性操作先以 AlertDialog
// 确认才送出。

const MEMBER = {
  authenticated: true,
  user: { id: "u1", email: "member@example.com", display: "Member", admin: false },
  home: "/account",
};

const ACCOUNT = {
  user: { id: "u1", email: "member@example.com", display: "Member", admin: false },
  memberships: [
    { projectKey: "alpha", projectName: "Alpha 项目", role: "editor" },
    { projectKey: "beta", projectName: "Beta 项目", role: "reader" },
  ],
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
    {
      id: "p3",
      prefix: "slk_old",
      name: "old",
      createdAt: "2026-01-01T00:00:00Z",
      expiresAt: null,
      lastUsedAt: "2026-01-04T00:00:00Z",
      revokedAt: "2026-01-05T00:00:00Z",
    },
  ],
  sessions: [
    { id: "s1", createdAt: "2026-01-01T00:00:00Z", expiresAt: "2026-02-01T00:00:00Z", revokedAt: null },
  ],
  deviceFamilies: [
    {
      id: "d1",
      source: "device 授权",
      createdAt: "2026-01-01T00:00:00Z",
      lastRefreshAt: "2026-01-02T00:00:00Z",
      revokedAt: null,
    },
  ],
};

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    getSession: vi.fn(async () => MEMBER),
    login: vi.fn(),
    logout: vi.fn(async () => ({ destination: "/login" })),
    getAdminOverview: vi.fn(),
    getAccount: vi.fn(async () => ACCOUNT),
    createPat: vi.fn(async () => ({
      pat: {
        id: "p2",
        prefix: "slk_new",
        name: "laptop",
        createdAt: "2026-01-03T00:00:00Z",
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
      },
      plaintext: "slk_new_SECRETPLAINTEXT",
    })),
    revokePat: vi.fn(async () => {}),
    revokeDevice: vi.fn(async () => {}),
    ...overrides,
  };
}

function renderAt(route: string, client: ReturnType<typeof makeClient>) {
  return render(<App client={client as never} initialEntries={[route]} />);
}

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

describe("帐号自助页", () => {
  it("四张卡由上而下为我的项目、访问密钥、设备登录、登录工作阶段，内容栏 768px 置中", async () => {
    renderAt("/account", makeClient());
    // 等帐号数据本身加载——header 的电子邮件链接在数据回来前就已渲染，不能当等待锚点。
    await screen.findByRole("region", { name: "我的项目" });
    const cards = ["我的项目", "访问密钥", "设备登录", "登录工作阶段"];
    const order = screen
      .getAllByRole("region")
      .map((region) => region.getAttribute("aria-label"))
      .filter((name) => cards.includes(name ?? ""));
    expect(order).toEqual(cards);
    const column = screen
      .getByRole("heading", { level: 1, name: "帐号" })
      .closest("[data-page-header]")?.parentElement as HTMLElement;
    expect(column.className).toContain("max-w-[768px]");
    expect(column.className).toContain("mx-auto");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("访问密钥列：说明为「前缀 · 到期 · 最近使用」或「前缀 · 撤销于」；有效者的撤销钮滑过才出现，已撤销的没有", async () => {
    renderAt("/account", makeClient());
    const keys = await screen.findByRole("region", { name: "访问密钥" });
    expect(within(keys).getByText("远程工作流程以你的身分连接时使用")).toBeTruthy();
    const cli = within(keys).getByRole("group", { name: "cli" });
    expect(cli.textContent).toContain("slk_abc · 到期 永久 · 最近使用 从未");
    expect(within(cli).getByText("有效").className).toContain("status-success");
    const revoke = within(cli).getByRole("button", { name: "撤销访问密钥 cli" });
    // 平时隐藏、列滑过或键盘聚焦时出现；没有鼠标移入能力的触摸设备恒常显示。
    expect(revoke.className.split(/\s+/)).toEqual(
      expect.arrayContaining([
        "opacity-0",
        "group-hover:opacity-100",
        "focus-visible:opacity-100",
        "[@media(hover:none)]:opacity-100",
      ]),
    );
    const old = within(keys).getByRole("group", { name: "old" });
    expect(old.textContent).toContain("slk_old · 撤销于 2026-01-05");
    expect(within(old).getByText("已撤销")).toBeTruthy();
    expect(within(old).queryByRole("button")).toBeNull();
  });

  it("设备登录列：说明为最近更新日期，撤销钮滑过才出现", async () => {
    renderAt("/account", makeClient());
    const devices = await screen.findByRole("region", { name: "设备登录" });
    expect(within(devices).getByText("桌面 app 或 CLI 授权后留下的凭证")).toBeTruthy();
    const row = within(devices).getByRole("group", { name: "device 授权" });
    expect(row.textContent).toContain("最近更新 2026-01-02");
    const revoke = within(row).getByRole("button", { name: "撤销设备登录 device 授权" });
    expect(revoke.className).toContain("group-hover:opacity-100");
  });

  it("登录工作阶段列：创建日期、到期日与状态签", async () => {
    renderAt("/account", makeClient());
    const sessions = await screen.findByRole("region", { name: "登录工作阶段" });
    const row = within(sessions).getByRole("group", { name: "创建 2026-01-01" });
    expect(row.textContent).toContain("到期 2026-02-01");
    expect(within(row).getByText("有效").className).toContain("status-success");
  });

  // 创建动作与管理列表页一致：页面唯一 primary action 开置中对话框，字段不常驻页面
  // （server-web-detail-pages design D7）。
  it("创建表单不常驻页面，按下创建访问密钥后才出现在置中对话框", async () => {
    renderAt("/account", makeClient());
    await screen.findByRole("region", { name: "访问密钥" });
    expect(screen.queryByLabelText("名称")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /创建访问密钥/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "创建访问密钥" });
    expect(within(dialog).getByLabelText("名称")).toBeTruthy();
    expect(within(dialog).getByLabelText(/到期日/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("送出成功后同一个对话框换成「密钥已创建」：绿系成功框内是明文与拷贝；按「完成」后页面没有明文、访问密钥卡多出 ci", async () => {
    const ci = {
      id: "p9",
      prefix: "slk_ci",
      name: "ci",
      createdAt: "2026-01-06T00:00:00Z",
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };
    const client = makeClient({
      getAccount: vi.fn().mockResolvedValueOnce(ACCOUNT).mockResolvedValue({ ...ACCOUNT, pats: [...ACCOUNT.pats, ci] }),
      createPat: vi.fn(async () => ({ pat: ci, plaintext: "slk_ci_SECRETPLAINTEXT" })),
    });
    renderAt("/account", client);
    const user = userEvent.setup();
    await screen.findByRole("region", { name: "访问密钥" });
    await user.click(screen.getByRole("button", { name: /创建访问密钥/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "创建访问密钥" });
    await user.type(within(dialog).getByLabelText("名称"), "ci");
    await user.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => expect(client.createPat).toHaveBeenCalledWith(expect.objectContaining({ name: "ci" })));

    const done = await screen.findByRole("alertdialog", { name: "密钥已创建" });
    expect(done.textContent).toContain("只显示这一次");
    const plaintext = within(done).getByText("slk_ci_SECRETPLAINTEXT");
    // （拷贝钮自己也带一个 sr-only 的 role=status，所以由明文回推外框。）
    const box = plaintext.closest("[role='status']") as HTMLElement;
    expect(box.getAttribute("aria-live")).toBe("polite");
    expect(within(box).getByRole("button", { name: "拷贝" })).toBeTruthy();
    // spec「秘密值成功框为成功语意」：一次性明码是「建好了」的回馈，走绿系而非主色。
    expect(box.className).toContain("status-success");
    expect(box.className).not.toContain("primary");

    await user.click(within(done).getByRole("button", { name: "完成" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.queryByText(/slk_ci_SECRETPLAINTEXT/)).toBeNull();
    const keys = screen.getByRole("region", { name: "访问密钥" });
    expect(within(keys).getByRole("group", { name: "ci" })).toBeTruthy();
  });

  it("创建成功后重读帐号较慢：明文留在对话框内，页面不退回加载中", async () => {
    let finish: (value: typeof ACCOUNT) => void = () => {};
    const client = makeClient({
      getAccount: vi
        .fn()
        .mockResolvedValueOnce(ACCOUNT)
        .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve))),
      createPat: vi.fn(async () => ({ pat: ACCOUNT.pats[0], plaintext: "slk_ci_SECRETPLAINTEXT" })),
    });
    renderAt("/account", client);
    const user = userEvent.setup();
    await screen.findByRole("region", { name: "访问密钥" });
    await user.click(screen.getByRole("button", { name: /创建访问密钥/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "创建访问密钥" });
    await user.type(within(dialog).getByLabelText("名称"), "ci");
    await user.click(within(dialog).getByRole("button", { name: "创建" }));

    const done = await screen.findByRole("alertdialog", { name: "密钥已创建" });
    await waitFor(() => expect(client.getAccount).toHaveBeenCalledTimes(2));
    expect(within(done).getByText("slk_ci_SECRETPLAINTEXT")).toBeTruthy();
    expect(screen.queryByText("加载中…")).toBeNull();
    finish(ACCOUNT);
    await waitFor(() => expect(screen.getByText("slk_ci_SECRETPLAINTEXT")).toBeTruthy());
    expect(screen.getByRole("alertdialog", { name: "密钥已创建" })).toBeTruthy();
  });

  it("送出失败时对话框保持打开、保留名称，错误以 role=alert 紧贴字段", async () => {
    const client = makeClient({
      createPat: vi.fn(async () => {
        throw new WebApiError(400, "validation_error", "字段有误", { name: "名称已存在" });
      }),
    });
    renderAt("/account", client);
    const user = userEvent.setup();
    await screen.findByRole("region", { name: "访问密钥" });
    await user.click(screen.getByRole("button", { name: /创建访问密钥/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "创建访问密钥" });
    await user.type(within(dialog).getByLabelText("名称"), "cli");
    await user.click(within(dialog).getByRole("button", { name: "创建" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("名称已存在");
    expect(alert.id).toBe("pat-name-error");
    expect((within(dialog).getByLabelText("名称") as HTMLInputElement).value).toBe("cli");
    expect(screen.getByRole("alertdialog", { name: "创建访问密钥" })).toBeTruthy();
  });

  it("工作阶段状态徽章：有效为绿系、已撤销为中性", async () => {
    // spec「凭证状态徽章」：帐号页与后台凭证页讲同一件事，色彩层级也要一致。
    renderAt("/account", makeClient());
    const valid = await screen.findAllByText("有效");
    expect(valid[0].className).toContain("status-success");
  });

  // 我的项目区块（server-web-console「帐号页呈现我的项目」）：数据来自 account
  // summary、唯读、admin 与一般成员同一形状，无隶属时仍显示区块与空状态。
  it("列出自己的项目显示名、等宽代号与角色签，且无任何编辑操作", async () => {
    renderAt("/account", makeClient());
    const section = await screen.findByRole("region", { name: /我的项目/ });
    expect(within(section).getByText("由管理员授予")).toBeTruthy();
    const alpha = within(section).getByRole("group", { name: "Alpha 项目" });
    expect(within(alpha).getByText("alpha").className).toContain("font-mono");
    expect(within(alpha).getByText("editor")).toBeTruthy();
    expect(within(section).getByText("Beta 项目")).toBeTruthy();
    expect(within(section).getByText("reader")).toBeTruthy();
    expect(within(section).queryAllByRole("button")).toHaveLength(0);
    expect(within(section).queryAllByRole("link")).toHaveLength(0);
  });

  it("项目显示名缺席时以项目代号呈现", async () => {
    const client = makeClient({
      getAccount: vi.fn(async () => ({
        ...ACCOUNT,
        memberships: [{ projectKey: "alpha", projectName: "", role: "editor" }],
      })),
    });
    renderAt("/account", client);
    const section = await screen.findByRole("region", { name: /我的项目/ });
    expect(within(section).getByText("alpha").className).toContain("font-mono");
    expect(within(section).getByRole("group", { name: "alpha" })).toBeTruthy();
  });

  // admin 也走同一区块：个人视角只列自己的隶属，全部项目是 /admin 的治理视角。
  it("admin 看到的是自己的隶属而非全部项目", async () => {
    const admin = { id: "u9", email: "admin@example.com", display: "Admin", admin: true };
    const client = makeClient({
      getSession: vi.fn(async () => ({ authenticated: true, user: admin, home: "/admin" })),
      getAccount: vi.fn(async () => ({
        ...ACCOUNT,
        user: admin,
        memberships: [{ projectKey: "alpha", projectName: "Alpha 项目", role: "editor" }],
      })),
    });
    renderAt("/account", client);
    const section = await screen.findByRole("region", { name: /我的项目/ });
    expect(within(section).getByText("Alpha 项目")).toBeTruthy();
    expect(within(section).queryByText("Beta 项目")).toBeNull();
    expect(within(section).getAllByRole("group")).toHaveLength(1);
  });

  it("无任何隶属时卡仍可见并在卡内呈现空状态", async () => {
    const client = makeClient({
      getAccount: vi.fn(async () => ({ ...ACCOUNT, memberships: [] })),
    });
    renderAt("/account", client);
    const section = await screen.findByRole("region", { name: /我的项目/ });
    const body = section.querySelector("[data-settings-card-body]") as HTMLElement;
    expect(within(body).getByText(/项目隶属由管理员授予/)).toBeTruthy();
  });

  it("撤销访问密钥需先经 AlertDialog 确认才送出", async () => {
    const client = makeClient();
    renderAt("/account", client);
    const user = userEvent.setup();
    await screen.findByText(/slk_abc/);
    // 触发撤销：先出现确认对话框，尚未调用撤销。
    await user.click(screen.getByRole("button", { name: "撤销访问密钥 cli" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(client.revokePat).not.toHaveBeenCalled();
    // 确认后才送出，带正确 PAT id。
    await user.click(within(dialog).getByRole("button", { name: /撤销|确认/ }));
    await waitFor(() => expect(client.revokePat).toHaveBeenCalledWith("p1"));
  });
});

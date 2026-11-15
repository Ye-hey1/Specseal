import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { REVEAL_ON_GROUP_HOVER } from "@specseal/ui";
import {
  AUDIT,
  REGISTRY,
  USERS,
  browserBack,
  currentLocation,
  makeAdminClient,
  makeUsers,
  renderAt,
  renderWithLocation,
  setViewport,
} from "./helpers/adminHarness";

// 用户详情页（server-web-console「管理列表以详情页与对话框承载查看与创建」「全部 browser route
// 由单一 SPA 提供可发现导览」；server-web-detail-pages design D1、D2、D5）：点用户列换成有网址的
// 详情页——页标题接状态签、卡片标头分页（概要／成员资格／凭证／稽核）；顶列面包屑三段、右端
// ‹ n / m › 依列表目前呈现的顺序切换；回列表时搜索、筛选与页码保持原样。

beforeEach(() => setViewport(false));

const crumbs = () => screen.getByRole("navigation", { name: "页面路径" });
const tab = (name: RegExp) => screen.getByRole("tab", { name });
const tabCount = (name: RegExp) => tab(name).querySelector("[data-tab-count]")?.textContent;
const hasRevealClasses = (el: Element) =>
  REVEAL_ON_GROUP_HOVER.split(" ").every((cls) => el.classList.contains(cls));

async function openMember(client = makeAdminClient()) {
  renderWithLocation(["/admin/users"], client);
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.click(await screen.findByRole("button", { name: "Member" }));
  await screen.findByRole("heading", { level: 1, name: "Member" });
  return user;
}

describe("进入详情页", () => {
  it("点用户列换成有网址的详情页：页标题接绿系状态签、四个分页，没有侧边滑出的面板", async () => {
    await openMember();
    expect(currentLocation()).toBe("/admin/users/m1");
    const heading = screen.getByRole("heading", { level: 1, name: "Member" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const header = heading.closest("[data-page-header]") as HTMLElement;
    expect(within(header).getByText("有效").className).toContain("status-success");
    expect(tab(/^概要/)).toBeTruthy();
    expect(tabCount(/^成员资格/)).toBe("1");
    // m1 有一把访问密钥与一个设备登录（凭证在详情页另外读取）。
    await waitFor(() => expect(tabCount(/^凭证/)).toBe("2"));
    expect(tab(/^稽核/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("以键盘移到列上按 Enter 同样进入详情页", async () => {
    renderWithLocation(["/admin/users"], makeAdminClient());
    const user = userEvent.setup();
    (await screen.findByRole("button", { name: "Member" })).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { level: 1, name: "Member" })).toBeTruthy();
    expect(currentLocation()).toBe("/admin/users/m1");
  });

  it("直接开 /admin/users/m1 呈现同一个详情页", async () => {
    renderWithLocation(["/admin/users/m1"], makeAdminClient());
    expect(await screen.findByRole("heading", { level: 1, name: "Member" })).toBeTruthy();
    expect(tabCount(/^成员资格/)).toBe("1");
    expect(currentLocation()).toBe("/admin/users/m1");
  });

  it("对不到数据时说明找不到并提供回到列表，顶列没有 ‹ n / m ›", async () => {
    renderWithLocation(["/admin/users/no-such-id"], makeAdminClient());
    expect(await screen.findByText("找不到这位用户")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "上一个" })).toBeNull();
    expect(screen.queryByRole("button", { name: "下一个" })).toBeNull();
    expect(crumbs().textContent).toBe("后台/用户");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "回到用户列表" }));
    expect(await screen.findByRole("heading", { level: 1, name: "用户" })).toBeTruthy();
    expect(currentLocation()).toBe("/admin/users");
  });
});

describe("顶列：面包屑与 ‹ n / m ›", () => {
  it("面包屑为「后台 / 用户 / Member」、侧栏高亮用户；点「用户」回到列表", async () => {
    const user = await openMember();
    expect(crumbs().textContent).toBe("后台/用户/Member");
    const nav = screen.getByRole("navigation", { name: "管理导览" });
    expect(within(nav).getByRole("link", { name: "用户" }).getAttribute("aria-current")).toBe("page");
    // 名称不可点。
    expect(within(crumbs()).queryByRole("button", { name: "Member" })).toBeNull();
    await user.click(within(crumbs()).getByRole("button", { name: "用户" }));
    expect(await screen.findByRole("heading", { level: 1, name: "用户" })).toBeTruthy();
    expect(currentLocation()).toBe("/admin/users");
    expect(crumbs().textContent).toBe("后台/用户");
  });

  it("回到列表保留状态筛选与页码", async () => {
    const client = makeAdminClient({ getAdminUsers: vi.fn(async () => ({ users: makeUsers(45), pending: [] })) });
    renderWithLocation(["/admin/users"], client);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await screen.findByText("第 1–20 笔，共 45 笔");
    await user.click(screen.getByRole("combobox", { name: /状态/ }));
    await user.click(await screen.findByRole("option", { name: "有效" }));
    await user.click(screen.getByRole("button", { name: "第 3 页" }));
    await screen.findByText("第 41–45 笔，共 45 笔");
    await user.click(screen.getByRole("button", { name: "User 41" }));
    await screen.findByRole("heading", { level: 1, name: "User 41" });
    await user.click(within(crumbs()).getByRole("button", { name: "用户" }));
    expect(await screen.findByText("第 41–45 笔，共 45 笔")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: /状态/ }).textContent).toContain("有效");
  });

  it("‹ n / m › 依搜索后的顺序切换、到头停用；切换不添加浏览纪录，上一页回到列表且搜索保留", async () => {
    // 12 位里有 3 位的 email 在 ops.example——关键字「ops.」只符合这 3 位（User 4、7、10）。
    const users = makeUsers(12).map((u, i) =>
      [3, 6, 9].includes(i) ? { ...u, email: u.email.replace("example.com", "ops.example") } : u,
    );
    const client = makeAdminClient({ getAdminUsers: vi.fn(async () => ({ users, pending: [] })) });
    renderWithLocation(["/admin/users"], client);
    const user = userEvent.setup();
    await screen.findByText("第 1–12 笔，共 12 笔");
    await user.type(screen.getByRole("textbox", { name: "搜索" }), "ops.");
    await screen.findByText("第 1–3 笔，共 3 笔");
    await user.click(screen.getByRole("button", { name: "User 7" }));
    await screen.findByRole("heading", { level: 1, name: "User 7" });
    expect(screen.getByText("2 / 3")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "下一个" }));
    expect(await screen.findByRole("heading", { level: 1, name: "User 10" })).toBeTruthy();
    expect(screen.getByText("3 / 3")).toBeTruthy();
    expect((screen.getByRole("button", { name: "下一个" }) as HTMLButtonElement).disabled).toBe(true);
    expect(currentLocation()).toBe("/admin/users/u10");

    await user.click(browserBack());
    expect(await screen.findByRole("heading", { level: 1, name: "用户" })).toBeTruthy();
    expect(currentLocation()).toBe("/admin/users");
    expect((screen.getByRole("textbox", { name: "搜索" }) as HTMLInputElement).value).toBe("ops.");
  });

  it("以键盘连按 ‹ ›：焦点留在按钮上，不跳回页标题", async () => {
    const client = makeAdminClient({ getAdminUsers: vi.fn(async () => ({ users: makeUsers(3), pending: [] })) });
    renderWithLocation(["/admin/users/u1"], client);
    const user = userEvent.setup();
    await screen.findByRole("heading", { level: 1, name: "User 1" });
    const next = screen.getByRole("button", { name: "下一个" });
    next.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { level: 1, name: "User 2" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "下一个" }));
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { level: 1, name: "User 3" })).toBeTruthy();
  });

  it("从列表进入详情页时焦点移到页标题", async () => {
    await openMember();
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Member" }));
  });
});

describe("页级动作与概要", () => {
  it("唯一有效管理员的管理员开关为开且停用，停权停用", async () => {
    renderAt("/admin/users/a1", makeAdminClient());
    await screen.findByRole("heading", { level: 1, name: "Admin" });
    const flag = screen.getByRole("switch", { name: "管理员" });
    expect(flag.getAttribute("aria-checked")).toBe("true");
    expect((flag as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "停权" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("概要列出电子邮件（可拷贝）、状态与创建日期；切换管理员开关即送出", async () => {
    const client = makeAdminClient();
    const user = await openMember(client);
    expect(screen.getByText("member@example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: /拷贝/ })).toBeTruthy();
    expect(screen.getByText("2026-01-02")).toBeTruthy();
    await user.click(screen.getByRole("switch", { name: "管理员" }));
    await waitFor(() => expect(client.adminSetAdminFlag).toHaveBeenCalledWith("m1", true));
  });

  it("「停权」开出指名用户的确认框，确认后才送出", async () => {
    const client = makeAdminClient();
    const user = await openMember(client);
    await user.click(screen.getByRole("button", { name: "停权" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Member");
    expect(client.adminSuspend).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "停权" }));
    await waitFor(() => expect(client.adminSuspend).toHaveBeenCalledWith("m1"));
  });
});

describe("成员资格分页", () => {
  it("角色下拉改为 reader 立即送出，重载后仍停在成员资格分页、该列显示 reader", async () => {
    const asReader = {
      ...USERS,
      users: [USERS.users[0], { ...USERS.users[1], memberships: [{ projectKey: "demo", role: "reader" }] }],
    };
    const client = makeAdminClient({
      getAdminUsers: vi.fn().mockResolvedValueOnce(USERS).mockResolvedValue(asReader),
    });
    const user = await openMember(client);
    await user.click(tab(/^成员资格/));
    await user.click(screen.getByRole("combobox", { name: "demo 的角色" }));
    await user.click(await screen.findByRole("option", { name: "reader" }));
    await waitFor(() =>
      expect(client.adminSetMembership).toHaveBeenCalledWith("m1", {
        projectKey: "demo",
        role: "reader",
        member: true,
      }),
    );
    await waitFor(() => expect(client.getAdminUsers).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(tab(/^成员资格/).getAttribute("aria-selected")).toBe("true"));
    expect(screen.getByRole("combobox", { name: "demo 的角色" }).textContent).toContain("reader");
    expect(screen.queryByRole("button", { name: /保存/ })).toBeNull();
  });

  it("移除钮滑过才出现；按下先确认并指名用户与项目，取消不送出、确认才送出；重载后该列消失、计数减一", async () => {
    const removed = { ...USERS, users: [USERS.users[0], { ...USERS.users[1], memberships: [] }] };
    const client = makeAdminClient({
      getAdminUsers: vi.fn().mockResolvedValueOnce(USERS).mockResolvedValue(removed),
    });
    const user = await openMember(client);
    await user.click(tab(/^成员资格/));
    const remove = screen.getByRole("button", { name: "移除 Member 在 demo 的成员资格" });
    expect(hasRevealClasses(remove)).toBe(true);

    await user.click(remove);
    let confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Member");
    expect(confirm.textContent).toContain("demo");
    await user.click(within(confirm).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(client.adminSetMembership).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "移除 Member 在 demo 的成员资格" }));
    confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "移除" }));
    await waitFor(() =>
      expect(client.adminSetMembership).toHaveBeenCalledWith("m1", {
        projectKey: "demo",
        role: "editor",
        member: false,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "demo 的角色" })).toBeNull());
    expect(tabCount(/^成员资格/)).toBe("0");
    expect(screen.getByText("尚未加入任何项目。")).toBeTruthy();
  });

  it("「加入项目」列的项目下拉只列尚未加入的项目，选好后按加入送出", async () => {
    const registry = {
      projects: [...REGISTRY.projects, { key: "ops", name: "Ops", repos: [] }],
    };
    const client = makeAdminClient({ getAdminRegistry: vi.fn(async () => registry) });
    const user = await openMember(client);
    await user.click(tab(/^成员资格/));
    const add = screen.getByRole("button", { name: "加入" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    await user.click(screen.getByRole("combobox", { name: "要加入的项目" }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["Ops（ops）"]);
    await user.click(screen.getByRole("option", { name: "Ops（ops）" }));
    await user.click(screen.getByRole("button", { name: "加入" }));
    await waitFor(() =>
      expect(client.adminSetMembership).toHaveBeenCalledWith("m1", {
        projectKey: "ops",
        role: "editor",
        member: true,
      }),
    );
  });
  it("加入列选好项目后按 ‹ › 换人：选择清空，不会替对方改掉既有角色", async () => {
    const registry = { projects: [...REGISTRY.projects, { key: "ops", name: "Ops", repos: [] }] };
    const users = {
      ...USERS,
      users: [
        { ...USERS.users[0], memberships: [{ projectKey: "ops", role: "reader" }] },
        USERS.users[1],
      ],
    };
    const client = makeAdminClient({
      getAdminRegistry: vi.fn(async () => registry),
      getAdminUsers: vi.fn(async () => users),
    });
    const user = await openMember(client);
    await user.click(tab(/^成员资格/));
    await user.click(screen.getByRole("combobox", { name: "要加入的项目" }));
    await user.click(await screen.findByRole("option", { name: "Ops（ops）" }));
    expect((screen.getByRole("button", { name: "加入" }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "上一个" }));
    await screen.findByRole("heading", { level: 1, name: "Admin" });
    expect((screen.getByRole("button", { name: "加入" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("项目清单还没加载时，加入列不说「已加入全部项目」", async () => {
    const client = makeAdminClient({ getAdminRegistry: vi.fn(() => new Promise(() => {})) });
    const user = await openMember(client);
    await user.click(tab(/^成员资格/));
    const picker = screen.getByRole("combobox", { name: "要加入的项目" });
    expect(picker.textContent).not.toContain("已加入全部项目");
    expect(picker.textContent).toContain("项目清单还没加载");
  });
});

describe("凭证与稽核分页", () => {
  it("凭证分页列出访问密钥与设备登录；有效项目的撤销钮滑过才出现，确认后才撤销", async () => {
    const client = makeAdminClient();
    const user = await openMember(client);
    await user.click(tab(/^凭证/));
    const panel = screen.getByRole("tabpanel");
    expect(await within(panel).findByText("cli")).toBeTruthy();
    expect(within(panel).getByText("slk_abc · 访问密钥 · 到期 永久 · 最近使用 从未")).toBeTruthy();
    expect(within(panel).getByText("desktop")).toBeTruthy();
    expect(within(panel).getByText("设备登录 · 最近更新 2026-01-03")).toBeTruthy();

    const revoke = screen.getByRole("button", { name: "撤销访问密钥 cli" });
    expect(hasRevealClasses(revoke)).toBe(true);
    await user.click(revoke);
    const confirm = await screen.findByRole("alertdialog");
    expect(client.adminRevokeToken).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(client.adminRevokeToken).toHaveBeenCalledWith("p1"));
  });

  it("稽核分页只列该用户的事件，动作为中文名称并附操作者", async () => {
    const audit = {
      ...AUDIT,
      entries: [
        ...AUDIT.entries,
        { id: "e2", actorId: "a1", action: "project-created", subject: "demo", source: "web", createdAt: "2026-01-04T00:00:00Z" },
      ],
    };
    const user = await openMember(makeAdminClient({ getAdminAudit: vi.fn(async () => audit) }));
    await user.click(tab(/^稽核/));
    const panel = screen.getByRole("tabpanel");
    expect(await within(panel).findByText("停权用户")).toBeTruthy();
    // 操作者以名称呈现。
    expect(within(panel).getByText("Admin")).toBeTruthy();
    expect(within(panel).getByText("2026-01-01")).toBeTruthy();
    expect(within(panel).queryByText("创建项目")).toBeNull();
  });
});

// 停权中的用户页级动作为重新激活（spec 用户详情页的页级动作）。
it("停权中的用户页级动作为「重新激活」，按下即送出", async () => {
  const users = { ...USERS, users: [USERS.users[0], { ...USERS.users[1], active: false }] };
  const client = makeAdminClient({ getAdminUsers: vi.fn(async () => users) });
  renderAt("/admin/users/m1", client);
  const heading = await screen.findByRole("heading", { level: 1, name: "Member" });
  const header = heading.closest("[data-page-header]") as HTMLElement;
  expect(within(header).getByText("已停权").className).toContain("status-warning");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "重新激活" }));
  await waitFor(() => expect(client.adminReactivate).toHaveBeenCalledWith("m1"));
});

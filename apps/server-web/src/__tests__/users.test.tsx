import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { I18nProvider, SEMANTIC_SURFACE } from "@specseal/ui";
import { WebApiError } from "../api/client";
import { ClientProvider, SessionProvider } from "../app/context";
import { APP_MESSAGES } from "../i18n/messages";
import { UsersSection } from "../pages/admin/UsersPage";
import {
  ADMIN_SESSION,
  makeAdminClient,
  makeUsers,
  REGISTRY,
  renderAt,
  setViewport,
  USERS,
} from "./helpers/adminHarness";

// 管理用户页（server-web-console「管理列表以详情页与对话框承载查看与创建」「管理列表提供搜索、
// 筛选、分页与具引导的空状态」「用户页呈现尚未接受的邀请」；server-web-list-pages design D2–D4；
// server-web-detail-pages design D4、D7）：页标题区右侧是搜索与状态筛选，其下一张列表卡，卡顶
// 「用户｜邀请中」两个分页，卡底共用换页列；用户列整列可点进详情页（详情页本身见
// userDetail.test.tsx）、列内不含输入控制项；邀请以置中对话框承载；破坏性动作维持确认框。

beforeEach(() => setViewport(false));

/** 目前网址与一颗「返回」钮：验证分页状态写在网址、且切换分页不添加浏览纪录。 */
function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{location.pathname + location.search}</output>
      <button type="button" onClick={() => navigate(-1)}>
        返回（测试）
      </button>
    </>
  );
}

/** 只渲染用户页本身（不经壳），网址由 LocationProbe 读出。 */
function renderUsersPage(entries: string[], client = makeAdminClient()) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
        <ClientProvider client={client as never}>
          <SessionProvider value={{ session: ADMIN_SESSION as never, refresh: async () => {} }}>
            <Routes>
              <Route path="/admin" element={<p>总览页</p>} />
              <Route path="/admin/users/*" element={<UsersSection />} />
            </Routes>
            <LocationProbe />
          </SessionProvider>
        </ClientProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

const location = () => screen.getByTestId("location").textContent;
const tab = (name: RegExp) => screen.getByRole("tab", { name });
const tabCount = (name: RegExp) => tab(name).querySelector("[data-tab-count]")?.textContent;
const userRowNames = () =>
  screen.getAllByRole("button", { name: /^User \d+$/ }).map((b) => b.textContent?.match(/User \d+/)?.[0]);

describe("用户分页的列", () => {
  it("用户列为可聚焦的按钮、名称即无障碍名称；列内有头像字、email、管理员签、状态签与项目数，不含输入控制项", async () => {
    renderAt("/admin/users", makeAdminClient());
    const admin = await screen.findByRole("button", { name: "Admin" });
    expect(admin.getAttribute("tabindex")).toBe("0");
    expect(admin.querySelector("[data-avatar]")?.textContent).toBe("A");
    expect(admin.textContent).toContain("admin@example.com");
    expect(within(admin).getByText("管理员")).toBeTruthy();
    expect(within(admin).getByText("有效").className).toContain("status-success");
    expect(within(admin).getByText("1 个项目")).toBeTruthy();

    const member = screen.getByRole("button", { name: "Member" });
    expect(within(member).queryByText("管理员")).toBeNull();
    // 列内不得有下拉、勾选框、文本输入或按钮。
    for (const role of ["combobox", "checkbox", "textbox", "button"]) {
      expect(within(member).queryAllByRole(role), `列内没有 ${role}`).toHaveLength(0);
    }
  });

  it("已停权为琥珀系状态签、没有隶属时为「尚无项目」；显示名称为空时头像字与名称退回 email", async () => {
    const users = {
      ...USERS,
      users: [
        USERS.users[0],
        { ...USERS.users[1], active: false, memberships: [] },
        { ...USERS.users[1], id: "n1", display: "", email: "zoe@example.com" },
      ],
    };
    renderAt("/admin/users", makeAdminClient({ getAdminUsers: vi.fn(async () => users) }));
    const member = await screen.findByRole("button", { name: "Member" });
    expect(within(member).getByText("已停权").className).toContain("status-warning");
    expect(within(member).getByText("尚无项目")).toBeTruthy();
    const nameless = screen.getByRole("button", { name: "zoe@example.com" });
    expect(nameless.querySelector("[data-avatar]")?.textContent).toBe("z");
  });

  it("没有列尾的「查看详细数据」钮，也没有表格", async () => {
    renderAt("/admin/users", makeAdminClient());
    await screen.findByRole("button", { name: "Member" });
    expect(screen.queryByRole("button", { name: /查看/ })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("卡顶分页与网址", () => {
  it("卡顶两个分页「用户」「邀请中」标示未经搜索与筛选的总数", async () => {
    renderAt("/admin/users", makeAdminClient());
    await screen.findByRole("button", { name: "Member" });
    expect(tabCount(/^用户/)).toBe("2");
    expect(tabCount(/^邀请中/)).toBe("1");
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "搜索" }), "member");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Admin" })).toBeNull());
    expect(tabCount(/^用户/)).toBe("2");
  });

  it("开 /admin/users?tab=pending 直接显示邀请中；切回用户后网址没有 tab，返回不会回到邀请中", async () => {
    renderUsersPage(["/admin", "/admin/users?tab=pending"]);
    expect(await screen.findByText("invited@example.com")).toBeTruthy();
    expect(tab(/^邀请中/).getAttribute("aria-selected")).toBe("true");
    const user = userEvent.setup();
    await user.click(tab(/^用户/));
    expect(await screen.findByRole("button", { name: "Member" })).toBeTruthy();
    expect(location()).toBe("/admin/users");
    await user.click(screen.getByRole("button", { name: "返回（测试）" }));
    expect(location()).toBe("/admin");
  });

  it("从用户分页切到邀请中，网址带 ?tab=pending；其他 tab 值视为用户分页", async () => {
    renderUsersPage(["/admin/users?tab=bogus"]);
    expect(await screen.findByRole("button", { name: "Member" })).toBeTruthy();
    expect(tab(/^用户/).getAttribute("aria-selected")).toBe("true");
    const user = userEvent.setup();
    await user.click(tab(/^邀请中/));
    expect(location()).toBe("/admin/users?tab=pending");
  });

  it("状态筛选只在用户分页出现", async () => {
    renderAt("/admin/users", makeAdminClient());
    expect(await screen.findByRole("combobox", { name: /状态/ })).toBeTruthy();
    const user = userEvent.setup();
    // 状态筛选不等数据，分页要等用户数据加载后才画出。
    await user.click(await screen.findByRole("tab", { name: /^邀请中/ }));
    await screen.findByText("invited@example.com");
    expect(screen.queryByRole("combobox", { name: /状态/ })).toBeNull();
    expect(screen.getByRole("textbox", { name: "搜索" })).toBeTruthy();
  });
});

describe("邀请中分页", () => {
  it("说明文本之下每笔一列：email、「显示名称 · 角色 · 加入 …」、到期日与撤回钮；列本身不可点开", async () => {
    renderAt("/admin/users?tab=pending", makeAdminClient());
    const email = await screen.findByText("invited@example.com");
    const row = email.closest("[data-invite]") as HTMLElement;
    expect(row.getAttribute("role")).toBeNull();
    expect(row.textContent).toContain("Invited · 成员 · 加入 demo");
    expect(row.textContent).toContain("到期 2026-01-10");
    expect(within(row).getByRole("button", { name: "撤回 invited@example.com 的邀请" })).toBeTruthy();
    expect(
      screen.getByText("已寄出但尚未接受的邀请。受邀者接受后才会成为「用户」分页里的一列。"),
    ).toBeTruthy();
    // 正式用户不混入邀请中分页。
    expect(screen.queryByRole("button", { name: "Member" })).toBeNull();
  });

  it("邀请没有要加入的项目时，说明省略「加入」那一段", async () => {
    const users = { ...USERS, pending: [{ ...USERS.pending[0], admin: true, memberships: [] }] };
    renderAt("/admin/users?tab=pending", makeAdminClient({ getAdminUsers: vi.fn(async () => users) }));
    const row = (await screen.findByText("invited@example.com")).closest("[data-invite]") as HTMLElement;
    expect(row.querySelector("[data-desc]")?.textContent).toBe("Invited · 管理员");
  });

  it("没有有效邀请时邀请中计数 0，切过去是空状态、没有换页列", async () => {
    renderAt(
      "/admin/users",
      makeAdminClient({ getAdminUsers: vi.fn(async () => ({ users: USERS.users, pending: [] })) }),
    );
    await screen.findByRole("button", { name: "Member" });
    expect(tabCount(/^邀请中/)).toBe("0");
    const user = userEvent.setup();
    await user.click(tab(/^邀请中/));
    expect(await screen.findByText("目前没有待接受的邀请")).toBeTruthy();
    expect(screen.queryByText(/^第 .+ 笔，共 .+ 笔$/)).toBeNull();
  });

  // 邀请寄错人或寄错权限时要收得回来——链接一旦流出去，唯一的止血就是让它失效。
  // 用「撤回」而非「取消」：确认框里的取消钮是「放弃这个操作」，两者并排会分不清。
  it("撤回邀请经 AlertDialog 确认后才送出，且对话框指名受邀者", async () => {
    const client = makeAdminClient();
    renderAt("/admin/users?tab=pending", client);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(await screen.findByRole("button", { name: "撤回 invited@example.com 的邀请" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("invited@example.com");
    expect(client.adminRevokeInvitation).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "撤回邀请" }));
    await waitFor(() => expect(client.adminRevokeInvitation).toHaveBeenCalledWith("i1"));
  });
});

describe("搜索、筛选与换页", () => {
  // 状态筛选是 Radix Select：点开 trigger 再点击项（Radix 打开时关闭 body 的
  // pointer-events，jsdom 没有真实命中测试，故关掉 userEvent 的检查）。
  it("关键字搜索与状态筛选收敛列表，无结果时呈现无符合状态并保留控制项、没有换页列", async () => {
    renderAt("/admin/users", makeAdminClient());
    await screen.findByRole("button", { name: "Member" });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.type(screen.getByRole("textbox", { name: "搜索" }), "member");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Admin" })).toBeNull());
    expect(screen.getByText("第 1–1 笔，共 1 笔")).toBeTruthy();
    await user.click(screen.getByRole("combobox", { name: /状态/ }));
    await user.click(await screen.findByRole("option", { name: "已停权" }));
    expect(await screen.findByText(/没有符合/)).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "搜索" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: /状态/ })).toBeTruthy();
    expect(screen.queryByText(/^第 .+ 笔，共 .+ 笔$/)).toBeNull();
  });

  it("页面填满主内容区、列在列表卡的卷动区内，换页列在卷动区之外", async () => {
    renderAt("/admin/users", makeAdminClient());
    const row = await screen.findByRole("button", { name: "Member" });
    const scroll = row.closest("[data-list-scroll]") as HTMLElement;
    expect(scroll).toBeTruthy();
    expect(scroll.contains(screen.getByText("第 1–2 笔，共 2 笔"))).toBe(false);
    const root = screen
      .getByRole("heading", { level: 1, name: "用户" })
      .closest("[data-page-header]")?.parentElement as HTMLElement;
    expect(root.className.split(/\s+/)).toEqual(expect.arrayContaining(["h-full", "min-h-0", "flex-col"]));
  });

  it("25 位用户时换页列为「第 1–20 笔，共 25 笔」，按第 2 页后只列第 21–25 位", async () => {
    const client = makeAdminClient({ getAdminUsers: vi.fn(async () => ({ users: makeUsers(25), pending: [] })) });
    renderAt("/admin/users", client);
    expect(await screen.findByText("第 1–20 笔，共 25 笔")).toBeTruthy();
    expect(userRowNames()).toHaveLength(20);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "第 2 页" }));
    expect(await screen.findByText("第 21–25 笔，共 25 笔")).toBeTruthy();
    expect(userRowNames()).toEqual(["User 21", "User 22", "User 23", "User 24", "User 25"]);
    // 换页在前端进行，不重新调用 browser API。
    expect(client.getAdminUsers).toHaveBeenCalledTimes(1);
  });

  it("停在第 2 页时搜索使清单回到第 1 页；只符合 3 位时没有页码钮", async () => {
    renderAt(
      "/admin/users",
      makeAdminClient({ getAdminUsers: vi.fn(async () => ({ users: makeUsers(21), pending: [] })) }),
    );
    await screen.findByText("第 1–20 笔，共 21 笔");
    const user = userEvent.setup();
    const search = screen.getByRole("textbox", { name: "搜索" });
    await user.click(screen.getByRole("button", { name: "第 2 页" }));
    await screen.findByText("第 21–21 笔，共 21 笔");
    // 「@」仍符合全部 21 位：页码若没重设会停在第 2 页。
    await user.type(search, "@");
    expect(await screen.findByText("第 1–20 笔，共 21 笔")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "第 2 页" }));
    await screen.findByText("第 21–21 笔，共 21 笔");
    await user.clear(search);
    await user.type(search, "user2");
    expect(await screen.findByText("第 1–3 笔，共 3 笔")).toBeTruthy();
    expect(userRowNames()).toEqual(["User 2", "User 20", "User 21"]);
    expect(screen.queryByRole("button", { name: "第 1 页" })).toBeNull();
  });
});

/** 打开邀请对话框；registry 有 demo 与 ops 两个项目。 */
async function openInvite(client = makeAdminClient({ getAdminRegistry: vi.fn(async () => TWO_PROJECTS) })) {
  renderAt("/admin/users", client);
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await screen.findByRole("button", { name: "Member" });
  await user.click(screen.getByRole("button", { name: /邀请用户/ }));
  const dialog = await screen.findByRole("alertdialog", { name: "邀请用户" });
  return { user, dialog };
}

const TWO_PROJECTS = { projects: [...REGISTRY.projects, { key: "ops", name: "Ops", repos: [] }] };

describe("邀请对话框", () => {
  it("邀请字段不常驻列表页，按下「邀请用户」后才出现在置中对话框", async () => {
    renderAt("/admin/users", makeAdminClient());
    await screen.findByRole("button", { name: "Member" });
    expect(screen.queryByLabelText(/电子邮件/)).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /邀请用户/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "邀请用户" });
    expect(within(dialog).getByLabelText(/电子邮件/)).toBeTruthy();
    expect(within(dialog).getByLabelText(/显示名称/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // 加入项目以下拉挑选再逐一移除，而不是每个项目一列 checkbox——项目数量会成长，
  // 一整栏的勾选框在十个项目之后就不可用了。
  it("项目下拉选一个项目后列入已选、不再出现在下拉，已选列可移除；焦点留在对话框内", async () => {
    const { user, dialog } = await openInvite();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    await user.click(within(dialog).getByRole("combobox", { name: /加入项目/ }));
    const listbox = await screen.findByRole("listbox");
    expect(dialog.contains(listbox)).toBe(true);
    await user.click(within(listbox).getByRole("option", { name: "Demo（demo）" }));
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(within(dialog).getByRole("button", { name: "移除 demo" })).toBeTruthy();

    await user.click(within(dialog).getByRole("combobox", { name: /加入项目/ }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["Ops（ops）"]);
    await user.keyboard("{Escape}");
    // Esc 只收起下拉，对话框还在。
    expect(screen.getByRole("alertdialog", { name: "邀请用户" })).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "移除 demo" }));
    expect(within(dialog).queryByRole("button", { name: "移除 demo" })).toBeNull();
  });

  it("送出收到含 fieldErrors 的 400 时对话框保持打开、保留输入，错误紧贴字段", async () => {
    const client = makeAdminClient({
      adminInvite: vi.fn(async () => {
        throw new WebApiError(400, "validation_error", "字段有误", {
          email: "email 格式不正确",
        });
      }),
    });
    const { user, dialog } = await openInvite(client);
    await user.type(within(dialog).getByLabelText(/电子邮件/), "bad");
    await user.type(within(dialog).getByLabelText(/显示名称/), "New");
    await user.click(within(dialog).getByRole("button", { name: /送出邀请/ }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("email 格式不正确");
    expect(alert.id).toBe("invite-email-error");
    expect(screen.getByRole("alertdialog", { name: "邀请用户" })).toBeTruthy();
    expect((within(dialog).getByLabelText(/电子邮件/) as HTMLInputElement).value).toBe("bad");
    expect((within(dialog).getByLabelText(/显示名称/) as HTMLInputElement).value).toBe("New");
  });

  it("送出成功后同一个对话框换成「邀请已创建」：绿系成功框内是完整邀请链接与「拷贝链接」，按「完成」后页面上没有链接、邀请中加一", async () => {
    const invited = {
      ...USERS,
      pending: [...USERS.pending, { ...USERS.pending[0], id: "i2", email: "new@example.com", display: "New" }],
    };
    const client = makeAdminClient({
      getAdminRegistry: vi.fn(async () => TWO_PROJECTS),
      getAdminUsers: vi.fn().mockResolvedValueOnce(USERS).mockResolvedValue(invited),
    });
    renderAt("/admin/users", client);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await screen.findByRole("button", { name: "Member" });
    expect(tabCount(/^邀请中/)).toBe("1");
    await user.click(screen.getByRole("button", { name: /邀请用户/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "邀请用户" });
    await user.type(within(dialog).getByLabelText(/电子邮件/), "new@example.com");
    await user.type(within(dialog).getByLabelText(/显示名称/), "New");
    await user.click(within(dialog).getByRole("combobox", { name: /加入项目/ }));
    await user.click(await screen.findByRole("option", { name: "Demo（demo）" }));
    await user.click(within(dialog).getByRole("button", { name: /送出邀请/ }));
    await waitFor(() =>
      expect(client.adminInvite).toHaveBeenCalledWith(
        expect.objectContaining({ email: "new@example.com", display: "New", memberships: ["demo"] }),
      ),
    );

    const done = await screen.findByRole("alertdialog", { name: "邀请已创建" });
    // 给受邀者的是可直接打开的链接，不是要他自己拼网址的 token。
    // （拷贝钮自己也带一个 sr-only 的 role=status，所以由链接文本回推外框。）
    const link = within(done).getByText(`${window.location.origin}/invite/invite-token-123`);
    const box = link.closest("[role='status']") as HTMLElement;
    expect(box.getAttribute("aria-live")).toBe("polite");
    expect(within(box).getByRole("button", { name: "拷贝链接" })).toBeTruthy();
    // spec「秘密值成功框为成功语意」：主色是链接／交互的颜色，用在这里读不出「成功了」。
    for (const cls of SEMANTIC_SURFACE.success.split(" ")) expect(box.classList.contains(cls)).toBe(true);
    expect(box.className).not.toContain("primary");
    // 成功当下就重载；对话框开着时页面对辅助技术隐藏，计数等关掉后再看。
    await waitFor(() => expect(client.getAdminUsers).toHaveBeenCalledTimes(2));

    await user.click(within(done).getByRole("button", { name: "完成" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(tabCount(/^邀请中/)).toBe("2");
    expect(screen.queryByText(/\/invite\/invite-token-123/)).toBeNull();
    await user.click(tab(/^邀请中/));
    expect((await screen.findByText("new@example.com")).closest("[data-invite]")).toBeTruthy();
  });

  it("点对话框以外的遮罩不关闭，按 Esc 关闭", async () => {
    const { user, dialog } = await openInvite();
    await user.type(within(dialog).getByLabelText(/电子邮件/), "new@example.com");
    // 遮罩是对话框内容的前一个兄弟节点（同 packages/ui 的确认框测试）。
    await user.click(dialog.previousElementSibling as HTMLElement);
    expect(screen.getByRole("alertdialog", { name: "邀请用户" })).toBeTruthy();
    expect((within(dialog).getByLabelText(/电子邮件/) as HTMLInputElement).value).toBe("new@example.com");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});

describe("窄屏幕", () => {
  it("用户列说明为「email · 管理员」、meta 只留状态签；换页列为窄版", async () => {
    setViewport(true);
    renderAt("/admin/users", makeAdminClient());
    const admin = await screen.findByRole("button", { name: "Admin" });
    expect(admin.querySelector("[data-desc]")?.textContent).toBe("admin@example.com · 管理员");
    expect(within(admin).queryByText("1 个项目")).toBeNull();
    expect(within(admin).getByText("有效")).toBeTruthy();
    const member = screen.getByRole("button", { name: "Member" });
    expect(member.querySelector("[data-desc]")?.textContent).toBe("member@example.com");
    expect(screen.getByText("第 1–2 笔，共 2 笔")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: /每页/ })).toBeNull();
  });

  it("窄屏幕点列同样进入详情页", async () => {
    setViewport(true);
    renderAt("/admin/users", makeAdminClient());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Member" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Member" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: /Member/ })).toBeNull();
  });
});

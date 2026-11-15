import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "@specseal/ui";
import { ClientProvider, SessionProvider } from "../app/context";
import { LocaleProvider } from "../i18n/LocaleContext";
import { APP_MESSAGES } from "../i18n/messages";
import { ConsoleLayout } from "../layouts/ConsoleLayout";
import { ADMIN_SESSION, makeAdminClient, renderAt, setViewport } from "./helpers/adminHarness";

// 主控台壳（server-web-console「全部 browser route 由单一 SPA 提供可发现导览」
// 「共用设计系统维持高密度可访问体验」）：管理员与一般成员共用同一种壳——侧栏（顶端字标、
// 中段导览、底部帐号菜单）加主栏（顶列面包屑、下方主内容），没有横贯顶部的 header。
// 管理员侧栏恰六个目的地（不含数据操作与帐号），一般成员只有「帐号」一项；帐号入口、
// 接口语言与注销收在侧栏底部的帐号菜单。

const MEMBER_SESSION = {
  authenticated: true,
  user: { id: "u1", email: "member@example.com", display: "Member", admin: false },
  home: "/account",
};

const ANONYMOUS = { authenticated: false, user: null, home: "/login" };

const DESTINATIONS = ["总览", "用户", "项目与保存库", "凭证", "系统", "稽核纪录"];

const ACCOUNT = {
  user: { id: "u1", email: "member@example.com", display: "Member", admin: false },
  memberships: [],
  pats: [],
  sessions: [],
  deviceFamilies: [],
};

function client(overrides: Record<string, unknown> = {}) {
  return makeAdminClient({ getAccount: vi.fn(async () => ACCOUNT), ...overrides });
}

function member() {
  return client({ getSession: vi.fn(async () => MEMBER_SESSION) });
}

function breadcrumbs() {
  return screen.getByRole("navigation", { name: "页面路径" });
}

const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

/** 只渲染壳本身：用来看路由不会停留的路径（例如管理面会立即导走的未知路径）。 */
function renderShellAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
        <LocaleProvider value={{ pref: null, setPref: () => {} }}>
          <ClientProvider client={client() as never}>
            <SessionProvider value={{ session: ADMIN_SESSION as never, refresh: async () => {} }}>
              <ConsoleLayout>
                <p>内容</p>
              </ConsoleLayout>
            </SessionProvider>
          </ClientProvider>
        </LocaleProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => setViewport(false));

describe("依角色裁切的主控台壳", () => {
  it("侧栏顶端是共用组件库的横式字标，页面没有横贯顶部的 header", async () => {
    renderAt("/admin", client());
    const sidebar = await screen.findByRole("complementary");
    // 深浅两版各一张、以 dark: 切换；第一张是浅色版（spec「品牌资产只有一处」）。
    const lockup = within(sidebar).getAllByAltText("Specseal")[0] as HTMLImageElement;
    expect(lockup.getAttribute("src")).toContain("logo-horizontal");
    expect(lockup.className).toContain("h-5");
    expect(screen.queryByRole("banner")).toBeNull();
  });

  it("侧栏恰有六个目的地，不含数据操作与帐号", async () => {
    renderAt("/admin", client());
    const nav = await screen.findByRole("navigation", { name: "管理导览" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent?.trim())).toEqual(DESTINATIONS);
    expect(within(nav).queryByText("数据操作")).toBeNull();
    expect(within(nav).queryByText("帐号")).toBeNull();
  });

  // design D4／D10：导览项是共用 NavItem——作用中为主色淡底主色字（不再实心主色），侧栏淡灰底。
  it("作用中目的地为主色淡底主色字，其余不是；侧栏底色为 bg-sidebar", async () => {
    renderAt("/admin", client());
    const nav = await screen.findByRole("navigation", { name: "管理导览" });
    expect(nav.closest("aside")?.className).toContain("bg-sidebar");
    const overview = within(nav).getByRole("link", { name: "总览" });
    expect(overview.getAttribute("aria-current")).toBe("page");
    expect(overview.className).toContain("text-primary");
    expect(overview.className).toContain("bg-primary/12");
    expect(overview.className).not.toContain("text-primary-foreground");
    const users = within(nav).getByRole("link", { name: "用户" });
    expect(users.className).not.toContain("text-primary");
    expect(users.getAttribute("aria-current")).toBeNull();
  });

  it("管理员于 /account 仍见完整侧栏且无项目高亮，面包屑为「帐号」", async () => {
    renderAt("/account", client());
    const nav = await screen.findByRole("navigation", { name: "管理导览" });
    for (const dest of DESTINATIONS) {
      expect(within(nav).getByText(dest), `sidebar has ${dest}`).toBeTruthy();
    }
    expect(within(nav).queryByRole("link", { current: "page" })).toBeNull();
    expect(breadcrumbs().textContent).toBe("帐号");
  });

  it("一般成员于 /account 有侧栏，只有作用中的「帐号」一项", async () => {
    renderAt("/account", member());
    const nav = await screen.findByRole("navigation", { name: "导览" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent?.trim())).toEqual(["帐号"]);
    expect(links[0].getAttribute("aria-current")).toBe("page");
    expect(links[0].getAttribute("href")).toBe("/account");
    expect(screen.queryByRole("navigation", { name: "管理导览" })).toBeNull();
    for (const dest of DESTINATIONS) {
      expect(screen.queryByRole("link", { name: dest }), `no admin dest ${dest}`).toBeNull();
    }
    expect(breadcrumbs().textContent).toBe("帐号");
  });

  // spec「管理壳版面数值与 Desktop 一致」「只有主内容区卷动」：壳本身满版不卷，侧栏与顶列
  // 固定，只有 main 卷动；顶列高度、侧栏宽度与主内容内距采 Desktop 壳的数值。
  it("版面数值与 Desktop 相同，且只有主内容区卷动", async () => {
    renderAt("/admin", client());
    const main = await screen.findByRole("main");
    const sidebar = screen.getByRole("complementary");
    expect(classes(sidebar.parentElement as HTMLElement)).toEqual(
      expect.arrayContaining(["h-screen", "overflow-hidden"]),
    );
    expect(classes(sidebar)).toEqual(expect.arrayContaining(["w-[200px]", "shrink-0"]));
    const sidebarTop = within(sidebar).getAllByAltText("Specseal")[0].parentElement as HTMLElement;
    expect(classes(sidebarTop)).toEqual(expect.arrayContaining(["h-12", "shrink-0"]));
    const topBar = breadcrumbs().parentElement as HTMLElement;
    expect(classes(topBar)).toEqual(expect.arrayContaining(["h-12", "shrink-0"]));
    expect(classes(main)).toEqual(expect.arrayContaining(["overflow-y-auto", "p-5"]));
  });
});

describe("主区顶列的面包屑", () => {
  it("/admin/users 为「后台 / 用户」，点「后台」回总览", async () => {
    const user = userEvent.setup();
    renderAt("/admin/users", client());
    await screen.findByRole("heading", { level: 1, name: "用户" });
    expect(breadcrumbs().textContent).toBe("后台/用户");

    await user.click(within(breadcrumbs()).getByRole("button", { name: "后台" }));
    expect(await screen.findByRole("heading", { level: 1, name: "总览" })).toBeTruthy();
    expect(breadcrumbs().textContent).toBe("后台/总览");
  });

  // 路由比对不分大小写：面包屑与侧栏高亮用同一套比对，手打大写网址也标得出位置。
  it("网址大小写不同时面包屑照样标出目的地", async () => {
    renderAt("/Admin/Users", client());
    await screen.findByRole("heading", { level: 1, name: "用户" });
    expect(breadcrumbs().textContent).toBe("后台/用户");
  });

  // server-web-detail-pages design D2：详情页为三段，目的地可点回列表、名称不可点。
  it("/admin/registry/demo 为「后台 / 项目与保存库 / Demo」，侧栏「项目与保存库」作用中", async () => {
    renderAt("/admin/registry/demo", client());
    await screen.findByRole("heading", { level: 1, name: "Demo" });
    expect(breadcrumbs().textContent).toBe("后台/项目与保存库/Demo");
    expect(within(breadcrumbs()).getByRole("button", { name: "项目与保存库" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "管理导览" });
    expect(within(nav).getByRole("link", { name: "项目与保存库" }).getAttribute("aria-current")).toBe("page");
  });

  it("未列在目的地表内的 /admin/* 路径只显示「后台」", () => {
    renderShellAt("/admin/unknown");
    expect(breadcrumbs().textContent).toBe("后台");
  });
});

describe("侧栏底部的帐号菜单", () => {
  it("触发钮显示名称与电子邮件；展开后标头为「email · 管理员」，含帐号、三个语言单选项与注销", async () => {
    const user = userEvent.setup();
    renderAt("/admin", client());
    const sidebar = await screen.findByRole("complementary");
    const trigger = within(sidebar).getByRole("button", { name: "帐号菜单：Admin" });
    expect(trigger.textContent).toContain("Admin");
    expect(trigger.textContent).toContain("admin@example.com");

    await user.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("admin@example.com · 管理员")).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "帐号" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "注销" })).toBeTruthy();
    const radios = within(menu).getAllByRole("menuitemradio");
    expect(radios.map((r) => r.textContent?.trim())).toEqual(["繁体中文", "English", "跟随系统"]);
    // 未明示偏好时标示「跟随系统」为目前选择。
    expect(within(menu).getByRole("menuitemradio", { name: "跟随系统" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("一般成员的菜单标头为「email · 成员」", async () => {
    const user = userEvent.setup();
    renderAt("/account", member());
    await user.click(await screen.findByRole("button", { name: "帐号菜单：Member" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("member@example.com · 成员")).toBeTruthy();
  });

  it("管理员选「帐号」前往帐号页", async () => {
    const user = userEvent.setup();
    renderAt("/admin", client());
    await user.click(await screen.findByRole("button", { name: "帐号菜单：Admin" }));
    await user.click(await screen.findByRole("menuitem", { name: "帐号" }));
    expect(await screen.findByRole("heading", { level: 1, name: "帐号" })).toBeTruthy();
    expect(breadcrumbs().textContent).toBe("帐号");
  });

  it("选「注销」撤销 session 并呈现登录页", async () => {
    const user = userEvent.setup();
    const c = client({
      getSession: vi.fn().mockResolvedValueOnce(ADMIN_SESSION).mockResolvedValue(ANONYMOUS),
    });
    renderAt("/admin", c);
    await user.click(await screen.findByRole("button", { name: "帐号菜单：Admin" }));
    await user.click(await screen.findByRole("menuitem", { name: "注销" }));
    expect(await screen.findByRole("heading", { level: 1, name: "登录" })).toBeTruthy();
    expect(c.logout).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("注销后依 server 回传的去处导向", async () => {
    const user = userEvent.setup();
    // session 保持登录，才看得出画面是被 destination 带走，而不是被登录守门弹回登录页。
    const c = client({ logout: vi.fn(async () => ({ destination: "/account" })) });
    renderAt("/admin", c);
    await user.click(await screen.findByRole("button", { name: "帐号菜单：Admin" }));
    await user.click(await screen.findByRole("menuitem", { name: "注销" }));
    expect(await screen.findByRole("heading", { level: 1, name: "帐号" })).toBeTruthy();
    expect(breadcrumbs().textContent).toBe("帐号");
  });

  it("注销请求失败时仍呈现登录页", async () => {
    const user = userEvent.setup();
    const c = client({ logout: vi.fn(async () => Promise.reject(new Error("network"))) });
    renderAt("/admin", c);
    await user.click(await screen.findByRole("button", { name: "帐号菜单：Admin" }));
    await user.click(await screen.findByRole("menuitem", { name: "注销" }));
    expect(await screen.findByRole("heading", { level: 1, name: "登录" })).toBeTruthy();
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("显示名称为空时，头像字与名称退回电子邮件", async () => {
    const session = { ...ADMIN_SESSION, user: { ...ADMIN_SESSION.user, display: "" } };
    renderAt("/admin", client({ getSession: vi.fn(async () => session) }));
    const trigger = await screen.findByRole("button", { name: "帐号菜单：admin@example.com" });
    // 头像字＋名称列＋email 列：名称列也是 email。
    expect(trigger.textContent).toBe("a" + "admin@example.com" + "admin@example.com");
  });
});

describe("窄屏幕导览", () => {
  it("768px 时「打开导览」开出从左滑出的 Sheet，含字标、六个目的地与帐号菜单钮", async () => {
    setViewport(true);
    const user = userEvent.setup();
    renderAt("/admin", client());
    const trigger = await screen.findByRole("button", { name: "打开导览" });
    expect(screen.queryByRole("complementary")).toBeNull();

    await user.click(trigger);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.className).toContain("left-0");
    expect(within(dialog).getAllByAltText("Specseal")[0].getAttribute("src")).toContain("logo-horizontal");
    const links = within(dialog).getAllByRole("link");
    expect(links.map((l) => l.textContent?.trim())).toEqual(DESTINATIONS);
    expect(within(dialog).getByRole("button", { name: "帐号菜单：Admin" })).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("一般成员 375px 时 Sheet 含字标与「帐号」一项", async () => {
    setViewport(true);
    const user = userEvent.setup();
    renderAt("/account", member());
    await user.click(await screen.findByRole("button", { name: "打开导览" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByAltText("Specseal").length).toBeGreaterThan(0);
    const links = within(dialog).getAllByRole("link");
    expect(links.map((l) => l.textContent?.trim())).toEqual(["帐号"]);
    expect(within(dialog).getByRole("button", { name: "帐号菜单：Member" })).toBeTruthy();
  });
});

// spec「共用设计系统维持高密度可访问体验」的「页标题与 Desktop 同款」（design D5）：
// 每页标题用共用 PageHeader，且是该页唯一的第一层标题。
describe("页标题区", () => {
  it.each([
    ["/admin", "总览", "这台 server 的用户、项目与凭证概况；点数字前往对应页。"],
    ["/admin/users", "用户", "能登录这台 server 的帐号。"],
    ["/admin/registry", "项目与保存库", "远程工作流程的范围：项目与其底下的保存库。"],
    ["/admin/credentials", "凭证", "所有用户的访问密钥与设备登录；撤销后立即失效。"],
    ["/admin/system", "系统", "运行环境、保存状态、导出与数据结构迁移。"],
    ["/admin/audit", "稽核纪录", "每一笔管理动作的纪录；只能查看，不能修改。"],
    ["/account", "帐号", "Member（member@example.com）——你的项目、访问密钥与登录纪录。"],
  ])("%s 恰有一个 h1「%s」，位于共用页标题区且附说明", async (route, title, description) => {
    renderAt(route, client());
    const heading = await screen.findByRole("heading", { level: 1, name: title });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const header = heading.closest("[data-page-header]") as HTMLElement;
    expect(header).not.toBeNull();
    expect(within(header).getByText(description)).toBeTruthy();
  });

  it("帐号页的显示名称为空时，说明退回电子邮件", async () => {
    const account = { ...ACCOUNT, user: { ...ACCOUNT.user, display: "" } };
    renderAt("/account", client({ getAccount: vi.fn(async () => account) }));
    const heading = await screen.findByRole("heading", { level: 1, name: "帐号" });
    const header = heading.closest("[data-page-header]") as HTMLElement;
    expect(
      within(header).getByText("member@example.com（member@example.com）——你的项目、访问密钥与登录纪录。"),
    ).toBeTruthy();
  });

  it("用户页的「邀请用户」在标题区的动作槽并保留导览标记", async () => {
    renderAt("/admin/users", client());
    const heading = await screen.findByRole("heading", { level: 1, name: "用户" });
    const header = heading.closest("[data-page-header]") as HTMLElement;
    const invite = within(header).getByRole("button", { name: "邀请用户" });
    expect(invite.getAttribute("data-tour")).toBe("list-primary");
  });
});

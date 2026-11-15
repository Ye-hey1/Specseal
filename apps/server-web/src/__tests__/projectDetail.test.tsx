import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WebApiError } from "../api/client";
import { REGISTRY, currentLocation, makeAdminClient, renderAt, renderWithLocation, setViewport } from "./helpers/adminHarness";

// 项目详情页（server-web-console「管理列表以详情页与对话框承载查看与创建」「不可变识别字段唯读且
// 更名为显式动作」；server-web-detail-pages design D1、D6、D7）：代号是身分、创建后不可变更，只以
// 唯读文本呈现；名称缺省唯读，按「更名」才在对话框里出现预填目前名称的输入框。分页为保存库与成员，
// 保存库每列可更名、末列添加保存库；成员唯读。

beforeEach(() => setViewport(false));

const tab = (name: RegExp) => screen.getByRole("tab", { name });
const tabCount = (name: RegExp) => tab(name).querySelector("[data-tab-count]")?.textContent;
const crumbs = () => screen.getByRole("navigation", { name: "页面路径" });

async function openDemo(client = makeAdminClient()) {
  renderAt("/admin/registry/demo", client);
  const heading = await screen.findByRole("heading", { level: 1, name: "Demo" });
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  return { user, header: heading.closest("[data-page-header]") as HTMLElement };
}

describe("项目详情页", () => {
  it("直接开 /admin/registry/demo：页标题为名称、说明标示代号创建后不可变更、保存库与成员两个分页，没有可编辑代号的输入框", async () => {
    const { header } = await openDemo();
    expect(header.textContent).toContain("代号 demo");
    expect(header.textContent).toContain("创建后不可变更");
    expect(tabCount(/^保存库/)).toBe("1");
    // 成员由用户清单反查：a1 与 m1 都在 demo。
    await waitFor(() => expect(tabCount(/^成员/)).toBe("2"));
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("保存库分页每列以唯读文本标示代号创建后不可变更", async () => {
    await openDemo();
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText("Backend")).toBeTruthy();
    expect(within(panel).getByText("代号 backend · 创建后不可变更")).toBeTruthy();
  });

  it("页标题区「更名」开出预填目前名称的对话框；确认后页标题与面包屑换成新名称", async () => {
    const renamed = { projects: [{ ...REGISTRY.projects[0], name: "Demo 2" }] };
    const client = makeAdminClient({
      getAdminRegistry: vi.fn().mockResolvedValueOnce(REGISTRY).mockResolvedValue(renamed),
    });
    const { user, header } = await openDemo(client);
    await user.click(within(header).getByRole("button", { name: "更名" }));
    const dialog = await screen.findByRole("alertdialog", { name: "更名项目" });
    expect(dialog.textContent).toContain("代号 demo 不会改变");
    const input = within(dialog).getByLabelText("项目名称") as HTMLInputElement;
    expect(input.value).toBe("Demo");
    await user.clear(input);
    await user.type(input, "Demo 2");
    await user.click(within(dialog).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(client.adminRenameProject).toHaveBeenCalledWith("demo", "Demo 2"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await screen.findByRole("heading", { level: 1, name: "Demo 2" })).toBeTruthy();
    expect(crumbs().textContent).toBe("后台/项目与保存库/Demo 2");
    expect(screen.getByRole("heading", { level: 1 }).closest("[data-page-header]")?.textContent).toContain("代号 demo");
  });

  it("更名失败时对话框保持打开、保留输入，错误以 role=alert 声明", async () => {
    const client = makeAdminClient({
      adminRenameProject: vi.fn(async () => {
        throw new WebApiError(400, "validation_error", "名称太长");
      }),
    });
    const { user, header } = await openDemo(client);
    await user.click(within(header).getByRole("button", { name: "更名" }));
    const dialog = await screen.findByRole("alertdialog", { name: "更名项目" });
    const input = within(dialog).getByLabelText("项目名称") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "Demo 2");
    await user.click(within(dialog).getByRole("button", { name: "确认" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("名称太长");
    expect(screen.getByRole("alertdialog", { name: "更名项目" })).toBeTruthy();
    expect(input.value).toBe("Demo 2");
  });

  it("保存库列的「更名 Backend」开出「更名保存库」对话框并以 adminRenameRepo 送出", async () => {
    const client = makeAdminClient();
    const { user } = await openDemo(client);
    await user.click(screen.getByRole("button", { name: "更名 Backend" }));
    const dialog = await screen.findByRole("alertdialog", { name: "更名保存库" });
    expect(dialog.textContent).toContain("代号 backend 不会改变");
    const input = within(dialog).getByLabelText("保存库名称") as HTMLInputElement;
    expect(input.value).toBe("Backend");
    await user.clear(input);
    await user.type(input, "后端");
    await user.click(within(dialog).getByRole("button", { name: "确认" }));
    await waitFor(() =>
      expect(client.adminRenameRepo).toHaveBeenCalledWith({ projectKey: "demo", key: "backend", name: "后端" }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("末列「添加保存库」开对话框；代号栏标示创建后不可变更，送出后关闭且保存库分页多一列", async () => {
    const added = {
      projects: [{ ...REGISTRY.projects[0], repos: [...REGISTRY.projects[0].repos, { key: "web", name: "web" }] }],
    };
    const client = makeAdminClient({
      getAdminRegistry: vi.fn().mockResolvedValueOnce(REGISTRY).mockResolvedValue(added),
    });
    const { user } = await openDemo(client);
    expect(screen.queryByLabelText(/保存库代号/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "添加保存库" }));
    const dialog = await screen.findByRole("alertdialog", { name: "添加保存库" });
    const key = within(dialog).getByLabelText("保存库代号");
    expect(document.getElementById(key.getAttribute("aria-describedby") ?? "")?.textContent).toBe("创建后不可变更。");
    await user.type(key, "web");
    await user.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() =>
      expect(client.adminCreateRepo).toHaveBeenCalledWith(expect.objectContaining({ projectKey: "demo", key: "web" })),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(tabCount(/^保存库/)).toBe("2"));
    expect(within(screen.getByRole("tabpanel")).getByText("代号 web · 创建后不可变更")).toBeTruthy();
  });

  it("成员分页唯读列出显示名称、电子邮件与角色签，没有按钮", async () => {
    const { user } = await openDemo();
    await waitFor(() => expect(tabCount(/^成员/)).toBe("2"));
    await user.click(tab(/^成员/));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText("Member")).toBeTruthy();
    expect(within(panel).getByText("member@example.com")).toBeTruthy();
    expect(within(panel).getAllByText("editor")).toHaveLength(2);
    expect(within(panel).queryAllByRole("button")).toHaveLength(0);
  });

  it("代号含 / ? # 的项目：点列进得了详情页，‹ › 切换也对得到", async () => {
    const odd = { key: "a/b?c#d", name: "Odd", repos: [] };
    const client = makeAdminClient({
      getAdminRegistry: vi.fn(async () => ({ projects: [...REGISTRY.projects, odd] })),
    });
    renderWithLocation(["/admin/registry"], client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Odd" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Odd" })).toBeTruthy();
    expect(screen.getByText("2 / 2")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "上一个" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Demo" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "下一个" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Odd" })).toBeTruthy();
  });

  it("对不到数据时说明找不到并提供回到项目列表", async () => {
    renderWithLocation(["/admin/registry/nope"], makeAdminClient());
    expect(await screen.findByText("找不到这个项目")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "上一个" })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "回到项目列表" }));
    expect(await screen.findByRole("heading", { level: 1, name: "项目与保存库" })).toBeTruthy();
    expect(currentLocation()).toBe("/admin/registry");
  });
});

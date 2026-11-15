import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WebApiError } from "../api/client";
import {
  currentLocation,
  makeAdminClient,
  REGISTRY,
  renderAt,
  renderWithLocation,
  setViewport,
} from "./helpers/adminHarness";

// 管理项目与保存库页（server-web-console「管理列表以详情页与对话框承载查看与创建」「管理列表提供
// 搜索、筛选、分页与具引导的空状态」；server-web-list-pages design D2、D3、D5；server-web-detail-pages
// design D1、D7）：项目以列表卡内的共用列呈现，整列可点进项目详情页（详情页本身见
// projectDetail.test.tsx）；创建项目以置中对话框承载，不常驻列表页。

beforeEach(() => setViewport(false));

async function openCreate(client = makeAdminClient()) {
  renderAt("/admin/registry", client);
  await screen.findByRole("button", { name: "Demo" });
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.click(screen.getByRole("button", { name: /创建项目/ }));
  return { user, dialog: await screen.findByRole("alertdialog", { name: "创建项目" }) };
}

describe("项目与保存库", () => {
  it("项目列为可聚焦的按钮、名称为无障碍名称、说明为「代号 <key> · n 个保存库」，列内没有输入控制项", async () => {
    renderAt("/admin/registry", makeAdminClient());
    const row = await screen.findByRole("button", { name: "Demo" });
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(row.querySelector("[data-desc]")?.textContent).toBe("代号 demo · 1 个保存库");
    expect(within(row).queryAllByRole("textbox")).toHaveLength(0);
    // 列尾没有另一颗「查看详细数据」钮：整列本身就是入口。
    expect(screen.queryByRole("button", { name: /查看/ })).toBeNull();
  });

  it("点项目列或以键盘移到列上按 Enter 都进入 /admin/registry/<代号>", async () => {
    renderWithLocation(["/admin/registry"], makeAdminClient());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Demo" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Demo" })).toBeTruthy();
    expect(currentLocation()).toBe("/admin/registry/demo");
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(within(screen.getByRole("navigation", { name: "页面路径" })).getByRole("button", { name: "项目与保存库" }));
    (await screen.findByRole("button", { name: "Demo" })).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { level: 1, name: "Demo" })).toBeTruthy();
    expect(currentLocation()).toBe("/admin/registry/demo");
  });

  it("没有项目时空状态说明用途、空状态内没有创建钮，页眉「创建项目」仍在", async () => {
    renderAt("/admin/registry", makeAdminClient({ getAdminRegistry: vi.fn(async () => ({ projects: [] })) }));
    expect(await screen.findByText("尚无项目")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /创建项目/ })).toHaveLength(1);
    expect(screen.queryByText(/^第 .+ 笔，共 .+ 笔$/)).toBeNull();
  });

  // server-web-console「管理列表提供搜索、筛选、分页与具引导的空状态」：项目与保存库页
  // SHALL 提供关键字搜索。
  it("关键字搜索收敛项目清单，无结果时呈现无符合状态并保留搜索框", async () => {
    renderAt("/admin/registry", makeAdminClient());
    expect(await screen.findByRole("button", { name: "Demo" })).toBeTruthy();
    expect(screen.getByText("第 1–1 笔，共 1 笔")).toBeTruthy();
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "搜索" }), "找不到的东西");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Demo" })).toBeNull());
    expect(screen.getByText(/没有符合/)).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "搜索" })).toBeTruthy();
    expect(screen.queryByText(/^第 .+ 笔，共 .+ 笔$/)).toBeNull();
  });

  it("搜索项目代号或保存库名称可筛出该项目", async () => {
    const registry = {
      projects: [...REGISTRY.projects, { key: "ops", name: "Operations", repos: [{ key: "infra", name: "Infra" }] }],
    };
    renderAt("/admin/registry", makeAdminClient({ getAdminRegistry: vi.fn(async () => registry) }));
    await screen.findByRole("button", { name: "Demo" });
    const user = userEvent.setup();
    const search = screen.getByRole("textbox", { name: "搜索" });
    await user.type(search, "backend");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Operations" })).toBeNull());
    expect(screen.getByRole("button", { name: "Demo" })).toBeTruthy();
    await user.clear(search);
    await user.type(search, "ops");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Demo" })).toBeNull());
    expect(screen.getByRole("button", { name: "Operations" })).toBeTruthy();
  });

});

describe("创建项目对话框", () => {
  // 「创建后不可变更」与初始设置同一种写法：标签只放名称，限制放在字段下方的灰字说明。
  it("「创建项目」开出置中对话框，代号栏以灰字说明标示创建后不可变更", async () => {
    const { dialog } = await openCreate();
    const projectKey = within(dialog).getByLabelText("项目代号");
    expect(document.getElementById(projectKey.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "创建后不可变更。",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // spec：对话框为 15px 标题加灰字说明（与其他创建类对话框同款）。
  it("对话框标题下有灰字说明", async () => {
    const { dialog } = await openCreate();
    const describedBy = dialog.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? "")?.textContent).toContain("代号创建后不可变更");
  });

  it("输入代号后点遮罩不关闭、代号仍在；按 Esc 关闭", async () => {
    const { user, dialog } = await openCreate();
    await user.type(within(dialog).getByLabelText("项目代号"), "ops");
    // 遮罩是对话框内容的前一个兄弟节点（同 packages/ui 的确认框测试）。
    await user.click(dialog.previousElementSibling as HTMLElement);
    expect(screen.getByRole("alertdialog", { name: "创建项目" })).toBeTruthy();
    expect((within(dialog).getByLabelText("项目代号") as HTMLInputElement).value).toBe("ops");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("送出成功后对话框关闭，列表多出新项目", async () => {
    const created = { projects: [...REGISTRY.projects, { key: "ops", name: "ops", repos: [] }] };
    const client = makeAdminClient({
      getAdminRegistry: vi.fn().mockResolvedValueOnce(REGISTRY).mockResolvedValue(created),
    });
    const { user, dialog } = await openCreate(client);
    await user.type(within(dialog).getByLabelText("项目代号"), "ops");
    await user.click(within(dialog).getByRole("button", { name: "创建项目" }));
    await waitFor(() => expect(client.adminCreateProject).toHaveBeenCalledWith({ key: "ops", name: undefined }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await screen.findByRole("button", { name: "ops" })).toBeTruthy();
  });

  it("字段错误时对话框保持打开、保留输入，错误紧贴字段", async () => {
    const client = makeAdminClient({
      adminCreateProject: vi.fn(async () => {
        throw new WebApiError(400, "validation_error", "字段有误", { key: "代号已存在" });
      }),
    });
    const { user, dialog } = await openCreate(client);
    await user.type(within(dialog).getByLabelText("项目代号"), "demo");
    await user.click(within(dialog).getByRole("button", { name: "创建项目" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("代号已存在");
    expect(alert.id).toBe("new-project-key-error");
    expect((within(dialog).getByLabelText("项目代号") as HTMLInputElement).value).toBe("demo");
  });
});

// fix-english-status-labels-and-plurals：server-web-console「后台英文计数文案依数量使用单数或复数」的项目列情境。
describe("英文接口的项目列计数", () => {
  beforeEach(() => localStorage.setItem("specseal.uiLocale", "en"));
  afterEach(() => localStorage.removeItem("specseal.uiLocale"));

  it("只有 1 个保存库时写「Key demo · 1 repository」", async () => {
    renderAt("/admin/registry", makeAdminClient());
    const row = await screen.findByRole("button", { name: "Demo" });
    expect(row.querySelector("[data-desc]")?.textContent).toBe("Key demo · 1 repository");
  });

  it("2 个保存库时写「Key demo · 2 repositories」", async () => {
    const registry = {
      projects: [
        { ...REGISTRY.projects[0], repos: [...REGISTRY.projects[0].repos, { key: "frontend", name: "Frontend" }] },
      ],
    };
    renderAt("/admin/registry", makeAdminClient({ getAdminRegistry: vi.fn(async () => registry) }));
    const row = await screen.findByRole("button", { name: "Demo" });
    expect(row.querySelector("[data-desc]")?.textContent).toBe("Key demo · 2 repositories");
  });
});

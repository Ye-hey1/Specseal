import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeAdminClient, renderAt, setViewport } from "./helpers/adminHarness";

// 管理稽核纪录页（server-web-console「管理列表提供搜索、筛选、分页与具引导的空状态」
// 与 server-admin「管理 browser API 提供最小且完整的页面 view model」；server-web-list-pages
// design D7）：页标题区是关键字、动作、来源与时间区间筛选；宽屏幕的表格放进列表卡、卡底是与其他
// 列表同一条换页列。SPA 只把筛选、页码与每页笔数送给 browser API，并只呈现服务器回传的当页
// 事件；「共 N 笔」取自回应的 total。

const PAGE_ONE = {
  entries: [
    {
      id: "e1",
      actorId: "a1",
      action: "user-invited",
      subject: "new@example.com",
      source: "web",
      createdAt: "2026-01-03T10:00:00Z",
    },
    {
      id: "e2",
      actorId: "a1",
      action: "project-created",
      subject: "demo",
      source: "cli",
      createdAt: "2026-01-02T10:00:00Z",
    },
  ],
  totalPages: 3,
  total: 45,
};

beforeEach(() => setViewport(false));

describe("稽核纪录页", () => {
  it("首次加载以第 1 页、每页 20 笔调用 browser API", async () => {
    const getAdminAudit = vi.fn(async () => PAGE_ONE);
    renderAt("/admin/audit", makeAdminClient({ getAdminAudit }));
    await screen.findByRole("table");
    expect(getAdminAudit).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, limit: 20 }));
  });

  it("换页列取自回应：「第 1–20 笔，共 45 笔」与页码钮 1–3", async () => {
    renderAt("/admin/audit", makeAdminClient({ getAdminAudit: vi.fn(async () => PAGE_ONE) }));
    expect(await screen.findByText("第 1–20 笔，共 45 笔")).toBeTruthy();
    for (const n of [1, 2, 3]) {
      expect(screen.getByRole("button", { name: `第 ${n} 页` })).toBeTruthy();
    }
    expect(screen.getByRole("combobox", { name: "每页 20 个" })).toBeTruthy();
  });

  it("按第 2 页以 page=2 重新调用", async () => {
    const getAdminAudit = vi.fn(async () => PAGE_ONE);
    renderAt("/admin/audit", makeAdminClient({ getAdminAudit }));
    await screen.findByText("第 1–20 笔，共 45 笔");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "第 2 页" }));
    await waitFor(() =>
      expect(getAdminAudit).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, limit: 20 })),
    );
    expect(await screen.findByText("第 21–40 笔，共 45 笔")).toBeTruthy();
  });

  it("换页时列表卡与换页列不卸载：加载期间照旧显示上一页，回应到了才替换", async () => {
    let release: (value: typeof PAGE_ONE) => void = () => {};
    const getAdminAudit = vi
      .fn()
      .mockImplementationOnce(async () => PAGE_ONE)
      .mockImplementationOnce(
        () =>
          new Promise<typeof PAGE_ONE>((resolve) => {
            release = resolve;
          }),
      );
    renderAt("/admin/audit", makeAdminClient({ getAdminAudit }));
    await screen.findByText("第 1–20 笔，共 45 笔");
    const user = userEvent.setup();
    const pageTwo = screen.getByRole("button", { name: "第 2 页" });
    await user.click(pageTwo);
    await waitFor(() => expect(getAdminAudit).toHaveBeenCalledTimes(2));
    // 加载中：表格、换页列与刚按的页码钮都还在（焦点不会掉回页眉）。
    expect(screen.getByRole("table")).toBeTruthy();
    expect(pageTwo.isConnected).toBe(true);
    expect(screen.queryByText("加载中…")).toBeNull();
    release({ ...PAGE_ONE, entries: [PAGE_ONE.entries[1]] });
    await waitFor(() => expect(screen.queryByText("new@example.com")).toBeNull());
    expect(screen.getByText("第 21–40 笔，共 45 笔")).toBeTruthy();
  });

  // 换页列在重抓期间仍可按：若点了旧页码列上较后面的页、而新结果的页数更少，服务器会回空页。
  // 回应到了发现页码越界，就拉回最后一页重抓，不让用户卡在空白页、换页列又消失。
  it("回应的总页数比目前页码少时，页码拉回最后一页并重新调用", async () => {
    const lastPage = { entries: [PAGE_ONE.entries[1]], totalPages: 1, total: 3 };
    let release: (value: typeof lastPage) => void = () => {};
    const getAdminAudit = vi
      .fn()
      .mockImplementationOnce(async () => PAGE_ONE)
      .mockImplementationOnce(async () => ({ entries: [], totalPages: 1, total: 3 }))
      .mockImplementationOnce(
        () =>
          new Promise<typeof lastPage>((resolve) => {
            release = resolve;
          }),
      );
    renderAt("/admin/audit", makeAdminClient({ getAdminAudit }));
    await screen.findByText("第 1–20 笔，共 45 笔");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "第 3 页" }));
    await waitFor(() =>
      expect(getAdminAudit).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 })),
    );
    expect(getAdminAudit).toHaveBeenCalledTimes(3);
    // 越界的空回应不当成「上一份」：重抓期间照旧显示上一页，不闪出空状态。
    expect(screen.queryByText(/没有符合/)).toBeNull();
    expect(screen.getByText("new@example.com")).toBeTruthy();
    release(lastPage);
    expect(await screen.findByText("第 1–3 笔，共 3 笔")).toBeTruthy();
    expect(screen.queryByText("new@example.com")).toBeNull();
    expect(screen.getByText("demo")).toBeTruthy();
  });

  it("停在第 3 页时改每页 50 笔，以 page=1、limit=50 重新调用", async () => {
    const getAdminAudit = vi.fn(async () => PAGE_ONE);
    renderAt("/admin/audit", makeAdminClient({ getAdminAudit }));
    await screen.findByText("第 1–20 笔，共 45 笔");
    // 每页笔数是 Radix Select：关掉 userEvent 的 pointer-events 检查（jsdom 没有命中测试）。
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole("button", { name: "第 3 页" }));
    await screen.findByText("第 41–45 笔，共 45 笔");
    await user.click(screen.getByRole("combobox", { name: "每页 20 个" }));
    await user.click(await screen.findByRole("option", { name: "每页 50 个" }));
    await waitFor(() =>
      expect(getAdminAudit).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, limit: 50 })),
    );
    expect(await screen.findByText("第 1–45 笔，共 45 笔")).toBeTruthy();
  });

  it("任一筛选变更回到第 1 页，筛选值送进 browser API", async () => {
    const getAdminAudit = vi.fn(async () => PAGE_ONE);
    renderAt("/admin/audit", makeAdminClient({ getAdminAudit }));
    await screen.findByText("第 1–20 笔，共 45 笔");
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole("button", { name: "第 2 页" }));
    await waitFor(() => expect(getAdminAudit).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
    await user.click(screen.getByRole("combobox", { name: "动作" }));
    await user.click(await screen.findByRole("option", { name: "邀请用户" }));
    await waitFor(() =>
      expect(getAdminAudit).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: "user-invited", page: 1 }),
      ),
    );
  });

  it("关键字与时间区间也送进 browser API", async () => {
    const getAdminAudit = vi.fn(async () => PAGE_ONE);
    renderAt("/admin/audit", makeAdminClient({ getAdminAudit }));
    await screen.findByRole("table");
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "搜索" }), "demo");
    await user.type(screen.getByLabelText("起始日期"), "2026-01-01");
    await user.type(screen.getByLabelText("结束日期"), "2026-01-31");
    await waitFor(() =>
      expect(getAdminAudit).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: "demo", from: "2026-01-01", to: "2026-01-31", page: 1 }),
      ),
    );
  });

  it("宽屏幕表格五栏照旧、表头固定且在列表卡内，来源为中性状态签", async () => {
    renderAt("/admin/audit", makeAdminClient({ getAdminAudit: vi.fn(async () => PAGE_ONE) }));
    const table = await screen.findByRole("table");
    const card = table.closest("[data-list-card]");
    expect(card).toBeTruthy();
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["时间", "动作", "对象", "操作者", "来源"]);
    const head = table.querySelector("thead") as HTMLElement;
    expect(head.className).toContain("sticky");
    expect(within(table).getAllByRole("row")).toHaveLength(3); // 表头 + 两笔
    expect(within(table).getByText("浏览器").className).toContain("bg-muted");
  });

  it("筛选后没有事件时呈现空状态、工具列仍在、没有换页列", async () => {
    const getAdminAudit = vi.fn(async () => ({ entries: [], totalPages: 0, total: 0 }));
    renderAt("/admin/audit", makeAdminClient({ getAdminAudit }));
    expect(await screen.findByText(/没有符合/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    // 筛选控制项仍在，用户才能改回来。
    expect(screen.getByRole("textbox", { name: "搜索" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "动作" })).toBeTruthy();
    expect(screen.queryByText(/^第 .+ 笔，共 .+ 笔$/)).toBeNull();
  });

  it("没有旧的「第 n / m 页」与上一页／下一页文本钮", async () => {
    renderAt("/admin/audit", makeAdminClient({ getAdminAudit: vi.fn(async () => PAGE_ONE) }));
    await screen.findByText("第 1–20 笔，共 45 笔");
    expect(screen.queryByText(/第 1 \/ 3 页/)).toBeNull();
  });

  it("窄屏幕：每笔一列（日期、动作名称、「对象 · 操作者」、来源签），换页列为窄版", async () => {
    setViewport(true);
    renderAt("/admin/audit", makeAdminClient({ getAdminAudit: vi.fn(async () => PAGE_ONE) }));
    const row = (await screen.findByText("邀请用户")).closest("[data-audit]") as HTMLElement;
    expect(screen.queryByRole("table")).toBeNull();
    expect(row.getAttribute("role")).toBeNull();
    expect(row.textContent).toContain("2026-01-03");
    expect(row.querySelector("[data-desc]")?.textContent).toBe("new@example.com · a1");
    expect(within(row).getByText("浏览器")).toBeTruthy();
    expect(screen.getByText("第 1–20 笔，共 45 笔")).toBeTruthy();
    expect(screen.getByText("1 / 3")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: /每页/ })).toBeNull();
  });
});

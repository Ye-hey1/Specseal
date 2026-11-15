import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import { WebApiError } from "../api/client";
import { makeAdminClient, renderAt, setViewport } from "./helpers/adminHarness";

// 系统页（server-web-console「数据操作目的地已并入系统」「共用设计系统维持高密度可访问体验」
// 的设置型页条款；server-web-list-pages design D10）：768px 置中栏，运行环境、保存状态、导出与
// 危险区四张设置型卡，各值为卡内的列；数据来自单一 view model。取得失败时整页呈现错误与重试
// 入口——不部分渲染陈旧数据，因为 Store 健康在整个接口只该有一处权威来源。

beforeEach(() => setViewport(false));

describe("系统页", () => {
  it("侧栏不含数据操作目的地", async () => {
    renderAt("/admin/system", makeAdminClient());
    const nav = await screen.findByRole("navigation", { name: "管理导览" });
    expect(within(nav).queryByText("数据操作")).toBeNull();
    expect(within(nav).getByText("系统")).toBeTruthy();
  });

  it("单页呈现运行环境、保存状态、导出与危险区四个区段", async () => {
    renderAt("/admin/system", makeAdminClient());
    for (const section of ["运行环境", "保存状态", "导出", "危险区"]) {
      expect(
        await screen.findByRole("region", { name: section }),
        `系统页有「${section}」区段`,
      ).toBeTruthy();
    }
  });

  it("运行环境与保存状态的字段来自同一份 view model", async () => {
    const getAdminSystem = vi.fn(async () => ({
      engineVersion: "0.1.0",
      apiVersion: "1",
      identitySchemaVersion: 6,
      storeDriver: "sqlite",
      storeContractVersion: 3,
      storeLevel: "full",
      storeCapabilities: ["migration", "backup"],
      storeHealthy: true,
      storeHealthError: null,
      outboxBacklogs: [{ project: "demo", repo: "backend", backlog: 0 }],
      scopes: [{ project: "demo", repo: "backend", exportPath: "/admin/data/export/demo/backend" }],
      migrateAvailable: true,
    }));
    renderAt("/admin/system", makeAdminClient({ getAdminSystem }));
    const runtime = await screen.findByRole("region", { name: "运行环境" });
    expect(within(runtime).getByRole("group", { name: "引擎版本" }).textContent).toContain("0.1.0");
    expect(within(runtime).getByRole("group", { name: "保存后端" }).textContent).toContain("sqlite");
    const storage = screen.getByRole("region", { name: "保存状态" });
    expect(within(storage).getByRole("group", { name: "保存后端" }).textContent).toContain("正常");
    expect(within(storage).getByRole("group", { name: "demo/backend" }).textContent).toContain("0");
    const exports = screen.getByRole("region", { name: "导出" });
    const scope = within(exports).getByRole("group", { name: "demo/backend" });
    expect(
      within(scope).getByRole("link", { name: /demo\/backend|导出/ }).getAttribute("href"),
    ).toBe("/admin/data/export/demo/backend");
    // 单一 view model：整页只打一支 API。
    expect(getAdminSystem).toHaveBeenCalledTimes(1);
  });

  it("view model 取得失败时整页呈现错误与重试入口，不部分渲染", async () => {
    renderAt(
      "/admin/system",
      makeAdminClient({
        getAdminSystem: vi.fn(async () => {
          throw new WebApiError(500, "internal", "服务器错误");
        }),
      }),
    );
    expect(await screen.findByRole("button", { name: /重试/ })).toBeTruthy();
    for (const section of ["运行环境", "保存状态", "导出", "危险区"]) {
      expect(
        screen.queryByRole("region", { name: section }),
        `失败时不渲染「${section}」`,
      ).toBeNull();
    }
  });

  it("内容栏 768px 置中、没有表格", async () => {
    renderAt("/admin/system", makeAdminClient());
    await screen.findByRole("region", { name: "运行环境" });
    const column = screen
      .getByRole("heading", { level: 1, name: "系统" })
      .closest("[data-page-header]")?.parentElement as HTMLElement;
    expect(column.className).toContain("max-w-[768px]");
    expect(column.className).toContain("mx-auto");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("迁移在危险区的「数据结构迁移」列，经 AlertDialog 确认后才送出", async () => {
    const client = makeAdminClient();
    renderAt("/admin/system", client);
    const danger = await screen.findByRole("region", { name: "危险区" });
    expect(within(danger).getByRole("group", { name: "数据结构迁移" })).toBeTruthy();
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    await user.click(within(danger).getByRole("button", { name: /迁移/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(client.adminMigrate).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: /迁移|确认/ }));
    expect(client.adminMigrate).toHaveBeenCalledOnce();
  });

  it("保存后端不可用时停用迁移并说明原因", async () => {
    renderAt(
      "/admin/system",
      makeAdminClient({
        getAdminSystem: vi.fn(async () => ({
          engineVersion: "0.1.0",
          apiVersion: "1",
          identitySchemaVersion: 6,
          storeDriver: "sqlite",
          storeContractVersion: 3,
          storeLevel: "full",
          storeCapabilities: [],
          storeHealthy: false,
          storeHealthError: "store unreachable",
          outboxBacklogs: [],
          scopes: [],
          migrateAvailable: false,
        })),
      }),
    );
    const danger = await screen.findByRole("region", { name: "危险区" });
    expect((within(danger).getByRole("button", { name: /迁移/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    const storage = screen.getByRole("region", { name: "保存状态" });
    expect(within(storage).getByRole("group", { name: "保存后端" }).textContent).toContain(
      "store unreachable",
    );
    // spec「保存健康徽章」：徽章与同区的错误消息同语意色层级。
    expect(within(storage).getByText("异常").className).toContain("destructive");
  });

  it("旧的 /admin/data 链接导向系统页", async () => {
    renderAt("/admin/data", makeAdminClient());
    expect(await screen.findByRole("heading", { name: "系统" })).toBeTruthy();
  });
});

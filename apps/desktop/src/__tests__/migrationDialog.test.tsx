import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nProvider, SEMANTIC_TONE } from "@specseal/ui";

import { MigrationDialog } from "../components/MigrationDialog";
import type { MigrationAdapter, MigrationResult } from "../adapter/migration";
import type { ConnectionView, ConnectionsAdapter } from "../adapter/connections";
import { APP_MESSAGES } from "../i18n/messages";

const CONNECTION: ConnectionView = {
  id: "conn_1",
  origin: "https://spec.example.test",
  name: "团队 Server",
  loggedIn: true,
};

const SCOPES = {
  projects: [
    {
      id: "prj_1",
      key: "specseal",
      name: "Specseal",
      repos: [{ id: "repo_1", key: "desktop", name: "Desktop" }],
    },
  ],
};

const RESULT: MigrationResult = {
  report: {
    projectRevision: 8,
    documents: Array.from({ length: 14 }, (_, index) => ({ index })),
  },
  backupPath: "/work/local/specseal.migrated-2026-07-21",
  checkoutRoot: "/work/local",
};

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
    {children}
  </I18nProvider>
);

function renderDialog(migrate: MigrationAdapter["migrate"]) {
  const onMigrated = vi.fn().mockResolvedValue(undefined);
  const connectionAdapter: Pick<ConnectionsAdapter, "scopes"> = {
    scopes: vi.fn().mockResolvedValue(SCOPES),
  };
  render(
    <MigrationDialog
      open
      root="/work/local"
      connections={[CONNECTION]}
      connectionAdapter={connectionAdapter}
      migration={{ migrate, adoptRemote: vi.fn() }}
      onOpenChange={vi.fn()}
      onMigrated={onMigrated}
    />,
    { wrapper: zhWrapper },
  );
  return { connectionAdapter, onMigrated };
}

async function reachConfirmation() {
  fireEvent.click(screen.getByRole("button", { name: /团队 Server/ }));
  const repo = await screen.findByRole("radio", { name: /Desktop/ });
  fireEvent.click(repo);
  fireEvent.click(screen.getByRole("button", { name: "检查迁移" }));
}

describe("MigrationDialog", () => {
  it("选空 scope、确认目标与备份、显示进度，成功后原地转成 checkout remote 分页", async () => {
    let resolveMigration: (result: MigrationResult) => void = () => {};
    const migrate = vi.fn(
      () =>
        new Promise<MigrationResult>((resolve) => {
          resolveMigration = resolve;
        }),
    );
    const { connectionAdapter, onMigrated } = renderDialog(migrate);

    await reachConfirmation();

    expect(screen.getAllByText("specseal / desktop")).toHaveLength(2);
    expect(screen.getByText(/本机规格文档夹.*改名备份/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "开始迁移" }));

    expect(screen.getByRole("status").textContent).toContain("正在创建 Bundle 并上传");
    resolveMigration(RESULT);

    await waitFor(() =>
      expect(migrate).toHaveBeenCalledWith(
        "/work/local",
        "conn_1",
        "specseal",
        "desktop",
      ),
    );
    await waitFor(() =>
      expect(onMigrated).toHaveBeenCalledWith(
        "conn_1",
        "specseal/desktop",
        "/work/local",
      ),
    );
    expect(connectionAdapter.scopes).toHaveBeenCalledWith("conn_1");
    expect(screen.getByText(/已迁移 14 份文档/)).toBeTruthy();
    expect(screen.getByText(RESULT.backupPath)).toBeTruthy();
  });

  it("状态语意色：eyebrow 中性、备份警语琥珀、进行中为蓝、成功为绿", async () => {
    // spec「进行中以蓝呈现」「成功以绿呈现」：主色同时当「进行中」与「成功」，
    // 两个结局长得一样，用户分不出迁移跑完没。
    let resolveMigration: (result: MigrationResult) => void = () => {};
    const migrate = vi.fn(
      () => new Promise<MigrationResult>((resolve) => { resolveMigration = resolve; }),
    );
    renderDialog(migrate);
    await reachConfirmation();

    const dialog = screen.getByTestId("migration-dialog");
    const eyebrow = screen.getByText("Local → Remote").closest("div") as HTMLElement;
    expect(eyebrow.className).not.toContain("text-primary");
    expect(screen.getByText(/本机规格文档夹.*改名备份/).closest("div")!.className).toContain("status-warning");

    fireEvent.click(screen.getByRole("button", { name: "开始迁移" }));
    const running = screen.getByRole("status");
    expect(running.className).toContain("status-progress");
    expect(running.querySelector("svg")?.getAttribute("class")).toContain(SEMANTIC_TONE.inProgress);

    resolveMigration(RESULT);
    await screen.findByText(/已迁移 14 份文档/);
    const check = dialog.querySelector(".rounded-full") as HTMLElement;
    expect(check.className).toContain("status-success");
    expect(check.className).not.toContain("bg-primary");
  });

  it("server 拒绝时原样呈现错误且不转换分页", async () => {
    const migrate = vi
      .fn()
      .mockRejectedValue(new Error("409 create-new import requires an empty target scope"));
    const { onMigrated } = renderDialog(migrate);

    await reachConfirmation();
    fireEvent.click(screen.getByRole("button", { name: "开始迁移" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "409 create-new import requires an empty target scope",
    );
    expect(onMigrated).not.toHaveBeenCalled();
  });
});

// remote 测试共用 fixtures：capability 矩阵（决策 1）、假 remote dataSource
// 与假 remote session——remoteOpen（store 面）与 remoteCapabilities（App 面）
// 测试共用。
import { vi } from "vitest";
import type { SpecsealDataSource } from "@specseal/ui";

import type { WorkspaceCapabilities, WorkspaceSession } from "../../session";
import { changeList } from "./changeList";

export const REMOTE_KEY = "remote:c1/demo/backend";

/** remote capability 描述：直达／组合真、不支持假（决策 1 矩阵）。 */
export const REMOTE_CAPS: WorkspaceCapabilities = {
  listChanges: true,
  listSpecs: true,
  listArchived: true,
  status: true,
  getDocument: true,
  getSpecDocument: true,
  searchWorkspace: true,
  changeCapabilities: true,
  changeMeta: true,
  deleteChange: false,
  setTaskDone: true,
  setAllTasks: true,
  moveTask: false,
  validate: false,
  analyze: false,
  archive: true,
  getArchivedDocument: true,
  archivedCapabilities: true,
  listDiscussions: true,
  getDiscussionDocument: true,
  promoteDiscussion: true,
  archiveDiscussion: true,
  reorderCard: false,
  setDepends: false,
  claim: true,
  policyWrite: true,
  liveUpdates: true,
};

/** 假 remote dataSource：直达方法回真值样本；其余不支持方法拒绝（镜射 remote adapter）。 */
export function fakeRemoteDs(over: Partial<SpecsealDataSource> = {}): SpecsealDataSource {
  const refuse = () => Promise.reject(new Error("此 server 尚未提供——功能已停用"));
  return {
    listChanges: vi.fn().mockResolvedValue(changeList([
      // 已就绪（2/2）：抽屉封存钮的阶段守门放行，capability 测试聚焦能力缺口本身。
      { name: "remote-change", status: "in-progress", totalTasks: 2, completedTasks: 2 },
    ])),
    listSpecs: vi.fn().mockResolvedValue([{ id: "auth" }]),
    listArchived: vi.fn().mockResolvedValue([
      {
        datedName: "2026-07-04-remote-old",
        date: "2026-07-04",
        name: "remote-old",
        tasksTotal: 1,
        tasksDone: 1,
        specCount: 1,
        // 与抽屉诠释数据的 "Remote Creator" 错开——负向断言（旧 server 缺
        // 归属字段）以 queryByText 验缺席，封存卡字符串不得撞名。
        createdBy: "Archived Author",
        fromDiscussions: [],
      },
    ]),
    status: vi.fn().mockResolvedValue({
      changeName: "remote-change",
      schemaName: "spec-driven",
      isComplete: false,
      applyRequires: ["tasks"],
      artifacts: [],
    }),
    getDocument: vi.fn().mockResolvedValue("- [ ] 1.1 First\n- [ ] 1.2 Second\n"),
    getSpecDocument: vi.fn().mockResolvedValue("# auth Specification\n\nRemote canonical truth.\n"),
    searchWorkspace: vi.fn().mockResolvedValue([]),
    // remote-read-parity：诠释数据与 capability 清单以 status payload 映射直达。
    changeCapabilities: vi.fn().mockResolvedValue(["auth"]),
    changeMeta: vi.fn().mockResolvedValue({
      schema: "spec-driven",
      created: "2026-07-29",
      createdBy: "Remote Creator",
      createdWith: "claude-code",
      fromDiscussions: [],
      startedAt: "2026-08-25T00:00:00Z",
      startedBy: "Remote Creator",
    }),
    deleteChange: vi.fn(refuse),
    setTaskDone: vi.fn().mockResolvedValue(undefined),
    setAllTasks: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn(refuse),
    runVerb: vi.fn().mockResolvedValue({}),
    getArchivedDocument: vi.fn().mockResolvedValue("## Why\n\nRemote archived truth.\n"),
    archivedCapabilities: vi.fn().mockResolvedValue(["auth"]),
    listDiscussions: vi.fn().mockResolvedValue({ active: [], archived: [] }),
    getDiscussionDocument: vi.fn().mockResolvedValue(null),
    promoteDiscussion: vi.fn().mockResolvedValue({ change: "chg" }),
    archiveDiscussion: vi.fn().mockResolvedValue(undefined),
    reorderCard: vi.fn(refuse),
    claim: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as SpecsealDataSource;
}

/** 假 remote session（handshake 成功后的形状）。 */
export function fakeRemoteSession(ds: SpecsealDataSource): WorkspaceSession {
  return {
    id: REMOTE_KEY,
    locator: { kind: "remote", connectionId: "c1", projectId: "demo", repoId: "backend" },
    descriptor: { name: "Demo/backend", badge: null },
    dataSource: ds,
    settings: {
      kind: "remote",
      policyWrite: true,
      readSettings: vi.fn(),
      writeAppTools: vi.fn(),
      writeWorkflowConfig: vi.fn(),
      writeWorkflowContext: vi.fn(),
      writeWorkflowRules: vi.fn(),
      writeWorkflowReview: vi.fn(),
      writeWorkflowSubagentModel: vi.fn(),
      readSchemas: vi.fn(),
      writeWorkflowSchema: vi.fn(),
      forkSchema: vi.fn(),
      createSchema: vi.fn(),
      revealSchema: vi.fn(),
      deleteSchema: vi.fn(),
    },
    events: { subscribe: () => () => {} },
    capabilities: REMOTE_CAPS,
  };
}

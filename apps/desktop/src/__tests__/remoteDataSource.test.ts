// RemoteDataSource＝薄 invoke 包装（remote-data-source design 决策 7）：
// SpecsealDataSource 全方法对 remote_* command 的参数映射（connectionId＋
// project＋repo）、不支持方法回拒绝（决策 1 (c)——server 缺什么就停用什么，
// 不在 client 伪造）；createRemoteSession 以 handshake 结果建 session、事件面
// 订阅 remote-workspace-changed 并以 locator key 过滤。
import { describe, it, expect } from "vitest";
import { changeStage, RevertBlockedError } from "@specseal/ui";

import { createRemoteDataSource } from "../adapter/remoteDataSource";
import {
  createLocalSession,
  createRemoteSession,
  type RemoteOpenInfo,
  type WorkspaceCapabilities,
} from "../session";

const CONN = "conn_abc";
const PROJECT = "demo";
const REPO = "backend";

/** remote 讨论记录回应里的一把刀（server 的 GET /discussions/{slug} 原样转交）。 */
const DISCUSSION_CUT = {
  cut: "cut 1",
  title: "骨架",
  note: "",
  line: "**cut 1 `a-one`**: 骨架",
  changes: ["a-one"],
  changesInBold: true,
  unpromoted: ["a-one"],
};

/** 假 invoke：记录每笔 (cmd, args) 并依 cmd 回复最小合法 payload。 */
function fakeInvoke() {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const results: Record<string, unknown> = {
    remote_list_changes: {
      changes: [{ name: "chg", status: "in-progress", completedTasks: 1, totalTasks: 2, summary: "s", claimedBy: "Alice <a@example.com>" }],
      planError: null,
      next: null,
      unpromotedCuts: [],
    },
    remote_list_specs: { specs: [{ id: "auth", path: "specs/auth/spec.md" }] },
    remote_list_archived: {
      archived: [
        {
          datedName: "2026-01-01-old",
          date: "2026-01-01",
          name: "old",
          tasksTotal: 2,
          tasksDone: 2,
          specCount: 1,
          createdBy: "momo",
          fromDiscussions: ["source"],
        },
      ],
    },
    remote_status: {
      changeName: "chg",
      schemaName: "spec-driven",
      isComplete: false,
      applyRequires: ["tasks"],
      artifacts: [],
      created: "2026-07-29",
      createdBy: "Demo <d@e.com>",
      createdWith: "claude-code",
      startedAt: "2026-08-25T00:00:00Z",
      startedBy: "Demo <d@e.com>",
      fromDiscussions: ["auth-scope"],
      deltaCapabilities: ["auth", "user-profile"],
    },
    remote_document: "content",
    remote_spec_document: "# auth Specification",
    remote_search_workspace: {
      hits: [{ kind: "change", id: "chg", artifact: "proposal.md", snippet: "needle" }],
    },
    remote_archive: { specs: [] },
    remote_archived_document: "archived content",
    remote_archived_capabilities: ["auth"],
    remote_list_discussions: {
      active: [
        { slug: "s1", topic: "T", status: "open", rounds: 1, created: "2026-01-01" },
        {
          slug: "s2",
          topic: "Promoted",
          status: "promoted",
          rounds: 2,
          created: "2026-01-02",
          promotedTo: ["cut-a", "cut-b"],
          concluded: true,
        },
        {
          slug: "s3",
          topic: "Promoted unconcluded",
          status: "promoted",
          rounds: 1,
          created: "2026-01-03",
          promotedTo: ["cut-c"],
          concluded: false,
        },
      ],
      archived: [],
    },
    remote_discussion_document: { content: "discussion text", cuts: [DISCUSSION_CUT] },
    remote_promote_discussion: { change: "chg" },
    remote_read_settings: {
      app: { tools: [], customTools: [], parseError: null },
      workflow: {
        locale: "tw",
        specLocale: null,
        tdd: false,
        audit: false,
        context: "Remote context",
        rules: {},
        schemaArtifacts: ["proposal", "design", "specs", "tasks"],
        parseError: null,
        revision: 7,
      },
    },
    remote_write_workflow_config: 8,
    remote_write_workflow_content: 8,
    remote_write_workflow_schema: 8,
    read_schemas: [
      {
        name: "spec-driven",
        source: "package",
        artifactIds: ["proposal", "design", "specs", "tasks"],
        artifacts: [],
        path: null,
        error: null,
      },
    ],
    remote_validate: { change: "chg", valid: true, errors: [], warnings: [] },
    remote_analyze: {
      change_id: "chg",
      dimensions: [],
      findings: [],
      artifacts_analyzed: [],
      artifacts_missing: [],
    },
    remote_delete_change: null,
    remote_move_task: null,
    remote_reorder_card: null,
    remote_set_change_depends: null,
    remote_revert_change_to_proposed: null,
    remote_claim: { claimedBy: "Tester <t@example.com>" },
  };
  const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return (results[cmd] ?? null) as T;
  };
  return { calls, invoke };
}

/** handshake 结果 fixture（editor）：全操作面直达，停用清单清空
 *（remote-board-order 决策 7）。 */
function openInfo(): RemoteOpenInfo {
  const capabilities: WorkspaceCapabilities = {
    listChanges: true,
    listSpecs: true,
    listArchived: true,
    status: true,
    getDocument: true,
    getSpecDocument: true,
    searchWorkspace: true,
    changeCapabilities: true,
    changeMeta: true,
    deleteChange: true,
    setTaskDone: true,
    setAllTasks: true,
    moveTask: true,
    validate: true,
    analyze: true,
    archive: true,
    getArchivedDocument: true,
    archivedCapabilities: true,
    listDiscussions: true,
    getDiscussionDocument: true,
    promoteDiscussion: true,
    archiveDiscussion: true,
    reorderCard: true,
    setDepends: true,
    policyWrite: true,
    claim: true,
    liveUpdates: true,
  };
  return {
    projectKey: PROJECT,
    projectName: "Demo",
    repoKey: REPO,
    repoName: "backend",
    capabilities,
  };
}

/** reader 的 handshake 结果：写入面（含看板拖排）依 role 停用。 */
function readerInfo(): RemoteOpenInfo {
  const info = openInfo();
  return {
    ...info,
    capabilities: {
      ...info.capabilities,
      deleteChange: false,
      moveTask: false,
      reorderCard: false,
      setDepends: false,
      policyWrite: false,
      claim: false,
    },
  };
}

describe("createRemoteDataSource（决策 7：薄 invoke 包装）", () => {
  it("revertChangeToProposed maps to remote_revert_change_to_proposed and translates the blocked JSON", async () => {
    const { calls, invoke } = fakeInvoke();
    const ds = createRemoteDataSource(CONN, PROJECT, REPO, invoke);
    await ds.revertChangeToProposed("chg");
    const call = calls.find((c) => c.cmd === "remote_revert_change_to_proposed");
    expect(call?.args).toMatchObject({
      connectionId: CONN,
      project: PROJECT,
      repo: REPO,
      change: "chg",
    });

    // 守门 JSON → RevertBlockedError——与本地 adapter 同一结构化错误形状
    //(spec Scenario「remote 模式行为一致」的 adapter 半边)。
    const blocked = async () => {
      throw '{"kind":"revertBlocked","checkedTasks":1,"touchedFiles":["src/x.rs"]}';
    };
    const ds2 = createRemoteDataSource(CONN, PROJECT, REPO, blocked as never);
    const err = await ds2.revertChangeToProposed("chg").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RevertBlockedError);
    expect((err as RevertBlockedError).checkedTasks).toBe(1);
    expect((err as RevertBlockedError).touchedFiles).toEqual(["src/x.rs"]);
  });

  it("supported methods map to remote_* commands carrying connectionId + project + repo", async () => {
    const { calls, invoke } = fakeInvoke();
    const ds = createRemoteDataSource(CONN, PROJECT, REPO, invoke);

    await ds.listChanges();
    await ds.listSpecs();
    await ds.listArchived();
    await ds.status("chg");
    await ds.getDocument("chg", "tasks");
    await ds.getSpecDocument("auth");
    await ds.searchWorkspace("needle");
    await ds.setTaskDone("chg", "1", true);
    await ds.setAllTasks("chg", true);
    await ds.runVerb("archive", "chg");
    await ds.runVerb("validate", "chg");
    await ds.runVerb("analyze", "chg");
    await ds.deleteChange("chg");
    await ds.moveTask("chg", 1, 3);
    await ds.getArchivedDocument("2026-01-01-old", "proposal.md");
    await ds.archivedCapabilities("2026-01-01-old");
    await ds.listDiscussions();
    await ds.getDiscussionDocument("s1");
    await ds.promoteDiscussion("s1");
    await ds.archiveDiscussion("s1");
    await ds.reorderCard("change", "chg", "prev-card", "next-card");

    expect(calls.map((c) => c.cmd)).toEqual([
      "remote_list_changes",
      "remote_list_specs",
      "remote_list_archived",
      "remote_status",
      "remote_document",
      "remote_spec_document",
      "remote_search_workspace",
      "remote_set_task_done",
      "remote_set_all_tasks",
      "remote_archive",
      "remote_validate",
      "remote_analyze",
      "remote_delete_change",
      "remote_move_task",
      "remote_archived_document",
      "remote_archived_capabilities",
      "remote_list_discussions",
      "remote_discussion_document",
      "remote_promote_discussion",
      "remote_archive_discussion",
      "remote_reorder_card",
    ]);
    // 每一击都带 locator 识别。
    const missing = calls
      .filter(
        (c) =>
          c.args?.connectionId !== CONN || c.args?.project !== PROJECT || c.args?.repo !== REPO,
      )
      .map((c) => c.cmd);
    expect(missing).toEqual([]);
    // 方法专属参数映射。
    expect(calls[3].args).toMatchObject({ change: "chg" });
    expect(calls[4].args).toMatchObject({ change: "chg", artifact: "tasks" });
    expect(calls[5].args).toMatchObject({ capability: "auth" });
    expect(calls[6].args).toMatchObject({ query: "needle" });
    expect(calls[7].args).toMatchObject({ change: "chg", task: "1", done: true });
    expect(calls[8].args).toMatchObject({ change: "chg", done: true });
    expect(calls[9].args).toMatchObject({ change: "chg" });
    expect(calls[10].args).toMatchObject({ change: "chg" });
    expect(calls[11].args).toMatchObject({ change: "chg" });
    // 桌面 remote 删除带 force=false（archive-readiness-gating D2 翻案）：与本地
    // discard 守门语意对齐，已开工 change 由 server 拒绝、走既有 deleteFailed toast。
    expect(calls[12].args).toMatchObject({ change: "chg", force: false });
    expect(calls[13].args).toMatchObject({ change: "chg", from: 1, to: 3, before: null });
    expect(calls[14].args).toMatchObject({
      datedName: "2026-01-01-old",
      artifact: "proposal.md",
    });
    expect(calls[15].args).toMatchObject({ datedName: "2026-01-01-old" });
    expect(calls[17].args).toMatchObject({ slug: "s1" });
    expect(calls[18].args).toMatchObject({ slug: "s1", name: null });
    expect(calls[19].args).toMatchObject({ slug: "s1" });
    // 看板拖排直达（remote-board-order）：邻居寻址与本地 reorder_card 同形。
    expect(calls[20].args).toMatchObject({
      kind: "change",
      id: "chg",
      prevId: "prev-card",
      nextId: "next-card",
    });
  });

  it("工单分页的两个读取映射到 remote_station_ticket／remote_archived_station_ticket 并带 locator", async () => {
    // drawer-quality-ticket-tab D2：活工单走结构化端点、封存工单走原文端点后由
    // Rust 解析——前端只认 command 名与参数，两者皆回 StationTicket | null。
    const { calls, invoke } = fakeInvoke();
    const ds = createRemoteDataSource(CONN, PROJECT, REPO, invoke);
    await ds.getStationTicket("chg", "review");
    await ds.getArchivedStationTicket("2026-01-01-old", "verify");
    expect(calls.map((c) => c.cmd)).toEqual(["remote_station_ticket", "remote_archived_station_ticket"]);
    expect(calls[0].args).toMatchObject({
      connectionId: CONN,
      project: PROJECT,
      repo: REPO,
      change: "chg",
      station: "review",
    });
    expect(calls[1].args).toMatchObject({
      connectionId: CONN,
      project: PROJECT,
      repo: REPO,
      datedName: "2026-01-01-old",
      station: "verify",
    });
  });

  it("绑有 checkout 时清单请求带 checkoutRoot，没有时不带（station-status-and-landing D7）", async () => {
    const bound = fakeInvoke();
    await createRemoteDataSource(CONN, PROJECT, REPO, bound.invoke, "/work/checkout").listChanges();
    expect(bound.calls[0]).toEqual({
      cmd: "remote_list_changes",
      args: { connectionId: CONN, project: PROJECT, repo: REPO, checkoutRoot: "/work/checkout" },
    });

    const unbound = fakeInvoke();
    await createRemoteDataSource(CONN, PROJECT, REPO, unbound.invoke).listChanges();
    expect(unbound.calls[0].args).toEqual({ connectionId: CONN, project: PROJECT, repo: REPO });
  });

  it("封存对话框的放弃与照样带走映射到 remote_discard_station／remote_archive 并带旗标", async () => {
    const { invoke, calls } = fakeInvoke();
    const ds = createRemoteDataSource(CONN, PROJECT, REPO, invoke);
    await ds.discardReview?.("chg");
    await ds.discardVerify?.("chg");
    await ds.archiveCarry?.("chg", true, false);
    const locator = { connectionId: CONN, project: PROJECT, repo: REPO };
    expect(calls).toEqual([
      { cmd: "remote_discard_station", args: { ...locator, change: "chg", station: "review" } },
      { cmd: "remote_discard_station", args: { ...locator, change: "chg", station: "verify" } },
      { cmd: "remote_archive", args: { ...locator, change: "chg", carryReview: true, carryVerify: false } },
    ]);
  });

  it("claim maps to remote_claim carrying the locator（remote-claim-ownership）", async () => {
    const { calls, invoke } = fakeInvoke();
    const ds = createRemoteDataSource(CONN, PROJECT, REPO, invoke);
    await ds.claim!("chg");
    const call = calls.find((c) => c.cmd === "remote_claim");
    expect(call?.args).toMatchObject({
      connectionId: CONN,
      project: PROJECT,
      repo: REPO,
      change: "chg",
    });
  });

  it("listChanges 带出调度字段与 planError（add-change-plan-remote D5）", async () => {
    // setDepends 的 command 映射与 capability 旗标由 planDataSource.test.ts 集中断言。
    const cycle = "dependency cycle: a -> b -> a";
    const invoke = async <T,>(cmd: string): Promise<T> => {
      if (cmd === "remote_list_changes") {
        return {
          changes: [
            { name: "a", status: "in-progress", completedTasks: 0, totalTasks: 1, dependsOn: ["b"] },
          ],
          planError: cycle,
        } as T;
      }
      return null as T;
    };
    const ds = createRemoteDataSource(CONN, PROJECT, REPO, invoke);

    const payload = await ds.listChanges();
    expect(payload.planError).toBe(cycle);
    expect(payload.changes[0].dependsOn).toEqual(["b"]);
  });

  it("listChanges 带出顶层 next 与 unpromotedCuts（desktop-roadmap）", async () => {
    const cut = { discussion: "panel", cut: "cut 3", title: "路线图", changes: ["add-z"], unpromoted: ["add-z"] };
    const invoke = async <T,>(cmd: string): Promise<T> =>
      (cmd === "remote_list_changes"
        ? { changes: [], planError: null, next: "add-a", unpromotedCuts: [cut] }
        : null) as T;
    const payload = await createRemoteDataSource(CONN, PROJECT, REPO, invoke).listChanges();
    expect(payload.next).toBe("add-a");
    expect(payload.unpromotedCuts).toEqual([cut]);
  });

  it("listChanges 带出 claimedBy（认领人呈现的数据源）", async () => {
    const { invoke } = fakeInvoke();
    const ds = createRemoteDataSource(CONN, PROJECT, REPO, invoke);
    const [first] = (await ds.listChanges()).changes;
    expect(first.claimedBy).toBe("Alice <a@example.com>");
  });

  it("returns server payloads in the UI shapes", async () => {
    const { invoke } = fakeInvoke();
    const ds = createRemoteDataSource(CONN, PROJECT, REPO, invoke);
    const { changes } = await ds.listChanges();
    expect(changes[0]).toMatchObject({ name: "chg", totalTasks: 2 });
    const specs = await ds.listSpecs();
    expect(specs[0].id).toBe("auth");
    const archived = await ds.listArchived();
    expect(archived[0]).toMatchObject({ datedName: "2026-01-01-old", specCount: 1 });
    const status = await ds.status("chg");
    expect(status.schemaName).toBe("spec-driven");
    await expect(ds.getSpecDocument("auth")).resolves.toBe("# auth Specification");
    await expect(ds.searchWorkspace("needle")).resolves.toEqual([
      { kind: "change", id: "chg", artifact: "proposal.md", snippet: "needle" },
    ]);
    await expect(
      ds.getArchivedDocument("2026-01-01-old", "proposal.md"),
    ).resolves.toBe("archived content");
    await expect(ds.archivedCapabilities("2026-01-01-old")).resolves.toEqual(["auth"]);
    await expect(ds.getDiscussionDocument("s1")).resolves.toEqual({ content: "discussion text", cuts: [DISCUSSION_CUT] });
    const discussions = await ds.listDiscussions();
    // promotedTo 映射 wire 字段（remote-read-parity）：缺席以空清单容错、
    // 非空如实携带，不再以 client 端固定值补齐。
    expect(discussions.active[0]).toMatchObject({ slug: "s1", promotedTo: [] });
    expect(discussions.active[1]).toMatchObject({ slug: "s2", promotedTo: ["cut-a", "cut-b"] });
    // concluded 同律（conclusion-gated-discussion-archive）：映射 wire 值，
    // 缺席（旧 server）维持未知、不补成 false。
    expect(discussions.active[0].concluded).toBeUndefined();
    expect(discussions.active[1].concluded).toBe(true);
    expect(discussions.active[2]).toMatchObject({ slug: "s3", concluded: false });
  });

  it("getDiscussionDocument：回应缺 cuts 时补空数组、不存在时为 null", async () => {
    let reply: unknown = { content: "old server text" };
    const invoke = async <T,>(): Promise<T> => reply as T;
    const ds = createRemoteDataSource(CONN, PROJECT, REPO, invoke);
    await expect(ds.getDiscussionDocument("s1")).resolves.toEqual({ content: "old server text", cuts: [] });
    reply = null;
    await expect(ds.getDiscussionDocument("s1")).resolves.toBeNull();
  });

  it("wire 的 startedAt 进入 ChangeItem，changeStage 对开工零进度卡判进行中", async () => {
    // spec desktop-app「remote 已开工零进度列于进行中」：startedAt 随清单
    // payload 进字段推导，不以任务完成数替代开工判定。
    const invoke = async <T,>(): Promise<T> =>
      ({
        changes: [
          {
            name: "started-zero",
            summary: "",
            status: "in-progress",
            completedTasks: 0,
            totalTasks: 15,
            startedAt: "2026-07-30",
          },
          {
            name: "unstarted",
            summary: "",
            status: "in-progress",
            completedTasks: 0,
            totalTasks: 15,
          },
        ],
      }) as T;
    const ds = createRemoteDataSource(CONN, PROJECT, REPO, invoke);
    const { changes } = await ds.listChanges();
    expect(changes[0].startedAt).toBe("2026-07-30");
    expect(changeStage(changes[0])).toBe("in-progress");
    expect(changes[1].startedAt).toBeUndefined();
    expect(changeStage(changes[1])).toBe("proposed");
  });

  it("changeCapabilities 以既有 remote_status 路径映射 deltaCapabilities", async () => {
    // remote-read-parity design D2：不开新 Tauri command、不另发 HTTP 请求，
    // 自 status payload 抽取既有字段。
    const { calls, invoke } = fakeInvoke();
    const ds = createRemoteDataSource(CONN, PROJECT, REPO, invoke);
    await expect(ds.changeCapabilities("chg")).resolves.toEqual(["auth", "user-profile"]);
    expect(calls.map((c) => c.cmd)).toEqual(["remote_status"]);
    expect(calls[0].args).toMatchObject({
      connectionId: CONN,
      project: PROJECT,
      repo: REPO,
      change: "chg",
    });
  });

  it("changeMeta 以 status payload 组出 ChangeMetaInfo、缺席字段诚实降级", async () => {
    const { calls, invoke } = fakeInvoke();
    const ds = createRemoteDataSource(CONN, PROJECT, REPO, invoke);
    await expect(ds.changeMeta("chg")).resolves.toEqual({
      schema: "spec-driven",
      created: "2026-07-29",
      createdBy: "Demo <d@e.com>",
      createdWith: "claude-code",
      fromDiscussions: ["auth-scope"],
      startedAt: "2026-08-25T00:00:00Z",
      startedBy: "Demo <d@e.com>",
    });
    expect(calls.map((c) => c.cmd)).toEqual(["remote_status"]);

    // 旧 server（无新字段）：对应字段为 null／缺席，不伪造默认值、不失败。
    const legacyInvoke = async <T,>(): Promise<T> =>
      ({
        changeName: "chg",
        schemaName: "spec-driven",
        isComplete: false,
        applyRequires: ["tasks"],
        artifacts: [],
      }) as T;
    const legacy = createRemoteDataSource(CONN, PROJECT, REPO, legacyInvoke);
    const meta = await legacy.changeMeta("chg");
    expect(meta).toMatchObject({ schema: "spec-driven" });
    expect(meta?.createdBy ?? null).toBeNull();
    expect(meta?.createdWith ?? null).toBeNull();
    expect(meta?.startedAt ?? null).toBeNull();
    expect(meta?.startedBy ?? null).toBeNull();
    expect(meta?.created ?? null).toBeNull();
    expect(meta?.fromDiscussions ?? []).toEqual([]);
  });

  it("changeCapabilities 与 changeMeta 并发加载共用单次 remote_status 请求", async () => {
    // spec remote-workspace-data「以单 change 读取回应既有 payload 映射实作、
    // 不另开请求」：抽屉同时加载 capability 清单与诠释数据时只打一次端点；
    // 落定后的新一轮加载仍重新取值，不留 stale 缓存。
    const { calls, invoke } = fakeInvoke();
    const ds = createRemoteDataSource(CONN, PROJECT, REPO, invoke);
    const [caps, meta] = await Promise.all([ds.changeCapabilities("chg"), ds.changeMeta("chg")]);
    expect(caps).toEqual(["auth", "user-profile"]);
    expect(meta?.createdBy).toBe("Demo <d@e.com>");
    expect(calls.filter((c) => c.cmd === "remote_status")).toHaveLength(1);
    await ds.changeMeta("chg");
    expect(calls.filter((c) => c.cmd === "remote_status")).toHaveLength(2);
  });
});

describe("createRemoteSession（决策 6/7：handshake 结果建 session）", () => {
  it("derives id from the locator, names the tab Project/Repo, and carries capabilities", () => {
    const { invoke } = fakeInvoke();
    const session = createRemoteSession(CONN, openInfo(), undefined, { invoke });
    expect(session.id).toBe(`remote:${CONN}/${PROJECT}/${REPO}`);
    expect(session.locator).toEqual({
      kind: "remote",
      connectionId: CONN,
      projectId: PROJECT,
      repoId: REPO,
    });
    expect(session.descriptor.name).toBe("Demo/backend");
    expect(session.capabilities.searchWorkspace).toBe(true);
    expect(session.capabilities.listArchived).toBe(true);
    expect(session.capabilities.getSpecDocument).toBe(true);
    expect(session.capabilities.listChanges).toBe(true);
    expect(session.settings.kind).toBe("remote");
    expect(session.settings.policyWrite).toBe(true);
  });

  it("capability 依 role：editor 的 reorderCard 真、reader 假（不伪造缺口）", () => {
    const { invoke } = fakeInvoke();
    const editor = createRemoteSession(CONN, openInfo(), undefined, { invoke });
    expect(editor.capabilities.reorderCard).toBe(true);
    const reader = createRemoteSession(CONN, readerInfo(), undefined, { invoke });
    expect(reader.capabilities.reorderCard).toBe(false);
    expect(reader.capabilities.listChanges).toBe(true);
  });

  it("remote settings 绑 locator，以读得 revision 作 expectedRevision 写回", async () => {
    const { calls, invoke } = fakeInvoke();
    const session = createRemoteSession(CONN, openInfo(), undefined, { invoke });

    const snap = await session.settings.readSettings();
    expect(snap.workflow.revision).toBe(7);
    await expect(
      session.settings.writeWorkflowConfig({
        locale: "tw",
        specLocale: "auto",
        tdd: true,
        audit: false,
        // remote 无 worktree 轴；字段存在于完整目标状态，写入端忽略。
        worktree: false,
      }),
    ).resolves.toBe(8);
    await session.settings.writeWorkflowContext("updated");
    await session.settings.writeWorkflowRules([["tasks", ["test first"]]]);

    expect(calls.find((call) => call.cmd === "remote_read_settings")?.args).toEqual({
      connectionId: CONN,
      project: PROJECT,
      repo: REPO,
    });
    expect(calls.find((call) => call.cmd === "remote_write_workflow_config")?.args).toMatchObject({
      connectionId: CONN,
      project: PROJECT,
      repo: REPO,
      locale: "tw",
      specLocale: "auto",
      tdd: true,
      audit: false,
      expectedRevision: 7,
    });
    const contentWrites = calls.filter((call) => call.cmd === "remote_write_workflow_content");
    expect(contentWrites[0]?.args).toMatchObject({ context: "updated", expectedRevision: 8 });
    expect(contentWrites[1]?.args).toMatchObject({
      rules: [["tasks", ["test first"]]],
      expectedRevision: 8,
    });
  });

  it("remote 审查规则写入只带 review，context／rules 为 null 且附读得的 expectedRevision", async () => {
    const { calls, invoke } = fakeInvoke();
    const session = createRemoteSession(CONN, openInfo(), undefined, { invoke });
    await session.settings.readSettings(); // 取得 revision 7
    const review = {
      baseline: "replace" as const,
      critical: ["不得写死密钥"],
      warning: [],
      suggestion: ["函数超过 50 行时宜拆分"],
    };

    await expect(session.settings.writeWorkflowReview(review)).resolves.toBe(8);

    expect(calls.find((call) => call.cmd === "remote_write_workflow_content")?.args).toEqual({
      connectionId: CONN,
      project: PROJECT,
      repo: REPO,
      context: null,
      rules: null,
      review,
      expectedRevision: 7,
    });
  });

  it("remote 产出流程面：读走本地内置组装、切换带 expectedRevision、fork 拒绝（desktop-schema-panel D2/D3）", async () => {
    const { calls, invoke } = fakeInvoke();
    const session = createRemoteSession(CONN, openInfo(), undefined, { invoke });
    await session.settings.readSettings(); // 取得 revision 7

    await session.settings.readSchemas();
    // 不打 server：由 desktop core 以内嵌内置组装，也不带任何本机 root。
    expect(calls.find((c) => c.cmd === "read_schemas")?.args).toEqual({});

    await expect(session.settings.writeWorkflowSchema("spec-driven")).resolves.toBe(8);
    expect(calls.find((c) => c.cmd === "remote_write_workflow_schema")?.args).toMatchObject({
      connectionId: CONN,
      project: PROJECT,
      repo: REPO,
      name: "spec-driven",
      expectedRevision: 7,
    });

    // remote 不支持 fork 与创建（spec「remote 模式无 fork 入口」「remote 模式无
    // 创建入口」的信道面防线）：rejected Promise 且不发任何 invoke。
    await expect(session.settings.forkSchema("spec-driven")).rejects.toThrow();
    expect(calls.some((c) => c.cmd === "fork_schema")).toBe(false);
    await expect(session.settings.createSchema("my-flow")).rejects.toThrow();
    expect(calls.some((c) => c.cmd === "init_schema")).toBe(false);
    await expect(session.settings.revealSchema("/anywhere")).rejects.toThrow();
    expect(calls.some((c) => c.cmd === "reveal_in_folder")).toBe(false);
    await expect(session.settings.deleteSchema("my-flow")).rejects.toThrow();
    expect(calls.some((c) => c.cmd === "delete_schema")).toBe(false);
  });

  it("events subscribe watches the stream, filters by locator key, and unwatches on teardown", async () => {
    const { calls, invoke } = fakeInvoke();
    const handlers = new Map<string, (e: { payload: unknown }) => void>();
    const listen = async (event: string, h: (e: { payload: unknown }) => void) => {
      handlers.set(event, h);
      return () => {
        handlers.delete(event);
      };
    };
    const session = createRemoteSession(CONN, openInfo(), undefined, { invoke, listen });
    let fired = 0;
    const unsubscribe = session.events.subscribe(() => {
      fired += 1;
    });
    await Promise.resolve();
    expect(calls.map((c) => c.cmd)).toContain("remote_watch");
    expect(calls.find((c) => c.cmd === "remote_watch")?.args).toMatchObject({
      connectionId: CONN,
      project: PROJECT,
      repo: REPO,
    });

    handlers.get("remote-workspace-changed")?.({ payload: "remote:other/x/y" });
    expect(fired).toBe(0);
    handlers.get("remote-workspace-changed")?.({ payload: session.id });
    expect(fired).toBe(1);

    unsubscribe();
    await Promise.resolve();
    expect(calls.map((c) => c.cmd)).toContain("remote_unwatch");
    handlers.get("remote-workspace-changed")?.({ payload: session.id });
    expect(fired).toBe(1);
  });

  it("local sessions 除 RemoteOnly 的 claim 外全真（决策 2：同一 UI 路径）", () => {
    const { invoke } = fakeInvoke();
    const session = createLocalSession("/proj/a", { invoke });
    const { claim, ...rest } = session.capabilities;
    expect(Object.values(rest).every((on) => on === true)).toBe(true);
    // claim 是 RemoteOnly 动词：本地没有共用者可撞工，能力为假而非伪造为真。
    expect(claim).toBe(false);
  });
});

describe("手册在 remote 尚不支持（desktop-manual-page spec「无手册与 remote 模式的空状态」）", () => {
  it("listManualPages 回 present false／reason remote 的空索引、getManualPage 回 null，且不发任何请求", async () => {
    const { calls, invoke } = fakeInvoke();
    const ds = createRemoteDataSource(CONN, PROJECT, REPO, invoke);
    expect(await ds.listManualPages()).toEqual({
      present: false,
      reason: "remote",
      pages: [],
      uncoveredNew: [],
      malformed: [],
    });
    expect(await ds.getManualPage("index")).toBeNull();
    expect(calls).toEqual([]);
  });
});

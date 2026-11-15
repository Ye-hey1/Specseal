import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { RevertBlockedError } from "@specseal/ui";

import { createTauriDataSource } from "../adapter/tauriDataSource";

describe("createTauriDataSource", () => {
  beforeEach(() => invoke.mockReset());

  it("listChanges keeps the envelope: items (restaleFrom carried) plus the top-level planError", async () => {
    // restaleFrom（待重新反映徽章数据源）随清单项透传至前端，供看板卡片渲染；spec
    // client-protocol「变更清单的调度字段」：顶层 planError（成环消息或 null）随清单
    // 一起回到前端，同一次 IO。
    invoke.mockResolvedValueOnce({
      changes: [{ name: "a", status: "s", totalTasks: 1, completedTasks: 0, restaleFrom: ["alpha"] }],
      planError: "dependency cycle: a -> b -> a",
      next: null,
      unpromotedCuts: [],
    });
    const ds = createTauriDataSource("/r");
    const payload = await ds.listChanges();
    expect(invoke).toHaveBeenCalledWith("list_changes", { root: "/r" });
    expect(payload.changes[0].restaleFrom).toEqual(["alpha"]);
    expect(payload.planError).toBe("dependency cycle: a -> b -> a");
  });

  it("getDiscussionDocument 回 { content, cuts }：cuts 照传、缺席补空数组、不存在为 null", async () => {
    const cut = {
      cut: "cut 1",
      title: "骨架",
      note: "",
      line: "**cut 1 `a-one`**: 骨架",
      changes: ["a-one"],
      changesInBold: true,
      unpromoted: [],
    };
    invoke.mockResolvedValueOnce({ content: "record", cuts: [cut] });
    const ds = createTauriDataSource("/r");
    await expect(ds.getDiscussionDocument("s1")).resolves.toEqual({ content: "record", cuts: [cut] });
    expect(invoke).toHaveBeenCalledWith("discussion_document", { root: "/r", slug: "s1" });
    invoke.mockResolvedValueOnce({ content: "record" });
    await expect(ds.getDiscussionDocument("s1")).resolves.toEqual({ content: "record", cuts: [] });
    invoke.mockResolvedValueOnce(null);
    await expect(ds.getDiscussionDocument("s1")).resolves.toBeNull();
  });

  it("listSpecs unwraps the { specs } envelope and carries the presentation helper fields", async () => {
    // spec「桌面 app 呈现 change 与 spec 的清单与内容」呈现层辅助字段（design D2、
    // spec-archive-drawer design D4）：modifiedAt 之外，规格卡收合信息字段原样透传。
    invoke.mockResolvedValueOnce({
      specs: [
        {
          id: "cap-x",
          modifiedAt: "2026-07-08",
          requirementCount: 7,
          purposeExcerpt: "First line.",
          purposeTbd: false,
          traceCount: 3,
        },
        { id: "cap-y" },
      ],
    });
    const ds = createTauriDataSource("/r");
    const specs = await ds.listSpecs();
    expect(invoke).toHaveBeenCalledWith("list_specs", { root: "/r" });
    expect(specs[0].modifiedAt).toBe("2026-07-08");
    expect(specs[0].requirementCount).toBe(7);
    expect(specs[0].purposeExcerpt).toBe("First line.");
    expect(specs[0].purposeTbd).toBe(false);
    expect(specs[0].traceCount).toBe(3);
    expect(specs[1].modifiedAt).toBeUndefined();
  });

  it("listArchived unwraps the { archived } envelope and carries the card info fields", async () => {
    // 封存卡收合信息（spec-archive-drawer design D4/D5）：specCount／createdBy／
    // fromDiscussions 原样透传。
    invoke.mockResolvedValueOnce({
      archived: [
        {
          datedName: "2026-01-01-a",
          date: "2026-01-01",
          name: "a",
          specCount: 2,
          createdBy: "momo",
          fromDiscussions: ["alpha-ux"],
        },
      ],
    });
    const ds = createTauriDataSource("/r");
    const archived = await ds.listArchived();
    expect(invoke).toHaveBeenCalledWith("archived_changes", { root: "/r" });
    expect(archived[0].datedName).toBe("2026-01-01-a");
    expect(archived[0].specCount).toBe(2);
    expect(archived[0].createdBy).toBe("momo");
    expect(archived[0].fromDiscussions).toEqual(["alpha-ux"]);
  });

  it("getDocument passes change + artifact to the document command", async () => {
    invoke.mockResolvedValueOnce("## Why");
    const ds = createTauriDataSource("/r");
    const doc = await ds.getDocument("chg", "proposal.md");
    expect(invoke).toHaveBeenCalledWith("document", { root: "/r", change: "chg", artifact: "proposal.md" });
    expect(doc).toBe("## Why");
  });

  it("revertChangeToProposed invokes the revert command with root and change", async () => {
    invoke.mockResolvedValueOnce(undefined);
    const ds = createTauriDataSource("/r");
    await ds.revertChangeToProposed("chg");
    expect(invoke).toHaveBeenCalledWith("revert_change_to_proposed", { root: "/r", change: "chg" });
  });

  it("revertChangeToProposed 把守门 JSON 错误转为 RevertBlockedError(结构化证据)", async () => {
    invoke.mockRejectedValueOnce(
      '{"kind":"revertBlocked","checkedTasks":2,"touchedFiles":["src/a.rs"]}',
    );
    const ds = createTauriDataSource("/r");
    const err = await ds.revertChangeToProposed("chg").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RevertBlockedError);
    expect((err as RevertBlockedError).checkedTasks).toBe(2);
    expect((err as RevertBlockedError).touchedFiles).toEqual(["src/a.rs"]);
  });

  it("revertChangeToProposed 非守门错误原样抛出单行消息", async () => {
    invoke.mockRejectedValueOnce("not a specseal project: /r");
    const ds = createTauriDataSource("/r");
    const err = await ds.revertChangeToProposed("chg").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RevertBlockedError);
    expect(String(err instanceof Error ? err.message : err)).toContain("not a specseal project");
  });

  it("runVerb invokes the verb command by name with the change arg", async () => {
    invoke.mockResolvedValueOnce({ valid: true });
    const ds = createTauriDataSource("/r");
    await ds.runVerb("validate", "chg");
    expect(invoke).toHaveBeenCalledWith("validate", { root: "/r", change: "chg" });
  });

  it("三选项的两条处置各走自己的 command", async () => {
    // spec「封存入口的未结工单三选项」：放弃审查＝discard_review（不封存），
    // 照样带走＝archive_carry（等同 CLI --carry-review／--carry-verify）。
    invoke.mockResolvedValue(undefined);
    const ds = createTauriDataSource("/r");
    await ds.discardReview?.("chg");
    expect(invoke).toHaveBeenCalledWith("discard_review", { root: "/r", change: "chg" });
    await ds.archiveCarry?.("chg", true, false);
    expect(invoke).toHaveBeenCalledWith("archive_carry", {
      root: "/r",
      change: "chg",
      carryReview: true,
      carryVerify: false,
    });
    await ds.discardVerify?.("chg");
    expect(invoke).toHaveBeenCalledWith("discard_verify", { root: "/r", change: "chg" });
  });

  it("setAllTasks invokes set_all_tasks with change and done", async () => {
    // spec「任务分页提供批量操作工具列」：全部已完成／重置任务走批量指令单次写回。
    invoke.mockResolvedValue(undefined);
    const ds = createTauriDataSource("/r");
    await ds.setAllTasks("chg", true);
    expect(invoke).toHaveBeenCalledWith("set_all_tasks", { root: "/r", change: "chg", done: true });
    await ds.setAllTasks("chg", false);
    expect(invoke).toHaveBeenCalledWith("set_all_tasks", { root: "/r", change: "chg", done: false });
  });

  it("reorderCard invokes reorder_card with kind, id and neighbor ids (null = column ends)", async () => {
    // design D5：以邻居识别码表达落点；null＝栏顶／栏底。
    invoke.mockResolvedValue(undefined);
    const ds = createTauriDataSource("/r");
    await ds.reorderCard("change", "my-change", "prev-c", null);
    expect(invoke).toHaveBeenCalledWith("reorder_card", {
      root: "/r",
      kind: "change",
      id: "my-change",
      prevId: "prev-c",
      nextId: null,
    });
    await ds.reorderCard("discussion", "slug-x", null, "next-s");
    expect(invoke).toHaveBeenCalledWith("reorder_card", {
      root: "/r",
      kind: "discussion",
      id: "slug-x",
      prevId: null,
      nextId: "next-s",
    });
  });

  it("工单分页的两个读取各走自己的 command（drawer-quality-ticket-tab D2／D5）", async () => {
    // 活工单以 change＋station 寻址、封存工单以 datedName＋station 寻址；payload
    // 原样透传（null＝无工单、远程 404 或格式坏掉，前端一律空态）。
    const ticket = {
      rounds: [{ index: 1, phase: "discovery", patchHash: null, scope: ["src/a.rs"], findings: [] }],
    };
    invoke.mockResolvedValueOnce(ticket);
    const ds = createTauriDataSource("/r");
    expect(await ds.getStationTicket("chg", "review")).toEqual(ticket);
    expect(invoke).toHaveBeenCalledWith("station_ticket", { root: "/r", change: "chg", station: "review" });
    invoke.mockResolvedValueOnce(null);
    expect(await ds.getArchivedStationTicket("2026-01-01-old", "verify")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("archived_station_ticket", {
      root: "/r",
      datedName: "2026-01-01-old",
      station: "verify",
    });
  });

  it("dependsCandidates invokes depends_candidates with root and change（add-change-plan-remote D9）", async () => {
    // 调度分页的候选名册：有 worktree 映射时为副本名册，由桌面 core 定根。
    invoke.mockResolvedValueOnce(["add-auth"]);
    const ds = createTauriDataSource("/r");
    expect(await ds.dependsCandidates!("add-dark-mode")).toEqual(["add-auth"]);
    expect(invoke).toHaveBeenCalledWith("depends_candidates", { root: "/r", change: "add-dark-mode" });
  });

  it("手册索引与内文各走自己的 command（desktop-manual-page design D1）", async () => {
    // spec desktop-manual-page：索引 `{ present, reason, pages, uncoveredNew, malformed }`
    // 原样透传；内文以 slug 寻址。command 名与参数对应 src-tauri 的
    // list_manual_pages(root) 与 get_manual_page(root, slug)。
    invoke.mockResolvedValueOnce({
      present: true,
      reason: null,
      pages: [
        {
          slug: "index",
          title: "手册",
          section: "开始使用",
          order: 10,
          keywords: [],
          sources: [],
          generated: "2026-09-02",
          stale: false,
        },
      ],
      uncoveredNew: ["github-oauth"],
      malformed: ["broken"],
    });
    const ds = createTauriDataSource("/r");
    const index = await ds.listManualPages();
    expect(invoke).toHaveBeenCalledWith("list_manual_pages", { root: "/r" });
    expect(index.present).toBe(true);
    expect(index.pages[0].slug).toBe("index");
    expect(index.uncoveredNew).toEqual(["github-oauth"]);
    expect(index.malformed).toEqual(["broken"]);

    invoke.mockResolvedValueOnce("# 手册\n\n内文。");
    expect(await ds.getManualPage("index")).toBe("# 手册\n\n内文。");
    expect(invoke).toHaveBeenCalledWith("get_manual_page", { root: "/r", slug: "index" });
    invoke.mockResolvedValueOnce(null);
    expect(await ds.getManualPage("missing")).toBeNull();
  });

  it("本地后端不提供 claim（RemoteOnly 动词不在本地伪造入口）", () => {
    const ds = createTauriDataSource("/r");
    expect(ds.claim).toBeUndefined();
  });
});

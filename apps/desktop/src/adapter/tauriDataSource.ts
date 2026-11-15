import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { toRevertError } from "@specseal/ui";
import type {
  SpecsealDataSource,
  CardKind,
  ChangeListPayload,
  SpecItem,
  ArchivedItem,
  DiscussionCut,
  DiscussionDocument,
  DiscussionLists,
  ManualIndex,
  SearchHit,
  StationTicket,
  StatusReport,
  TicketStation,
  Verb,
} from "@specseal/ui";

import type { InvokeFn } from "../session";

// core-backed adapter：以 Tauri invoke 调用 specseal-desktop 的 #[command]，
// 实作 @specseal/ui 的 SpecsealDataSource 接口。command 名与参数对应 src-tauri/src/lib.rs。
// root 绑入闭包（workspace-session 决策 3/4）：每支 command 显式带 root，直通
// desktop-core 的带路径函数——Rust 侧无 current-root 全域。invoke 可注入以利测试。
export function createTauriDataSource(
  root: string,
  invoke: InvokeFn = tauriInvoke as InvokeFn,
): SpecsealDataSource {
  return {
    async listChanges(): Promise<ChangeListPayload> {
      // list_changes payload 原样：清单项＋顶层 planError。
      return await invoke<ChangeListPayload>("list_changes", { root });
    },
    async listSpecs(): Promise<SpecItem[]> {
      const r = await invoke<{ specs: SpecItem[] }>("list_specs", { root });
      return r.specs;
    },
    async listArchived(): Promise<ArchivedItem[]> {
      const r = await invoke<{ archived: ArchivedItem[] }>("archived_changes", { root });
      return r.archived;
    },
    async status(change: string): Promise<StatusReport> {
      return await invoke<StatusReport>("status", { root, change });
    },
    async getDocument(change: string, artifact: string): Promise<string | null> {
      return await invoke<string | null>("document", { root, change, artifact });
    },
    async getSpecDocument(capability: string): Promise<string | null> {
      return await invoke<string | null>("spec_document", { root, capability });
    },
    async listManualPages(): Promise<ManualIndex> {
      return await invoke<ManualIndex>("list_manual_pages", { root });
    },
    async getManualPage(slug: string): Promise<string | null> {
      return await invoke<string | null>("get_manual_page", { root, slug });
    },
    async searchWorkspace(query: string): Promise<SearchHit[]> {
      const r = await invoke<{ hits: SearchHit[] }>("search_workspace", { root, query });
      return r.hits;
    },
    async changeCapabilities(change: string): Promise<string[]> {
      return await invoke<string[]>("change_capabilities", { root, change });
    },
    async changeMeta(change: string) {
      return await invoke<import("@specseal/ui").ChangeMetaInfo | null>("change_meta", {
        root,
        change,
      });
    },
    async revertChangeToProposed(change: string): Promise<void> {
      // 守门拒绝由 desktop core 以 JSON 字符串回证据——经共用 toRevertError
      // 转为 RevertBlockedError,App 的守门对话框单一消费入口。
      try {
        await invoke("revert_change_to_proposed", { root, change });
      } catch (e) {
        throw toRevertError(e);
      }
    },
    async deleteChange(change: string): Promise<void> {
      await invoke("delete_change", { root, change });
    },
    async setTaskDone(change: string, task: string, done: boolean): Promise<void> {
      await invoke("set_task_done", { root, change, task, done });
    },
    async setAllTasks(change: string, done: boolean): Promise<void> {
      await invoke("set_all_tasks", { root, change, done });
    },
    async moveTask(change: string, from: number, to: number, before?: boolean): Promise<void> {
      await invoke("move_task", { root, change, from, to, before: before ?? null });
    },
    async runVerb(verb: Verb, change: string): Promise<unknown> {
      // 动词 command 与动词同名（validate/analyze/archive）。
      return await invoke(verb, { root, change });
    },
    async discardReview(change: string): Promise<void> {
      await invoke("discard_review", { root, change });
    },
    async discardVerify(change: string): Promise<void> {
      await invoke("discard_verify", { root, change });
    },
    async archiveCarry(
      change: string,
      carryReview: boolean,
      carryVerify: boolean,
    ): Promise<unknown> {
      return await invoke("archive_carry", { root, change, carryReview, carryVerify });
    },
    async getStationTicket(change: string, station: TicketStation): Promise<StationTicket | null> {
      return await invoke<StationTicket | null>("station_ticket", { root, change, station });
    },
    async getArchivedDocument(datedName: string, artifact: string): Promise<string | null> {
      return await invoke<string | null>("archived_document", { root, datedName, artifact });
    },
    async getArchivedStationTicket(
      datedName: string,
      station: TicketStation,
    ): Promise<StationTicket | null> {
      return await invoke<StationTicket | null>("archived_station_ticket", { root, datedName, station });
    },
    async archivedCapabilities(datedName: string): Promise<string[]> {
      return await invoke<string[]>("archived_capabilities", { root, datedName });
    },
    async listDiscussions(): Promise<DiscussionLists> {
      return await invoke<DiscussionLists>("list_discussions", { root });
    },
    async getDiscussionDocument(slug: string): Promise<DiscussionDocument | null> {
      const doc = await invoke<{ content: string; cuts?: DiscussionCut[] } | null>("discussion_document", { root, slug });
      return doc && { content: doc.content, cuts: doc.cuts ?? [] };
    },
    async promoteDiscussion(slug: string, name?: string): Promise<{ change: string }> {
      return await invoke<{ change: string }>("promote_discussion", {
        root,
        slug,
        name: name ?? null,
      });
    },
    async archiveDiscussion(slug: string): Promise<void> {
      await invoke("archive_discussion", { root, slug });
    },
    async reorderCard(
      kind: CardKind,
      id: string,
      prevId: string | null,
      nextId: string | null,
    ): Promise<void> {
      await invoke("reorder_card", { root, kind, id, prevId, nextId });
    },
    async setDepends(change: string, on: string[], remove: boolean): Promise<void> {
      await invoke("set_change_depends", { root, change, on, remove });
    },
    async dependsCandidates(change: string): Promise<string[]> {
      // 候选名册与 setDepends 同一定根（add-change-plan-remote D9）：worktree 映射时为副本。
      return await invoke<string[]>("depends_candidates", { root, change });
    },
  };
}

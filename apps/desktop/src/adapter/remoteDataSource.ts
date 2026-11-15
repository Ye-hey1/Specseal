import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { emptyManualIndex, toRevertError } from "@specseal/ui";
import type {
  SpecsealDataSource,
  CardKind,
  ChangeListPayload,
  SpecItem,
  ArchivedItem,
  DiscussionCut,
  DiscussionDocument,
  DiscussionItem,
  DiscussionLists,
  ManualIndex,
  SearchHit,
  StationTicket,
  StatusReport,
  TicketStation,
  Verb,
} from "@specseal/ui";

import type { InvokeFn } from "../session";

// remote adapter（remote-data-source 决策 7）：SpecsealDataSource 对 remote_*
// command 的薄 invoke 包装——每击带 locator 识别（connectionId＋project＋repo），
// 所有 HTTP、token、重试逻辑在 Rust。全读取面直达 server：change 诠释数据与
// capability 清单以既有 remote_status payload 映射（remote-read-parity design
// D2，不开新 command、不另发请求），旧 server 不送的字段以缺席呈现、不伪造。

/** server 的讨论 payload：字段镜射 protocol DiscussionInfo（camelCase）。 */
interface RemoteDiscussionInfo {
  slug: string;
  topic: string;
  status: string;
  rounds: number;
  created: string;
  createdBy?: string | null;
  /** 讨论类型（目前唯一值 "improve"）——一般讨论缺席。 */
  kind?: string | null;
  /** 已转出变更名清单（wire promotedTo）——空清单时 server 省略键。 */
  promotedTo?: string[];
  /** 结论已写入与否（wire concluded）——旧 server 不送时缺席＝未知，不补值。 */
  concluded?: boolean;
  /** 结论是否保留在途（wire hold）——旧 server 不送时缺席＝未知，视同未保留。 */
  hold?: boolean;
}

function toDiscussionItem(info: RemoteDiscussionInfo): DiscussionItem {
  return { ...info, promotedTo: info.promotedTo ?? [] };
}

/** remote_status 的整包 payload：StatusReport 叠加 show 组合字段（wire
 * ChangeStatus 的选填 meta 字段，旧 server 缺席）。 */
interface RemoteStatusPayload extends StatusReport {
  created?: string | null;
  createdBy?: string | null;
  createdWith?: string | null;
  startedAt?: string | null;
  startedBy?: string | null;
  fromDiscussions?: string[];
  deltaCapabilities?: string[];
}

export function createRemoteDataSource(
  connectionId: string,
  project: string,
  repo: string,
  invoke: InvokeFn = tauriInvoke as InvokeFn,
  /** 这个 remote 项目绑定的本机工作副本；没有 checkout 时不带。 */
  checkoutRoot?: string,
): SpecsealDataSource {
  const locator = { connectionId, project, repo };
  // changeCapabilities 与 changeMeta 映射同一份 status payload（spec：不另开
  // 请求）——并发加载共用同一个 in-flight 请求，落定即清、不留 stale 缓存。
  const statusInFlight = new Map<string, Promise<RemoteStatusPayload>>();
  function fetchStatus(change: string): Promise<RemoteStatusPayload> {
    const pending = statusInFlight.get(change);
    if (pending) return pending;
    const p = invoke<RemoteStatusPayload>("remote_status", { ...locator, change }).finally(() => {
      statusInFlight.delete(change);
    });
    statusInFlight.set(change, p);
    return p;
  }
  return {
    async listChanges(): Promise<ChangeListPayload> {
      // remote_list_changes payload 原样（add-change-plan-remote D5）：清单项已依 plan
      // 排序并带调度字段，顶层 planError 在 plan 成环时为消息。清单项的审查与验证状态
      // 也在 Rust 算好（键与本机清单相同）；绑有 checkout 时带上它的位置，已盖章变更的
      // 「其后有变动」才比得到 checkout 里的文件。
      return await invoke<ChangeListPayload>("remote_list_changes", {
        ...locator,
        ...(checkoutRoot ? { checkoutRoot } : {}),
      });
    },
    async listSpecs(): Promise<SpecItem[]> {
      const r = await invoke<{ specs: SpecItem[] }>("remote_list_specs", { ...locator });
      return r.specs;
    },
    async listArchived(): Promise<ArchivedItem[]> {
      const r = await invoke<{ archived: ArchivedItem[] }>("remote_list_archived", {
        ...locator,
      });
      return r.archived;
    },
    async status(change: string): Promise<StatusReport> {
      return await invoke<StatusReport>("remote_status", { ...locator, change });
    },
    async getDocument(change: string, artifact: string): Promise<string | null> {
      return await invoke<string | null>("remote_document", { ...locator, change, artifact });
    },
    async getSpecDocument(capability: string): Promise<string | null> {
      return await invoke<string | null>("remote_spec_document", {
        ...locator,
        capability,
      });
    },
    async listManualPages(): Promise<ManualIndex> {
      // 手册在 remote 尚不支持（desktop-manual-page Non-Goals：投影列于讨论 Deferred）
      // ——回报空索引、不发任何请求；手册页据 reason 显示 remote 空状态。
      return emptyManualIndex("remote");
    },
    async getManualPage(): Promise<string | null> {
      return null;
    },
    async searchWorkspace(query: string): Promise<SearchHit[]> {
      const r = await invoke<{ hits: SearchHit[] }>("remote_search_workspace", {
        ...locator,
        query,
      });
      return r.hits;
    },
    async changeCapabilities(change: string): Promise<string[]> {
      const s = await fetchStatus(change);
      return s.deltaCapabilities ?? [];
    },
    async changeMeta(change: string): Promise<import("@specseal/ui").ChangeMetaInfo | null> {
      const s = await fetchStatus(change);
      return {
        schema: s.schemaName,
        created: s.created ?? null,
        createdBy: s.createdBy ?? null,
        createdWith: s.createdWith ?? null,
        fromDiscussions: s.fromDiscussions ?? [],
        startedAt: s.startedAt ?? null,
        startedBy: s.startedBy ?? null,
      };
    },
    async claim(change: string): Promise<void> {
      // 已被他人持有时 Rust 侧原样带回 server 的 409 消息（含持有人与建议
      // 动作）——沿既有失败 toast 呈现，这里不加工。
      await invoke("remote_claim", { ...locator, change });
    },
    async deleteChange(change: string): Promise<void> {
      // archive-readiness-gating D2 翻案：force=false 与本地 discard 守门语意对齐
      // ——已开工 change 由 server 拒绝（需要强制），拒绝错误沿既有 deleteFailed
      // toast 路径呈现；server 端运行 discard 全语意（守门＋unlink＋原子删除）。
      await invoke("remote_delete_change", { ...locator, change, force: false });
    },
    async revertChangeToProposed(change: string): Promise<void> {
      // 守门 409 的证据由 Rust bridge 转为与本地同形状的 JSON 错误字符串——
      // 同一 toRevertError 转译,App 的守门对话框单一消费入口。
      try {
        await invoke("remote_revert_change_to_proposed", { ...locator, change });
      } catch (e) {
        throw toRevertError(e);
      }
    },
    async setTaskDone(change: string, task: string, done: boolean): Promise<void> {
      await invoke("remote_set_task_done", { ...locator, change, task, done });
    },
    async setAllTasks(change: string, done: boolean): Promise<void> {
      await invoke("remote_set_all_tasks", { ...locator, change, done });
    },
    async moveTask(change: string, from: number, to: number, before?: boolean): Promise<void> {
      await invoke("remote_move_task", { ...locator, change, from, to, before: before ?? null });
    },
    async runVerb(verb: Verb, change: string): Promise<unknown> {
      // 动词 command 对 remote_* 同名映射（validate/analyze/archive 皆直达）。
      if (verb === "validate") return await invoke("remote_validate", { ...locator, change });
      if (verb === "analyze") return await invoke("remote_analyze", { ...locator, change });
      return await invoke("remote_archive", { ...locator, change });
    },
    // 封存对话框的三个选项在 remote 与本机相同：放弃该站的工单，或带着它封存。
    async discardReview(change: string): Promise<void> {
      await invoke("remote_discard_station", { ...locator, change, station: "review" });
    },
    async discardVerify(change: string): Promise<void> {
      await invoke("remote_discard_station", { ...locator, change, station: "verify" });
    },
    async archiveCarry(change: string, carryReview: boolean, carryVerify: boolean): Promise<unknown> {
      return await invoke("remote_archive", { ...locator, change, carryReview, carryVerify });
    },
    async getStationTicket(change: string, station: TicketStation): Promise<StationTicket | null> {
      // 活工单走 GET /changes/{name}/{station} 的结构化 rounds（不走 artifact 白名单）。
      return await invoke<StationTicket | null>("remote_station_ticket", { ...locator, change, station });
    },
    async getArchivedDocument(datedName: string, artifact: string): Promise<string | null> {
      return await invoke<string | null>("remote_archived_document", {
        ...locator,
        datedName,
        artifact,
      });
    },
    async getArchivedStationTicket(
      datedName: string,
      station: TicketStation,
    ): Promise<StationTicket | null> {
      // 封存工单只有原文端点——Rust 侧取原文后以引擎解析成同一形状。
      return await invoke<StationTicket | null>("remote_archived_station_ticket", {
        ...locator,
        datedName,
        station,
      });
    },
    async archivedCapabilities(datedName: string): Promise<string[]> {
      return await invoke<string[]>("remote_archived_capabilities", {
        ...locator,
        datedName,
      });
    },
    async listDiscussions(): Promise<DiscussionLists> {
      const r = await invoke<{ active: RemoteDiscussionInfo[]; archived: RemoteDiscussionInfo[] }>(
        "remote_list_discussions",
        { ...locator },
      );
      return { active: r.active.map(toDiscussionItem), archived: r.archived.map(toDiscussionItem) };
    },
    async getDiscussionDocument(slug: string): Promise<DiscussionDocument | null> {
      const doc = await invoke<{ content: string; cuts?: DiscussionCut[] } | null>("remote_discussion_document", { ...locator, slug });
      return doc && { content: doc.content, cuts: doc.cuts ?? [] };
    },
    async promoteDiscussion(slug: string, name?: string): Promise<{ change: string }> {
      return await invoke<{ change: string }>("remote_promote_discussion", {
        ...locator,
        slug,
        name: name ?? null,
      });
    },
    async archiveDiscussion(slug: string): Promise<void> {
      await invoke("remote_archive_discussion", { ...locator, slug });
    },
    async reorderCard(
      kind: CardKind,
      id: string,
      prevId: string | null,
      nextId: string | null,
    ): Promise<void> {
      await invoke("remote_reorder_card", { ...locator, kind, id, prevId, nextId });
    },
    async setDepends(change: string, on: string[], remove: boolean): Promise<void> {
      await invoke("remote_set_change_depends", { ...locator, change, on, remove });
    },
  };
}

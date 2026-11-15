// WorkspaceSession 模型（workspace-session design 决策 1/3）：
// 分页身分＝WorkspaceLocator、locatorKey 为去重／持久化 activeKey／tray 识别
// 的唯一身分函数。remote 变体的建构路径是 WorkspaceChooser 的远程打开
// （skip 或 folder 模式）→ remote_open handshake → createRemoteSession。
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import type { ReviewRules, SpecsealDataSource } from "@specseal/ui";

import { createRemoteDataSource } from "./adapter/remoteDataSource";
import { createTauriDataSource } from "./adapter/tauriDataSource";
import {
  createRemoteSettings,
  createWorkspaceSettings,
  type SchemaEntry,
  type SettingsSnapshot,
  type SubagentModelConfig,
  type WorkflowFields,
} from "./adapter/workspace";

export type WorkspaceLocator =
  | { kind: "local"; root: string }
  | {
      kind: "remote";
      connectionId: string;
      projectId: string;
      repoId: string;
      checkoutRoot?: string;
    };

/** 分页去重、持久化 activeKey 与 tray 菜单识别的唯一身分（design 决策 1）：
 * local 为 local:{root}、remote 为 remote:{connectionId}/{projectId}/{repoId}
 * （checkoutRoot 属工作副本位置、不参与身分）。 */
export function locatorKey(locator: WorkspaceLocator): string {
  return locator.kind === "local"
    ? `local:${locator.root}`
    : `remote:${locator.connectionId}/${locator.projectId}/${locator.repoId}`;
}

/** 显示信息（§10.4 descriptor）：承接现有分页显示字段（name、badge）。 */
export interface WorkspaceDescriptor {
  name: string;
  /** 待收尾数；null＝尚未取得。 */
  badge: number | null;
}

/** 设置面（design 决策 3）：现 WorkspaceAdapter 设置面的 root 绑定版——
 * 方法不收 root，root 已绑入 session 闭包。 */
export interface WorkspaceSettingsProvider {
  kind: "local" | "remote";
  /** remote 取自 handshake；local 固定为 true。server 仍是最终防线。 */
  policyWrite: boolean;
  readSettings(): Promise<SettingsSnapshot>;
  writeAppTools(tools: string[]): Promise<void>;
  /** remote 成功回新 revision；local 维持 void。 */
  writeWorkflowConfig(fields: WorkflowFields): Promise<number | void>;
  writeWorkflowContext(context: string): Promise<number | void>;
  writeWorkflowRules(rules: Array<[string, string[]]>): Promise<number | void>;
  /** 审查规则整块代换（只写 review 键）；remote 成功回新 revision、local 维持 void。 */
  writeWorkflowReview(review: ReviewRules): Promise<number | void>;
  /** 子代理模型整块代换（只写 subagent_model 键）；remote 成功回新 revision、local 维持 void。 */
  writeWorkflowSubagentModel(config: SubagentModelConfig): Promise<number | void>;
  /** 产出流程清单（desktop-schema-panel D2）：local 三层、remote 仅内嵌内置。 */
  readSchemas(): Promise<SchemaEntry[]>;
  /** 切换项目 schema；remote 成功回新 revision、local 维持 void。 */
  writeWorkflowSchema(name: string): Promise<number | void>;
  /** fork 到项目层（复本名固定为引擎缺省 <source>-custom），回新 schema 名称；
   * remote 不支持（rejected Promise）。 */
  forkSchema(source: string): Promise<string>;
  /** 创建自订 schema 骨架（D5；引擎缺省布局）；remote 不支持（rejected Promise）。 */
  createSchema(name: string): Promise<void>;
  /** 在文件管理器显示 schema 目录（D6；path 来自快照）；remote 不支持。 */
  revealSchema(path: string): Promise<void>;
  /** 删除项目层自订 schema（D7；使用中拒删）；remote 不支持。 */
  deleteSchema(name: string): Promise<void>;
}

/** 事件面（design 决策 5）：workspace-changed 以自身 locator 过滤后才触发。 */
export interface WorkspaceEvents {
  /** 订阅过滤后的变更通知；回传解除订阅函数。 */
  subscribe(onChange: () => void, onConnectionState?: (event: RemoteConnectionStateEvent) => void): () => void;
}

export type RemoteConnectionState = "online" | "offline" | "needs-reauth";

export interface RemoteConnectionStateEvent {
  connectionId: string;
  state: RemoteConnectionState;
  message: string | null;
}

/** 逐操作的 capability 描述（remote-data-source 决策 2）：UI 据此停用
 * affordance——字段镜射 Rust RemoteCapabilities 的 camelCase 串行化。
 * 本地 session 全真、同一 UI 路径零分岐维护。 */
export interface WorkspaceCapabilities {
  listChanges: boolean;
  listSpecs: boolean;
  listArchived: boolean;
  status: boolean;
  getDocument: boolean;
  getSpecDocument: boolean;
  searchWorkspace: boolean;
  changeCapabilities: boolean;
  changeMeta: boolean;
  deleteChange: boolean;
  setTaskDone: boolean;
  setAllTasks: boolean;
  moveTask: boolean;
  validate: boolean;
  analyze: boolean;
  archive: boolean;
  getArchivedDocument: boolean;
  archivedCapabilities: boolean;
  listDiscussions: boolean;
  getDiscussionDocument: boolean;
  promoteDiscussion: boolean;
  archiveDiscussion: boolean;
  reorderCard: boolean;
  /** 前置编辑（调度分页的添加／移除）：local 真；remote 依 membership role（与 reorderCard 同源）。 */
  setDepends: boolean;
  /** 认领（RemoteOnly）：remote 依 membership role；local 固定为 false。 */
  claim: boolean;
  /** remote membership 是否可写 policy；local 固定为 true。 */
  policyWrite: boolean;
  /** server 是否声明事件能力（SSE／polling）；缺席时退化为手动重整。 */
  liveUpdates: boolean;
}

/** 本地 session 的 capability 描述：全真（决策 2）。 */
export const LOCAL_CAPABILITIES: WorkspaceCapabilities = {
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
  // claim 是 RemoteOnly 动词——本地没有共用者可撞工，连停用的入口都不长。
  claim: false,
  policyWrite: true,
  liveUpdates: true,
};

/** WorkspaceSession（§10.4 全字段）：id 以 locatorKey 衍生——同 locator 同
 * session（独立 id 留给多窗口需求出现时）。 */
export interface WorkspaceSession {
  id: string;
  locator: WorkspaceLocator;
  descriptor: WorkspaceDescriptor;
  dataSource: SpecsealDataSource;
  settings: WorkspaceSettingsProvider;
  events: WorkspaceEvents;
  capabilities: WorkspaceCapabilities;
  /** handshake 原始 capability；offline mask 解除时由此精确还原。 */
  baseCapabilities?: WorkspaceCapabilities;
  /** local 为缺席；remote 初始 online，之后只接受 Rust 事件更新。 */
  connectionState?: RemoteConnectionStateEvent;
}

export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
export type ListenFn = (
  event: string,
  handler: (e: { payload: unknown }) => void,
) => Promise<() => void>;

export interface LocalSessionDeps {
  /** 测试注入假 invoke；缺省 Tauri invoke。 */
  invoke?: InvokeFn;
  /** 测试注入假 listen；缺省 Tauri listen。 */
  listen?: ListenFn;
  /** 显示名（探测回报）；未给时以 root 末段推导。 */
  name?: string;
}

/** root 末段作为缺省显示名（Windows 反斜线与 POSIX 斜线皆可）。 */
function basenameOf(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || root;
}

/** local session 工厂（design 决策 3）：root 绑入 dataSource／settings 闭包，
 * events 订阅 workspace-changed 并以自身 root 过滤 payload（决策 5）——
 * 非活跃 session 的订阅者天然收不到（watcher 只挂在活跃 root）。 */
export function createLocalSession(root: string, deps: LocalSessionDeps = {}): WorkspaceSession {
  const invoke = deps.invoke ?? (tauriInvoke as InvokeFn);
  const listen = deps.listen ?? (tauriListen as unknown as ListenFn);
  const locator: WorkspaceLocator = { kind: "local", root };
  return {
    id: locatorKey(locator),
    locator,
    descriptor: { name: deps.name ?? basenameOf(root), badge: null },
    dataSource: createTauriDataSource(root, invoke),
    settings: createWorkspaceSettings(root, invoke),
    events: {
      subscribe(onChange) {
        const unlisten = listen("workspace-changed", (e) => {
          if (e.payload === root) onChange();
        });
        return () => {
          void unlisten.then((f) => f());
        };
      },
    },
    capabilities: LOCAL_CAPABILITIES,
  };
}

/** remote_open 的回传 payload（Rust RemoteOpenInfo 的 camelCase 串行化）：
 * handshake 裁定后的 project/repo 识别、显示名与 capability 描述。 */
export interface RemoteOpenInfo {
  projectKey: string;
  projectName: string;
  repoKey: string;
  repoName: string;
  capabilities: WorkspaceCapabilities;
}

export type RemoteRecoveryKind =
  | "unreachable"
  | "needs-reauth"
  | "access-denied"
  | "not-found"
  | "unknown";

export interface RemoteOpenFailure {
  kind: RemoteRecoveryKind;
  message: string;
  reason: string | null;
  status: number | null;
}

export type RemoteWorkspaceRecoveryState =
  | { status: "restoring"; failure: null }
  | { status: "error"; failure: RemoteOpenFailure };

export type RemoteWorkspaceStatus =
  | "ready"
  | "restoring"
  | "offline"
  | "needs-reauth"
  | "error";

/** 主窗口 tab、复原页与 Tray 共用的单一状态裁决。无 session 且无明确
 * recovery state 是不完整状态，安全降阶为 error，绝不伪装成 ready。 */
export function remoteWorkspaceStatus(
  session: WorkspaceSession | undefined,
  recovery: RemoteWorkspaceRecoveryState | undefined,
): RemoteWorkspaceStatus {
  if (recovery) return recovery.status;
  if (!session) return "error";
  if (session.locator.kind !== "remote") return "ready";
  const connectionState = session.connectionState?.state ?? "online";
  return connectionState === "online" ? "ready" : connectionState;
}

function structuredRemoteOpenFailure(
  error: unknown,
): Omit<RemoteOpenFailure, "kind"> | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as Record<string, unknown>;
  if (typeof candidate.message !== "string") return null;
  const reason = candidate.reason;
  if (reason !== null && typeof reason !== "string") return null;
  const status = candidate.status;
  if (
    status !== null &&
    (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599)
  ) {
    return null;
  }
  return {
    message: candidate.message,
    reason,
    status,
  };
}

/** 将 Tauri object rejection 与旧版 string/Error rejection 收敛成封闭分类。
 * `message` 仅保留作 technical detail，分类永不比对其文本。 */
export function normalizeRemoteOpenFailure(error: unknown): RemoteOpenFailure {
  if (error instanceof RemoteOpenError) return error.failure;
  const failure = structuredRemoteOpenFailure(error);
  if (!failure) {
    return {
      kind: "unknown",
      message: error instanceof Error ? error.message : String(error),
      reason: null,
      status: null,
    };
  }

  let kind: RemoteRecoveryKind = "unknown";
  if (failure.status === 401 || failure.reason === "needs_reauth") {
    kind = "needs-reauth";
  } else if (failure.status === 403) {
    kind = "access-denied";
  } else if (failure.status === 404 || failure.reason === "not_found") {
    kind = "not-found";
  } else if (
    failure.reason === "unavailable" ||
    failure.reason === "offline" ||
    (failure.reason === null && failure.status === null) ||
    (failure.status !== null && failure.status >= 500)
  ) {
    kind = "unreachable";
  }
  return { kind, ...failure };
}

export class RemoteOpenError extends Error {
  readonly failure: RemoteOpenFailure;

  constructor(failure: RemoteOpenFailure) {
    super(failure.message);
    this.name = "RemoteOpenError";
    this.failure = failure;
  }
}

export interface RemoteSessionDeps {
  invoke?: InvokeFn;
  listen?: ListenFn;
}

const REMOTE_WRITE_CAPABILITIES: ReadonlyArray<keyof WorkspaceCapabilities> = [
  "deleteChange",
  "setTaskDone",
  "setAllTasks",
  "moveTask",
  "archive",
  "promoteDiscussion",
  "archiveDiscussion",
  "reorderCard",
  "setDepends",
  "claim",
  "policyWrite",
];

function maskRemoteWrites(capabilities: WorkspaceCapabilities): WorkspaceCapabilities {
  const masked = { ...capabilities };
  for (const key of REMOTE_WRITE_CAPABILITIES) masked[key] = false;
  return masked;
}

export function applyRemoteConnectionState(
  session: WorkspaceSession,
  event: RemoteConnectionStateEvent,
): WorkspaceSession {
  if (session.locator.kind !== "remote" || session.locator.connectionId !== event.connectionId) {
    return session;
  }
  const baseCapabilities = session.baseCapabilities ?? session.capabilities;
  const writable = event.state === "online";
  return {
    ...session,
    baseCapabilities,
    connectionState: event,
    capabilities: writable ? baseCapabilities : maskRemoteWrites(baseCapabilities),
    settings: {
      ...session.settings,
      policyWrite: writable ? baseCapabilities.policyWrite : false,
    },
  };
}

function isRemoteConnectionStateEvent(payload: unknown): payload is RemoteConnectionStateEvent {
  if (!payload || typeof payload !== "object") return false;
  const event = payload as Partial<RemoteConnectionStateEvent>;
  return (
    typeof event.connectionId === "string" &&
    (event.state === "online" || event.state === "offline" || event.state === "needs-reauth") &&
    (event.message === null || typeof event.message === "string")
  );
}

/** remote session 工厂（决策 6/7）：以 remote_open（handshake）的结果建
 * session——handshake 成功是创建前置，这里不再打 server。dataSource 为
 * remote_* 的薄 invoke 包装；事件面订阅时挂 remote_watch（Rust 端同
 * connection 同 scope 共用单流）、以 locator key 过滤 payload，解除时
 * remote_unwatch。 */
export function createRemoteSession(
  connectionId: string,
  info: RemoteOpenInfo,
  checkoutRoot?: string,
  deps: RemoteSessionDeps = {},
): WorkspaceSession {
  const invoke = deps.invoke ?? (tauriInvoke as InvokeFn);
  const listen = deps.listen ?? (tauriListen as unknown as ListenFn);
  const locator: WorkspaceLocator = {
    kind: "remote",
    connectionId,
    projectId: info.projectKey,
    repoId: info.repoKey,
    ...(checkoutRoot ? { checkoutRoot } : {}),
  };
  const key = locatorKey(locator);
  const watchArgs = { connectionId, project: info.projectKey, repo: info.repoKey };
  return {
    id: key,
    locator,
    descriptor: { name: `${info.projectName}/${info.repoName}`, badge: null },
    dataSource: createRemoteDataSource(connectionId, info.projectKey, info.repoKey, invoke, checkoutRoot),
    settings: createRemoteSettings(
      connectionId,
      info.projectKey,
      info.repoKey,
      info.capabilities.policyWrite,
      invoke,
    ),
    events: {
      subscribe(onChange, onConnectionState) {
        void invoke("remote_watch", { ...watchArgs });
        const unlistenWorkspace = listen("remote-workspace-changed", (e) => {
          if (e.payload === key) onChange();
        });
        const unlistenState = listen("remote-connection-state", (e) => {
          if (
            isRemoteConnectionStateEvent(e.payload) &&
            e.payload.connectionId === connectionId
          ) {
            onConnectionState?.(e.payload);
          }
        });
        return () => {
          void unlistenWorkspace.then((f) => f());
          void unlistenState.then((f) => f());
          void invoke("remote_unwatch", { ...watchArgs });
        };
      },
    },
    capabilities: info.capabilities,
    baseCapabilities: info.capabilities,
    connectionState: { connectionId, state: "online", message: null },
  };
}

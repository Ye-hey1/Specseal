// workspace 管理操作的桌面 adapter（design D6；workspace-session 决策 3/4）：
// 直接 invoke 桌面专属 command，不经 packages/ui 的 SpecsealDataSource——该接口
// 是 change／spec 浏览管理抽象，项目与设置语意属宿主。探测面（打开／初始化／
// 统计）收路径参数；设置面经 createWorkspaceSettings 将 root 绑入闭包，每支
// command 显式带 root。
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { ReviewRules } from "@specseal/ui";

import type { InvokeFn, WorkspaceSettingsProvider } from "../session";

/** open_project／init_project／adopt_project 的判定 payload（错误走 rejected Promise）。 */
export type ProjectProbe =
  | { status: "project"; root: string; name: string }
  | {
      status: "remoteBinding";
      url: string;
      repo?: string | null;
      hasLocalOpenspec: boolean;
    }
  | { status: "uninitialized"; dir: string }
  /** needsImport：规格文件夹是旧布局 openspec/，激活会先改名为 specseal/。 */
  | { status: "unadopted"; root: string; needsImport: boolean };

/** schema 的来源层级（引擎的 resolution 层命名：内置／项目层／user 层）。 */
export type SchemaSource = "package" | "project" | "user";

/** 产出流程清单一项（read_schemas 的 payload；desktop-schema-panel D1/D2）：
 * error 有值＝该 schema 解析失败，内容字段一律空。 */
export interface SchemaEntry {
  name: string;
  source: SchemaSource;
  /** artifact 图（引擎显示序，与产出规则分节固定键同源）。 */
  artifactIds: string[];
  artifacts: SchemaArtifactDetail[];
  /** schema 目录绝对路径（打开所在文件夹的把手）；内置为 null。 */
  path: string | null;
  error: string | null;
}

/** 一个 artifact 的唯读详情全文。 */
export interface SchemaArtifactDetail {
  id: string;
  description: string;
  instruction: string | null;
  template: string | null;
}

/** config.yaml 的 subagent_model 区块：两站各工具的模型与各工具的自订清单（键为工具名称）。 */
export interface SubagentModelConfig {
  review: Record<string, string>;
  verify: Record<string, string>;
  choices: Record<string, string[]>;
}

/** read_settings 的快照 payload（字段值＋各档可选的 parseError）。 */
export interface SettingsSnapshot {
  /** 规格文件夹的项目根相对路径（specseal、旧布局 openspec 或明写的 spec_dir）；远程快照不带。 */
  specDir?: string;
  app: { tools: string[]; customTools: string[]; parseError: string | null };
  workflow: {
    locale: string | null;
    specLocale: string | null;
    tdd: boolean;
    audit: boolean;
    /** worktree 政策现值；remote 快照恒为 false（该面不支持此轴）。 */
    worktree: boolean;
    /** 项目说明现值（config.yaml 的 context；null＝未设置）。 */
    context: string | null;
    /** 产出规则现值（依 artifact id 分组；条目顺序即文件顺序）。 */
    rules: Record<string, string[]>;
    /** 审查规则现值（config.yaml 的 review）。 */
    review: ReviewRules;
    /** 缺省清单的 12 个 smell 名称——引擎单一提供，前端只显示、不另存。 */
    reviewBaselineSmells: string[];
    /** 子代理模型现值（config.yaml 的 subagent_model；缺席时三个空对象）。 */
    subagentModel: SubagentModelConfig;
    /** 引擎的内置子代理模型清单（工具名称 → 名称；只有 claude）——前端只显示、不另存。 */
    builtinSubagentModels: Record<string, string[]>;
    /** 活跃 schema 的 artifact id（引擎显示序）——产出规则分节的固定键。 */
    schemaArtifacts: string[];
    /** 活跃 schema 名称（config 的 schema 键；缺席缺省 spec-driven、坏档空字符串）。 */
    schemaName: string;
    /** false＝remote 快照遇非内置 schema 名称（远程自订尚不支持）；其余恒 true。 */
    schemaKnown: boolean;
    parseError: string | null;
    /** remote policy 的 scope revision；local 快照不带此栏。 */
    revision?: number;
  };
}

/** write_workflow_config 的完整目标状态（null/false＝设回缺省即移除键）。 */
export interface WorkflowFields {
  locale: string | null;
  specLocale: string | null;
  tdd: boolean;
  audit: boolean;
  /** 并行 apply 的 worktree 流程；remote 无此轴（写入时忽略）。 */
  worktree: boolean;
}

/** probe_assets 的回报（引擎 AssetProbe 的 camelCase 串行化）：
 * 五态判定、目前产物层版号、逐工具状态与将被新建或改写的受管档清单。 */
export interface AssetProbeResult {
  status: "missing" | "stale" | "newer" | "current" | "unknown";
  currentVersion: string;
  tools: Array<{
    tool: string;
    workspaceVersion: string | null;
    stale: boolean;
    /** 此工具的文件领先引擎（app 本体是旧版）；与 stale 互斥。 */
    newer: boolean;
    missing: boolean;
  }>;
  differingFiles: string[];
  /** 规格文件夹迁移状态（desktop-spec-dir-migration D1）。 */
  migration: MigrationProbe;
  /** remote 项目才有（probe_remote_assets）：Server 提供的技能版本——比对的基准是它，
   * `currentVersion` 仍是这个 app 内置的技能版号。 */
  serverVersion?: string;
  /** remote 项目才有：这个 app 内置的技能版号比 Server 的旧。 */
  appOlderThanServer?: boolean;
}

/** 有 checkout 的 remote 项目：连接、Project／Repo 与 checkout 的文件夹。 */
export interface RemoteCheckout {
  connectionId: string;
  project: string;
  repo: string;
  checkout: string;
}

/** 迁移暂缓的原因（引擎 DeferReason 的代码）。 */
export type MigrationDeferReason =
  | "linkedWorktree"
  | "otherWorktrees"
  | "uncommitted"
  | "symlinkedFolder"
  | "specFolderTaken";

/** `folder` 是数据档现在所在的文件夹：openspec 会改名为 specseal，specseal 只改名旧文件名的数据档。 */
export type MigrationProbe =
  | { state: "none" }
  | { state: "pending"; folder: string; metaFiles: number }
  | { state: "deferred"; folder: string; reason: MigrationDeferReason; worktrees: string[] };

/** update_assets 的回报中桌面用到的部分：这次迁移做了什么。 */
export interface AssetUpdateResult {
  migrated: { movedFolder: boolean; renamed: number };
}

/** 探测面：打开／初始化／统计皆收路径参数、无全域语意（设置面见
 * createWorkspaceSettings，经 session 绑 root）。 */
export interface WorkspaceAdapter {
  openProject(path: string): Promise<ProjectProbe>;
  initProject(path: string, tools: string[]): Promise<ProjectProbe>;
  /** 对未激活项目根补齐工作区档（既有规格内容零触碰），成功回报 project。 */
  adoptProject(path: string, tools: string[]): Promise<ProjectProbe>;
  /** 启动语境的缺省目录（首启无持久化分页时据此显式打开）；纯读。 */
  startupDir(): Promise<string>;
  projectStats(path: string): Promise<{ pendingWrapUp: number }>;
  /** 技能档过期探测（唯读）；探测失败以 status=unknown 表达，不 reject。 */
  probeAssets(path: string): Promise<AssetProbeResult>;
  /** 技能档整套再生（委派引擎 update()，含规格文件夹迁移；调用期间暂停监看）；
   * 失败为单行错误消息。 */
  updateAssets(path: string): Promise<AssetUpdateResult>;
  /** remote 项目的技能档探测：以 Server 提供的技能为基准（只比摘要，不下载全文）。
   * Server 没有提供技能时为 null；连不上时 reject。 */
  probeRemoteAssets(target: RemoteCheckout): Promise<AssetProbeResult | null>;
  /** 把 Server 提供的技能写进 checkout（调用期间暂停监看）；失败为单行错误消息。 */
  updateRemoteAssets(target: RemoteCheckout): Promise<AssetUpdateResult>;
  /** 监看重挂（workspace-session 决策 5）：显式跟随活跃 session。 */
  watchWorkspace(root: string): Promise<void>;
  /** 有 checkout 的 remote 项目的监看重挂：监看 checkout 里各工具的技能目录与
   * `.specseal.yaml`（不是整个 checkout）。和本机的监看共用同一个槽位。 */
  watchCheckoutSkills(checkout: string): Promise<void>;
  /** 订阅 `checkout` 的技能档变动；回传退订函数。只通知，不带内容——收到后重新探测。 */
  onCheckoutSkillsChanged(checkout: string, handler: () => void): () => void;
  /** 原生文件夹选择器；取消回 null。 */
  pickFolder(): Promise<string | null>;
}

export function createWorkspaceAdapter(): WorkspaceAdapter {
  return {
    openProject: (path) => tauriInvoke("open_project", { path }),
    initProject: (path, tools) => tauriInvoke("init_project", { path, tools }),
    adoptProject: (path, tools) => tauriInvoke("adopt_project", { path, tools }),
    startupDir: () => tauriInvoke("startup_dir"),
    projectStats: (path) => tauriInvoke("project_stats", { path }),
    probeAssets: (path) => tauriInvoke("probe_assets", { path }),
    updateAssets: (path) => tauriInvoke("update_assets", { path }),
    probeRemoteAssets: (target) => tauriInvoke("probe_remote_assets", { ...target }),
    updateRemoteAssets: (target) => tauriInvoke("update_remote_assets", { ...target }),
    watchWorkspace: (root) => tauriInvoke("watch_workspace", { root }),
    watchCheckoutSkills: (checkout) => tauriInvoke("watch_checkout_skills", { checkout }),
    onCheckoutSkillsChanged: (checkout, handler) => {
      const unlisten = listen<string>("checkout-skills-changed", (event) => {
        if (event.payload === checkout) handler();
      });
      return () => {
        void unlisten.then((stop) => stop());
      };
    },
    pickFolder: async () => {
      const picked = await open({ directory: true, multiple: false });
      return typeof picked === "string" ? picked : null;
    },
  };
}

/** 设置面工厂（workspace-session 决策 3）：root 绑入闭包，每支 command 显式
 * 带 root 直通 desktop-core 的带路径函数。invoke 可注入以利测试。 */
export function createWorkspaceSettings(
  root: string,
  invoke: InvokeFn = tauriInvoke as InvokeFn,
): WorkspaceSettingsProvider {
  return {
    kind: "local",
    policyWrite: true,
    readSettings: () => invoke("read_settings", { root }),
    writeAppTools: (tools) => invoke("write_app_tools", { root, tools }),
    writeWorkflowConfig: (fields) =>
      invoke("write_workflow_config", {
        root,
        locale: fields.locale,
        specLocale: fields.specLocale,
        tdd: fields.tdd,
        audit: fields.audit,
        worktree: fields.worktree,
      }),
    writeWorkflowContext: (context) =>
      invoke("write_workflow_content", { root, context, rules: null }),
    writeWorkflowRules: (rules) => invoke("write_workflow_content", { root, context: null, rules }),
    writeWorkflowReview: (review) =>
      invoke("write_workflow_content", { root, context: null, rules: null, review }),
    writeWorkflowSubagentModel: (subagentModel) =>
      invoke("write_workflow_content", { root, context: null, rules: null, review: null, subagentModel }),
    readSchemas: () => invoke("read_schemas", { root }),
    writeWorkflowSchema: (name) => invoke("write_workflow_schema", { root, name }),
    forkSchema: (source) => invoke("fork_schema", { root, source }),
    createSchema: (name) => invoke("init_schema", { root, name }),
    // reveal 以快照给的绝对路径为准（user 层路径前端拼不出来；design D6）。
    revealSchema: (path) => invoke("reveal_in_folder", { path }),
    deleteSchema: (name) => invoke("delete_schema", { root, name }),
  };
}

/** remote 设置面：locator 绑入闭包；read 保存 server revision，三种 targeted
 * write 都必须带该 expectedRevision，成功后才前进本地 token。 */
export function createRemoteSettings(
  connectionId: string,
  project: string,
  repo: string,
  policyWrite: boolean,
  invoke: InvokeFn = tauriInvoke as InvokeFn,
): WorkspaceSettingsProvider {
  const scope = { connectionId, project, repo };
  let revision: number | null = null;

  const expectedRevision = () => {
    if (!policyWrite) throw new Error("你的角色为查看者，只能查看此 Workflow 政策。");
    if (revision === null) throw new Error("尚未读取 policy revision，无法保存");
    return revision;
  };
  const adoptRevision = async (request: Promise<number>) => {
    const next = await request;
    revision = next;
    return next;
  };

  return {
    kind: "remote",
    policyWrite,
    readSettings: async () => {
      const snapshot = await invoke<SettingsSnapshot>("remote_read_settings", scope);
      revision = snapshot.workflow.revision ?? null;
      return snapshot;
    },
    // fork／创建／reveal／删除在 remote 一律拒绝：能力边界的显性表达——UI 依
    // kind 不渲染入口，拒绝是第二道防线，非 Refused Bequest（接口成员对 remote
    // 语意上就是「尚不支持」，与 writeAppTools 同款）。
    writeAppTools: () => Promise.reject(new Error("remote Workflow 无 .specseal.yaml 工具设置")),
    writeWorkflowConfig: (fields) =>
      adoptRevision(
        invoke<number>("remote_write_workflow_config", {
          ...scope,
          locale: fields.locale,
          specLocale: fields.specLocale,
          tdd: fields.tdd,
          audit: fields.audit,
          expectedRevision: expectedRevision(),
        }),
      ),
    writeWorkflowContext: (context) =>
      adoptRevision(
        invoke<number>("remote_write_workflow_content", {
          ...scope,
          context,
          rules: null,
          expectedRevision: expectedRevision(),
        }),
      ),
    writeWorkflowRules: (rules) =>
      adoptRevision(
        invoke<number>("remote_write_workflow_content", {
          ...scope,
          context: null,
          rules,
          expectedRevision: expectedRevision(),
        }),
      ),
    writeWorkflowReview: (review) =>
      adoptRevision(
        invoke<number>("remote_write_workflow_content", {
          ...scope,
          context: null,
          rules: null,
          review,
          expectedRevision: expectedRevision(),
        }),
      ),
    writeWorkflowSubagentModel: (subagentModel) =>
      adoptRevision(
        invoke<number>("remote_write_workflow_content", {
          ...scope,
          context: null,
          rules: null,
          review: null,
          subagentModel,
          expectedRevision: expectedRevision(),
        }),
      ),
    // remote 产出流程清单：desktop core 以内嵌内置组装（不打 server、不带 root）。
    readSchemas: () => invoke("read_schemas", {}),
    writeWorkflowSchema: (name) =>
      adoptRevision(
        invoke<number>("remote_write_workflow_schema", {
          ...scope,
          name,
          expectedRevision: expectedRevision(),
        }),
      ),
    forkSchema: () => Promise.reject(new Error("远程项目尚不支持 fork 产出流程")),
    createSchema: () => Promise.reject(new Error("远程项目尚不支持创建产出流程")),
    revealSchema: () => Promise.reject(new Error("远程项目没有本机文件可显示")),
    deleteSchema: () => Promise.reject(new Error("远程项目尚不支持删除产出流程")),
  };
}

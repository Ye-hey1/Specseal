// server 连接的桌面 adapter（desktop-connections；client-browser-login D7、D9）：
// 清单/添加/登录/注销/移除的 invoke 包装。类型面无任何 secret 字段——
// credential 唯一落点是 Rust 侧的 OS Keychain，TS 只见连接状态与身分显示名；
// PAT 仅作 pat_login 的参数单次过境，不回读、不入状态。登录的等待循环在 Rust：
// 这里只转送它送来的阶段事件，并把终态交回调用端。
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

import type { InvokeFn, ListenFn } from "../session";

/** Rust 送来登录阶段事件的名称。 */
const LOGIN_PHASE_EVENT = "connection-login-phase";

/** 连接条目的 TS 查看：registry 字段＋由 Keychain 推导的登录状态。 */
export interface ConnectionView {
  id: string;
  origin: string;
  name: string;
  /** 最后登录身分的显示名；未登录过即缺席。 */
  lastActorDisplay?: string | null;
  loggedIn: boolean;
}

/** 服务器页「缺省」卡的有效缺省连接：存在且已登录才算，否则等同不预选（null）。 */
export function defaultConnectionOf(
  connections: readonly ConnectionView[],
  defaultConnectionId: string | null | undefined,
): ConnectionView | null {
  return connections.find((entry) => entry.id === defaultConnectionId && entry.loggedIn) ?? null;
}

/** 登录等待中的阶段（Rust 经事件送来）；store 的 `ConnectionPhase` 直接收它。
 * expiresAt＝截止时刻（epoch 毫秒），倒数依它计算。
 * 授权网址只带 state 与 PKCE challenge，不含授权码、verifier 或任何 token。 */
export type LoginPhase =
  | { kind: "awaitingBrowser"; url: string; expiresAt: number }
  | { kind: "awaitingApproval"; userCode: string; verificationUri: string; expiresAt: number };

/** 一次登录的终态（规格「device login 缺省与 PAT fallback」）：patRequired＝server
 * 只收访问密钥或没有 device flow，就地改收 PAT；被拒与逾时带出这一轮的登录方式
 * （两种的说法不同）；连接错误走 reject。 */
export type LoginResult =
  | { status: "loggedIn"; display: string }
  | { status: "patRequired" }
  | { status: "denied"; method: "browser" | "device" }
  | { status: "expired"; method: "browser" | "device" }
  | { status: "cancelled" };

/** 注销结果：撤销为尽力语意；patNotice＝请至服务器帐号页撤销 PAT。 */
export interface LogoutResult {
  revokedOnServer: boolean;
  patNotice: boolean;
}

export interface ScopeRefView {
  id: string;
  key: string;
  name: string;
}

export interface ProjectScopeView extends ScopeRefView {
  repos: ScopeRefView[];
}

export interface ScopesView {
  projects: ProjectScopeView[];
}

/** inspect_checkout 的零写入结果：确认过的 checkout 根路径与要预选的既有 built-in
 * 工具选集（claude／codex／copilot／pi／cursor）。不含任何 credential 或 Server 数据。 */
export interface CheckoutInspection {
  root: string;
  tools: string[];
}

export interface ConnectionsAdapter {
  list(): Promise<ConnectionView[]>;
  add(baseUrl: string, name: string): Promise<ConnectionView>;
  /** 移除连接＝Rust 侧先走注销语意再删条目（决策 6）。 */
  remove(id: string): Promise<void>;
  /** 登录到终态才 resolve：先试静默换新，否则依 server 声明的方式登录；途中的
   * 等待阶段（只属于这个 origin）经 onPhase 送来。 */
  loginStart(origin: string, onPhase: (phase: LoginPhase) => void): Promise<LoginResult>;
  /** 取消等待中的登录：Rust 结束等待、loginStart 以 cancelled 收场。 */
  loginCancel(origin: string): Promise<void>;
  /** PAT 单次过境：调用后 TS 不保留任何拷贝。 */
  patLogin(origin: string, pat: string): Promise<{ status: "loggedIn"; display: string }>;
  logout(origin: string): Promise<LogoutResult>;
  /** 登录者 membership 过滤后的 Project／Repo 清单。 */
  scopes(connectionId: string): Promise<ScopesView>;
  /** 先检查阶段（零写入）：验证 checkout marker 一致性并回报要预选的既有工具选集。 */
  inspectCheckout(
    path: string,
    origin: string,
    project: string,
    repo: string,
  ): Promise<CheckoutInspection>;
  /** 提交阶段：重做验证、无 marker 时写入 marker，再同步所选 built-in 工具的受管产物。 */
  bindCheckout(
    path: string,
    origin: string,
    project: string,
    repo: string,
    tools: string[],
  ): Promise<string>;
}

export function createConnectionsAdapter(
  invoke: InvokeFn = tauriInvoke as InvokeFn,
  listen: ListenFn = tauriListen as unknown as ListenFn,
): ConnectionsAdapter {
  return {
    list: () => invoke("connection_list"),
    add: (baseUrl, name) => invoke("connection_add", { baseUrl, name }),
    remove: (id) => invoke("connection_remove", { id }),
    async loginStart(origin, onPhase) {
      // 先挂好监听再起登录：Rust 一开始就可能送出等待阶段。
      const unlisten = await listen(LOGIN_PHASE_EVENT, (e) => {
        const { origin: from, ...phase } = e.payload as LoginPhase & { origin: string };
        if (from === origin) onPhase(phase as LoginPhase);
      });
      try {
        return await invoke<LoginResult>("connection_login_start", { origin });
      } finally {
        unlisten();
      }
    },
    loginCancel: (origin) => invoke("connection_login_cancel", { origin }),
    patLogin: (origin, pat) => invoke("pat_login", { origin, pat }),
    logout: (origin) => invoke("connection_logout", { origin }),
    scopes: (connectionId) => invoke("remote_scopes", { connectionId }),
    inspectCheckout: (path, origin, project, repo) =>
      invoke("inspect_checkout", { path, origin, project, repo }),
    bindCheckout: (path, origin, project, repo, tools) =>
      invoke("bind_checkout", { path, origin, project, repo, tools }),
  };
}

// 服务器管理最小面（规格「服务器管理最小面」；desktop-settings-mode design D7）：页顶的添加卡
// （URL＋显示名→随即登录，成功即收起）与「连接」卡——一列一个 saved server：显示名＋状态签、
// 等宽 origin、身分；右侧注销或登录／重新登录＋「⋯」（打开项目、移除）；等待授权与 PAT 输入
// 于列下就地展开。app 全域、不经 session 绑定；credential 全程不出 Rust——此面只见状态与身分。
import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  SEMANTIC_TONE,
  SettingsCard,
  SettingsRow,
  StatusPill,
  useI18n,
  type StatusPillLabel,
} from "@specseal/ui";

import type { ConnectionView } from "../adapter/connections";
import type { ConnectionPhase } from "../store";
import { LoginWaiting, PatLoginInput } from "./connectionLogin";

export interface ServersPanelProps {
  connections: ConnectionView[];
  /** 逐连接交互状态（keyed by origin）。 */
  phases: Record<string, ConnectionPhase>;
  /** 添加并随即登录；无效输入 reject、由表单就地呈现。 */
  onAdd: (baseUrl: string, name: string) => Promise<unknown>;
  onLogin: (origin: string) => void;
  /** 取消等待中的登录（等待授权或等待浏览器登录）：回未登录。 */
  onCancelLogin?: (origin: string) => void;
  /** PAT 单次过境：提交后本面即清空草稿。 */
  onSubmitPat: (origin: string, pat: string) => void;
  onLogout: (origin: string) => void;
  onRemove: (id: string) => void;
  /** 挂载时加载清单（进服务器页才触发）。 */
  onRefresh?: () => void;
  /** 打开统一 chooser，预选此 server 并直达 scopes；未注入时入口不显示。 */
  onOpenWorkspace?: (id: string) => void;
  /** needs-reauth 导向时即使 registry 仍标 loggedIn，也呈现并聚焦重新登录。 */
  focusConnectionId?: string | null;
  /** 开着的 remote session 回报需重新登录的连接：registry 仍标 loggedIn，也呈现登录过期与重新登录（不抢焦点）。 */
  expiredConnectionIds?: readonly string[];
  /** 页顶添加卡是否展开（服务器页标题右侧「添加连接」切换）。 */
  addOpen?: boolean;
  onAddOpenChange?: (open: boolean) => void;
}

/** 状态签：交互状态优先于登录状态。 */
function statusPill(entry: ConnectionView, phase: ConnectionPhase, needsReauth: boolean): StatusPillLabel {
  if (phase.kind === "busy") return { key: "servers.busy", tone: "neutral" };
  if (phase.kind === "awaitingApproval" || phase.kind === "awaitingBrowser") {
    return { key: "servers.page.pill.awaiting", tone: "progress" };
  }
  if (phase.kind === "error") return { key: "servers.page.pill.failed", tone: "destructive" };
  if (needsReauth) return { key: "servers.page.pill.expired", tone: "warning" };
  if (entry.loggedIn) return { key: "servers.loggedIn", tone: "success" };
  return { key: "servers.notLoggedIn", tone: "neutral" };
}

function AddConnectionCard({
  onAdd,
  onClose,
}: {
  onAdd: ServersPanelProps["onAdd"];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  async function submit() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setAdding(true);
    setError(null);
    try {
      await onAdd(trimmed, name.trim() || trimmed);
      onClose();
    } catch (e) {
      setError(String(e));
      setAdding(false);
    }
  }

  return (
    <SettingsCard title={t("servers.addTitle")}>
      <div className="flex flex-col gap-2 px-4 py-3" data-testid="server-add-form">
        <div className="flex items-center gap-1.5">
          <Input placeholder={t("servers.urlPlaceholder")} value={url} onChange={(e) => setUrl(e.target.value)} />
          <Input placeholder={t("servers.namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex items-center justify-end gap-1.5">
          {error && (
            <span role="alert" className={`mr-auto text-xs ${SEMANTIC_TONE.danger}`}>
              {error}
            </span>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t("app.cancel")}
          </Button>
          <Button type="button" size="sm" disabled={adding} onClick={() => void submit()}>
            {t("servers.add")}
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}

export function ServersPanel({
  connections,
  phases,
  onAdd,
  onLogin,
  onCancelLogin,
  onSubmitPat,
  onLogout,
  onRemove,
  onRefresh,
  onOpenWorkspace,
  focusConnectionId = null,
  expiredConnectionIds = [],
  addOpen = false,
  onAddOpenChange,
}: ServersPanelProps) {
  const { t } = useI18n();
  const reauthButton = useRef<HTMLButtonElement | null>(null);
  /** 刚登录成功那一列的打开项目钮（规格「登录成功聚焦打开工作区」）。 */
  const openWorkspaceButton = useRef<HTMLButtonElement | null>(null);
  /** 上一轮已登录的 origins；null＝尚未初始化。初次渲染只记录不聚焦——进页看见既有已登录
   * 条目不该被抢走焦点，聚焦与行动呼吁只给「刚完成的登录」。 */
  const loggedInBefore = useRef<Set<string> | null>(null);
  const [justLoggedIn, setJustLoggedIn] = useState<string | null>(null);
  useEffect(() => {
    onRefresh?.();
  }, [onRefresh]);
  useEffect(() => {
    reauthButton.current?.focus();
  }, [focusConnectionId, connections]);
  useEffect(() => {
    const now = new Set(connections.filter((e) => e.loggedIn).map((e) => e.origin));
    const before = loggedInBefore.current;
    loggedInBefore.current = now;
    if (!before) return;
    const fresh = [...now].find((origin) => !before.has(origin));
    if (fresh) setJustLoggedIn(fresh);
  }, [connections]);
  useEffect(() => {
    if (justLoggedIn) openWorkspaceButton.current?.focus();
  }, [justLoggedIn]);

  return (
    <>
      {addOpen && <AddConnectionCard onAdd={onAdd} onClose={() => onAddOpenChange?.(false)} />}
      <SettingsCard title={t("servers.page.connectionsCard")} count={connections.length}>
        {connections.length === 0 ? (
          <p className="m-0 px-4 py-3 text-sm text-muted-foreground" data-testid="servers-empty">
            {t("servers.empty")}
          </p>
        ) : (
          connections.map((entry) => {
            const phase = phases[entry.origin] ?? { kind: "idle" as const };
            const busy = phase.kind === "busy";
            const needsReauth = entry.id === focusConnectionId || expiredConnectionIds.includes(entry.id);
            const pill = statusPill(entry, phase, needsReauth);
            const canOpen = entry.loggedIn && onOpenWorkspace !== undefined;
            return (
              <div key={entry.id} data-testid={`server-row-${entry.origin}`}>
                <SettingsRow
                  label={
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium">{entry.name}</span>
                      <StatusPill tone={pill.tone}>{t(pill.key)}</StatusPill>
                    </span>
                  }
                  description={
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-mono">{entry.origin}</span>
                      {entry.lastActorDisplay && <span className="truncate">{entry.lastActorDisplay}</span>}
                    </span>
                  }
                  control={
                    <>
                      {/* 登录成功的行动呼吁：只给刚完成登录的那一列，并取得键盘焦点。 */}
                      {canOpen && entry.origin === justLoggedIn && (
                        <Button
                          ref={openWorkspaceButton}
                          type="button"
                          size="sm"
                          disabled={busy}
                          data-testid={`open-workspace-${entry.origin}`}
                          onClick={() => onOpenWorkspace!(entry.id)}
                        >
                          {t("servers.openProject")}
                        </Button>
                      )}
                      {entry.loggedIn && !needsReauth ? (
                        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onLogout(entry.origin)}>
                          {t("servers.logout")}
                        </Button>
                      ) : (
                        <Button
                          ref={entry.id === focusConnectionId ? reauthButton : undefined}
                          type="button"
                          size="sm"
                          disabled={busy}
                          data-testid={needsReauth ? `reauth-login-${entry.id}` : undefined}
                          onClick={() => onLogin(entry.origin)}
                        >
                          {needsReauth ? t("remote.reauthAction") : t("servers.login")}
                        </Button>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="subtle"
                            size="icon-sm"
                            disabled={busy}
                            aria-label={t("servers.page.moreActions")}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {canOpen && (
                            <DropdownMenuItem onSelect={() => onOpenWorkspace!(entry.id)}>
                              {t("servers.openProject")}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem variant="destructive" onSelect={() => onRemove(entry.id)}>
                            {t("servers.remove")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  }
                >
                  {(phase.kind === "error" ||
                    phase.kind === "notice" ||
                    phase.kind === "awaitingApproval" ||
                    phase.kind === "awaitingBrowser" ||
                    phase.kind === "patInput") && (
                    <div className="flex flex-col gap-2">
                      {phase.kind === "error" && (
                        <span role="alert" className={`text-xs ${SEMANTIC_TONE.danger}`}>
                          {phase.message}
                        </span>
                      )}
                      {phase.kind === "notice" && <span className="text-xs text-muted-foreground">{phase.message}</span>}
                      {(phase.kind === "awaitingApproval" || phase.kind === "awaitingBrowser") && (
                        <LoginWaiting origin={entry.origin} phase={phase} onCancel={() => onCancelLogin?.(entry.origin)} />
                      )}
                      {phase.kind === "patInput" && (
                        <div data-testid={`pat-input-${entry.origin}`}>
                          <PatLoginInput error={phase.error} onSubmit={(pat) => onSubmitPat(entry.origin, pat)} />
                        </div>
                      )}
                    </div>
                  )}
                </SettingsRow>
              </div>
            );
          })
        )}
      </SettingsCard>
    </>
  );
}

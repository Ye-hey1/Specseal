import { useEffect, useState } from "react";
import { ArrowLeft, Cloud, Folder, GitBranch, Plus, Server } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Checkbox,
  Input,
  StepProgress,
  cn,
  useI18n,
} from "@specseal/ui";

import {
  defaultConnectionOf,
  type ConnectionView,
  type ConnectionsAdapter,
  type ProjectScopeView,
  type ScopeRefView,
  type ScopesView,
} from "../adapter/connections";
import type { WorkspaceAdapter } from "../adapter/workspace";
import type { RecentEntry } from "../recents";
import { locatorKey } from "../session";
import type { ConnectionPhase } from "../store";
import { LoginWaiting, PatLoginInput } from "./connectionLogin";
import { RecentList, useRecentOpener, type OpenLocal } from "./RecentList";
import { BUILTIN_TOOLS } from "../builtinTools";

type Step = "source" | "server" | "scopes" | "checkout";

export interface ScopeChoice {
  project: ProjectScopeView;
  repo: ScopeRefView;
}

export interface WorkspaceChooserProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connections: ConnectionView[];
  connectionAdapter: Pick<
    ConnectionsAdapter,
    "scopes" | "inspectCheckout" | "bindCheckout"
  >;
  workspace: Pick<WorkspaceAdapter, "pickFolder" | "openProject">;
  onOpenLocal: OpenLocal;
  onRequestMigration?: (root: string) => Promise<void>;
  /** 添加并随即登录；回传范式 origin 供本面追踪该连接的交互状态。 */
  onAddServer: (baseUrl: string, name: string) => Promise<string | null>;
  /** 逐连接交互状态（keyed by origin）——登录回馈在本面就地渲染（design 决策三）。 */
  phases: Record<string, ConnectionPhase>;
  /** 取消等待授权：停止轮询、回未登录。 */
  onCancelLogin: (origin: string) => void;
  /** PAT 单次过境提交。 */
  onSubmitPat: (origin: string, pat: string) => void;
  /** 重整连接清单；回传读取是否成功——失败时清单保留现值，最近打开列据此
   * 不把 remote 条目误判成「连接已移除」。 */
  onRefreshConnections: () => Promise<boolean>;
  onOpenRemote: (
    connectionId: string,
    target: string,
    checkoutRoot?: string,
  ) => Promise<void>;
  /** 最近打开清单（design D3）：已在 App 层滤掉分页列上开着的项目。 */
  recents: RecentEntry[];
  /** 自最近打开清单移除一笔（以 locator key）。 */
  onRemoveRecent: (key: string) => void;
  /** 服务器页入口：预选已登录 connection 并直达 scopes。 */
  initialConnectionId?: string | null;
  /** remote marker 未登录时：server 步骤预填 marker url。 */
  initialServerUrl?: string | null;
  /** 空状态「连接 Server」入口：直接起始于 Server 步骤。 */
  initialStep?: "server" | null;
  /** 既有 marker 缺工具选集：直达 checkout 步骤并预选此 scope。 */
  initialScope?: { projectKey: string; repoKey: string } | null;
  /** 既有 marker 缺工具选集：checkout 步骤预填此文件夹路径并自动 inspect。 */
  initialCheckoutPath?: string | null;
  /** 服务器页「缺省」卡选定的连接：Server 步骤预选（存在且已登录才预选，仍可改选）。 */
  defaultConnectionId?: string | null;
}

const STEP_NUMBER: Record<Step, number> = {
  source: 1,
  server: 2,
  scopes: 3,
  checkout: 4,
};

/** 第一步的来源卡（design D8）：点卡只选取，动作由页脚主要钮运行。 */
function ChoiceCard({
  icon,
  title,
  description,
  onClick,
  selected = false,
  disabled = false,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  selected?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "group flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
        // 停用为箭头且无 hover（desktop-app「可点元素的光标与 hover 回馈」）：hover 只在 enabled 时命中。
        selected ? "border-primary bg-primary/5" : "border-border enabled:hover:border-primary/50 enabled:hover:bg-muted/60",
        disabled && "cursor-default opacity-50",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
          selected && "bg-primary/12 text-primary",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}

/** 步骤 2–4 的整列单选列（design D8）：选中主色淡底、左侧圆点。 */
function RadioRow({
  checked,
  onClick,
  disabled = false,
  icon,
  title,
  description,
  trailing,
}: {
  checked: boolean;
  onClick: () => void;
  disabled?: boolean;
  icon?: React.ReactNode;
  title: string;
  description?: string;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
        checked ? "border-primary bg-primary/5" : "border-border enabled:hover:bg-muted/60",
        disabled && "cursor-default opacity-50",
      )}
    >
      <span
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          checked ? "border-primary" : "border-border",
        )}
      >
        {checked && <span className="h-2 w-2 rounded-full bg-primary" />}
      </span>
      {icon && <span className="shrink-0 text-muted-foreground">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{title}</span>
        {description && (
          <span className="block truncate text-xs text-muted-foreground">{description}</span>
        )}
      </span>
      {trailing}
    </button>
  );
}

/** chooser 与正式迁移共用的 membership scope 单选面。 */
export function ScopeSelection({
  scopes,
  selected,
  busy,
  onSelect,
}: {
  scopes: ScopesView | null;
  selected: ScopeChoice | null;
  busy: boolean;
  onSelect: (scope: ScopeChoice) => void;
}) {
  const { t } = useI18n();
  const repoCount =
    scopes?.projects.reduce((sum, project) => sum + project.repos.length, 0) ?? 0;
  return (
    <div className="flex max-h-[360px] flex-col gap-3 overflow-y-auto pr-1">
      {busy && (
        <p className="m-0 text-sm text-muted-foreground">{t("chooser.loadingScopes")}</p>
      )}
      {!busy && scopes && repoCount === 0 && (
        <p
          className="m-0 rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground"
          data-testid="scopes-empty"
        >
          {t("chooser.noMemberships")}
        </p>
      )}
      {scopes?.projects.map((project) =>
        project.repos.length > 0 ? (
          <section key={project.id} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3 px-1">
              <h3 className="m-0 text-sm font-semibold">{project.name}</h3>
              <span className="font-mono text-[11px] text-muted-foreground">
                {project.key}
              </span>
            </div>
            <div role="radiogroup" aria-label={project.name} className="flex flex-col gap-1.5">
              {project.repos.map((repo) => (
                <RadioRow
                  key={repo.id}
                  checked={selected?.project.id === project.id && selected.repo.id === repo.id}
                  onClick={() => onSelect({ project, repo })}
                  icon={<GitBranch className="h-3.5 w-3.5" />}
                  title={repo.name}
                  trailing={
                    <span className="ml-auto font-mono text-xs text-muted-foreground">{repo.key}</span>
                  }
                />
              ))}
            </div>
          </section>
        ) : null,
      )}
    </div>
  );
}

export function WorkspaceChooser({
  open,
  onOpenChange,
  connections,
  connectionAdapter,
  workspace,
  onOpenLocal,
  onRequestMigration,
  onAddServer,
  phases,
  onCancelLogin,
  onSubmitPat,
  onRefreshConnections,
  onOpenRemote,
  recents,
  onRemoveRecent,
  initialConnectionId = null,
  initialServerUrl = null,
  initialStep = null,
  initialScope = null,
  initialCheckoutPath = null,
  defaultConnectionId = null,
}: WorkspaceChooserProps) {
  const { t } = useI18n();
  const [step, setStep] = useState<Step>("source");
  const [connection, setConnection] = useState<ConnectionView | null>(null);
  const [scopes, setScopes] = useState<ScopesView | null>(null);
  const [scope, setScope] = useState<ScopeChoice | null>(null);
  const [checkoutMode, setCheckoutMode] = useState<"skip" | "folder" | null>(null);
  const [checkoutRoot, setCheckoutRoot] = useState<string | null>(null);
  // folder mode 的 built-in 工具选集：inspect 回传既有选集作为初值，打开时交给 bind。
  const [checkoutTools, setCheckoutTools] = useState<string[]>([]);
  const [serverUrl, setServerUrl] = useState("");
  const [serverName, setServerName] = useState("");
  const [showAddServer, setShowAddServer] = useState(false);
  /** 刚从本面发起登录的连接 origin（addConnection 回传）；其交互状态就地渲染。 */
  const [pendingOrigin, setPendingOrigin] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [localProject, setLocalProject] = useState<{ root: string; name: string } | null>(null);
  /** 第一步选取的来源卡（design D8）：未选时页脚主要钮停用。 */
  const [source, setSource] = useState<"local" | "server" | null>(null);
  /** 最近打开列（design D4）：错误态只活在本面，chooser 重开即清空。 */
  const recent = useRecentOpener({
    workspace,
    connections,
    connectionAdapter,
    onRefreshConnections,
    onOpenLocal,
    onOpenRemote,
    onLocalProbed: () => onOpenChange(false),
  });

  async function selectConnection(selected: ConnectionView) {
    setConnection(selected);
    setStep("scopes");
    setScope(null);
    setScopes(null);
    setError(null);
    setBusy(true);
    try {
      setScopes(await connectionAdapter.scopes(selected.id));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // 既有 marker 缺工具选集的入口：加载 scopes、依 key 预选 scope、直达 checkout
  // 步骤并以预填 path inspect（显示既有选集），让用户明示选择 Claude／Codex／Copilot／Pi／Cursor。
  async function startAtCheckout(
    selected: ConnectionView,
    scopeKeys: { projectKey: string; repoKey: string },
    path: string,
  ) {
    setConnection(selected);
    setScope(null);
    setScopes(null);
    setError(null);
    setBusy(true);
    try {
      const loaded = await connectionAdapter.scopes(selected.id);
      setScopes(loaded);
      const project = loaded.projects.find((p) => p.key === scopeKeys.projectKey);
      const repo = project?.repos.find((r) => r.key === scopeKeys.repoKey);
      if (!project || !repo) {
        setStep("scopes");
        return;
      }
      setScope({ project, repo });
      setStep("checkout");
      const inspection = await connectionAdapter.inspectCheckout(
        path,
        selected.origin,
        project.key,
        repo.key,
      );
      setCheckoutMode("folder");
      setCheckoutRoot(inspection.root);
      setCheckoutTools(inspection.tools);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  /** 服务器页「缺省」卡的连接：存在且已登录才预选，否则不预选。 */
  const preferredConnection = () => defaultConnectionOf(connections, defaultConnectionId);

  useEffect(() => {
    if (!open) return;
    recent.reset();
    setConnection(null);
    setScopes(null);
    setScope(null);
    setCheckoutMode(null);
    setCheckoutRoot(null);
    setCheckoutTools([]);
    setServerUrl(initialServerUrl ?? "");
    setServerName("");
    setShowAddServer(Boolean(initialServerUrl));
    setBusy(false);
    setError(null);
    setNotice(null);
    setLocalProject(null);
    setSource(null);
    const selected = initialConnectionId
      ? connections.find((entry) => entry.id === initialConnectionId && entry.loggedIn)
      : undefined;
    if (selected && initialScope && initialCheckoutPath) {
      void startAtCheckout(selected, initialScope, initialCheckoutPath);
    } else if (selected) {
      void selectConnection(selected);
    } else {
      const nextStep = initialStep ?? (initialConnectionId || initialServerUrl ? "server" : "source");
      // 入口意图（指定连接、marker 指向的服务器）优先：此时预选缺省连接会把项目绑到别台服务器。
      if (nextStep === "server" && !initialConnectionId && !initialServerUrl) setConnection(preferredConnection());
      setStep(nextStep);
    }
    // 打开时只消费当次入口意图；连接清单更新不得把进行中的 chooser 重设。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialConnectionId, initialServerUrl, initialStep]);

  async function chooseLocal() {
    setBusy(true);
    setError(null);
    try {
      const picked = await workspace.pickFolder();
      if (!picked) return;
      const probe = await workspace.openProject(picked);
      if (probe.status === "project") {
        setLocalProject({ root: probe.root, name: probe.name });
        return;
      }
      onOpenChange(false);
      await onOpenLocal(picked);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function openLocal(root: string) {
    onOpenChange(false);
    await onOpenLocal(root);
  }

  function openRecent(entry: RecentEntry) {
    setError(null);
    void recent.open(entry);
  }

  async function migrateLocal(root: string) {
    if (!onRequestMigration) return;
    setBusy(true);
    setError(null);
    try {
      await onRequestMigration(root);
      onOpenChange(false);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  /** 刚发起登录的连接交互状态；等待授权／PAT／错误据此就地渲染。 */
  const pendingPhase = pendingOrigin ? phases[pendingOrigin] : undefined;

  async function addServer() {
    const url = serverUrl.trim();
    if (!url) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const origin = await onAddServer(url, serverName.trim() || url);
      await recent.refreshConnections();
      setServerName("");
      setPendingOrigin(origin ?? null);
      setNotice(t("chooser.serverAdded"));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // 先检查阶段（零写入）：选好文件夹后 inspect 验证 marker 一致性，成功才显示
  // 工具 checkbox 并以既有选集预选。失败保留在 checkout 步骤显示错误、不写入。
  async function chooseCheckoutFolder() {
    if (!connection || !scope) return;
    const picked = await workspace.pickFolder();
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const inspection = await connectionAdapter.inspectCheckout(
        picked,
        connection.origin,
        scope.project.key,
        scope.repo.key,
      );
      setCheckoutMode("folder");
      setCheckoutRoot(inspection.root);
      setCheckoutTools(inspection.tools);
    } catch (e) {
      setCheckoutMode(null);
      setCheckoutRoot(null);
      setCheckoutTools([]);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggleCheckoutTool(tool: string, on: boolean) {
    setCheckoutTools((prev) =>
      on ? [...prev.filter((t) => t !== tool), tool] : prev.filter((t) => t !== tool),
    );
  }

  // 打开：skip 直接 handshake；folder mode 先同步受管产物（bind），全部成功才
  // openRemote 带 checkoutRoot——同步任一步失败保留步骤与选集供重试，不开分页。
  async function openRemote() {
    if (!connection || !scope || checkoutMode === null) return;
    if (checkoutMode === "folder" && (checkoutTools.length === 0 || !checkoutRoot)) return;
    setBusy(true);
    setError(null);
    try {
      let checkoutTarget: string | undefined;
      if (checkoutMode === "folder") {
        await connectionAdapter.bindCheckout(
          checkoutRoot!,
          connection.origin,
          scope.project.key,
          scope.repo.key,
          checkoutTools,
        );
        checkoutTarget = checkoutRoot!;
      }
      await onOpenRemote(
        connection.id,
        `${scope.project.key}/${scope.repo.key}`,
        checkoutTarget,
      );
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function back() {
    setError(null);
    if (step === "server") setStep("source");
    else if (step === "scopes") setStep("server");
    else if (step === "checkout") setStep("scopes");
  }

  const loggedInConnections = connections.filter((entry) => entry.loggedIn);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-xl gap-4 p-5" data-testid="workspace-chooser">
        <AlertDialogHeader>
          <StepProgress current={STEP_NUMBER[step]} total={4} />
          <AlertDialogTitle className="text-[15px] font-medium">{t(`chooser.${step}Title`)}</AlertDialogTitle>
          <AlertDialogDescription>{t(`chooser.${step}Desc`)}</AlertDialogDescription>
        </AlertDialogHeader>

        {step === "source" && !localProject && (
          <div className="grid gap-2 sm:grid-cols-2">
            <ChoiceCard
              icon={<Folder className="h-4 w-4" />}
              title={t("chooser.local")}
              description={t("chooser.localDesc")}
              selected={source === "local"}
              disabled={busy || recent.busy}
              onClick={() => setSource("local")}
            />
            <ChoiceCard
              icon={<Cloud className="h-4 w-4" />}
              title={t("chooser.server")}
              description={t("chooser.serverSourceDesc")}
              selected={source === "server"}
              onClick={() => setSource("server")}
            />
          </div>
        )}

        {step === "source" && !localProject && (
          <RecentList
            variant="dialog"
            entries={recents}
            connections={connections}
            connectionsReady={recent.connectionsReady}
            errors={recent.errors}
            busy={busy || recent.busy}
            onOpen={openRecent}
            onRemove={(entry) => onRemoveRecent(locatorKey(entry.locator))}
          />
        )}

        {step === "source" && localProject && (
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-border bg-muted/25 p-3">
              <p className="m-0 text-sm font-semibold">{localProject.name}</p>
              <p className="mt-1 mb-0 break-all font-mono text-xs text-muted-foreground">
                {localProject.root}
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                type="button"
                className="sm:flex-1"
                onClick={() => void openLocal(localProject.root)}
              >
                {t("chooser.openLocal")}
              </Button>
              {onRequestMigration && (
                <Button
                  type="button"
                  variant="outline"
                  className="sm:flex-1"
                  disabled={busy}
                  onClick={() => void migrateLocal(localProject.root)}
                >
                  {t("chooser.migrateToServer")}
                </Button>
              )}
            </div>
          </div>
        )}

        {step === "server" && (
          <div className="flex max-h-[360px] flex-col gap-3 overflow-y-auto pr-1">
            {loggedInConnections.length === 0 ? (
              <p className="m-0 rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
                {t("chooser.noLoggedInServers")}
              </p>
            ) : (
              <div role="radiogroup" aria-label={t("chooser.serverTitle")} className="flex flex-col gap-1.5">
                {loggedInConnections.map((entry) => (
                  <RadioRow
                    key={entry.id}
                    checked={connection?.id === entry.id}
                    icon={<Server className="h-4 w-4" />}
                    title={entry.name}
                    description={`${entry.origin}${entry.lastActorDisplay ? ` · ${entry.lastActorDisplay}` : ""}`}
                    onClick={() => void selectConnection(entry)}
                  />
                ))}
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start gap-1.5"
              onClick={() => setShowAddServer((shown) => !shown)}
            >
              <Plus className="h-3.5 w-3.5" /> {t("chooser.addServer")}
            </Button>
            {showAddServer && (
              <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
                <Input
                  aria-label={t("servers.urlPlaceholder")}
                  placeholder={t("servers.urlPlaceholder")}
                  value={serverUrl}
                  onChange={(event) => setServerUrl(event.target.value)}
                />
                <Input
                  aria-label={t("servers.namePlaceholder")}
                  placeholder={t("servers.namePlaceholder")}
                  value={serverName}
                  onChange={(event) => setServerName(event.target.value)}
                />
                <Button type="button" size="sm" disabled={busy} onClick={() => void addServer()}>
                  {t("chooser.addAndLogin")}
                </Button>
              </div>
            )}
            {/* 登录回馈跟着发起登录的接口走（design 决策三）：等待授权面／PAT
                输入／错误就地渲染，不要求用户切到设置页才看得到状态。 */}
            {pendingOrigin &&
              (pendingPhase?.kind === "awaitingApproval" || pendingPhase?.kind === "awaitingBrowser") && (
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <LoginWaiting
                    origin={pendingOrigin}
                    phase={pendingPhase}
                    onCancel={() => {
                      onCancelLogin(pendingOrigin);
                      setPendingOrigin(null);
                      setNotice(null);
                    }}
                  />
                </div>
              )}
            {pendingOrigin && pendingPhase?.kind === "patInput" && (
              <div
                className="rounded-lg border border-border bg-muted/30 p-3"
                data-testid={`pat-input-${pendingOrigin}`}
              >
                <PatLoginInput
                  error={pendingPhase.error}
                  onSubmit={(pat) => onSubmitPat(pendingOrigin, pat)}
                />
              </div>
            )}
            {pendingPhase?.kind === "busy" && (
              <p className="m-0 text-xs text-muted-foreground">{t("servers.busy")}</p>
            )}
            {pendingPhase?.kind === "error" && (
              <p role="alert" className="m-0 text-xs text-destructive">
                {pendingPhase.message}
              </p>
            )}
          </div>
        )}

        {step === "scopes" && (
          <ScopeSelection scopes={scopes} selected={scope} busy={busy} onSelect={setScope} />
        )}

        {step === "checkout" && scope && (
          <div role="radiogroup" aria-label={t("chooser.checkoutTitle")} className="flex flex-col gap-1.5">
            <RadioRow
              icon={<Cloud className="h-4 w-4" />}
              title={t("chooser.skipCheckout")}
              description={t("chooser.skipCheckoutDesc")}
              checked={checkoutMode === "skip"}
              onClick={() => {
                setCheckoutMode("skip");
                setCheckoutRoot(null);
                setCheckoutTools([]);
                setError(null);
              }}
            />
            <RadioRow
              icon={<Folder className="h-4 w-4" />}
              title={t("chooser.connectCheckout")}
              description={checkoutRoot ?? t("chooser.connectCheckoutDesc")}
              checked={checkoutMode === "folder"}
              disabled={busy}
              onClick={() => void chooseCheckoutFolder()}
            />
            {checkoutMode === "folder" && checkoutRoot && (
              <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
                <span className="text-sm font-medium">{t("chooser.checkoutTools")}</span>
                <div className="flex gap-4">
                  {BUILTIN_TOOLS.map((tool) => (
                    <label
                      key={tool}
                      htmlFor={`checkout-tool-${tool}`}
                      className="flex items-center gap-1.5 text-sm"
                    >
                      <Checkbox
                        id={`checkout-tool-${tool}`}
                        aria-label={tool}
                        checked={checkoutTools.includes(tool)}
                        disabled={busy}
                        onCheckedChange={(v) => toggleCheckoutTool(tool, v === true)}
                      />
                      {tool}
                    </label>
                  ))}
                </div>
                <span className="text-xs leading-5 text-muted-foreground">
                  {t("chooser.checkoutToolsHelp")}
                </span>
              </div>
            )}
          </div>
        )}

        {(error || (notice && (!pendingPhase || pendingPhase.kind === "idle"))) && (
          <p
            role={error ? "alert" : "status"}
            className={cn(
              "m-0 rounded-md px-3 py-2 text-xs",
              error
                ? "bg-destructive/10 text-destructive"
                : "bg-muted text-muted-foreground",
            )}
          >
            {error ?? notice}
          </p>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
          <div>
            {step !== "source" && (
              <Button type="button" variant="ghost" size="sm" className="gap-1" onClick={back}>
                <ArrowLeft className="h-3.5 w-3.5" /> {t("chooser.back")}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t("app.cancel")}
            </Button>
            {step === "source" && !localProject && (
              <Button
                type="button"
                size="sm"
                disabled={source === null || busy || recent.busy}
                onClick={() => {
                  if (source === "local") return void chooseLocal();
                  setConnection(preferredConnection());
                  setStep("server");
                }}
              >
                {t(
                  source === "local"
                    ? "chooser.chooseFolder"
                    : source === "server"
                      ? "chooser.next"
                      : "chooser.selectSource",
                )}
              </Button>
            )}
            {/* 预选的连接（服务器页「缺省」卡）可直接前进；点其他列即改选并前进。 */}
            {step === "server" && connection && (
              <Button type="button" size="sm" disabled={busy} onClick={() => void selectConnection(connection)}>
                {t("chooser.next")}
              </Button>
            )}
            {step === "scopes" && (
              <Button
                type="button"
                size="sm"
                disabled={!scope || busy}
                onClick={() => {
                  setCheckoutMode(null);
                  setCheckoutRoot(null);
                  setStep("checkout");
                }}
              >
                {t("chooser.next")}
              </Button>
            )}
            {step === "checkout" && (
              <Button
                type="button"
                size="sm"
                disabled={
                  checkoutMode === null ||
                  busy ||
                  (checkoutMode === "folder" && checkoutTools.length === 0)
                }
                onClick={() => void openRemote()}
              >
                {t("chooser.open")}
              </Button>
            )}
          </div>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

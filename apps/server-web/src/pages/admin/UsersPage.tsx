import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Mail, UserPlus, X } from "lucide-react";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ListCard,
  ListPager,
  ListRow,
  SearchField,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsRow,
  StatusPill,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
  useI18n,
  usePaging,
  PageHeader,
} from "@specseal/ui";
import { useClient } from "../../app/context";
import { useAsync, useLastData } from "../../lib/useAsync";
import { useListScroll } from "../../lib/useListScroll";
import { useNarrow } from "../../lib/useMediaQuery";
import { userLabel } from "../../lib/userLabel";
import { fmtDate } from "../../lib/fmtDate";
import { Field } from "../../components/Field";
import {
  FormDialog,
  FormDialogActions,
  FormMessage,
  SecretDone,
  useDialogSubmit,
} from "../../components/FormDialog";
import { FilterSelect } from "../../components/FilterSelect";
import { NoMatchState } from "../../components/NoMatchState";
import { SectionRoutes } from "./detail";
import { AdminError, AdminLoading } from "./states";
import { UserDetailPage } from "./UserDetailPage";
import type { AdminPendingInvitation, AdminProject, AdminUser } from "../../api/client";

// 用户区段（server-web-console「管理列表以详情页与对话框承载查看与创建」「用户页呈现尚未接受的
// 邀请」；server-web-list-pages design D2–D4；server-web-detail-pages design D1）：`/admin/users` 是
// 列表、`/admin/users/<id>` 是详情页。数据与列表状态（搜索、状态筛选、页码）放在区段——两者切换时
// 区段不卸载，回列表时状态原样，详情页的 ‹ n / m › 也依列表目前呈现的顺序。列表页标题区右侧是搜索、
// 状态筛选与邀请；其下一张列表卡，卡顶「用户｜邀请中」两个分页（分页状态在网址 ?tab=pending），
// 卡底共用换页列（前端换页）。用户列整列可点进详情页、列内不含输入控制项；邀请由页面唯一 primary
// action 打开。撤回邀请等破坏性动作维持确认框确认（确认钮为红系）。

type Confirm = { title: string; body: string; action: string; run: () => Promise<void> };

/** 邀请对话框的项目挑选器固定停在这个值；它对不到任何选项，所以 trigger 显示 placeholder。 */
const PICKER = "__picker__";

export function UsersSection() {
  const { t } = useI18n();
  const client = useClient();
  const navigate = useNavigate();
  const narrow = useNarrow();
  const { data: fresh, error, reload } = useAsync(() => client.getAdminUsers(), []);
  // useAsync 重抓时会先清空 data：留着上一份成功回应继续渲染，详情页的变更（改角色、撤销）
  // 重载时详情页才不会卸载重挂、跳回第一个分页（design D1）。只有第一次加载显示加载中。
  const data = useLastData(fresh, error);
  // 成员资格的项目选项来自 registry（项目代号为封闭集合，不开放自由输入）；还没加载时为 null。
  const registry = useAsync(() => client.getAdminRegistry(), []);
  const projects = registry.data?.projects ?? null;
  const [searchParams, setSearchParams] = useSearchParams();
  // 其他值或缺席都是用户分页。
  const tab = searchParams.get("tab") === "pending" ? "pending" : "users";
  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const { scrollRef, scrollToTop } = useListScroll();
  const needle = q.trim().toLowerCase();
  const matches = (...fields: string[]) =>
    needle === "" || fields.some((field) => field.toLowerCase().includes(needle));
  const visible = (data?.users ?? []).filter(
    (u) => (status === "" || (status === "active" ? u.active : !u.active)) && matches(u.display, u.email),
  );
  const visiblePending = (data?.pending ?? []).filter((i) => matches(i.email, i.display));
  const users = usePaging(visible, { onMove: scrollToTop });
  const pending = usePaging(visiblePending, { onMove: scrollToTop });

  // 搜索、筛选与切分页都回到第 1 页。
  function firstPage() {
    users.setPage(1);
    pending.setPage(1);
  }

  // 分页写进网址但不添加浏览纪录：上一页不会在两个分页间来回。
  function switchTab(next: string) {
    setSearchParams(next === "pending" ? { tab: "pending" } : {}, { replace: true });
    firstPage();
    scrollToTop();
  }

  async function runConfirmed() {
    if (!confirm || busy) return;
    setBusy(true);
    try {
      await confirm.run();
    } finally {
      setBusy(false);
      setConfirm(null);
      reload();
    }
  }

  const list = (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader
        level={1}
        title={t("users.title")}
        description={t("users.description")}
        actions={
          <>
            <SearchField
              label={t("common.search")}
              placeholder={t("users.searchPlaceholder")}
              value={q}
              onChange={(value) => {
                setQ(value);
                firstPage();
              }}
            />
            {tab === "users" && (
              <FilterSelect
                label={t("field.status")}
                allLabel={t("field.allStatuses")}
                value={status}
                onChange={(value) => {
                  setStatus(value);
                  firstPage();
                }}
              >
                <SelectItem value="active">{t("common.active")}</SelectItem>
                <SelectItem value="suspended">{t("common.suspended")}</SelectItem>
              </FilterSelect>
            )}
            <Button
              type="button"
              data-tour="list-primary"
              className="gap-1.5"
              onClick={() => setInviteOpen(true)}
            >
              <UserPlus aria-hidden="true" className="h-4 w-4" />
              {t("users.invite")}
            </Button>
          </>
        }
      />

      {!data && error == null && <AdminLoading />}
      {error != null && <AdminError onRetry={reload} />}
      {data && (
        <Tabs value={tab} onValueChange={switchTab} className="flex min-h-0 flex-1 flex-col">
          <ListCard
            scrollRef={scrollRef}
            header={
              // 计数是未经搜索与筛选的总数。
              <TabsList variant="card">
                <TabsTrigger value="users" count={data.users.length}>
                  {t("users.tabUsers")}
                </TabsTrigger>
                <TabsTrigger value="pending" count={data.pending.length}>
                  {t("users.pendingTitle")}
                </TabsTrigger>
              </TabsList>
            }
            footer={
              tab === "users" ? (
                <ListPager key="users" compact={narrow} {...users.pager} />
              ) : (
                <ListPager key="pending" compact={narrow} {...pending.pager} />
              )
            }
          >
            <TabsContent value="users">
              {visible.length === 0 ? (
                <NoMatchState />
              ) : (
                users.pageItems.map((u) => (
                  <UserRow
                    key={u.id}
                    user={u}
                    narrow={narrow}
                    onOpen={() => navigate(`/admin/users/${u.id}`)}
                  />
                ))
              )}
            </TabsContent>
            <TabsContent value="pending">
              {data.pending.length === 0 ? (
                <EmptyState icon={Mail} title={t("users.pendingEmpty")} description={t("users.pendingHint")} />
              ) : visiblePending.length === 0 ? (
                <NoMatchState />
              ) : (
                <>
                  <p className="border-b border-border/70 px-4 py-3 text-[13px] text-muted-foreground">
                    {t("users.pendingHint")}
                  </p>
                  {pending.pageItems.map((i) => (
                    <PendingRow
                      key={i.id}
                      invitation={i}
                      busy={busy}
                      onRevoke={() =>
                        setConfirm({
                          title: t("users.revokeInviteTitle").replace("{email}", i.email),
                          body: t("users.revokeInviteBody"),
                          action: t("users.revokeInvite"),
                          run: () => client.adminRevokeInvitation(i.id),
                        })
                      }
                    />
                  ))}
                </>
              )}
            </TabsContent>
          </ListCard>
        </Tabs>
      )}

      {/* 只在开着时挂载：每次打开都是空白表单。 */}
      {inviteOpen && <InviteDialog projects={projects} onClose={() => setInviteOpen(false)} onCreated={reload} />}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm?.title ?? ""}
        description={confirm?.body}
        confirmLabel={confirm?.action ?? ""}
        destructive
        busy={busy}
        onConfirm={runConfirmed}
      />
    </div>
  );

  return (
    <SectionRoutes
      base="/admin/users"
      param="id"
      list={list}
      detail={data && <UserDetailPage users={data.users} sequence={visible} projects={projects} reload={reload} />}
      error={error}
      onRetry={reload}
    />
  );
}

/** 受邀者要开的链接；token 只在创建当下拿得到，网址在前端拼。 */
function inviteUrl(token: string): string {
  return `${window.location.origin}/invite/${token}`;
}

/** 用户列（design D4）：头像字、名称与 email、管理员签、状态签、所属项目数；窄屏幕把管理员
 *  并入 email 那一行、meta 只留状态签。整列可点进详情页。 */
function UserRow({ user, narrow, onOpen }: { user: AdminUser; narrow: boolean; onOpen: () => void }) {
  const { t, tn } = useI18n();
  const name = userLabel(user);
  const adminLabel = t("users.roleAdmin");
  const statusPill = (
    <StatusPill tone={user.active ? "success" : "warning"}>
      {user.active ? t("common.active") : t("common.suspended")}
    </StatusPill>
  );
  const projectCount = user.memberships.length;
  return (
    <ListRow
      data-user={user.id}
      mono={false}
      leading={
        <span
          data-avatar
          aria-hidden="true"
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium",
            user.active ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground",
          )}
        >
          {Array.from(name)[0]}
        </span>
      }
      title={name}
      description={narrow && user.admin ? `${user.email} · ${adminLabel}` : user.email}
      meta={
        narrow ? (
          statusPill
        ) : (
          <>
            {user.admin && <StatusPill tone="neutral">{adminLabel}</StatusPill>}
            {statusPill}
            <span className="tabular-nums">
              {projectCount === 0
                ? t("users.noProjectsShort")
                : tn("users.projectCount", projectCount)}
            </span>
          </>
        )
      }
      onClick={onOpen}
    />
  );
}

// 待激活邀请列：受邀者接受前没有 user row，不能被停权、没有凭证也没有细节可看，所以是静态列；
// 标示到期日，管理员才知道哪一笔快失效。撤回恒常显示（破坏性动作，确认框指名受邀者）。
function PendingRow({
  invitation: i,
  busy,
  onRevoke,
}: {
  invitation: AdminPendingInvitation;
  busy: boolean;
  onRevoke: () => void;
}) {
  const { t } = useI18n();
  const role = i.admin ? t("users.roleAdmin") : t("users.roleMember");
  const meta = (i.memberships.length > 0 ? t("users.pendingMetaProjects") : t("users.pendingMeta"))
    .replace("{display}", () => i.display)
    .replace("{role}", role)
    .replace("{projects}", () => i.memberships.join("、"));
  return (
    <ListRow
      data-invite={i.id}
      leading={
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Mail aria-hidden="true" className="h-3.5 w-3.5" />
        </span>
      }
      title={i.email}
      description={meta}
      meta={
        <span className="tabular-nums">
          {t("users.pendingExpires").replace("{date}", fmtDate(i.expiresAt, t("common.dash")))}
        </span>
      }
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={t("users.revokeInviteFor").replace("{email}", i.email)}
          disabled={busy}
          onClick={onRevoke}
        >
          {t("users.revokeInvite")}
        </Button>
      }
    />
  );
}

// 邀请对话框（design D7）：送出成功后同一个对话框换成已创建状态，一次性的邀请链接（token 进入 URL
// 成为链接）只在这里出现、关掉就看不到；成功当下即重载，邀请中分页的计数随之加一。提交失败保持打开
// 并保留非秘密输入，错误置于对应字段附近。
function InviteDialog({
  projects,
  onClose,
  onCreated,
}: {
  /** registry 的项目；还没加载（或加载失败）时为 null。 */
  projects: AdminProject[] | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const client = useClient();
  const [email, setEmail] = useState("");
  const [display, setDisplay] = useState("");
  const [memberships, setMemberships] = useState<string[]>([]);
  const [admin, setAdmin] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const { pending, message, fieldErrors, submit } = useDialogSubmit(t("users.inviteError"));

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit(async () => {
      const created = await client.adminInvite({ email, display, memberships, admin });
      setToken(created.token);
      onCreated();
    });
  }

  if (token) {
    return (
      <FormDialog
        open
        onOpenChange={(open) => !open && onClose()}
        title={t("users.inviteDoneTitle")}
        description={t("users.inviteDoneBody").replace("{email}", () => email)}
        done
      >
        {/* 给受邀者的是可直接打开的链接，不是要他自己拼网址的 token。 */}
        <SecretDone
          value={inviteUrl(token)}
          copyLabel={t("users.copyLink")}
          note={t("users.inviteDoneNote")}
          onDone={onClose}
        />
      </FormDialog>
    );
  }

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("users.invite")}
      description={t("users.inviteHint")}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field
          id="invite-email"
          label={t("field.email")}
          value={email}
          onChange={setEmail}
          error={fieldErrors.email}
        />
        <Field
          id="invite-display"
          label={t("field.display")}
          value={display}
          onChange={setDisplay}
          error={fieldErrors.display}
        />
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("users.inviteJoinProjects")}</legend>
          {/* 以下拉挑选再逐一移除，而不是每个项目一列勾选框：项目数量会成长，一整栏
              勾选框在十来个项目之后就不可用了。已选的项目不再出现在可选项里。 */}
          {projects === null || projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t(projects === null ? "users.projectsNotLoaded" : "users.inviteNoProjects")}
            </p>
          ) : (
            <>
              {/* 纯挑选器，不持有选中值：value 固定绑在一个对不到任何选项的哨符上，
                  所以 trigger 永远显示 placeholder，而每次挑选都算一次值变动（同一个
                  项目移除后可以再加回来）。 */}
              <Select value={PICKER} onValueChange={(key) => setMemberships((prev) => [...prev, key])}>
                <SelectTrigger id="invite-memberships" aria-label={t("users.inviteJoinProjects")}>
                  <SelectValue placeholder={t("users.pickProject")} />
                </SelectTrigger>
                <SelectContent>
                  {projects
                    .filter((p) => !memberships.includes(p.key))
                    .map((p) => (
                      <SelectItem key={p.key} value={p.key}>
                        {p.name === p.key ? p.key : `${p.name}（${p.key}）`}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {memberships.length > 0 && (
                <ul className="divide-y divide-border rounded-xl border border-border">
                  {memberships.map((key) => (
                    <li key={key} className="flex items-center gap-2 py-1.5 pl-3 pr-1.5">
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {projects.find((p) => p.key === key)?.name ?? key}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">{key}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("users.removeFromInvite").replace("{project}", key)}
                        onClick={() => setMemberships((prev) => prev.filter((k) => k !== key))}
                      >
                        <X aria-hidden="true" className="h-4 w-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {fieldErrors.memberships && (
            <p role="alert" className="text-sm text-destructive">
              {fieldErrors.memberships}
            </p>
          )}
        </fieldset>
        {/* 管理员开关与用户详情页同一个设置型列，框起来与上方的已选项目清单同一种外框。 */}
        <div className="rounded-xl border border-border">
          <SettingsRow
            label={t("users.roleAdmin")}
            htmlFor="invite-admin"
            description={t("users.adminHint")}
            control={
              // 按钮的名称 axe 只认 aria-*，不认 <label for>。
              <Switch id="invite-admin" aria-label={t("users.roleAdmin")} checked={admin} onCheckedChange={setAdmin} />
            }
          />
        </div>
        <FormMessage message={message} fieldErrors={fieldErrors} />
        <FormDialogActions
          submitLabel={pending ? t("common.submitting") : t("users.inviteSubmit")}
          pending={pending}
          onCancel={onClose}
        />
      </form>
    </FormDialog>
  );
}

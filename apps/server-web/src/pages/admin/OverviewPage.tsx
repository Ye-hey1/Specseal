import { Link, useSearchParams } from "react-router-dom";
import { Activity, CircleAlert, History, Rocket } from "lucide-react";
import {
  Button,
  CopyButton,
  DocTiles,
  SettingsCard,
  SettingsRow,
  StatusPill,
  useI18n,
  PageHeader,
} from "@specseal/ui";
import { useClient } from "../../app/context";
import { CardNote } from "../../components/CardNote";
import { useAsync } from "../../lib/useAsync";
import { auditLabel } from "../../lib/auditLabel";
import { AdminError, AdminLoading } from "./states";
import type { AdminConnection, AdminTodo } from "../../api/client";

// 管理总览（server-web-console「总览提供可行动入口与待办」；server-web-list-pages design D10）：
// 768px 置中栏；顶端四格数字砖（与 desktop 阅读卡同款），其下需要处理、系统健康与最近活动三张
// 设置型卡。数字是入口而非装饰——看到数字的下一步一定是去某一页做事，所以每格都可点。没有
// 待处理事项时整张卡不渲染，不留空标题与空清单。
//
// setup 完成后 Server 导向 `/admin?welcome=1`，此页承接连接信息的呈现
// （server-setup「完成 setup 即可邀请与连接」）；Store 降级状态亦于此明示
// （server-admin「Store 不健康时 identity 管理仍可用」）。

/** 用户页的邀请中分页：待激活数字砖与「查看邀请」待办都直接开到这里。 */
const PENDING_INVITATIONS = "/admin/users?tab=pending";

/** 卡片标头右端的入口链接。 */
const ASIDE_LINK_CLS =
  "rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function OverviewPage() {
  const { t, tn } = useI18n();
  const client = useClient();
  const [params] = useSearchParams();
  const welcome = params.get("welcome") === "1";
  const { loading, data, error, reload } = useAsync(() => client.getAdminOverview(), []);
  const tile = (label: string, hint: string) => `${t(label)} · ${hint}`;

  return (
    <div className="mx-auto flex w-full max-w-[768px] flex-col gap-6">
      <PageHeader level={1} title={t("overview.title")} description={t("overview.description")} />
      {loading && <AdminLoading />}
      {error != null && <AdminError onRetry={reload} />}
      {data && (
        <>
          {welcome && data.connection && <WelcomeConnection connection={data.connection} />}
          {!data.storeHealthy && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm"
            >
              <p className="font-medium">{t("overview.storeDownTitle")}</p>
              <p className="mt-1 text-muted-foreground">{t("overview.storeDownBody")}</p>
              {data.storeHealthError && (
                <p className="mt-1 break-all font-mono text-xs">{data.storeHealthError}</p>
              )}
            </div>
          )}

          <DocTiles
            tiles={[
              {
                value: data.activeUsers,
                label: tile("overview.metricUsers", t("overview.metricUsersHint").replace("{n}", String(data.suspendedUsers))),
                link: <Link to="/admin/users" />,
              },
              {
                value: data.projects,
                label: tile("overview.metricProjects", tn("overview.metricProjectsHint", data.repos)),
                link: <Link to="/admin/registry" />,
              },
              {
                value: data.activeCredentials,
                label: tile("overview.metricCredentials", t("overview.metricCredentialsHint")),
                link: <Link to="/admin/credentials" />,
              },
              {
                value: data.pendingInvitations,
                label: tile("overview.metricPending", t("overview.metricPendingHint")),
                link: <Link to={PENDING_INVITATIONS} />,
              },
            ]}
          />

          {data.todos.length > 0 && (
            <SettingsCard title={t("overview.todos")} icon={<CircleAlert />}>
              {data.todos.map((todo) => (
                <TodoRow key={todo.kind} todo={todo} />
              ))}
            </SettingsCard>
          )}

          <SettingsCard
            title={t("overview.health")}
            icon={<Activity />}
            aside={
              <Link to="/admin/system" className={ASIDE_LINK_CLS}>
                {t("nav.system")} ›
              </Link>
            }
          >
            <SettingsRow
              label={t("overview.storeRow")}
              description={data.storeHealthy ? undefined : data.storeHealthError}
              control={
                <StatusPill tone={data.storeHealthy ? "success" : "destructive"}>
                  {data.storeHealthy ? t("common.normal") : t("common.abnormal")}
                </StatusPill>
              }
            />
            <SettingsRow
              label={t("overview.schemaRow")}
              control={<span className="font-mono text-[13px]">v{data.identitySchemaVersion}</span>}
            />
          </SettingsCard>

          <SettingsCard
            title={t("overview.recent")}
            icon={<History />}
            aside={
              <Link to="/admin/audit" className={ASIDE_LINK_CLS}>
                {t("overview.recentAll")} ›
              </Link>
            }
          >
            {data.recentAudit.length === 0 ? (
              <CardNote>{t("overview.recentEmpty")}</CardNote>
            ) : (
              data.recentAudit.map((e) => (
                <SettingsRow
                  key={e.id}
                  label={`${auditLabel(t, "action", e.action)} ${e.subject}`}
                  description={`${e.createdAt.slice(0, 10)} · ${e.actorId}`}
                  control={null}
                />
              ))
            )}
          </SettingsCard>
        </>
      )}
    </div>
  );
}

// 待办的文案留在前端：wire 上只有封闭集合的 kind 与目的地，消息与行动名称由此对应。
const TODO_KEYS: Record<string, { message: string; action: string }> = {
  "no-active-credentials": {
    message: "overview.todoNoCredentials",
    action: "overview.todoNoCredentialsAction",
  },
  "pending-invitations": {
    message: "overview.todoPendingInvitations",
    action: "overview.todoPendingInvitationsAction",
  },
};

function TodoRow({ todo }: { todo: AdminTodo }) {
  const { t, tn } = useI18n();
  const keys = TODO_KEYS[todo.kind];
  // 待接受邀请直接开到邀请中分页；其他待办照服务器给的目的地。
  const to = todo.kind === "pending-invitations" ? PENDING_INVITATIONS : todo.destination;
  return (
    <SettingsRow
      label={keys ? tn(keys.message, todo.count) : todo.kind}
      control={
        <Button asChild variant="outline" size="sm">
          <Link to={to}>{keys ? t(keys.action) : t("overview.todoGo")}</Link>
        </Button>
      }
    />
  );
}

// setup 完成后的开箱信息：三个要素各自可拷贝，并指出下一步是邀请成员。
function WelcomeConnection({ connection }: { connection: AdminConnection }) {
  const { t } = useI18n();
  return (
    <SettingsCard title={t("overview.welcomeTitle")} icon={<Rocket />}>
      <CardNote>{t("overview.welcomeBody")}</CardNote>
      <CopyRow label={t("overview.welcomeUrl")} value={connection.publicUrl} />
      <CopyRow label={t("overview.welcomeProjectKey")} value={connection.projectKey} />
      <CopyRow label={t("overview.welcomeRepoKey")} value={connection.repoKey} />
    </SettingsCard>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const { t } = useI18n();
  return (
    <SettingsRow
      label={label}
      description={<span className="break-all font-mono">{value}</span>}
      control={<CopyButton size="sm" value={value} label={t("common.copyField").replace("{name}", label)} />}
    />
  );
}

import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { FolderX } from "lucide-react";
import { Button, PageHeader, SettingsRow, StatusPill, TabsContent, TabsTrigger, useI18n } from "@specseal/ui";
import { useClient } from "../../app/context";
import { useAsync } from "../../lib/useAsync";
import { userLabel } from "../../lib/userLabel";
import { DetailTitle } from "../../layouts/DetailTitle";
import { CardNote } from "../../components/CardNote";
import { Field } from "../../components/Field";
import { FormDialog, FormDialogActions, FormMessage, useDialogSubmit } from "../../components/FormDialog";
import { DetailNotFound, DetailTabs } from "./detail";
import { AdminCardState } from "./states";
import type { AdminProject } from "../../api/client";

// 项目详情页（server-web-console「管理列表以详情页与对话框承载查看与创建」「不可变识别字段唯读且
// 更名为显式动作」；server-web-detail-pages design D6）：以用户详情页为范本——768px 置中栏，页标题
// 为项目名称、说明标示代号创建后不可变更、页级动作为更名；其下卡片标头分页为保存库与成员。代号是
// 身分，只以唯读文本呈现（连 disabled 输入框都不出现，避免暗示「某些条件下可改」）；名称按「更名」
// 才在对话框里出现输入框。成员由用户清单反查，唯读。

/** 更名对话框的对象：项目或保存库，在按下「更名」时就组好。 */
type RenameTarget = {
  title: string;
  label: string;
  /** 不随更名改变的代号。 */
  identity: string;
  current: string;
  rename: (name: string) => Promise<void>;
};

/** 项目详情页的网址：代号只挡空白，可能含 / ? # 这类字符，要编码成一段路径。 */
export function projectPath(key: string): string {
  return `/admin/registry/${encodeURIComponent(key)}`;
}

export function ProjectDetailPage({
  projects,
  sequence,
  reload,
}: {
  projects: AdminProject[];
  /** 列表目前呈现的项目（含搜索）——‹ n / m › 的串行。 */
  sequence: AdminProject[];
  reload: () => void;
}) {
  const { t } = useI18n();
  const { key } = useParams();
  const project = projects.find((p) => p.key === key);
  if (!project) {
    return (
      <DetailNotFound
        icon={FolderX}
        title={t("registry.notFoundTitle")}
        body={t("registry.notFoundBody")}
        backLabel={t("registry.backToList")}
        backTo="/admin/registry"
      />
    );
  }
  return <ProjectDetail project={project} sequence={sequence} reload={reload} />;
}

function ProjectDetail({
  project,
  sequence,
  reload,
}: {
  project: AdminProject;
  sequence: AdminProject[];
  reload: () => void;
}) {
  const { t } = useI18n();
  const client = useClient();
  const navigate = useNavigate();
  // 分页是组件 state：‹ › 换项目时停在同一个分页。
  const [tab, setTab] = useState("repos");
  const [rename, setRename] = useState<RenameTarget | null>(null);
  const [addingRepo, setAddingRepo] = useState(false);
  const users = useAsync(() => client.getAdminUsers(), [project.key]);
  const members = (users.data?.users ?? []).flatMap((user) => {
    const membership = user.memberships.find((m) => m.projectKey === project.key);
    return membership ? [{ user, role: membership.role }] : [];
  });
  const index = sequence.findIndex((p) => p.key === project.key);
  const keyMeta = (key: string) => t("registry.detailMeta").replace("{key}", key);

  return (
    <div className="mx-auto flex w-full max-w-[768px] flex-col gap-6">
      <DetailTitle
        label={project.name}
        index={index}
        total={sequence.length}
        onStep={(delta) => navigate(projectPath(sequence[index + delta].key), { replace: true })}
      />
      <PageHeader
        level={1}
        title={project.name}
        description={keyMeta(project.key)}
        actions={
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setRename({
                title: t("registry.renameProjectTitle"),
                label: t("registry.projectName"),
                identity: project.key,
                current: project.name,
                rename: (name) => client.adminRenameProject(project.key, name),
              })
            }
          >
            {t("common.rename")}
          </Button>
        }
      />

      <DetailTabs
        value={tab}
        onValueChange={setTab}
        triggers={
          <>
            <TabsTrigger value="repos" count={project.repos.length}>
              {t("registry.tabRepos")}
            </TabsTrigger>
            <TabsTrigger value="members" count={users.data ? members.length : undefined}>
              {t("registry.tabMembers")}
            </TabsTrigger>
          </>
        }
      >
        <TabsContent value="repos" className="divide-y divide-border">
          {project.repos.length === 0 && <CardNote>{t("registry.noRepos")}</CardNote>}
          {project.repos.map((r) => (
            <SettingsRow
              key={r.key}
              label={r.name}
              description={keyMeta(r.key)}
              control={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={t("registry.renameNamed").replace("{name}", r.name)}
                  onClick={() =>
                    setRename({
                      title: t("registry.renameRepoTitle"),
                      label: t("registry.repoName"),
                      identity: r.key,
                      current: r.name,
                      rename: (name) => client.adminRenameRepo({ projectKey: project.key, key: r.key, name }),
                    })
                  }
                >
                  {t("common.rename")}
                </Button>
              }
            />
          ))}
          <SettingsRow
            label={t("registry.newRepo")}
            description={t("registry.addRepoHint")}
            control={
              <Button type="button" variant="outline" size="sm" onClick={() => setAddingRepo(true)}>
                {t("registry.newRepo")}
              </Button>
            }
          />
        </TabsContent>

        <TabsContent value="members" className="divide-y divide-border">
          {users.loading || users.error != null ? (
            <AdminCardState error={users.error} onRetry={users.reload} />
          ) : members.length === 0 ? (
            <CardNote>{t("registry.noMembers")}</CardNote>
          ) : (
            members.map(({ user, role }) => (
              <SettingsRow
                key={user.id}
                label={userLabel(user)}
                description={user.email}
                control={
                  <StatusPill tone="neutral" className="font-mono">
                    {role}
                  </StatusPill>
                }
              />
            ))
          )}
        </TabsContent>
      </DetailTabs>

      {rename && <RenameDialog target={rename} onClose={() => setRename(null)} onRenamed={reload} />}
      {addingRepo && (
        <CreateRepoDialog project={project} onClose={() => setAddingRepo(false)} onCreated={reload} />
      )}
    </div>
  );
}

// 更名对话框（项目与保存库共用）：预填目前名称、标示代号不随更名改变；空白名称时确认钮停用。
// 失败保持打开并保留输入；成功关闭，页标题、面包屑或列标题随重载换成新名称。
function RenameDialog({
  target,
  onClose,
  onRenamed,
}: {
  target: RenameTarget;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(target.current);
  const { pending, message, submit } = useDialogSubmit(t("registry.renameError"));

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    void submit(async () => {
      await target.rename(name.trim());
      onClose();
      onRenamed();
    });
  }

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={target.title}
      description={t("registry.renameBody").replace("{key}", target.identity)}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field id="rename-name" label={target.label} value={name} onChange={setName} error={message ?? undefined} />
        <FormDialogActions
          submitLabel={t("common.confirm")}
          pending={pending}
          disabled={!name.trim()}
          onCancel={onClose}
        />
      </form>
    </FormDialog>
  );
}

function CreateRepoDialog({
  project,
  onClose,
  onCreated,
}: {
  project: AdminProject;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const client = useClient();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const { pending, message, fieldErrors, submit } = useDialogSubmit(t("registry.createRepoError"));

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit(async () => {
      await client.adminCreateRepo({ projectKey: project.key, key, name: name.trim() || undefined });
      onClose();
      onCreated();
    });
  }

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("registry.newRepo")}
      description={t("registry.newRepoBody").replace("{name}", () => project.name)}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field
          id="new-repo-key"
          label={t("field.repoKey")}
          hint={t("field.keyImmutable")}
          value={key}
          onChange={setKey}
          error={fieldErrors.key}
        />
        <Field
          id="new-repo-name"
          label={t("registry.repoNameLabel")}
          value={name}
          onChange={setName}
          error={fieldErrors.name}
        />
        <FormMessage message={message} fieldErrors={fieldErrors} />
        <FormDialogActions
          submitLabel={pending ? t("common.creating") : t("common.create")}
          pending={pending}
          onCancel={onClose}
        />
      </form>
    </FormDialog>
  );
}

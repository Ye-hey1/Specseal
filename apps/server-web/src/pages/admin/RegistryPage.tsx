import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { FolderPlus, Inbox } from "lucide-react";
import {
  Button,
  EmptyState,
  ListCard,
  ListPager,
  ListRow,
  SearchField,
  useI18n,
  usePaging,
  PageHeader,
} from "@specseal/ui";
import { useClient } from "../../app/context";
import { useAsync, useLastData } from "../../lib/useAsync";
import { useListScroll } from "../../lib/useListScroll";
import { useNarrow } from "../../lib/useMediaQuery";
import { Field } from "../../components/Field";
import { FormDialog, FormDialogActions, FormMessage, useDialogSubmit } from "../../components/FormDialog";
import { NoMatchState } from "../../components/NoMatchState";
import { SectionRoutes } from "./detail";
import { AdminError, AdminLoading } from "./states";
import { ProjectDetailPage, projectPath } from "./ProjectDetailPage";

// 项目区段（server-web-console「管理列表以详情页与对话框承载查看与创建」「管理列表提供搜索、筛选、
// 分页与具引导的空状态」；server-web-list-pages design D2、D3、D5；server-web-detail-pages design D1）：
// `/admin/registry` 是列表、`/admin/registry/<代号>` 是项目详情页。数据与列表状态（搜索、页码）放在
// 区段，回列表时原样保留。列表页标题区右侧是搜索与创建项目，其下一张列表卡（前端换页），整列可点
// 进详情页；创建项目以置中对话框承载，列表页不含输入控制项。

export function RegistrySection() {
  const { t, tn } = useI18n();
  const client = useClient();
  const navigate = useNavigate();
  const narrow = useNarrow();
  const { data: fresh, error, reload } = useAsync(() => client.getAdminRegistry(), []);
  // 留着上一份成功回应：详情页变更后重载时不卸载重挂（同用户区段，design D1）。
  const data = useLastData(fresh, error);
  const [createOpen, setCreateOpen] = useState(false);
  const [q, setQ] = useState("");
  const { scrollRef, scrollToTop } = useListScroll();
  const needle = q.trim().toLowerCase();
  const visible = (data?.projects ?? []).filter(
    (p) =>
      needle === "" ||
      [p.name, p.key, ...p.repos.flatMap((r) => [r.name, r.key])].some((field) =>
        field.toLowerCase().includes(needle),
      ),
  );
  const paging = usePaging(visible, { onMove: scrollToTop });

  const list = (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader
        level={1}
        title={t("registry.title")}
        description={t("registry.description")}
        actions={
          <>
            <SearchField
              label={t("common.search")}
              placeholder={t("registry.searchPlaceholder")}
              value={q}
              onChange={(value) => {
                setQ(value);
                paging.setPage(1);
              }}
            />
            <Button
              type="button"
              data-tour="list-primary"
              className="gap-1.5"
              onClick={() => setCreateOpen(true)}
            >
              <FolderPlus aria-hidden="true" className="h-4 w-4" />
              {t("registry.create")}
            </Button>
          </>
        }
      />

      {!data && error == null && <AdminLoading />}
      {error != null && <AdminError onRetry={reload} />}
      {data && (
        <ListCard scrollRef={scrollRef} footer={<ListPager compact={narrow} {...paging.pager} />}>
          {/* 空状态不放创建钮：创建钮常驻页眉，一页只有一个主要动作。 */}
          {data.projects.length === 0 ? (
            <EmptyState icon={Inbox} title={t("registry.emptyTitle")} description={t("registry.emptyBody")} />
          ) : visible.length === 0 ? (
            <NoMatchState />
          ) : (
            paging.pageItems.map((p) => (
              <ListRow
                key={p.key}
                data-project={p.key}
                mono={false}
                title={p.name}
                description={tn("registry.projectMeta", p.repos.length).replace("{key}", p.key)}
                onClick={() => navigate(projectPath(p.key))}
              />
            ))
          )}
        </ListCard>
      )}

      {/* 只在开着时挂载：每次打开都是空白表单。 */}
      {createOpen && <CreateProjectDialog onClose={() => setCreateOpen(false)} onCreated={reload} />}
    </div>
  );

  return (
    <SectionRoutes
      base="/admin/registry"
      param="key"
      list={list}
      detail={data && <ProjectDetailPage projects={data.projects} sequence={visible} reload={reload} />}
      error={error}
      onRetry={reload}
    />
  );
}

function CreateProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useI18n();
  const client = useClient();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const { pending, message, fieldErrors, submit } = useDialogSubmit(t("registry.createProjectError"));

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit(async () => {
      await client.adminCreateProject({ key, name: name.trim() || undefined });
      onClose();
      onCreated();
    });
  }

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("registry.create")}
      description={t("registry.createProjectHint")}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field
          id="new-project-key"
          label={t("field.projectKey")}
          hint={t("field.keyImmutable")}
          value={key}
          onChange={setKey}
          error={fieldErrors.key}
        />
        <Field
          id="new-project-name"
          label={t("registry.projectNameLabel")}
          value={name}
          onChange={setName}
          error={fieldErrors.name}
        />
        <FormMessage message={message} fieldErrors={fieldErrors} />
        <FormDialogActions
          submitLabel={pending ? t("common.creating") : t("registry.create")}
          pending={pending}
          onCancel={onClose}
        />
      </form>
    </FormDialog>
  );
}

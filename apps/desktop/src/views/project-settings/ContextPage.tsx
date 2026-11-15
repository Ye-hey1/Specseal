// 项目说明页（desktop-settings-mode design D8；desktop-settings-editors design D2；spec「设置页编辑
// 项目说明与产出规则」）：唯读为 markdown 渲染全文（自成一页，不收合）；编辑为 markdown 模式的
// CodeEditor，页标题右侧「编辑／预览」切换＋取消＋保存 ⌘S，预览渲染草稿、编辑器维持挂载。
import { useState } from "react";
import {
  Card,
  Markdown,
  SettingsPageHeader,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useI18n,
} from "@specseal/ui";

import { CodeEditor } from "../../components/CodeEditor";
import { CardEditControls, FieldHelp, PageAlerts, PageNote, useSaveShortcut } from "./parts";
import type { ProjectSettingsState } from "./useProjectSettings";

type EditView = "edit" | "preview";

export function ContextPage({ ps }: { ps: ProjectSettingsState }) {
  const { t } = useI18n();
  const [view, setView] = useState<EditView>("edit");
  const save = () => void ps.saveContext();
  useSaveShortcut(ps.ctxEditing, save);
  return (
    <Tabs
      data-testid="context-page"
      value={view}
      onValueChange={(next) => setView(next as EditView)}
      className="flex flex-col gap-6"
    >
      <SettingsPageHeader
        title={t("settings.projectSection.context")}
        description={t("settings.contextPageDesc")}
        actions={
          <CardEditControls
            editing={ps.ctxEditing}
            disabled={ps.wfDisabled || ps.ctxSaving}
            msg={ps.ctxMsg}
            testPrefix="context"
            toggle={
              <TabsList variant="segmented">
                <TabsTrigger value="edit">{t("settings.editor.edit")}</TabsTrigger>
                <TabsTrigger value="preview">{t("settings.editor.preview")}</TabsTrigger>
              </TabsList>
            }
            onEdit={() => {
              setView("edit");
              ps.beginCtxEdit();
            }}
            onCancel={() => ps.setCtxEditing(false)}
            onSave={save}
          />
        }
        note={<PageNote remote={ps.remoteNote} fileKey={`${ps.configFile} · context`} testId="file-note-config" />}
      />
      <PageAlerts ps={ps} parseError={ps.snap.workflow.parseError} />
      {ps.ctxEditing ? (
        <>
          <TabsContent
            value="edit"
            forceMount
            hidden={view !== "edit"}
            data-testid="context-input"
            className="flex flex-col gap-2"
          >
            <CodeEditor
              value={ps.draftContext}
              onChange={ps.setDraftContext}
              mode="markdown"
              readOnly={ps.wfDisabled || ps.ctxSaving}
              onSave={save}
              minLines={12}
              ariaLabel={t("settings.projectSection.context")}
              autoFocus
            />
            <FieldHelp>{t("settings.contextHelp")}</FieldHelp>
          </TabsContent>
          <TabsContent value="preview" data-testid="context-preview">
            <Card className="p-4">
              <Markdown content={ps.draftContext || null} empty={t("settings.contextEmpty")} />
            </Card>
          </TabsContent>
        </>
      ) : (
        <Card data-testid="context-readonly" className="p-4">
          <Markdown content={ps.contextText || null} empty={t("settings.contextEmpty")} />
        </Card>
      )}
    </Tabs>
  );
}

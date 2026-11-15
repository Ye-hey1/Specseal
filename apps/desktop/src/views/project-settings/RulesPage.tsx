// 产出规则页（desktop-settings-mode design D8；desktop-settings-editors design D3；spec「设置页编辑
// 项目说明与产出规则」）：页标题右侧编辑／取消／保存 ⌘S；唯读只列有条目的固定键（等宽键名＋条数），
// 编辑为每个固定键一张小卡（等宽键名＋即时「N 条」＋纯文本 CodeEditor）。
import { FileText } from "lucide-react";
import { Card, SettingsPageHeader, useI18n } from "@specseal/ui";

import { CodeEditor } from "../../components/CodeEditor";
import { CardEditControls, FieldHelp, PageAlerts, PageNote, useSaveShortcut } from "./parts";
import { textToEntries } from "./lines";
import type { ProjectSettingsState } from "./useProjectSettings";

export function RulesPage({ ps }: { ps: ProjectSettingsState }) {
  const { t, tn } = useI18n();
  const save = () => void ps.saveRules();
  useSaveShortcut(ps.rulesEditing, save);
  const countLabel = (n: number) => tn("settings.rulesCount", n);
  return (
    <div data-testid="rules-page" className="flex flex-col gap-6">
      <SettingsPageHeader
        title={t("settings.projectSection.rules")}
        description={t("settings.rulesPageDesc")}
        actions={
          <CardEditControls
            editing={ps.rulesEditing}
            disabled={ps.wfDisabled || ps.rulesSaving}
            msg={ps.rulesMsg}
            testPrefix="rules"
            onEdit={ps.beginRulesEdit}
            onCancel={() => ps.setRulesEditing(false)}
            onSave={save}
          />
        }
        note={<PageNote remote={ps.remoteNote} fileKey={`${ps.configFile} · rules`} testId="file-note-config" />}
      />
      <PageAlerts ps={ps} parseError={ps.snap.workflow.parseError} />
      <Card className="flex flex-col gap-3 p-4">
        {ps.rulesEditing ? (
          <>
            {/* 编辑面以冻结键集渲染（review N4），不跟 snap 的固定键换集。 */}
            {ps.editingRuleKeys.map((id) => (
              <section key={id} data-testid={`rules-input-${id}`} aria-label={id} className="flex flex-col gap-2">
                <div className="flex items-center gap-1.5 px-1 text-sm font-medium">
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="font-mono">{id}</span>
                  <span
                    data-testid={`rules-count-${id}`}
                    className="inline-flex h-4 items-center rounded-full bg-muted px-1.5 text-[11px] font-normal tabular-nums text-muted-foreground"
                  >
                    {countLabel(textToEntries(ps.draftRules[id] ?? "").length)}
                  </span>
                </div>
                <CodeEditor
                  value={ps.draftRules[id] ?? ""}
                  onChange={(text) => ps.setDraftRules((prev) => ({ ...prev, [id]: text }))}
                  mode="plain"
                  readOnly={ps.wfDisabled || ps.rulesSaving}
                  onSave={save}
                  minLines={3}
                  ariaLabel={id}
                />
              </section>
            ))}
            <FieldHelp>{t("settings.rulesHelp")}</FieldHelp>
          </>
        ) : ps.populatedRuleKeys.length === 0 ? (
          <p className="m-0 py-4 text-sm text-muted-foreground">{t("common.noContent")}</p>
        ) : (
          ps.populatedRuleKeys.map((id) => {
            const entries = ps.rules[id] ?? [];
            return (
              <div key={id} data-testid={`rules-readonly-${id}`} className="flex flex-col gap-1">
                <span className="flex items-baseline gap-2">
                  <span className="font-mono text-sm font-medium">{id}</span>
                  <span className="text-xs text-muted-foreground">
                    {countLabel(entries.length)}
                  </span>
                </span>
                <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-sm text-muted-foreground">
                  {entries.map((entry, i) => (
                    <li key={i}>{entry}</li>
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </Card>
    </div>
  );
}

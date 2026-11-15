// 子代理模型页（spec 需求「设置页编辑子代理模型」）：「各站使用的模型」表格（每列一个内置 AI 工具、
// 审查与验证两栏）与「自订清单」卡。编辑沿用审查规则页的页标题右侧编辑／取消／保存 ⌘S；每格是
// 共用下拉（与产出流程页 locale 同一组件），清单是纯文本 CodeEditor。内置清单取自快照（引擎提供）。
import {
  Badge,
  Input,
  SettingsCard,
  SettingsChoice,
  SettingsPageHeader,
  SettingsRow,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useI18n,
} from "@specseal/ui";

import { BUILTIN_TOOLS, BUILTIN_TOOL_NAMES, type BuiltinTool } from "../../builtinTools";
import { CodeEditor } from "../../components/CodeEditor";
import { textToEntries } from "./lines";
import { CardEditControls, FieldHelp, PageAlerts, PageNote, useSaveShortcut } from "./parts";
import {
  SUBAGENT_CUSTOM,
  SUBAGENT_INHERIT,
  SUBAGENT_STATIONS,
  cellChoice,
  cellValue,
  choiceOptions,
  modelSource,
  type SubagentCell,
  type SubagentStation,
} from "./subagentModel";
import type { ProjectSettingsState } from "./useProjectSettings";

/** 名称的小签（自订清单与内置名称）：共用 Badge，名称用等宽字。 */
function NameChip({ name }: { name: string }) {
  return <Badge className="font-mono">{name}</Badge>;
}

export function SubagentModelPage({ ps }: { ps: ProjectSettingsState }) {
  const { t, tn } = useI18n();
  const save = () => void ps.saveSubagentModel();
  useSaveShortcut(ps.subagentEditing, save);
  const disabled = ps.wfDisabled || ps.subagentSaving;
  const editing = ps.subagentEditing;
  const draft = ps.draftSubagent;
  const current = ps.subagentModel;
  const builtinOf = (tool: string) => ps.snap.workflow.builtinSubagentModels[tool] ?? [];
  const labels = {
    inherit: t("settings.subagentInherit"),
    builtin: t("settings.subagentSource.builtin"),
    choices: t("settings.subagentSource.choices"),
    custom: t("settings.subagentCustomOption"),
  };
  const cellName = (tool: BuiltinTool, station: SubagentStation) =>
    `${BUILTIN_TOOL_NAMES[tool]} · ${t(`settings.subagentStation.${station}`)}`;
  const setCell = (station: SubagentStation, tool: BuiltinTool, cell: SubagentCell) =>
    ps.setDraftSubagent((prev) => ({
      ...prev,
      cells: { ...prev.cells, [station]: { ...prev.cells[station], [tool]: cell } },
    }));

  const cellView = (station: SubagentStation, tool: BuiltinTool) => {
    const value = current[station][tool];
    if (value === undefined) return <span className="text-muted-foreground">{labels.inherit}</span>;
    const source = modelSource(value, builtinOf(tool), current.choices[tool] ?? []);
    return (
      <span className="flex flex-col gap-0.5">
        <span className="font-mono text-[13px]">{value}</span>
        <span className="text-xs text-muted-foreground">{t(`settings.subagentSource.${source}`)}</span>
      </span>
    );
  };

  const cellEditor = (station: SubagentStation, tool: BuiltinTool) => {
    const cell = draft.cells[station][tool];
    const options = choiceOptions(builtinOf(tool), textToEntries(draft.lists[tool]), labels);
    const choice = cellChoice(cell, options);
    const name = cellName(tool, station);
    const onChange = (value: string) =>
      setCell(
        station,
        tool,
        value === SUBAGENT_INHERIT
          ? { mode: "inherit" }
          : value === SUBAGENT_CUSTOM
            ? { mode: "custom", value: cellValue(cell) }
            : { mode: "pick", value },
      );
    return (
      <div className="flex flex-col gap-1.5">
        <SettingsChoice value={choice} options={options} ariaLabel={name} disabled={disabled} onChange={onChange} />
        {choice === SUBAGENT_CUSTOM && (
          <>
            <Input
              aria-label={`${name} · ${t("settings.subagentCustomInput")}`}
              value={cellValue(cell)}
              disabled={disabled}
              className="font-mono text-[13px]"
              onChange={(e) => setCell(station, tool, { mode: "custom", value: e.target.value })}
            />
            <FieldHelp>{t("settings.subagentCustomHelp")}</FieldHelp>
          </>
        )}
      </div>
    );
  };

  const toolLabel = (tool: BuiltinTool) => (
    <span className="flex flex-wrap items-baseline gap-x-1.5">
      <span data-testid="subagent-tool-name" className="text-sm">
        {BUILTIN_TOOL_NAMES[tool]}
      </span>
      <span className="font-mono text-xs text-muted-foreground">{tool}</span>
    </span>
  );

  return (
    <div data-testid="subagent-page" className="flex flex-col gap-6">
      <SettingsPageHeader
        title={t("settings.projectSection.subagent")}
        description={t("settings.subagentPageDesc")}
        actions={
          <CardEditControls
            editing={editing}
            disabled={disabled}
            msg={ps.subagentMsg}
            testPrefix="subagent"
            onEdit={ps.beginSubagentEdit}
            onCancel={() => ps.setSubagentEditing(false)}
            onSave={save}
          />
        }
        note={<PageNote remote={ps.remoteNote} fileKey={`${ps.configFile} · subagent_model`} testId="file-note-config" />}
      />
      <PageAlerts ps={ps} parseError={ps.snap.workflow.parseError} />

      <SettingsCard title={t("settings.subagentTableCard")}>
        <Table>
          <TableHeader>
            <TableRow hoverable={false}>
              <TableHead className="w-[40%]">{t("settings.subagentToolColumn")}</TableHead>
              <TableHead>
                {t("settings.subagentStation.review")}
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  {t("settings.subagentStation.reviewHint")}
                </span>
              </TableHead>
              <TableHead>{t("settings.subagentStation.verify")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {BUILTIN_TOOLS.map((tool) => (
              <TableRow key={tool} data-testid={`subagent-row-${tool}`} hoverable={false}>
                <TableCell className="align-top">
                  <div className="flex flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      {toolLabel(tool)}
                      {/* 远程没有 .specseal.yaml；它解析失败时不知道勾了哪些工具，都不标。 */}
                      {!ps.isRemote && ps.snap.app.parseError === null && !ps.snap.app.tools.includes(tool) && (
                        <Badge variant="muted">{t("settings.subagentNotEnabled")}</Badge>
                      )}
                    </span>
                    {tool === "pi" && <p className="m-0 text-xs text-muted-foreground">{t("settings.subagentPiNote")}</p>}
                  </div>
                </TableCell>
                {SUBAGENT_STATIONS.map((station) => (
                  <TableCell key={station} data-testid={`subagent-cell-${station}-${tool}`} className="align-top">
                    {editing ? cellEditor(station, tool) : cellView(station, tool)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SettingsCard>

      <SettingsCard title={t("settings.subagentListsCard")}>
        {BUILTIN_TOOLS.map((tool) => {
          const builtin = builtinOf(tool);
          const builtinNames = builtin.length > 0 && (
            <span className="flex flex-wrap items-center gap-1">
              <span className="text-xs text-muted-foreground">{t("settings.subagentSource.builtin")}</span>
              {builtin.map((name) => (
                <NameChip key={name} name={name} />
              ))}
            </span>
          );
          if (editing) {
            return (
              <section
                key={tool}
                data-testid={`subagent-list-input-${tool}`}
                aria-label={BUILTIN_TOOL_NAMES[tool]}
                className="flex flex-col gap-2 px-4 py-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {toolLabel(tool)}
                  {builtinNames}
                </div>
                <CodeEditor
                  value={draft.lists[tool]}
                  onChange={(text) => ps.setDraftSubagent((prev) => ({ ...prev, lists: { ...prev.lists, [tool]: text } }))}
                  mode="plain"
                  readOnly={disabled}
                  onSave={save}
                  minLines={2}
                  ariaLabel={BUILTIN_TOOL_NAMES[tool]}
                />
              </section>
            );
          }
          const names = current.choices[tool] ?? [];
          return (
            <div key={tool} data-testid={`subagent-list-${tool}`}>
              <SettingsRow
                label={toolLabel(tool)}
                description={
                  names.length === 0 ? (
                    t("settings.subagentListEmpty")
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {names.map((name, i) => (
                        <NameChip key={i} name={name} />
                      ))}
                    </span>
                  )
                }
                control={
                  <span className="flex flex-col items-end gap-1">
                    {builtinNames}
                    {names.length > 0 && (
                      <span className="text-xs text-muted-foreground">{tn("settings.subagentListCount", names.length)}</span>
                    )}
                  </span>
                }
              />
            </div>
          );
        })}
      </SettingsCard>

      {editing && <FieldHelp>{t("settings.subagentListsHelp")}</FieldHelp>}
      {!editing && !ps.isRemote && <FieldHelp>{t("settings.subagentNotEnabledNote")}</FieldHelp>}
      <FieldHelp>{t("settings.subagentFootnote")}</FieldHelp>
    </div>
  );
}

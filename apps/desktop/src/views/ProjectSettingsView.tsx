// 项目设置（spec 需求「设置页图形化读写两层设置」「设置页编辑项目说明与产出规则」；
// desktop-settings-mode design D8）：依项目设置分类栏的所在分类渲染一页——项目说明、产出规则、
// 审查规则、子代理模型、产出流程、.specseal.yaml（remote 无此页）。状态与动作在 useProjectSettings，各页共用、
// 切页不重载。
import { useEffect } from "react";

import type { WorkspaceSettingsProvider } from "../session";
import type { ProjectSettingsSection } from "../settingsCatalog";
import { ContextPage } from "./project-settings/ContextPage";
import { ReviewRulesPage } from "./project-settings/ReviewRulesPage";
import { RulesPage } from "./project-settings/RulesPage";
import { SpecsealPage } from "./project-settings/SpecsealPage";
import { SubagentModelPage } from "./project-settings/SubagentModelPage";
import { WorkflowPage } from "./project-settings/WorkflowPage";
import { useProjectSettings } from "./project-settings/useProjectSettings";

export interface ProjectSettingsViewProps {
  /** 活跃 session 的设置面（root 已绑定；workspace-session 决策 3）。 */
  settings: WorkspaceSettingsProvider;
  /** 项目设置分类栏的所在分类（remote 项目的 .specseal.yaml 已由 App 退回项目说明）。 */
  section: ProjectSettingsSection;
  /** 回报两层设置档的解析失败——项目设置分类栏据此挂警示点（desktop-settings-mode design D2）。 */
  onParseErrors?: (errors: { config: boolean; specseal: boolean }) => void;
  /** 回报有无未存修改——App 的返回据此先问要不要舍弃。 */
  onDirtyChange?: (dirty: boolean) => void;
}

export function ProjectSettingsView({
  settings,
  section,
  onParseErrors,
  onDirtyChange,
}: ProjectSettingsViewProps) {
  const ps = useProjectSettings(settings);
  const configParseError = ps !== null && ps.snap.workflow.parseError !== null;
  const specsealParseError = ps !== null && ps.snap.app.parseError !== null;
  const dirty = ps !== null && ps.dirty;
  useEffect(() => {
    onParseErrors?.({ config: configParseError, specseal: specsealParseError });
  }, [onParseErrors, configParseError, specsealParseError]);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [onDirtyChange, dirty]);
  // 卸载（离开项目设置、切到设置页还没就绪的分页）时清掉回报：分类栏不沿用上一个项目的
  // 警示点，返回也不再问。
  useEffect(
    () => () => {
      onParseErrors?.({ config: false, specseal: false });
      onDirtyChange?.(false);
    },
    [onParseErrors, onDirtyChange],
  );

  if (!ps) return null;
  return (
    <div className="mx-auto flex w-full max-w-[768px] flex-col gap-6 px-6 pb-10 pt-7">
      {section === "context" && <ContextPage ps={ps} />}
      {section === "rules" && <RulesPage ps={ps} />}
      {section === "review" && <ReviewRulesPage ps={ps} />}
      {section === "subagent" && <SubagentModelPage ps={ps} />}
      {section === "workflow" && <WorkflowPage ps={ps} />}
      {section === "specseal" && <SpecsealPage ps={ps} />}
    </div>
  );
}

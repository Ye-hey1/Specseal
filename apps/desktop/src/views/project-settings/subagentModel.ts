// 子代理模型的草稿与保存（desktop-subagent-model-page design「子代理模型的草稿与保存」）：
// 页面与 hook 共用的纯函数。草稿只涵盖内置工具；存回以现值为底，其他工具名称的格子与清单原样带回。
import { isSettingsChoiceGroup, type SettingsChoiceGroup, type SettingsChoiceOption } from "@specseal/ui";

import type { SubagentModelConfig } from "../../adapter/workspace";
import { BUILTIN_TOOLS, type BuiltinTool } from "../../builtinTools";
import { entriesToText, keepUnedited } from "./lines";

export const SUBAGENT_STATIONS = ["review", "verify"] as const;
export type SubagentStation = (typeof SUBAGENT_STATIONS)[number];

/** 下拉的哨兵值（Radix Select 的值不得为空字符串）：沿用主对话、自行输入…。 */
export const SUBAGENT_INHERIT = "__inherit__";
export const SUBAGENT_CUSTOM = "__custom__";

/** 一格的草稿：沿用主对话（没有值）、从清单选、自行输入（输入框带 value）。 */
export type SubagentCell = { mode: "inherit" } | { mode: "pick" | "custom"; value: string };

/** 编辑草稿：两站各内置工具一格，各内置工具的自订清单一份「一行一个」文本。 */
export interface SubagentDraft {
  cells: Record<SubagentStation, Record<BuiltinTool, SubagentCell>>;
  lists: Record<BuiltinTool, string>;
}

/** 一格现在的模型名称（沿用主对话＝空字符串）。 */
export const cellValue = (cell: SubagentCell) => (cell.mode === "inherit" ? "" : cell.value);

export type ModelSource = "builtin" | "choices" | "custom";

export const EMPTY_SUBAGENT_MODEL: SubagentModelConfig = { review: {}, verify: {}, choices: {} };

/** 值的来源：在内置清单＝内置；否则在自订清单＝自订清单；否则＝自行输入。 */
export function modelSource(value: string, builtin: readonly string[], choices: readonly string[]): ModelSource {
  if (builtin.includes(value)) return "builtin";
  if (choices.includes(value)) return "choices";
  return "custom";
}

export function toDraft(config: SubagentModelConfig, builtin: Record<string, string[]>): SubagentDraft {
  const cell = (station: SubagentStation, tool: BuiltinTool): SubagentCell => {
    const value = config[station][tool];
    if (value === undefined) return { mode: "inherit" };
    const source = modelSource(value, builtin[tool] ?? [], config.choices[tool] ?? []);
    return { mode: source === "custom" ? "custom" : "pick", value };
  };
  const perTool = <T>(make: (tool: BuiltinTool) => T) =>
    Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool, make(tool)])) as Record<BuiltinTool, T>;
  return {
    cells: { review: perTool((tool) => cell("review", tool)), verify: perTool((tool) => cell("verify", tool)) },
    lists: perTool((tool) => entriesToText(config.choices[tool] ?? [])),
  };
}

/** 存回：只覆写内置工具的格子与清单——沿用主对话与留空的自行输入移除该格，自行输入去头尾
 * 空白；清单一行一条、没改过的沿用现值，清空移除键。 */
export function fromDraft(draft: SubagentDraft, current: SubagentModelConfig): SubagentModelConfig {
  const next: SubagentModelConfig = {
    review: { ...current.review },
    verify: { ...current.verify },
    choices: { ...current.choices },
  };
  for (const tool of BUILTIN_TOOLS) {
    for (const station of SUBAGENT_STATIONS) {
      const value = cellValue(draft.cells[station][tool]).trim();
      if (value === "") delete next[station][tool];
      else next[station][tool] = value;
    }
    const names = keepUnedited(draft.lists[tool], current.choices[tool] ?? []);
    if (names.length === 0) delete next.choices[tool];
    else next.choices[tool] = names;
  }
  return next;
}

const sortedEntries = <T>(map: Record<string, T>) =>
  Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const canonical = (config: SubagentModelConfig) =>
  JSON.stringify([sortedEntries(config.review), sortedEntries(config.verify), sortedEntries(config.choices)]);

/** 内容相同（不看键序）：存回结果与现值相同时不写档。 */
export const sameSubagentModel = (a: SubagentModelConfig, b: SubagentModelConfig) => canonical(a) === canonical(b);

/** 下拉选项：沿用主对话、内置组、自订清单组、自行输入…；空的组不出现。同名只留在内置组，
 * 重复名称只列一次，撞到哨兵的名称不列（Radix Select 的值不得重复）。 */
export function choiceOptions(
  builtin: readonly string[],
  custom: readonly string[],
  labels: { inherit: string; builtin: string; choices: string; custom: string },
): (SettingsChoiceOption | SettingsChoiceGroup)[] {
  const sentinels = [SUBAGENT_INHERIT, SUBAGENT_CUSTOM];
  const group = (label: string, names: string[]): SettingsChoiceGroup[] =>
    names.length === 0 ? [] : [{ label, options: names.map((name) => ({ value: name, label: name })) }];
  const builtinNames = builtin.filter((name) => !sentinels.includes(name));
  const customNames = Array.from(new Set(custom)).filter(
    (name) => !sentinels.includes(name) && !builtinNames.includes(name),
  );
  return [
    { value: SUBAGENT_INHERIT, label: labels.inherit },
    ...group(labels.builtin, builtinNames),
    ...group(labels.choices, customNames),
    { value: SUBAGENT_CUSTOM, label: labels.custom },
  ];
}

/** 一格在下拉上的值：pick 的名称已不在选项里（从清单删掉了）时改判自行输入。 */
export function cellChoice(cell: SubagentCell, options: (SettingsChoiceOption | SettingsChoiceGroup)[]): string {
  if (cell.mode === "inherit") return SUBAGENT_INHERIT;
  const listed = options.some((entry) => isSettingsChoiceGroup(entry) && entry.options.some((o) => o.value === cell.value));
  return cell.mode === "pick" && listed ? cell.value : SUBAGENT_CUSTOM;
}

/** 内置 AI 工具的勾选清单：初始化确认、激活确认、checkout 绑定与设置页 AI 工具卡共用。
 * 名称与引擎 `Tool::parse` 认得的内置名一致，标签直接显示原始工具名。 */
export const BUILTIN_TOOLS = ["claude", "codex", "copilot", "pi", "cursor"] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

/** 内置工具的产品显示名（子代理模型页的工具栏）；产品名不翻译。 */
export const BUILTIN_TOOL_NAMES: Record<BuiltinTool, string> = {
  claude: "Claude Code",
  codex: "Codex",
  copilot: "Copilot",
  pi: "pi",
  cursor: "Cursor",
};

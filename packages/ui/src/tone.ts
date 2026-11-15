/*
 * 接口状态语意色的单一来源（spec desktop-app「接口状态语意色分层」、
 * server-web-console「后台状态徽章语意色」共用）。三层色彩角色规则：
 * 主色只做链接／交互／进度，状态一律语意色，静态 metadata 一律中性。
 *
 * 表内只保存「状态→token class」对照：色值与深色值都在 theme.css 的
 * status-* token，这里不写原生色阶、也不写深色成对变体。错误与危险
 * 沿用 destructive token，不另设 status-danger。
 */

/** 状态文本／图标色：进行中＝蓝、成功＝绿、警示＝琥珀、错误与危险＝红、待手动＝暖黄。 */
export const SEMANTIC_TONE = {
  inProgress: "text-status-progress",
  success: "text-status-success",
  warning: "text-status-warning",
  danger: "text-destructive",
  manual: "text-status-manual",
} as const;

/** 同语意的面色（border＋淡底）：供横幅、状态卡与政策冲突面等有底色的区块用。 */
export const SEMANTIC_SURFACE = {
  inProgress: "border-status-progress/40 bg-status-progress/10",
  success: "border-status-success/40 bg-status-success/10",
  warning: "border-status-warning/40 bg-status-warning/10",
  danger: "border-destructive/40 bg-destructive/10",
  manual: "border-status-manual/40 bg-status-manual/10",
} as const;

/** 语意色键集——`SEMANTIC_TONE` 与 `SEMANTIC_SURFACE` 的共同键。 */
export type SemanticTone = keyof typeof SEMANTIC_TONE;

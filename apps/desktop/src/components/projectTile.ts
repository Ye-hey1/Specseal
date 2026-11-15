// 项目首字母方块的样式常数（tray-panel-restyle design D3）：主窗口图标列与系统匣
// 面板的项目 tab 取同一份，两处永远同形。零依赖——面板是独立 bundle。

/** 图标列方块的尺寸样式（项目方块、「＋」、齿轮与更新钮共用）。 */
export const RAIL_SQUARE =
  "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[13px] font-medium";

/** 作用中项目：实心主色＋反白字。 */
export const PROJECT_TILE_ACTIVE = "bg-primary text-primary-foreground";

/** 非作用中项目：灰底。 */
export const PROJECT_TILE_IDLE = "bg-muted text-muted-foreground";

/** 「加入项目」／「＋」的虚线方块。 */
export const ADD_TILE = "border border-dashed border-border bg-transparent text-muted-foreground";

/** 方块内的首字母：去头尾空白后的第一个字（以 code point 计，不切断代理对）转大写。 */
export function projectInitial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "";
}

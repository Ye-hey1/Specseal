// 面板可卷区的边缘淡出（spec「面板样式（macOS）」；design「项目 tab 条：「＋」固定右端、边缘淡出、
// 卷到作用中」「中段上下缘淡出：与 tab 条共用边缘淡出」）：tab 条（横向）与可卷中段（纵向）共用
// 同一套判断——轴向无关，start＝左／上、end＝右／下。纯函数：jsdom 没有版面，组件测试以注入
// 尺寸验证接线，计算本身由纯函数测试覆盖。

/** 边缘淡出的宽度（px）：遮罩渐层宽度，也是 tab 条卷到作用中 tab 时留给淡出区的余裕。 */
export const EDGE_FADE_PX = 24;

/** 卷动位置可能是小数：差不到 1px 视为已到尽头。 */
const TOLERANCE_PX = 1;

/** 淡出的侧；以字符串表示，组件存成状态时值相同就不重绘。 */
export type EdgeFadeSide = "none" | "start" | "end" | "both";

/** 可卷区单轴的卷动量测；字段具名，避免三个同型数字传错位置。 */
export interface ScrollMetrics {
  /** 目前卷动位置（scrollLeft／scrollTop）。 */
  position: number;
  /** 内容总长（scrollWidth／scrollHeight）。 */
  scrollSize: number;
  /** 可视长度（clientWidth／clientHeight）。 */
  viewportSize: number;
}

/** 淡出判断：该侧还有被卷出可视范围的内容才淡出。 */
export function edgeFade({ position, scrollSize, viewportSize }: ScrollMetrics): EdgeFadeSide {
  const start = position > TOLERANCE_PX;
  const end = position + viewportSize < scrollSize - TOLERANCE_PX;
  return start && end ? "both" : start ? "start" : end ? "end" : "none";
}

/** 依淡出侧组出遮罩渐层（挂在可卷区本身，不随内容卷动）；不淡出时不挂遮罩。 */
export function edgeFadeMask(axis: "x" | "y", side: EdgeFadeSide): string | undefined {
  if (side === "none") return undefined;
  const start = side === "end" ? "black" : `transparent, black ${EDGE_FADE_PX}px`;
  const end = side === "start" ? "black" : `black calc(100% - ${EDGE_FADE_PX}px), transparent`;
  return `linear-gradient(${axis === "x" ? "to right" : "to bottom"}, ${start}, ${end})`;
}

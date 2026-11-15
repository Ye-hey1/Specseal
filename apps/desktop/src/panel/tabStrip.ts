// 面板项目 tab 条的卷动计算（spec「面板样式（macOS）」；design「项目 tab 条：「＋」固定
// 右端、边缘淡出、卷到作用中」）：纯函数——jsdom 没有版面，组件测试以注入尺寸验证接线，
// 计算本身由纯函数测试覆盖。参数一律具名，避免几个同型数字传错位置。边缘淡出的判断与
// 中段共用，在 edgeFade.ts。
import { EDGE_FADE_PX } from "./edgeFade";

/**
 * 露出目标：让作用中 tab 完整可见、且不落在淡出区内的 scrollLeft；本来就可见则回传原值。
 * tabLeft 是 tab 在可卷内容中的左缘（可卷区为其 offsetParent 时即 offsetLeft）。超过最大
 * 卷动量的值交给浏览器夹回——卷到尽头时该侧本来就不淡出。
 */
export function tabRevealScrollLeft({
  tabLeft,
  tabWidth,
  scrollLeft,
  viewportWidth,
}: {
  tabLeft: number;
  tabWidth: number;
  scrollLeft: number;
  viewportWidth: number;
}): number {
  const minScroll = tabLeft + tabWidth + EDGE_FADE_PX - viewportWidth;
  const maxScroll = tabLeft - EDGE_FADE_PX;
  if (scrollLeft < minScroll) return minScroll;
  if (scrollLeft > maxScroll) return Math.max(0, maxScroll);
  return scrollLeft;
}

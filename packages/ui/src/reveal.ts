/** 列滑过才出现的控制项（拷贝钮、server 后台的撤销钮）：平时透明，所在 `group` 滑过或键盘聚焦时出现；
 *  没有鼠标移入能力的设备恒常显示。只改不透明度，隐藏期间仍在 Tab 顺序内、屏幕阅读器读得到。 */
export const REVEAL_ON_GROUP_HOVER =
  "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100";

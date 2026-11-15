// 系统匣图标资产：单色 template PNG（Specseal 标记剪影，可见形状由 alpha 表达）。
// macOS 以 iconAsTemplate 依 alpha 渲染为系统色，自动适应深浅色菜单列。前端拥有（design
// D1）故内嵌为 base64 常数，免资产管线与 fetch——tray.ts 以 Image.fromBytes 解码（需 Rust
// image-png feature）。来源档为 apps/desktop/src-tauri/icons/specseal-tray-18@2x.png
// （36×36，接合 S 单色剪影）；更新来源档后须重新编码此常数。
const TRAY_ICON_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAACXBIWXMAAAsTAAALEwEAmpwYAAABcklEQVRYhd2YPUoDQRSAPy2CCBKDir2W6bUQCwslFxCSKOQEnkE8RS4gQgoPoNYWuhtYbFVMJVaKEauoKwsvkGYzszPDY/WD1+58M+/tmx/4BywANc/wZh04Az6ANEAMfGS2gbdAIuPouspsAcPAMrfAfFlknoBVF5nNgPWSSrwDdReZ7C94CSwzAho4clJgoB8gAq6mxDmwiwdRgVm3UODRQuYLaKPEpUWaOihyaBC6QZlZwyp9a9XOJFUgNtRQU1tq0UIqS68qNaBfNqkVC6kkpyn2gCOgElqqIh/u5QyciFiedF8mpsq+dO88qTtguWxSCbCkLdU0pC+WtqJKSxpontQFMKMtFRm2oANNmY5swqlhlVRoG2poHA9atTOyPOB5nRr25Cg67agaW6RpMo5dZRoFZm0bz7J5F6Yu15eQMtn1asNFJmvz94FlPoEdF5k54LosMshjQEiZV3m0cGYQSGQInAJrBMD3USp72Pr7/AKjwMjhZxFjYwAAAABJRU5ErkJggg==";

/** 解码内嵌 base64 为字节——供 Image.fromBytes 创建 tray 图标。 */
export function trayIconBytes(): Uint8Array {
  const binary = atob(TRAY_ICON_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

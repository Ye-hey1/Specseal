export type Platform = "macos" | "windows" | "linux";

/** 平台侦测（design D1）：以 UA 判定——无 os plugin，前端自足且可测；非浏览器环境回 linux。 */
export function detectPlatform(ua?: string): Platform {
  const source =
    ua ??
    (typeof navigator === "undefined"
      ? ""
      : navigator.userAgent || (navigator as { platform?: string }).platform || "");
  if (/Macintosh|Mac OS/i.test(source)) return "macos";
  if (/Windows/i.test(source)) return "windows";
  return "linux";
}

/** 快捷键标签的修饰键：macOS 为 ⌘，其余为 Ctrl+（菜单与按钮的快捷键提示共用）。 */
export const modKey = (platform: Platform) => (platform === "macos" ? "⌘" : "Ctrl+");

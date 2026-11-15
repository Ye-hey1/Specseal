// 品牌标记与字标（spec desktop-app「共用组件唯一来源」；design D8）：资产只在
// packages/ui/src/assets/ 一处，换 Logo 只换那三个 SVG。
import mark from "../assets/logo-mark.svg?raw";
import horizontal from "../assets/logo-horizontal.svg";
import horizontalDark from "../assets/logo-horizontal-dark.svg";
import { cn } from "../lib/utils";

/**
 * 裸标记：SVG 以 currentColor 内嵌，颜色跟 text-primary 走（浅色主色 teal、深色浅青绿）。
 * `mark` 是 `?raw` 导入的建置期常数，不经任何运行期输入，可安全内嵌。
 */
export function BrandMark({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <span
      role="img"
      aria-label="Specseal"
      className={cn("inline-block text-primary [&>svg]:h-full [&>svg]:w-auto", className)}
      style={{ height: size }}
      dangerouslySetInnerHTML={{ __html: mark }}
    />
  );
}

/** 横式锁版字标：深色时取深色版；高度由调用端给（例如 h-5）。两版各一张、以 dark: 切换——
 *  dark: 与深色 token 同一套触发（theme.css），明示外观也跟得上；<picture media> 只看系统偏好。
 *  隐藏的那张 display:none，不进无障碍树。 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <>
      <img src={horizontal} alt="Specseal" className={cn("w-auto dark:hidden", className)} />
      <img src={horizontalDark} alt="Specseal" className={cn("hidden w-auto dark:block", className)} />
    </>
  );
}

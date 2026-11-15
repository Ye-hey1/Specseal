// 三平台标题列（design D1／D6）：左侧标题列（图标列＋项目栏共用）与主区顶列，
// 两者整列可拖拽（deep：子树皆可拖、按钮等可点元素由 Tauri 自动排除）。
import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, Copy, Minus, Square, X } from "lucide-react";
import { Breadcrumbs, Button, cn, useI18n, type Crumb } from "@specseal/ui";

import type { Platform } from "../platform";

export function LeftTitleBar({
  title,
  path,
  menu,
  back,
  trailing,
}: {
  /** 纯文本标题（作用中项目名或「设置」）；零项目时不传。 */
  title?: string;
  /** hover 显示的完整路径。 */
  path?: string;
  /** 右端动作槽（项目动作菜单的「⋯」）。 */
  menu?: ReactNode;
  /** 取代标题的返回钮（项目设置模式的「← 项目设置」；desktop-settings-mode design D2）。 */
  back?: { label: string; onClick: () => void };
  /** 右端等宽小字（项目设置模式的项目名）。 */
  trailing?: ReactNode;
}) {
  // 标题左缘对齐下方项目栏的导览文本：图标列 56＋项目栏内距 8＋导览项内距 10＋
  // 图标 16＋间距 8＝98px（macOS 红绿灯落在其左侧留白）。下缘细线与主区顶列
  // 同高，顶列成为横贯窗口的一条带，图标列分隔线从这条线往下。
  return (
    <div
      data-testid="left-titlebar"
      data-tauri-drag-region="deep"
      className="flex h-12 shrink-0 select-none items-center gap-1 border-b border-border pl-[98px] pr-2"
    >
      {back ? (
        // 返回钮的箭头对齐标题左缘：抵销按钮内距。
        <Button type="button" variant="ghost" size="sm" className="-ml-2.5 shrink-0" onClick={back.onClick}>
          <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
          {back.label}
        </Button>
      ) : (
        title && (
          <span title={path} className="min-w-0 flex-1 truncate text-sm font-medium">
            {title}
          </span>
        )
      )}
      {trailing && (
        <div title={path} className="ml-auto min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          {trailing}
        </div>
      )}
      {menu && <div className="ml-auto shrink-0">{menu}</div>}
    </div>
  );
}

export function MainTitleBar({
  platform,
  crumbs,
  leading,
  trailing,
}: {
  platform: Platform;
  crumbs: Crumb[];
  /** 面包屑之前的槽（详情页的返回钮）。 */
  leading?: ReactNode;
  /** 面包屑之后、Windows 窗口钮之前的槽（详情页的 ‹ n／m ›）。 */
  trailing?: ReactNode;
}) {
  return (
    <div
      data-testid="main-titlebar"
      data-tauri-drag-region="deep"
      className="flex h-12 shrink-0 select-none items-center border-b border-border bg-background pl-5"
    >
      {leading}
      <Breadcrumbs crumbs={crumbs} />
      {trailing}
      {platform === "windows" && <WindowControls />}
    </div>
  );
}

/** Windows 自绘窗口钮：API 被拒（权限缺）时按钮无效、只记 console.error。 */
export function WindowControls() {
  const { t } = useI18n();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    let disposed = false;
    const sync = () =>
      win
        .isMaximized()
        .then((m) => {
          if (!disposed) setMaximized(m);
        })
        .catch(console.error);
    void sync();
    const unlisten = win.onResized(() => void sync()).catch(() => null);
    return () => {
      disposed = true;
      void unlisten.then((u) => u?.());
    };
  }, []);
  const run = (action: "minimize" | "toggleMaximize" | "close") => () =>
    void getCurrentWindow()[action]().catch(console.error);
  const btn = "flex h-12 w-[46px] items-center justify-center text-foreground";
  return (
    <div className="flex shrink-0 self-stretch">
      <button
        type="button"
        aria-label={t("titlebar.minimize")}
        className={cn(btn, "hover:bg-muted")}
        onClick={run("minimize")}
      >
        <Minus className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label={t(maximized ? "titlebar.restore" : "titlebar.maximize")}
        className={cn(btn, "hover:bg-muted")}
        onClick={run("toggleMaximize")}
      >
        {maximized ? <Copy className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        aria-label={t("titlebar.close")}
        className={cn(btn, "hover:bg-destructive hover:text-white")}
        onClick={run("close")}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

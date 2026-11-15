import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** 栏的色相组（图标、色相条、图标色、计数徽章色），全部取 stage.ts 的 stage-* token。 */
export interface ColumnTone {
  icon: LucideIcon;
  bar: string;
  iconCls: string;
  badge: string;
}

/**
 * 看板栏的容器卡（desktop-board-reskin design D1）：白底细框 16px 圆角，顶端 3px 色相条、
 * 白底标头（色相图标、栏名、计数）下细线、卡片区铺侧栏淡灰并于栏内纵向卷动——与设置页、
 * 系统匣面板同一套容器规则。阶段栏与讨论栏共用，栏外观只在这里定义。
 *
 * 栏容器不作 droppable：跨栏放开为弹回＋零写入（spec「跨栏拖曳不改变变更阶段」），
 * isOver 高亮会假示可跨栏放置；唯一的栏外落点是封存浮层。
 */
export function BoardColumn({
  id,
  title,
  tone,
  count,
  empty,
  footer,
  children,
}: {
  /** data-column 值：阶段名或 "discussions"。 */
  id: string;
  title: string;
  tone: ColumnTone;
  /** 计数徽章；null＝计数未知（首访加载中或失败），显示 0 会谎报空，徽章整个不出。 */
  count: number | null;
  /** 卡片区顶端的置中灰字空文案；null＝不显示。 */
  empty: string | null;
  /** 栏底固定区（讨论栏的已转出展开区与收合列），不随卡片区卷动。 */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const Icon = tone.icon;
  return (
    <div
      data-column={id}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-sidebar"
    >
      <div className={`h-[3px] shrink-0 ${tone.bar}`} />
      <div className="flex items-center gap-2 bg-card px-3 py-2.5 border-b border-border/70 shrink-0">
        <Icon className={`h-3.5 w-3.5 ${tone.iconCls}`} />
        <h2 className="text-xs font-semibold text-foreground">{title}</h2>
        <div className="flex-1" />
        {count !== null && (
          <span
            data-testid="column-count"
            className={`inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full text-[11px] font-semibold tabular-nums ${tone.badge}`}
          >
            {count}
          </span>
        )}
      </div>
      {/* relative：卡片内的 absolute 元素以本卷动区为定位容器、受它裁切，不跳出去撑高外层。 */}
      <div className="relative flex-1 min-h-0 overflow-y-auto flex flex-col gap-2 p-2">
        {empty !== null && <p className="px-2 py-6 text-center text-xs text-muted-foreground">{empty}</p>}
        {children}
      </div>
      {footer}
    </div>
  );
}

import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

/** 页标题区（design D6）：24px 一般字重标题＋灰字说明，右侧动作槽与标题底缘对齐。
 *  `level` 只换标签不换样式：desktop 页标题在 app 标题之下用 h2；server 后台没有外层标题，用 h1。
 *  并排放不下时动作槽换到标题下方一列、槽内控件再各自换行（server-web-list-pages design D1）；
 *  标题栏以 16rem 为换行基准，长说明照旧在栏内折行，不会因说明长就把动作挤下去。
 *  `badge` 接在标题文本后面同一列（详情页的状态签，server-web-detail-pages design D8）；
 *  不给时 DOM 与加槽前相同。 */
function PageHeader({
  title,
  description,
  actions,
  badge,
  level = 2,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  badge?: ReactNode;
  level?: 1 | 2;
  className?: string;
}) {
  const Heading = level === 1 ? "h1" : "h2";
  const heading = <Heading className="text-2xl font-normal">{title}</Heading>;
  return (
    <div data-page-header className={cn("flex shrink-0 flex-wrap items-end justify-between gap-3", className)}>
      <div className="min-w-0 grow basis-64">
        {badge ? (
          <div className="flex items-center gap-2">
            {heading}
            {badge}
          </div>
        ) : (
          heading
        )}
        {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">{actions}</div>}
    </div>
  );
}

export { PageHeader };

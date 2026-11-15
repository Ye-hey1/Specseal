import type { ReactNode, Ref } from "react";

import { Card } from "./ui/card";

export interface ListCardProps {
  /** 卡顶槽（已封存页的卡片标头式分页列）；有它时内容卡以 Card 的 attached="top" 接在其下。 */
  header?: ReactNode;
  /** 卡底固定槽（换页工具列）；槽本身不画分隔线——分隔线属工具列，工具列不渲染时卡底不留空线。 */
  footer?: ReactNode;
  children: ReactNode;
  /** 内容卷动容器（data-list-scroll）——换页后卷回顶部、聚焦列卷入窗口的目标。 */
  scrollRef?: Ref<HTMLDivElement>;
}

/**
 * 列表卡（spec desktop-app「清单最新在前与换页浏览」；design D1）：白底细框容器填满
 * 主区剩余高度，列在卡内纵向卷动，header／footer 固定不随列卷动。header 为
 * Tabs card variant 的分页列时，内容卡依该原语的既定接法去掉上圆角与上框线。
 */
export function ListCard({ header, footer, children, scrollRef }: ListCardProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <Card
        data-list-card
        attached={header ? "top" : "none"}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <div ref={scrollRef} data-list-scroll className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </div>
        {footer && (
          <div data-list-footer className="shrink-0">
            {footer}
          </div>
        )}
      </Card>
    </div>
  );
}

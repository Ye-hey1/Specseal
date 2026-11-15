import type { ReactNode } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { Button, Card, EmptyState, Tabs, TabsList, type EmptyStateProps } from "@specseal/ui";
import { AdminError, AdminLoading } from "./states";

// 用户与项目两个区段共用的详情页骨架（server-web-detail-pages design D1、D5、D6）：区段的内层路由、
// 对不到数据时的说明，以及卡片标头分页接内容卡。

/** 区段的内层路由：index 是列表、`:<param>` 是详情页（数据未到时为加载中或可重试的错误），其他路径导回列表。 */
export function SectionRoutes({
  base,
  param,
  list,
  detail,
  error,
  onRetry,
}: {
  base: string;
  param: string;
  list: ReactNode;
  /** 数据已加载时的详情页；尚未加载时为 null。 */
  detail: ReactNode | null;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <Routes>
      <Route index element={list} />
      <Route
        path={`:${param}`}
        element={detail ?? (error != null ? <AdminError onRetry={onRetry} /> : <AdminLoading />)}
      />
      <Route path="*" element={<Navigate to={base} replace />} />
    </Routes>
  );
}

/** 网址对不到数据：说明找不到，附回到列表的按钮。 */
export function DetailNotFound({
  icon,
  title,
  body,
  backLabel,
  backTo,
}: {
  icon: EmptyStateProps["icon"];
  title: string;
  body: string;
  backLabel: string;
  backTo: string;
}) {
  const navigate = useNavigate();
  return (
    <EmptyState
      icon={icon}
      title={title}
      description={body}
      action={
        <Button type="button" variant="outline" onClick={() => navigate(backTo)}>
          {backLabel}
        </Button>
      }
    />
  );
}

/** 卡片标头分页：分页列为内容卡的顶部，窄屏幕时在卡内水平卷动；`children` 为各分页的 TabsContent。 */
export function DetailTabs({
  value,
  onValueChange,
  triggers,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  triggers: ReactNode;
  children: ReactNode;
}) {
  return (
    <Tabs value={value} onValueChange={onValueChange} className="flex flex-col">
      <TabsList variant="card" className="overflow-x-auto">
        {triggers}
      </TabsList>
      <Card attached="top">{children}</Card>
    </Tabs>
  );
}

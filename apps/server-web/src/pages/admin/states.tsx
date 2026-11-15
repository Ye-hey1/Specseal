import { Button, useI18n } from "@specseal/ui";

// 管理六页共用的加载／错误状态（D6：一致且可恢复）。标题属页面外壳、始终呈现，
// 数据层则以这两个状态呈现加载与可重试错误。
export function AdminLoading() {
  const { t } = useI18n();
  return (
    <p role="status" aria-live="polite" className="text-muted-foreground">
      {t("common.loading")}
    </p>
  );
}

export function AdminError({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div role="alert" className="space-y-2">
      <p className="text-destructive">{t("common.loadFailed")}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        {t("common.retry")}
      </Button>
    </div>
  );
}

/** 卡内分页的加载／错误状态：与设置型列同样的内距。 */
export function AdminCardState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return <div className="px-4 py-3">{error != null ? <AdminError onRetry={onRetry} /> : <AdminLoading />}</div>;
}

import { Component, type ReactNode } from "react";
import { Button, useI18n } from "@specseal/ui";

// route chunk 或 render 失败时显示可重试消息，而非白屏（D6）。route 数据层的
// 预期错误（fetch 失败）由页面 inline error 状态处理；此边界接住真正的 render crash。
//
// 边界本身必须是 class（只有 class 有 getDerivedStateFromError），class 不能用 hook，
// 所以文案交给下面这个 function component 读。
export class RouteErrorBoundary extends Component<
  { children: ReactNode },
  { error: unknown }
> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return <RenderFailed onRetry={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}

function RenderFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div role="alert" className="mx-auto max-w-md p-6 text-center">
      <p className="text-destructive">{t("common.renderFailed")}</p>
      <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        {t("common.retry")}
      </Button>
    </div>
  );
}

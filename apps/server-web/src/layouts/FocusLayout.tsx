import { Fragment, useRef, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { TriangleAlert } from "lucide-react";
import { Card, cn, SEMANTIC_SURFACE, SEMANTIC_TONE, StepProgress, useI18n, Wordmark } from "@specseal/ui";
import { SkipLink } from "../components/SkipLink";
import { UI_LOCALES, useLocalePreference } from "../i18n/LocaleContext";
import { useFocusMain } from "../lib/useFocusMain";

// 专注流程壳（登录／setup／邀请／激活；design D7）：画面正中一个大字标，下方一张与 Desktop
// 对话框同款的卡片（12px 圆角、15px 标题加灰字说明、页脚细在线方右侧为主要动作），卡片下方
// 是语言切换。卡片内的标题区、页脚与提示卡由下方三个小组件提供，四页共用。
export function FocusLayout({ children }: { children: ReactNode }) {
  const mainRef = useRef<HTMLElement>(null);
  const location = useLocation();
  useFocusMain(mainRef, location.pathname);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <SkipLink />
      <main id="main-content" ref={mainRef} className="flex w-[400px] max-w-full flex-col items-center gap-6">
        <Wordmark className="h-10" />
        <Card size="nested" className="flex w-full flex-col gap-4 p-5">
          {children}
        </Card>
        <LocaleToggle />
      </main>
    </div>
  );
}

// 登录前的语言切换：每种语言一个钮（跟随系统在登录后的帐号菜单里），与帐号菜单写入同一个
// 偏好。点目前已标示的语言不写入——跟随系统的人点了「中文」，偏好不该被悄悄固定下来。
function LocaleToggle() {
  const { t, locale } = useI18n();
  const { setPref } = useLocalePreference();
  return (
    <div role="group" aria-label={t("locale.label")} className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {UI_LOCALES.map(({ value, short }, i) => (
        <Fragment key={value}>
          {i > 0 && <span aria-hidden="true">·</span>}
          <button
            type="button"
            aria-pressed={locale === value}
            onClick={() => {
              if (locale !== value) setPref(value);
            }}
            className={cn(
              "rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              locale === value && "text-foreground",
            )}
          >
            {short}
          </button>
        </Fragment>
      ))}
    </div>
  );
}

/** 卡片标题区：15px 标题＋灰字说明；多步骤流程在上方加共用的步骤列（与 Desktop WorkspaceChooser 同一个组件）。 */
export function FocusHeader({
  title,
  description,
  step,
}: {
  title: string;
  description?: ReactNode;
  step?: { current: number; total: number; label: string };
}) {
  return (
    <div className="flex flex-col gap-1">
      {step && <StepProgress prefix={step.label} current={step.current} total={step.total} />}
      <h1 className="text-[15px] font-medium">{title}</h1>
      {description && <p className="text-[13px] text-muted-foreground">{description}</p>}
    </div>
  );
}

/** 卡片页脚：上缘细线、右对齐的按钮列。 */
export function FocusFooter({ children }: { children: ReactNode }) {
  return (
    <div data-focus-footer className="flex justify-end gap-2 border-t border-border pt-3.5">
      {children}
    </div>
  );
}

/** 链接无效与无权限的提示卡：警示色圆形图标、标题与说明，整块以 role=alert 声明。 */
export function FocusNotice({ title, body }: { title: string; body: string }) {
  return (
    <div role="alert" className="flex gap-3">
      <span
        className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full border", SEMANTIC_SURFACE.warning)}
      >
        <TriangleAlert aria-hidden="true" className={cn("h-4 w-4", SEMANTIC_TONE.warning)} />
      </span>
      <div className="min-w-0">
        <FocusHeader title={title} description={body} />
      </div>
    </div>
  );
}

import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  CopyButton,
  SEMANTIC_SURFACE,
  SEMANTIC_TONE,
  cn,
  useI18n,
} from "@specseal/ui";
import { FocusFooter } from "../layouts/FocusLayout";
import { readFormError } from "../lib/formError";

// 创建类动作的置中对话框（server-web-detail-pages design D4，取代从侧边滑出的面板）：与 Desktop 添加项目对话框
// 同款——12px 圆角、15px 标题加灰字说明、页脚细在线方右侧为主要动作。AlertDialog 的原生行为：Esc 与
// 取消关闭、点遮罩不关闭（不会误触丢掉输入）、关闭后焦点回到打开它的按钮；内容里的下拉列表挂进
// 对话框自己。`done` 为已创建状态：标题左侧换成绿系勾号，内容改放 SecretDone。

export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  done = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  done?: boolean;
  children: ReactNode;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="w-[520px]" {...(description ? {} : { "aria-describedby": undefined })}>
        <div className="flex items-start gap-3">
          {done && (
            <span
              aria-hidden="true"
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
                SEMANTIC_SURFACE.success,
                SEMANTIC_TONE.success,
              )}
            >
              <Check className="h-4 w-4" />
            </span>
          )}
          <AlertDialogHeader className="min-w-0 flex-1">
            <AlertDialogTitle>{title}</AlertDialogTitle>
            {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
          </AlertDialogHeader>
        </div>
        {children}
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * 对话框表单的送出状态：送出中挡住重复送出；失败时读出可公开的消息与字段错误，输入不动
 * （对话框保持打开、保留输入）。`run` 成功后由调用端决定关闭或换成已创建状态。
 */
export function useDialogSubmit(fallback: string) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(run: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setMessage(null);
    setFieldErrors({});
    try {
      await run();
    } catch (error) {
      const read = readFormError(error, fallback);
      setMessage(read.message);
      setFieldErrors(read.fieldErrors);
    } finally {
      setPending(false);
    }
  }

  return { pending, message, fieldErrors, submit };
}

/** 表单底部的非字段错误；有字段错误时由字段自己以 role=alert 呈现。 */
export function FormMessage({ message, fieldErrors }: { message: string | null; fieldErrors: Record<string, string> }) {
  if (!message || Object.keys(fieldErrors).length > 0) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

/** 表单页脚：取消与送出，细在线方右侧排列（与专注流程卡的页脚同一个组件）。 */
export function FormDialogActions({
  submitLabel,
  pending,
  disabled = false,
  onCancel,
}: {
  submitLabel: string;
  pending: boolean;
  disabled?: boolean;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <FocusFooter>
      <Button type="button" variant="ghost" onClick={onCancel}>
        {t("common.cancel")}
      </Button>
      <Button type="submit" disabled={pending || disabled}>
        {submitLabel}
      </Button>
    </FocusFooter>
  );
}

/** 已创建状态的内容：只显示一次的秘密值放在绿系成功框（以 aria-live 声明）并附拷贝，页脚只有「完成」。
 *  标题与说明由所在的 FormDialog（`done`）呈现。 */
export function SecretDone({
  value,
  copyLabel,
  note,
  onDone,
}: {
  value: string;
  copyLabel: string;
  note?: string;
  onDone: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <div
        role="status"
        aria-live="polite"
        className={cn("flex items-start gap-3 rounded-xl border p-3", SEMANTIC_SURFACE.success)}
      >
        <code className="min-w-0 flex-1 break-all font-mono text-[13px]">{value}</code>
        <CopyButton size="sm" value={value} label={copyLabel} />
      </div>
      {note && <p className="m-0 text-xs text-muted-foreground">{note}</p>}
      <FocusFooter>
        <Button type="button" onClick={onDone}>
          {t("common.done")}
        </Button>
      </FocusFooter>
    </>
  );
}

// 两键式确认框（取消＋确认；spec desktop-app「共用组件唯一来源」、design D7）：
// 外观只此一份，文案与状态由调用端以属性提供。三选项以上的对话框各自组 AlertDialog。
import type { ReactNode } from "react";

import { useI18n } from "../../i18n";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog";
import { buttonVariants } from "./button";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  /** 缺省 i18n `common.cancel`。 */
  cancelLabel?: string;
  /** 确认钮用 destructive 变体（实心红）。 */
  destructive?: boolean;
  /** 动作进行中：确认钮与取消钮都不可按。 */
  busy?: boolean;
  /** 只停用确认钮（例如远程能力不支持该动作）；取消照常可按。 */
  confirmDisabled?: boolean;
  /** 按下确认后对话框随即关闭（onOpenChange(false)）；在此之前先同步调用。 */
  onConfirm: () => void | Promise<void>;
  /** 标题与说明之后、按钮之前的额外内容（如工具多选）。 */
  children?: ReactNode;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = false,
  busy = false,
  confirmDisabled = false,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description !== undefined && (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{cancelLabel ?? t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className={destructive ? buttonVariants({ variant: "destructive" }) : undefined}
            disabled={busy || confirmDisabled}
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

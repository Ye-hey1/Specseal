import { useI18n } from "../i18n";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogCancel,
} from "./ui/alert-dialog";
import { SEMANTIC_TONE } from "../tone";
import { Button } from "./ui/button";

export interface ReviewArchiveDialogProps {
  open: boolean;
  /** 要封存的 change 名称（对话框文案带出）。 */
  change: string | null;
  /** 哪一个品质站的工单未结；缺省审查站。两站工单并存时由宿主依序各弹一次
   * （spec「封存入口三选项扩及验证工单」：分别处置后才封存）。 */
  station?: "review" | "verify";
  onOpenChange: (open: boolean) => void;
  /** 前往完成盖章：不封存，导引用户收尾审查（宿主通常打开详情抽屉）。 */
  onGoStamp: () => void;
  /** 放弃审查后封存（等同 `review discard` 再 archive）。 */
  onDiscardReview: () => void;
  /** 照样带走（等同 `archive --carry-review`）：永久显示「曾审查未通过」。 */
  onCarryReview: () => void;
}

/** 封存入口的未结工单三选项对话框（spec「封存入口的未结工单三选项」；design
 * D6）：目标 change 审查中（工单未结）时取代一般封存确认；未选择前不运行任何
 * 封存。 */
export function ReviewArchiveDialog({
  open,
  change,
  station = "review",
  onOpenChange,
  onGoStamp,
  onDiscardReview,
  onCarryReview,
}: ReviewArchiveDialogProps) {
  const { t } = useI18n();
  // 站别只换词条前缀——版面、选项数与危险动作分工两站一致。
  const k = (name: string) => `${station}.${name}`;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(k("archiveGateTitle"))}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(k("archiveGateDesc")).replace("{name}", change ?? "")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col gap-2 sm:flex-col sm:items-stretch sm:space-x-0">
          <Button onClick={onGoStamp}>{t(k("goStamp"))}</Button>
          <Button variant="outline" onClick={onDiscardReview}>
            {t(k("discardReview"))}
          </Button>
          {/* 危险动作走 destructive；rose 专属「曾审查未通过」的永久标示（三红分工）。 */}
          <Button variant="outline" className={SEMANTIC_TONE.danger} onClick={onCarryReview}>
            {t(k("carryReview"))}
          </Button>
          <AlertDialogCancel>{t(k("cancel"))}</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

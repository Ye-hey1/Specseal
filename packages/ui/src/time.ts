import type { Translator } from "./i18n";

/** 相对时间（天级即可；日期通常是 YYYY-MM-DD）。翻译函数由调用端注入；无日期回 null、
 * 不可解析原样回传（可见的失败，非静默错值）。差 1 天回「昨天」，所以 `time.daysAgo` 实际只在
 * 2 天以上出现——它的 `.one` 是字典守门要求的完整性，不会显示。 */
export function relativeDays(date: string | null | undefined, { t, tn }: Translator): string | null {
  if (!date) return null;
  const parsed = Date.parse(date);
  if (Number.isNaN(parsed)) return date;
  const days = Math.floor((Date.now() - parsed) / 86_400_000);
  if (days <= 0) return t("time.today");
  if (days === 1) return t("time.yesterday");
  return tn("time.daysAgo", days);
}

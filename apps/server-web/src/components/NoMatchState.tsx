import { SearchX } from "lucide-react";
import { EmptyState, useI18n } from "@specseal/ui";

/** 筛选后没有符合项目——消息与图标都刻意与「这份清单本来就空」区分开，且不给创建动作：
 *  该情况要改的是筛选，不是创建（server-web-console「管理列表提供搜索、筛选、分页与具引导的空状态」）。 */
export function NoMatchState() {
  const { t } = useI18n();
  return <EmptyState icon={SearchX} title={t("common.noMatchTitle")} description={t("common.noMatchHint")} />;
}

import { StatusPill, useI18n } from "@specseal/ui";

/** 凭证与登录工作阶段的状态签：有效为绿系、已撤销为中性（撤销不可逆，得一眼看出哪一把还活着）。 */
export function RevocationPill({ revokedAt }: { revokedAt: string | null }) {
  const { t } = useI18n();
  return (
    <StatusPill tone={revokedAt ? "neutral" : "success"}>
      {revokedAt ? t("common.revoked") : t("common.active")}
    </StatusPill>
  );
}

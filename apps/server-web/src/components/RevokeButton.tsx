import { Button, REVEAL_ON_GROUP_HOVER, useI18n } from "@specseal/ui";

/** 撤销钮（server-web-list-pages design D8）：访问密钥与设备登录列上滑过才出现。显隐只用不透明度——
 *  隐藏期间仍在 Tab 顺序内、屏幕阅读器读得到；键盘聚焦时出现；没有鼠标移入能力的设备恒常显示。
 *  所在列要带 `group`（ListRow、SettingsRow 都有）。 */
export function RevokeButton({
  label,
  disabled,
  onClick,
}: {
  /** 无障碍名称，指名要撤销的对象。 */
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={REVEAL_ON_GROUP_HOVER}
    >
      {t("common.revoke")}
    </Button>
  );
}

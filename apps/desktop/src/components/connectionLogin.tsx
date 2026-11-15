// 连接登录的共用回馈组件（design 决策三）：等待授权面与 PAT 输入由服务器页签
// 的连接列与工作区选择器的添加并登录区共用——登录回馈跟着发起登录的接口走，
// 两处无重复实作。credential 不经此层：PAT 仅单次过境 onSubmit。
import { useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Button, CopyButton, Input, SEMANTIC_TONE, useI18n } from "@specseal/ui";

import type { LoginPhase } from "../adapter/connections";

/** 授权有效期限的剩余时间（分:秒）：以截止时刻减现在时间计算、每秒更新，
 * 不依赖轮询节奏（design 决策三）；归零即停在 0:00。 */
function Countdown({ expiresAt }: { expiresAt: number }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const time = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return (
    <span className="text-xs text-muted-foreground">
      {t("servers.timeLeft").replace("{time}", time)}
    </span>
  );
}

/** 等待面里的一列：标签、内容与拷贝钮。设备码要人照着输入，字放大并拉开字距。 */
function CopyRow({
  label,
  value,
  copyLabel,
  code = false,
}: {
  label: string;
  value: string;
  copyLabel: string;
  code?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {code ? (
        <code className="font-mono text-sm tracking-widest">{value}</code>
      ) : (
        <span className="min-w-0 truncate font-mono text-xs">{value}</span>
      )}
      <CopyButton size="sm" label={copyLabel} value={value} onCopy={writeText} />
    </div>
  );
}

/** 登录等待面（规格「device login 缺省与 PAT fallback」；client-browser-login D9）：
 * 标题、一句说明、可拷贝的内容、倒数与取消。等待设备核准时是设备码与验证网址
 * ——用户无需依赖已打开的分页即可换设备核准；等待浏览器登录时是授权网址——
 * 浏览器没有自动打开时自己拷贝去开（网址只带 state 与 challenge，不含任何
 * credential）。服务器页的连接列与工作区选择器共用这一个组件。 */
export function LoginWaiting({
  origin,
  phase,
  onCancel,
}: {
  origin: string;
  phase: LoginPhase;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const browser = phase.kind === "awaitingBrowser";
  return (
    <div
      className="flex flex-col gap-1.5"
      data-testid={`${browser ? "awaiting-browser" : "awaiting-approval"}-${origin}`}
    >
      <div className="text-xs font-medium">
        {t(browser ? "servers.awaitingBrowserTitle" : "servers.awaitingTitle")}
      </div>
      <p className="m-0 text-xs text-muted-foreground">
        {t(browser ? "servers.awaitingBrowserHint" : "servers.awaitingHint")}
      </p>
      {phase.kind === "awaitingBrowser" ? (
        <CopyRow
          label={t("servers.authorizationUrl")}
          value={phase.url}
          copyLabel={t("servers.copyAuthorizationUrl")}
        />
      ) : (
        <>
          <CopyRow
            code
            label={t("servers.deviceCode")}
            value={phase.userCode}
            copyLabel={t("servers.copyDeviceCode")}
          />
          <CopyRow
            label={t("servers.verificationUri")}
            value={phase.verificationUri}
            copyLabel={t("servers.copyVerificationUri")}
          />
        </>
      )}
      <div className="flex items-center gap-3">
        <Countdown expiresAt={phase.expiresAt} />
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          {t("servers.cancelLogin")}
        </Button>
      </div>
    </div>
  );
}

/** PAT 输入（规格 PAT fallback）：草稿只存在提交前的组件状态，提交即清空
 * ——单次过境，不留任何拷贝。 */
export function PatLoginInput({
  error,
  onSubmit,
}: {
  error: string | null;
  onSubmit: (pat: string) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");

  function submit() {
    const pat = draft.trim();
    if (!pat) return;
    setDraft("");
    onSubmit(pat);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <p className="m-0 text-xs text-muted-foreground">{t("servers.patHint")}</p>
      <div className="flex items-center gap-1.5">
        <Input
          type="password"
          placeholder={t("servers.patPlaceholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="button" size="sm" onClick={submit}>
          {t("servers.patSubmit")}
        </Button>
      </div>
      {error && (
        <span role="alert" className={`text-xs ${SEMANTIC_TONE.danger}`}>
          {error}
        </span>
      )}
    </div>
  );
}

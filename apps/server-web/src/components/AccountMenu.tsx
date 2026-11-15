import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronsUpDown, LogOut, UserRound } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  useI18n,
  type LocalePreference,
} from "@specseal/ui";
import { useClient, useSession } from "../app/context";
import { UI_LOCALES, useLocalePreference } from "../i18n/LocaleContext";
import { userLabel } from "../lib/userLabel";

// 侧栏底部的帐号菜单（design D2）：触发钮显示自己是谁，菜单收帐号、接口语言与注销。

/** 跟随系统在 LocalePreference 里是 null，但 Radix 单选项的 value 不接受空字符串。 */
const SYSTEM = "__system__";

export function AccountMenu({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  const client = useClient();
  const { session, refresh } = useSession();
  const { pref, setPref } = useLocalePreference();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const user = session.user;
  if (!user) return null;
  const name = userLabel(user);

  // 注销：撤销 server session、reload 角色真相、导向 server 回传的去处；失败也回登录页，
  // 不留在仍显示帐号信息的壳。
  async function logout() {
    setPending(true);
    try {
      const { destination } = await client.logout();
      await refresh();
      navigate(destination);
    } catch {
      navigate("/login");
    } finally {
      setPending(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("shell.accountMenu").replace("{name}", () => name)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/12 text-xs font-medium text-primary"
        >
          {Array.from(name)[0]}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px]">{name}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{user.email}</span>
        </span>
        <ChevronsUpDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start">
        <DropdownMenuLabel>
          <span className="block truncate text-[13px] text-foreground">{name}</span>
          <span className="block truncate">
            {`${user.email} · ${t(user.admin ? "users.roleAdmin" : "users.roleMember")}`}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            onNavigate?.();
            navigate("/account");
          }}
        >
          <UserRound aria-hidden="true" />
          {t("account.title")}
        </DropdownMenuItem>
        <DropdownMenuLabel>{t("locale.label")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={pref ?? SYSTEM}
          onValueChange={(v) => setPref(v === SYSTEM ? null : (v as LocalePreference))}
        >
          {UI_LOCALES.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.name}
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuRadioItem value={SYSTEM}>{t("locale.followSystem")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={pending} onSelect={() => void logout()}>
          <LogOut aria-hidden="true" />
          {t("shell.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

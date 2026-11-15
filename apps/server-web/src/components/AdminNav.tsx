import { NavLink, useMatch } from "react-router-dom";
import {
  Activity,
  FolderGit2,
  KeyRound,
  LayoutDashboard,
  ScrollText,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import { NavItem, useI18n } from "@specseal/ui";

// 管理导览的六个固定目的地，分为日常与维运两组。帐号不是管理员的侧栏目的地——入口在
// 侧栏底部的帐号菜单（AccountMenu）；一般成员的导览只有帐号一项（MemberNav）。导览项是
// 共用 NavItem（design D4），与 Desktop 项目栏同一份。tour 是首次导览的目标标记
// （components/Tour.tsx）；每个管理目的地一步。
type Destination = { to: string; labelKey: string; icon: LucideIcon; tour?: string; end?: boolean };

const PRIMARY: Destination[] = [
  { to: "/admin", labelKey: "nav.overview", icon: LayoutDashboard, tour: "nav-overview", end: true },
  { to: "/admin/users", labelKey: "nav.users", icon: Users, tour: "nav-users" },
  { to: "/admin/registry", labelKey: "nav.registry", icon: FolderGit2, tour: "nav-registry" },
];

const OPERATIONS: Destination[] = [
  { to: "/admin/credentials", labelKey: "nav.credentials", icon: KeyRound, tour: "nav-credentials" },
  { to: "/admin/system", labelKey: "nav.system", icon: Activity, tour: "nav-system" },
  { to: "/admin/audit", labelKey: "nav.audit", icon: ScrollText, tour: "nav-audit" },
];

/** 管理目的地（面包屑依路径取名称用，与侧栏同一份表）。 */
export const ADMIN_DESTINATIONS = [...PRIMARY, ...OPERATIONS];

const MEMBER: Destination[] = [{ to: "/account", labelKey: "account.title", icon: UserRound }];

/** 作用中与否以 NavLink 同一套比对（含 end）决定，交给 NavItem 套样式。 */
function Item({
  to,
  labelKey,
  icon: Icon,
  tour,
  end,
  onNavigate,
}: Destination & { onNavigate?: () => void }) {
  const { t } = useI18n();
  const active = useMatch({ path: to, end: end ?? false }) !== null;
  return (
    <NavItem asChild active={active} icon={<Icon aria-hidden="true" />} label={t(labelKey)}>
      <NavLink to={to} end={end} data-tour={tour} onClick={onNavigate} />
    </NavItem>
  );
}

function Group({ items, onNavigate }: { items: Destination[]; onNavigate?: () => void }) {
  return (
    <ul className="space-y-1">
      {items.map((item) => (
        <li key={item.to}>
          <Item {...item} onNavigate={onNavigate} />
        </li>
      ))}
    </ul>
  );
}

export function AdminNav({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  return (
    <>
      <Group items={PRIMARY} onNavigate={onNavigate} />
      {/* 分组标签而非可点目的地：维运三项与日常三项视觉分离（proposal 版面蓝图）。 */}
      <p className="mt-3 border-t border-border px-3 pb-1 pt-3 text-xs font-medium tracking-wide text-muted-foreground">
        {t("shell.operations")}
      </p>
      <Group items={OPERATIONS} onNavigate={onNavigate} />
    </>
  );
}

export function MemberNav({ onNavigate }: { onNavigate?: () => void }) {
  return <Group items={MEMBER} onNavigate={onNavigate} />;
}

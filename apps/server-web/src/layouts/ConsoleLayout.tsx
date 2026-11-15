import { useRef, useState, type ReactNode } from "react";
import { matchPath, useLocation, useNavigate } from "react-router-dom";
import { Menu } from "lucide-react";
import {
  Breadcrumbs,
  Button,
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
  useI18n,
  Wordmark,
  type Crumb,
} from "@specseal/ui";
import { SkipLink } from "../components/SkipLink";
import { ADMIN_DESTINATIONS, AdminNav, MemberNav } from "../components/AdminNav";
import { AccountMenu } from "../components/AccountMenu";
import { TourProvider } from "../components/Tour";
import { useSession } from "../app/context";
import { useFocusMain } from "../lib/useFocusMain";
import { useNarrow } from "../lib/useMediaQuery";
import { DetailTitleProvider } from "./DetailTitle";

// 主控台壳（design D1）：管理员与一般成员同一种形状——侧栏（顶端字标、中段导览、底部
// 帐号菜单）加主栏（顶列面包屑、下方主内容），没有横贯顶部的 header。导览依 session 的
// admin 旗标裁切（服务器回传的角色真相，前端不自行推导）：管理员六个目的地，一般成员只有
// 帐号一项。管理员在 /account 时侧栏整条保留但无项目高亮。
//
// ≥1024px 显示固定侧栏；更窄时改由顶列的「打开导览」钮开出从左滑出、内容相同的 Sheet，
// 关闭后 focus 回到触发钮（Radix 缺省处理）。顶列高度、侧栏宽度与主内容内距采用 Desktop
// 应用程序壳的数值（h-12／w-[200px]／p-5）。
export function ConsoleLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const mainRef = useRef<HTMLElement>(null);
  const location = useLocation();
  const { session } = useSession();
  // ‹ › 在同一区段的详情页之间切换时焦点留在导览钮上，键盘才能连按；其他换页把焦点移到页标题。
  const detailMatch = matchPath("/admin/:section/:item", location.pathname);
  useFocusMain(mainRef, detailMatch ? `/admin/${detailMatch.params.section}/*` : location.pathname);
  const narrow = useNarrow();
  const [sheetOpen, setSheetOpen] = useState(false);
  // 详情页交出的面包屑第三段与 ‹ n / m › 的插槽（server-web-detail-pages design D2）。
  const [detailLabel, setDetailLabel] = useState<string | null>(null);
  const [detailSlot, setDetailSlot] = useState<HTMLElement | null>(null);
  const admin = session.user?.admin === true;
  // 路径比对与路由、侧栏高亮同一套（matchPath：不分大小写、容许结尾斜线）。
  const inAdmin = matchPath({ path: "/admin", end: false }, location.pathname) !== null;
  const crumbs = useCrumbs(location.pathname, inAdmin, detailLabel);

  return (
    // 满高栏式版面：壳本身固定满版不卷动，只有主内容区卷——与 Desktop 壳同结构。
    // 若让整页卷，侧栏与顶列会跟着滚出画面，导览就不再是恒常可见的。
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <SkipLink />
      {!narrow && (
        <aside className="flex w-[200px] shrink-0 flex-col border-r border-border bg-sidebar">
          <SidebarBody admin={admin} />
        </aside>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-5">
          {narrow && (
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="-ml-2 shrink-0" aria-label={t("shell.openNav")}>
                  <Menu aria-hidden="true" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" aria-describedby={undefined} className="w-[280px] gap-0 p-0">
                <SheetTitle className="sr-only">{t("shell.nav")}</SheetTitle>
                <SidebarBody admin={admin} onNavigate={() => setSheetOpen(false)} />
              </SheetContent>
            </Sheet>
          )}
          <Breadcrumbs crumbs={crumbs} />
          <div ref={setDetailSlot} className="ml-auto flex shrink-0 items-center" />
        </div>
        <main id="main-content" ref={mainRef} className="min-w-0 flex-1 overflow-y-auto p-5">
          {/* 导览只在管理面启动：帐号页没有侧栏目的地可指，一般成员更看不到管理面。 */}
          <TourProvider enabled={admin && inAdmin}>
            <DetailTitleProvider setLabel={setDetailLabel} slot={detailSlot}>
              {children}
            </DetailTitleProvider>
          </TourProvider>
        </main>
      </div>
    </div>
  );
}

/** 侧栏与窄屏幕 Sheet 共用的内容：字标、该角色的导览、帐号菜单。 */
function SidebarBody({ admin, onNavigate }: { admin: boolean; onNavigate?: () => void }) {
  const { t } = useI18n();
  return (
    <>
      <div className="flex h-12 shrink-0 items-center border-b border-border px-4">
        <Wordmark className="h-5" />
      </div>
      <nav aria-label={t(admin ? "shell.adminNav" : "shell.nav")} className="min-h-0 flex-1 overflow-y-auto p-2">
        {admin ? <AdminNav onNavigate={onNavigate} /> : <MemberNav onNavigate={onNavigate} />}
      </nav>
      <div className="shrink-0 border-t border-border p-2">
        <AccountMenu onNavigate={onNavigate} />
      </div>
    </>
  );
}

/** 面包屑（design D4）：管理面为「后台 / <目的地>」且「后台」可点回总览，帐号页为「帐号」；
 *  未列在目的地表内的 /admin/* 路径只显示「后台」。详情页交出名称时为「后台 / <目的地> / <名称>」，
 *  目的地可点回列表（server-web-detail-pages design D2）。目的地依各自的 `end` 比对，详情页的
 *  网址也找得到所属目的地。 */
function useCrumbs(pathname: string, inAdmin: boolean, detailLabel: string | null): Crumb[] {
  const { t } = useI18n();
  const navigate = useNavigate();
  if (!inAdmin) return [{ label: t("account.title") }];
  const home: Crumb = { label: t("shell.console"), onClick: () => navigate("/admin") };
  const destination = ADMIN_DESTINATIONS.find((d) => matchPath({ path: d.to, end: d.end ?? false }, pathname));
  if (!destination) return [home];
  const label = t(destination.labelKey);
  return detailLabel
    ? [home, { label, onClick: () => navigate(destination.to) }, { label: detailLabel }]
    : [home, { label }];
}

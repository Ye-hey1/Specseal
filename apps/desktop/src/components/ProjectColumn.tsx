// 项目栏（design D4）：每项目的四页＋底部项目设置；点击即切页（无 toggle）。设置模式与
// 项目设置模式下由分类栏取代（desktop-settings-mode design D2）。底部的 notice 槽放技能档提示卡
// （desktop-notice-relocation design D1）：提示是这个项目的事，住在项目栏、不占主区。
import type { ReactNode } from "react";
import { Archive, BookOpen, FileText, GitBranch, SlidersHorizontal } from "lucide-react";
import { NavItem, useI18n } from "@specseal/ui";

import type { BoardView } from "../store";

export function ProjectColumn({
  boardView,
  archivedCount,
  onNavigate,
  notice,
}: {
  boardView: BoardView;
  archivedCount: number;
  onNavigate: (view: BoardView) => void;
  /** 弹性空白与项目设置项之间的提示卡（null＝无）。 */
  notice?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <nav aria-label={t("app.projectColumn")} className="flex w-[200px] shrink-0 flex-col gap-0.5 p-2 pb-3">
      <NavItem
        icon={<GitBranch />}
        label={t("app.navChanges")}
        active={boardView === "board"}
        onClick={() => onNavigate("board")}
      />
      <NavItem
        icon={<Archive />}
        label={t("app.archived")}
        ariaLabel={t("app.archived")}
        count={archivedCount}
        active={boardView === "archived"}
        onClick={() => onNavigate("archived")}
      />
      <NavItem
        icon={<FileText />}
        label={t("app.navSpecs")}
        active={boardView === "specs"}
        onClick={() => onNavigate("specs")}
      />
      <NavItem
        icon={<BookOpen />}
        label={t("app.navManual")}
        ariaLabel={t("app.navManual")}
        active={boardView === "manual"}
        onClick={() => onNavigate("manual")}
      />
      <div className="mt-auto flex flex-col gap-2">
        {notice}
        <NavItem
          icon={<SlidersHorizontal />}
          label={t("app.navProjectSettings")}
          active={boardView === "project-settings"}
          onClick={() => onNavigate("project-settings")}
        />
      </div>
    </nav>
  );
}

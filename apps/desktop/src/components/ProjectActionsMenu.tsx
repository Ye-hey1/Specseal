// 项目动作菜单（design D5）：一份项目，由标题列「⋯」的下拉列表与图标列方块的右键
// 菜单各自包一层渲染。remote 无 checkout 时没有本机目录，只剩刷新与关闭项目。
import { Code, Copy, FolderOpen, RefreshCw, SquareTerminal, X } from "lucide-react";
import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  MenuShortcut,
  useI18n,
} from "@specseal/ui";

import { projectDirOf } from "../adapter/fsActions";
import { modKey, type Platform } from "../platform";
import { locatorKey } from "../session";
import type { ProjectTab } from "../tabs";

export interface ProjectActions {
  reveal: (key: string) => void;
  openTerminal: (key: string) => void;
  openEditor: (key: string) => void;
  copyPath: (key: string) => void;
  refresh: (key: string) => void;
  close: (key: string) => void;
}

const PARTS = {
  dropdown: { Item: DropdownMenuItem, Label: DropdownMenuLabel, Separator: DropdownMenuSeparator },
  context: { Item: ContextMenuItem, Label: ContextMenuLabel, Separator: ContextMenuSeparator },
};

export function ProjectActionItems({
  menu,
  tab,
  platform,
  actions,
  error,
}: {
  menu: keyof typeof PARTS;
  tab: ProjectTab;
  platform: Platform;
  actions: ProjectActions;
  /** 错误变体：首列显示错误消息，其后只有「自项目列移除」。 */
  error?: string;
}) {
  const { t } = useI18n();
  const { Item, Label, Separator } = PARTS[menu];
  const key = locatorKey(tab.locator);
  if (error) {
    return (
      <>
        <Label className="max-w-72 truncate text-destructive">{error}</Label>
        <Item onSelect={() => actions.close(key)}>
          <X />
          <span>{t("app.removeTab")}</span>
        </Item>
      </>
    );
  }
  const dir = projectDirOf(tab.locator);
  const mod = modKey(platform);
  return (
    <>
      {dir && (
        <>
          <Item onSelect={() => actions.reveal(key)}>
            <FolderOpen />
            <span>{t(`fs.revealIn.${platform}`)}</span>
          </Item>
          <Item onSelect={() => actions.openTerminal(key)}>
            <SquareTerminal />
            <span>{t("fs.openTerminal")}</span>
          </Item>
          <Item onSelect={() => actions.openEditor(key)}>
            <Code />
            <span>{t("fs.openEditor")}</span>
          </Item>
          <Item onSelect={() => actions.copyPath(key)}>
            <Copy />
            <span>{t("fs.copyPath")}</span>
            <MenuShortcut className="max-w-28 truncate">
              {dir.split(/[\\/]/).filter(Boolean).pop()}
            </MenuShortcut>
          </Item>
          <Separator />
        </>
      )}
      <Item onSelect={() => actions.refresh(key)}>
        <RefreshCw />
        <span>{t("fs.refresh")}</span>
        <MenuShortcut>{mod}R</MenuShortcut>
      </Item>
      <Item variant="destructive" onSelect={() => actions.close(key)}>
        <X />
        <span>{t("fs.closeProject")}</span>
        <MenuShortcut>{mod}W</MenuShortcut>
      </Item>
    </>
  );
}

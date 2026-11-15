// 详情页阅读卡标题列右端的「打开 ▾」（design D4）：对目前分页的文件提供以缺省 App
// 打开、在文件管理员显示、拷贝路径；remote 无本机 checkout、或分页没有可定位的文件
// （已封存讨论）时只剩「拷贝内容」。
import { useRef, useState } from "react";
import { ChevronDown, Copy, ExternalLink, FileText, FolderOpen } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  useI18n,
  type DocumentRef,
  type DocumentTarget,
} from "@specseal/ui";

import type { DocumentLocation } from "../adapter/fsActions";
import type { Platform } from "../platform";

export function DocumentActionsMenu({
  target,
  local,
  platform,
  locate,
  onOpenDefault,
  onReveal,
  onCopyPath,
  onCopyContent,
}: {
  /** 分页对应的文档与已加载原文；null＝此分页没有文件（调度），整个菜单缺席；
   * `doc` 为 null＝只带原文（已封存讨论），菜单只有「拷贝内容」。 */
  target: DocumentTarget | null;
  /** 项目有本机目录（local 或已绑 checkout 的 remote）。 */
  local: boolean;
  platform: Platform;
  /** 文档的磁盘位置（宿主向 core 查找）；找不到为 null。 */
  locate: (doc: DocumentRef) => Promise<DocumentLocation | null>;
  onOpenDefault: (location: DocumentLocation) => void;
  onReveal: (location: DocumentLocation) => void;
  onCopyPath: (location: DocumentLocation) => void;
  onCopyContent: (text: string) => void;
}) {
  const { t } = useI18n();
  // 展开时才查位置（文档可能刚被封存搬走）；序号挡掉较早一次展开的过期回应。
  const [location, setLocation] = useState<DocumentLocation | null>(null);
  const seq = useRef(0);
  if (target === null) return null;
  const { content } = target;
  // 没有本机目录或没有可定位的文件时唯一的动作是拷贝原文；分页不载原文（工单）就没有可做的事。
  const fileDoc = local ? target.doc : null;
  if (!fileDoc && content === undefined) return null;

  const onOpenChange = (open: boolean) => {
    if (!open || !fileDoc) return;
    const mine = ++seq.current;
    setLocation(null);
    void locate(fileDoc).then((found) => {
      if (seq.current === mine) setLocation(found);
    });
  };

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1">
          <FileText className="h-3.5 w-3.5" />
          {t("detail.open")}
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {fileDoc ? (
          <>
            {location && (
              <DropdownMenuLabel className="max-w-80 truncate font-mono text-[11px] text-muted-foreground">
                {location.relative}
              </DropdownMenuLabel>
            )}
            <DropdownMenuItem disabled={!location} onSelect={() => location && onOpenDefault(location)}>
              <ExternalLink />
              <span>{t("detail.openDefault")}</span>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!location} onSelect={() => location && onReveal(location)}>
              <FolderOpen />
              <span>{t(`fs.revealIn.${platform}`)}</span>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!location} onSelect={() => location && onCopyPath(location)}>
              <Copy />
              <span>{t("fs.copyPath")}</span>
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem
            disabled={content === null}
            onSelect={() => {
              if (typeof content === "string") onCopyContent(content);
            }}
          >
            <Copy />
            <span>{t("detail.copyContent")}</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

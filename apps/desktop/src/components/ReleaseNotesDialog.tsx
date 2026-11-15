// 更新日志对话框（desktop-app spec「更新日志弹窗」）：同一个对话框两种模式——
// whatsNew（版号变更后首次启动自动弹出，标题「X.Y.Z 更新内容」、主钮「知道了」）与
// browse（设置页按钮打开，标题「更新日志」、列出全部条目、主钮「关闭」）。看过即止的
// 记录由 App 层在 onOpenChange 决定，这里只呈现（MigrationDialog 先例）。browse 模式可带
// focusVersion：打开后把该版卷到卷动区顶端（desktop-about-page design D8）。条目、分组标题与
// 版号小标依接口语言呈现（spec「更新日志依接口语言呈现」），切换语言即重绘。
import { useCallback } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  useI18n,
} from "@specseal/ui";

import { entryText, type ReleaseNotesEntry } from "../release-notes/release-notes";

export interface ReleaseNotesDialogProps {
  open: boolean;
  mode: "whatsNew" | "browse";
  entries: ReleaseNotesEntry[];
  /** browse 模式打开后卷到的版号（更新页旧版本列的「查看」）；不带或不在清单内时自顶端呈现。 */
  focusVersion?: string;
  onOpenChange: (open: boolean) => void;
}

export function ReleaseNotesDialog({ open, mode, entries, focusVersion, onOpenChange }: ReleaseNotesDialogProps) {
  const { t, locale } = useI18n();
  // callback ref：Radix 的 Portal 在打开后下一轮才挂上内容，effect 那时还拿不到节点；卷动区
  // 挂上（每次打开）时才找该版并卷到顶端。
  const listRef = useCallback(
    (list: HTMLDivElement | null) => {
      if (!list || !focusVersion) return;
      const target = Array.from(list.querySelectorAll<HTMLElement>("[data-version]")).find(
        (section) => section.dataset.version === focusVersion,
      );
      target?.scrollIntoView({ block: "start" });
    },
    [focusVersion],
  );
  const title =
    mode === "whatsNew"
      ? t("releaseNotes.whatsNewTitle").replace("{version}", entries[0].version)
      : t("releaseNotes.browseTitle");

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {/* 宽度沿 markdown 行宽上限（Markdown.tsx 的 96ch）；内容区可卷动。 */}
      <AlertDialogContent
        className="max-w-[96ch] gap-4"
        aria-describedby={undefined}
        data-testid="release-notes-dialog"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
        </AlertDialogHeader>

        <div ref={listRef} className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto pr-1">
          {entries.length === 0 ? (
            <p className="m-0 rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
              {t("releaseNotes.empty")}
            </p>
          ) : (
            entries.map((entry) => (
              <section key={entry.version} data-version={entry.version} className="flex flex-col gap-3">
                <h3 className="m-0 text-sm font-semibold">
                  {t("releaseNotes.versionHeading").replace("{version}", entry.version).replace("{date}", entry.date)}
                </h3>
                {entry.sections.map((section) => (
                  <div key={section.kind} className="flex flex-col gap-1">
                    <h4 className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      {t(`releaseNotes.kind.${section.kind}`)}
                    </h4>
                    <ul className="m-0 list-disc pl-5 text-sm leading-6">
                      {section.items.map((item, index) => (
                        <li key={index}>{entryText(item, locale)}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            ))
          )}
        </div>

        <div className="flex items-center justify-end border-t border-border pt-3">
          <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
            {mode === "whatsNew" ? t("releaseNotes.gotIt") : t("releaseNotes.close")}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

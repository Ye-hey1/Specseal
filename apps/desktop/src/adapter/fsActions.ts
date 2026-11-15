// 项目层文件系统动作（design D5）：Tauri command 与剪贴板的接线面。错误字符串为
// i18n 键（fs.noTerminal／fs.noEditor／fs.dirMissing）或 opener／剪贴板的原文。
// store 只依赖此接口，测试以假 adapter 注入。
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { DocumentRef } from "@specseal/ui";

import type { WorkspaceLocator } from "../session";

/** 文档在磁盘上的位置（core 回报）：绝对路径，与相对所在 checkout 根的路径（正斜线；
 * 「打开 ▾」首列与失败 toast 的主词）。 */
export interface DocumentLocation {
  path: string;
  relative: string;
}

export interface FsActionsAdapter {
  reveal: (path: string) => Promise<void>;
  /** 以系统缺省 App 打开文档（只收 .md，其余回 fs.notDocument）。 */
  openDefault: (path: string) => Promise<void>;
  openTerminal: (path: string) => Promise<void>;
  openEditor: (path: string) => Promise<void>;
  /** 写入剪贴板（路径或文档原文）。 */
  copyText: (text: string) => Promise<void>;
  /** 详情页与手册页文档的磁盘位置：core 以读文档同一套解析（worktree 副本、spec 目录名、
   * 已封存讨论的日期文件名、封存目录）；找不到为 null。 */
  locate: (root: string, doc: DocumentRef) => Promise<DocumentLocation | null>;
}

export function tauriFsActionsAdapter(): FsActionsAdapter {
  return {
    reveal: (path) => invoke<void>("reveal_in_folder", { path }),
    openDefault: (path) => invoke<void>("open_path", { path }),
    openTerminal: (path) => invoke<void>("open_in_terminal", { path }),
    openEditor: (path) => invoke<void>("open_in_editor", { path }),
    copyText: (text) => writeText(text),
    locate: (root, doc) => {
      if ("discussion" in doc) return invoke<DocumentLocation | null>("discussion_location", { root, slug: doc.discussion });
      if ("spec" in doc) return invoke<DocumentLocation | null>("spec_location", { root, capability: doc.spec });
      if ("manual" in doc) return invoke<DocumentLocation | null>("manual_location", { root, slug: doc.manual });
      if ("archived" in doc) {
        return invoke<DocumentLocation | null>("archived_document_location", {
          root,
          datedName: doc.archived,
          artifact: doc.artifact,
        });
      }
      return invoke<DocumentLocation | null>("document_location", { root, change: doc.change, artifact: doc.artifact });
    },
  };
}

/** 文件系统动作作用的本机目录：local 为项目根、remote 为 checkout；remote 无 checkout 时为 null。 */
export function projectDirOf(locator: WorkspaceLocator): string | null {
  return locator.kind === "local" ? locator.root : (locator.checkoutRoot ?? null);
}

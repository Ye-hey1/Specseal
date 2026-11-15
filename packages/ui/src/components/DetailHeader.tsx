import { Fragment, type ReactNode } from "react";

import type { Stage } from "../stage";
import type { StatusPillTone } from "./ui/status-pill";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** 变更阶段签的 tone（看板栏色相）：变更详情页身分区与讨论页的衍生变更签共用；已封存中性、已删除警示由调用端另判。 */
export const STAGE_PILL_TONE: Record<Stage, StatusPillTone> = {
  proposed: "primary",
  "in-progress": "progress",
  ready: "success",
};

/** 详情页分页对应的文档（design D4「打开 ▾」）：change 的 artifact（输出路径，如
 * `proposal.md`、`specs/<capability>/spec.md`）、一笔讨论记录、一份正式规格、封存变更
 * 的 artifact（dated name 寻址），或一页手册（slug 寻址）。磁盘位置由宿主解析（worktree
 * 副本、spec 目录名、已封存讨论的日期文件名），页不拼路径。 */
export type DocumentRef =
  | { change: string; artifact: string }
  | { discussion: string }
  | { spec: string }
  | { archived: string; artifact: string }
  | { manual: string };

/** 对象的 artifact 路径（相对变更目录，阅读卡出处行用）；讨论、正式规格与没有文件时为 null。 */
export function documentArtifact(target: DocumentTarget | null): string | null {
  return target?.doc && "artifact" in target.doc ? target.doc.artifact : null;
}

/** 「打开 ▾」的对象：文档与该分页已加载的原文（未载完为 null）。分页不载原文时
 * （审查／验证工单只载解析后的回合）`content` 缺席；`doc` 为 null＝没有可定位的文件
 * （已封存讨论），只能拷贝原文。 */
export interface DocumentTarget {
  doc: DocumentRef | null;
  content?: string | null;
}

/** 出身列仅显示名字：去除 email 尖括号段（无尖括号时整串直出），完整识别由提示承载。
 * 变更、讨论与已封存详情页的出身列共用。 */
export function displayName(identity: string): string {
  const name = identity.replace(/\s*<[^>]*>\s*/g, " ").trim();
  return name || identity;
}

/** 出身列的人：首字母圆标（中性）＋名字，含 email 的完整识别收进提示。
 * 需在 TooltipProvider 内渲染。 */
export function IdentityName({ identity }: { identity: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 items-center gap-1">
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[9px] font-bold text-muted-foreground">
            {identity.charAt(0).toUpperCase()}
          </span>
          {displayName(identity)}
        </span>
      </TooltipTrigger>
      <TooltipContent>{identity}</TooltipContent>
    </Tooltip>
  );
}

/** 以「·」分隔的信息段：缺席（falsy）的段整段略过。以原始槽位为 key——数据陆续抵达时
 * 前段由缺席变存在，后段不得因位移而重挂。身分区与阅读卡出处行共用。 */
export function DotSeparated({ segments }: { segments: ReactNode[] }) {
  return segments
    .flatMap((node, slot) => (node ? [{ node, slot }] : []))
    .map(({ node, slot }, i) => (
      <Fragment key={slot}>
        {i > 0 && (
          <span aria-hidden="true" className="shrink-0 opacity-50">
            ·
          </span>
        )}
        {node}
      </Fragment>
    ));
}

/** 「状态」列的一列（文档树左栏，design D1）：左标签右内容，`data-status-<mark>` 供测试定位。
 * 内容缺省单行不撑宽；`wrap` 让多颗签（衍生变更、阶段步骤）折行。 */
export function StatusRow({
  mark,
  label,
  wrap = false,
  children,
}: {
  mark: string;
  label: string;
  wrap?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      {...{ [`data-status-${mark}`]: "" }}
      className="col-span-2 grid grid-cols-subgrid items-start gap-x-2 px-2 py-2 text-xs"
    >
      {/* 标签栏宽由 DetailStatus 的格线依最长标签决定：下限 56px（繁中版面不变）、上限 112px，超过才在字间折行。 */}
      <span className="min-w-14 max-w-28 break-words leading-5 text-muted-foreground">{label}</span>
      <div
        className={
          wrap
            ? "flex min-h-5 min-w-0 flex-1 flex-wrap items-center gap-1.5"
            : "flex min-h-5 min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap"
        }
      >
        {children}
      </div>
    </div>
  );
}

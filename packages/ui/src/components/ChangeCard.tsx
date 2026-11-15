import { AlertTriangle, Archive, FileText, GitBranch, Hand, MessageSquareText, RefreshCw, Undo2 } from "lucide-react";

import type { ChangeItem, SearchHit } from "../adapter";
import { useI18n } from "../i18n";
import {
  awaitingManualCount,
  changeStage,
  planBlockedBy,
  planBlockedLabel,
  planWave,
  planWaveLabel,
  STAGE_BADGE,
} from "../stage";
import { SEMANTIC_TONE } from "../tone";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader } from "./ui/card";
import { CardNameRow } from "./CardNameRow";
import { HighlightText } from "./HighlightText";
import { REVIEW_ICON, REVIEW_LABEL_KEY, REVIEW_TONE, type ReviewBadgeStatus } from "./reviewStyle";
import { VERIFY_ICON, VERIFY_LABEL_KEY, VERIFY_TONE, type VerifyBadgeStatus } from "./verifyStyle";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

export interface ChangeCardProps {
  change: ChangeItem;
  onOpen?: (name: string) => void;
  /** 封存请求（仅「已就绪」阶段的卡片显示封存钮）。 */
  onArchive?: (name: string) => void;
  /** 退回提案中请求（仅派生「进行中」的卡片显示退回钮；未提供时不渲染）。 */
  onRevert?: (name: string) => void;
  /** 进度条填色 class（看板依阶段配色）。 */
  barClass?: string;
  /** 搜索字符串（design D7）：名称子字符串命中时高亮命中原文。 */
  highlight?: string;
  /** 全文命中（design D6）：卡身呈 snippet 行（artifact 名＋前后文）。 */
  hit?: SearchHit;
}

/** 看板卡片（极简）：名称＋拷贝钮＋进度。点卡片开详情页；动作归详情页，仅 ready 卡有封存。 */
export function ChangeCard({
  change,
  onOpen,
  onArchive,
  onRevert,
  barClass = "bg-primary",
  highlight,
  hit,
}: ChangeCardProps) {
  const { t } = useI18n();
  const pct =
    change.totalTasks > 0 ? Math.round((change.completedTasks / change.totalTasks) * 100) : 0;
  const stage = changeStage(change);
  // 波次与被挡（spec「看板卡片的波次与阻挡标示」；add-change-plan-desktop design D4）：
  // 判定归 stage.ts 的 planWave／planBlockedBy 单一入口，缺 wave（remote、成环）
  // 无章也不变淡。被挡＝整卡变淡，与系统匣面板被挡列同一种语言：淡＝现在不能做。
  const wave = planWave(change);
  const blockedBy = planBlockedBy(change);
  const blocked = blockedBy.length > 0;
  const waveLabel = wave === null ? "" : planWaveLabel(wave, t);
  const waveTitle = blocked ? `${waveLabel} · ${planBlockedLabel(blockedBy, t)}` : waveLabel;
  return (
    <TooltipProvider>
    <Card
      data-change={change.name}
      data-blocked={blocked ? "true" : undefined}
      size="nested"
      interactive
      className={`group cursor-(--cursor-interaction)${blocked ? " opacity-60" : ""}`}
      onClick={() => onOpen?.(change.name)}
    >
      <CardHeader className="p-3 flex-row items-start gap-1.5">
        <CardNameRow text={change.name} copyLabel={t("common.copyName")} highlight={highlight} />
        {change.createdBy && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-label={change.createdBy}
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-bold text-muted-foreground"
              >
                {change.createdBy.charAt(0).toUpperCase()}
              </span>
            </TooltipTrigger>
            <TooltipContent>{change.createdBy}</TooltipContent>
          </Tooltip>
        )}
        {/* 认领人（remote-claim-ownership D4）：沿创建者头像的同款圆标，位置
            固定在其后——扫视看板时「谁在做」与「谁开的」读成同一行。 */}
        {change.claimedBy && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-label={t("card.claimedBy").replace("{name}", change.claimedBy)}
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[9px] font-bold text-primary"
              >
                {change.claimedBy.charAt(0).toUpperCase()}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t("card.claimedBy").replace("{name}", change.claimedBy)}
            </TooltipContent>
          </Tooltip>
        )}
        {/* 审查章（spec「看板卡片的审查标示」）：行内小章＋tooltip 状态词，
            不加文本列维持卡片极简；none 无任何审查元素。 */}
        {change.reviewStatus && change.reviewStatus !== "none" && (() => {
          const status: ReviewBadgeStatus = change.reviewStatus;
          const labelKey = REVIEW_LABEL_KEY[status];
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span aria-label={t(labelKey)} className={`shrink-0 ${REVIEW_TONE[status]}`}>
                  {REVIEW_ICON[status]}
                </span>
              </TooltipTrigger>
              <TooltipContent>{t(labelKey)}</TooltipContent>
            </Tooltip>
          );
        })()}
        {/* 验证章（spec「看板卡片的验证标示」）：与审查章同构、顺序固定在其后
            ——两章位置每次刷新都一样，扫视才有意义。 */}
        {change.verifyStatus && change.verifyStatus !== "none" && (() => {
          const status: VerifyBadgeStatus = change.verifyStatus;
          const labelKey = VERIFY_LABEL_KEY[status];
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span aria-label={t(labelKey)} className={`shrink-0 ${VERIFY_TONE[status]}`}>
                  {VERIFY_ICON[status]}
                </span>
              </TooltipTrigger>
              <TooltipContent>{t(labelKey)}</TooltipContent>
            </Tooltip>
          );
        })()}
        {/* 待手动章（spec「看板卡片的待手动标示」；design D5）：写码任务全完成、
            尚有未勾 `[M]` 时浮现——判定归 stage.ts 的 awaitingManualCount 单一
            入口（含 remote 缺字段与 codeTotal=0 空真值两个不浮现边界），组件
            只读结果。沿审查章的行内小章家族，不增加文本列。 */}
        {awaitingManualCount(change) > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-label={t("card.awaitingManual")}
                className={`shrink-0 ${SEMANTIC_TONE.manual}`}
              >
                <Hand className="h-3.5 w-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t("card.awaitingManualTitle").replace("{n}", String(awaitingManualCount(change)))}
            </TooltipContent>
          </Tooltip>
        )}
        {(change.fromDiscussions ?? []).length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span aria-label={t("card.fromDiscussion")} className="shrink-0 text-primary/60">
                <MessageSquareText className="h-3.5 w-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t("card.fromDiscussionTitle").replace("{name}", (change.fromDiscussions ?? []).join(", "))}
            </TooltipContent>
          </Tooltip>
        )}
        {change.worktree && (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* worktree 挂着＝工作正于副本进行中，属状态非静态 metadata。 */}
              <span
                aria-label={t("card.worktree")}
                className={`shrink-0 ${SEMANTIC_TONE.inProgress}`}
              >
                <GitBranch className="h-3.5 w-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t("card.worktreeTitle").replace("{branch}", change.worktree.branch)}
            </TooltipContent>
          </Tooltip>
        )}
        {(change.restaleFrom ?? []).length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span aria-label={t("card.restale")} className={`shrink-0 ${SEMANTIC_TONE.warning}`}>
                <RefreshCw className="h-3.5 w-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t("card.restaleTitle").replace("{name}", (change.restaleFrom ?? []).join(", "))}
            </TooltipContent>
          </Tooltip>
        )}
        {/* 最小 invalid 标记（design 决策四）：metadata 损坏卡照常显示，
            操作由引擎错误拒绝；tooltip 载解析原因供修复。 */}
        {change.metaError && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span aria-label={t("card.invalidMeta")} className="shrink-0 text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t("card.invalidMetaTitle").replace("{reason}", change.metaError)}
            </TooltipContent>
          </Tooltip>
        )}
      </CardHeader>
      <CardContent className="p-3 pt-0 gap-2">
        {/* 描述列（anatomy 三列骨架）：proposal Why 首句一行截断；null 时整列缺席。 */}
        {change.whyExcerpt && (
          <div data-desc className="truncate text-[11px] text-muted-foreground">
            {change.whyExcerpt}
          </div>
        )}
        <div className="flex items-center gap-2">
          {/* 波次章在进度列最左：圆圈数字（同波同号可并行），tooltip 带前置清单；
              放这里而不放标题列，名称的空间才不被调度信息占用。 */}
          {wave !== null && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  aria-label={waveLabel}
                  className={`inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none ${STAGE_BADGE[stage]}`}
                >
                  {wave}
                </span>
              </TooltipTrigger>
              <TooltipContent>{waveTitle}</TooltipContent>
            </Tooltip>
          )}
          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
            <div className={`h-full rounded-full transition-all ${barClass}`} style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {change.completedTasks}/{change.totalTasks}
          </span>
        </div>
        {/* stopPropagation 挂在按钮自身而非整列：钮旁空白仍冒泡开卡片详情。 */}
        {stage === "ready" && (
          <div>
            <Button
              variant="outline"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                onArchive?.(change.name);
              }}
            >
              <Archive className="h-3 w-3" /> {t("common.archive")}
            </Button>
          </div>
        )}
        {/* 退回提案中（样式沿讨论卡封存钮）：仅派生进行中呈现；点击交宿主先确认,
            UI 不预判守门——引擎是唯一裁决点。 */}
        {stage === "in-progress" && onRevert && (
          <div>
            <Button
              variant="outline"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                onRevert(change.name);
              }}
            >
              <Undo2 className="h-3 w-3" /> {t("common.revert")}
            </Button>
          </div>
        )}
        {/* 全文命中 snippet 行（design D6/D7）：哪个 artifact 命中＋前后文＋命中高亮。 */}
        {hit && (
          <div
            data-snippet
            className="flex items-start gap-1 border-t border-border/40 pt-1.5 text-[11px] leading-snug text-muted-foreground"
          >
            <FileText className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="min-w-0">
              <span className="font-mono">{hit.artifact}</span>{" "}
              <HighlightText text={hit.snippet} query={highlight} />
            </span>
          </div>
        )}
      </CardContent>
    </Card>
    </TooltipProvider>
  );
}

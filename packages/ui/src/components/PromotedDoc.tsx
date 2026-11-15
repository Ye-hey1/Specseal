import { ArrowUpRight } from "lucide-react";

import type { ArchivedItem, ChangeItem } from "../adapter";
import type { CutCard } from "../discussionModel";
import type { CutStage } from "./ConclusionDoc";
import { useI18n } from "../i18n";
import { changeStage } from "../stage";
import { Button } from "./ui/button";
import { StatusPill, type StatusPillTone } from "./ui/status-pill";
import { STAGE_PILL_TONE } from "./DetailHeader";
import { discussionChipStage } from "./DiscussionColumn";
import { InlineMarks, NAME_CHIP_CLS } from "./DocParts";
import type { SourceLinkItem } from "./SourceDiscussionChip";

/** 衍生变更的一列。`state` 为 null＝宿主没给两份清单、所在未知（已封存讨论页的退回）。 */
export interface PromotedRow {
  name: string;
  stage: { label: string; tone: StatusPillTone };
  state: "active" | "archived" | "deleted" | null;
  tasks: { done: number; total: number } | null;
  review: boolean;
  verify: boolean;
  date: string | null;
  onOpen?: () => void;
}

/**
 * 衍生列的单一推导（design D5）：依 `promoted_to` 原序——作用中取看板阶段、任务完成数、两章与最近盖章日；
 * 已封访问封存清单的任务数、结局章与封存日期；两者皆无为已删除（不可开）。缺打开回呼的那一类不可开。两页共用。
 */
export function promotedRows(
  names: string[],
  changes: ChangeItem[],
  archivedChanges: ArchivedItem[],
  t: (key: string) => string,
  openActive?: (name: string) => void,
  openArchived?: (name: string) => void,
): PromotedRow[] {
  return names.map((name) => {
    const label = t(discussionChipStage(name, changes, archivedChanges));
    const active = changes.find((c) => c.name === name);
    if (active) {
      const stamped = [active.reviewedAt, active.verifiedAt].filter((d): d is string => !!d).sort();
      return {
        name,
        stage: { label, tone: STAGE_PILL_TONE[changeStage(active)] },
        state: "active",
        tasks: active.totalTasks > 0 ? { done: active.completedTasks, total: active.totalTasks } : null,
        review: active.reviewStatus === "reviewed" || active.reviewStatus === "reviewedStale",
        verify: active.verifyStatus === "verified" || active.verifyStatus === "verifiedStale",
        date: stamped.length > 0 ? stamped[stamped.length - 1].slice(0, 10) : null,
        onOpen: openActive && (() => openActive(name)),
      };
    }
    const archived = archivedChanges.find((a) => a.name === name);
    if (archived) {
      return {
        name,
        stage: { label, tone: "neutral" },
        state: "archived",
        tasks:
          archived.tasksDone !== undefined && archived.tasksTotal !== undefined
            ? { done: archived.tasksDone, total: archived.tasksTotal }
            : null,
        review: archived.reviewStatus === "reviewed",
        verify: archived.verifyStatus === "verified",
        date: archived.date,
        onOpen: openArchived && (() => openArchived(name)),
      };
    }
    return { name, stage: { label, tone: "destructive" }, state: "deleted", tasks: null, review: false, verify: false, date: null };
  });
}

/** 分刀卡变更签的阶段：取该名称的衍生列（不在 `promoted_to` 为 null）。 */
export function rowStage(rows: PromotedRow[]): (name: string) => CutStage | null {
  return (name) => {
    const row = rows.find((r) => r.name === name);
    return row ? { label: row.stage.label, tone: row.stage.tone, onOpen: row.onOpen } : null;
  };
}

/** 宿主没给两份清单时的退回：宿主派生的三态签（副标当阶段签文本），所在未知、无任务与日期。 */
export function promotedRowsFromLinks(items: SourceLinkItem[], onOpen?: (name: string) => void): PromotedRow[] {
  return items.map((item) => ({
    name: item.slug,
    stage: { label: item.topic ?? "", tone: "neutral" },
    state: item.disabled ? "deleted" : null,
    tasks: null,
    review: false,
    verify: false,
    date: null,
    onOpen: item.disabled || !onOpen ? undefined : () => onOpen(item.slug),
  }));
}

/** 一列：阶段签、等宽名、任务进度、审／验章、日期、打开钮。 */
function PromotedRowView({ row }: { row: PromotedRow }) {
  const { t } = useI18n();
  const pct = row.tasks && row.tasks.total > 0 ? Math.round((row.tasks.done / row.tasks.total) * 100) : 0;
  return (
    <div data-promoted-row={row.name} className="flex min-w-0 items-center gap-2.5 py-2 first:pt-0 last:pb-0">
      <StatusPill tone={row.stage.tone} className={row.stage.tone === "destructive" ? "line-through" : undefined}>
        {row.stage.label}
      </StatusPill>
      <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium">{row.name}</span>
      {row.tasks && (
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="h-1.5 w-14 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </span>
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{`${row.tasks.done}/${row.tasks.total}`}</span>
        </span>
      )}
      {row.review && (
        <StatusPill data-stamp="review" tone="stamp">
          {t("promoted.stampReview")}
        </StatusPill>
      )}
      {row.verify && (
        <StatusPill data-stamp="verify" tone="stamp">
          {t("promoted.stampVerify")}
        </StatusPill>
      )}
      {row.date && <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{row.date}</span>}
      {row.onOpen && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("ddrawer.openCard")}
          title={t("ddrawer.openCard")}
          className="shrink-0"
          onClick={row.onOpen}
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

function RowGroup({ rows }: { rows: PromotedRow[] }) {
  return (
    <div className="flex flex-col divide-y divide-border/70">
      {rows.map((row) => (
        <PromotedRowView key={row.name} row={row} />
      ))}
    </div>
  );
}

/**
 * 衍生变更文档（design D5；spec「讨论详情页查看与转出变更」）：结论读得到分刀时依刀分组（组头为本页目录锚点，
 * 没有列的刀不出组），不属任何刀的列接在最后、无组头；读不到时依转出顺序平面清单。唯读、无转出动作。
 */
export function PromotedDoc({ rows, cuts, empty }: { rows: PromotedRow[]; cuts: CutCard[]; empty?: string }) {
  const { t, tn } = useI18n();
  if (rows.length === 0) return <p className="py-4 text-sm text-muted-foreground">{empty ?? t("ddrawer.notPromoted")}</p>;
  if (cuts.length === 0) return <RowGroup rows={rows} />;
  const placed = new Set<string>();
  const groups = cuts.flatMap((cut) => {
    const members = cut.names
      .map((name) => rows.find((r) => r.name === name && !placed.has(r.name)))
      .filter((r): r is PromotedRow => !!r);
    members.forEach((r) => placed.add(r.name));
    return members.length > 0 ? [{ cut, members }] : [];
  });
  const loose = rows.filter((r) => !placed.has(r.name));
  return (
    <div className="flex flex-col gap-5">
      {groups.map(({ cut, members }) => (
        <section key={cut.id} data-cut-group={cut.id} className="flex flex-col gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <h3 data-doc-heading className="flex min-w-0 items-center gap-2 text-sm font-semibold">
              <span className={NAME_CHIP_CLS}>{cut.id}</span> <span className="min-w-0 truncate">
                <InlineMarks text={cut.title} />
              </span>
            </h3>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
              {tn("promoted.groupChanges", members.length)}
            </span>
          </div>
          <RowGroup rows={members} />
        </section>
      ))}
      {loose.length > 0 && <RowGroup rows={loose} />}
    </div>
  );
}

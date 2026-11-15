import type { ReactElement, ReactNode } from "react";
import { X } from "lucide-react";

import type { ChangeItem, DeltaOperation } from "../adapter";
import { useI18n, type Translator } from "../i18n";
import {
  planArchiveAfter,
  planBlockedBy,
  planBlockedLabel,
  planRequirementOverlap,
  planWave,
  planWaveLabel,
} from "../stage";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { DELTA_COLORS, DELTA_LABEL_KEYS } from "./DeltaBadges";
import type { DocSummary } from "./DetailShell";
import { NAME_CHIP_CLS, SECTION_HEADING_CLS } from "./DocParts";

/** 调度文档内的名称签（同波伙伴、前置、重叠、封存顺序共用；与能力名签同款）。 */
function PlanName({ name }: { name: string }) {
  return <span className={NAME_CHIP_CLS}>{name}</span>;
}

/** 重叠卡的 delta 操作小标签：用词与配色和规格文档的 delta 区段同源；title 标出属于哪一方。 */
function OpTag({ op, owner }: { op: DeltaOperation; owner: string }) {
  const { t } = useI18n();
  const key = op.toLowerCase() as Lowercase<DeltaOperation>;
  return (
    <span title={owner} className={`rounded border border-border/60 px-1 py-0.5 text-[10px] ${DELTA_COLORS[key]}`}>
      {t(DELTA_LABEL_KEYS[key])}
    </span>
  );
}

/** 前置卡与阅读卡签槽的同一枚状态徽章：blockedBy 空为「可以开工」、非空为「等 N 项」（title 列出前置名）。 */
function PlanStatusBadge({ blockedBy, t }: { blockedBy: string[]; t: (key: string) => string }) {
  return blockedBy.length === 0 ? (
    <Badge variant="secondary">{t("plan.canStart")}</Badge>
  ) : (
    <Badge variant="outline" title={planBlockedLabel(blockedBy, t)}>
      {t("plan.blockedCount").replace("{n}", String(blockedBy.length))}
    </Badge>
  );
}

/** 调度文档的一张卡片：外观与工单文档的轮卡同一种边框卡片，卡头（16px 标题、右侧可放签）与内容区以分隔线分格。 */
function PlanCard({
  section,
  title,
  badge,
  children,
}: {
  section: "wave" | "depends" | "overlaps" | "archive";
  title: string;
  badge?: ReactElement;
  children: ReactNode;
}) {
  return (
    <section data-plan-section={section} className="rounded-md border border-border/60 bg-muted/20">
      <div data-plan-card-header className="flex items-center justify-between gap-2 px-3 py-2">
        <h3 data-doc-heading className={SECTION_HEADING_CLS}>
          {title}
        </h3>
        {badge}
      </div>
      <div data-plan-card-body className="border-t border-border/60 px-3 py-2 text-sm">
        {children}
      </div>
    </section>
  );
}

/** 卡头右端的笔数签（重叠卡、封存顺序卡）。 */
const countBadge = (n: number) => (
  <Badge variant="secondary" className="tabular-nums">
    {n}
  </Badge>
);

/**
 * 调度文档（spec desktop-app「详情页的调度分页」）：波次（同波伙伴）、前置（可增减，
 * 标题列的状态徽章取代独立的阻挡段）、重叠（唯读）、封存顺序四张卡片。清单项缺 wave
 * 时：remote 摘要（亦缺 dependsOn）只剩一句说明；plan 成环（payload 仍带 dependsOn
 * 原文）另渲染前置卡（无徽章）、只能移除——解环的出口。判定沿 stage.ts 的 planWave／
 * planBlockedBy／planRequirementOverlap／planArchiveAfter 单一入口。
 */
export function PlanDoc({
  change,
  changes,
  roster,
  onSetDepends,
}: {
  change: ChangeItem;
  changes: ChangeItem[];
  /** 候选名册：数组＝查找结果、null＝自清单派生、undefined＝查找中（不给候选）。 */
  roster: string[] | null | undefined;
  onSetDepends?: (change: string, on: string[], remove: boolean) => void;
}) {
  const { t } = useI18n();
  const wave = planWave(change);
  const dependsOn = change.dependsOn ?? [];
  // 前置卡内文（成环与一般两个分支共用）：声明的前置每项一列，空时「尚无前置」。
  const dependsBody = (
    <>
      {dependsOn.length === 0 && <div className="text-muted-foreground">{t("plan.noDepends")}</div>}
      <ul className="flex flex-col gap-1">
        {dependsOn.map((n) => (
          <li key={n} className="flex items-center gap-2">
            <PlanName name={n} />
            {onSetDepends && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={t("plan.remove").replace("{name}", n)}
                onClick={() => onSetDepends(change.name, [n], true)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
  if (wave === null) {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <div className="text-muted-foreground py-6">{t(change.dependsOn ? "plan.cycle" : "plan.unavailable")}</div>
        {change.dependsOn && (
          <PlanCard section="depends" title={t("plan.depends")}>
            {dependsBody}
          </PlanCard>
        )}
      </div>
    );
  }
  const requirementOverlaps = planRequirementOverlap(change);
  const archiveAfter = planArchiveAfter(change);
  const blockedBy = planBlockedBy(change);
  // 旧 server 的 blockedBy 另含先配置、共用 capability 的变更（本机与新 server 只含声明
  // 前置）：列出 dependsOn 以外的名称，徽章的数字才对得上卡片内容。
  const undeclaredWaits = blockedBy.filter((n) => !dependsOn.includes(n));
  const others = changes.filter((c) => c.name !== change.name);
  const mates = others.filter((c) => planWave(c) === wave).map((c) => c.name);
  // 添加候选：该变更所在名册的其他作用中变更（add-change-plan-remote D9；未提供名册时
  // 自清单派生），扣掉自己与已声明的前置（成环留给引擎拒绝）。
  const pool = roster === undefined ? [] : (roster ?? others.map((c) => c.name));
  const candidates = pool.filter((n) => n !== change.name && !dependsOn.includes(n));
  // 封存卡的两种警示：同名冲突（双方都带进或都拿走，先后救不了）与互相等待（双方互列
  // archiveAfter，封存互卡）——两者引擎都不会让任一方「可直接封存」。
  const conflictWith = conflictNames(change);
  const mutualWaits = archiveAfter.filter((n) =>
    others.some((c) => c.name === n && planArchiveAfter(c).includes(change.name)),
  );
  const names = (list: string[]) => list.join(t("common.listSeparator"));
  return (
    <div className="flex flex-col gap-3 text-sm">
      <PlanCard section="wave" title={t("plan.waveLabel")}>
        <div className="font-medium">{planWaveLabel(wave, t)}</div>
        {mates.length === 0 ? (
          <div className="text-muted-foreground">{t("plan.onlyOne")}</div>
        ) : (
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground">{t("plan.waveMates")}</span>
            {mates.map((n) => (
              <PlanName key={n} name={n} />
            ))}
          </div>
        )}
      </PlanCard>
      <PlanCard section="depends" title={t("plan.depends")} badge={<PlanStatusBadge blockedBy={blockedBy} t={t} />}>
        {dependsBody}
        {undeclaredWaits.length > 0 && (
          <div data-plan-undeclared-waits className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground">{t("plan.undeclaredWaits")}</span>
            {undeclaredWaits.map((n) => (
              <PlanName key={n} name={n} />
            ))}
          </div>
        )}
        {onSetDepends && candidates.length > 0 && (
          // 只当挑选器用：value 固定为空，选择即写入、trigger 回到提示文本。
          <Select value="" onValueChange={(name) => onSetDepends(change.name, [name], false)}>
            <SelectTrigger aria-label={t("plan.add")} className="mt-2 w-full">
              <SelectValue placeholder={t("plan.add")} />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((n) => (
                <SelectItem key={n} value={n}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </PlanCard>
      <PlanCard section="overlaps" title={t("plan.overlaps")} badge={countBadge(requirementOverlaps.length)}>
        {requirementOverlaps.length === 0 && <div className="text-muted-foreground">{t("plan.noOverlaps")}</div>}
        <ul className="flex flex-col gap-1">
          {requirementOverlaps.map((o) => (
            <li key={`${o.change}/${o.capability}/${o.requirement}`} className="flex flex-wrap items-center gap-1.5">
              <PlanName name={o.change} />
              <span className="text-xs">{`${o.capability} › ${o.requirement}`}</span>
              {/* 双方操作：本变更在前、对方在后。 */}
              <OpTag op={o.ownOperation} owner={change.name} />
              <OpTag op={o.otherOperation} owner={o.change} />
              {o.conflict && (
                <span className="rounded border border-destructive/60 px-1 py-0.5 text-[10px] text-destructive">
                  {t("plan.conflict")}
                </span>
              )}
            </li>
          ))}
        </ul>
      </PlanCard>
      <PlanCard section="archive" title={t("plan.archiveAfter")} badge={countBadge(archiveAfter.length)}>
        {archiveAfter.length === 0 && conflictWith.length === 0 && (
          <div className="text-muted-foreground">{t("plan.noArchiveAfter")}</div>
        )}
        {archiveAfter.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              {archiveAfter.map((n) => (
                <PlanName key={n} name={n} />
              ))}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t("plan.archiveHint")}</p>
          </>
        )}
        {mutualWaits.length > 0 && (
          <p className="mt-1 text-xs text-destructive">{t("plan.archiveDeadlock").replace("{names}", names(mutualWaits))}</p>
        )}
        {conflictWith.length > 0 && (
          <p className="mt-1 text-xs text-destructive">{t("plan.archiveConflict").replace("{names}", names(conflictWith))}</p>
        )}
      </PlanCard>
    </div>
  );
}

/** 同名冲突的对方变更名（去重）。 */
function conflictNames(change: ChangeItem): string[] {
  return [...new Set(planRequirementOverlap(change).filter((o) => o.conflict).map((o) => o.change))];
}

/**
 * 调度文档的签、数字砖与两态提示框（spec「详情页的调度分页」；design D7）：缺 wave 时全空。提示框标题
 * 由两个子句组成——前置（可以开工／等 N 项前置）与封存（也可直接封存／封存前要等 M 个变更／有同名
 * 冲突要先改）；两子句皆绿为 tip，否则 warning。
 */
export function planSummary(change: ChangeItem, { t, tn }: Translator): DocSummary {
  const wave = planWave(change);
  if (wave === null) return { badges: null, tiles: [], callout: null };
  const blockedBy = planBlockedBy(change);
  const archiveAfter = planArchiveAfter(change);
  const conflicts = conflictNames(change);
  const startClause =
    blockedBy.length === 0 ? t("plan.calloutStart") : tn("plan.calloutBlocked", blockedBy.length);
  const archiveClause =
    conflicts.length > 0
      ? t("plan.calloutConflict")
      : archiveAfter.length > 0
        ? tn("plan.calloutArchiveWait", archiveAfter.length)
        : t(blockedBy.length === 0 ? "plan.calloutArchiveFree" : "plan.noArchiveAfter");
  const green = blockedBy.length === 0 && archiveAfter.length === 0 && conflicts.length === 0;
  const lines = [
    { label: "plan.depends", names: blockedBy },
    { label: "plan.archiveAfter", names: archiveAfter },
    { label: "plan.conflict", names: conflicts },
  ].filter((l) => l.names.length > 0);
  return {
    badges: <PlanStatusBadge blockedBy={blockedBy} t={t} />,
    tiles: [
      { value: wave, label: t("plan.tileWave") },
      { value: (change.dependsOn ?? []).length, label: t("plan.tileDepends") },
      { value: planRequirementOverlap(change).length, label: t("plan.tileOverlaps") },
      { value: archiveAfter.length, label: t("plan.tileArchiveAfter") },
    ],
    callout: (
      <Callout
        tone={green ? "tip" : "warning"}
        title={`${startClause}${t("plan.calloutJoin")}${archiveClause}`}
        className="my-0"
      >
        {lines.map((l) => (
          <div key={l.label} className="my-1 flex flex-wrap items-center gap-1.5 text-sm">
            <span className="text-muted-foreground">{t(l.label)}</span>
            {l.names.map((n) => (
              <PlanName key={n} name={n} />
            ))}
          </div>
        ))}
        <p className="text-sm text-muted-foreground">{t("plan.calloutRecompute")}</p>
      </Callout>
    ),
  };
}

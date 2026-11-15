import { useEffect, useRef } from "react";

import { specDeltaCounts, splitDeltaSections, type DeltaCounts } from "../delta";
import { removedScenarios } from "../docModel";
import { useI18n } from "../i18n";
import { parseSpecSections, type SpecRequirement } from "../specSections";
import { SEMANTIC_TONE } from "../tone";
import { Button } from "./ui/button";
import { SECTION_HEADING_CLS } from "./DocParts";
import { Markdown } from "./Markdown";
import { RequirementBlock } from "./RequirementBlock";

/** delta 四种操作的色彩 class——计数徽章与规格分页色标区段共用的单一来源。
 *  添加＝成功、修改＝警示、移除＝destructive、更名＝进行中，色值在 theme.css。 */
export const DELTA_COLORS: Record<keyof DeltaCounts, string> = {
  added: SEMANTIC_TONE.success,
  modified: SEMANTIC_TONE.warning,
  removed: SEMANTIC_TONE.danger,
  renamed: SEMANTIC_TONE.inProgress,
};

/** 同色的左色条（delta 需求段）：色值同 DELTA_COLORS 的语意 token。 */
export const DELTA_BORDER: Record<keyof DeltaCounts, string> = {
  added: "border-status-success",
  modified: "border-status-warning",
  removed: "border-destructive",
  renamed: "border-status-progress",
};

const DELTA_MARKS: Record<keyof DeltaCounts, string> = {
  added: "+",
  modified: "~",
  removed: "-",
  renamed: "→",
};

/** delta 四种操作的 i18n 词条键——规格分页色标区段与调度分页的操作标签共用。 */
export const DELTA_LABEL_KEYS: Record<keyof DeltaCounts, string> = {
  added: "delta.added",
  modified: "delta.modified",
  removed: "delta.removed",
  renamed: "delta.renamed",
};

/** 彩色 delta 计数：+添加=绿、~修改=琥珀、-移除=红、→更名=蓝。 */
export function DeltaBadges({ counts }: { counts: DeltaCounts }) {
  const parts: { text: string; cls: string }[] = [];
  if (counts.added) parts.push({ text: `+${counts.added}`, cls: DELTA_COLORS.added });
  if (counts.modified) parts.push({ text: `~${counts.modified}`, cls: DELTA_COLORS.modified });
  if (counts.removed) parts.push({ text: `-${counts.removed}`, cls: DELTA_COLORS.removed });
  if (counts.renamed) parts.push({ text: `→${counts.renamed}`, cls: DELTA_COLORS.renamed });
  if (parts.length === 0) return null;
  return (
    <span className="inline-flex gap-1 text-xs font-semibold tabular-nums">
      {parts.map((p) => (
        <span key={p.text} className={p.cls}>
          {p.text}
        </span>
      ))}
    </span>
  );
}

/** 需求段的 REMOVED-SCENARIO 声明（需求文或 Scenario 内文都可能放）：取出名称、去掉声明与 BEFORE 注解行。 */
function withoutRemovals(req: SpecRequirement): { req: SpecRequirement; names: string[] } {
  const body = removedScenarios(req.body);
  const scenarios = req.scenarios.map((sc) => ({ title: sc.title, ...removedScenarios(sc.body) }));
  return {
    req: { ...req, body: body.content, scenarios: scenarios.map((sc) => ({ title: sc.title, body: sc.content })) },
    names: [...body.names, ...scenarios.flatMap((sc) => sc.names)],
  };
}

/** 一个 op 区段的内文：ADDED／MODIFIED 每条需求成需求段（第一条展开），其余照 Markdown。 */
function DeltaSectionBody({ op, content }: { op: keyof DeltaCounts; content: string }) {
  const parsed = op === "added" || op === "modified" ? parseSpecSections(content) : null;
  if (!parsed) return <Markdown content={content} />;
  return (
    <>
      {parsed.intro && <Markdown content={parsed.intro} />}
      {parsed.requirements.map((r, i) => {
        const { req, names } = withoutRemovals(r);
        return <RequirementBlock key={i} req={req} delta={{ op, removedScenarios: names, defaultOpen: i === 0 }} />;
      })}
      {parsed.appendix && <Markdown content={parsed.appendix} />}
    </>
  );
}

/**
 * delta spec 的色标区段查看（spec「规格分页 delta 区段以色标呈现」；design D6）：
 * `## <OP> Requirements` 机器标题不直出，改为色标区段标头（配色同 DELTA_COLORS）；ADDED／MODIFIED
 * 的每条需求以规格详情页同一个需求段呈现（操作色左色条、REMOVED-SCENARIO 提示框、可收合），
 * REMOVED／RENAMED 内文照 Markdown。无 delta 标题的文档整篇照常渲染。
 * ChangeDetailPage 与 ArchivedDetailPage 的规格文档共用。
 */
export function DeltaSpecView({ markdown }: { markdown: string | null }) {
  const { t } = useI18n();
  if (!markdown || !markdown.trim()) return <Markdown content={markdown} />;
  return (
    <div className="flex flex-col gap-4">
      {splitDeltaSections(markdown).map((s, i) =>
        s.op === null ? (
          <Markdown key={i} content={s.content} />
        ) : (
          <div key={i} className="flex flex-col gap-3">
            <div
              data-delta-section={s.op}
              data-doc-heading
              className={`flex items-center gap-1.5 ${SECTION_HEADING_CLS} ${DELTA_COLORS[s.op]}`}
            >
              <span aria-hidden="true">{DELTA_MARKS[s.op]}</span>
              <span>{t(DELTA_LABEL_KEYS[s.op])}</span>
            </div>
            <DeltaSectionBody op={s.op} content={s.content} />
          </div>
        ),
      )}
    </div>
  );
}

/** 规格文档的能力头（design D6）：等宽能力名（本页目录锚点）、delta 计数，有回呼时「看正式规格」。 */
export function CapabilityHeader({
  cap,
  counts,
  onOpenSpec,
}: {
  cap: string;
  counts: DeltaCounts;
  onOpenSpec?: (capability: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div data-capability-header className="flex min-w-0 items-center gap-2 border-b border-border/70 pb-2">
      <h2 data-doc-heading className="min-w-0 truncate font-mono text-sm font-semibold">
        {cap}
      </h2>
      <DeltaBadges counts={counts} />
      {onOpenSpec && (
        <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => onOpenSpec(cap)}>
          {t("doc.viewSpec")}
        </Button>
      )}
    </div>
  );
}

/**
 * 规格文档的一个能力段（能力头＋delta 查看），变更与已封存两页共用。`jump` 指到它时卷到段首并回报清除：
 * 卷动放在段自己的 effect，因为 Radix 的 TabsContent 在切换后的下一轮 render 才挂上内文，页层 effect
 * 那时还找不到段。
 */
export function DeltaCapSection({
  cap,
  doc,
  jump,
  onJumped,
  onOpenSpec,
}: {
  cap: string;
  doc: string | null;
  jump: { cap: string } | null;
  onJumped: () => void;
  onOpenSpec?: (capability: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (jump?.cap !== cap) return;
    ref.current?.scrollIntoView?.({ block: "start" });
    onJumped();
  }, [jump, cap, onJumped]);
  return (
    <div ref={ref} data-spec-cap={cap} className="mb-6 flex flex-col gap-3">
      <CapabilityHeader cap={cap} counts={specDeltaCounts(doc)} onOpenSpec={onOpenSpec} />
      {/* 逐项空态（capability 有列出、其 spec.md 为空）不套整体性文案。 */}
      <DeltaSpecView markdown={doc} />
    </div>
  );
}

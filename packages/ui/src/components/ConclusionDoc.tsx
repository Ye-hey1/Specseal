import { useEffect, useRef, useState } from "react";
import { Clock } from "lucide-react";

import type { DiscussionCut } from "../adapter";
import { itemMarkdown } from "../docModel";
import {
  CONCLUSION_LABELS,
  captureTargets,
  commandChips,
  cutCards,
  cutPromotion,
  nameSpans,
  parseConclusion,
  splitOption,
  splitRows,
  splitVerdict,
  type ConclusionLabel,
  type CutCard,
} from "../discussionModel";
import { useI18n } from "../i18n";
import { SEMANTIC_SURFACE } from "../tone";
import { StatusPill, type StatusPillTone } from "./ui/status-pill";
import {
  CommandChip,
  DocSection,
  InlineMarks,
  MoreToggle,
  NAME_CHIP_CLS,
  NameChip,
  OptionReasonRows,
  RowList,
} from "./DocParts";
import { Markdown } from "./Markdown";

/** 分刀卡变更签的阶段：名称在 `promoted_to` 中时有阶段签，`onOpen` 缺席为不可点。 */
export interface CutStage {
  label: string;
  tone: StatusPillTone;
  onOpen?: () => void;
}

export interface ConclusionDocProps {
  text: string;
  /** 引擎对该记录解析的刀；空数组（没有刀或旧 server 没有分刀数据）时没有分刀段，刀列留在定案细节。 */
  cuts?: DiscussionCut[];
  empty?: string;
  /** 分刀卡变更签的阶段与打开；回 null＝不在 `promoted_to`（不可点、无阶段签）。 */
  stageOf?: (name: string) => CutStage | null;
  /** 记录去向的规格签：名称在 `specNames` 中才可点。 */
  specNames?: string[];
  onOpenSpec?: (capability: string) => void;
  /** 「前往」请求：把该刀卡卷到阅读区中央（seq 递增，同一刀可重复跳）；处理完调用 `onJumped` 清除。 */
  jump?: { id: string; seq: number } | null;
  onJumped?: () => void;
}

/** 字段 → 区段标题词条（也是 `data-section` 的值）。 */
const FIELD_KEYS: Record<ConclusionLabel, string> = {
  Decision: "conclusion.decision",
  Rationale: "conclusion.rationale",
  "Rejected alternatives": "conclusion.rejected",
  Deferred: "conclusion.deferred",
  "Capture to": "conclusion.captureTo",
  Next: "conclusion.next",
};

/** 定案细节缺省只画前几条。 */
const DETAILS_SHOWN = 4;

/**
 * 结论文档（desktop-discussion-doc-views design D2；spec「讨论结论以字段标签呈现」）：六字段各一段，决定之后
 * 有分刀时多一段「分刀」；字段一个都没有时整篇 Markdown 退回。讨论详情页与已封存讨论页共用。
 */
export function ConclusionDoc({ text, cuts = [], empty, stageOf, specNames, onOpenSpec, jump, onJumped }: ConclusionDocProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  // 刀卡在这一轮 commit 后才在 DOM 里，effect 里卷动才找得到；找不到时只清请求。
  useEffect(() => {
    if (!jump) return;
    ref.current
      ?.querySelector(`[data-cut="${CSS.escape(jump.id)}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
    onJumped?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump]);
  const parsed = parseConclusion(text);
  if (!parsed) return <Markdown content={text} empty={empty} />;
  const { lead, fields } = parsed;
  return (
    <div ref={ref}>
      {lead && (
        <div className="mb-5">
          <Markdown content={lead} />
        </div>
      )}
      {CONCLUSION_LABELS.filter((l) => fields[l] !== undefined).map((l) => {
        const md = fields[l]!;
        const title = t(FIELD_KEYS[l]);
        switch (l) {
          case "Decision":
            return <DecisionSections key={l} md={md} engineCuts={cuts} stageOf={stageOf} />;
          case "Rejected alternatives":
          case "Deferred": {
            const rows = splitRows(md).map(splitOption);
            return (
              <DocSection key={l} sectionKey={FIELD_KEYS[l]} title={title} count={rows.length > 0 ? rows.length : undefined}>
                <OptionReasonRows items={rows} icon={l === "Deferred" ? <Clock className="h-3.5 w-3.5" /> : undefined} />
              </DocSection>
            );
          }
          case "Capture to":
            return (
              <DocSection key={l} sectionKey={FIELD_KEYS[l]} title={title}>
                <CaptureChips md={md} specNames={specNames ?? []} onOpenSpec={onOpenSpec} />
              </DocSection>
            );
          case "Next":
            return (
              <DocSection key={l} sectionKey={FIELD_KEYS[l]} title={title}>
                <NextCommands md={md} />
              </DocSection>
            );
          default:
            return (
              <DocSection key={l} sectionKey={FIELD_KEYS[l]} title={title}>
                <Markdown content={md} />
              </DocSection>
            );
        }
      })}
    </div>
  );
}

/** 决定：定论句放大、定案细节收合；引擎的刀对回的列抽成其后的「分刀」段。 */
function DecisionSections({
  md,
  engineCuts,
  stageOf,
}: {
  md: string;
  engineCuts: DiscussionCut[];
  stageOf?: ConclusionDocProps["stageOf"];
}) {
  const { t, tn } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const { verdict, details } = splitVerdict(md);
  const { cuts, rest } = cutCards(details, engineCuts);
  const rows = rest.map(itemMarkdown);
  const hidden = expanded ? 0 : Math.max(0, rows.length - DETAILS_SHOWN);
  return (
    <>
      <DocSection sectionKey="conclusion.decision" title={t("conclusion.decision")} count={rows.length > 0 ? rows.length : undefined}>
        <div className="flex flex-col gap-3">
          {verdict && (
            <p data-verdict className="text-[17px] leading-relaxed">
              <InlineMarks text={verdict} />
            </p>
          )}
          {rows.length > 0 && <RowList items={hidden > 0 ? rows.slice(0, DETAILS_SHOWN) : rows} />}
          {hidden > 0 && (
            <div>
              <MoreToggle
                label={tn("conclusion.moreDetails", hidden)}
                onExpand={() => setExpanded(true)}
              />
            </div>
          )}
        </div>
      </DocSection>
      {cuts.length > 0 && (
        <DocSection sectionKey="conclusion.cuts" title={t("conclusion.cuts")} count={cuts.length}>
          <div className="flex flex-col gap-2.5">
            {cuts.map((cut) => (
              <CutCardView key={cut.id} cut={cut} stageOf={stageOf} />
            ))}
          </div>
        </DocSection>
      )}
    </>
  );
}

/** 一张分刀卡：识别签、范围句、变更数；变更名签附阶段签；卡内细线列。转出判定取自引擎（`cutPromotion`）：
 * 整刀未转出时橄榄色虚线框、卡头「尚未转出」签；部分转出时 `unpromoted` 内的变更名签之后接同款签。
 * `unpromoted` 内的名称不取 `stageOf`（清单的 promotedTo 可能与文档不同步），同一颗签只有一种转出状态。 */
function CutCardView({ cut, stageOf }: { cut: CutCard; stageOf?: ConclusionDocProps["stageOf"] }) {
  const { t, tn } = useI18n();
  const promotion = cutPromotion(cut);
  const todo = promotion === "none";
  const notPromoted = <StatusPill tone="manual">{t("conclusion.notPromoted")}</StatusPill>;
  return (
    <section
      data-cut={cut.id}
      data-cut-todo={todo ? "" : undefined}
      className={`rounded-xl border px-4 py-3 ${todo ? `border-dashed ${SEMANTIC_SURFACE.manual}` : "border-border"}`}
    >
      <header className="flex min-w-0 items-center gap-2">
        <span className={NAME_CHIP_CLS}>{cut.id}</span>
        {todo && notPromoted}
        {cut.title && (
          <span className="min-w-0 font-medium">
            <InlineMarks text={cut.title} />
          </span>
        )}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
          {tn("conclusion.cutChanges", cut.names.length)}
        </span>
      </header>
      {cut.names.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {cut.names.map((name) => {
            const unpromoted = cut.unpromoted.includes(name);
            const stage = unpromoted ? null : (stageOf?.(name) ?? null);
            return (
              <span key={name} data-cut-change={name} className="inline-flex items-center gap-1">
                <NameChip name={name} onClick={stage?.onOpen} />
                {stage ? (
                  <StatusPill tone={stage.tone} className={stage.tone === "destructive" ? "line-through" : undefined}>
                    {stage.label}
                  </StatusPill>
                ) : (
                  promotion === "partial" && unpromoted && notPromoted
                )}
              </span>
            );
          })}
        </div>
      )}
      {cut.items.length > 0 && (
        <div className="mt-2.5">
          <RowList items={cut.items} />
        </div>
      )}
    </section>
  );
}

/** 记录去向：每项一颗签；等于规格名时整颗可点，内含规格名时签内的名称可点；切不出签时照 Markdown。 */
function CaptureChips({
  md,
  specNames,
  onOpenSpec,
}: {
  md: string;
  specNames: string[];
  onOpenSpec?: (capability: string) => void;
}) {
  const targets = captureTargets(md);
  if (!targets) return <Markdown content={md} />;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {targets.map((target, i) => {
        if (onOpenSpec && specNames.includes(target)) {
          return (
            <span key={i} data-capture-chip className="inline-flex">
              <NameChip name={target} onClick={() => onOpenSpec(target)} />
            </span>
          );
        }
        const spans = onOpenSpec ? nameSpans(target, specNames) : [];
        let last = 0;
        // 签文本可能是一整句：可折行、宽度不超过容器（不沿用名称签的不换行）。
        return (
          <span key={i} data-capture-chip className="inline-block max-w-full rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-words">
            {spans.flatMap(({ name, start, end }) => {
              const parts = [
                target.slice(last, start),
                <button
                  key={start}
                  type="button"
                  className="text-primary underline-offset-2 hover:underline"
                  onClick={() => onOpenSpec!(name)}
                >
                  {name}
                </button>,
              ];
              last = end;
              return parts;
            })}
            {target.slice(last)}
          </span>
        );
      })}
    </div>
  );
}

/** 下一步：Markdown 之后列出 `/specseal-*` 指令签，每颗附拷贝钮。 */
function NextCommands({ md }: { md: string }) {
  const commands = commandChips(md);
  return (
    <div className="flex flex-col gap-2.5">
      <Markdown content={md} />
      {commands.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {commands.map((command) => (
            <CommandChip key={command} command={command} />
          ))}
        </div>
      )}
    </div>
  );
}

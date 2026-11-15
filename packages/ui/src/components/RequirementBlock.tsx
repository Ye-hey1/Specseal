import { useState, type ReactNode } from "react";

import type { DeltaCounts } from "../delta";
import { splitScenarioSteps } from "../docModel";
import { useI18n } from "../i18n";
import { fenceFlags, type SpecRequirement } from "../specSections";
import { Badge } from "./ui/badge";
import { Callout } from "./ui/callout";
import { DELTA_BORDER } from "./DeltaBadges";
import { MoreToggle, SECTION_HEADING_CLS } from "./DocParts";
import { Markdown } from "./Markdown";

/** 收合列的 hover 提示：滑过淡底（与文档树节点同一浓度）；光标由调用端取共用光标变量。 */
const TOGGLE_HOVER_CLS = "rounded-lg transition-colors hover:bg-foreground/5";

/** 「Requirement」小标：与需求文的 SHALL／MUST 关键字同款等宽灰底。 */
const KW_LABEL_CLS = "shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground";

/** delta 查看的需求段设置；缺席＝规格详情页的画法（不收合、无色条、无移除提示）。 */
export interface RequirementDelta {
  /** 左色条取该操作色。 */
  op: keyof DeltaCounts;
  /** 本需求以 REMOVED-SCENARIO 声明移除的 scenario 名称。 */
  removedScenarios: string[];
  defaultOpen: boolean;
}

export interface RequirementBlockProps {
  req: SpecRequirement;
  /** 标题列右端（规格详情页的溯源锚点）；放在收合钮之外，点它不切换收合。 */
  anchor?: ReactNode;
  delta?: RequirementDelta;
  /** 非 delta 画法的收合模式（规格详情页）；缺席＝恒展开、无收合钮。`onToggle` 在每次展开／收合后
   * 调用（页据以重扫本页目录：收起的内文不在 DOM 里）。 */
  collapse?: { defaultOpen: boolean; onToggle?: () => void };
}

/** 超过这个数量的需求文段落与 Scenario 先收起来。 */
const VISIBLE = 3;

/** 以空行切段（围栏内的空行不切）。 */
function paragraphs(md: string): string[] {
  const lines = md.split(/\r?\n/);
  const inFence = fenceFlags(lines);
  const out: string[][] = [[]];
  lines.forEach((line, i) => {
    if (!inFence[i] && line.trim() === "") out.push([]);
    else out[out.length - 1].push(line);
  });
  return out.map((p) => p.join("\n")).filter((p) => p.trim());
}

/**
 * 一条需求段（design D6）：「Requirement」小标＋标题＋右端锚点、需求文、左线缩进的 Scenario。
 * 规格详情页照原画法，带 `collapse` 时整段可收合为一列（desktop-spec-manual-pages design D3）；
 * delta 查看另加操作色左色条、REMOVED-SCENARIO 提示框、WHEN／THEN 两栏、超过三段需求文与三个
 * Scenario 时收合，且整段可收合为一列。两种画法的标题常驻、皆为本页目录锚点。
 */
export function RequirementBlock({ req, anchor, delta, collapse }: RequirementBlockProps) {
  const { t, tn } = useI18n();
  const [open, setOpen] = useState(delta?.defaultOpen ?? collapse?.defaultOpen ?? true);
  const [allParagraphs, setAllParagraphs] = useState(false);
  const [allScenarios, setAllScenarios] = useState(false);
  if (!delta) {
    const head = (
      <>
        <span data-requirement-label className={`mt-0.5 ${KW_LABEL_CLS}`}>
          {t("sdetail.requirementLabel")}
        </span>
        <h2 data-doc-heading className={`min-w-0 flex-1 ${SECTION_HEADING_CLS}`}>
          {req.title}
        </h2>
      </>
    );
    return (
      <section data-requirement className="border-t border-border/70 pt-4">
        {/* 收合列的淡底盖整列（含锚点）；左右各外推 8px，文本与未收合的段落对齐不变。 */}
        <div className={`flex min-w-0 items-start gap-2 ${collapse ? `-mx-2 ${TOGGLE_HOVER_CLS}` : ""}`}>
          {collapse ? (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => {
                setOpen((v) => !v);
                collapse.onToggle?.();
              }}
              className="flex min-w-0 flex-1 cursor-(--cursor-interaction) items-start gap-2 px-2 py-1.5 text-left"
            >
              {head}
              {!open && (
                <Badge variant="secondary" className="shrink-0">
                  {tn("doc.scenarioCount", req.scenarios.length)}
                </Badge>
              )}
            </button>
          ) : (
            head
          )}
          {collapse ? <div className="shrink-0 py-1.5 pr-2">{anchor}</div> : anchor}
        </div>
        {open && req.body && (
          <div className="mt-2">
            <Markdown content={req.body} specKeywords />
          </div>
        )}
        {open &&
          req.scenarios.map((s, i) => (
            <div key={i} data-scenario className="mt-2.5 border-l-2 border-border pl-4">
              <div className="mb-1 text-xs font-semibold text-muted-foreground">
                {t("sdetail.scenarioLabel").replace("{title}", s.title)}
              </div>
              <Markdown content={s.body} specKeywords />
            </div>
          ))}
      </section>
    );
  }
  const removed = delta.removedScenarios;
  const paras = paragraphs(req.body);
  const shownParas = allParagraphs ? paras : paras.slice(0, VISIBLE);
  const shownScenarios = allScenarios ? req.scenarios : req.scenarios.slice(0, VISIBLE);
  return (
    <section data-requirement className={`border-l-4 ${DELTA_BORDER[delta.op]} py-1 pl-4`}>
      {/* 左侧外推 8px 进色条内距，淡底不贴字、文本位置不变。 */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`-ml-2 flex w-[calc(100%+0.5rem)] min-w-0 cursor-(--cursor-interaction) items-start gap-2 px-2 py-1 text-left ${TOGGLE_HOVER_CLS}`}
      >
        <span data-requirement-label className={`mt-0.5 ${KW_LABEL_CLS}`}>
          {t("sdetail.requirementLabel")}
        </span>
        <h3 data-doc-heading className={`min-w-0 flex-1 ${SECTION_HEADING_CLS}`}>
          {req.title}
        </h3>
        {!open && (
          <span className="flex shrink-0 items-center gap-1.5">
            <Badge variant="secondary">{tn("doc.scenarioCount", req.scenarios.length)}</Badge>
            {removed.length > 0 && (
              <Badge variant="outline" className="text-destructive">
                {tn("doc.removedScenariosChip", removed.length)}
              </Badge>
            )}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          {removed.length > 0 && (
            <Callout
              data-removed-scenarios
              tone="caution"
              title={tn("doc.removedScenarios", removed.length)}
              className="my-0"
            >
              <ul className="my-1 flex flex-col gap-0.5">
                {removed.map((name) => (
                  <li key={name}>
                    <del>{name}</del>
                  </li>
                ))}
              </ul>
              <p className="text-sm text-muted-foreground">{t("doc.removedScenariosHint")}</p>
            </Callout>
          )}
          {shownParas.length > 0 && <Markdown content={shownParas.join("\n\n")} specKeywords />}
          {paras.length > shownParas.length && (
            <div>
              <MoreToggle
                label={tn("doc.moreParagraphs", paras.length - shownParas.length)}
                onExpand={() => setAllParagraphs(true)}
              />
            </div>
          )}
          {shownScenarios.map((s, i) => (
            <DeltaScenario key={i} title={s.title} body={s.body} />
          ))}
          {req.scenarios.length > shownScenarios.length && (
            <div>
              <MoreToggle
                label={tn("doc.moreScenarios", req.scenarios.length - shownScenarios.length)}
                onExpand={() => setAllScenarios(true)}
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** delta 查看的一个 Scenario：开头的 WHEN／THEN 等列点成「标签／内容」两栏，其余照 Markdown 接在下方。 */
function DeltaScenario({ title, body }: { title: string; body: string }) {
  const { t } = useI18n();
  const split = splitScenarioSteps(body);
  return (
    <div data-scenario className="border-l-2 border-border pl-4">
      <div className="mb-1 text-xs font-semibold text-muted-foreground">
        {t("sdetail.scenarioLabel").replace("{title}", title)}
      </div>
      {split ? (
        <>
          <div data-scenario-steps className="grid grid-cols-[4rem_1fr] gap-x-3 gap-y-1">
            {split.steps.map((step, i) => (
              <div key={i} className="contents">
                <span className="pt-1 font-mono text-xs lowercase text-muted-foreground">{step.label}</span>
                <Markdown content={step.text} specKeywords className="min-w-0 [&_p]:my-0" />
              </div>
            ))}
          </div>
          {split.rest && <Markdown content={split.rest} specKeywords />}
        </>
      ) : (
        <Markdown content={body} specKeywords />
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";

import {
  REVIEW_LISTS,
  type ReviewList,
  type ReviewRules,
  type StationTicket,
  type TicketFinding,
  type TicketRound,
  type TicketStation,
} from "../adapter";
import { findingAxis } from "../docModel";
import { useI18n } from "../i18n";
import { cn } from "../lib/utils";
import { SEMANTIC_SURFACE } from "../tone";
import { BaselineSmellList } from "./BaselineSmellList";
import { Badge } from "./ui/badge";
import { Callout } from "./ui/callout";
import { ExpandToggle, SECTION_HEADING_CLS } from "./DocParts";
import { SeverityTag } from "./SeverityTag";
import type { DocSummary } from "./DetailShell";
import { DocSkeleton } from "./skeletons";

/** 阶段词：discovery →「首轮」、validation →「复验」（LANGUAGE.md 词条）；legacy 轮无。 */
const PHASE_KEY = {
  discovery: "ticket.phase.discovery",
  validation: "ticket.phase.validation",
} as const;

/** 描述行尾的结构 token `(accepted)`，允许尾端空白；只在行尾辨识，行中出现原样显示。 */
const ACCEPTED_TAIL = /\s*\(accepted\)\s*$/;

/** 描述原文 → 显示文本＋是否标「已接受」（design D4）。 */
function splitAcceptedToken(text: string): { shown: string; accepted: boolean } {
  return ACCEPTED_TAIL.test(text)
    ? { shown: text.replace(ACCEPTED_TAIL, ""), accepted: true }
    : { shown: text, accepted: false };
}

/** 工单分页的加载三态（design D3）：undefined＝加载在途、null＝加载完成无工单
 * （不存在、远程 404、读取或解析失败）、对象＝有内容。 */
type TicketDoc = StationTicket | null | undefined;

/** 两站工单的加载状态（design D3／D5，两个抽屉共用）：`key` 为 change 名或封存
 * 目录名，null＝抽屉关闭或无主体（留住内容陪滑出动画）；`present` 为分页是否出现
 * ——出现时加载、随 `gen` 重载、消失时清回未加载；换 `key` 先清回骨架再载。
 * latest-wins：每站一个序号，清空与换主体也推进序号，晚到的旧回应一律丢弃。
 * 失败与无工单同一终态 null（spec：读取或解析失败显示空态而非错误）。 */
export function useStationTickets(
  key: string | null,
  present: Record<TicketStation, boolean>,
  gen: number,
  load: ((key: string, station: TicketStation) => Promise<StationTicket | null>) | undefined,
): Record<TicketStation, TicketDoc> {
  return {
    review: useStationTicket("review", key, present.review, gen, load),
    verify: useStationTicket("verify", key, present.verify, gen, load),
  };
}

function useStationTicket(
  station: TicketStation,
  key: string | null,
  present: boolean,
  gen: number,
  load: ((key: string, station: TicketStation) => Promise<StationTicket | null>) | undefined,
): TicketDoc {
  const [doc, setDoc] = useState<TicketDoc>(undefined);
  const seq = useRef(0);
  const shownKey = useRef<string | null>(null);
  useEffect(() => {
    if (!key) return;
    const mine = ++seq.current;
    if (!present || key !== shownKey.current) setDoc(undefined);
    shownKey.current = key;
    if (!present) return;
    const settle = (v: TicketDoc) => {
      if (seq.current === mine) setDoc(v);
    };
    (load ? load(key, station) : Promise.resolve(null)).then(settle).catch(() => settle(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, present, gen]);
  return doc;
}

/** 两个抽屉共用的分页内容：三态依「抽屉文档加载以 skeleton 呈现」——加载中骨架、
 * 无工单空态文案、有内容交 [`TicketView`]。 */
export function TicketTabBody({ station, ticket }: { station: TicketStation; ticket: TicketDoc }) {
  const { t } = useI18n();
  if (ticket === undefined) return <DocSkeleton />;
  if (ticket === null) {
    return <div className="text-muted-foreground text-sm py-6">{t("ticket.empty")}</div>;
  }
  return <TicketView station={station} ticket={ticket} />;
}

export interface TicketViewProps {
  station: TicketStation;
  ticket: StationTicket;
}

const SEVERITIES: TicketFinding["severity"][] = ["CRITICAL", "WARNING", "SUGGESTION"];

/** 一轮三级严重度各自的条数。 */
function severityCounts(round: TicketRound): Record<TicketFinding["severity"], number> {
  const counts = { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 };
  for (const f of round.findings) counts[f.severity] += 1;
  return counts;
}

/** 依序号升序的轮次（引擎不保证档内顺序）。 */
const sortedRounds = (ticket: StationTicket) => [...ticket.rounds].sort((a, b) => a.index - b.index);

/**
 * 工单文档的签、数字砖与可盖章提示框（spec「详情页的工单分页」；design D8）：签槽为「第 N 轮」与
 * 末轮阶段词，数字砖为轮数与末轮三级计数；末轮 CRITICAL 与 WARNING 皆为 0 时 tip「可以盖章」并
 * 点名该站的 stamp 指令。工单未加载或不存在时全空。
 */
export function ticketSummary(
  station: TicketStation,
  ticket: StationTicket | null | undefined,
  t: (key: string) => string,
): DocSummary {
  if (!ticket || ticket.rounds.length === 0) return { badges: null, tiles: [], callout: null };
  const rounds = sortedRounds(ticket);
  const last = rounds[rounds.length - 1];
  const counts = severityCounts(last);
  const [before, after] = t("ticket.stampHow").split("{cmd}");
  return {
    badges: (
      <>
        <Badge variant="secondary">{roundLabel(t, last.index)}</Badge>
        {last.phase && <Badge variant="outline">{t(PHASE_KEY[last.phase])}</Badge>}
      </>
    ),
    tiles: [
      { value: rounds.length, label: t("ticket.tileRounds") },
      ...SEVERITIES.map((sev) => ({ value: counts[sev], label: t("ticket.tileLast").replace("{sev}", sev) })),
    ],
    callout:
      counts.CRITICAL === 0 && counts.WARNING === 0 ? (
        <Callout tone="tip" title={t("ticket.stampable")} className="my-0">
          <p className="text-sm">
            {counts.SUGGESTION > 0
              ? t("ticket.stampableHint").replace("{n}", String(counts.SUGGESTION))
              : t("ticket.stampableNone")}
          </p>
          <p className="text-sm text-muted-foreground">
            {before}
            <code className="font-mono">{`specseal ${station} stamp`}</code>
            {after}
          </p>
        </Callout>
      ) : null,
  };
}

/**
 * 结构化工单（spec desktop-app「详情页的工单分页」、design D8）：轮次依序号升序逐轮一张卡，
 * 末轮展开、其余收合；展开后先列套用规则列（该轮有记录时），再列范围路径与 finding（色章、
 * 轴向签、等宽路径、原文描述、行尾 accepted 签）。站名、轮数与计数在阅读卡标题区（ticketSummary），内文不另画段标题列。
 * 唯读、无虚拟化。
 */
export function TicketView({ station, ticket }: TicketViewProps) {
  const rounds = sortedRounds(ticket);
  const smells = ticket.reviewBaselineSmells ?? [];
  return (
    <div data-ticket-view data-station={station} className="flex flex-col gap-2">
      {/* key 绑轮数：追加轮后整组重挂，缺省「末轮展开、其余收合」重新成立
          （spec Scenario「工单追加轮后分页更新」），不必逐轮同步状态。轮的 key 用
          数组位置——引擎不检查 `## Round N` 唯一，手改出的同序号不得撞 key。 */}
      <ol key={rounds.length} className="flex flex-col gap-1.5">
        {rounds.map((round, i) => (
          <RoundBlock key={i} round={round} smells={smells} defaultOpen={i === rounds.length - 1} />
        ))}
      </ol>
    </div>
  );
}

function roundLabel(t: (key: string) => string, index: number): string {
  return t("ticket.round").replace("{n}", String(index));
}

/** 轮卡（与调度文档同一种边框卡片）：卡头 16px「第 N 轮」（本页目录锚点）、阶段词、范围档数、条数与
 * 各严重度计数签；展开后先列套用规则列（该轮有记录时）、再列范围路径与 finding。 */
function RoundBlock({ round, smells, defaultOpen }: { round: TicketRound; smells: string[]; defaultOpen: boolean }) {
  const { t, tn } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  const phase = round.phase ? t(PHASE_KEY[round.phase]) : null;
  const counts = severityCounts(round);
  const meta = [
    phase,
    tn("ticket.scopeFiles", round.scope.length),
    tn("ticket.findings", round.findings.length),
  ].filter(Boolean);
  return (
    <li data-ticket-round={round.index} className="overflow-hidden rounded-md border border-border/60 bg-muted/20">
      <ExpandToggle
        data-ticket-round-header
        data-ticket-round-toggle
        open={open}
        onToggle={() => setOpen((v) => !v)}
        className="flex-wrap gap-x-2 gap-y-1 px-3 py-2"
      >
        <h3 data-doc-heading className={SECTION_HEADING_CLS}>
          {roundLabel(t, round.index)}
        </h3>
        <span className="text-xs tabular-nums text-muted-foreground">{meta.map((m) => ` · ${m}`).join("")}</span>
        {SEVERITIES.filter((sev) => counts[sev] > 0).map((sev) => (
          <SeverityTag key={sev} severity={sev} data-ticket-count={sev} className="tabular-nums">
            {`${sev} ${counts[sev]}`}
          </SeverityTag>
        ))}
      </ExpandToggle>
      {open && (
        <div className="flex flex-col gap-2 border-t border-border/60 px-3 py-2">
          {round.rules && <RulesRow rules={round.rules} smells={smells} />}
          <ul className="flex flex-col gap-0.5">
            {round.scope.map((path) => (
              <li key={path} data-ticket-scope-path className="break-all font-mono text-[11px] text-muted-foreground">
                {path}
              </li>
            ))}
          </ul>
          {round.findings.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("ticket.noFindings")}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {round.findings.map((f, i) => (
                <FindingRow key={`${f.path}-${i}`} finding={f} />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/** 项目规则清单的严重度签：清单名的大写（critical → CRITICAL）。 */
const severityOf = (list: ReviewList) => list.toUpperCase();

/** 套用规则列（spec「详情页的工单分页」）：缺省收合；列头依 baseline 与项目规则条数写模式并附非零的
 * 条数签，replace 且没有项目规则时琥珀底；展开后列缺省清单（或写明没有套用）、各严重度的规则原文与
 * 末尾注记。N 取 `smells` 的长度。 */
function RulesRow({ rules, smells }: { rules: ReviewRules; smells: string[] }) {
  const { t, tn } = useI18n();
  const [open, setOpen] = useState(false);
  const groups = REVIEW_LISTS.filter((list) => rules[list].length > 0);
  const extend = rules.baseline === "extend";
  const mode = extend
    ? groups.length > 0
      ? "ticket.rules.extendWithRules"
      : "ticket.rules.baselineOnly"
    : groups.length > 0
      ? "ticket.rules.replaceWithRules"
      : "ticket.rules.replaceEmpty";
  return (
    <div
      data-ticket-rules
      className={cn("rounded-md border", !extend && groups.length === 0 ? SEMANTIC_SURFACE.warning : "border-border/60")}
    >
      <ExpandToggle
        data-ticket-rules-toggle
        open={open}
        onToggle={() => setOpen((v) => !v)}
        className="flex-wrap gap-x-2 gap-y-1 px-2 py-1.5 text-xs"
      >
        <span data-ticket-rules-label className="font-medium">
          {t("ticket.rules.label")}
        </span>
        <span data-ticket-rules-mode className="text-muted-foreground">
          {tn(mode, smells.length)}
        </span>
        {groups.map((list) => (
          <SeverityTag key={list} severity={severityOf(list)} data-ticket-rules-count={severityOf(list)} className="tabular-nums">
            {`${severityOf(list)} ${rules[list].length}`}
          </SeverityTag>
        ))}
      </ExpandToggle>
      {open && (
        <div data-ticket-rules-body className="flex flex-col gap-2 border-t border-border/60 px-2 py-2 text-xs">
          {extend ? (
            <div data-ticket-rules-baseline className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <SeverityTag data-ticket-severity severity="SUGGESTION" />
                <span>{tn("ticket.rules.baselineOnly", smells.length)}</span>
              </div>
              <BaselineSmellList names={smells} />
            </div>
          ) : (
            <p data-ticket-rules-baseline className="m-0 text-muted-foreground">
              {tn("ticket.rules.baselineNotApplied", smells.length)}
            </p>
          )}
          {groups.map((list) => (
            <div key={list} data-ticket-rules-group={severityOf(list)} className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <SeverityTag data-ticket-severity severity={severityOf(list)} />
                <span>{tn("ticket.rules.projectCount", rules[list].length)}</span>
              </div>
              {/* 规则原文：不翻译、不截断、可换行。 */}
              <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5">
                {rules[list].map((rule, i) => (
                  <li key={i} className="whitespace-pre-wrap break-words">
                    {rule}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p data-ticket-rules-note className="m-0 text-muted-foreground">
            {t("ticket.rules.note")}
          </p>
        </div>
      )}
    </div>
  );
}

function FindingRow({ finding }: { finding: TicketFinding }) {
  const { t } = useI18n();
  // 先切行尾 accepted token、再取开头的轴向前缀（「Standards: (accepted) 语意不清」的 token 在行中，原样）。
  const { shown: tail, accepted } = splitAcceptedToken(finding.text);
  const { axis, text: shown } = findingAxis(tail);
  return (
    <li data-ticket-finding className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
      <SeverityTag data-ticket-severity severity={finding.severity} />
      {axis && (
        <Badge data-ticket-axis variant="outline" className="shrink-0">
          {axis}
        </Badge>
      )}
      <span data-ticket-path className="min-w-0 break-all font-mono text-[11px] text-muted-foreground">
        {finding.path}
      </span>
      {accepted && (
        <span
          data-ticket-accepted
          className="shrink-0 rounded border border-border/60 px-1 py-0.5 text-[10px] font-medium text-muted-foreground"
        >
          {t("ticket.accepted")}
        </span>
      )}
      {/* 描述原文：不翻译、不截断、可换行。 */}
      <span data-ticket-text className="min-w-0 basis-full whitespace-pre-wrap break-words">
        {shown}
      </span>
    </li>
  );
}

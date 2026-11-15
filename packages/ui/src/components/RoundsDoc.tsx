import { useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";

import { itemMarkdown } from "../docModel";
import { openItems, splitRounds, splitRows, splitVerdict, type DiscussionRound } from "../discussionModel";
import { useI18n } from "../i18n";
import { cn } from "../lib/utils";
import { SEMANTIC_SURFACE, SEMANTIC_TONE } from "../tone";
import { InlineMarks, ROW_MD_CLS, RowList } from "./DocParts";
import { Markdown } from "./Markdown";

/** 节点色点：assumptions 主色、interview 取看板讨论栏色相，其他 mode 中性（mode 字符串透传、不设白名单）。 */
const MODE_DOT: Record<string, string> = {
  assumptions: "bg-primary",
  interview: "bg-stage-discussion",
};

/** 字段小标。 */
function FieldLabel({ label }: { label: string }) {
  return <div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>;
}

/**
 * 讨论过程文档（desktop-discussion-doc-views design D3；spec「讨论轮以卡片呈现」）：时间轴上每轮一张卡、由新到旧
 * 排列（只改呈现，记录档的轮顺序不变），卡头为轮次（本页目录锚点）、焦点、mode 与日期；首末轮（画面最下与最上）
 * 缺省展开、其余收合，点卡头切换。任一轮标题不符 scaffold 时整篇 Markdown 退回。讨论详情页与已封存讨论页共用。
 */
export function RoundsDoc({ text, empty }: { text: string; empty?: string }) {
  // 用户点过的轮：记录档中的位置 → 展开与否；没点过的依缺省（首末轮展开）。以记录位置而非画面位置记录：引擎只往
  // 档尾追加，新轮插在最上时不错位；手改记录出现重号时两张卡也各自切换。
  const [toggled, setToggled] = useState<Record<number, boolean>>({});
  const rounds = splitRounds(text);
  if (rounds === null) return <Markdown content={text} empty={empty} />;
  if (rounds.length === 0) return <Markdown content="" empty={empty} />;
  // 轮次大者在上；同号（手改记录）时记录中较后者在上。
  const newestFirst = rounds.map((round, at) => ({ round, at })).sort((a, b) => b.round.round - a.round.round || b.at - a.at);
  return (
    <ol
      data-round-timeline
      className="relative flex flex-col gap-3 pl-6 before:absolute before:top-3 before:bottom-3 before:left-[6px] before:w-px before:bg-border"
    >
      {newestFirst.map(({ round, at }, i) => {
        const open = toggled[at] ?? (i === 0 || i === newestFirst.length - 1);
        return (
          <RoundCard
            key={at}
            round={round}
            open={open}
            onToggle={() => setToggled((prev) => ({ ...prev, [at]: !open }))}
          />
        );
      })}
    </ol>
  );
}

function RoundCard({ round, open, onToggle }: { round: DiscussionRound; open: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const [focus = "", ...focusRest] = (round.fields.Focus ?? "").split("\n");
  return (
    <li data-round={round.round} className="relative">
      <span
        aria-hidden="true"
        data-round-dot
        className={cn(
          "absolute top-3.5 -left-6 h-3.5 w-3.5 rounded-full border-2 border-background",
          MODE_DOT[round.mode] ?? "bg-muted-foreground/50",
        )}
      />
      <div className="overflow-hidden rounded-xl border border-border">
        <h3>
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="flex w-full min-w-0 cursor-(--cursor-interaction) items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-foreground/5"
          >
            {/* 轮次签是静态编号，与同列 mode／日期同层级——走中性，不占用主色。 */}
            <span
              data-doc-heading
              className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground"
            >
              {t("rounds.roundN").replace("{n}", String(round.round))}
            </span>
            {/* 收合时一行截断、展开时折行完整显示（长焦点不被裁掉）。 */}
            <span data-round-focus className={cn("min-w-0 flex-1 text-sm font-medium", open ? "break-words" : "truncate")}>
              {focus.trim() && <InlineMarks text={focus.trim()} />}
            </span>
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {round.mode}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{round.date}</span>
            <ChevronDown
              aria-hidden="true"
              className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
            />
          </button>
        </h3>
        {open && (
          <div className="flex flex-col gap-3 border-t border-border/70 px-4 py-3">
            {round.lead && <Markdown content={round.lead} />}
            {focusRest.join("\n").trim() && <Markdown content={focusRest.join("\n").trim()} />}
            {round.fields.Position !== undefined && <PositionField md={round.fields.Position} />}
            {round.fields["Ruled out"] !== undefined && (
              <div data-round-field="ruledOut">
                <FieldLabel label={t("rounds.ruledOut")} />
                <ul className="flex flex-col gap-1.5">
                  {splitRows(round.fields["Ruled out"]).map((row, i) => (
                    <li key={i} data-ruled-out className="flex items-start gap-2">
                      <X aria-hidden="true" className="mt-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <Markdown content={row} className={ROW_MD_CLS} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {round.fields.Open !== undefined && <OpenField md={round.fields.Open} />}
          </div>
        )}
      </div>
    </li>
  );
}

/** 立场：定论句中等字重、其后列点为细线列。 */
function PositionField({ md }: { md: string }) {
  const { t } = useI18n();
  const { verdict, details } = splitVerdict(md);
  return (
    <div data-round-field="position">
      <FieldLabel label={t("rounds.position")} />
      {verdict && (
        <p data-position-verdict className="font-medium">
          <InlineMarks text={verdict} />
        </p>
      )}
      {details.length > 0 && (
        <div className="mt-2">
          <RowList items={details.map(itemMarkdown)} />
        </div>
      )}
    </div>
  );
}

/** 待决：收敛标记为一行带勾选图标的灰字原文，否则每条一颗琥珀签。 */
function OpenField({ md }: { md: string }) {
  const { t } = useI18n();
  const open = openItems(md);
  return (
    <div data-round-field="open">
      <FieldLabel label={t("rounds.open")} />
      {open.none ? (
        <div data-open-none className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          {open.items[0]}
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {open.items.map((item, i) => (
            <span
              key={i}
              data-open-item
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs",
                SEMANTIC_SURFACE.warning,
                SEMANTIC_TONE.warning,
              )}
            >
              <InlineMarks text={item} />
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

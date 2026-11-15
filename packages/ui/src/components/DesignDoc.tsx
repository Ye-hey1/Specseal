import { useEffect, useRef, useState } from "react";

import {
  itemMarkdown,
  listItemsOf,
  parseContractRows,
  parseDecisions,
  parseGoalsNonGoals,
  parseListItems,
  splitH2Sections,
  splitRisk,
  type DecisionData,
  type H2Section,
} from "../docModel";
import { useI18n } from "../i18n";
import { Callout } from "./ui/callout";
import { Card } from "./ui/card";
import {
  DocSection,
  ExpandToggle,
  InlineMarks,
  KeyValueRows,
  ListBlocks,
  ListSection,
  NAME_CHIP_CLS,
  RowList,
  SECTION_HEADING_CLS,
  SUB_LABEL_CLS,
} from "./DocParts";
import { Markdown } from "./Markdown";

/** 跳到某张决策卡的请求：每次点 D 签 seq 递增，同一张卡可重跳。 */
export interface DecisionJump {
  id: string;
  seq: number;
}

export interface DesignDocProps {
  content: string | null;
  empty?: string;
  jump: DecisionJump | null;
  /** 跳转处理完（命中或没命中）——页据此清掉请求。 */
  onJumped: () => void;
}

/**
 * 设计渲染器（spec「提案与设计章节以中文标签呈现」；design D4）：背景细线列、目标／非目标两栏、
 * 决策可收合卡、实作契约键值列、风险逐条 warning 提示框；其余章节照 Markdown。
 */
export function DesignDoc({ content, empty, jump, onJumped }: DesignDocProps) {
  const doc = content ? splitH2Sections(content) : null;
  const decisionIds = (doc?.sections ?? [])
    .filter((s) => s.key === "sections.decisions")
    .flatMap((s) => parseDecisions(s.content).cards.map((c) => c.id));
  const hit = jump !== null && decisionIds.includes(jump.id);
  // 没命中：只回报完成（页已切到设计文档、自顶端呈现）；命中由该卡自己的 effect 处理。
  useEffect(() => {
    if (jump && !hit) onJumped();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump]);
  if (!doc) return <Markdown content={content} empty={empty} />;
  return (
    <div data-design-doc>
      {doc.preamble && <Markdown content={doc.preamble} />}
      {doc.sections.map((s, i) => (
        <DesignSection key={i} section={s} jump={hit ? jump : null} onJumped={onJumped} />
      ))}
    </div>
  );
}

function DesignSection({ section, jump, onJumped }: { section: H2Section; jump: DecisionJump | null; onJumped: () => void }) {
  const { t } = useI18n();
  const { key, content } = section;
  const title = key ? t(key) : section.title;
  if (key === "sections.context") {
    return <ListSection section={section} title={title} renderList={(items) => <RowList items={items.map(itemMarkdown)} />} />;
  }
  if (key === "sections.risks") {
    return (
      <ListSection
        section={section}
        title={title}
        renderList={(items) => (
          <div className="flex flex-col gap-2.5">
            {items.map((item, i) => {
              const { risk, mitigation } = splitRisk(itemMarkdown(item));
              return (
                <Callout key={i} data-risk tone="warning" title={<InlineMarks text={risk} />} className="my-0">
                  {mitigation && <Markdown content={mitigation} className="[&_p]:my-0" />}
                </Callout>
              );
            })}
          </div>
        )}
      />
    );
  }
  if (key === "sections.goalsNonGoals") {
    const split = parseGoalsNonGoals(content);
    if (split) {
      const columns = [
        { mark: "goals", label: "doc.goals", md: split.goals },
        { mark: "nonGoals", label: "doc.nonGoals", md: split.nonGoals },
      ];
      return (
        <DocSection sectionKey={key} title={title}>
          {split.intro && <Markdown content={split.intro} />}
          <div className="grid grid-cols-2 gap-4">
            {columns.map((col) => {
              const blocks = parseListItems(col.md);
              return (
                <div key={col.mark} data-goals-column={col.mark} className="flex min-w-0 flex-col gap-2">
                  <div className={SUB_LABEL_CLS}>{t(col.label).replace("{n}", String(listItemsOf(blocks).length))}</div>
                  <ListBlocks blocks={blocks} renderList={(items) => <RowList items={items.map(itemMarkdown)} />} />
                </div>
              );
            })}
          </div>
        </DocSection>
      );
    }
  }
  if (key === "sections.decisions") {
    const { intro, cards } = parseDecisions(content);
    return (
      <DocSection sectionKey={key} title={title} count={cards.length > 0 ? cards.length : undefined}>
        <div className="flex flex-col gap-2.5">
          {intro && <Markdown content={intro} />}
          {cards.map((card, i) => (
            <DecisionCard key={i} card={card} mark={card.id ?? String(i + 1)} jump={jump} onJumped={onJumped} />
          ))}
        </div>
      </DocSection>
    );
  }
  if (key === "sections.contract") {
    const rows = parseContractRows(content);
    if (rows) {
      return (
        <DocSection sectionKey={key} title={title}>
          <KeyValueRows rows={rows} />
        </DocSection>
      );
    }
  }
  return (
    <DocSection sectionKey={key} title={title}>
      {content && <Markdown content={content} />}
    </DocSection>
  );
}

/**
 * 可收合的决策卡：缺省收合，点卡头或 D 签跳转才展开。收合只藏内文、标题常驻——本页目录的
 * 锚点集合不随展开收合改变。卷动放在卡自己的 effect：Radix 的 TabsContent 切换后下一轮才挂内文。
 */
function DecisionCard({
  card,
  mark,
  jump,
  onJumped,
}: {
  card: DecisionData;
  mark: string;
  jump: DecisionJump | null;
  onJumped: () => void;
}) {
  const { t, tn } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!jump || jump.id !== card.id) return;
    setOpen(true);
    ref.current?.scrollIntoView?.({ block: "start" });
    onJumped();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump]);
  return (
    <Card ref={ref} size="nested" data-decision={mark} className="overflow-hidden">
      <ExpandToggle open={open} onToggle={() => setOpen((v) => !v)} className="gap-2 px-4 py-3">
        {card.id && <span className={NAME_CHIP_CLS}>{card.id}</span>}
        <h3 data-doc-heading className={`min-w-0 flex-1 ${SECTION_HEADING_CLS}`}>
          <InlineMarks text={card.title} />
        </h3>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {tn("doc.points", card.bullets)}
        </span>
      </ExpandToggle>
      {open && card.body && (
        <div className="border-t border-border/70 px-4 py-3">
          <Markdown content={card.body} />
        </div>
      )}
    </Card>
  );
}

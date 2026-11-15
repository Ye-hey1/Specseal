import type { KeyboardEvent, ReactNode, SyntheticEvent } from "react";

import { splitLead, type ContextModel } from "../discussionModel";
import { useI18n } from "../i18n";
import { CopyButton } from "./CopyButton";
import { displayName } from "./DetailHeader";
import { DocSection, Lead, NameChip, ROW_MD_CLS } from "./DocParts";
import { isImproveKind } from "./improveStyle";
import { Markdown, type NameChip as NameChipRef } from "./Markdown";

export interface ContextDocProps {
  /** 背景的推导（`contextModel`）：收尾行、关联与比对所用的名称清单（本讨论的 slug 为 `names.self`）。 */
  model: ContextModel;
  empty?: string;
  created?: string | null;
  createdBy?: string | null;
  kind?: string | null;
  /** 记录档路径；已封存讨论页为 null（记录列不出文件列）。 */
  recordPath: string | null;
  onOpenSpec?: (capability: string) => void;
  onOpenChange?: (name: string) => void;
  /** 开已封存变更（以变更名；宿主自己换成封存目录名）。 */
  onOpenArchivedChange?: (name: string) => void;
  onOpenDiscussion?: (slug: string) => void;
}

type ChipKind = "spec" | "change" | "archived" | "discussion";

/** 内文名称签的款式：由容器以任意变体给（签是 Markdown 插件产生的 span）。 */
const NAME_CHIP_HOST_CLS =
  "[&_.name-chip]:cursor-(--cursor-interaction) [&_.name-chip]:rounded [&_.name-chip]:border [&_.name-chip]:border-border [&_.name-chip]:bg-background [&_.name-chip]:px-1 [&_.name-chip]:font-mono [&_.name-chip]:text-[0.86em] [&_.name-chip]:text-primary [&_.name-chip:hover]:underline";

type MetaRow = { key: string; label: string; value: ReactNode };

/** 键值列：左键灰字、右值任意内容。 */
function MetaRows({ rows }: { rows: MetaRow[] }) {
  return (
    <dl className="divide-y divide-border/70">
      {rows.map((r) => (
        <div key={r.key} data-context-row={r.key} className="flex items-start gap-4 py-2 first:pt-0 last:pb-0">
          <dt className="w-28 shrink-0 text-sm text-muted-foreground">{r.label}</dt>
          <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 背景文档（desktop-discussion-doc-views design D4；spec「讨论详情页查看与转出变更」）：收尾四行剥离后分三段——
 * 起因与范围（灰底引言＋带名称签的内文）、关联（收尾行与内文命中的联集）、记录（创建、种类、文件）。
 * 内文名称签只给有打开回呼的种类。讨论详情页与已封存讨论页共用。
 */
export function ContextDoc(props: ContextDocProps) {
  const { t } = useI18n();
  const { meta, rel, names } = props.model;
  // 背景全空白：没有内文、也没有任何收尾行。
  if (!meta.body && meta.specs === null && meta.changes === null && meta.prior === null && meta.sourceDoc === null) {
    return <Markdown content="" empty={props.empty} />;
  }
  const { lead, rest } = splitLead(meta.body);
  const open: Record<ChipKind, ((name: string) => void) | undefined> = {
    spec: props.onOpenSpec,
    change: props.onOpenChange,
    archived: props.onOpenArchivedChange,
    discussion: props.onOpenDiscussion,
  };
  const chips: NameChipRef[] = (
    [
      ["spec", rel.hits.specs],
      ["change", rel.hits.changes],
      ["archived", rel.hits.archived],
      ["discussion", rel.hits.discussions],
    ] as const
  ).flatMap(([kind, names]) => (open[kind] ? names.map((name) => ({ kind, name })) : []));

  // 内文名称签的点击与键盘启动：签以 `kind:name` 标在 data 属性上；事件不是来自签时不拦（链接、拷贝钮照常）。
  const chipOf = (e: SyntheticEvent) =>
    (e.target as HTMLElement).closest?.("[data-name-chip]")?.getAttribute("data-name-chip") ?? null;
  const activate = (value: string) => {
    const at = value.indexOf(":");
    open[value.slice(0, at) as ChipKind]?.(value.slice(at + 1));
  };
  const onClick = (e: SyntheticEvent) => {
    const value = chipOf(e);
    if (value) activate(value);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const value = chipOf(e);
    if (!value) return;
    e.preventDefault();
    activate(value);
  };

  const chipRow = (names: string[], known: string[], onOpen?: (name: string) => void) =>
    names.map((name) => (
      <NameChip key={name} name={name} onClick={onOpen && known.includes(name) ? () => onOpen(name) : undefined} />
    ));
  const relations = ([
    rel.specs.length > 0 && {
      key: "specs",
      label: t("context.relSpecs"),
      value: chipRow(rel.specs, names.specs, props.onOpenSpec),
    },
    rel.changes.length > 0 && {
      key: "changes",
      label: t("context.relChanges"),
      value: chipRow(rel.changes, names.active, props.onOpenChange),
    },
    rel.archived.length > 0 && {
      key: "archived",
      label: t("context.relArchived"),
      value: chipRow(rel.archived, names.archived, props.onOpenArchivedChange),
    },
    rel.prior.length > 0 && {
      key: "prior",
      label: t("context.relPrior"),
      value: chipRow(rel.prior, names.discussions, props.onOpenDiscussion),
    },
    meta.sourceDoc !== null && {
      key: "source",
      label: t("context.relSource"),
      value: meta.sourceDoc ? <span className="font-mono text-sm break-all">{meta.sourceDoc}</span> : t("context.none"),
    },
  ] as (MetaRow | false)[]).filter((r): r is MetaRow => r !== false);

  const created = [props.created, props.createdBy && displayName(props.createdBy)].filter(Boolean).join(" · ");
  const record = ([
    !!created && { key: "created", label: t("context.created"), value: created },
    {
      key: "kind",
      label: t("context.kind"),
      value: t(isImproveKind(props.kind) ? "context.kindImprove" : "context.kindGeneral"),
    },
    !!props.recordPath && {
      key: "file",
      label: t("context.file"),
      value: (
        <>
          <span className="font-mono text-sm break-all">{props.recordPath}</span>
          <CopyButton value={props.recordPath!} label={t("common.copy")} />
        </>
      ),
    },
  ] as (MetaRow | false)[]).filter((r): r is MetaRow => r !== false);

  return (
    <div>
      {(lead || rest) && (
        <DocSection sectionKey="context.intro" title={t("context.intro")}>
          {/* 签由 Markdown 插件产生、不是组件：点击与键盘在容器上拦。 */}
          <div className={`flex flex-col gap-3 ${NAME_CHIP_HOST_CLS}`} onClick={onClick} onKeyDown={onKeyDown}>
            {lead && (
              <div data-context-lead>
                <Lead>
                  <Markdown content={lead} nameChips={chips} className={ROW_MD_CLS} />
                </Lead>
              </div>
            )}
            {rest && <Markdown content={rest} nameChips={chips} />}
          </div>
        </DocSection>
      )}
      {relations.length > 0 && (
        <DocSection sectionKey="context.relations" title={t("context.relations")}>
          <MetaRows rows={relations} />
        </DocSection>
      )}
      <DocSection sectionKey="context.record" title={t("context.record")}>
        <MetaRows rows={record} />
      </DocSection>
    </div>
  );
}

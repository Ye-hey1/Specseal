import type { ManualPageItem } from "../adapter";
import { useI18n } from "../i18n";
import { groupSections } from "../manualDoc";
import { matchesQuery } from "../search";
import { SEMANTIC_SURFACE, SEMANTIC_TONE } from "../tone";
import { SearchField } from "./SearchField";
import { TREE_NODE_CLS } from "./ui/tabs";

export interface ManualTreeProps {
  /** 全部页（已依阅读序排好）。 */
  pages: ManualPageItem[];
  currentSlug: string;
  query: string;
  onQuery: (query: string) => void;
  onSelect: (slug: string) => void;
  /** 手册生成后添加且未入册的规格数；0 不显示提示。 */
  uncoveredCount: number;
}

/** 手册页左栏（spec「手册页的侧栏树与阅读序」「手册页的搜索列」「可能过期与未入册的
 * 标示」；design D5：240px 淡灰底；desktop-spec-manual-pages design D7：页列与详情页文档树的
 * 节点同款）：搜索列以大小写不敏感比对 title 与 keywords、命中页依分区分组列出（stale 者列尾
 * 带「过期」签）、底部在有未入册规格时显示计数提示。 */
export function ManualTree({ pages, currentSlug, query, onQuery, onSelect, uncoveredCount }: ManualTreeProps) {
  const { t, tn } = useI18n();
  const visibleSections = groupSections(
    pages.filter((p) => matchesQuery(query, p.title, ...p.keywords)),
    t("manual.sectionOther"),
  );
  return (
    <aside className="flex w-60 shrink-0 flex-col gap-2 border-r border-border bg-sidebar p-3">
      <SearchField value={query} onChange={onQuery} placeholder={t("manual.searchPlaceholder")} />
      <nav data-manual-tree className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        {visibleSections.length === 0 ? (
          <div data-manual-no-results className="py-4 text-center text-sm text-muted-foreground">
            {t("manual.noResults")}
          </div>
        ) : (
          visibleSections.map((section, i) => (
            // 以位置为 key：明写 section「其他」的组与缺 section 归「其他」的组可能不相邻。
            <section
              key={i}
              data-manual-section={section.label}
              className={i > 0 ? "border-t border-border pt-3" : undefined}
            >
              <h3 className="px-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {section.label}
              </h3>
              <ul className="mt-1 flex flex-col gap-0.5">
                {section.pages.map((p) => {
                  const active = p.slug === currentSlug;
                  return (
                    <li key={p.slug}>
                      <button
                        type="button"
                        data-manual-page={p.slug}
                        aria-current={active ? "page" : undefined}
                        data-state={active ? "active" : "inactive"}
                        className={TREE_NODE_CLS}
                        onClick={() => onSelect(p.slug)}
                      >
                        <span className="min-w-0 flex-1 truncate">{p.title}</span>
                        {p.stale && (
                          <span
                            data-manual-stale
                            className={`shrink-0 rounded-full px-1.5 text-[10px] font-medium ${SEMANTIC_SURFACE.warning} ${SEMANTIC_TONE.warning}`}
                          >
                            {t("manual.staleShort")}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </nav>
      {uncoveredCount > 0 && (
        <div
          data-manual-uncovered
          className={`mt-auto rounded-md border px-2 py-1.5 text-xs ${SEMANTIC_SURFACE.warning}`}
        >
          {tn("manual.uncoveredNew", uncoveredCount)}
        </div>
      )}
    </aside>
  );
}

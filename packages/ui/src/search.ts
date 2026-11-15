/**
 * 看板与已封存页共用的搜索比对规则（spec「与已封存页的搜索规则一致」的单一真相）：
 * query 去头尾空白、不分大小写、以子字符串命中任一字段；空（或仅空白）query 恒命中。
 */
export function matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f ?? "").toLowerCase().includes(q));
}

/**
 * 名称层模糊比对（design D7）：查找字符依序出现于目标即命中（subsequence，
 * 不分大小写、去头尾空白）。仅套用于变更卡名称与讨论卡 slug——摘要与主题
 * 维持子字符串（spec「名称层模糊比对」）。空 query 恒命中。
 */
export function matchesFuzzy(query: string, target: string | null | undefined): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const t = (target ?? "").toLowerCase();
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}

/** 看板筛选状态（design D5）：三维度、null＝未激活；多 chip 与搜索字符串 AND 交集。 */
export interface BoardFilters {
  /** 创建者（"Name <email>" 全等比对）。 */
  createdBy: string | null;
  /** 创建时间窗：近 7 天／近 30 天／更早（超过 30 天）。 */
  createdWithin: "7d" | "30d" | "earlier" | null;
  /** 来源讨论 slug：命中该讨论卡自身与来源讨论含该 slug 的变更卡。 */
  fromDiscussion: string | null;
}

export const EMPTY_FILTERS: BoardFilters = {
  createdBy: null,
  createdWithin: null,
  fromDiscussion: null,
};

/**
 * created 日期（YYYY-MM-DD）是否落在时间窗内（以 today 为基准）。
 * 未激活（range null）恒命中；日期缺席或不可解析时不命中任何激活中的窗。
 */
export function matchesCreatedRange(
  created: string | null | undefined,
  range: BoardFilters["createdWithin"],
  today: string,
): boolean {
  if (!range) return true;
  if (!created) return false;
  const days = (new Date(today).getTime() - new Date(created).getTime()) / 86_400_000;
  if (Number.isNaN(days)) return false;
  if (range === "7d") return days <= 7;
  if (range === "30d") return days <= 30;
  return days > 30;
}

/**
 * 筛选 chips 的 AND 交集比对（design D5）：卡片（变更或讨论）须同时满足所有
 * 激活中的维度。变更卡以 fromDiscussions 命中来源讨论；讨论卡以自身 slug 命中
 * （spec「来源讨论筛选」：该讨论卡自身与其衍生变更卡）。
 */
export function matchesFilters(
  filters: BoardFilters,
  card: {
    createdBy?: string | null;
    created?: string | null;
    fromDiscussions?: string[];
    slug?: string;
  },
  today: string,
): boolean {
  if (filters.createdBy && card.createdBy !== filters.createdBy) return false;
  if (!matchesCreatedRange(card.created, filters.createdWithin, today)) return false;
  if (filters.fromDiscussion) {
    const hit =
      card.slug === filters.fromDiscussion ||
      (card.fromDiscussions ?? []).includes(filters.fromDiscussion);
    if (!hit) return false;
  }
  return true;
}

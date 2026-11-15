import { useEffect, useRef, useState, type RefObject } from "react";

import { useI18n } from "../i18n";
import { cn } from "../lib/utils";

/** 锚点列的一笔：内文 h2／h3 的 DOM id、纯文本与层级。 */
interface TocEntry {
  id: string;
  text: string;
  level: 2 | 3;
}

export interface ManualTocProps {
  /** 内文容器——锚点由它渲染后的 DOM 推导，点击也卷动它所在的卷动容器。 */
  bodyRef: RefObject<HTMLElement | null>;
  /** 目前渲染的内文（或任何随内文 DOM 变化的键）；换了就重扫标题。 */
  markdownBody: string | null;
  /** 列入目录的标题选择器（缺省：内文 Markdown 的 h2／h3）。 */
  headings?: string;
  className?: string;
}

/** 手册页右侧锚点列（spec「内页渲染与出处跳规格」），规格详情页的需求目录亦用：由渲染后的
 * DOM 扫标题（与画面一致，不另解析 Markdown）、给 id；点击卷至该标题；卷动时以卷动容器顶缘
 * 下方 12px 内最后一个标题为目前段。卷动容器可能是内文本身（手册页）或其祖先（规格详情页的
 * 页层），故以 capture 收任一元素的卷动、只理会包住内文者。没有标题时不渲染。 */
export function ManualToc({ bodyRef, markdownBody, headings = ".markdown h2, .markdown h3", className }: ManualTocProps) {
  const { t } = useI18n();
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // 目前段的标题元素：重扫（规格详情页展开／收合需求段）时它若仍在，高亮留在它身上——展开不卷动，
  // 不会有卷动事件把高亮带回来；换文档、搜索换掉标题时才回第一项。
  const activeEl = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = bodyRef.current;
    // null＝还没扫过，第一次一定更新（没有标题也要把目录清空）。
    let heads: HTMLElement[] | null = null;
    const scan = () => {
      const next = root ? Array.from(root.querySelectorAll<HTMLElement>(headings)) : [];
      // 节点增减没换到标题（如展开收合轮卡）就不动目录。只比标题元素、不比文本：同一标题元素换字不会增减节点，
      // 要靠调用端把内文放进重扫键（markdownBody），让整段重跑。
      const prev = heads;
      if (prev && next.length === prev.length && next.every((el, i) => el === prev[i])) return;
      heads = next;
      heads.forEach((el, i) => {
        el.id = `manual-h-${i}`;
      });
      setToc(heads.map((el) => ({ id: el.id, text: el.textContent ?? "", level: el.tagName === "H3" ? 3 : 2 })));
      const kept = activeEl.current && heads.includes(activeEl.current) ? activeEl.current : (heads[0] ?? null);
      activeEl.current = kept;
      setActiveId(kept?.id ?? null);
    };
    scan();
    if (!root) return;
    // 详情页以分页换文档时，新文档的内容晚一次画面更新才挂上，重扫键变动那次扫到的还是前一份：
    // 内文节点一增减就重扫。
    const observer = new MutationObserver(scan);
    observer.observe(root, { childList: true, subtree: true });
    const onScroll = (e: Event) => {
      if (!heads || heads.length === 0) return;
      const scroller = e.target instanceof Element ? e.target : null;
      if (scroller && !scroller.contains(root)) return;
      const top = (scroller?.getBoundingClientRect().top ?? 0) + 12;
      let hit = heads[0];
      for (const el of heads) {
        if (el.getBoundingClientRect().top <= top) hit = el;
        else break;
      }
      activeEl.current = hit;
      setActiveId(hit.id);
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      observer.disconnect();
      document.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [bodyRef, markdownBody, headings]);

  if (toc.length === 0) return null;
  return (
    <nav
      data-manual-toc
      aria-label={t("manual.toc")}
      className={cn(
        "hidden w-[200px] shrink-0 flex-col gap-1 overflow-y-auto border-l border-border py-5 pl-3 pr-5 lg:flex",
        className,
      )}
    >
      <div className="px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t("manual.toc")}
      </div>
      <ul className="flex flex-col">
        {toc.map((h) => {
          const active = h.id === activeId;
          return (
            <li key={h.id}>
              <button
                type="button"
                data-manual-anchor={h.id}
                aria-current={active ? "location" : undefined}
                className={`w-full truncate border-l-2 py-1 text-left text-xs ${h.level === 3 ? "pl-5" : "pl-2"} ${
                  active
                    ? "border-primary font-medium text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
                onClick={() =>
                  bodyRef.current
                    ?.querySelector<HTMLElement>(`#${h.id}`)
                    ?.scrollIntoView({ block: "start", behavior: "smooth" })
                }
              >
                {h.text}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

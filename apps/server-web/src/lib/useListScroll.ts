import { useRef } from "react";

/** 列表卡的卷动区：`scrollRef` 交给 ListCard，换页、改每页笔数或切分页后调用 `scrollToTop` 卷回顶部。 */
export function useListScroll() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollToTop = () => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };
  return { scrollRef, scrollToTop };
}

import { useEffect, useState } from "react";

// 以 matchMedia 判断窗口宽度／偏好，据以条件渲染侧栏或 Sheet（D6）。
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = () => setMatches(mql.matches);
    handler();
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);
  return matches;
}

/** 窄屏幕（<1024px）：壳改用 Sheet 导览、列表改窄版——全站同一个断点。 */
export function useNarrow(): boolean {
  return useMediaQuery("(max-width: 1023px)");
}

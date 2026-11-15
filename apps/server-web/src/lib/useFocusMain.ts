import { useEffect, type RefObject } from "react";

// route 切换后 focus 移至 <main> 标题（D3／可访问性）。找不到 h1 时退回聚焦 main。
export function useFocusMain(mainRef: RefObject<HTMLElement | null>, key: string) {
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const heading = main.querySelector("h1") as HTMLElement | null;
    const target = heading ?? main;
    target.tabIndex = -1;
    target.focus();
  }, [mainRef, key]);
}

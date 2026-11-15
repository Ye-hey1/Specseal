import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

/**
 * 详情页的文档加载：打开时全量加载、世代递增时就地重载（不清空）。`load` 收到「此回应仍是最新」
 * 的检查——回应晚到且已被后一次加载取代即丢弃（latest-wins）。换目标由调用端以 key 重挂处理。
 */
export function useGenerationLoad(gen: number, load: (isLatest: () => boolean) => void) {
  const seq = useRef(0);
  const loadedGen = useRef(-1);
  useEffect(() => {
    if (gen <= loadedGen.current) return;
    loadedGen.current = gen;
    const mine = ++seq.current;
    load(() => seq.current === mine);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen]);
}

/** 失败收敛：还没有东西可显示才落终态空值（undefined 停着＝永久骨架）；已有内容维持前值。 */
export function settle<T>(apply: Dispatch<SetStateAction<T | undefined>>, empty: NoInfer<T>, isLatest: () => boolean) {
  return () => {
    if (isLatest()) apply((prev) => (prev === undefined ? empty : prev));
  };
}

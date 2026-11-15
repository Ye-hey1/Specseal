import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DetailNav } from "@specseal/ui";

// 详情页接主区顶列的唯一落点（server-web-detail-pages design D2）：ConsoleLayout 持有面包屑第三段
// 的名称与顶列右端的插槽节点，详情页以 DetailTitle 交出名称、把 ‹ n / m › 以 portal 送进插槽。
// 只有字符串进 state——ReactNode 进 state 会随每次渲染换身分而造成循环，所以导览组件走 portal。

type DetailTitleContextValue = {
  setLabel: (label: string | null) => void;
  /** 顶列右端的插槽；尚未挂上时为 null。 */
  slot: HTMLElement | null;
};

// 壳外（只渲染单页的测试）没有 provider：名称无处可交、导览不渲染。
const DetailTitleContext = createContext<DetailTitleContextValue>({ setLabel: () => {}, slot: null });

export function DetailTitleProvider({
  setLabel,
  slot,
  children,
}: DetailTitleContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ setLabel, slot }), [setLabel, slot]);
  return <DetailTitleContext.Provider value={value}>{children}</DetailTitleContext.Provider>;
}

/** 详情页的标题列：面包屑第三段为 `label`，顶列右端为 ‹ n / m ›（`index` 为 -1 时整组缺席）。 */
export function DetailTitle({
  label,
  index,
  total,
  onStep,
}: {
  label: string;
  index: number;
  total: number;
  onStep: (delta: -1 | 1) => void;
}) {
  const { setLabel, slot } = useContext(DetailTitleContext);
  useEffect(() => {
    setLabel(label);
    return () => setLabel(null);
  }, [label, setLabel]);
  if (!slot) return null;
  return createPortal(<DetailNav index={index} total={total} onStep={onStep} />, slot);
}

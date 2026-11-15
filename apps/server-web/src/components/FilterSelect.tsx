import type { ReactNode } from "react";
import { SELECT_ALL, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@specseal/ui";

/** 页标题区的筛选下拉（server-web-list-pages design D2）：没有可见标签，以 `label` 作无障碍名称；
 *  高度与搜索框同为 h-8（SelectTrigger 缺省）。空字符串代表不筛选，选项为「全部」——Radix Select 禁止
 *  空字符串当 item value，所以在组件内部与共用的 `SELECT_ALL` 来回换，调用端仍只认得空字符串。 */
export function FilterSelect({
  label,
  allLabel,
  value,
  onChange,
  children,
}: {
  label: string;
  /** 「不筛选」那一项的文本，例如「全部状态」。 */
  allLabel: string;
  value: string;
  onChange: (value: string) => void;
  /** 该筛选器自己的选项（`SelectItem`），不含「全部」。 */
  children: ReactNode;
}) {
  return (
    <Select value={value === "" ? SELECT_ALL : value} onValueChange={(v) => onChange(v === SELECT_ALL ? "" : v)}>
      <SelectTrigger aria-label={label} className="w-auto min-w-32 text-[13px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={SELECT_ALL}>{allLabel}</SelectItem>
        {children}
      </SelectContent>
    </Select>
  );
}

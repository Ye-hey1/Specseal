import { Search } from "lucide-react";

import { Input } from "./ui/input";

export interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** 输入框的无障碍名称（server-web 列表页没有可见标签）。 */
  label?: string;
}

/** 全圆搜索框（design D3；与看板同款）：左侧搜索图标＋280px 圆角输入框。 */
export function SearchField({ value, onChange, placeholder, label }: SearchFieldProps) {
  return (
    <div className="relative">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-[280px] max-w-full rounded-full pl-8"
      />
    </div>
  );
}

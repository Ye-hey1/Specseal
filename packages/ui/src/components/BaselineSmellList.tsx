import type { HTMLAttributes } from "react";

/** 审查站缺省 smell 名称清单（名称由引擎提供）：desktop 设置页的审查规则页与工单分页的
 * 套用规则列共用同一个组件。 */
export function BaselineSmellList({ names, ...rest }: { names: readonly string[] } & HTMLAttributes<HTMLUListElement>) {
  return (
    <ul data-baseline-smells {...rest} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
      {names.map((name) => (
        <li key={name} className="rounded-md border border-border bg-muted/40 px-2 py-0.5 font-mono text-xs">
          {name}
        </li>
      ))}
    </ul>
  );
}

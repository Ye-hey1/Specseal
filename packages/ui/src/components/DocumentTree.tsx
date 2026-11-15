import type { ChangeItem, SpecItem } from "../adapter";
import { Button } from "./ui/button";
import { SectionHeader } from "./SectionHeader";

/** 树上被选取的节点：一个 change 或一个 spec。 */
export interface TreeSelection {
  kind: "change" | "spec";
  id: string;
}

export interface DocumentTreeProps {
  changes: ChangeItem[];
  specs: SpecItem[];
  onSelect?: (sel: TreeSelection) => void;
}

/** 导览树：change 与 spec 两区，点击触发 onSelect。纯呈现，数据由 props 注入。 */
export function DocumentTree({ changes, specs, onSelect }: DocumentTreeProps) {
  return (
    <nav className="flex flex-col gap-4">
      <section>
        <SectionHeader label="Changes" className="px-2 mb-1.5" />
        <ul className="list-none m-0 p-0 flex flex-col gap-0.5">
          {changes.map((c) => (
            <li key={c.name}>
              <Button
                variant="ghost"
                className="w-full justify-start h-8 px-2.5 font-normal"
                onClick={() => onSelect?.({ kind: "change", id: c.name })}
              >
                {c.name}
              </Button>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <SectionHeader label="Specs" className="px-2 mb-1.5" />
        <ul className="list-none m-0 p-0 flex flex-col gap-0.5">
          {specs.map((s) => (
            <li key={s.id}>
              <Button
                variant="ghost"
                className="w-full justify-start h-8 px-2.5 font-normal"
                onClick={() => onSelect?.({ kind: "spec", id: s.id })}
              >
                {s.id}
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </nav>
  );
}

// Sheet 滑出方向（server-web-shell-alignment design D6）：窄屏幕导览从左侧滑出，抽屉照旧贴右。
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { Sheet, SheetContent, SheetTitle } from "../components/ui/sheet";

const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

function Fixture({ side }: { side?: "left" | "right" }) {
  return (
    <Sheet open>
      <SheetContent side={side}>
        <SheetTitle>面板</SheetTitle>
      </SheetContent>
    </Sheet>
  );
}

describe("SheetContent side", () => {
  it("side=left 贴左、右侧细线", () => {
    render(<Fixture side="left" />);
    const cls = classes(screen.getByRole("dialog"));
    expect(cls).toEqual(expect.arrayContaining(["left-0", "border-r", "data-[state=open]:slide-in-from-left"]));
    expect(cls).not.toContain("right-0");
    expect(cls).not.toContain("border-l");
  });

  it("未给 side 时维持贴右、左侧细线", () => {
    render(<Fixture />);
    const cls = classes(screen.getByRole("dialog"));
    expect(cls).toEqual(expect.arrayContaining(["right-0", "border-l", "data-[state=open]:slide-in-from-right"]));
    expect(cls).not.toContain("left-0");
  });
});

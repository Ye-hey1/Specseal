// 内置 AI 工具勾选的共用断言：初始化确认、激活确认与 checkout 步骤都依同一个顺串行出五个工具。
// 期望的顺序写在这里，不读被测的 BUILTIN_TOOLS。
import { expect } from "vitest";
import { within } from "@testing-library/react";

const TOOL_ORDER = ["claude", "codex", "copilot", "pi", "cursor"] as const;

/** `container` 内恰好依 claude、codex、copilot、pi、cursor 顺序出现五个勾选，且只有 `checked` 列出的工具是勾选状态。 */
export function expectToolCheckboxes(container: HTMLElement, checked: readonly (typeof TOOL_ORDER)[number][]) {
  const boxes = within(container).getAllByRole("checkbox");
  expect(TOOL_ORDER.map((name) => boxes.indexOf(within(container).getByRole("checkbox", { name })))).toEqual([
    0, 1, 2, 3, 4,
  ]);
  expect(boxes.map((box) => box.getAttribute("aria-checked"))).toEqual(
    TOOL_ORDER.map((name) => String(checked.includes(name))),
  );
}

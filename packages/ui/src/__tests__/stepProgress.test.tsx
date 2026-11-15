// 多步骤进度列（server-web-shell-alignment design D7）：desktop 工作区精灵与 server 初始设置共用。
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { StepProgress } from "../components/StepProgress";

const filled = () =>
  Array.from(screen.getByTestId("step-bar").children).filter((seg) =>
    (seg.getAttribute("class") ?? "").split(/\s+/).includes("bg-primary"),
  ).length;

describe("StepProgress", () => {
  it("「步骤 n / total」加步骤条，已到的段为主色", () => {
    render(<StepProgress current={2} total={4} />);
    expect(screen.getByText("步骤 2 / 4")).toBeTruthy();
    expect(screen.getByTestId("step-bar").children).toHaveLength(4);
    expect(filled()).toBe(2);
  });

  it("前缀接在步骤文本前，以「 · 」分隔", () => {
    render(<StepProgress prefix="初始设置" current={1} total={2} />);
    expect(screen.getByText("初始设置 · 步骤 1 / 2")).toBeTruthy();
    expect(filled()).toBe(1);
  });
});

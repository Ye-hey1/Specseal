// 共用空状态与区段标题（spec desktop-app「共用组件唯一来源」；design D8）。
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Inbox } from "lucide-react";

import { EmptyState } from "../components/EmptyState";
import { SectionHeader } from "../components/SectionHeader";

const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

describe("EmptyState", () => {
  it("置中直栏：40px 图标、2xl 一般字重标题、13px 灰字描述、动作", () => {
    render(
      <EmptyState
        icon={Inbox}
        title="尚无项目"
        description="添加一个项目开始"
        action={<button>添加</button>}
      />,
    );
    const title = screen.getByText("尚无项目");
    expect(classes(title)).toEqual(expect.arrayContaining(["text-2xl", "font-normal"]));
    expect(classes(screen.getByText("添加一个项目开始"))).toEqual(
      expect.arrayContaining(["text-[13px]", "text-muted-foreground"]),
    );
    const root = title.parentElement as HTMLElement;
    expect(classes(root)).toEqual(
      expect.arrayContaining(["flex", "flex-col", "items-center", "text-center"]),
    );
    const icon = root.querySelector("svg") as SVGElement;
    expect(classes(icon)).toEqual(expect.arrayContaining(["h-10", "w-10"]));
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("button", { name: "添加" })).toBeTruthy();
  });

  it("描述与动作可省略", () => {
    render(<EmptyState icon={Inbox} title="空" />);
    expect(screen.getByText("空").parentElement!.querySelectorAll("p").length).toBe(0);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("SectionHeader", () => {
  it("一列 xs 粗体灰字，计数为 badge 并可带色", () => {
    render(
      <SectionHeader
        icon={<svg data-testid="icon" />}
        label="提案中"
        count={3}
        countClassName="bg-stage-proposed/10 text-stage-proposed"
      />,
    );
    const row = screen.getByText("提案中").closest("div") as HTMLElement;
    expect(classes(row)).toEqual(
      expect.arrayContaining(["text-xs", "font-semibold", "text-muted-foreground"]),
    );
    expect(row.contains(screen.getByTestId("icon"))).toBe(true);
    const count = screen.getByTestId("section-count");
    expect(count.textContent).toBe("3");
    expect(classes(count)).toEqual(
      expect.arrayContaining(["rounded-full", "bg-stage-proposed/10", "text-stage-proposed"]),
    );
  });

  it("未给计数时不出 badge（计数未知不谎报 0）", () => {
    render(<SectionHeader label="讨论" />);
    expect(screen.queryByTestId("section-count")).toBeNull();
  });

  it("计数未带色时为中性 badge：直接用 Badge 的 secondary 变体，不以 className 改色", () => {
    render(<SectionHeader label="已转出" count={0} />);
    const count = classes(screen.getByTestId("section-count"));
    expect(count).toEqual(expect.arrayContaining(["bg-muted", "text-foreground"]));
    expect(count).not.toContain("text-muted-foreground");
  });

  it("action 渲染在列尾", () => {
    render(<SectionHeader label="规格" action={<button>全部</button>} />);
    const row = screen.getByText("规格").closest("div") as HTMLElement;
    expect(row.lastElementChild!.textContent).toBe("全部");
  });
});

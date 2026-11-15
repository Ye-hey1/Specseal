// 详情页「状态」列的标签栏（fix-english-status-labels-and-plurals D1、D5；desktop-app「详情页状态栏的
// 标签栏依最长标签对齐」）：各列以 subgrid 共用同一个标签栏，栏宽取最长标签（下限 56px、上限 112px），
// 英文单字标签不再溢出到数值上。jsdom 量不到版面，这里钉住结构；画面由实机验收。
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import { DetailStatus } from "../components/DetailShell";
import { StatusRow } from "../components/DetailHeader";

function renderStatus() {
  return render(
    <DetailStatus>
      <StatusRow mark="requirements" label="Requirements">
        2
      </StatusRow>
      <StatusRow mark="sources" label="Provenance">
        1
      </StatusRow>
    </DetailStatus>,
  );
}

describe("详情页状态栏的标签栏", () => {
  it("容器是两栏格线：标签栏依内容宽、数值栏吃剩下的宽", () => {
    const { container } = renderStatus();
    const section = container.querySelector("[data-status-card]") as HTMLElement;
    expect(section.className).toContain("grid");
    expect(section.className).toContain("grid-cols-[max-content_minmax(0,1fr)]");
  });

  it("每一列跨两栏并以 subgrid 共用容器的栏", () => {
    const { container } = renderStatus();
    for (const mark of ["requirements", "sources"]) {
      const row = container.querySelector(`[data-status-${mark}]`) as HTMLElement;
      expect(row.className).toContain("col-span-2");
      expect(row.className).toContain("grid-cols-subgrid");
    }
  });

  it("标签宽度下限 56px、上限 112px、可在字间折行，不再写死 w-14", () => {
    const { container } = renderStatus();
    const label = container.querySelector("[data-status-requirements] > span") as HTMLElement;
    expect(label.textContent).toBe("Requirements");
    const classes = label.className.split(/\s+/);
    expect(classes).toContain("min-w-14");
    expect(classes).toContain("max-w-28");
    expect(classes).toContain("break-words");
    expect(classes).not.toContain("w-14");
  });
});

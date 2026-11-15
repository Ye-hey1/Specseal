// design D1／D3／D7：详情页三栏骨架与标题列动作插槽。
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { useRef, useState, type ReactNode } from "react";

import { I18nProvider, useI18n } from "../i18n";
import {
  DetailActions,
  DetailActionsSlot,
  DetailActionsSlotProvider,
  DetailIdentity,
  DetailShell,
  DocBody,
  DocTiles,
} from "../components/DetailShell";
import { TooltipProvider } from "../components/ui/tooltip";

const wrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">
    <TooltipProvider>{children}</TooltipProvider>
  </I18nProvider>
);

function Shell() {
  const bodyRef = useRef<HTMLDivElement>(null);
  return (
    <DetailShell tree={<div>树</div>} activeDoc="proposal" tocKey="k" bodyRef={bodyRef}>
      <DocBody ref={bodyRef}>
        <h2 data-doc-heading>为什幺</h2>
      </DocBody>
    </DetailShell>
  );
}

describe("DetailShell 三栏外框", () => {
  it("左栏文档树、中栏阅读区、右栏本页目录；右栏宽度门槛以 container query 控制", () => {
    const { container } = render(<Shell />, { wrapper });
    const shell = container.querySelector("[data-detail-shell]") as HTMLElement;
    expect(shell.className).toContain("@container");
    expect(shell.querySelector("[data-detail-tree]")!.textContent).toBe("树");
    const reading = shell.querySelector("[data-detail-reading]") as HTMLElement;
    expect(reading.querySelector("[data-doc-body]")).toBeTruthy();
    const toc = shell.querySelector("[data-detail-toc]") as HTMLElement;
    expect(toc.className).toContain("hidden");
    expect(toc.className).toContain("@min-[1200px]:flex");
    // 本页目录扫 data-doc-body 内的锚点。
    expect(within(toc).getByRole("button", { name: "为什幺" })).toBeTruthy();
  });
});

describe("DetailShell 本页目录随语系重扫", () => {
  it("详情页开着时切换语系，目录锚点文本换成新语系", () => {
    function TranslatedShell() {
      const { t } = useI18n();
      const bodyRef = useRef<HTMLDivElement>(null);
      return (
        <DetailShell tree={null} activeDoc="proposal" tocKey="k" bodyRef={bodyRef}>
          <DocBody ref={bodyRef}>
            <h2 data-doc-heading>{t("detail.tree")}</h2>
          </DocBody>
        </DetailShell>
      );
    }
    const at = (locale: "zh-CN" | "en") => (
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <TranslatedShell />
        </TooltipProvider>
      </I18nProvider>
    );
    const { container, rerender } = render(at("zh-CN"));
    const toc = () => container.querySelector("[data-detail-toc]") as HTMLElement;
    expect(within(toc()).getByRole("button", { name: "文档" })).toBeTruthy();
    rerender(at("en"));
    expect(within(toc()).getByRole("button", { name: "Documents" })).toBeTruthy();
  });
});

describe("DocTiles 数字砖", () => {
  it("空数组不渲染", () => {
    const { container } = render(<DocTiles tiles={[]} />, { wrapper });
    expect(container.innerHTML).toBe("");
  });

  it("四格时渲染四个值与标签", () => {
    const tiles = [
      { value: 3, label: "需求" },
      { value: 7, label: "情境" },
      { value: "9/9", label: "任务" },
      { value: 2, label: "决策" },
    ];
    const { container } = render(<DocTiles tiles={tiles} />, { wrapper });
    const cells = container.querySelectorAll("[data-doc-tile]");
    expect(cells).toHaveLength(4);
    expect(Array.from(cells).map((c) => c.firstElementChild!.textContent)).toEqual(["3", "7", "9/9", "2"]);
  });

  // spec「markdown 文档内容行宽有上限」的「数字砖依格数平分整列」：每格一栏、各栏等宽、填满整列（1 格也占满）。
  // jsdom 不算版面，以 class 断言栏的分配方式。
  it.each([1, 3, 4])("%i 格时数字砖列每格一栏、各栏等宽", (count) => {
    const tiles = Array.from({ length: count }, (_, i) => ({ value: i, label: `格 ${i}` }));
    const { container } = render(<DocTiles tiles={tiles} />, { wrapper });
    const cls = (container.querySelector("[data-doc-tiles]") as HTMLElement).className.split(" ");
    expect(cls).toContain("grid-flow-col");
    expect(cls).toContain("auto-cols-fr");
    expect(cls).not.toContain("grid-cols-4");
    expect(container.querySelectorAll("[data-doc-tile]")).toHaveLength(count);
  });

  // server-web-list-pages design D1：带 link 的格以该链接元素渲染、整格可点；未带的格照旧是 div。
  it("带 link 的格渲染成该 a（含值、标签与 data-doc-tile），未带的格照旧是 div", () => {
    const tiles = [
      { value: 12, label: "用户 · 停权 1", link: <a href="/x" /> },
      { value: 3, label: "项目" },
    ];
    const { container } = render(<DocTiles tiles={tiles} />, { wrapper });
    const cells = container.querySelectorAll("[data-doc-tile]");
    expect(cells).toHaveLength(2);
    const linked = cells[0] as HTMLElement;
    expect(linked.tagName).toBe("A");
    expect(linked.getAttribute("href")).toBe("/x");
    expect(linked.textContent).toContain("12");
    expect(linked.textContent).toContain("用户 · 停权 1");
    expect(linked.className).toContain("focus-visible:ring-2");
    expect(screen.getByRole("link", { name: /用户 · 停权 1/ })).toBe(linked);
    expect((cells[1] as HTMLElement).tagName).toBe("DIV");
  });

  it("link 自带的子元素与 className 不采用，格子内容与样式由组件决定", () => {
    const tiles = [{ value: 5, label: "项目", link: <a href="/y" className="bg-red-500">旧字</a> }];
    const { container } = render(<DocTiles tiles={tiles} />, { wrapper });
    const cell = container.querySelector("[data-doc-tile]") as HTMLElement;
    expect(cell.textContent).toBe("5项目");
    expect(cell.className).not.toContain("bg-red-500");
    expect(cell.className).toContain("rounded-xl");
  });
});

// spec「markdown 内容保留文档结构呈现」「markdown 文档内容行宽有上限」（design D10）：阅读卡内文 15px／1.75，
// 行宽以卡栏为上限（不再套 96ch）。index.css 的 .markdown 基准字级不在 cascade layer、会压过 Tailwind
// utilities 层的规则，所以 .markdown 的字级与行高覆盖要带 important（`!`）；jsdom 不算样式，只断言 class token。
describe("DocBody 字级与行宽", () => {
  it("内文 15px、行高 1.75，以 important 覆盖 .markdown 字级，不带 96ch 上限", () => {
    const { container } = render(<DocBody>内文</DocBody>, { wrapper });
    const cls = (container.querySelector("[data-doc-body]") as HTMLElement).className.split(" ");
    for (const token of [
      "text-[15px]",
      "leading-[1.75]",
      "[&_.markdown]:text-[15px]!",
      "[&_.markdown]:leading-[1.75]!",
      "[&_.markdown]:max-w-none",
    ]) {
      expect(cls).toContain(token);
    }
    expect(cls.join(" ")).not.toContain("max-w-[96ch]");
  });
});

describe("DetailActions 标题列插槽", () => {
  it("无 provider 时原地渲染", () => {
    render(
      <div data-testid="here">
        <DetailActions>
          <button type="button">分析</button>
        </DetailActions>
      </div>,
      { wrapper },
    );
    expect(within(screen.getByTestId("here")).getByRole("button", { name: "分析" })).toBeTruthy();
  });

  it("有 provider 时子节点出现在插槽节点内", () => {
    function Host() {
      const [slot, setSlot] = useState<HTMLDivElement | null>(null);
      return (
        <DetailActionsSlotProvider value={slot}>
          <header data-testid="bar">
            <DetailActionsSlot ref={setSlot} />
          </header>
          <main data-testid="page">
            <DetailActions>
              <button type="button">封存</button>
            </DetailActions>
          </main>
        </DetailActionsSlotProvider>
      );
    }
    render(<Host />, { wrapper });
    const slot = screen.getByTestId("bar").querySelector("[data-detail-actions]") as HTMLElement;
    expect(within(slot).getByRole("button", { name: "封存" })).toBeTruthy();
    expect(within(screen.getByTestId("page")).queryByRole("button", { name: "封存" })).toBeNull();
  });
});

describe("DetailIdentity 身分区", () => {
  it("关联列以 data-relation-<mark> 定位；出身缺席段略过、其余以「·」分隔", () => {
    const { container } = render(
      <DetailIdentity
        title="add-auth"
        copyLabel="拷贝名称"
        provenance={[<span>Momo</span>, null, <span>3 天前</span>]}
        relations={[{ mark: "from", label: "来自", children: <span>login-flow</span> }]}
      />,
      { wrapper },
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("add-auth");
    const from = container.querySelector("[data-relation-from]") as HTMLElement;
    expect(from.textContent).toBe("来自login-flow");
    const prov = container.querySelector("[data-identity-provenance]") as HTMLElement;
    expect(prov.textContent).toBe("Momo·3 天前");
  });

  it("关联列标签宽度随字长：英文单字标签不被固定宽度截断、不折行", () => {
    const { container } = render(
      <DetailIdentity
        title="add-auth"
        copyLabel="Copy name"
        relations={[{ mark: "sibling", label: "Siblings", children: <span>sib-one</span> }]}
      />,
      { wrapper },
    );
    const label = (container.querySelector("[data-relation-sibling]") as HTMLElement).firstElementChild as HTMLElement;
    expect(label.textContent).toBe("Siblings");
    expect(label.className).not.toMatch(/(^|\s)w-8(\s|$)/);
    expect(label.className).toContain("min-w-8");
    expect(label.className).toContain("whitespace-nowrap");
  });
});

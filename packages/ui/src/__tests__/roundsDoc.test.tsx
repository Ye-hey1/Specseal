// spec「讨论轮以卡片呈现」的讨论过程渲染器（desktop-discussion-doc-views design D3）。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";
import { RoundsDoc } from "../components/RoundsDoc";

const wrapper = ({ children }: { children: ReactNode }) => <I18nProvider locale="zh-CN">{children}</I18nProvider>;
const render = (ui: ReactElement) => rtlRender(ui, { wrapper });

const ROUNDS = `
<!-- \`### Round N — <mode> (<date>)\` entries are appended here by the CLI. -->

### Round 1 — assumptions (2026-07-08)

**Focus**: 现况的痛点是哪一种
**Position**: 用户裁定：只改 UI。
- 决策空间甲
- 决策空间乙
- 决策空间丙
**Ruled out**: A——理由甲；B——理由乙
**Open**: 点缀色留 teal 还是换紫；切刀

### Round 2 — interview (2026-10-12)

**Focus**: 第二轮焦点
**Position**: 直答
**Open**: 无

### Round 3 — explore (2026-10-13)

**Focus**: 第三轮焦点
**Position**: 三

### Round 4 — interview (2026-10-14)

**Focus**: 收尾
**Position**: 定案
**Ruled out**: 甲
**Open**: 无——写结论
`;

// 记录档往尾端追加第 5 轮（引擎 discuss add-round 的写法）。
const FIVE_ROUNDS = `${ROUNDS}
### Round 5 — assumptions (2026-10-15)

**Focus**: 结论后再补一轮
**Position**: 补充
`;

// spec Example「九轮的排列」：Rounds 区段依序为 Round 1 到 Round 9，Round 9 的 Focus 为「结论后补充」。
const NINE_ROUNDS = Array.from(
  { length: 9 },
  (_, i) =>
    `### Round ${i + 1} — assumptions (2026-10-0${i + 1})\n\n**Focus**: ${i === 8 ? "结论后补充" : `第 ${i + 1} 轮焦点`}\n**Position**: 定论\n`,
).join("\n");

/** 画面上由上而下的轮卡。 */
const cards = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>("[data-round]"));
/** 依轮次取卡（不以画面位置代表轮次）。 */
const card = (container: HTMLElement, round: number) =>
  container.querySelector<HTMLElement>(`[data-round="${round}"]`) as HTMLElement;
const toggle = (el: HTMLElement) => el.querySelector("button[aria-expanded]") as HTMLButtonElement;

describe("RoundsDoc", () => {
  // spec「标准记录逐轮成卡」：由新到旧，第 4 与第 1 轮（最上与最下）展开。Round 1 即 spec Example「轮标题解析」
  // 的输入：Round 1、assumptions、2026-07-08、焦点「现况的痛点是哪一种」。
  it("四轮：由上而下 data-round 依序为 4、3、2、1，aria-expanded 依序为 true、false、false、true，Round 1 卡头含 Round 1、焦点、mode、日期", () => {
    const { container } = render(<RoundsDoc text={ROUNDS} />);
    expect(container.querySelector("[data-round-timeline]")).toBeTruthy();
    const all = cards(container);
    expect(all.map((c) => c.getAttribute("data-round"))).toEqual(["4", "3", "2", "1"]);
    expect(all.map((c) => toggle(c).getAttribute("aria-expanded"))).toEqual(["true", "false", "false", "true"]);
    const first = card(container, 1);
    const head = toggle(first).textContent;
    for (const part of ["Round 1", "现况的痛点是哪一种", "assumptions", "2026-07-08"]) expect(head).toContain(part);
    expect(first.querySelector("[data-doc-heading]")!.textContent).toBe("Round 1");
    expect(first.querySelector("h3")!.textContent).toContain("现况的痛点是哪一种");
  });

  // spec「新的轮排在最上」的 Example「九轮的排列」。
  it("九轮：第一张卡为 Round 9 且焦点为「结论后补充」、最后一张为 Round 1，两者展开、其间七张收合", () => {
    const { container } = render(<RoundsDoc text={NINE_ROUNDS} />);
    const all = cards(container);
    expect(all.map((c) => c.getAttribute("data-round"))).toEqual(["9", "8", "7", "6", "5", "4", "3", "2", "1"]);
    expect(all[0].querySelector("[data-doc-heading]")!.textContent).toBe("Round 9");
    expect(all[0].querySelector("[data-round-focus]")!.textContent).toBe("结论后补充");
    expect(toggle(all[0]).getAttribute("aria-expanded")).toBe("true");
    expect(all[8].querySelector("[data-doc-heading]")!.textContent).toBe("Round 1");
    expect(toggle(all[8]).getAttribute("aria-expanded")).toBe("true");
    expect(all.slice(1, 8).map((c) => toggle(c).getAttribute("aria-expanded"))).toEqual(Array(7).fill("false"));
  });

  // 记录档只会往尾端追加轮，倒序后新轮插在画面最上；点过的展开状态跟着轮次走、不错位。
  it("新轮加入不错位：点开 Round 2 后以五轮记录重新渲染，Round 2 仍展开、Round 5 在最上且展开、Round 4 收合", () => {
    const { container, rerender } = render(<RoundsDoc text={ROUNDS} />);
    fireEvent.click(toggle(card(container, 2)));
    expect(toggle(card(container, 2)).getAttribute("aria-expanded")).toBe("true");
    rerender(<RoundsDoc text={FIVE_ROUNDS} />);
    expect(cards(container)[0].getAttribute("data-round")).toBe("5");
    expect(toggle(card(container, 5)).getAttribute("aria-expanded")).toBe("true");
    expect(toggle(card(container, 4)).getAttribute("aria-expanded")).toBe("false");
    expect(toggle(card(container, 2)).getAttribute("aria-expanded")).toBe("true");
    expect(toggle(card(container, 1)).getAttribute("aria-expanded")).toBe("true");
  });

  // 手改记录：轮次不照顺序时仍依轮次号由大到小排。
  it("记录顺序为 Round 1、3、2 时，由上而下 data-round 依序为 3、2、1", () => {
    const shuffled = [1, 3, 2].map((n) => `### Round ${n} — assumptions (2026-10-0${n})\n\n**Focus**: 第 ${n} 轮\n`).join("\n");
    const { container } = render(<RoundsDoc text={shuffled} />);
    expect(cards(container).map((c) => c.getAttribute("data-round"))).toEqual(["3", "2", "1"]);
  });

  // 手改记录出现重号：两张同号卡各自展开收合，且不出现 React 重复 key 警告。
  it("记录为 Round 1、2、2 时，两张 Round 2 卡各自切换、无重复 key 警告", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const dup = [1, 2, 2].map((n, i) => `### Round ${n} — assumptions (2026-10-0${i + 1})\n\n**Focus**: 第 ${i + 1} 段\n`).join("\n");
    const { container } = render(<RoundsDoc text={dup} />);
    const all = cards(container);
    expect(all.map((c) => c.getAttribute("data-round"))).toEqual(["2", "2", "1"]);
    expect(all.map((c) => toggle(c).getAttribute("aria-expanded"))).toEqual(["true", "false", "true"]);
    fireEvent.click(toggle(all[1]));
    fireEvent.click(toggle(all[0]));
    expect(all.map((c) => toggle(c).getAttribute("aria-expanded"))).toEqual(["false", "true", "true"]);
    expect(errors.mock.calls.flat().join(" ")).not.toContain("same key");
    errors.mockRestore();
  });

  it("立场定论句与 3 条细线列、粗体前缀原文不出现", () => {
    const { container } = render(<RoundsDoc text={ROUNDS} />);
    const first = card(container, 1);
    expect(first.querySelector("[data-position-verdict]")!.textContent).toBe("用户裁定：只改 UI。");
    expect(first.querySelectorAll('[data-round-field="position"] [data-row-list] > li').length).toBe(3);
    for (const prefix of ["Focus", "Position", "Ruled out", "**Open**"]) expect(container.textContent).not.toContain(prefix);
  });

  it("否决两列带 × 图标、待决两颗签、末轮「无——写结论」为 data-open-none", () => {
    const { container } = render(<RoundsDoc text={ROUNDS} />);
    const first = card(container, 1);
    const last = card(container, 4);
    const ruledOut = first.querySelectorAll("[data-ruled-out]");
    expect(Array.from(ruledOut).map((r) => r.textContent)).toEqual(["A——理由甲", "B——理由乙"]);
    for (const row of ruledOut) expect(row.querySelector("svg.lucide-x")).toBeTruthy();
    expect(Array.from(first.querySelectorAll("[data-open-item]")).map((o) => o.textContent)).toEqual([
      "点缀色留 teal 还是换紫",
      "切刀",
    ]);
    const none = last.querySelector("[data-open-none]")!;
    expect(none.textContent).toBe("无——写结论");
    expect(none.querySelector("svg.lucide-check")).toBeTruthy();
    expect(last.querySelector("[data-open-item]")).toBeNull();
  });

  it("点第 2 轮卡头展开、再点收合、第 1 轮不受影响", () => {
    const { container } = render(<RoundsDoc text={ROUNDS} />);
    const first = card(container, 1);
    const second = card(container, 2);
    expect(second.querySelector("[data-position-verdict]")).toBeNull();
    // 卡头可点：共用光标变量与滑过淡底（与工单轮卡头、需求收合列同款）。
    expect(toggle(second).className).toContain("cursor-(--cursor-interaction)");
    expect(toggle(second).className).toContain("hover:bg-foreground/5");
    fireEvent.click(toggle(second));
    expect(toggle(second).getAttribute("aria-expanded")).toBe("true");
    expect(second.querySelector("[data-position-verdict]")!.textContent).toBe("直答");
    fireEvent.click(toggle(second));
    expect(toggle(second).getAttribute("aria-expanded")).toBe("false");
    expect(second.querySelector("[data-position-verdict]")).toBeNull();
    expect(toggle(first).getAttribute("aria-expanded")).toBe("true");
  });

  it("焦点在收合卡头一行截断、展开后折行完整显示", () => {
    const long = "第二轮的焦点写得很长，".repeat(8).trim();
    const { container } = render(<RoundsDoc text={ROUNDS.replace("第二轮焦点", long)} />);
    const second = card(container, 2);
    const focus = () => second.querySelector("[data-round-focus]") as HTMLElement;
    expect(focus().className).toContain("truncate");
    fireEvent.click(toggle(second));
    expect(focus().className).not.toContain("truncate");
    expect(focus().className).toContain("break-words");
    expect(focus().textContent).toBe(long);
  });

  it("缺 Ruled out 时无否决字段", () => {
    const { container } = render(<RoundsDoc text={ROUNDS} />);
    const third = card(container, 3);
    fireEvent.click(toggle(third));
    expect(third.querySelector('[data-round-field="position"]')).toBeTruthy();
    expect(third.querySelector('[data-round-field="ruledOut"]')).toBeNull();
    expect(third.querySelector('[data-round-field="open"]')).toBeNull();
  });

  it("非标准轮标题整篇 Markdown、无时间轴", () => {
    const bad = ROUNDS.replace("### Round 2 — interview (2026-10-12)", "### 插入的手写标题");
    const { container } = render(<RoundsDoc text={bad} />);
    expect(container.querySelector("[data-round-timeline]")).toBeNull();
    expect(container.textContent).toContain("插入的手写标题");
  });

  it("零轮时为空态文案", () => {
    const { container } = render(<RoundsDoc text={"\n<!-- scaffold -->\n"} empty="（尚无讨论过程）" />);
    expect(container.querySelector("[data-round-timeline]")).toBeNull();
    expect(container.textContent).toBe("（尚无讨论过程）");
  });

  it("色点：assumptions 带 bg-primary、interview 带 bg-stage-discussion、其他 mode 中性", () => {
    const { container } = render(<RoundsDoc text={ROUNDS} />);
    const dot = (round: number) => card(container, round).querySelector("[data-round-dot]")!.className;
    expect(dot(1)).toContain("bg-primary");
    expect(dot(2)).toContain("bg-stage-discussion");
    expect(dot(3)).toContain("bg-muted-foreground");
    expect(dot(3)).not.toMatch(/bg-primary|bg-stage-discussion/);
  });
});

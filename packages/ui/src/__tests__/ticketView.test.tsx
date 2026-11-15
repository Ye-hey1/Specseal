import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, fireEvent, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider, MESSAGES } from "../i18n";
import { TicketView, ticketSummary } from "../components/TicketView";
import type { StationTicket, TicketRound } from "../adapter";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const HASH = `sha256:${"a".repeat(64)}`;
const SCOPE = ["src/a.rs", "src/b.rs", "src/c.rs"];

// spec desktop-app Scenario「审查工单分页出现并结构化呈现」的工单：Round 1 首轮
// 两条 WARNING、Round 2 复验一条 WARNING 结尾 (accepted) 与一条 SUGGESTION。
const TWO_ROUNDS: StationTicket = {
  rounds: [
    {
      index: 1,
      phase: "discovery",
      patchHash: HASH,
      scope: SCOPE,
      findings: [
        { severity: "WARNING", path: "src/a.rs", text: "Correctness: 未处理空清单" },
        { severity: "WARNING", path: "src/b.rs", text: "Standards: 命名不一致" },
      ],
    },
    {
      index: 2,
      phase: "validation",
      patchHash: HASH,
      scope: SCOPE,
      findings: [
        { severity: "WARNING", path: "src/b.rs", text: "Standards: 命名不一致 (accepted)" },
        { severity: "SUGGESTION", path: "src/c.rs", text: "Style: 可简化" },
      ],
    },
  ],
};

const t = (key: string) => MESSAGES["zh-CN"][key] ?? key;
/** 阅读卡标题区的推导（签槽文本与数字砖），取代旧的段标题列。 */
const summaryOf = (station: "review" | "verify", ticket: StationTicket) => {
  const summary = ticketSummary(station, ticket, t);
  const badges = text(render(<>{summary.badges}</>).container);
  return { badges, tiles: summary.tiles.map((x) => `${x.label} ${x.value}`), callout: summary.callout };
};

const round = (container: HTMLElement, index: number) =>
  container.querySelector(`[data-ticket-round="${index}"]`) as HTMLElement;
const roundToggle = (el: HTMLElement) =>
  el.querySelector("[data-ticket-round-toggle]") as HTMLButtonElement;

describe("TicketView（design D4 呈现规则）", () => {
  it("签槽为末轮轮数与阶段词，数字砖为轮数与末轮三级计数；内文不另画段标题列", () => {
    const { container } = render(<TicketView station="review" ticket={TWO_ROUNDS} />);
    expect(container.querySelector("[data-ticket-header]")).toBeNull();
    const summary = summaryOf("review", TWO_ROUNDS);
    expect(summary.badges).toBe("第 2 轮复验");
    expect(summary.tiles).toEqual(["轮 2", "CRITICAL（末轮） 0", "WARNING（末轮） 1", "SUGGESTION（末轮） 1"]);
    expect(summary.callout).toBeNull();
  });

  it("工单未加载或不存在时签、砖与提示框皆空", () => {
    expect(ticketSummary("verify", undefined, t)).toEqual({ badges: null, tiles: [], callout: null });
    expect(ticketSummary("verify", null, t)).toEqual({ badges: null, tiles: [], callout: null });
  });

  it("末轮缺省展开、旧轮收合，收合轮的标题含阶段词、范围档数与条数", () => {
    const { container } = render(<TicketView station="review" ticket={TWO_ROUNDS} />);
    const r1 = round(container, 1);
    const r2 = round(container, 2);
    expect(roundToggle(r2).getAttribute("aria-expanded")).toBe("true");
    expect(roundToggle(r1).getAttribute("aria-expanded")).toBe("false");
    expect(text(r1.querySelector("[data-ticket-round-header]"))).toContain("第 1 轮 · 首轮 · 范围 3 档 · 2 条");
    expect(text(r2.querySelector("[data-ticket-round-header]"))).toContain("第 2 轮 · 复验 · 范围 3 档 · 2 条");
    // 展开轮列出两条 finding；收合轮不列。
    expect(r2.querySelectorAll("[data-ticket-finding]")).toHaveLength(2);
    expect(r1.querySelectorAll("[data-ticket-finding]")).toHaveLength(0);
    // 点击收合轮的标题即展开。
    fireEvent.click(roundToggle(r1));
    expect(roundToggle(r1).getAttribute("aria-expanded")).toBe("true");
    expect(r1.querySelectorAll("[data-ticket-finding]")).toHaveLength(2);
  });

  it("finding 列有严重度色章、等宽路径与原文描述", () => {
    const { container } = render(<TicketView station="review" ticket={TWO_ROUNDS} />);
    const rows = round(container, 2).querySelectorAll("[data-ticket-finding]");
    expect(text(rows[1].querySelector("[data-ticket-severity]"))).toBe("SUGGESTION");
    expect(text(rows[1].querySelector("[data-ticket-path]"))).toBe("src/c.rs");
    expect(rows[1].querySelector("[data-ticket-path]")?.className).toMatch(/font-mono/);
    expect(text(rows[1].querySelector("[data-ticket-text]"))).toBe("Style: 可简化");
  });

  it("展开的轮先列 scope 路径（原样、等宽）再列 findings；收合轮不列", () => {
    const { container } = render(<TicketView station="review" ticket={TWO_ROUNDS} />);
    const r2 = round(container, 2);
    expect(round(container, 1).querySelectorAll("[data-ticket-scope-path]")).toHaveLength(0);
    // 第 2 轮的 findings 只碰 b.rs／c.rs——a.rs 只会来自 scope 清单。
    const scopeItem = within(r2).getByText("src/a.rs");
    expect(scopeItem.className).toMatch(/font-mono/);
    expect(r2.querySelectorAll("[data-ticket-scope-path]")).toHaveLength(3);
  });

  it("零 findings 的轮显示「本轮无发现」", () => {
    const empty: StationTicket = {
      rounds: [{ index: 3, phase: "validation", patchHash: HASH, scope: ["src/a.rs"], findings: [] }],
    };
    const { container } = render(<TicketView station="verify" ticket={empty} />);
    expect(text(round(container, 3))).toContain("本轮无发现");
    expect(text(round(container, 3))).not.toContain("findings");
    expect(summaryOf("verify", empty).badges).toBe("第 3 轮复验");
  });

  // 引擎不检查 `## Round N` 的 N 是否唯一：手改出同序号的工单，React key 与
  // 「末轮展开」都以数组位置决定，不撞 key、不把两轮一起展开。
  it("同序号的轮不撞 React key，只有位置上的末轮展开", () => {
    const dup: StationTicket = {
      rounds: [
        { index: 1, phase: "discovery", patchHash: HASH, scope: SCOPE, findings: [] },
        { index: 1, phase: "validation", patchHash: HASH, scope: SCOPE, findings: [] },
      ],
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { container } = render(<TicketView station="review" ticket={dup} />);
      const toggles = Array.from(
        container.querySelectorAll("[data-ticket-round-toggle]"),
      ) as HTMLButtonElement[];
      expect(toggles).toHaveLength(2);
      expect(toggles[0].getAttribute("aria-expanded")).toBe("false");
      expect(toggles[1].getAttribute("aria-expanded")).toBe("true");
      expect(errors.mock.calls.some((c) => String(c[0]).includes("same key"))).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  // spec Example「阶段词与 accepted token」：一列一案。
  const EXAMPLE: Array<{
    phase: TicketRound["phase"];
    phaseWord: string | null;
    text: string;
    shown: string;
    axis: string;
    accepted: boolean;
  }> = [
    { phase: "discovery", phaseWord: "首轮", text: "Correctness: 未处理空清单", shown: "未处理空清单", axis: "Correctness", accepted: false },
    { phase: "validation", phaseWord: "复验", text: "Standards: 命名不一致 (accepted)", shown: "命名不一致", axis: "Standards", accepted: true },
    { phase: null, phaseWord: null, text: "Standards: (accepted) 语意不清", shown: "(accepted) 语意不清", axis: "Standards", accepted: false },
  ];
  for (const row of EXAMPLE) {
    it(`phase=${String(row.phase)}：阶段词 ${row.phaseWord ?? "（不显示）"}、描述「${row.shown}」、轴向签 ${row.axis}、已接受签 ${row.accepted ? "有" : "无"}`, () => {
      const ticket: StationTicket = {
        rounds: [
          {
            index: 1,
            phase: row.phase,
            patchHash: row.phase ? HASH : null,
            scope: ["src/a.rs"],
            findings: [{ severity: "WARNING", path: "src/a.rs", text: row.text }],
          },
        ],
      };
      const { container } = render(<TicketView station="review" ticket={ticket} />);
      const roundHeader = text(round(container, 1).querySelector("[data-ticket-round-header]"));
      const badges = summaryOf("review", ticket).badges;
      if (row.phaseWord) {
        expect(badges).toBe(`第 1 轮${row.phaseWord}`);
        expect(roundHeader).toContain(`第 1 轮 · ${row.phaseWord} · 范围 1 档 · 1 条`);
      } else {
        expect(badges).toBe("第 1 轮");
        expect(roundHeader).toContain("第 1 轮 · 范围 1 档 · 1 条");
        expect(roundHeader).not.toMatch(/首轮|复验/);
      }
      const finding = round(container, 1).querySelector("[data-ticket-finding]") as HTMLElement;
      expect(text(finding.querySelector("[data-ticket-text]"))).toBe(row.shown);
      // 先切行尾 token、再取开头前缀（design D8）：accepted 与轴向签可同时出现。
      expect(text(finding.querySelector("[data-ticket-axis]"))).toBe(row.axis);
      const badge = finding.querySelector("[data-ticket-accepted]");
      if (row.accepted) {
        expect(text(badge)).toBe("已接受");
      } else {
        expect(badge).toBeNull();
      }
    });
  }
});

// spec「详情页的工单分页」的轴向签、可盖章提示框与轮卡头计数签（desktop-change-doc-views design D8）。
describe("TicketView 轴向签、可盖章提示框与轮卡头", () => {
  const single = (findings: StationTicket["rounds"][number]["findings"]): StationTicket => ({
    rounds: [{ index: 2, phase: "validation", patchHash: HASH, scope: ["src/a.rs"], findings }],
  });

  it("描述以轴向前缀开头时出轴向签并去前缀；(accepted) 在行中时原样、无已接受签", () => {
    const { container } = render(
      <TicketView
        station="review"
        ticket={single([
          { severity: "WARNING", path: "src/a.rs", text: "Correctness: 未处理空清单" },
          { severity: "WARNING", path: "src/a.rs", text: "Standards: (accepted) 语意不清" },
        ])}
      />,
    );
    const rows = container.querySelectorAll("[data-ticket-finding]");
    expect(text(rows[0].querySelector("[data-ticket-axis]"))).toBe("Correctness");
    expect(text(rows[0].querySelector("[data-ticket-text]"))).toBe("未处理空清单");
    expect(text(rows[1].querySelector("[data-ticket-axis]"))).toBe("Standards");
    expect(text(rows[1].querySelector("[data-ticket-text]"))).toBe("(accepted) 语意不清");
    expect(rows[1].querySelector("[data-ticket-accepted]")).toBeNull();
  });

  it("末轮只有一条 SUGGESTION 时 tip 提示框「可以盖章」并点名该站 stamp 指令；末轮有 WARNING 时无提示框", () => {
    const ok = summaryOf("review", single([{ severity: "SUGGESTION", path: "src/a.rs", text: "Standards: possible Duplicated Code" }]));
    const box = render(<>{ok.callout}</>).container;
    expect(text(box.querySelector(".markdown-alert-title"))).toBe("可以盖章");
    expect(text(box)).toContain("末轮只剩 1 条 SUGGESTION，不挡章。");
    expect(text(box)).toContain("specseal review stamp");
    expect(box.firstElementChild!.className).toContain("bg-status-success/10");
    const none = render(<>{summaryOf("verify", single([])).callout}</>).container;
    expect(text(none)).toContain("末轮无发现。");
    expect(text(none)).toContain("specseal verify stamp");
    expect(summaryOf("review", single([{ severity: "WARNING", path: "src/a.rs", text: "x" }])).callout).toBeNull();
  });

  it("轮卡头为 16px 粗体「第 N 轮」并附各严重度计数签（为零不出）", () => {
    const { container } = render(<TicketView station="review" ticket={TWO_ROUNDS} />);
    const r1 = round(container, 1);
    const heading = r1.querySelector("h3[data-doc-heading]") as HTMLElement;
    expect(text(heading)).toBe("第 1 轮");
    expect(heading.className).toContain("text-base");
    const counts = Array.from(r1.querySelectorAll("[data-ticket-count]")).map((c) => text(c));
    expect(counts).toEqual(["WARNING 2"]);
  });

  it("轮卡头看得出可点：共用光标变量、滑过有淡底，淡底不超出卡片圆角", () => {
    const { container } = render(<TicketView station="review" ticket={TWO_ROUNDS} />);
    const r1 = round(container, 1);
    expect(roundToggle(r1).className).toContain("cursor-(--cursor-interaction)");
    expect(roundToggle(r1).className).toContain("hover:bg-foreground/5");
    expect(r1.className).toContain("overflow-hidden");
  });
});

// spec desktop-app「详情页的工单分页」的「套用规则」列（review-ticket-applied-rules design D6）。
describe("TicketView 套用规则列", () => {
  const SMELLS = [
    "Mysterious Name",
    "Duplicated Code",
    "Feature Envy",
    "Data Clumps",
    "Primitive Obsession",
    "Repeated Switches",
    "Shotgun Surgery",
    "Divergent Change",
    "Speculative Generality",
    "Message Chains",
    "Middle Man",
    "Refused Bequest",
  ];
  type Rules = NonNullable<TicketRound["rules"]>;
  const rulesOf = (baseline: Rules["baseline"], critical: string[], warning: string[], suggestion: string[]): Rules => ({
    baseline,
    critical,
    warning,
    suggestion,
  });
  const withRules = (rules: Rules | null): StationTicket => ({
    rounds: [{ index: 1, phase: "discovery", patchHash: HASH, rules, scope: ["src/a.rs"], findings: [] }],
    reviewBaselineSmells: SMELLS,
  });
  const enWrapper = ({ children }: { children: ReactNode }) => <I18nProvider locale="en">{children}</I18nProvider>;
  const rulesRow = (container: HTMLElement) => container.querySelector("[data-ticket-rules]") as HTMLElement | null;
  const rulesToggle = (container: HTMLElement) =>
    rulesRow(container)!.querySelector("[data-ticket-rules-toggle]") as HTMLButtonElement;
  const counts = (container: HTMLElement) =>
    Array.from(rulesToggle(container).querySelectorAll("[data-ticket-rules-count]")).map((c) => text(c));
  const NOTE = "记录首轮当时的设置；之后改了审查规则，这里不会跟着变。";

  // spec Example「列头呈现」：一列一案（tw 与 en 的列头文本、条数签、底色）。
  const HEADER: Array<{ name: string; rules: Rules; tw: string; en: string; counts: string[]; amber: boolean }> = [
    { name: "extend，三清单皆空", rules: rulesOf("extend", [], [], []), tw: "缺省 12 条 code smell", en: "12 baseline code smells", counts: [], amber: false },
    {
      name: "extend，critical 2、warning 1、suggestion 0",
      rules: rulesOf("extend", ["c1", "c2"], ["w1"], []),
      tw: "缺省 12 条＋项目规则",
      en: "12 baseline smells + project rules",
      counts: ["CRITICAL 2", "WARNING 1"],
      amber: false,
    },
    {
      name: "replace，suggestion 1",
      rules: rulesOf("replace", [], [], ["s1"]),
      tw: "只用项目规则（没有套用缺省 12 条）",
      en: "Project rules only (baseline not applied)",
      counts: ["SUGGESTION 1"],
      amber: false,
    },
    {
      name: "replace，三清单皆空",
      rules: rulesOf("replace", [], [], []),
      tw: "整份换掉且没有项目规则：只依 repo 文档审查",
      en: "Baseline replaced, no project rules: judged against repo documents only",
      counts: [],
      amber: true,
    },
  ];
  for (const row of HEADER) {
    it(`列头：${row.name}`, () => {
      const { container } = render(<TicketView station="review" ticket={withRules(row.rules)} />);
      const toggle = rulesToggle(container);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(text(toggle.querySelector("[data-ticket-rules-label]"))).toBe("套用规则");
      expect(text(toggle.querySelector("[data-ticket-rules-mode]"))).toBe(row.tw);
      expect(counts(container)).toEqual(row.counts);
      expect(rulesRow(container)!.className.includes("bg-status-warning/10")).toBe(row.amber);

      const en = rtlRender(<TicketView station="review" ticket={withRules(row.rules)} />, { wrapper: enWrapper });
      expect(text(rulesToggle(en.container).querySelector("[data-ticket-rules-label]"))).toBe("Rules applied");
      expect(text(rulesToggle(en.container).querySelector("[data-ticket-rules-mode]"))).toBe(row.en);
    });
  }

  it("没有项目规则时：缺省收合，展开后列 SUGGESTION 色章、缺省清单 12 个名称与末尾注记，没有项目规则组", () => {
    const { container } = render(<TicketView station="review" ticket={withRules(rulesOf("extend", [], [], []))} />);
    expect(container.querySelector("[data-baseline-smells]")).toBeNull();
    fireEvent.click(rulesToggle(container));
    expect(rulesToggle(container).getAttribute("aria-expanded")).toBe("true");
    const body = rulesRow(container)!.querySelector("[data-ticket-rules-body]") as HTMLElement;
    const baseline = body.querySelector("[data-ticket-rules-baseline]") as HTMLElement;
    expect(text(baseline.querySelector("[data-ticket-severity]"))).toBe("SUGGESTION");
    expect(text(baseline)).toContain("缺省 12 条 code smell");
    const names = Array.from(body.querySelectorAll("[data-baseline-smells] li")).map((li) => text(li));
    expect(names).toEqual(SMELLS);
    expect(body.querySelectorAll("[data-ticket-rules-group]")).toHaveLength(0);
    expect(text(body.querySelector("[data-ticket-rules-note]"))).toBe(NOTE);
  });

  it("展开后依严重度列出项目规则原文（spec Scenario「展开后列出项目规则原文」）", () => {
    const rules = rulesOf(
      "extend",
      ["所有 SQL 一律用参数化查找，不得用字符串拼接", "不得把密钥或密码写死在代码里"],
      ["添加的公开 API 要有对应的测试"],
      [],
    );
    const { container } = render(<TicketView station="review" ticket={withRules(rules)} />);
    fireEvent.click(rulesToggle(container));
    const body = rulesRow(container)!.querySelector("[data-ticket-rules-body]") as HTMLElement;
    expect(body.querySelectorAll("[data-baseline-smells] li")).toHaveLength(12);
    const groups = Array.from(body.querySelectorAll("[data-ticket-rules-group]")) as HTMLElement[];
    expect(groups.map((g) => g.getAttribute("data-ticket-rules-group"))).toEqual(["CRITICAL", "WARNING"]);
    expect(text(groups[0].querySelector("[data-ticket-severity]"))).toBe("CRITICAL");
    expect(text(groups[0])).toContain("项目规则 2 条");
    expect(Array.from(groups[0].querySelectorAll("li")).map((li) => text(li))).toEqual(rules.critical);
    expect(text(groups[1])).toContain("项目规则 1 条");
    expect(Array.from(groups[1].querySelectorAll("li")).map((li) => text(li))).toEqual(rules.warning);
    // 末尾注记排在最后。
    expect(body.lastElementChild?.hasAttribute("data-ticket-rules-note")).toBe(true);
  });

  it("replace 展开后写「没有套用缺省 12 条 code smell」，不列名称", () => {
    const { container } = render(<TicketView station="review" ticket={withRules(rulesOf("replace", [], [], ["s1"]))} />);
    fireEvent.click(rulesToggle(container));
    const body = rulesRow(container)!.querySelector("[data-ticket-rules-body]") as HTMLElement;
    expect(text(body.querySelector("[data-ticket-rules-baseline]"))).toBe("没有套用缺省 12 条 code smell");
    expect(body.querySelector("[data-baseline-smells]")).toBeNull();
    expect(text(body.querySelector('[data-ticket-rules-group="SUGGESTION"]'))).toContain("s1");
    expect(text(body.querySelector("[data-ticket-rules-note]"))).toBe(NOTE);
  });

  it("条数取 reviewBaselineSmells 的长度，不写死 12", () => {
    const ticket = { ...withRules(rulesOf("extend", [], [], [])), reviewBaselineSmells: SMELLS.slice(0, 3) };
    const { container } = render(<TicketView station="review" ticket={ticket} />);
    expect(text(rulesToggle(container).querySelector("[data-ticket-rules-mode]"))).toBe("缺省 3 条 code smell");
  });

  it("列在范围路径之前", () => {
    const { container } = render(<TicketView station="review" ticket={withRules(rulesOf("extend", [], [], []))} />);
    const scope = container.querySelector("[data-ticket-scope-path]") as HTMLElement;
    expect(rulesRow(container)!.compareDocumentPosition(scope) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("rules 为 null、缺席或验证站工单时没有此列", () => {
    expect(rulesRow(render(<TicketView station="review" ticket={withRules(null)} />).container)).toBeNull();
    expect(rulesRow(render(<TicketView station="review" ticket={TWO_ROUNDS} />).container)).toBeNull();
    expect(rulesRow(render(<TicketView station="verify" ticket={withRules(null)} />).container)).toBeNull();
  });
});

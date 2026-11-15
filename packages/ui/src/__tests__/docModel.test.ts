// 文档解析器（desktop-change-doc-views design D1）：纯函数，形状不符时逐项降级（回 null 或标成一般列），不抛错。
import { describe, expect, it } from "vitest";

import {
  findingAxis,
  listItemsOf,
  parseCapabilities,
  parseContractRows,
  parseDecisions,
  parseGoalsNonGoals,
  parseImpact,
  parseListItems,
  proposalShape,
  removedScenarios,
  splitAlternative,
  splitH2Sections,
  splitRisk,
  splitScenarioSteps,
  splitTaskText,
} from "../docModel";

describe("splitH2Sections", () => {
  // spec「提案与设计章节以中文标签呈现」Example「章节对照与画法」的来源标题。
  it.each([
    ["Summary", "sections.summary"],
    ["Why", "sections.why"],
    ["What Changes", "sections.whatChanges"],
    ["Proposed Solution", "sections.proposedSolution"],
    ["Non-Goals", "sections.nonGoals"],
    ["Alternatives Considered", "sections.alternatives"],
    ["Capabilities", "sections.capabilities"],
    ["Impact", "sections.impact"],
    ["Context", "sections.context"],
    ["Decisions", "sections.decisions"],
    ["Implementation Contract", "sections.contract"],
    ["Risks / Trade-offs", "sections.risks"],
  ])("白名单章节 ## %s 对到 %s", (title, key) => {
    const doc = splitH2Sections(`## ${title}\n\n内文。\n`);
    expect(doc?.sections).toEqual([{ key, title, content: "内文。", subsections: [] }]);
  });

  it("(optional) 于比对前剥除", () => {
    expect(splitH2Sections("## Non-Goals (optional)\n\n- 不做\n")?.sections[0]).toMatchObject({
      key: "sections.nonGoals",
      title: "Non-Goals",
    });
  });

  it("白名单外章节以原文为标题、key 为 null；首个 h2 之前为 preamble", () => {
    const doc = splitH2Sections("# 标题\n\n开场。\n\n## Why\n\n动机。\n\n## Rollout\n\n第一段。\n\n第二段。\n");
    expect(doc?.preamble).toBe("# 标题\n\n开场。");
    expect(doc?.sections.map((s) => [s.key, s.title, s.content])).toEqual([
      ["sections.why", "Why", "动机。"],
      [null, "Rollout", "第一段。\n\n第二段。"],
    ]);
  });

  it("fenced code block 内的 `## ` 不切段", () => {
    const doc = splitH2Sections("## Why\n\n```md\n## 不是标题\n```\n\n尾段。\n");
    expect(doc?.sections).toHaveLength(1);
    expect(doc?.sections[0].content).toBe("```md\n## 不是标题\n```\n\n尾段。");
  });

  it("没有任何 h2 回 null", () => {
    expect(splitH2Sections("# 自由文档\n\n段落而已。\n")).toBeNull();
  });

  it("New／Modified Capabilities 只在 Capabilities 段内切成子段", () => {
    const md = [
      "## Capabilities",
      "",
      "### New Capabilities",
      "",
      "(none)",
      "",
      "### Modified Capabilities",
      "",
      "- `desktop-app`: 改写",
      "",
      "## Decisions",
      "",
      "### New Capabilities",
      "",
      "决策内文。",
    ].join("\n");
    const doc = splitH2Sections(md)!;
    expect(doc.sections[0].subsections).toEqual([
      { key: "sections.newCapabilities", title: "New Capabilities", content: "(none)" },
      { key: "sections.modifiedCapabilities", title: "Modified Capabilities", content: "- `desktop-app`: 改写" },
    ]);
    expect(doc.sections[1].subsections).toEqual([]);
    expect(doc.sections[1].content).toBe("### New Capabilities\n\n决策内文。");
  });
});

describe("parseListItems", () => {
  it("顶层列点与编号项依序成列，嵌套行归入该项 body，非列点段落归 prose", () => {
    const md = "开场段落。\n\n- 第一项\n  - 嵌套\n- 第二项\n\n1. 编号一\n2. 编号二\n\n收尾段落。";
    expect(parseListItems(md)).toEqual([
      { kind: "prose", text: "开场段落。" },
      {
        kind: "list",
        items: [
          { text: "第一项", body: "- 嵌套" },
          { text: "第二项", body: "" },
          { text: "编号一", body: "" },
          { text: "编号二", body: "" },
        ],
      },
      { kind: "prose", text: "收尾段落。" },
    ]);
  });

  it("listItemsOf 收齐各段的列点", () => {
    expect(listItemsOf(parseListItems("- a\n\n段落\n\n* b")).map((i) => i.text)).toEqual(["a", "b"]);
  });

  it("围栏内的 `- ` 不是列点", () => {
    expect(parseListItems("```\n- 不是列点\n```")).toEqual([{ kind: "prose", text: "```\n- 不是列点\n```" }]);
  });
});

describe("splitAlternative", () => {
  it("首个「——」切方案与落败理由", () => {
    expect(splitAlternative("保留旧画法——讨论裁定改掉——再补一句")).toEqual({
      option: "保留旧画法",
      reason: "讨论裁定改掉——再补一句",
    });
  });

  it("切不到时整条为方案、理由为 null", () => {
    expect(splitAlternative("只有方案")).toEqual({ option: "只有方案", reason: null });
  });
});

describe("parseImpact", () => {
  it("Affected specs 成能力名、Affected code 三组路径，(none) 为空", () => {
    const md = [
      "- Affected specs: `desktop-app`（7 条 MODIFIED）",
      "- Affected code:",
      "  - New: `a/b.ts`、a/c.ts",
      "  - Modified: d/e.tsx（顺手改）",
      "  - Removed: (none)",
    ].join("\n");
    expect(parseImpact(md)).toEqual({
      specs: { names: ["desktop-app"], raw: "`desktop-app`（7 条 MODIFIED）" },
      code: {
        new: [
          { path: "a/b.ts", note: null },
          { path: "a/c.ts", note: null },
        ],
        modified: [{ path: "d/e.tsx", note: "顺手改" }],
        removed: [],
      },
      notes: [],
    });
  });

  it("没有 Affected specs 列时 specs 为 null；其他列点留在 notes", () => {
    const md = "- Affected code:\n  - New: a.ts, b.ts\n  - Modified: c.ts\n  - Removed: (none)\n- 兼容性：不变";
    const impact = parseImpact(md)!;
    expect(impact.specs).toBeNull();
    expect(impact.code.new.map((p) => p.path)).toEqual(["a.ts", "b.ts"]);
    expect(impact.notes.map((n) => n.text)).toEqual(["兼容性：不变"]);
  });

  it("能力名不成形时保留原文、不切签", () => {
    const md = "- Affected specs: 无 delta（零行为变化）\n- Affected code:\n  - Modified: a.ts";
    expect(parseImpact(md)?.specs).toEqual({ names: null, raw: "无 delta（零行为变化）" });
  });

  it("「无」为空能力清单", () => {
    expect(parseImpact("- Affected specs: 无\n- Affected code:\n  - New: a.ts")?.specs).toEqual({ names: [], raw: "无" });
  });

  it("不符形状（无 Affected code 子项）回 null", () => {
    expect(parseImpact("- 影响看板与详情页\n- 无 CLI 变动")).toBeNull();
  });

  it("路径项不成形（含空白的散文）回 null", () => {
    expect(parseImpact("- Affected code:\n  - Modified: a.ts、以及 components 下所有组件")).toBeNull();
  });
});

describe("parseCapabilities", () => {
  it("「`名称`: 说明」列点成能力签，其他列点为一般列，(none) 为空", () => {
    expect(parseCapabilities("- `desktop-app`: 修改详情页\n- auth：登录\n- 纯说明列")).toEqual([
      { name: "desktop-app", text: "修改详情页" },
      { name: "auth", text: "登录" },
      { name: null, text: "纯说明列" },
    ]);
    expect(parseCapabilities("(none)")).toEqual([]);
  });
});

describe("parseGoalsNonGoals", () => {
  it("以粗体标签切两栏", () => {
    const md = "**Goals:**\n\n- 目标一\n- 目标二\n\n**Non-Goals:**\n\n- 非目标一";
    expect(parseGoalsNonGoals(md)).toEqual({ intro: "", goals: "- 目标一\n- 目标二", nonGoals: "- 非目标一" });
  });

  it("缺任一标签回 null", () => {
    expect(parseGoalsNonGoals("**Goals:**\n\n- 目标一")).toBeNull();
  });
});

describe("parseDecisions", () => {
  it("每个 h3 一张卡：D 编号、去编号标题、顶层列点数", () => {
    const md = "引言。\n\n### D1 面板底与卡片层\n\n- 一\n- 二\n  - 嵌套\n\n### 不带编号\n\n散文。";
    expect(parseDecisions(md)).toEqual({
      intro: "引言。",
      cards: [
        { id: "D1", title: "面板底与卡片层", bullets: 2, body: "- 一\n- 二\n  - 嵌套" },
        { id: null, title: "不带编号", bullets: 0, body: "散文。" },
      ],
    });
  });
});

describe("parseContractRows", () => {
  it("「- **键**：值」列点成键值列", () => {
    expect(parseContractRows("- **Behavior**：开页\n- **Failure modes**: 降级")).toEqual([
      { key: "Behavior", value: "开页" },
      { key: "Failure modes", value: "降级" },
    ]);
  });

  it("任一列不符回 null", () => {
    expect(parseContractRows("- **Behavior**：开页\n- 散文列")).toBeNull();
  });
});

describe("splitRisk", () => {
  it("首个「→」切风险与对策，风险的方括号剥除", () => {
    expect(splitRisk("[字级连动讨论侧] → spec 已纳入 → 不再动")).toEqual({
      risk: "字级连动讨论侧",
      mitigation: "spec 已纳入 → 不再动",
    });
  });

  it("切不到时整条为标题", () => {
    expect(splitRisk("只有风险")).toEqual({ risk: "只有风险", mitigation: null });
  });
});

describe("splitTaskText", () => {
  // spec「任务群组标题与章节标签同款式」Example「三层切分」。
  it.each([
    ["添加 `a.ts`（design D1）：导出 x；验证：npm test", "添加 `a.ts`", "导出 x；", "npm test", ["D1"], null],
    ["补 i18n 词条；验证：i18n 测试全绿", "补 i18n 词条；", null, "i18n 测试全绿", [], null],
    ["对齐导出", "对齐导出", null, null, [], null],
    [
      "改 TaskList（design D5；spec「任务群组标题与章节标签同款式」）：群组成卡",
      "改 TaskList",
      "群组成卡",
      null,
      ["D5"],
      "spec「任务群组标题与章节标签同款式」",
    ],
  ])("%s", (text, title, body, verify, decisions, note) => {
    expect(splitTaskText(text)).toEqual({ number: null, title, body, verify, decisions, note });
  });

  it("开头的「X.Y」序号切到 number，其余照三层切", () => {
    expect(splitTaskText("1.2 对齐导出（design D2）：内文")).toMatchObject({ number: "1.2", title: "对齐导出", decisions: ["D2"] });
    expect(splitTaskText("3 单层序号")).toMatchObject({ number: "3", title: "单层序号" });
  });

  it("半角括号与多个 D 编号", () => {
    expect(splitTaskText("改页 (design D1, D3)：接线")).toMatchObject({ title: "改页", decisions: ["D1", "D3"] });
  });
});

describe("removedScenarios", () => {
  it("取 REMOVED-SCENARIO 名单并去掉注解行与 BEFORE 行", () => {
    const block = [
      "<!-- BEFORE: 旧说明。 -->",
      "",
      "需求文。",
      "",
      "<!-- REMOVED-SCENARIO: ready workspace 的区块顺序与分割线 -->",
      "<!-- REMOVED-SCENARIO: 进度条依阶段深浅 -->",
    ].join("\n");
    expect(removedScenarios(block)).toEqual({
      names: ["ready workspace 的区块顺序与分割线", "进度条依阶段深浅"],
      content: "需求文。",
    });
  });
});

describe("splitScenarioSteps", () => {
  it("开头的 GIVEN／WHEN／THEN／AND 列点成步骤，其余为 rest", () => {
    const body = "- **GIVEN** 前提\n- **WHEN** 动作\n- **THEN** 结果\n- **AND** 补充\n\n##### Example: 表\n\n| a |\n| - |";
    expect(splitScenarioSteps(body)).toEqual({
      steps: [
        { label: "GIVEN", text: "前提" },
        { label: "WHEN", text: "动作" },
        { label: "THEN", text: "结果" },
        { label: "AND", text: "补充" },
      ],
      rest: "##### Example: 表\n\n| a |\n| - |",
    });
  });

  it("没有步骤列点回 null", () => {
    expect(splitScenarioSteps("散文而已。")).toBeNull();
  });
});

describe("findingAxis", () => {
  // spec「详情页的工单分页」Example「阶段词与 accepted token」（accepted 尾 token 已先切掉）。
  it.each([
    ["Correctness: 未处理空清单", "Correctness", "未处理空清单"],
    ["Standards: 命名不一致", "Standards", "命名不一致"],
    ["Standards: (accepted) 语意不清", "Standards", "(accepted) 语意不清"],
    ["Coherence：前后不一", "Coherence", "前后不一"],
    ["没有前缀的描述", null, "没有前缀的描述"],
  ])("%s", (input, axis, text) => {
    expect(findingAxis(input)).toEqual({ axis, text });
  });
});

describe("proposalShape", () => {
  const shape = (titles: string[]) => proposalShape(splitH2Sections(titles.map((t) => `## ${t}\n\n内文`).join("\n\n"))!);
  it.each([
    [["Problem", "Root Cause", "Proposed Solution"], "bugFix"],
    [["Summary", "Motivation", "Proposed Solution"], "refactor"],
    [["Why", "What Changes", "Impact"], "feature"],
    [["Context", "Rollout"], null],
  ])("%j → %s", (titles, expected) => {
    expect(shape(titles)).toBe(expected);
  });
});

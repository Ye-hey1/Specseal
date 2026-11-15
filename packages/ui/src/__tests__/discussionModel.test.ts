// 讨论记录解析器（desktop-discussion-doc-views design D1）：纯函数，形状不符时逐项降级（回 null、空数组或整条
// 当一般列），不抛错。案例取自 spec Example 与 detail-content-redesign 真实结论；分刀由引擎解析（见 discussionCuts.test.ts）。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  captureTargets,
  commandChips,
  contextRelations,
  countPriorDiscussions,
  matchNames,
  openItems,
  parseConclusion,
  parseContextMeta,
  roundStats,
  splitDiscussionSections,
  splitLead,
  splitOption,
  splitRounds,
  splitRows,
  splitVerdict,
} from "../discussionModel";

const DOC = `---
topic: Alpha search
slug: alpha-search
status: concluded
created: 2026-07-01
---

# Discussion: Alpha search

## Context

框架脉络内容。

## Rounds

### Round 1 — assumptions (2026-07-01)

**Focus**: 范围界定

## Conclusion

**Decision**: 建置 alpha 搜索
`;

describe("splitDiscussionSections（区段切分）", () => {
  it("切出脉络/回合/结论三区段", () => {
    const s = splitDiscussionSections(DOC);
    expect(s).not.toBeNull();
    expect(s!.context).toContain("框架脉络内容");
    expect(s!.rounds).toContain("范围界定");
    expect(s!.conclusion).toContain("建置 alpha 搜索");
  });

  it("非预期格式（缺区段）回 null → 整篇退回", () => {
    expect(splitDiscussionSections("手写的自由格式记录，没有标准区段。")).toBeNull();
    expect(splitDiscussionSections("## Context\n\n只有脉络。\n")).toBeNull();
  });

  it("轮内文含「## 」开头行时 rounds 区段完整涵盖至结构 Conclusion、内文不遗失", () => {
    // spec「区段切分不被轮内文截断」：与引擎同一结构标题白名单。
    const doc = DOC.replace("**Focus**: 范围界定", "**Focus**: 范围界定\n\n## 背景\n首轮本文");
    const s = splitDiscussionSections(doc);
    expect(s).not.toBeNull();
    expect(s!.rounds).toContain("## 背景");
    expect(s!.rounds).toContain("首轮本文");
    expect(s!.conclusion).toContain("建置 alpha 搜索");
  });

  it("围栏内的结构标题行不切断区段、不误当区段起点", () => {
    // 与引擎同规则：fenced code block 内的行不是结构。
    const doc = DOC.replace("**Focus**: 范围界定", "**Focus**: 范围界定\n\n```\n## Conclusion\n```");
    const s = splitDiscussionSections(doc);
    expect(s).not.toBeNull();
    expect(s!.rounds).toContain("```\n## Conclusion\n```");
    expect(s!.conclusion).toContain("建置 alpha 搜索");
    expect(s!.conclusion).not.toContain("```");
  });

  it("结论区段不吞其后的 pre-scaffold「## Round 」区段", () => {
    // 与引擎同规则：未跳脱的「## Round 」前缀行是区段边界（pre-scaffold 容忍）。
    const doc = `${DOC}\n## Round 2 — explore (2026-07-02)\n\n次轮本文\n`;
    const s = splitDiscussionSections(doc);
    expect(s).not.toBeNull();
    expect(s!.conclusion).toContain("建置 alpha 搜索");
    expect(s!.conclusion).not.toContain("次轮本文");
  });
});

describe("结构标题白名单跨语言对齐（引擎 ↔ UI）", () => {
  const REPO_ROOT = () => resolve(dirname(expect.getState().testPath ?? ""), "../../../..");
  const tsSource = () => readFileSync(resolve(REPO_ROOT(), "packages/ui/src/discussionModel.ts"), "utf8");
  const rustSource = () =>
    readFileSync(resolve(REPO_ROOT(), "crates/engine/specseal-core/src/lifecycle/discuss.rs"), "utf8");

  it("Rust 与 TS 的 STRUCTURAL_HEADERS 逐值一致", () => {
    // 两份白名单只靠注解互指不够——读源文件逐值比对（同 tooltipDelay.test.tsx
    // 的文件系统断言惯例；repo root 由测试档路径推出）。
    const extract = (source: string): string[] => {
      const m = /const STRUCTURAL_HEADERS[^=]*=[^[]*\[([^\]]+)\]/.exec(source);
      expect(m).not.toBeNull();
      return [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    };
    const rust = extract(rustSource());
    expect(extract(tsSource())).toEqual(rust);
    expect(rust).toEqual(["## Context", "## Rounds", "## Conclusion"]);
  });

  it("围栏、轮标题与 pre-scaffold 边界的字面规则两边同在", () => {
    // 绊线测试：三条跨语言规则（围栏定界符、轮标题前缀与 em-dash 分隔、
    // pre-scaffold 边界前缀）的字面值必须同时存在于两份源文件——
    // 任一侧改了定界符或前缀，这里就断。
    const rustSrc = rustSource();
    const tsSrc = tsSource();
    for (const literal of ["## Round ", "### Round ", "```", "~~~", " — "]) {
      expect(rustSrc, `Rust 缺 ${JSON.stringify(literal)}`).toContain(literal);
      expect(tsSrc, `TS 缺 ${JSON.stringify(literal)}`).toContain(literal);
    }
  });
});

// spec 需求「讨论轮以卡片呈现」的轮切分。
const ROUNDS_TEXT = `
<!-- \`### Round N — <mode> (<date>)\` entries are appended here by the CLI. -->

### Round 1 — assumptions (2026-07-08)

**Focus**: 第一轮焦点
**Position**: 总绾一句：
- 列点甲
- 列点乙
**Open**: 未解之一

### Round 2 — interview (2026-07-09)

**Focus**: 第二轮焦点
**Position**: 直答
**Note**: 这行不是字段
**Ruled out**: 淘汰项
**Open**: 无
`;

describe("splitRounds（轮切分，行扫描解析 scaffold）", () => {
  it("scaffold 记录解析出轮数组：轮次、mode、日期、字段对应", () => {
    const rounds = splitRounds(ROUNDS_TEXT);
    expect(rounds).not.toBeNull();
    expect(rounds!.length).toBe(2);
    expect(rounds![0].round).toBe(1);
    expect(rounds![0].mode).toBe("assumptions");
    expect(rounds![0].date).toBe("2026-07-08");
    expect(rounds![1].round).toBe(2);
    expect(rounds![1].mode).toBe("interview");
    expect(rounds![1].date).toBe("2026-07-09");
    expect(rounds![0].fields.Focus).toBe("第一轮焦点");
  });

  it("Position 标签行后的列点多行归属 Position 字段", () => {
    const rounds = splitRounds(ROUNDS_TEXT)!;
    expect(rounds[0].fields.Position).toContain("总绾一句");
    expect(rounds[0].fields.Position).toContain("- 列点甲");
    expect(rounds[0].fields.Position).toContain("- 列点乙");
    expect(rounds[0].fields.Open).toBe("未解之一");
  });

  it("来源缺 Ruled out 时字段对应无该键", () => {
    const rounds = splitRounds(ROUNDS_TEXT)!;
    expect(rounds[0].fields["Ruled out"]).toBeUndefined();
    expect(rounds[1].fields["Ruled out"]).toBe("淘汰项");
  });

  it("非四词白名单的粗体前缀行按内文归属当前字段", () => {
    const rounds = splitRounds(ROUNDS_TEXT)!;
    expect(Object.keys(rounds[1].fields)).not.toContain("Note");
    expect(rounds[1].fields.Position).toContain("**Note**: 这行不是字段");
  });

  it("围栏内的 ### 行不触发轮切分或整篇退回", () => {
    // 与引擎同规则：fenced code block 内的行归当前轮内文，不是轮标题。
    const text =
      "\n### Round 1 — assumptions (2026-07-08)\n\n**Focus**: 焦点\n\n```\n### 附注\n### Round 9 — fake (2026-01-01)\n```\n";
    const rounds = splitRounds(text);
    expect(rounds).not.toBeNull();
    expect(rounds!.length).toBe(1);
    expect(rounds![0].fields.Focus).toContain("```\n### 附注\n### Round 9 — fake (2026-01-01)\n```");
  });

  it("任一轮标题不符 scaffold 格式时回 null（整篇退回）", () => {
    expect(splitRounds("### Round 1 — assumptions\n\n**Focus**: 缺日期括号\n")).toBeNull();
    expect(
      splitRounds("### Round 1 — assumptions (2026-07-08)\n\n**Focus**: 好轮\n\n### 附注\n\n手写段落\n"),
    ).toBeNull();
    expect(splitRounds("手写的自由格式轮记录，没有轮标题。")).toBeNull();
  });

  it("零轮（仅 scaffold 注解与空行）回空数组", () => {
    expect(
      splitRounds("\n<!-- \\`### Round N — <mode> (<date>)\\` entries are appended here by the CLI. -->\n\n"),
    ).toEqual([]);
  });
});

describe("countPriorDiscussions", () => {
  it.each([
    ["Prior discussions: none", null],
    ["Prior discussions: None.", null],
    ["Prior discussions: none — 首次讨论这个主题", null],
    ["Prior discussions: NONE（尚无）", null],
    ["Prior discussions: none-legacy-topic", 1],
    ["Prior discussions: alpha-one, beta-two", 2],
    // 与背景的先前讨论签同一套切法：分号也切项、重复名只算一次、括号内的顿号不算。
    ["Prior discussions: alpha-one（甲、乙）；beta-two。", 2],
    ["Prior discussions: alpha-one, alpha-one", 1],
  ])("countPriorDiscussions(%s) → %s：none 开头的变体写法都算没有先前讨论", (line, expected) => {
    expect(countPriorDiscussions(`框架脉络。\n\n${line}`)).toBe(expected);
  });
});

// detail-content-redesign 结论的节录（形状照真实记录：一句定论、一般细节、三条带嵌套子项的分刀列）。
const DCR_CONCLUSION = [
  "**Decision**: 变更、讨论、已封存三种详情页的内容呈现改成手册式三栏阅读页，原始 Markdown 格式与模板不动，分三刀落地。",
  "- 范围与验收：只改 UI 渲染",
  "- 版面：左栏 240px 文档树",
  "- **cut 1 `desktop-detail-doc-tree`**: 骨架——三种详情页改三栏，九份文档先以现有渲染器落进新骨架",
  "  - 文档树栏（身分区、文档节点、状态区）",
  "  - 分页列退场；已封存详情页同步",
  "- **cut 2 `desktop-change-doc-views`**: 变更文档渲染器——提案、设计的新画法；依赖 cut 1",
  "  - 章节白名单与逐项降级规则落在这一刀",
  "- **cut 3 `desktop-discussion-doc-views`**: 讨论文档渲染器——结论分刀卡；最后一刀",
  "  - desktop-app 讨论轮、讨论结论、讨论详情页需求 MODIFIED",
  "**Rationale**: 手册页已经证明三栏阅读页成立。",
  "**Rejected alternatives**:",
  "- 改 Markdown 格式或模板来迁就呈现 — 用户裁定格式不动，只改 UI",
  "- 一刀落地 — 约 15 条需求",
  "**Deferred**:",
  "- 引擎在 discuss show --json 回拆好的 rounds — 等有第二个消费者再做",
  "- 手册页要不要同步加数字砖",
  "**Capture to**: proposal、design、spec（desktop-app MODIFIED）、tasks、LANGUAGE.md",
  "**Next**: /specseal-propose --from-discussion detail-content-redesign（先建 cut 1 `desktop-detail-doc-tree`；cut 3 带 --last）",
].join("\n");

describe("parseConclusion", () => {
  it("六词白名单切出六个字段；第一个标签前无内文时 lead 为空", () => {
    const c = parseConclusion(DCR_CONCLUSION);
    expect(c).not.toBeNull();
    expect(Object.keys(c!.fields)).toEqual([
      "Decision",
      "Rationale",
      "Rejected alternatives",
      "Deferred",
      "Capture to",
      "Next",
    ]);
    expect(c!.lead).toBe("");
    expect(c!.fields.Rationale).toBe("手册页已经证明三栏阅读页成立。");
  });

  it("第一个标签前的内文归 lead", () => {
    const c = parseConclusion("前言一段。\n**Decision**: 拍板");
    expect(c).toEqual({ lead: "前言一段。", fields: { Decision: "拍板" } });
  });

  it("零个白名单字段（手写自由格式）回 null", () => {
    expect(parseConclusion("就这样定了，大家都同意这个方向。")).toBeNull();
    expect(parseConclusion("**决定**：中文标签不在白名单")).toBeNull();
  });
});

describe("splitVerdict", () => {
  it("第一段散文为定论句、顶层列点依序为细节（嵌套子项留在 body）", () => {
    const v = splitVerdict(parseConclusion(DCR_CONCLUSION)!.fields.Decision!);
    expect(v.verdict).toBe(
      "变更、讨论、已封存三种详情页的内容呈现改成手册式三栏阅读页，原始 Markdown 格式与模板不动，分三刀落地。",
    );
    expect(v.details.map((d) => d.text)).toEqual([
      "范围与验收：只改 UI 渲染",
      "版面：左栏 240px 文档树",
      "**cut 1 `desktop-detail-doc-tree`**: 骨架——三种详情页改三栏，九份文档先以现有渲染器落进新骨架",
      "**cut 2 `desktop-change-doc-views`**: 变更文档渲染器——提案、设计的新画法；依赖 cut 1",
      "**cut 3 `desktop-discussion-doc-views`**: 讨论文档渲染器——结论分刀卡；最后一刀",
    ]);
    expect(v.details[2].body).toBe("- 文档树栏（身分区、文档节点、状态区）\n- 分页列退场；已封存详情页同步");
  });

  it("首段即列点时定论句为空", () => {
    const v = splitVerdict("- 甲\n- 乙");
    expect(v.verdict).toBe("");
    expect(v.details.map((d) => d.text)).toEqual(["甲", "乙"]);
  });

  it("只有一句时没有细节", () => {
    expect(splitVerdict("只有一句定论。")).toEqual({ verdict: "只有一句定论。", details: [] });
  });
});

describe("splitOption（否决与搁置的方案／理由）", () => {
  it.each<[string, string, string | null]>([
    ["改 Markdown 格式或模板来迁就呈现 — 用户裁定格式不动，只改 UI", "改 Markdown 格式或模板来迁就呈现", "用户裁定格式不动，只改 UI"],
    ["A——理由甲", "A", "理由甲"],
    ["维持顶部横幅提示 — 看板被推下去——且很远", "维持顶部横幅提示", "看板被推下去——且很远"],
    ["前者——后者 — 再后", "前者", "后者 — 再后"],
    ["desktop-ui—redesign 没有空白的破折号不切", "desktop-ui—redesign 没有空白的破折号不切", null],
    ["手册页要不要同步加数字砖", "手册页要不要同步加数字砖", null],
  ])("%s", (text, option, reason) => {
    expect(splitOption(text)).toEqual({ option, reason });
  });
});

describe("splitRows", () => {
  it("内文有列点时取顶层列点（嵌套子项跟着该列）", () => {
    expect(splitRows("- 甲\n- 乙\n  - 子")).toEqual(["甲", "乙\n- 子"]);
  });

  it("没有列点时以顶层的「；」切段，反引号与括号内的「；」不切", () => {
    expect(splitRows("A——理由甲；B——理由乙")).toEqual(["A——理由甲", "B——理由乙"]);
    expect(splitRows("`a；b`；c（d；e）;f； ")).toEqual(["`a；b`", "c（d；e）", "f"]);
  });

  it("空内文为空数组", () => {
    expect(splitRows("  ")).toEqual([]);
  });
});

describe("captureTargets", () => {
  it("顶层的顿号与逗号切项，括号内不切、反引号拿掉", () => {
    expect(captureTargets("proposal、design、spec（desktop-app、desktop-config MODIFIED）, `tasks`，LANGUAGE.md")).toEqual([
      "proposal",
      "design",
      "spec（desktop-app、desktop-config MODIFIED）",
      "tasks",
      "LANGUAGE.md",
    ]);
  });

  it("整段散文（含句号或换行）回 null", () => {
    expect(captureTargets("写进设计文档。")).toBeNull();
    expect(captureTargets("proposal\n另起一行")).toBeNull();
    expect(captureTargets("  ")).toBeNull();
  });
});

describe("openItems", () => {
  it.each(["无——写结论", "无：写入结论", "无", "None", "none.", "  无——跑 ingest  "])("%s 为收敛标记", (md) => {
    expect(openItems(md)).toEqual({ none: true, items: [md.trim()] });
  });

  it("「无法…」与 none-legacy 不算收敛标记", () => {
    expect(openItems("无法决定；切刀")).toEqual({ none: false, items: ["无法决定", "切刀"] });
    expect(openItems("none-legacy 题目")).toEqual({ none: false, items: ["none-legacy 题目"] });
  });

  it("其余逐条切开", () => {
    expect(openItems("点缀色留 teal 还是换紫；切刀")).toEqual({
      none: false,
      items: ["点缀色留 teal 还是换紫", "切刀"],
    });
  });
});

describe("roundStats", () => {
  it("mode 依首次出现序计数、天数为不同日期数、首末日", () => {
    const rounds = splitRounds(
      [
        "### Round 1 — assumptions (2026-10-08)",
        "### Round 2 — interview (2026-10-08)",
        "### Round 3 — assumptions (2026-10-09)",
        "### Round 4 — explore (2026-10-11)",
      ].join("\n\n"),
    )!;
    expect(roundStats(rounds)).toEqual({
      modes: [
        { mode: "assumptions", count: 2 },
        { mode: "interview", count: 1 },
        { mode: "explore", count: 1 },
      ],
      days: 3,
      first: "2026-10-08",
      last: "2026-10-11",
    });
  });

  it("零轮", () => {
    expect(roundStats([])).toEqual({ modes: [], days: 0, first: null, last: null });
  });
});

// spec Scenario「背景文档的引言、关联与记录列」的收尾四行。
const CONTEXT = [
  "起因段落，提到 desktop-app 与 tray-status-menu。",
  "",
  "第二段提到 add-copilot-tool 与 tray-panel-card-design。",
  "",
  "Related specs: desktop-app（79 条）、tray-status-menu",
  "Related changes: add-copilot-tool: desktop-config, tray-panel-card-design",
  "Prior discussions: card-drawer-header-colors, admin-console-redesign",
  "Source doc: none",
].join("\n");

describe("parseContextMeta", () => {
  it("四行收尾行剥离、名单去括号备注并取冒号前、Source doc none 为空字符串", () => {
    expect(parseContextMeta(CONTEXT)).toEqual({
      specs: ["desktop-app", "tray-status-menu"],
      changes: ["add-copilot-tool", "tray-panel-card-design"],
      prior: ["card-drawer-header-colors", "admin-console-redesign"],
      sourceDoc: "",
      body: "起因段落，提到 desktop-app 与 tray-status-menu。\n\n第二段提到 add-copilot-tool 与 tray-panel-card-design。",
    });
  });

  it("行缺席为 null；none 起头为空数组；Source doc 其余为原文；分号也切项、重复名去重", () => {
    const meta = parseContextMeta(
      "内文。\nPrior discussions: None.\n  Related specs: desktop-app (79 reqs); tray-status-menu、desktop-app\nSource doc: docs/brief.md \n",
    );
    expect(meta).toEqual({
      specs: ["desktop-app", "tray-status-menu"],
      changes: null,
      prior: [],
      sourceDoc: "docs/brief.md",
      body: "内文。",
    });
  });

  it("名称止于括号、句尾标点拿掉、英数段后紧接的中文不算进名称（真实记录 spec-manual-page-alignment）", () => {
    const meta = parseContextMeta(
      [
        "内文。",
        "Related specs: desktop-app（桌面 app 呈现、markdown 内容）；desktop-manual-page（手册页的侧栏树）。",
        "Related changes: desktop-change-doc-views（在途、apply 中）会改写 markdown 的两条需求；desktop-detail-doc-tree定义了三栏骨架；desktop-discussion-doc-views（cut 3，尚未建）。",
        "Prior discussions: config-context-与-rules-gui-编辑, 桌面即时刷新与封存浏览。",
      ].join("\n"),
    );
    expect(meta.specs).toEqual(["desktop-app", "desktop-manual-page"]);
    expect(meta.changes).toEqual(["desktop-change-doc-views", "desktop-detail-doc-tree", "desktop-discussion-doc-views"]);
    expect(meta.prior).toEqual(["config-context-与-rules-gui-编辑", "桌面即时刷新与封存浏览"]);
  });

  it("围栏内的同名行不剥", () => {
    const meta = parseContextMeta("```\nRelated specs: x\n```");
    expect(meta.specs).toBeNull();
    expect(meta.body).toBe("```\nRelated specs: x\n```");
  });
});

describe("contextRelations", () => {
  it("收尾行与内文命中的联集；在途与已封存只收宿主清单里有的名称；讨论排除本身", () => {
    const meta = parseContextMeta(
      [
        "提到 desktop-app、add-copilot-tool、old-change 与 self-slug、alpha-talk。",
        "Related specs: tray-status-menu",
        "Related changes: gone-change, old-change",
        "Prior discussions: beta-talk",
      ].join("\n"),
    );
    const rel = contextRelations(meta, {
      specs: ["desktop-app", "tray-status-menu"],
      active: ["add-copilot-tool"],
      archived: ["old-change"],
      discussions: ["self-slug", "alpha-talk", "beta-talk"],
      self: "self-slug",
    });
    expect(rel).toEqual({
      specs: ["tray-status-menu", "desktop-app"],
      changes: ["add-copilot-tool"],
      archived: ["old-change"],
      prior: ["beta-talk", "alpha-talk"],
      hits: {
        specs: ["desktop-app"],
        changes: ["add-copilot-tool"],
        archived: ["old-change"],
        discussions: ["alpha-talk"],
      },
    });
  });
});

describe("splitLead", () => {
  it("第一个空行之前为引言段", () => {
    expect(splitLead("第一段\n第一段续行\n\n第二段\n\n第三段")).toEqual({
      lead: "第一段\n第一段续行",
      rest: "第二段\n\n第三段",
    });
  });

  it("只有一段时 rest 为空", () => {
    expect(splitLead("\n\n只有一段\n")).toEqual({ lead: "只有一段", rest: "" });
  });

  it.each(["- 列点\n\n段", "## 标题\n\n段", "```\ncode\n```\n\n段"])("第一段不是散文（%j）时 lead 为空", (body) => {
    expect(splitLead(body)).toEqual({ lead: "", rest: body });
  });
});

describe("matchNames", () => {
  it("前后边界、依首次出现序去重", () => {
    expect(
      matchNames("内文提到 desktop-app 与 add-copilot-tool，再提 desktop-app。", ["add-copilot-tool", "desktop-app", "desktop"]),
    ).toEqual(["desktop-app", "add-copilot-tool"]);
  });

  it("前缀与反引号内、围栏内不算", () => {
    expect(matchNames("desktop-app-x 与 `desktop-app`\n```\ndesktop-app\n```", ["desktop-app"])).toEqual([]);
  });

  it("长名优先：短名在长名之内不另算", () => {
    expect(
      matchNames("见 desktop-导览与项目首页重构 的结论", ["desktop-导览", "desktop-导览与项目首页重构"]),
    ).toEqual(["desktop-导览与项目首页重构"]);
  });

  it("名单为空时零命中", () => {
    expect(matchNames("desktop-app", [])).toEqual([]);
  });
});

describe("commandChips", () => {
  it("截取 /specseal-* 指令与其旗标、参数，遇到中文或标点停", () => {
    expect(commandChips(parseConclusion(DCR_CONCLUSION)!.fields.Next!)).toEqual([
      "/specseal-propose --from-discussion detail-content-redesign",
    ]);
  });

  it("反引号内外皆算、去重保序", () => {
    expect(commandChips("跑 `/specseal-quality` 后 /specseal-archive x-y；再 /specseal-quality")).toEqual([
      "/specseal-quality",
      "/specseal-archive x-y",
    ]);
  });

  it("中文 slug 的参数完整截取；英数段后紧接的中文、句尾句点与空白后的中文不算", () => {
    expect(commandChips("/specseal-propose --from-discussion config-context-与-rules-gui-编辑")).toEqual([
      "/specseal-propose --from-discussion config-context-与-rules-gui-编辑",
    ]);
    expect(commandChips("跑 /specseal-apply 的时候；/specseal-archive x-y后再推。最后 /specseal-archive z-w.")).toEqual([
      "/specseal-apply",
      "/specseal-archive x-y",
      "/specseal-archive z-w",
    ]);
  });

  it("没有指令时为空数组", () => {
    expect(commandChips("先跑品质关卡。")).toEqual([]);
  });
});

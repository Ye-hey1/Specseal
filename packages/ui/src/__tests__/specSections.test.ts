// design D1：正式规格 spec.md 依 `### Requirement:` 切段（Purpose、body、scenarios、段尾 @trace），
// 与 SHALL／MUST 关键字的 rehype 标示插件。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { PURPOSE_TBD_PREFIX, parseSpecSections, rehypeSpecKeywords } from "../specSections";

/** 比照 archive.rs trace_block 排版的 @trace 注解。 */
function trace(source: string, updated: string): string {
  return ["<!-- @trace", `source: ${source}`, `updated: ${updated}`, "code:", "  - a.rs", "-->"].join("\n");
}

const SPEC = [
  "# demo Specification",
  "",
  "## Purpose",
  "",
  "示范用的规格。",
  "",
  "## Requirements",
  "",
  "### Requirement: 登录",
  "用户 SHALL 能登录。",
  "",
  "#### Scenario: 正确密码",
  "- **WHEN** 输入正确密码",
  "- **THEN** 进入首页",
  "",
  "##### Example: 帐密对照",
  "",
  "| 帐号 | 结果 |",
  "| --- | --- |",
  "| alice | 成功 |",
  "",
  "#### Scenario: 错误密码",
  "- **WHEN** 输入错误密码",
  "- **THEN** 显示错误",
  "",
  "",
  trace("add-login", "2026-07-05"),
  "",
  "---",
  "### Requirement: 注销",
  "用户 MUST 能注销。",
  "",
  "#### Scenario: 点注销",
  "- **WHEN** 点注销",
  "- **THEN** 回登录页",
  "",
  trace("add-logout", "2026-09-16T16:37:51+08:00"),
  "",
  "---",
  "### Requirement: 记住我",
  "系统 SHALL NOT 在未勾选时记住帐号。",
  "",
  "```",
  "## 不是标题",
  "### Requirement: 也不是需求",
  "---",
  "```",
  "",
  "#### Scenario: 未勾选",
  "- **WHEN** 未勾选记住我",
  "- **THEN** 下次需重新输入",
  "",
].join("\n");

describe("parseSpecSections", () => {
  it("切出 Purpose 与三条需求的标题", () => {
    const parsed = parseSpecSections(SPEC);
    expect(parsed).not.toBeNull();
    expect(parsed!.purpose).toBe("示范用的规格。");
    expect(parsed!.requirements.map((r) => r.title)).toEqual(["登录", "注销", "记住我"]);
  });

  it("body 为标题之后到第一个 Scenario 之前", () => {
    const [login] = parseSpecSections(SPEC)!.requirements;
    expect(login.body).toBe("用户 SHALL 能登录。");
  });

  it("每个 Scenario 一段，Example 归属所在 Scenario", () => {
    const [login] = parseSpecSections(SPEC)!.requirements;
    expect(login.scenarios.map((s) => s.title)).toEqual(["正确密码", "错误密码"]);
    expect(login.scenarios[0].body).toContain("##### Example: 帐密对照");
    expect(login.scenarios[0].body).toContain("| alice | 成功 |");
    expect(login.scenarios[1].body).not.toContain("Example");
  });

  it("段尾 @trace 解析 source 与 updated 日期部分并自内文移除", () => {
    const [login, logout] = parseSpecSections(SPEC)!.requirements;
    expect(login.trace).toEqual({ source: "add-login", updated: "2026-07-05" });
    expect(logout.trace).toEqual({ source: "add-logout", updated: "2026-09-16" });
    const all = [login, logout].flatMap((r) => [r.body, ...r.scenarios.map((s) => s.body)]).join("\n");
    expect(all).not.toContain("@trace");
    expect(all).not.toContain("add-login");
  });

  it("单行的 @trace 注解自内文移除、不吞掉其后内容", () => {
    const parsed = parseSpecSections("### Requirement: A\n内文。\n<!-- @trace -->\n\n#### Scenario: S\n- x\n");
    expect(parsed!.requirements[0].body).toBe("内文。");
    expect(parsed!.requirements[0].scenarios).toEqual([{ title: "S", body: "- x" }]);
  });

  it("无 @trace 的需求 trace 为 null", () => {
    const remember = parseSpecSections(SPEC)!.requirements[2];
    expect(remember.trace).toBeNull();
  });

  it("--- 分隔线不出现在 body 与 scenario，代码区块内的照留", () => {
    const { requirements } = parseSpecSections(SPEC)!;
    const [login, logout, remember] = requirements;
    expect(login.scenarios[1].body).not.toMatch(/^---$/m);
    expect(logout.scenarios[0].body).not.toMatch(/^---$/m);
    // 围栏内的 `## `、`### Requirement:`、`---` 都不是结构。
    expect(remember.body).toContain("## 不是标题");
    expect(remember.body).toContain("### Requirement: 也不是需求");
    expect(remember.body).toMatch(/^---$/m);
    expect(remember.scenarios.map((s) => s.title)).toEqual(["未勾选"]);
  });

  it("没有任何需求标题回 null", () => {
    expect(parseSpecSections("# x\n\n## Purpose\n\n只有目的。\n")).toBeNull();
    expect(parseSpecSections("")).toBeNull();
  });

  it("Purpose 缺席为空字符串", () => {
    const parsed = parseSpecSections("### Requirement: A\n内文。\n");
    expect(parsed!.purpose).toBe("");
    expect(parsed!.requirements[0].body).toBe("内文。");
  });

  it("嵌套围栏：收尾围栏须同字符且不短于开头，内层围栏里的需求标题不切段", () => {
    const md = [
      "### Requirement: A",
      "````markdown",
      "```",
      "### Requirement: 外层围栏内",
      "```",
      "````",
      "~~~",
      "```",
      "### Requirement: 波浪围栏内",
      "~~~",
      "### Requirement: B",
      "B 内文。",
    ].join("\n");
    const { requirements } = parseSpecSections(md)!;
    expect(requirements.map((r) => r.title)).toEqual(["A", "B"]);
    expect(requirements[0].body).toContain("### Requirement: 外层围栏内");
    expect(requirements[0].body).toContain("### Requirement: 波浪围栏内");
  });

  it("`## Requirements` 下的引言与需求段之外的 `## ` 区段不丢：分别收进 intro 与 appendix", () => {
    const md = [
      "# x Specification",
      "",
      "## Purpose",
      "",
      "目的。",
      "",
      "## Requirements",
      "",
      "这些需求适用于所有平台。",
      "",
      "### Requirement: A",
      "",
      "A 内文。",
      "",
      "## 附录",
      "",
      "补充说明。",
    ].join("\n");
    const parsed = parseSpecSections(md)!;
    expect(parsed.purpose).toBe("目的。");
    expect(parsed.intro).toBe("这些需求适用于所有平台。");
    expect(parsed.requirements[0].body).toBe("A 内文。");
    expect(parsed.appendix).toBe("## 附录\n\n补充说明。");
  });

  it("只有 Purpose 与需求的规格：intro 与 appendix 皆为空字符串", () => {
    const parsed = parseSpecSections(SPEC)!;
    expect(parsed.intro).toBe("");
    expect(parsed.appendix).toBe("");
  });
});

/** 最小 hast 节点（测试直接构树，不经 unified）。 */
interface Node {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
}

const text = (value: string): Node => ({ type: "text", value });
const el = (tagName: string, children: Node[]): Node => ({ type: "element", tagName, properties: {}, children });

/** 把子节点摊成「文本」与「[kw:…]」串行，方便比对。 */
function flat(node: Node): string[] {
  return (node.children ?? []).map((c) =>
    c.type === "text"
      ? c.value!
      : `[${c.tagName}.${(c.properties?.className as string[]).join(".")}:${c.children?.[0]?.value}]`,
  );
}

describe("rehypeSpecKeywords", () => {
  it("整词包住 SHALL NOT／SHALL／MUST NOT／MUST", () => {
    const p = el("p", [text("系统 SHALL NOT 当机、SHALL 记录，且 MUST 回报、MUST NOT 吞错。")]);
    rehypeSpecKeywords()(el("root", [p]));
    expect(flat(p)).toEqual([
      "系统 ",
      "[code.spec-kw:SHALL NOT]",
      " 当机、",
      "[code.spec-kw:SHALL]",
      " 记录，且 ",
      "[code.spec-kw:MUST]",
      " 回报、",
      "[code.spec-kw:MUST NOT]",
      " 吞错。",
    ]);
  });

  it("不包非整词（SHALLOW、MUSTER）", () => {
    const p = el("p", [text("SHALLOW MUSTER")]);
    rehypeSpecKeywords()(el("root", [p]));
    expect(flat(p)).toEqual(["SHALLOW MUSTER"]);
  });

  it("行内 code 与代码区块内不处理", () => {
    const inline = el("code", [text("SHALL")]);
    const block = el("pre", [el("code", [text("MUST")])]);
    const p = el("p", [text("见 "), inline]);
    rehypeSpecKeywords()(el("root", [p, block]));
    expect(inline.children).toEqual([text("SHALL")]);
    expect(block.children![0].children).toEqual([text("MUST")]);
  });
});

describe("Purpose 占位前缀跨语言对齐（引擎 ↔ UI）", () => {
  it("PURPOSE_TBD_PREFIX 与 lifecycle/model.rs 的同名常数逐字一致", () => {
    // 规格详情页的「Purpose 待补」提示框与引擎的 purposeTbd 同一前缀——读源文件逐字比对
    //（同 discussionDetailPage.test.tsx 的 STRUCTURAL_HEADERS 对齐题；repo root 由测试档路径推出）。
    const REPO_ROOT = resolve(dirname(expect.getState().testPath ?? ""), "../../../..");
    const source = readFileSync(resolve(REPO_ROOT, "crates/engine/specseal-core/src/lifecycle/model.rs"), "utf8");
    const m = /pub const PURPOSE_TBD_PREFIX: &str = "([^"]*)";/.exec(source);
    expect(m).not.toBeNull();
    expect(PURPOSE_TBD_PREFIX).toBe(m![1]);
  });
});

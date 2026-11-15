// 子代理模型的草稿与保存（desktop-subagent-model-page design「子代理模型的草稿与保存」）：
// 由现值建草稿、来源判定、存回合并、相同判定、下拉选项组成——页面与 hook 共用的纯函数。
import { describe, expect, it } from "vitest";

import type { SubagentModelConfig } from "../adapter/workspace";
import {
  SUBAGENT_CUSTOM,
  SUBAGENT_INHERIT,
  cellChoice,
  choiceOptions,
  fromDraft,
  modelSource,
  sameSubagentModel,
  toDraft,
} from "../views/project-settings/subagentModel";

const BUILTIN = { claude: ["sonnet", "opus", "haiku", "fable"] };
const EMPTY: SubagentModelConfig = { review: {}, verify: {}, choices: {} };
const LABELS = { inherit: "沿用主对话", builtin: "内置", choices: "自订清单", custom: "自行输入…" };

const CURRENT: SubagentModelConfig = {
  review: { claude: "opus", codex: "gpt-6.1-sol", copilot: "gpt-5.6" },
  verify: { claude: "sonnet" },
  choices: { codex: ["gpt-6.1-sol", "gpt-6-astra"] },
};

describe("toDraft", () => {
  it("没值 inherit、在内置或自订清单 pick、其他 custom；清单一行一个", () => {
    const draft = toDraft(CURRENT, BUILTIN);
    expect(draft.cells.review.claude).toEqual({ mode: "pick", value: "opus" });
    expect(draft.cells.review.codex).toEqual({ mode: "pick", value: "gpt-6.1-sol" });
    expect(draft.cells.review.copilot).toEqual({ mode: "custom", value: "gpt-5.6" });
    expect(draft.cells.review.pi).toEqual({ mode: "inherit" });
    expect(draft.cells.verify.claude).toEqual({ mode: "pick", value: "sonnet" });
    expect(draft.cells.verify.codex).toEqual({ mode: "inherit" });
    expect(draft.lists).toEqual({ claude: "", codex: "gpt-6.1-sol\ngpt-6-astra", copilot: "", pi: "", cursor: "" });
  });
});

describe("modelSource", () => {
  it("优先序：内置 > 自订清单 > 自行输入", () => {
    expect(modelSource("opus", BUILTIN.claude, ["opus"])).toBe("builtin");
    expect(modelSource("gpt-6.1-sol", [], ["gpt-6.1-sol"])).toBe("choices");
    expect(modelSource("gpt-5.6", [], ["gpt-6.1-sol"])).toBe("custom");
  });
});

describe("cellChoice", () => {
  it("下拉的值：inherit 与 custom 各为哨兵、pick 为名称", () => {
    const options = choiceOptions(BUILTIN.claude, [], LABELS);
    expect(cellChoice({ mode: "inherit" }, options)).toBe(SUBAGENT_INHERIT);
    expect(cellChoice({ mode: "pick", value: "opus" }, options)).toBe("opus");
    expect(cellChoice({ mode: "custom", value: "opus" }, options)).toBe(SUBAGENT_CUSTOM);
  });

  it("编辑中从清单删掉已选用的名称：改判自行输入", () => {
    const options = choiceOptions([], ["gpt-6-astra"], LABELS);
    expect(cellChoice({ mode: "pick", value: "gpt-6.1-sol" }, options)).toBe(SUBAGENT_CUSTOM);
  });
});

describe("fromDraft", () => {
  it("没改任何东西：存回结果与现值相同", () => {
    const saved = fromDraft(toDraft(CURRENT, BUILTIN), CURRENT);
    expect(saved).toEqual(CURRENT);
    expect(sameSubagentModel(saved, CURRENT)).toBe(true);
  });

  it("inherit 与留空的 custom 移除该格；custom 去头尾空白；pick 写名称", () => {
    const draft = toDraft(CURRENT, BUILTIN);
    draft.cells.verify.claude = { mode: "inherit" };
    draft.cells.review.copilot = { mode: "custom", value: "   " };
    draft.cells.verify.copilot = { mode: "custom", value: " gpt-5.6 " };
    draft.cells.verify.codex = { mode: "pick", value: "gpt-6-astra" };
    expect(fromDraft(draft, CURRENT)).toEqual({
      review: { claude: "opus", codex: "gpt-6.1-sol" },
      verify: { copilot: "gpt-5.6", codex: "gpt-6-astra" },
      choices: { codex: ["gpt-6.1-sol", "gpt-6-astra"] },
    });
  });

  it("清单一行一条、去空白、略过空行；清空的清单移除键", () => {
    const draft = toDraft(CURRENT, BUILTIN);
    draft.lists.claude = "  claude-x \n\n   \nclaude-y";
    draft.lists.codex = "  \n";
    expect(fromDraft(draft, CURRENT).choices).toEqual({ claude: ["claude-x", "claude-y"] });
  });

  it("没改过的清单沿用现值（不重新拆行）", () => {
    const current: SubagentModelConfig = { ...EMPTY, choices: { codex: ["a\nb"] } };
    expect(fromDraft(toDraft(current, BUILTIN), current).choices).toEqual({ codex: ["a\nb"] });
  });

  it("只覆写内置工具的格子与清单：未显示的工具名称原样带回", () => {
    const current: SubagentModelConfig = {
      review: { "my-agent": "model-a" },
      verify: { "my-agent": "model-b" },
      choices: { "my-agent": ["model-a"] },
    };
    const draft = toDraft(current, BUILTIN);
    draft.cells.review.claude = { mode: "pick", value: "opus" };
    expect(fromDraft(draft, current)).toEqual({
      review: { "my-agent": "model-a", claude: "opus" },
      verify: { "my-agent": "model-b" },
      choices: { "my-agent": ["model-a"] },
    });
  });
});

describe("sameSubagentModel", () => {
  it("内容相同（键序不同）为真；任一格或清单不同为假", () => {
    const reordered: SubagentModelConfig = {
      review: { copilot: "gpt-5.6", codex: "gpt-6.1-sol", claude: "opus" },
      verify: { claude: "sonnet" },
      choices: { codex: ["gpt-6.1-sol", "gpt-6-astra"] },
    };
    expect(sameSubagentModel(reordered, CURRENT)).toBe(true);
    expect(sameSubagentModel({ ...CURRENT, verify: {} }, CURRENT)).toBe(false);
    expect(sameSubagentModel({ ...CURRENT, choices: { codex: ["gpt-6-astra", "gpt-6.1-sol"] } }, CURRENT)).toBe(false);
  });
});

describe("choiceOptions", () => {
  // spec Example「各工具的下拉选项」——逐列对应。
  const flat = (options: ReturnType<typeof choiceOptions>) =>
    options.map((entry) =>
      "options" in entry ? `${entry.label}：${entry.options.map((o) => o.label).join("、")}` : entry.label,
    );

  it.each([
    ["claude", BUILTIN.claude, [], ["沿用主对话", "内置：sonnet、opus、haiku、fable", "自行输入…"]],
    ["codex", [], ["gpt-6.1-sol", "gpt-6-astra"], ["沿用主对话", "自订清单：gpt-6.1-sol、gpt-6-astra", "自行输入…"]],
    ["copilot", [], [], ["沿用主对话", "自行输入…"]],
    ["claude", BUILTIN.claude, ["opus", "claude-x"], ["沿用主对话", "内置：sonnet、opus、haiku、fable", "自订清单：claude-x", "自行输入…"]],
  ])("%s：内置 %j、自订 %j", (_tool, builtin, custom, expected) => {
    expect(flat(choiceOptions(builtin, custom, LABELS))).toEqual(expected);
  });

  it("头尾两项的值为哨兵；组内选项的值为名称；重复名称与撞到哨兵的名称不进选项", () => {
    const options = choiceOptions([], ["x", "x", SUBAGENT_CUSTOM], LABELS);
    expect(options[0]).toEqual({ value: SUBAGENT_INHERIT, label: "沿用主对话" });
    expect(options[1]).toEqual({ label: "自订清单", options: [{ value: "x", label: "x" }] });
    expect(options[2]).toEqual({ value: SUBAGENT_CUSTOM, label: "自行输入…" });
  });
});

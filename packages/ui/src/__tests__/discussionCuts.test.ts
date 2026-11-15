// 刀卡的组成（discussion-cuts-from-engine design「前端以列点原文把刀对回细节列」）：刀由引擎解析，前端只以
// `line` 把刀对回决定的细节列，并只读引擎字段判定转出。
import { describe, expect, it } from "vitest";

import { cutCards, cutPromotion, splitVerdict, type CutCard } from "../discussionModel";
import { engineCut } from "./engineCuts";

const DECISION = [
  "定论。",
  "- 一般细节",
  "- **cut 1 `a-one`**: 骨架——说明",
  "  续行散文一句。",
  "  - 子项",
  "- **cut 2 `b-two`**: 外壳",
].join("\n");

const CUT_1 = engineCut("**cut 1 `a-one`**: 骨架——说明", {
  cut: "cut 1",
  title: "骨架",
  note: "说明",
  changes: ["a-one"],
  changesInBold: true,
});
const CUT_2 = engineCut("**cut 2 `b-two`**: 外壳", {
  cut: "cut 2",
  title: "外壳",
  changes: ["b-two"],
  changesInBold: true,
  unpromoted: ["b-two"],
});

describe("cutCards（以列点原文把刀对回细节列）", () => {
  it("依 cuts 顺序认领 text 等于 line 的细节列，认领到的列自 rest 移除", () => {
    const { cuts, rest } = cutCards(splitVerdict(DECISION).details, [CUT_2, CUT_1]);
    expect(cuts.map((c) => c.id)).toEqual(["cut 2", "cut 1"]);
    expect(rest.map((r) => r.text)).toEqual(["一般细节"]);
    expect(cuts[1]).toEqual<CutCard>({
      id: "cut 1",
      title: "骨架",
      names: ["a-one"],
      namesInBold: true,
      unpromoted: [],
      items: ["说明", "续行散文一句。", "子项"],
    });
  });

  it("items 为 note 接嵌套子项与续行散文的细线列；note 为空时只有嵌套内容", () => {
    const { cuts } = cutCards(splitVerdict(DECISION).details, [CUT_1, CUT_2]);
    expect(cuts[0].items).toEqual(["说明", "续行散文一句。", "子项"]);
    expect(cuts[1].items).toEqual([]);
  });

  it("同一首行出现两次时各认领一列", () => {
    const md = ["定论。", "- **cut 1 `a`**: 同名", "  - 第一列的子项", "- **cut 1 `a`**: 同名", "  - 第二列的子项"].join("\n");
    const twin = engineCut("**cut 1 `a`**: 同名", { cut: "cut 1", title: "同名", changes: ["a"], changesInBold: true });
    const { cuts, rest } = cutCards(splitVerdict(md).details, [twin, twin]);
    expect(cuts.map((c) => c.items)).toEqual([["第一列的子项"], ["第二列的子项"]]);
    expect(rest).toEqual([]);
  });

  it("找不到对应列的刀仍成卡，items 只有 note；细节列不动", () => {
    const lost = engineCut("**cut 9 `z`**: 不在这里 <!-- 注解 -->", { cut: "cut 9", title: "不在这里", note: "说明" });
    const { cuts, rest } = cutCards(splitVerdict(DECISION).details, [lost]);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].items).toEqual(["说明"]);
    expect(rest).toHaveLength(3);
  });

  it("cuts 为空时没有刀卡，细节列全部留在 rest", () => {
    const details = splitVerdict(DECISION).details;
    expect(cutCards(details, [])).toEqual({ cuts: [], rest: details });
  });

  it("以 `*` 起头的刀列不是引擎的刀，留在 rest", () => {
    const { cuts, rest } = cutCards(splitVerdict("定论。\n* **cut 3 `add-x`**: 范围").details, []);
    expect(cuts).toEqual([]);
    expect(rest.map((r) => r.text)).toEqual(["**cut 3 `add-x`**: 范围"]);
  });
});

// desktop-app「刀的转出判定」Example 逐列一案：只读引擎的 changes、changesInBold、unpromoted。
describe("cutPromotion（刀的转出判定）", () => {
  const card = (names: string[], namesInBold: boolean, unpromoted: string[]): CutCard => ({
    id: "cut 1",
    title: "骨架",
    names,
    namesInBold,
    unpromoted,
    items: [],
  });

  it.each<[string, CutCard, string]>([
    ["a、b 皆在 promoted_to", card(["a", "b"], true, []), "promoted"],
    ["a、b 只有 a 在 promoted_to", card(["a", "b"], true, ["b"]), "partial"],
    ["a 不在 promoted_to", card(["a"], true, ["a"]), "none"],
    ["没有变更名签", card([], false, []), "unknown"],
    ["粗体内没有、粗体之后有 KeyLines、util.rs", card(["KeyLines", "util.rs"], false, []), "unknown"],
  ])("%s → %s", (_row, cut, verdict) => {
    expect(cutPromotion(cut)).toBe(verdict);
  });
});

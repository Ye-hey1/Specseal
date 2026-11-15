// D1／D2：前端解析正式规格 spec.md 内 @trace 区块的 source，聚合至 spec 层级去重保序。
// @trace 格式比照 archive.rs 的 trace_block（source/updated/code）。
import { describe, it, expect } from "vitest";

import { parseTraceSources } from "../trace";

/** 依 archive.rs trace_block 格式组一个 @trace HTML 注解区块（source 为 null＝畸形、略去该行）。 */
function traceBlock(source: string | null, code: string[] = ["a.rs"]): string {
  const lines = ["<!-- @trace"];
  if (source !== null) lines.push(`source: ${source}`);
  lines.push("updated: 2026-07-09");
  lines.push("code:");
  for (const f of code) lines.push(`  - ${f}`);
  lines.push("-->");
  return lines.join("\n");
}

/** 组多 requirement 的 spec.md：每块需求后接一个 @trace（比照正典排版）。 */
function specWith(sources: (string | null)[]): string {
  return sources
    .map((s, i) => `### Requirement: R${i}\n\n某段内文。\n\n${traceBlock(s)}`)
    .join("\n\n");
}

describe("parseTraceSources（@trace source 解析）", () => {
  it("单一 @trace 回传其 source", () => {
    expect(parseTraceSources(specWith(["alpha-change"]))).toEqual(["alpha-change"]);
  });

  // spec Example 表：source 出现序去重且依首次出现保序。
  it.each([
    { seq: ["A", "A", "B"], expected: ["A", "B"] },
    { seq: ["B", "A", "B"], expected: ["B", "A"] },
  ])("去重保序：$seq → $expected", ({ seq, expected }) => {
    expect(parseTraceSources(specWith(seq))).toEqual(expected);
  });

  it("无 @trace 的纯 markdown 回空数组", () => {
    expect(parseTraceSources("# 标题\n\n没有任何 trace 注解。")).toEqual([]);
  });

  it("畸形区块（缺 source）静默略过，只回有效 source", () => {
    // 中间一块缺 source 行 → 该块不计；前后有效块照收。
    expect(parseTraceSources(specWith(["A", null, "B"]))).toEqual(["A", "B"]);
  });

  it("null／undefined／空字符串回空数组", () => {
    expect(parseTraceSources(null)).toEqual([]);
    expect(parseTraceSources(undefined)).toEqual([]);
    expect(parseTraceSources("")).toEqual([]);
  });
});

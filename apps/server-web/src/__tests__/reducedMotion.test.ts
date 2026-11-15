// @vitest-environment node
// 纯文件系统断言：以 node 环境运行，import.meta.url 才是 file:// URL。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// spec 需求「共用设计系统维持高密度可访问体验」的 Scenario「reduced motion 停用转场」：
// 操作系统设置 `prefers-reduced-motion: reduce` 时 SPA 不运行任何转场动画。
//
// 这条只能在样式层钉住：动画散在 Tailwind 的 transition-colors／animate-* utility 里，
// 逐处加 `motion-reduce:` 一定会漏（而且漏掉时完全没有信号）。改以一条全域守门，
// 并用这支测试确保它不会在某次 CSS 整理中被顺手删掉。
const css = () => readFileSync(fileURLToPath(new URL("../index.css", import.meta.url)), "utf8");

describe("reduced motion", () => {
  it("index.css 带 prefers-reduced-motion 的全域守门", () => {
    const source = css();
    expect(source).toContain("@media (prefers-reduced-motion: reduce)");
    // 转场与动画都要压掉：Sheet 用 animation，按钮与导览项用 transition。
    expect(source).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(source).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    // 守门要涵盖全部元素，逐处挂 motion-reduce: 一定会漏。
    expect(source).toMatch(/\*\s*,\s*\*::before\s*,\s*\*::after/);
  });
});

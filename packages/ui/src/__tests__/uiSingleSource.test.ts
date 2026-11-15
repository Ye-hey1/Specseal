// @vitest-environment node
// 纯文件系统断言：以 node 环境运行，import.meta.url 才是 file:// URL。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { scanSources } from "./sourceScan";

// 共用组件唯一来源（spec desktop-app「共用组件唯一来源」Scenario「同名本地定义被守门挡下」；
// design D9）：@specseal/ui 导出的名称，桌面 app 与 server web 不得在原代码顶层再定义一份——
// 散落的同名组件正是「换皮时每一份都要再改一次」的来源。
const SCAN_ROOTS = ["apps/desktop/src", "apps/server-web/src"];

/** index.ts 导出的值识别字（`export { A, B as C } from`、`export function A`、`export const A`；略过 type）。 */
function exportedNames(): Set<string> {
  const index = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
  const names = new Set<string>();
  for (const block of index.matchAll(/export\s*\{([^}]*)\}\s*from/g)) {
    for (const raw of block[1].split(",")) {
      const entry = raw.replace(/\/\/[^\n]*/g, "").trim();
      if (!entry || entry.startsWith("type ")) continue;
      names.add(entry.split(/\s+as\s+/).pop()!.trim());
    }
  }
  for (const m of index.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  return names;
}

/** 顶层（行首、不缩进）的函数或常数定义名。 */
const TOP_LEVEL_DEFINITION =
  /^(?:export\s+)?(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[<(]|const\s+([A-Za-z_$][\w$]*)\s*[:=])/gm;

describe("共用组件唯一来源守门", () => {
  it("收得到 @specseal/ui 的导出名（守门本身不空转）", () => {
    const names = exportedNames();
    for (const name of ["CopyButton", "EmptyState", "SectionHeader", "ConfirmDialog", "Wordmark"]) {
      expect(names.has(name), name).toBe(true);
    }
    expect(names.has("ConfirmDialogProps")).toBe(false);
  });

  it("桌面 app 与 server web 顶层不定义与 @specseal/ui 导出同名的函数或常数", () => {
    const names = exportedNames();
    const violations: string[] = [];
    for (const [file, source] of scanSources(SCAN_ROOTS, [".ts", ".tsx"])) {
      for (const m of source.matchAll(TOP_LEVEL_DEFINITION)) {
        const name = m[1] ?? m[2];
        if (names.has(name)) violations.push(`${file}: ${name}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

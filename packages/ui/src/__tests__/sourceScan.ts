// 守门测试共用的原代码扫描（theme.test.ts 原生色阶守门、uiSingleSource.test.ts 同名定义守门）。
// 以 import.meta.url 定位 repo 根：调用端须以 node 环境运行（jsdom 会把它换成 http location）。
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** repo 根目录（结尾带 /）。 */
export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const SKIPPED_DIRS = new Set(["__tests__", "dist", "node_modules"]);

/** 扫描根（相对 repo 根）下扩展名符合的原代码，回传 [repo 相对路径, 内容]；略过测试、建置产物与相依。 */
export function scanSources(roots: readonly string[], extensions: readonly string[]): [string, string][] {
  const files: string[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (extensions.some((ext) => entry.name.endsWith(ext))) files.push(child);
    }
  };
  for (const root of roots) walk(`${REPO_ROOT}${root}`);
  return files.map((f) => [f.slice(REPO_ROOT.length), readFileSync(f, "utf8")]);
}

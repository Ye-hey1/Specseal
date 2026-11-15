// @vitest-environment node
// 纯文件系统断言：以 node 环境运行，import.meta.url 才是 file:// URL。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import { REPO_ROOT, scanSources } from "./sourceScan";

// 可点元素的光标（spec desktop-app「可点元素的光标与 hover 回馈」；design D1／D2／D6）：
// 光标只在共用样式的 --cursor-interaction 一处决定（缺省手指、桌面覆写为箭头），
// 组件写死手指或禁止光标就会让桌面与网页各自漂移，因此一律挡下。
const SCAN_ROOTS = ["packages/ui/src/components", "apps/desktop/src", "apps/server-web/src"];

/** 写死的手指或禁止光标：整字 class（含 disabled:、peer-disabled: 等变体前缀）、任意值 cursor-[…]、
 * 任意属性 [cursor:…] 与行内 style。第三方套件（Streamdown 控制钮）的 class 扫不到，由 Markdown 容器的
 * 任意变体盖回共用设置（markdownCode.test.tsx 钉住）。 */
const HARDCODED_CURSOR =
  /(?<![\w-])cursor-(?:pointer|not-allowed)(?![\w-])|cursor-\[(?:pointer|not-allowed)\]|\[cursor:(?:pointer|not-allowed)\]|\bcursor\s*:\s*["'`](?:pointer|not-allowed)["'`]/;

const readCss = (path: string) => readFileSync(`${REPO_ROOT}${path}`, "utf8");

describe("可点元素光标守门", () => {
  it("比对式抓得到各种写死光标的写法，不误判共用设置（守门本身不空转）", () => {
    for (const hit of [
      'className="cursor-pointer"',
      "disabled:cursor-not-allowed",
      "peer-disabled:cursor-not-allowed",
      "cursor-[pointer]",
      "[cursor:not-allowed]",
      'style={{ cursor: "pointer" }}',
    ]) {
      expect(HARDCODED_CURSOR.test(hit), hit).toBe(true);
    }
    for (const miss of [
      "cursor-(--cursor-interaction)",
      "[&_.name-chip]:cursor-(--cursor-interaction)",
      "disabled:cursor-default",
      "pointer-events-none",
    ]) {
      expect(HARDCODED_CURSOR.test(miss), miss).toBe(false);
    }
  });

  it("组件原代码不写死手指或禁止光标", () => {
    const violations = scanSources(SCAN_ROOTS, [".ts", ".tsx"])
      .filter(([, source]) => HARDCODED_CURSOR.test(source))
      .map(([file]) => file);
    expect(violations, "改用 cursor-(--cursor-interaction)；停用态用 cursor-default").toEqual([]);
  });

  it("共用样式声明光标变量的默认值为手指", () => {
    const css = readCss("packages/ui/src/theme.css");
    expect(css.includes("--cursor-interaction: pointer"), "theme.css 缺 --cursor-interaction: pointer").toBe(true);
  });

  it("共用样式以 base layer 全域规则让可用按钮与 role=button 取用光标变量", () => {
    const base = [...readCss("packages/ui/src/theme.css").matchAll(/@layer base\s*\{([\s\S]*?)\n\}/g)]
      .map((m) => m[1])
      .find((block) => block.includes("cursor: var(--cursor-interaction)"));
    expect(base !== undefined, "theme.css 缺 @layer base 的 cursor: var(--cursor-interaction) 全域规则").toBe(true);
    expect(base!.includes("button:not(:disabled)"), "全域规则选择器缺 button:not(:disabled)").toBe(true);
    expect(base!.includes('[role="button"]'), '全域规则选择器缺 [role="button"]').toBe(true);
  });

  it("桌面根样式把光标变量覆写为箭头，且排在 theme.css 导入之后", () => {
    const css = readCss("apps/desktop/src/index.css");
    const override = css.indexOf("--cursor-interaction: default");
    expect(override >= 0, "apps/desktop/src/index.css 缺 --cursor-interaction: default").toBe(true);
    // 两段 :root 都不在 layer 内、权重相同，靠先后取胜：覆写必须在导入之后。
    expect(override > css.indexOf('/theme.css";'), "--cursor-interaction: default 必须排在 theme.css 导入之后").toBe(
      true,
    );
  });

  it("网页后台根样式不覆写光标变量", () => {
    const css = readCss("apps/server-web/src/index.css");
    expect(css.includes("--cursor-interaction"), "apps/server-web/src/index.css 不得覆写 --cursor-interaction").toBe(false);
  });
});

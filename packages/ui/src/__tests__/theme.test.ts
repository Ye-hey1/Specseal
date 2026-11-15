// @vitest-environment node
// 纯文件系统断言：以 node 环境运行，import.meta.url 才是 file:// URL
// （jsdom 环境会把它换成 http location，导致 fileURLToPath 失败）。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { scanSources } from "./sourceScan";

// 共用 semantic theme（D1/D7）：青绿 token 从 apps/desktop/src/index.css 抽到
// packages/ui/src/theme.css，Desktop 与 Server Web 各自 import 同一份，证明
// 「抽取只改所有权、不改值」——Desktop 可观察 token 不得漂移。
const themeCss = () =>
  readFileSync(fileURLToPath(new URL("../theme.css", import.meta.url)), "utf8");
const desktopCss = () =>
  readFileSync(
    fileURLToPath(new URL("../../../../apps/desktop/src/index.css", import.meta.url)),
    "utf8",
  );

// canonical token 值（desktop-design-foundation D1／D3）：色值只在 theme.css，
// 逐一钉死，任何值漂移即回归失败。原生色阶值逐字取自 tailwindcss/theme.css。
const LIGHT_TOKENS = [
  "--background: oklch(1 0 0);",
  "--foreground: oklch(0.145 0 0);",
  "--card: oklch(1 0 0);",
  "--card-foreground: oklch(0.145 0 0);",
  "--primary: oklch(0.52 0.085 190);",
  "--primary-foreground: oklch(0.985 0 0);",
  "--secondary: oklch(0.97 0 0);",
  "--secondary-foreground: oklch(0.205 0 0);",
  "--muted: oklch(0.97 0 0);",
  "--muted-foreground: oklch(0.556 0 0);",
  "--accent: oklch(0.94 0.035 192);",
  "--accent-foreground: oklch(0.205 0 0);",
  "--destructive: oklch(0.577 0.245 27.325);",
  "--border: oklch(0.922 0 0);",
  "--input: oklch(0.922 0 0);",
  "--ring: oklch(0.62 0.1 192);",
  "--sidebar: oklch(0.985 0 0);",
  "--status-progress: oklch(58.8% 0.158 241.966);",
  "--status-success: oklch(59.6% 0.145 163.225);",
  "--status-warning: oklch(66.6% 0.179 58.318);",
  "--stamp: oklch(54.1% 0.281 293.009);",
  "--improve: oklch(51.1% 0.262 276.966);",
  "--stage-discussion: oklch(59.1% 0.293 322.896);",
  "--stage-proposed: var(--primary);",
  "--stage-in-progress: var(--status-progress);",
  "--stage-ready: var(--status-success);",
];

const DARK_TOKENS = [
  "--background: oklch(0.145 0 0);",
  "--card: oklch(0.205 0 0);",
  "--secondary: oklch(0.269 0 0);",
  "--muted: oklch(0.269 0 0);",
  "--primary: oklch(0.72 0.1 190);",
  "--primary-foreground: oklch(0.16 0.02 210);",
  "--accent: oklch(0.3 0.045 192);",
  "--destructive: oklch(0.62 0.2 25);",
  "--border: oklch(1 0 0 / 12%);",
  "--input: oklch(1 0 0 / 15%);",
  "--ring: oklch(0.64 0.1 192);",
  "--sidebar: oklch(0.185 0 0);",
  "--status-progress: oklch(74.6% 0.16 232.661);",
  "--status-success: oklch(76.5% 0.177 163.223);",
  "--status-warning: oklch(76.9% 0.188 70.08);",
  "--stamp: oklch(70.2% 0.183 293.541);",
  "--improve: oklch(67.3% 0.182 276.935);",
  "--stage-discussion: oklch(74% 0.238 322.16);",
];

/** 添加 token 都要映射成 Tailwind utility（bg-status-progress、text-stamp…）。 */
const NEW_TOKENS = [
  "sidebar",
  "status-progress",
  "status-success",
  "status-warning",
  "stamp",
  "improve",
  "stage-discussion",
  "stage-proposed",
  "stage-in-progress",
  "stage-ready",
];

const THEME_MAP = [
  "--color-primary: var(--primary);",
  "--color-background: var(--background);",
  "--color-ring: var(--ring);",
  ...NEW_TOKENS.map((name) => `--color-${name}: var(--${name});`),
];

// 组件只能用这份 theme 真的映射出来的语意色。用了没定义的 token（例如上游 shadcn 的
// `bg-popover`——这个 theme 没有 `--popover`）Tailwind 会产出一条解析不到值的声明，
// 组件静默变透明：不会有编译错误、不会有测试红灯，只有肉眼看得到。
const componentSources = () => {
  const dir = fileURLToPath(new URL("..", import.meta.url));
  const files: string[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === "__tests__") continue;
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".tsx")) files.push(child);
    }
  };
  walk(dir);
  return files.map((f) => [f, stripComments(readFileSync(f, "utf8"))] as const);
};

/** Tailwind 内置色名（逐字取自 tailwindcss/theme.css 的 --color-*-500）。 */
const PALETTE_NAMES =
  "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|mauve|olive|mist|taupe";
/** Tailwind 内置色阶（bg-amber-500 之类）不经 theme，排除。 */
const PALETTE = new RegExp(`^(?:${PALETTE_NAMES})-\\d{2,3}$`);
const BUILTIN = new Set(["black", "white", "transparent", "current", "inherit"]);

// 原生色阶守门（spec desktop-app「原生色阶守门无白名单」场景）：色值只在 theme.css，
// 集中常数档只保存「状态→token class」对照，组件只写 token class——三个扫描根的
// 任何原代码都不得出现原生色阶字面，没有白名单。漂移多半发生在 app 侧，只扫
// packages/ui 挡不住。
/** 扫描根（相对 repo root）。 */
const SCAN_ROOTS = ["packages/ui/src", "apps/desktop/src", "apps/server-web/src"];

/**
 * 原生色阶字面：任意 utility 前缀（text-、fill-、border-t-、shadow-…）＋全部色名＋
 * Tailwind 色阶数字。前缀不枚举——枚举的前缀清单本身就是白名单的缺口。
 */
const PALETTE_SCALE = new RegExp(`\\b[a-z][a-z-]*-(?:${PALETTE_NAMES})-(?:50|[1-9]00|950)\\b`, "g");

// 注解里提到某个 class 名称（例如解释为什么不用它）不该被当成用到了它。
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** 扫描范围内的 .ts／.tsx／.css 原代码（去注解）。 */
const scannedSources = () =>
  scanSources(SCAN_ROOTS, [".ts", ".tsx", ".css"]).map(([file, source]) => [file, stripComments(source)] as const);

describe("共用 semantic theme 抽取", () => {
  it("组件用到的 bg-* 语意色都在 theme.css 有对应 token", () => {
    const mapped = new Set([...themeCss().matchAll(/--color-([a-z0-9-]+):/g)].map((m) => m[1]));
    const unmapped: string[] = [];
    for (const [file, source] of componentSources()) {
      for (const match of source.matchAll(/\bbg-([a-z][a-z0-9-]*)/g)) {
        const name = match[1];
        if (mapped.has(name) || BUILTIN.has(name) || PALETTE.test(name)) continue;
        unmapped.push(`${file.split("/src/")[1]}: bg-${name}`);
      }
    }
    expect(unmapped).toEqual([]);
  });
});

describe("原生色阶守门", () => {
  it("比对式涵盖 Tailwind 全部色名与任意 utility 前缀，不误中 token class", () => {
    const hits = (source: string) => [...source.matchAll(PALETTE_SCALE)].map((m) => m[0]);
    const caught = [
      "text-blue-600",
      "bg-cyan-50",
      "border-lime-950",
      "ring-pink-400",
      "fill-sky-500",
      "stroke-amber-600",
      "outline-rose-300",
      "shadow-cyan-500/50",
      "divide-slate-200",
      "via-violet-400",
      "border-t-amber-500",
      "hover:bg-emerald-100",
      "decoration-mauve-700",
      "accent-olive-600",
      "caret-mist-500",
      "placeholder-taupe-400",
    ];
    for (const cls of caught) expect(hits(cls), cls).toEqual([cls.replace(/^hover:/, "").replace(/\/\d+$/, "")]);
    for (const cls of ["text-status-progress", "bg-stage-ready", "border-t-stage-discussion", "text-primary-foreground"]) {
      expect(hits(cls), cls).toEqual([]);
    }
  });

  it("三个扫描根的原代码都不含原生色阶字面（无白名单）", () => {
    const violations: string[] = [];
    for (const [file, source] of scannedSources()) {
      for (const match of source.matchAll(PALETTE_SCALE)) {
        violations.push(`${file}: ${match[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

// spec desktop-app「截断省略号的统一字形」（design D6）：省略号长什么样由该处字体
// 决定——等宽把手画半角贴基线、中文文本画全角置中，同一画面两种收尾。以限定
// U+2026 的字体层统一，其余字符照原字体解析（不换任何一段文本的字体）。
describe("截断省略号的统一字形", () => {
  const ELLIPSIS_FALLBACKS = ["Helvetica Neue", "Arial", "Segoe UI", "DejaVu Sans"];
  /** 既有 body 堆栈——省略号层插在最前，其后必须原封不动。 */
  const EXISTING_STACK =
    '"Noto Sans TC Variable", "Noto Sans TC", "Segoe UI", system-ui, -apple-system, sans-serif';

  it("theme.css 声明只接管 U+2026 的拉丁字体层", () => {
    const face = themeCss().match(/@font-face\s*\{[^}]*EllipsisLatin[^}]*\}/)?.[0];
    expect(face).toBeTruthy();
    // 限定单一码位：没有 unicode-range 这层会接管整段文本，把中文换成拉丁字体。
    expect(face).toContain("unicode-range: U+2026;");
    // 三平台各有一个常驻拉丁字体；全数落空时整层无效、退回既有字体（不花屏）。
    for (const font of ELLIPSIS_FALLBACKS) {
      expect(face).toContain(`local("${font}")`);
    }
  });

  it("body 字体堆栈以省略号层为首，其后既有顺序不变", () => {
    const family = themeCss().match(/body\s*\{[^}]*font-family:\s*([^;]+);/)?.[1]?.trim();
    expect(family).toBeTruthy();
    expect(family!.startsWith('"EllipsisLatin"')).toBe(true);
    expect(family).toContain(EXISTING_STACK);
  });
});

describe("共用 semantic theme 抽取（既有）", () => {
  it("packages/ui/src/theme.css 保留全部 canonical light token 值", () => {
    const css = themeCss();
    for (const token of LIGHT_TOKENS) {
      expect(css).toContain(token);
    }
  });

  it("theme.css 保留 dark 模式 token 与系统偏好查找", () => {
    const css = themeCss();
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    for (const token of DARK_TOKENS) {
      expect(css).toContain(token);
    }
    // 深色基底纯中性（D3）：不再带色相 260 的蓝调。
    expect(css).not.toContain("0.008 260");
  });

  // 外观偏好（desktop-settings-mode design D4）：深色 token 由系统偏好与明示深色两种触发共用，
  // 两份声明必须逐行相同——漂移即红。
  const darkBlockDeclarations = (css: string, selector: RegExp) => {
    const match = selector.exec(css);
    expect(match, String(selector)).not.toBeNull();
    const bodyStart = match!.index + match![0].length;
    return css
      .slice(bodyStart, css.indexOf("}", bodyStart))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("--"));
  };

  it("系统偏好区块排除明示浅色、另有明示深色区块", () => {
    const css = themeCss();
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{/);
    expect(css).toMatch(/:root\[data-theme="dark"\]\s*\{/);
  });

  it("两个深色区块的声明逐行相同", () => {
    const css = themeCss();
    const media = darkBlockDeclarations(css, /:root:not\(\[data-theme="light"\]\)\s*\{/);
    const explicit = darkBlockDeclarations(css, /:root\[data-theme="dark"\]\s*\{/);
    expect(media.length).toBeGreaterThan(0);
    expect(explicit).toEqual(media);
    for (const token of DARK_TOKENS) expect(media).toContain(token);
  });

  it("dark: 变体与深色 token 同一套触发（系统深色且未明示浅色、或明示深色）", () => {
    const variant = themeCss().match(/@custom-variant dark \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(variant).toContain("@media (prefers-color-scheme: dark)");
    expect(variant).toContain(':root:not([data-theme="light"]) *');
    expect(variant).toContain(':root[data-theme="dark"] *');
  });

  it("theme.css 保留 @theme inline 对 Tailwind utility 的映射", () => {
    const css = themeCss();
    expect(css).toContain("@theme inline");
    for (const mapping of THEME_MAP) {
      expect(css).toContain(mapping);
    }
    // 圆角改用 Tailwind 缺省四阶（D2）：不再自订 --radius 与其衍生覆写。
    expect(css).not.toMatch(/--radius/);
  });

  it("theme.css 让 Tailwind 扫描 Streamdown 的 class（D10，两个 app 经 @import 共用）", () => {
    expect(themeCss()).toContain('@source "../../../node_modules/streamdown/dist/*.js";');
  });

  it("theme.css 保留 Noto Sans TC body 字体堆栈", () => {
    const css = themeCss();
    expect(css).toContain('"Noto Sans TC Variable"');
    expect(css).toContain("font-family:");
  });

  it("Desktop index.css 的 markdown 覆写只留字级行高、code chip、del 与任务清单（D10）", () => {
    const css = desktopCss();
    // 排版交给 Streamdown：typography 插件与 prose 变量对照整段移除。
    expect(css).not.toContain("@tailwindcss/typography");
    expect(css).not.toContain("--tw-prose-");
    const base = css.match(/\.markdown\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(base).toContain("font-size: 1rem;");
    expect(base).toContain("line-height: 1.7;");
    // Streamdown 自带表格容器与代码框，这几条不再需要。
    expect(css).not.toMatch(/\.markdown table\s*\{/);
    expect(css).not.toMatch(/\.markdown th\s*\{/);
    expect(css).not.toMatch(/\.markdown pre\s*\{/);
    expect(css).not.toContain("code::before");
    expect(css).toMatch(/\.markdown code:not\(pre code\)\s*\{/);
    expect(css).toMatch(/\.markdown del\s*\{/);
    expect(css).toContain('.markdown li:has(> input[type="checkbox"])');
  });

  it("Desktop index.css 改为 import 共用 theme，不再自行内嵌 token（单一真相源）", () => {
    const css = desktopCss();
    // 引用共用 theme.css（相对 workspace 路径，与既有 @source 惯例一致）。
    expect(css).toMatch(/@import\s+["'][^"']*packages\/ui\/src\/theme\.css["']/);
    // 不得再就地声明青绿主色 token——否则两处各自维护会漂移。
    expect(css).not.toContain("--primary: oklch(0.52 0.085 190);");
  });
});

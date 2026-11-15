#!/usr/bin/env node
// 拷贝 Herdr 的 main 版面成 specseal 版面，在最右边加一栏常驻的 Specseal 面板。
// 也拷贝 spaces、agents 接上阶段徽章和 Specseal 信息，因为内置的没有扩充点；拷贝 files、changes 让文件名称和差异内容不会被 i18n.js 翻掉；拷贝 tabs 让卷动不会切换页签。
// 内置版面不能停靠，拷贝版又不会跟着 Herdr 更新，所以 Herdr 更新后要重跑这支。
// 旧的版面会留在 layouts/specseal.json.old-<时间>，和 Herdr 的 layout.reset 同样做法；
// 旧的 mod 拷贝版直接删掉，那些文件夹没有用户的数据。
//
// 用法：node scripts/herdr/dock-panel.mjs（Herdr 要开着）
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'specseal';
// 宽度和 main 内置的 Files／Changes 那一栏相同。
const PANEL = {
  id: 'specseal',
  type: 'block',
  size: { px: 368 },
  min: 280,
  max: 900,
  // 标头可以拖动窗口，和分页列一样；面板内容与按钮会挡下按压。
  window_drag: true,
  content: { mod: 'specseal' },
};

// 不画东西的浮动区块，负责让那一栏每个 space 各自记住开关（见 column-sync.js）。
const COLUMN_SYNC = { id: 'specseal-column-sync', content: { mod: 'specseal', props: { view: 'column-sync' } } };

// 接上徽章要改的地方。Herdr 改了这几行就停下来，不要装出半套。
const SPACES_EDITS = [
  ['import { View, div, svg } from "gpui-kit";', 'import { View, div, svg } from "gpui-kit";\nimport { InputState as LangInput } from "gpui-base";\nimport { tr, watchLang } from "./i18n.js";\nimport { rowEnd, watchStages } from "./stage-badge.js";'],
  ['export default class Spaces extends View {\n  init(_props, cx) {', 'export default class Spaces extends View {\n  init(_props, cx) {\n    watchLang(exec, cx, { div, InputState: LangInput });\n    watchStages(this, cx);'],
  [
    '.child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1())',
    '.child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1())\n          .children(rowEnd(g, tree, t))',
  ],
  // 跟随系统语系。内置的文本是英文，对应的中文在 i18n.js。
  ['.child(collapsed ? "…" : "Loading…")', '.child(collapsed ? "…" : tr("Loading…"))'],
  ['.child(m ?? "This computer")', '.child(m ?? tr("This computer"))'],
  ['repair?.error || "rebuilt ·"', 'repair?.error || tr("rebuilt ·")'],
  ['.tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")', '.tooltip(repair?.error || tr("This machine was rebuilt or replaced. Click to connect to the new one."))'],
  ['.child(repair?.busy ? "Connecting…" : "Connect")', '.child(tr(repair?.busy ? "Connecting…" : "Connect"))'],
  ['.child("New space there")', '.child(tr("New space there"))'],
  ['el.child("Spaces")', 'el.child(tr("Spaces"))'],
  // 徽章会占掉宽度。git 的箭头搬到 rowEnd，和徽章一起固定在右边；放不下时让 space 名字变短，才不会叠在一起。
  [
    '.child(div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).child(w.name))',
    '.child(div().max_w(150).truncate().text_color(t.foreground).child(w.name))',
  ],
  [
    '.child(where)))\n      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\\u2191${g.ahead}`)))\n      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\\u2193${g.behind}`)));',
    '.child(where)));',
  ],
];

// Agents 清单要改的地方。规则同上。
const AGENTS_EDITS = [
  [
    'closeOverlay, props, window, layout } from "herdr";',
    'closeOverlay, props, window, layout, exec } from "herdr";\nimport { tr, watchLang } from "./i18n.js";\nimport { groupedOrder, statusCounts, statusSections } from "./model.js";\nimport { changeOf, planMark, watchPlans } from "./specseal-rows.js";',
  ],
  // 缺省依 space 分组。时钟菜单还能切回 Priority。
  ['shared("agents.sort")) ?? SORTS[0];', 'shared("agents.sort")) ?? SORTS[1];'],
  ['if (props()?.sortMenu) return;\n    this.folded = new Set();', 'watchLang(exec, cx);\n    if (props()?.sortMenu) return;\n    this.folded = new Set();\n    watchPlans(cx);'],
  // 有自己分页的 agent 本来就有一列，不再接在开它的 agent 底下。
  ['k.parent === addr && k.state === "live");', 'k.parent === addr && k.state === "live" && !this.listed.has(k.address));'],
  [
    'this.since(y) - this.since(x) || y.seq - x.seq);\n    const pinned',
    'this.since(y) - this.since(x) || y.seq - x.seq);\n    else list = groupedOrder(list, spaces(), rankOf, (a) => this.since(a));\n    const pinned',
  ],
  // 没取过名的分页，列上写在做的变更。
  [
    'const label = (a) => labels.get(a.address);',
    'const named = new Set(spaces().flatMap((s) => s.tabs).filter((tab) => tab.named).map((tab) => tab.id));\n    const label = (a) => (named.has(a.tab) ? null : changeOf(a)?.name) ?? labels.get(a.address);',
  ],
  // Needs you 那一组没有 space 标题，所以列上要写 space。
  ['const full = byPriority || isPinned;', 'const full = byPriority || isPinned || rankOf(a) === RANK.blocked;'],
  ['.child(this.status(t, a, byPriority && !isPinned));', '.child(this.status(t, a, full && !isPinned));'],
  ['.child(`\\u00b7 ${more}`))))', '.child(`\\u00b7 ${more}`)))\n          .children(planMark(a, t)))'],
  // 侧栏窄，有进度的列不放时间，名字才看得出是哪个变更。
  ['.when(this.hovered !== a.address && Boolean(when), el =>', '.when(this.hovered !== a.address && Boolean(when) && !changeOf(a), el =>'],
  [
    'const id = byPriority ? `sec-${r}` : `sp-${a.space}`;',
    'const section = byPriority || r === RANK.blocked;\n      const id = section ? `sec-${r}` : `sp-${a.space}`;',
  ],
  [
    'label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null,',
    'label: section ? tr(SECTION[r]) : a.space_name || "", status: section ? SECTION_STATUS[r] : null,',
  ],
  // space 的标题要比里面的状态小标题明显。收起时右边写各状态的数量，其他组照内置写总数。
  ['.child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))', '.child(div().truncate().text_color(t[g.status] ?? (g.id.startsWith("sp-") ? t.foreground : t.dim)).child(g.label))'],
  ['      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);\n      return h_flex()\n        .id(g.id)', '      return h_flex()\n        .id(g.id)'],
  ['.when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))', '.when(!g.id.startsWith("sp-"), (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))'],
  [
    '.when(!open, (el) => el\n          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))\n          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));',
    '.when(g.id.startsWith("sp-") && !open, (el) => el.children(statusCounts(g.members).map(([status, n]) =>\n          h_flex().gap(3).items_center().text_color(t.dim).child(this.status(t, { status }, true)).child(String(n)))))\n        .when(!open, (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));',
  ],
  // space 那一组里再依状态分段。
  [
    'const rows = collapsed\n      ? list.flatMap(withKids)\n      : groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : g.members.flatMap(withKids))]);',
    `const body = (g) => !g.id.startsWith("sp-") ? g.members.flatMap(withKids) : statusSections(g.members, rankOf).flatMap((s) => [
      h_flex().id(\`\${g.id}-\${s.rank}\`).pl(16).h(22).flex_none().items_center().text_size(10.5).font_medium().text_color(t[SECTION_STATUS[s.rank]] ?? t.dim).child(tr(SECTION[s.rank])),
      ...s.members.flatMap(withKids),
    ]);
    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : body(g))]);`,
  ],
  // 跟随系统语系。
  ['.child("Sort agents")', '.child(tr("Sort agents"))'],
  ['.child(div().flex_1().child(s.label))', '.child(div().flex_1().child(tr(s.label)))'],
  ['.tooltip(isPinned ? "Unpin" : "Pin to the top")', '.tooltip(tr(isPinned ? "Unpin" : "Pin to the top"))'],
  ['.child("Needs you")', '.child(tr("Needs you"))'],
  ['label: "Pinned"', 'label: tr("Pinned")'],
  ['.child("Agents")', '.child(tr("Agents"))'],
  // 排序菜单要开拷贝版才会翻译。
  ['openOverlay({ mod: "agents", kind: "popup"', 'openOverlay({ mod: "specseal-agents", kind: "popup"'],
  ['.tooltip(`Sort agents: ${sort.label}`)', '.tooltip(tr("Sort agents: {0}", tr(sort.label)))'],
  ['.child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")', '.child(tr("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not."))'],
];

// i18n.js 会翻画面上所有符合对照表的字符串，但文件夹可能刚好叫 Settings，差异的某一行也可能刚好是 Commit。
// 后缀加上看不见的 U+2060，对照表就查不到。
const FILES_EDITS = [['.truncate().child(entry.name))', '.truncate().child(`${entry.name}\u2060`))']];
const CHANGES_EDITS = [
  ['.max_w(260).min_w(0).truncate().child(name)))', '.max_w(260).min_w(0).truncate().child(`${name}\u2060`)))'],
  ['.child(div().flex_1().min_w(0).truncate().child(text));', '.child(div().flex_1().min_w(0).truncate().child(`${text}\u2060`));'],
];

// 内置的页签列一卷动就切换页签，触摸板滑一次会连切好几个，画面一直闪。拿掉后卷动只移动页签列。
const TABS_EDITS = [['      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })\n', '']];

const integration = (file) => fileURLToPath(new URL(`../../integrations/herdr/${file}`, import.meta.url));
// 版面里的区块换成哪个拷贝版。files 是拷贝版里的文件名对应 repo 里的文件。
const I18N = { 'i18n.js': 'mods/specseal/i18n.js' };
const UNPROTECTED = '名称刚好和接口文本相同时会被翻。';
const CLONES = [
  {
    mod: 'spaces',
    blocks: ['spaces'],
    as: 'specseal-spaces',
    edits: SPACES_EDITS,
    files: { ...I18N, 'stage-badge.js': 'spaces-badge/stage-badge.js' },
  },
  {
    mod: 'agents',
    blocks: ['agents'],
    as: 'specseal-agents',
    edits: AGENTS_EDITS,
    files: { ...I18N, 'specseal-rows.js': 'agents-list/specseal-rows.js', 'model.js': 'mods/specseal/model.js', 'shared.js': 'mods/specseal/shared.js' },
  },
  // 这几个 Herdr 改了就用内置的，不挡停靠。optional 写的是改用内置后会怎样。
  { mod: 'files', blocks: ['files'], as: 'specseal-files', edits: FILES_EDITS, files: {}, optional: UNPROTECTED },
  { mod: 'changes', blocks: ['changes'], as: 'specseal-changes', edits: CHANGES_EDITS, files: {}, optional: UNPROTECTED },
  { mod: 'tabs', blocks: ['tabs'], as: 'specseal-tabs', edits: TABS_EDITS, files: {}, optional: '卷动页签列时会切换页签。' },
];

const home = process.env.HERDR_APP_HOME ?? path.join(homedir(), '.config/herdr-app');
const file = path.join(home, 'layouts', `${NAME}.json`);
const herdr = (command, args) => execFileSync('herdr-app', ['do', command, JSON.stringify(args)], { stdio: 'pipe' });

// 先改好再动任何东西：找不到要改的行时，现在的版面还完好。
for (const clone of CLONES) {
  clone.source = readFileSync(path.join(home, 'mods', clone.mod, 'main.js'), 'utf8');
  for (const [from, to] of clone.edits) {
    if (clone.source.split(from).length !== 2) {
      if (!clone.optional) throw new Error(`Herdr 的 ${clone.mod} mod 改了，找不到这一行，这支脚本要跟着改：${from}`);
      console.warn(`Herdr 的 ${clone.mod} mod 改了，改用内置的。${clone.optional}找不到：${from}`);
      clone.skip = true;
      break;
    }
    clone.source = clone.source.replace(from, () => to);
  }
}
const clones = CLONES.filter((clone) => !clone.skip);

// 版面里指定 id 的区块。
function findBlock(node, id) {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findBlock(child, id);
    if (found) return found;
  }
  return null;
}

if (existsSync(file)) {
  // 先切回 main，才不会把显示中的版面抽走。
  herdr('layout.switch', { name: 'main' });
  renameSync(file, `${file}.old-${Date.now()}`);
}

for (const clone of clones) {
  const dir = path.join(home, 'mods', clone.as);
  rmSync(dir, { recursive: true, force: true });
  herdr('mod.clone', { name: clone.mod, as: clone.as });
  writeFileSync(path.join(dir, 'main.js'), clone.source);
  for (const [name, from] of Object.entries(clone.files)) copyFileSync(integration(from), path.join(dir, name));
}

herdr('layout.clone', { name: 'main', as: NAME });
const layout = JSON.parse(readFileSync(file, 'utf8'));
if (layout.type !== 'row') {
  throw new Error(`main 版面的最外层不再是 row（现在是 ${layout.type}），这支脚本要跟着改`);
}
for (const clone of clones) {
  for (const id of clone.blocks) {
    const block = findBlock(layout, id);
    if (block?.content?.mod !== clone.mod) {
      throw new Error(`main 版面找不到 ${id} 区块，这支脚本要跟着改`);
    }
    block.content.mod = clone.as;
  }
}
layout.children.push(PANEL);
layout.floating = [...(layout.floating ?? []), COLUMN_SYNC];
writeFileSync(file, `${JSON.stringify(layout, null, 2)}\n`);
console.log(`已停靠：${file}`);

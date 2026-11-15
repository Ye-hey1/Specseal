#!/usr/bin/env node
// 安装或更新 Specseal 的 Herdr 集成：保留已安装布局中的外观与其他区块。
// 项目选择菜单、右上角入口和默认收起行为都由仓库生成，重复安装不会丢失。
// 更新前先验证内置组件的匹配点，再暂存全部文件并备份当前布局、快捷键和组件。
// 用法：node scripts/herdr/dock-panel.mjs（Herdr 要开着）
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'specseal';
// 宽度和 main 内置的 Files／Changes 那一栏相同。
const PANEL = {
  id: 'specseal',
  type: 'block',
  size: { px: 340 },
  min: 280,
  max: 900,
  hidden: true,
  // 标头可以拖动窗口，和分页列一样；面板内容与按钮会挡下按压。
  window_drag: true,
  content: { mod: 'specseal' },
};

// 不画东西的浮动区块，负责让那一栏每个 space 各自记住开关（见 column-sync.js）。
const COLUMN_SYNC = { id: 'specseal-column-sync', content: { mod: 'specseal', props: { view: 'column-sync' } } };

// 接上徽章要改的地方。Herdr 改了这几行就停下来，不要装出半套。
const SPACES_EDITS = [
  ['import { View, div, svg } from "gpui-kit";', 'import { View, div, svg } from "gpui-kit";\nimport { InputState as LangInput } from "gpui-base";\nimport { tr, watchLang } from "./i18n.js";\nimport { rowEnd, watchStages } from "./stage-badge.js";\nimport { watchProjectCommands } from "./projects.js";'],
  ['export default class Spaces extends View {\n  init(_props, cx) {', 'export default class Spaces extends View {\n  init(_props, cx) {\n    watchLang(exec, cx, { div, InputState: LangInput });\n    watchStages(this, cx);\n    watchProjectCommands(this, cx);'],
  [
    '.on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))',
    '.cursor_pointer().tooltip(tr("New workspace or project"))\n          .on_click(() => openOverlay({ mod: "specseal-workspace-menu", kind: "popup", width: 156, props: { labels: [tr("New workspace"), tr("Add project…")] } })).child(svg("mods/workspace-chrome/plus.svg").size(14))',
  ],
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
const TABS_REQUIRED_EDITS = [[
  '      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))',
  '      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))\n      .child(button("specseal-toggle", svg("mods/specseal/icons/logo.svg").size(12), () => run("layout.toggle", { id: "specseal" })).tooltip("Specseal · ⌘⇧S"))',
]];

const integration = (file) => fileURLToPath(new URL(`../../integrations/herdr/${file}`, import.meta.url));
// 版面里的区块换成哪个拷贝版。files 是拷贝版里的文件名对应 repo 里的文件。
const I18N = { 'i18n.js': 'mods/specseal/i18n.js' };
const UNPROTECTED = '名称刚好和接口文本相同时会被翻。';
export const CLONES = [
  {
    mod: 'spaces',
    blocks: ['spaces'],
    as: 'specseal-spaces',
    edits: SPACES_EDITS,
    files: { ...I18N, 'stage-badge.js': 'spaces-badge/stage-badge.js', 'projects.js': 'mods/specseal/projects.js' },
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
  { mod: 'tabs', blocks: ['tabs'], as: 'specseal-tabs', edits: TABS_EDITS, requiredEdits: TABS_REQUIRED_EDITS, files: {}, optional: '卷动页签列时会切换页签。' },
];

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`无法读取 ${file}: ${error.message}`, { cause: error }); }
}

function writeJson(file, value) {
  const next = `${file}.install-next`;
  try {
    writeFileSync(next, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(next, file);
  } finally {
    rmSync(next, { force: true });
  }
}

export function patchClone(clone, original, warn = console.warn) {
  let source = original;
  for (const [from, to] of clone.requiredEdits ?? []) {
    if (source.split(from).length !== 2) throw new Error(`Herdr 的 ${clone.mod} 组件缺少必须的匹配点：${from}`);
    source = source.replace(from, () => to);
  }
  for (const [from, to] of clone.edits) {
    if (source.split(from).length !== 2) {
      if (!clone.optional) throw new Error(`Herdr 的 ${clone.mod} mod 改了，找不到这一行：${from}`);
      warn(`Herdr 的 ${clone.mod} 可选修改未应用：${clone.optional}`);
      return { ...clone, source, skip: !clone.requiredEdits?.length };
    }
    source = source.replace(from, () => to);
  }
  return { ...clone, source, skip: false };
}

function findBlock(node, id) {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findBlock(child, id);
    if (found) return found;
  }
  return null;
}

export function prepareLayout(base, clones) {
  const layout = structuredClone(base);
  if (layout.type !== 'row') throw new Error('Herdr 布局的最外层必须是 row');
  for (const clone of clones) {
    for (const id of clone.blocks) {
      const block = findBlock(layout, id);
      if (![clone.mod, clone.as].includes(block?.content?.mod)) throw new Error(`布局中的 ${id} 不是内置或 Specseal 管理的组件，未覆盖`);
      block.content.mod = clone.skip ? clone.mod : clone.as;
    }
  }
  const panel = findBlock(layout, NAME) ?? structuredClone(PANEL);
  panel.content = { mod: NAME };
  panel.hidden = true;
  layout.children = [...layout.children.filter((node) => node.id !== NAME), panel];
  layout.floating = [...(layout.floating ?? []).filter((node) => node.id !== COLUMN_SYNC.id), structuredClone(COLUMN_SYNC)];
  return layout;
}

export function mergeKeys(current, defaults, warn = console.warn) {
  const keys = structuredClone(current);
  for (const [section, bindings] of Object.entries(defaults)) {
    keys[section] ??= {};
    for (const [key, action] of Object.entries(bindings)) {
      const old = keys[section][key];
      const managed = typeof old === 'string' && (/^mod\.open:(?:speclink|specseal|zh-CN-speclink)(?:-new)?$/.test(old) || /^layout\.toggle:(?:speclink|specseal)$/.test(old));
      if (old === undefined || old === action || managed) keys[section][key] = action;
      else warn(`保留用户快捷键：${section} ${key}`);
    }
  }
  return keys;
}

const callHerdr = (args) => execFileSync('herdr-app', args, { encoding: 'utf8' });

export function installHerdr({ home = process.env.HERDR_APP_HOME ?? path.join(homedir(), '.config/herdr-app'), herdr = callHerdr, warn = console.warn } = {}) {
  const file = path.join(home, 'layouts', `${NAME}.json`);
  const keysFile = path.join(home, 'keys.json');
  // 所有匹配点和布局先准备好；不匹配时不改当前界面。
  const clones = CLONES.map((clone) => patchClone(clone, readFileSync(path.join(home, 'mods', clone.mod, 'main.js'), 'utf8'), warn));
  const layout = prepareLayout(readJson(existsSync(file) ? file : path.join(home, 'layouts', 'main.json')), clones);
  const keys = mergeKeys(existsSync(keysFile) ? readJson(keysFile) : {}, readJson(integration('keys.json')), warn);
  let initial;
  try { initial = JSON.parse(herdr(['status'])); }
  catch (error) { throw new Error(`无法读取 Herdr 当前状态：${error.message}`, { cause: error }); }
  if (typeof initial.layout !== 'string') throw new Error('Herdr 未返回当前布局，未开始安装');
  const version = herdr(['--version']).trim().replace(/^herdr-app\s+/, '');
  const stage = mkdtempSync(path.join(home, '.specseal-install-'));
  const folders = [];
  let backup;
  const replaced = [];
  const originals = new Set();
  const files = [file, keysFile].map((name) => ({ name, content: existsSync(name) ? readFileSync(name) : null }));
  try {
    for (const entry of readdirSync(integration('mods'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      cpSync(integration(`mods/${entry.name}`), path.join(stage, entry.name), { recursive: true });
      folders.push(entry.name);
    }
    for (const clone of clones.filter((item) => !item.skip)) {
      const dir = path.join(stage, clone.as);
      cpSync(path.join(home, 'mods', clone.mod), dir, { recursive: true });
      writeFileSync(path.join(dir, 'main.js'), clone.source.replaceAll(`mods/${clone.mod}/`, `mods/${clone.as}/`));
      const meta = readJson(path.join(dir, 'mod.json'));
      meta.place = 'none';
      meta.cloned_from = { name: clone.mod, version };
      writeJson(path.join(dir, 'mod.json'), meta);
      for (const [name, from] of Object.entries(clone.files)) copyFileSync(integration(from), path.join(dir, name));
      folders.push(clone.as);
    }
    const backupRoot = path.join(home, 'backups', NAME);
    mkdirSync(backupRoot, { recursive: true });
    backup = mkdtempSync(path.join(backupRoot, `${Date.now()}-`));
    mkdirSync(path.join(backup, 'mods'));
    for (const name of folders) {
      const old = path.join(home, 'mods', name);
      if (existsSync(old)) {
        cpSync(old, path.join(backup, 'mods', name), { recursive: true });
        originals.add(name);
      }
    }
    for (const item of files) {
      if (item.content !== null) writeFileSync(path.join(backup, path.basename(item.name)), item.content);
    }
    writeJson(path.join(backup, 'manifest.json'), { layout: initial.layout, version, installedFrom: integration('.'), modules: folders });
    for (const name of folders) {
      replaced.push(name);
      const dest = path.join(home, 'mods', name);
      rmSync(dest, { recursive: true, force: true });
      renameSync(path.join(stage, name), dest);
    }
    writeJson(file, layout);
    writeJson(keysFile, keys);
    herdr(['do', 'layout.switch', JSON.stringify({ name: NAME })]);
    return { layout: file, backup };
  } catch (error) {
    for (const name of [...replaced].reverse()) {
      const dest = path.join(home, 'mods', name);
      rmSync(dest, { recursive: true, force: true });
      if (originals.has(name)) cpSync(path.join(backup, 'mods', name), dest, { recursive: true });
    }
    if (replaced.length) {
      for (const item of files) {
        if (item.content === null) rmSync(item.name, { force: true });
        else writeFileSync(item.name, item.content);
      }
      try { herdr(['do', 'layout.switch', JSON.stringify({ name: initial.layout })]); } catch {}
    }
    throw error;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = installHerdr();
  console.log(`已安装：${result.layout}\n备份：${result.backup}`);
}

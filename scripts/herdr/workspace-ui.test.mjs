import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { CLONES, installHerdr, mergeKeys, patchClone } from './dock-panel.mjs';
import { TO_ZH } from '../../integrations/herdr/mods/specseal/i18n.js';

const integration = fileURLToPath(new URL('../../integrations/herdr/', import.meta.url));
const read = (file) => readFileSync(path.join(integration, file), 'utf8');
function json(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Cannot read ${file}`, { cause: error }); }
}
const save = (file, value) => writeFileSync(file, JSON.stringify(value));
function loadNative(file, globals) {
  const source = read(file).replace(/^import .*;\n/gm, '')
    .replace(/export default class (\w+)/, 'globalThis.Entry = class $1')
    .replace(/export function /g, 'function ');
  const context = vm.createContext({ structuredClone, ...globals });
  vm.runInContext(source, context, { filename: file });
  return context;
}
function element(kind = 'div') {
  const target = { kind, attrs: {}, nodes: [], events: {} };
  let proxy;
  proxy = new Proxy(target, { get(object, key) {
    if (key in object) return object[key];
    if (key === 'child') return value => { object.nodes.push(value); return proxy; };
    if (key === 'children') return values => { object.nodes.push(...values); return proxy; };
    if (key === 'when') return (condition, callback) => { if (condition) callback(proxy); return proxy; };
    if (key === 'hover') return () => proxy;
    if (String(key).startsWith('on_')) return callback => { object.events[key] = callback; return proxy; };
    return (...values) => { object.attrs[key] = values.length === 1 ? values[0] : values; return proxy; };
  } });
  return proxy;
}
const tr = text => TO_ZH[text] ?? text;
function projects(picker, allSpaces = [], allPanes = []) {
  const calls = [], notices = [], jobs = [];
  const context = loadNative('mods/specseal/projects.js', {
    pickFolder: picker, spaces: () => allSpaces, panes: () => allPanes, tr,
    run: (command, args) => calls.push({ command, args }), notify: note => notices.push(note),
  });
  const cx = { notify() {}, spawn(callback) { jobs.push(callback(cx)); } };
  return { context, cx, view: {}, calls, notices, jobs };
}

test('添加项目：中文、空格、单引号目录原样传入本机工作区', async () => {
  const folder = "/tmp/项目 one's folder";
  let prompt;
  const state = projects(async options => { prompt = options.prompt; return folder; });
  state.context.addProject(state.view, state.cx);
  await Promise.all(state.jobs);
  assert.equal(prompt, '添加项目');
  assert.equal(state.calls[0].command, 'space.new');
  assert.equal(state.calls[0].args.folder, folder);
  assert.equal(state.calls[0].args.name, "项目 one's folder");
  assert.equal(state.calls[0].args.machine, '');
  assert.equal(state.view.addingProject, false);
});

test('添加项目：取消不创建，已打开的本机项目复用，远端同路径不复用', async () => {
  const cancelled = projects(async () => null);
  cancelled.context.addProject(cancelled.view, cancelled.cx);
  await Promise.all(cancelled.jobs);
  assert.equal(cancelled.calls.length, 0);
  const state = projects(async () => '/tmp/app', [
    { id: 'remote', machine: 'server', folder: '/tmp/app' },
    { id: 'local', machine: null, folder: '/tmp/app', tabs: [{ id: 't' }] },
  ], [{ tab: 't', cwd: '/tmp/app/src' }]);
  state.context.addProject(state.view, state.cx);
  await Promise.all(state.jobs);
  assert.equal(state.calls[0].command, 'space.select');
  assert.equal(state.calls[0].args.id, 'local');
});

test('添加项目：失败后可重试，选择中重复点击不会再开选择器', async () => {
  const state = projects(async () => { throw new Error('picker failed'); });
  state.context.addProject(state.view, state.cx);
  await Promise.all(state.jobs);
  assert.equal(state.notices[0].title, '无法添加项目');
  assert.equal(state.view.addingProject, false);
  let finish, picked = 0;
  state.context.pickFolder = () => { picked++; return new Promise(resolve => { finish = resolve; }); };
  state.context.addProject(state.view, state.cx);
  state.context.addProject(state.view, state.cx);
  assert.equal(picked, 1);
  finish(null);
  await Promise.all(state.jobs);
});

test('关闭小菜单后，常驻工作区仍能接收项目选择命令', async () => {
  let count = 0, messages = 0;
  const state = projects(async () => { count++; return null; });
  state.context.nextCommand = () => ++messages === 1 ? Promise.resolve('add-project') : new Promise(() => {});
  state.context.watchProjectCommands(state.view, state.cx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(count, 1);
  assert.equal(state.view.addingProject, false);
});

test('工作区＋菜单只有两个紧凑选项，关闭后分派正确操作', () => {
  const actions = [];
  const context = loadNative('mods/specseal-workspace-menu/main.js', {
    View: class {}, div: () => element(), svg: () => element('svg'), h_flex: () => element(), v_flex: () => element(),
    props: () => ({ overlay: 'popup' }), theme: () => ({}),
    closeOverlay: () => actions.push('close'), run: command => actions.push(command),
  });
  const menu = new context.Entry();
  menu.at = 0;
  const tree = menu.render();
  assert.equal(tree.nodes.length, 2);
  assert.equal(tree.nodes[0].attrs.h, 30);
  assert.equal(tree.nodes[1].nodes[1].nodes[0], '添加项目…');
  menu.choose(0); menu.choose(1);
  assert.deepEqual(actions, ['close', 'space.new', 'close', 'specseal-spaces.add-project']);
  assert.equal(json(path.join(integration, 'mods/specseal-workspace-menu/mod.json')).overlay.width, 156);
});

test('右上角图标在改动按钮之后、大小 12px；可选卷动补丁失败不会丢掉入口', () => {
  const tabs = CLONES.find(clone => clone.mod === 'tabs');
  const source = 'const display = h_flex()\n      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))';
  const patched = patchClone(tabs, source, () => {});
  assert.equal(patched.skip, false);
  const actions = [];
  const context = vm.createContext({
    enabled: ['changes'], h_flex: () => element(), svg: () => element('svg'),
    panelButton: id => element('button').id(id),
    button: (id, label, action) => element('button').id(id).on_click(action).child(label),
    run: (command, args) => actions.push([command, args]),
  });
  vm.runInContext(patched.source + '; globalThis.result = display;', context);
  assert.deepEqual(context.result.nodes.map(node => node.attrs.id), ['changes', 'specseal-toggle']);
  assert.equal(context.result.nodes[1].nodes[0].attrs.size, 12);
  context.result.nodes[1].events.on_click();
  assert.equal(actions[0][0], 'layout.toggle');
  assert.equal(actions[0][1].id, 'specseal');
});

test('面板初次默认收起，手动打开后按工作区记住状态', () => {
  let active = 'one';
  const column = { id: 'specseal', hidden: true };
  const stored = new Map();
  const context = loadNative('mods/specseal/column-sync.js', {
    div: () => ({}), layout: () => ({ children: [column] }), spaces: () => [{ id: active, active: true }],
    run: command => { column.hidden = command === 'layout.hide'; },
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
  });
  const sync = new context.Entry();
  sync.init(); sync.sync();
  assert.equal(column.hidden, true);
  column.hidden = false; sync.sync();
  active = 'two'; sync.sync(); sync.sync();
  assert.equal(column.hidden, true);
  active = 'one'; sync.sync(); sync.sync();
  assert.equal(column.hidden, false);
});

// 这些文本夹具只模拟安装所需的内置组件匹配点，验证文件更新、备份和回退。
// 与真实 Herdr 的兼容性另由 verify-install.mjs 在本机安装后检查。
function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'specseal-herdr-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, 'layouts'));
  mkdirSync(path.join(home, 'mods'));
  for (const clone of CLONES) {
    const dir = path.join(home, 'mods', clone.mod);
    mkdirSync(dir);
    const anchors = [...clone.requiredEdits ?? [], ...clone.edits].map(([from]) => from).sort((a, b) => b.length - a.length);
    let text = '';
    for (const anchor of anchors) if (!text.includes(anchor)) text += anchor + '\n';
    writeFileSync(path.join(dir, 'main.js'), text);
    save(path.join(dir, 'mod.json'), { place: 'none' });
  }
  const base = { id: 'root', type: 'row', theme: 'user-theme', children: [
    ...CLONES.map(clone => ({ id: clone.blocks[0], type: 'block', content: { mod: clone.mod } })),
    { id: 'personal', type: 'block', content: { mod: 'my-mod' } },
  ] };
  save(path.join(home, 'layouts/main.json'), base);
  save(path.join(home, 'keys.json'), { global: { 'cmd-x': 'personal.command' }, terminal: { 'ctrl-v': 'terminal.paste_image' } });
  let active = 'main';
  const calls = [];
  const herdr = args => {
    calls.push(args);
    if (args[0] === 'status') return JSON.stringify({ layout: active });
    if (args[0] === '--version') return 'herdr-app 0.1.15';
    active = JSON.parse(args[2]).name;
    return '{"ok":true}';
  };
  return { home, herdr, calls };
}

test('从仓库安装全部组件，重复安装保留主题、个人区块和快捷键且不叠加面板', t => {
  const state = fixture(t);
  const first = installHerdr({ ...state, warn() {} });
  const file = path.join(state.home, 'layouts/specseal.json');
  const changed = json(file);
  changed.theme = 'new-theme';
  changed.children.find(node => node.id === 'specseal').size.px = 421;
  save(file, changed);
  const marker = path.join(state.home, 'mods/specseal/personal-note.txt');
  writeFileSync(marker, 'keep in backup');
  const second = installHerdr({ ...state, warn() {} });
  const actual = json(file);
  assert.equal(actual.theme, 'new-theme');
  assert.equal(actual.children.filter(node => node.id === 'specseal').length, 1);
  assert.equal(actual.children.find(node => node.id === 'specseal').size.px, 421);
  assert.equal(actual.children.find(node => node.id === 'specseal').hidden, true);
  assert.equal(actual.children.find(node => node.id === 'personal').content.mod, 'my-mod');
  assert.equal(actual.floating.filter(node => node.id === 'specseal-column-sync').length, 1);
  const spaces = readFileSync(path.join(state.home, 'mods/specseal-spaces/main.js'), 'utf8');
  assert.ok(spaces.includes('watchProjectCommands(this, cx)'));
  assert.ok(spaces.includes('specseal-workspace-menu'));
  assert.ok(spaces.includes('width: 156'));
  assert.ok(readFileSync(path.join(state.home, 'mods/specseal-tabs/main.js'), 'utf8').includes('.size(12)'));
  assert.ok(existsSync(path.join(state.home, 'mods/specseal-spaces/projects.js')));
  assert.ok(existsSync(path.join(state.home, 'mods/specseal-workspace-menu/main.js')));
  assert.equal(json(path.join(state.home, 'keys.json')).global['cmd-x'], 'personal.command');
  assert.equal(json(path.join(state.home, 'keys.json')).global['cmd-shift-n'], 'mod.open:specseal-new');
  assert.equal(readFileSync(path.join(second.backup, 'mods/specseal/personal-note.txt'), 'utf8'), 'keep in backup');
  assert.notEqual(first.backup, second.backup);
  assert.equal(state.calls.filter(args => args[0] === 'do').length, 2);
});

test('内置组件匹配点丢失时，安装在修改现有配置之前失败', t => {
  const state = fixture(t);
  const file = path.join(state.home, 'mods/tabs/main.js');
  writeFileSync(file, 'changed upstream header');
  const before = readFileSync(path.join(state.home, 'keys.json'), 'utf8');
  assert.throws(() => installHerdr({ ...state, warn() {} }), /匹配点/);
  assert.equal(state.calls.length, 0);
  assert.equal(readFileSync(path.join(state.home, 'keys.json'), 'utf8'), before);
  assert.equal(existsSync(path.join(state.home, 'mods/specseal')), false);
});

test('启用新布局失败时恢复原组件、布局和快捷键', t => {
  const state = fixture(t);
  const before = readFileSync(path.join(state.home, 'keys.json'), 'utf8');
  const herdr = args => {
    if (args[0] === 'do' && JSON.parse(args[2]).name === 'specseal') throw new Error('activation failed');
    return state.herdr(args);
  };
  assert.throws(() => installHerdr({ home: state.home, herdr, warn() {} }), /activation failed/);
  assert.equal(existsSync(path.join(state.home, 'mods/specseal')), false);
  assert.equal(existsSync(path.join(state.home, 'layouts/specseal.json')), false);
  assert.equal(readFileSync(path.join(state.home, 'keys.json'), 'utf8'), before);
  assert.equal(JSON.parse(state.calls.at(-1)[2]).name, 'main');
});

test('已有自定义快捷键保留，旧集成的快捷键更新到 Specseal', () => {
  const keys = mergeKeys({ global: { a: 'personal.action', b: 'mod.open:speclink-new' } },
    { global: { a: 'mod.open:specseal', b: 'mod.open:specseal-new' } }, () => {});
  assert.equal(keys.global.a, 'personal.action');
  assert.equal(keys.global.b, 'mod.open:specseal-new');
});

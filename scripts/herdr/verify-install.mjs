#!/usr/bin/env node
// 验证当前安装实际使用仓库生成的组件，不写入 Herdr 配置。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLONES, patchClone } from './dock-panel.mjs';

const home = process.env.HERDR_APP_HOME ?? path.join(homedir(), '.config/herdr-app');
const integration = fileURLToPath(new URL('../../integrations/herdr/', import.meta.url));
function json(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`无法读取 ${file}`, { cause: error }); }
}
function find(node, id) {
  if (node.id === id) return node;
  return (node.children ?? []).map(child => find(child, id)).find(Boolean);
}
const layout = json(path.join(home, 'layouts/specseal.json'));
const statusText = execFileSync('herdr-app', ['status'], { encoding: 'utf8' });
let status;
try { status = JSON.parse(statusText); }
catch (error) { throw new Error('Herdr 未返回可读状态', { cause: error }); }
assert.equal(status.layout, 'specseal', '当前应启用本仓库的 specseal 布局');
assert.deepEqual(status.errors, [], '当前界面不应有加载错误');
assert.equal(layout.children.filter(node => node.id === 'specseal').length, 1);
assert.equal(find(layout, 'specseal').hidden, true, '安装配置应默认收起面板');
assert.equal(layout.floating.filter(node => node.id === 'specseal-column-sync').length, 1);

const installedFolders = [];
for (const entry of readdirSync(path.join(integration, 'mods'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  installedFolders.push(entry.name);
  const source = path.join(integration, 'mods', entry.name);
  for (const file of readdirSync(source)) {
    if (!file.endsWith('.js') && file !== 'mod.json') continue;
    assert.equal(readFileSync(path.join(home, 'mods', entry.name, file), 'utf8'), readFileSync(path.join(source, file), 'utf8'), `组件未同步：${entry.name}/${file}`);
  }
}
for (const clone of CLONES) {
  const native = readFileSync(path.join(home, 'mods', clone.mod, 'main.js'), 'utf8');
  const expected = patchClone(clone, native, () => {});
  assert.equal(find(layout, clone.blocks[0]).content.mod, expected.skip ? clone.mod : clone.as);
  if (expected.skip) continue;
  installedFolders.push(clone.as);
  assert.equal(readFileSync(path.join(home, 'mods', clone.as, 'main.js'), 'utf8'), expected.source.replaceAll(`mods/${clone.mod}/`, `mods/${clone.as}/`), `生成组件不同步：${clone.as}`);
  for (const [name, from] of Object.entries(clone.files)) {
    assert.equal(readFileSync(path.join(home, 'mods', clone.as, name), 'utf8'), readFileSync(path.join(integration, from), 'utf8'), `辅助组件未同步：${clone.as}/${name}`);
  }
}
const tabs = readFileSync(path.join(home, 'mods/specseal-tabs/main.js'), 'utf8');
assert.ok(tabs.includes('button("specseal-toggle", svg("mods/specseal/icons/logo.svg").size(12)'));
const brand = find(layout, 'brand');
if (brand?.content?.mod) {
  const source = readFileSync(path.join(home, 'mods', brand.content.mod, 'main.js'), 'utf8');
  assert.ok(!source.includes('specseal-toggle'), '左侧标题栏不应保留 Specseal 图标');
}
assert.equal(json(path.join(home, 'mods/specseal-workspace-menu/mod.json')).overlay.width, 156);
for (const folder of installedFolders) {
  for (const file of readdirSync(path.join(home, 'mods', folder)).filter(name => name.endsWith('.js'))) {
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: readFileSync(path.join(home, 'mods', folder, file)), stdio: ['pipe', 'pipe', 'pipe'] });
  }
}
const backupRoot = path.join(home, 'backups/specseal');
const backups = existsSync(backupRoot) ? readdirSync(backupRoot).filter(name => existsSync(path.join(backupRoot, name, 'manifest.json'))) : [];
console.log(`Specseal Herdr installation verified (${installedFolders.length} modules, ${backups.length} backups)`);

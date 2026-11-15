import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts', 'npm', 'npm-engine-package.mjs');

// napi create-npm-dir 的产物形状：主套件根一份 package.json，npm/<平台>/ 各一份。
function makeTree(tmp, platforms) {
  const dir = path.join(tmp, 'pkg');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      { name: '@specseal/engine', version: '0.1.0', license: 'MIT', '//': '版号为占位符' },
      null,
      2,
    )}\n`,
  );
  for (const platform of platforms) {
    const subDir = path.join(dir, 'npm', platform);
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      path.join(subDir, 'package.json'),
      `${JSON.stringify(
        { name: `@specseal/engine-${platform}`, version: '0.1.0', os: [platform.split('-')[0]] },
        null,
        2,
      )}\n`,
    );
  }
  return dir;
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

function readPkg(...segments) {
  return JSON.parse(readFileSync(path.join(...segments), 'utf8'));
}

const FIVE = [
  'win32-x64-msvc',
  'darwin-x64',
  'darwin-arm64',
  'linux-x64-gnu',
  'linux-arm64-gnu',
];

test('盖章后主套件与每个平台子套件同版，optionalDependencies 恰为子套件名各钉同版', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'specseal-engine-pkg-'));
  const dir = makeTree(tmp, FIVE);
  const result = run(['--version', '0.2.0', '--dir', dir]);
  assert.equal(result.status, 0, result.stderr);

  const main = readPkg(dir, 'package.json');
  assert.equal(main.version, '0.2.0');
  // 占位符注解只对 repo 内的版号成立，盖章后的发布产物不得带着它。
  assert.equal(main['//'], undefined, '盖章后不得保留占位符注解');
  assert.deepEqual(main.optionalDependencies, {
    '@specseal/engine-win32-x64-msvc': '0.2.0',
    '@specseal/engine-darwin-x64': '0.2.0',
    '@specseal/engine-darwin-arm64': '0.2.0',
    '@specseal/engine-linux-x64-gnu': '0.2.0',
    '@specseal/engine-linux-arm64-gnu': '0.2.0',
  });

  for (const platform of FIVE) {
    const sub = readPkg(dir, 'npm', platform, 'package.json');
    assert.equal(sub.version, '0.2.0', `${platform} 子套件版号未盖章`);
    assert.equal(sub.name, `@specseal/engine-${platform}`, `${platform} 子套件名不得被改写`);
  }
});

test('子套件清单来自目录枚举：目录增减时 optionalDependencies 跟着变', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'specseal-engine-pkg-'));
  const dir = makeTree(tmp, ['darwin-arm64', 'linux-x64-gnu']);
  assert.equal(run(['--version', '0.2.0', '--dir', dir]).status, 0);
  assert.deepEqual(Object.keys(readPkg(dir, 'package.json').optionalDependencies), [
    '@specseal/engine-darwin-arm64',
    '@specseal/engine-linux-x64-gnu',
  ]);

  // 同一棵树再长出一个平台目录，重跑后清单应含三笔——不得硬编码 triple。
  const extra = path.join(dir, 'npm', 'win32-x64-msvc');
  mkdirSync(extra, { recursive: true });
  writeFileSync(
    path.join(extra, 'package.json'),
    `${JSON.stringify({ name: '@specseal/engine-win32-x64-msvc', version: '0.1.0' }, null, 2)}\n`,
  );
  assert.equal(run(['--version', '0.3.0', '--dir', dir]).status, 0);
  assert.deepEqual(readPkg(dir, 'package.json').optionalDependencies, {
    '@specseal/engine-darwin-arm64': '0.3.0',
    '@specseal/engine-linux-x64-gnu': '0.3.0',
    '@specseal/engine-win32-x64-msvc': '0.3.0',
  });
});

test('缺 --version 即非零结束', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'specseal-engine-pkg-'));
  const result = run(['--dir', makeTree(tmp, FIVE)]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--version/);
});

test('版本不符 X.Y.Z 格式即非零结束（tag 名须先去 v 前缀）', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'specseal-engine-pkg-'));
  const result = run(['--version', 'v0.2.0', '--dir', makeTree(tmp, FIVE)]);
  assert.notEqual(result.status, 0);
});

test('没有任何平台子套件目录即非零结束（fail-closed）', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'specseal-engine-pkg-'));
  const result = run(['--version', '0.2.0', '--dir', makeTree(tmp, [])]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /npm/);
});

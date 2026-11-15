// @specseal/cli 主套件的 shim 与 postinstall（cli-distribution spec「CLI 以 npm 套件发布」；
// release-assets-trim 设计 D4）。纯函数（平台映射、binary 定位、置换决策）直接导入测；
// shim 的 spawn、参数透传与 exit code 转发以子行程对假 binary 验，三平台都跑：POSIX 的假
// binary 是 sh 脚本，Windows 的假 binary 是 node.exe 的复本（shim 原样透传参数，所以测试
// 以 -e 让它印参数并以指定码结束）。信号转发只在 POSIX 验——Windows 没有信号。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkgSource = path.join(root, 'packages/cli-npm');
const { platformPackage, binaryName, resolveBinary, SUPPORTED_PLATFORMS } = await import(
  pathToFileURL(path.join(pkgSource, 'platform.mjs')).href
);
const { replaceShim } = await import(pathToFileURL(path.join(pkgSource, 'postinstall.mjs')).href);

const isWindows = process.platform === 'win32';
const posixTest = isWindows ? test.skip : test;
// 子行程 postinstall 的环境：固定 npm 的 user agent，测试由 yarn 启动时结果才不会跟着变。
const NPM_ENV = { ...process.env, npm_config_user_agent: 'npm/10.9.0 node/v22.0.0 linux x64' };

// --- 平台映射 ---

test('os/cpu 映射到五个平台子套件，之外的平台回 null', () => {
  const matrix = [
    ['darwin', 'arm64', '@specseal/cli-darwin-arm64'],
    ['darwin', 'x64', '@specseal/cli-darwin-x64'],
    ['linux', 'x64', '@specseal/cli-linux-x64'],
    ['linux', 'arm64', '@specseal/cli-linux-arm64'],
    ['win32', 'x64', '@specseal/cli-win32-x64'],
    ['freebsd', 'x64', null],
    ['win32', 'arm64', null],
  ];
  for (const [platform, arch, expected] of matrix) {
    assert.equal(platformPackage(platform, arch), expected, `${platform}/${arch}`);
  }
  assert.deepEqual(SUPPORTED_PLATFORMS, ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64']);
  assert.equal(binaryName('win32'), 'specseal.exe');
  assert.equal(binaryName('linux'), 'specseal');
});

// --- 沙盒：仿真 npm i -g 之后的目录布局 ---
//
//   <sandbox>/node_modules/@specseal/cli/{package.json,bin/specseal,postinstall.mjs,platform.mjs}
//   <sandbox>/node_modules/@specseal/cli-<os>-<cpu>/{package.json,specseal[.exe]}
//
// shim 与 postinstall 以自身位置往上找 node_modules 解析子套件，与真实安装同一条路。
function sandbox(t, { withPlatformPackage = true, platform = process.platform, arch = process.arch, exitCode = 0, signal = null } = {}) {
  // realpath：macOS 的 os.tmpdir() 经 /var → /private/var symlink，require.resolve 回的是真实路径。
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'specseal-cli-npm-')));
  // maxRetries：Windows 上刚拷贝出来、刚运行完的假 specseal.exe 会短暂被占用（杀毒扫描），
  // 立刻删会 EBUSY 或 ENOTEMPTY；rmSync 遇到这些错误会重试，第 i 次重试前等 i × retryDelay，
  // 这组数值最多共等 11 秒（只在真的被占用时才等）。原本 5／100 只等 1.5 秒，CI 上还是不够。
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const mainDir = path.join(dir, 'node_modules/@specseal/cli');
  mkdirSync(path.join(mainDir, 'bin'), { recursive: true });
  for (const file of ['package.json', 'bin/specseal', 'postinstall.mjs', 'platform.mjs']) {
    cpSync(path.join(pkgSource, file), path.join(mainDir, file));
  }
  chmodSync(path.join(mainDir, 'bin/specseal'), 0o755);

  let binary = null;
  if (withPlatformPackage) {
    const subDir = path.join(dir, 'node_modules', platformPackage(platform, arch));
    mkdirSync(subDir, { recursive: true });
    writeFileSync(path.join(subDir, 'package.json'), JSON.stringify({ name: platformPackage(platform, arch), version: '0.5.0' }));
    binary = path.join(subDir, binaryName(platform));
    if (isWindows) {
      // Windows 的假 binary 得是真的 .exe：拿 node.exe 复本，行为由测试传入的 -e 决定。
      cpSync(process.execPath, binary);
    } else {
      // 假 binary：印出收到的每个参数（一行一个），以指定码结束；指定 signal 时改对自己送该信号。
      const ending = signal ? `kill -${signal} $$` : `exit ${exitCode}`;
      writeFileSync(binary, `#!/bin/sh\nfor a in "$@"; do echo "arg:$a"; done\n${ending}\n`);
      chmodSync(binary, 0o755);
    }
  }
  return { dir, mainDir, shim: path.join(mainDir, 'bin/specseal'), binary };
}

/// 假 binary 的「印参数、以指定码结束」行为：POSIX 写在 sh 脚本里，Windows 由 node.exe 复本
/// 吃 -e 脚本——shim 原样透传参数，所以测试把 -e 放在最前面即可。
function fakeArgs(exitCode, ...args) {
  if (!isWindows) return args;
  return ['-e', `for (const a of process.argv.slice(1)) console.log('arg:' + a); process.exit(${exitCode});`, ...args];
}

// --- binary 定位 ---

test('resolveBinary 自主套件位置解析出对应子套件内的 binary；未安装或不支持回 null', (t) => {
  const box = sandbox(t);
  const fromUrl = pathToFileURL(box.shim).href;
  assert.equal(resolveBinary(fromUrl, process.platform, process.arch), box.binary);
  assert.equal(resolveBinary(fromUrl, 'freebsd', 'x64'), null, '不支持的平台回 null');

  const empty = sandbox(t, { withPlatformPackage: false });
  assert.equal(resolveBinary(pathToFileURL(empty.shim).href, process.platform, process.arch), null, '子套件未安装回 null');
});

// --- shim：spawn、参数透传、exit code 转发 ---

test('shim 以 spawn 运行平台 binary、参数原样透传、exit 0 转发（三平台）', (t) => {
  const box = sandbox(t);
  const result = spawnSync(process.execPath, [box.shim, ...fakeArgs(0, 'status', '--json')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.replace(/\r\n/g, '\n'), 'arg:status\narg:--json\n');
});

posixTest('shim 连 -- 与空字符串参数都原样透传', (t) => {
  const box = sandbox(t);
  const result = spawnSync(process.execPath, [box.shim, 'status', '--json', '--', '--weird', ''], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'arg:status\narg:--json\narg:--\narg:--weird\narg:\n');
});

test('shim 把 binary 的非零 exit code 原样带回（三平台）', (t) => {
  const box = sandbox(t, { exitCode: 3 });
  const result = spawnSync(process.execPath, [box.shim, ...fakeArgs(3, 'validate')], { encoding: 'utf8' });
  assert.equal(result.status, 3);
});

posixTest('binary 被信号收束时 shim 对自己送同一个信号：调用端看到的是 SIGTERM，不是 exit code', (t) => {
  const box = sandbox(t, { signal: 'TERM' });
  const result = spawnSync(process.execPath, [box.shim, 'serve'], { encoding: 'utf8' });
  assert.equal(result.signal, 'SIGTERM', 'shim 应以同一个信号终止');
  assert.equal(result.status, null);
  assert.equal(result.stdout, 'arg:serve\n', '信号之前的输出仍透传');
});

test('找不到对应子套件时 shim 于 stderr 列出支持组合并以 exit 1 结束（三平台）', (t) => {
  const box = sandbox(t, { withPlatformPackage: false });
  const result = spawnSync(process.execPath, [box.shim, '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`${process.platform}[-/]${process.arch}`), 'stderr 点名目前的 os/cpu');
  for (const key of SUPPORTED_PLATFORMS) {
    assert.ok(result.stderr.includes(key), `stderr 应列出支持组合 ${key}`);
  }
  assert.equal(result.stdout, '');
});

// --- postinstall：原生 binary 原地置换 shim ---

posixTest('darwin／linux 找到 binary 时把 bin/specseal 原地换成该 binary（内容相同、0755）', (t) => {
  const box = sandbox(t);
  const outcome = replaceShim({ platform: process.platform, arch: process.arch, shimPath: box.shim });
  assert.deepEqual(outcome, { replaced: true, binary: box.binary });
  assert.equal(readFileSync(box.shim, 'utf8'), readFileSync(box.binary, 'utf8'), '置换后 shim 档内容应等于原生 binary');
  assert.equal(statSync(box.shim).mode & 0o777, 0o755);
  // 置换后就是原生档本身，直接运行仍转发 exit code。
  const result = spawnSync(box.shim, ['x'], { encoding: 'utf8' });
  assert.equal(result.stdout, 'arg:x\n');
});

test('win32 不置换：npm 的 .cmd 壳以 node 运行 bin，换成原生档会坏', (t) => {
  const box = sandbox(t, { platform: 'win32', arch: 'x64' });
  const before = readFileSync(box.shim, 'utf8');
  const outcome = replaceShim({ platform: 'win32', arch: 'x64', shimPath: box.shim });
  assert.deepEqual(outcome, { replaced: false, reason: 'win32' });
  assert.equal(readFileSync(box.shim, 'utf8'), before);
});

test('Yarn 安装时不置换：Yarn Berry 一律以 node 运行套件 bin，换成原生档会坏（esbuild 同款守门）', (t) => {
  const box = sandbox(t, { platform: 'linux', arch: 'x64' });
  const before = readFileSync(box.shim, 'utf8');
  const yarn = 'yarn/4.5.0 npm/? node/v22.0.0 linux x64';
  assert.deepEqual(
    replaceShim({ platform: 'linux', arch: 'x64', shimPath: box.shim, userAgent: yarn }),
    { replaced: false, reason: 'yarn' },
  );
  assert.equal(readFileSync(box.shim, 'utf8'), before, 'Yarn 下 shim 不得被动');
  // npm／pnpm 的 user agent 不受影响；未设置（直接运行 node postinstall.mjs）亦同。
  assert.equal(replaceShim({ platform: 'linux', arch: 'x64', shimPath: box.shim, userAgent: 'npm/10.9.0 node/v22.0.0 linux x64' }).replaced, true);
});

test('postinstall 本体读 npm_config_user_agent：Yarn 下以 0 结束且 shim 未动', (t) => {
  const box = sandbox(t);
  const before = readFileSync(box.shim, 'utf8');
  const result = spawnSync(process.execPath, ['postinstall.mjs'], {
    encoding: 'utf8',
    cwd: box.mainDir,
    env: { ...process.env, npm_config_user_agent: 'yarn/4.5.0 npm/? node/v22.0.0 darwin arm64' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(box.shim, 'utf8'), before);
});

test('找不到平台 binary 时保留 shim 且不视为错误（--ignore-scripts 或子套件缺席的退路）', (t) => {
  const box = sandbox(t, { withPlatformPackage: false });
  const before = readFileSync(box.shim, 'utf8');
  // 平台固定给 linux/x64：win32 在找 binary 之前就先以 reason win32 保留 shim（上一条测试），
  // 用 host 平台会让这条在 Windows runner 上验到的是另一个分支。
  const outcome = replaceShim({ platform: 'linux', arch: 'x64', shimPath: box.shim });
  assert.deepEqual(outcome, { replaced: false, reason: 'binary-missing' });
  assert.equal(readFileSync(box.shim, 'utf8'), before);

  // 以子行程跑 postinstall 本体：exit 0、shim 未动。
  const result = spawnSync(process.execPath, [path.join(box.mainDir, 'postinstall.mjs')], { encoding: 'utf8', cwd: box.mainDir, env: NPM_ENV });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(box.shim, 'utf8'), before);
  assert.equal(existsSync(path.join(box.mainDir, 'bin/specseal')), true);
});

posixTest('postinstall 本体经 symlink 路径被调用时仍运行置换（npm prefix 走 symlink 的机器）', (t) => {
  const box = sandbox(t);
  // 套件目录通过一个 symlink 抵达：argv[1] 是 symlink 路径，import.meta.url 是 node 解析后的
  // 实体路径——入口判定没 realpath 就会静默不跑 main，shim 留着、每次调用多付 Node 启动。
  const link = path.join(box.dir, 'linked-cli');
  symlinkSync(box.mainDir, link);
  const result = spawnSync(process.execPath, [path.join(link, 'postinstall.mjs')], { encoding: 'utf8', cwd: link, env: NPM_ENV });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(box.shim, 'utf8'), readFileSync(box.binary, 'utf8'), '经 symlink 调用也要完成置换');
  assert.equal(statSync(box.shim).mode & 0o777, 0o755);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const launcherPath = path.join(root, 'packages/server-npm/bin/specseal-server.mjs');
const { platformPackageSuffix, buildQuickstart, decideSpawnArgs } = await import(
  pathToFileURL(launcherPath).href
);

// --- 平台映射（server-release spec「npm 套件一行启动 server」） ---

test('os/cpu 映射到五个平台子套件，之外的平台回 null', () => {
  const matrix = [
    ['darwin', 'arm64', 'server-darwin-arm64'],
    ['darwin', 'x64', 'server-darwin-x64'],
    ['linux', 'x64', 'server-linux-x64'],
    ['linux', 'arm64', 'server-linux-arm64'],
    ['win32', 'x64', 'server-win32-x64'],
    ['freebsd', 'x64', null],
    ['win32', 'arm64', null],
  ];
  for (const [platform, arch, expected] of matrix) {
    assert.equal(platformPackageSuffix(platform, arch), expected, `${platform}/${arch}`);
  }
});

// --- 快速启动的组态插值（设计 D9：仿 compose，环境变量 → YAML 落地） ---

// 路径在 YAML 里是双引号 scalar（JSON 跳脱——Windows 反斜线成 \\），断言要比对
// 跳脱后的字面，拿原始路径 includes() 在 Windows 必然对不上。
const asYamlScalar = (p) => JSON.stringify(p);

test('零环境变量时走 sqlite 缺省、数据目录 ./specseal-data、public_url 连动缺省端口', () => {
  const plan = buildQuickstart({});
  assert.equal(plan.error, undefined);
  assert.equal(plan.dataDir, path.resolve('./specseal-data'));
  assert.equal(plan.addr, '127.0.0.1:8080');
  assert.match(plan.configYaml, /driver: "sqlite"/);
  assert.ok(plan.configYaml.includes(asYamlScalar(path.join(plan.dataDir, 'store.db'))));
  assert.ok(plan.configYaml.includes(asYamlScalar(path.join(plan.dataDir, 'identity.db'))));
  assert.match(plan.configYaml, /public_url: "http:\/\/localhost:8080"/);
});

test('SPECSEAL_PORT 连动 addr 与 public_url，SPECSEAL_PUBLIC_URL 设置时胜出', () => {
  const ported = buildQuickstart({ SPECSEAL_PORT: '9123' });
  assert.equal(ported.addr, '127.0.0.1:9123');
  assert.match(ported.configYaml, /public_url: "http:\/\/localhost:9123"/);

  const explicit = buildQuickstart({ SPECSEAL_PORT: '9123', SPECSEAL_PUBLIC_URL: 'https://spec.example.com' });
  assert.match(explicit.configYaml, /public_url: "https:\/\/spec\.example\.com"/);
});

test('SPECSEAL_STORE=serverfs 产出 serverfs 目录声明', () => {
  const plan = buildQuickstart({ SPECSEAL_STORE: 'serverfs', SPECSEAL_DATA_DIR: '/tmp/x' });
  assert.match(plan.configYaml, /driver: "serverfs"/);
  assert.ok(plan.configYaml.includes(asYamlScalar(path.join(path.resolve('/tmp/x'), 'store'))));
});

test('SPECSEAL_STORE=postgres 带 URL 产出 url 字段、缺 URL 即错误点名', () => {
  const ok = buildQuickstart({
    SPECSEAL_STORE: 'postgres',
    SPECSEAL_POSTGRES_URL: 'postgres://u@h/db',
  });
  assert.match(ok.configYaml, /driver: "postgres"/);
  assert.match(ok.configYaml, /url: "postgres:\/\/u@h\/db"/);
  assert.ok(!ok.configYaml.includes('store.db'), 'postgres 不应产出 sqlite 路径');

  const missing = buildQuickstart({ SPECSEAL_STORE: 'postgres' });
  assert.match(missing.error, /SPECSEAL_POSTGRES_URL/);
});

test('未知 SPECSEAL_STORE 即错误并列出合法值', () => {
  const plan = buildQuickstart({ SPECSEAL_STORE: 'mongodb' });
  assert.match(plan.error, /mongodb/);
  assert.match(plan.error, /sqlite/);
  assert.match(plan.error, /serverfs/);
  assert.match(plan.error, /postgres/);
});

// --- 模式判定：零参数 → 快速启动；带参数或 SPECSEAL_CONFIG → 透传 ---

test('零参数且无 SPECSEAL_CONFIG 走快速启动', () => {
  assert.equal(decideSpawnArgs([], {}).mode, 'quickstart');
});

test('带 --config 或子命令即纯透传、不产组态', () => {
  const config = decideSpawnArgs(['--config', 'x.yaml'], {});
  assert.equal(config.mode, 'passthrough');
  assert.deepEqual(config.args, ['--config', 'x.yaml']);

  const sub = decideSpawnArgs(['invite', '--email', 'a@b.c'], {});
  assert.equal(sub.mode, 'passthrough');
  assert.deepEqual(sub.args, ['invite', '--email', 'a@b.c']);
});

test('SPECSEAL_CONFIG 补上 --config，args 已有 --config 时不重复', () => {
  const bare = decideSpawnArgs([], { SPECSEAL_CONFIG: '/etc/s.yaml' });
  assert.equal(bare.mode, 'passthrough');
  assert.deepEqual(bare.args, ['--config', '/etc/s.yaml']);

  const withAddr = decideSpawnArgs(['--addr', '0.0.0.0:80'], { SPECSEAL_CONFIG: '/etc/s.yaml' });
  assert.deepEqual(withAddr.args, ['--config', '/etc/s.yaml', '--addr', '0.0.0.0:80']);

  const explicit = decideSpawnArgs(['--config', 'mine.yaml'], { SPECSEAL_CONFIG: '/etc/s.yaml' });
  assert.deepEqual(explicit.args, ['--config', 'mine.yaml']);
});

// --- 集成：假 binary 验证透传与 exit code（Windows 无法以 script 假冒 .exe，跳过） ---

const intTest = process.platform === 'win32' ? test.skip : test;

function plantFakePackage(tmp, { exitCode = 0 } = {}) {
  const suffix = platformPackageSuffix(process.platform, process.arch);
  assert.ok(suffix, '集成测试需在支持平台上运行');
  const pkgDir = path.join(tmp, 'node_modules', '@specseal', suffix);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: `@specseal/${suffix}`, version: '0.0.0' }));
  const bin = path.join(pkgDir, 'specseal-server');
  // 假 binary：把收到的参数逐行写到 SPECSEAL_FAKE_OUT，以指定码结束。
  writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do echo "$a" >> "$SPECSEAL_FAKE_OUT"; done\nexit ${exitCode}\n`);
  chmodSync(bin, 0o755);
  return tmp;
}

intTest('透传模式：参数逐字到达 binary、exit code 一致', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'specseal-npm-'));
  plantFakePackage(tmp, { exitCode: 7 });
  const out = path.join(tmp, 'args.txt');
  const result = spawnSync(process.execPath, [launcherPath, '--config', 'x.yaml', '--addr', '1.2.3.4:9'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: path.join(tmp, 'node_modules'), SPECSEAL_FAKE_OUT: out },
  });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(readFileSync(out, 'utf8').trim().split('\n'), ['--config', 'x.yaml', '--addr', '1.2.3.4:9']);
});

intTest('快速启动：组态 YAML 落地数据目录并以 --config 传入', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'specseal-npm-'));
  plantFakePackage(tmp);
  const out = path.join(tmp, 'args.txt');
  const dataDir = path.join(tmp, 'data');
  const result = spawnSync(process.execPath, [launcherPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_PATH: path.join(tmp, 'node_modules'),
      SPECSEAL_FAKE_OUT: out,
      SPECSEAL_DATA_DIR: dataDir,
      SPECSEAL_PORT: '8321',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const args = readFileSync(out, 'utf8').trim().split('\n');
  assert.equal(args[0], '--config');
  assert.equal(args[1], path.join(dataDir, 'config.yaml'));
  assert.deepEqual(args.slice(2), ['--addr', '127.0.0.1:8321']);
  const yaml = readFileSync(path.join(dataDir, 'config.yaml'), 'utf8');
  assert.match(yaml, /driver: "sqlite"/);
  assert.match(yaml, /public_url: "http:\/\/localhost:8321"/);
});

intTest('经 npm bin shim 的 symlink 调用时 main 仍运行（argv[1] 是 symlink、import.meta.url 是实体路径）', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'specseal-npm-'));
  plantFakePackage(tmp, { exitCode: 7 });
  const out = path.join(tmp, 'args.txt');
  // npm 在 node_modules/.bin 放的是指向 bin 档的 symlink——node 缺省解析主模块
  // 的 realpath，于是 import.meta.url 与 argv[1] 不同字面；入口判断若比对原始
  // argv[1]，main() 静默不运行、exit 0。
  const shim = path.join(tmp, 'specseal-server-shim');
  symlinkSync(launcherPath, shim);
  const result = spawnSync(process.execPath, [shim, '--config', 'x.yaml'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: path.join(tmp, 'node_modules'), SPECSEAL_FAKE_OUT: out },
  });
  assert.equal(result.status, 7, `main 未运行（status=${result.status}）：${result.stderr}`);
  assert.deepEqual(readFileSync(out, 'utf8').trim().split('\n'), ['--config', 'x.yaml']);
});

intTest('平台子套件缺席时以可读错误点名', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'specseal-npm-'));
  const result = spawnSync(process.execPath, [launcherPath, '--config', 'x.yaml'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: path.join(tmp, 'node_modules') },
  });
  assert.notEqual(result.status, 0);
  const suffix = platformPackageSuffix(process.platform, process.arch);
  assert.ok(result.stderr.includes(suffix), `错误消息应点名 ${suffix}：${result.stderr}`);
});

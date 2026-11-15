// OS 签章 secrets 闸门的单元测试（desktop-release spec「OS 代码签章为可插钥匙开关」，
// design D1）。以子行程运行 scripts/release/signing-gate.mjs，仿真三种 secrets 组合：
// 全无（跳过签章、绿灯）、全有（激活对应路径）、缺一（fail-closed 并点名缺项）。
//
// 闸门只读「是否非空」，永不输出 secret 值——泄漏面由专门案例守住。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/release/signing-gate.mjs');

/// 回传 needle 在 haystack 的起始索引，找不到时以带标签的消息 fail——把「缺片段」
/// 与「顺序错」两种失败分开，避免 indexOf 回 -1 让顺序断言假性通过。
function requireIndex(haystack, needle, label) {
  const i = haystack.indexOf(needle);
  assert.notEqual(i, -1, `${label}: 找不到片段 ${JSON.stringify(needle)}`);
  return i;
}

const MACOS_NAMES = [
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_SIGNING_IDENTITY',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID',
];
// SIGNPATH_*：裁定不采用后不再受管，保留清单只为抹除环境与「被忽略」断言。
const SIGNPATH_NAMES = [
  'SIGNPATH_API_TOKEN',
  'SIGNPATH_ORGANIZATION_ID',
  'SIGNPATH_PROJECT_SLUG',
  'SIGNPATH_POLICY_SLUG',
];
const WINDOWS_CERT_NAMES = ['WINDOWS_CERTIFICATE', 'WINDOWS_CERTIFICATE_PASSWORD'];
const ALL_NAMES = [...MACOS_NAMES, ...SIGNPATH_NAMES, ...WINDOWS_CERT_NAMES];

// 可辨识的假值：一旦出现在 stdout／stderr／GITHUB_ENV，即为泄漏。
const SECRET_VALUE = 'ZmFrZS1zZWNyZXQtdmFsdWU=';

/// 把一组 secret 名称全部填成假值。
function filled(names) {
  return Object.fromEntries(names.map((name) => [name, SECRET_VALUE]));
}

/// 以干净环境运行闸门：先抹掉全部受管名称，再套用本案例的 overrides。
/// 回传结果附上 GITHUB_ENV 档的内容（未写入时为 null），供决策断言使用。
function runGate(overrides = {}, t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'signing-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, 'github_env');

  const env = { ...process.env };
  for (const name of ALL_NAMES) delete env[name];
  env.GITHUB_ENV = envFile;
  Object.assign(env, overrides);

  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
  const githubEnv = existsSync(envFile) ? readFileSync(envFile, 'utf8') : null;
  return { ...result, githubEnv };
}

/// 从 GITHUB_ENV 内容取出某个键的值（`KEY=value` 逐行格式）。
function envValue(content, key) {
  const line = (content ?? '').split('\n').find((row) => row.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1);
}

// --- 全无：跳过签章、workflow 照常全绿 ---

test('三组 secrets 全无时以零结束，两平台决策皆为 none', (t) => {
  const result = runGate({}, t);

  assert.equal(result.status, 0, `全无 secrets 应成功结束\nstderr: ${result.stderr}`);
  assert.equal(envValue(result.githubEnv, 'SPECSEAL_MACOS_SIGNING'), 'none');
  assert.equal(envValue(result.githubEnv, 'SPECSEAL_WINDOWS_SIGNING'), 'none');
});

// --- 全有：激活对应签章路径 ---

test('macOS 六项齐备时决策为 full（凭证半组＋公证半组）', (t) => {
  const result = runGate(filled(MACOS_NAMES), t);

  assert.equal(result.status, 0, `六项齐备应成功结束\nstderr: ${result.stderr}`);
  assert.equal(envValue(result.githubEnv, 'SPECSEAL_MACOS_SIGNING'), 'full');
});

// SignPath 裁定不采用（design D2）：SIGNPATH_* 不再是受管签章组——存在、部分
// 存在都不影响决策，也不触发 fail-closed。
test('SIGNPATH_* 即使齐备也不影响决策（裁定不采用）', (t) => {
  const result = runGate(filled(SIGNPATH_NAMES), t);

  assert.equal(result.status, 0, `SIGNPATH_* 不应触发任何闸门行为\nstderr: ${result.stderr}`);
  assert.equal(envValue(result.githubEnv, 'SPECSEAL_WINDOWS_SIGNING'), 'none');
});

test('SIGNPATH_* 与本机凭证并存时决策仍为 certificate', (t) => {
  const result = runGate({ ...filled(SIGNPATH_NAMES), ...filled(WINDOWS_CERT_NAMES) }, t);

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.equal(envValue(result.githubEnv, 'SPECSEAL_WINDOWS_SIGNING'), 'certificate');
});

test('仅本机凭证两项齐备时 Windows 决策为 certificate', (t) => {
  const result = runGate(filled(WINDOWS_CERT_NAMES), t);

  assert.equal(result.status, 0, `两项齐备应成功结束\nstderr: ${result.stderr}`);
  assert.equal(envValue(result.githubEnv, 'SPECSEAL_WINDOWS_SIGNING'), 'certificate');
});

// --- 缺一：fail-closed 并点名缺项 ---

test('macOS 凭证半组齐而公证半组缺一项时非零结束并点名该项', (t) => {
  const overrides = filled(MACOS_NAMES);
  delete overrides.APPLE_TEAM_ID;

  const result = runGate(overrides, t);

  assert.notEqual(result.status, 0, 'macOS 签章组部分存在时应非零结束');
  assert.match(result.stderr, /APPLE_TEAM_ID/, '错误消息应点名缺少的 APPLE_TEAM_ID');
});

test('macOS 只设公证半组时非零结束并列出凭证半组三项缺项', (t) => {
  const result = runGate(
    filled(['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']),
    t,
  );

  assert.notEqual(result.status, 0, 'macOS 签章组部分存在时应非零结束');
  for (const name of ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY']) {
    assert.match(result.stderr, new RegExp(name), `错误消息应点名缺少的 ${name}`);
  }
});

test('本机凭证只设凭证而缺密码时非零结束并点名密码', (t) => {
  const result = runGate(filled(['WINDOWS_CERTIFICATE']), t);

  assert.notEqual(result.status, 0, 'Windows 凭证组部分存在时应非零结束');
  assert.match(
    result.stderr,
    /WINDOWS_CERTIFICATE_PASSWORD/,
    '错误消息应点名缺少的 WINDOWS_CERTIFICATE_PASSWORD',
  );
});

test('只填空白字符视为未设置，与全无同义', (t) => {
  const result = runGate({ APPLE_CERTIFICATE: '   ' }, t);

  assert.equal(result.status, 0, '空白值应视为未设置而非部分存在');
  assert.equal(envValue(result.githubEnv, 'SPECSEAL_MACOS_SIGNING'), 'none');
});

// --- fail-closed 的两个附带保证 ---

test('缺项失败时不写入任何决策，避免下游沿用半套设置', (t) => {
  const overrides = filled(MACOS_NAMES);
  delete overrides.APPLE_TEAM_ID;

  const result = runGate(overrides, t);

  assert.notEqual(result.status, 0);
  assert.equal(
    envValue(result.githubEnv, 'SPECSEAL_MACOS_SIGNING'),
    undefined,
    '失败时不得写出 macOS 决策',
  );
  assert.equal(
    envValue(result.githubEnv, 'SPECSEAL_WINDOWS_SIGNING'),
    undefined,
    '失败时不得写出 Windows 决策',
  );
});

test('输出只含 secret 名称，任何路径都不得带出 secret 值', (t) => {
  const overrides = filled(MACOS_NAMES);
  delete overrides.APPLE_TEAM_ID;

  const result = runGate(overrides, t);

  assert.doesNotMatch(result.stderr, new RegExp(SECRET_VALUE), 'stderr 泄漏了 secret 值');
  assert.doesNotMatch(result.stdout, new RegExp(SECRET_VALUE), 'stdout 泄漏了 secret 值');
  assert.doesNotMatch(result.githubEnv ?? '', new RegExp(SECRET_VALUE), 'GITHUB_ENV 泄漏了 secret 值');
});

// --- release.yml 接线的静态契约 ---
//
// 闸门本身绿灯不代表 workflow 有用它。以下断言守住接线：闸门排在昂贵的桌面建置
// 之前、签章步骤改以闸门决策为条件、公证三项确实注入建置环境。

test('release.yml 的 desktop job 在 Tauri 建置前运行签章闸门', () => {
  const release = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');

  const gate = requireIndex(release, 'node scripts/release/signing-gate.mjs', 'release.yml');
  const build = requireIndex(release, 'tauri -- build', 'release.yml');
  assert.ok(gate < build, 'release.yml：签章闸门必须排在 Tauri 建置之前');
});

test('release.yml 的签章步骤以闸门决策为条件，不再自行推导 secrets 是否存在', () => {
  const release = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');

  assert.match(
    release,
    /env\.SPECSEAL_MACOS_SIGNING == 'full'/,
    'release.yml：macOS 签章步骤应以闸门的 SPECSEAL_MACOS_SIGNING 决策为条件',
  );
  assert.match(
    release,
    /env\.SPECSEAL_WINDOWS_SIGNING == 'certificate'/,
    'release.yml：Windows 凭证签章步骤应以闸门的 SPECSEAL_WINDOWS_SIGNING 决策为条件',
  );
  assert.doesNotMatch(
    release,
    /HAS_APPLE_CERT|HAS_WINDOWS_CERT/,
    'release.yml：旧的 secrets 存在旗标应由闸门决策取代，避免两处各自推导',
  );
});

test('release.yml 在 macOS 签章激活时注入公证三项，供 Tauri 完成公证与 staple', () => {
  const release = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');

  for (const name of ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']) {
    assert.match(
      release,
      new RegExp(`${name}=\\$\\{\\{ secrets\\.${name} \\}\\}`),
      `release.yml：缺少公证所需的 ${name} 注入`,
    );
  }
});

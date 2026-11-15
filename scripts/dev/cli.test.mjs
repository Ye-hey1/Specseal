// scripts/dev/cli.mjs 的 node --test 测试（规格「checkout 内 CLI 测试入口」）。
// 注入假的 runSync／platform／env 观察进程边界：binary path、argv、stdio、
// environment、cwd 与 exit code 转送；不运行真实 CLI。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkoutCliPath, runCheckoutCli } from '../dev/cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/// 记录每次 runSync 的调用，并依序回传 syncResults（不足时视为 exit code 0）。
function trackedRunSync(syncResults = []) {
  const calls = [];
  let count = 0;
  return {
    calls,
    runSync: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return syncResults[count++] ?? { status: 0 };
    },
  };
}

/// 没有 stdout 断言需求时的缺省调用参数：不落地任何真实环境值。
/// exists 缺省 true——binary 存在路径；自动建置测试自行注入 false。
function baseDeps(overrides = {}) {
  return {
    args: [],
    env: { PATH: '/usr/local/bin' },
    platform: 'linux',
    fallbackCwd: '/repo/specseal',
    exists: () => true,
    logError: () => {},
    ...overrides,
  };
}

// --- binary 解析（design 决策「以 checkout 内 binary 提供 CLI wrapper」） ---

test('checkoutCliPath：非 win32 解析到 checkout 的 target/debug/specseal', () => {
  assert.equal(checkoutCliPath('darwin'), path.join(ROOT, 'target', 'debug', 'specseal'));
  assert.equal(checkoutCliPath('linux'), path.join(ROOT, 'target', 'debug', 'specseal'));
});

test('checkoutCliPath：win32 解析到 target/debug/specseal.exe', () => {
  assert.equal(checkoutCliPath('win32'), path.join(ROOT, 'target', 'debug', 'specseal.exe'));
});

test('PATH 中另有 specseal 时仍只运行 checkout binary', () => {
  const { calls, runSync } = trackedRunSync();
  runCheckoutCli(baseDeps({
    args: ['status'],
    env: { PATH: '/opt/old-specseal/bin:/usr/local/bin' },
    runSync,
  }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, path.join(ROOT, 'target', 'debug', 'specseal'));
  assert.equal(path.isAbsolute(calls[0].cmd), true, '必须是绝对路径，不得由 PATH 解析');
});

// --- 进程契约转送 ---

test('argv 原序转送、stdio 全 inherit，且不经 shell', () => {
  const { calls, runSync } = trackedRunSync();
  runCheckoutCli(baseDeps({ args: ['list', '--json', '--no-color'], runSync }));

  assert.deepEqual(calls[0].args, ['list', '--json', '--no-color']);
  assert.equal(calls[0].options.stdio, 'inherit');
  // shell 会让 <args> 被再解析一次（引号、$、&），必须关闭。
  assert.notEqual(calls[0].options.shell, true);
});

test('environment 原样继承', () => {
  const env = { PATH: '/usr/local/bin', SPECSEAL_TOKEN: 'x', LANG: 'zh_TW.UTF-8' };
  const { calls, runSync } = trackedRunSync();
  runCheckoutCli(baseDeps({ env, runSync }));

  assert.deepEqual(calls[0].options.env, env);
});

test('child cwd 优先采用 npm 的 INIT_CWD', () => {
  const { calls, runSync } = trackedRunSync();
  runCheckoutCli(baseDeps({
    args: ['list'],
    env: { PATH: '/usr/local/bin', INIT_CWD: '/tmp/remote-client' },
    fallbackCwd: '/repo/specseal',
    runSync,
  }));

  assert.equal(calls[0].options.cwd, '/tmp/remote-client');
  // binary 仍来自 checkout，不随调用端 cwd 移动。
  assert.equal(calls[0].cmd, path.join(ROOT, 'target', 'debug', 'specseal'));
});

test('INIT_CWD 缺席时退回 wrapper 的 process.cwd()', () => {
  const { calls, runSync } = trackedRunSync();
  runCheckoutCli(baseDeps({ fallbackCwd: '/repo/specseal', runSync }));

  assert.equal(calls[0].options.cwd, '/repo/specseal');
});

test('INIT_CWD 为空字符串时视同未提供，同样退回 process.cwd()', () => {
  const { calls, runSync } = trackedRunSync();
  runCheckoutCli(baseDeps({
    env: { PATH: '/usr/local/bin', INIT_CWD: '' },
    fallbackCwd: '/repo/specseal',
    runSync,
  }));

  // 空的 cwd 会让 spawn 以 ENOENT 失败，错误看起来像 binary 不存在。
  assert.equal(calls[0].options.cwd, '/repo/specseal');
});

// --- exit code 与失败转送 ---

test('CLI 成功结束时回传 0，且 wrapper 不增加任何 stdout', () => {
  const { runSync } = trackedRunSync([{ status: 0 }]);
  const written = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };

  let code;
  try {
    code = runCheckoutCli(baseDeps({ args: ['--version'], runSync }));
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.equal(code, 0);
  assert.deepEqual(written, [], 'machine-readable 输出不得被 wrapper 污染');
});

test('CLI 以非零状态结束时回传相同状态', () => {
  const { runSync } = trackedRunSync([{ status: 3 }]);
  assert.equal(runCheckoutCli(baseDeps({ args: ['validate', 'nope'], runSync })), 3);
});

test('checkout binary 无法运行时以非零状态结束，且不改用 PATH 的 specseal', () => {
  const { calls, runSync } = trackedRunSync([
    { status: null, error: new Error('spawn ENOENT') },
  ]);
  const errors = [];

  const code = runCheckoutCli(baseDeps({
    args: ['status'],
    env: { PATH: '/opt/old-specseal/bin' },
    runSync,
    logError: (message) => errors.push(message),
  }));

  assert.notEqual(code, 0);
  assert.equal(calls.length, 1, '失败后不得再尝试第二个 binary');
  assert.equal(calls[0].cmd, path.join(ROOT, 'target', 'debug', 'specseal'));
  const stderr = errors.join('\n');
  assert.match(stderr, /target[/\\]debug[/\\]specseal/);
  // 自动建置落地后，走到这里代表 binary 刚确认存在却无法运行——提示应指向
  // cwd／运行权限，而不是已过期的「先建置」指引。
  assert.match(stderr, /运行权限/);
  // spawn 的 ENOENT 可能来自 binary 也可能来自 cwd——两者都要点名才不会误导。
  assert.match(stderr, /\/repo\/specseal/);
});

// --- 自动建置（规格「checkout binary 不存在时自动建置且禁止 fallback」） ---

test('binary 不存在：先于 checkout root 建置 specseal-cli，再运行 debug binary', () => {
  const { calls, runSync } = trackedRunSync();
  const code = runCheckoutCli(baseDeps({
    args: ['status'],
    env: { PATH: '/opt/old-specseal/bin' },
    exists: () => false,
    runSync,
  }));

  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].cmd, 'cargo');
  assert.deepEqual(calls[0].args, ['build', '-p', 'specseal-cli']);
  assert.equal(calls[0].options.cwd, ROOT, '自动建置固定于 checkout root，不受调用端 cwd 影响');
  assert.equal(calls[1].cmd, path.join(ROOT, 'target', 'debug', 'specseal'));
  assert.deepEqual(calls[1].args, ['status'], 'args 原序传入建置出的 binary');
  for (const call of calls) {
    assert.notEqual(call.cmd, 'specseal', '绝不运行 PATH 中的 specseal');
  }
});

test('存在性检查针对 checkout binary 路径本身', () => {
  const seen = [];
  const { runSync } = trackedRunSync();
  runCheckoutCli(baseDeps({
    exists: (p) => {
      seen.push(p);
      return true;
    },
    runSync,
  }));

  assert.deepEqual(seen, [path.join(ROOT, 'target', 'debug', 'specseal')]);
});

test('自动建置的进度输出不写入 stdout（build 的 stdout 导向 stderr）', () => {
  const { calls, runSync } = trackedRunSync();
  runCheckoutCli(baseDeps({ exists: () => false, runSync }));

  assert.deepEqual(calls[0].options.stdio, ['inherit', 2, 'inherit']);
});

test('自动建置失败：stderr 显示原因、以建置状态收场、不运行任何 CLI', () => {
  const { calls, runSync } = trackedRunSync([{ status: 101 }]);
  const errors = [];
  const code = runCheckoutCli(baseDeps({
    args: ['status'],
    env: { PATH: '/opt/old-specseal/bin' },
    exists: () => false,
    runSync,
    logError: (message) => errors.push(message),
  }));

  assert.equal(code, 101);
  assert.equal(calls.length, 1, '建置失败后不得运行任何 CLI，也不得 fallback 到 PATH');
  assert.match(errors.join('\n'), /specseal-cli/);
});

test('自动建置无法启动（cargo 缺席）：非零收场且不运行任何 CLI', () => {
  const { calls, runSync } = trackedRunSync([
    { status: null, error: new Error('spawn cargo ENOENT') },
  ]);
  const errors = [];
  const code = runCheckoutCli(baseDeps({
    exists: () => false,
    runSync,
    logError: (message) => errors.push(message),
  }));

  assert.notEqual(code, 0);
  assert.equal(calls.length, 1);
  assert.match(errors.join('\n'), /spawn cargo ENOENT/);
});

test('binary 已存在：不触发建置，直接运行', () => {
  const { calls, runSync } = trackedRunSync();
  runCheckoutCli(baseDeps({ args: ['--version'], runSync }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, path.join(ROOT, 'target', 'debug', 'specseal'));
});

test('CLI 被 signal 收束时不当成成功', () => {
  const { runSync } = trackedRunSync([{ status: null, signal: 'SIGTERM' }]);
  const errors = [];

  const code = runCheckoutCli(baseDeps({
    args: ['auth', 'login'],
    runSync,
    logError: (message) => errors.push(message),
  }));

  assert.notEqual(code, 0);
  assert.match(errors.join('\n'), /SIGTERM/);
});

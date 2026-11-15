// scripts/dev/dev.mjs 纯函数层的 node --test 测试（规格「env 到设置的生成逻辑可测」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDotenv, buildDevConfig, parseDevMode, startDevEnvironment } from './dev.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEV_SCRIPT = path.resolve(SCRIPTS_DIR, 'dev.mjs');
const ROOT = path.resolve(SCRIPTS_DIR, '../..');

// --- .env 解析（design 决策 3：逐行 KEY=VALUE、跳过注解与空行、不支持展开） ---

test('parseDotenv：解析 KEY=VALUE、跳过注解与空行', () => {
  const parsed = parseDotenv(
    '# 注解行\n\nSPECSEAL_STORE_DRIVER=sqlite\n  \nSPECSEAL_PORT=8080\n',
  );
  assert.deepEqual(parsed, {
    SPECSEAL_STORE_DRIVER: 'sqlite',
    SPECSEAL_PORT: '8080',
  });
});

test('parseDotenv：值保留第一个 = 之后的全部内容，且不做变量展开', () => {
  const parsed = parseDotenv(
    'SPECSEAL_POSTGRES_URL=postgres://u@h:5432/db?sslmode=require\nSPECSEAL_STORE_PATH=$HOME/store.db\n',
  );
  assert.deepEqual(parsed, {
    SPECSEAL_POSTGRES_URL: 'postgres://u@h:5432/db?sslmode=require',
    SPECSEAL_STORE_PATH: '$HOME/store.db',
  });
});

// --- env → {configYaml, addr} 生成（design 决策 2 的映射表） ---

test('sqlite 全缺省：store/identity 落 .dev、public_url 缺省端口、addr 127.0.0.1:8080', () => {
  const { configYaml, addr } = buildDevConfig({}, {});
  assert.equal(addr, '127.0.0.1:8080');
  assert.match(configYaml, /^# 本档由 npm run dev 生成/);
  assert.ok(
    configYaml.includes(
      'store:\n  driver: sqlite\n  path: .dev/store.db\nidentity:\n  driver: sqlite\n  path: .dev/identity.db\npublic_url: http://localhost:8080\n',
    ),
    `sqlite 全缺省形状不符：\n${configYaml}`,
  );
});

test('serverfs：缺省 path 为 .dev/store', () => {
  const { configYaml } = buildDevConfig({}, { SPECSEAL_STORE_DRIVER: 'serverfs' });
  assert.ok(
    configYaml.includes('store:\n  driver: serverfs\n  path: .dev/store\nidentity:'),
    `serverfs 形状不符：\n${configYaml}`,
  );
});

test('postgres：store.url 取自 SPECSEAL_POSTGRES_URL、无 path', () => {
  const url = 'postgres://specseal@localhost:5432/specseal';
  const { configYaml } = buildDevConfig(
    {},
    { SPECSEAL_STORE_DRIVER: 'postgres', SPECSEAL_POSTGRES_URL: url },
  );
  assert.ok(
    configYaml.includes(`store:\n  driver: postgres\n  url: ${url}\nidentity:`),
    `postgres 形状不符：\n${configYaml}`,
  );
});

test('memory：store 段无 path 也无 url', () => {
  const { configYaml } = buildDevConfig({}, { SPECSEAL_STORE_DRIVER: 'memory' });
  assert.ok(
    configYaml.includes('store:\n  driver: memory\nidentity:'),
    `memory 形状不符：\n${configYaml}`,
  );
});

test('process env 盖过 .env 档值', () => {
  const { configYaml } = buildDevConfig(
    { SPECSEAL_STORE_DRIVER: 'sqlite' },
    { SPECSEAL_STORE_DRIVER: 'memory' },
  );
  assert.ok(configYaml.includes('store:\n  driver: memory\n'));
});

test('SPECSEAL_PORT 连动 addr 与缺省 public_url（design 决策 2）', () => {
  const { configYaml, addr } = buildDevConfig({}, { SPECSEAL_PORT: '3000' });
  assert.equal(addr, '127.0.0.1:3000');
  assert.ok(configYaml.includes('public_url: http://localhost:3000\n'));
});

test('postgres 缺 SPECSEAL_POSTGRES_URL：错误点名该键、不生成', () => {
  assert.throws(
    () => buildDevConfig({}, { SPECSEAL_STORE_DRIVER: 'postgres' }),
    /SPECSEAL_POSTGRES_URL/,
  );
});

test('未知 driver（mysql）：错误点名 SPECSEAL_STORE_DRIVER 并列出四个合法值', () => {
  assert.throws(
    () => buildDevConfig({}, { SPECSEAL_STORE_DRIVER: 'mysql' }),
    (err) => {
      assert.match(err.message, /SPECSEAL_STORE_DRIVER/);
      for (const valid of ['sqlite', 'serverfs', 'postgres', 'memory']) {
        assert.match(err.message, new RegExp(valid));
      }
      return true;
    },
  );
});

// --- 启动编排（design 决策「先建置 CLI 再启动长时间进程」） ---
// 注入假的 runSync／spawnChild 观察进程边界：命令顺序、argv、stdio、shell 与
// 失败时的长时间 child 数；不启动真实 cargo、server 或 desktop。

/// 依序回传 syncResults 当作各 prerequisite 的结果（不足时视为成功），
/// 并把每次 prerequisite 与 child spawn 记进同一份 calls 以保留调用顺序。
function trackedDeps(syncResults = []) {
  const calls = [];
  const errors = [];
  let syncCount = 0;
  return {
    calls,
    errors,
    deps: {
      addr: '127.0.0.1:8080',
      runSync: (cmd, args, options) => {
        calls.push({ kind: 'sync', cmd, args, options });
        return syncResults[syncCount++] ?? { status: 0 };
      },
      spawnChild: (cmd, args) => {
        calls.push({ kind: 'spawn', cmd, args });
        return { cmd, args };
      },
      log: () => {},
      logError: (message) => errors.push(message),
    },
  };
}

function spawnCount(calls) {
  return calls.filter((call) => call.kind === 'spawn').length;
}

test('startDevEnvironment：CLI build 成功后直接 spawn 长时间 child，不另建前端', () => {
  const { calls, deps } = trackedDeps();
  const result = startDevEnvironment(deps);

  assert.deepEqual(
    calls.map((call) => [call.kind, call.cmd, ...call.args]),
    [
      ['sync', 'cargo', 'build', '-p', 'specseal-cli'],
      [
        'spawn', 'cargo',
        'run', '-p', 'specseal-server', '--',
        '--config', '.dev/config.yaml', '--addr', '127.0.0.1:8080',
      ],
      ['spawn', 'npm', 'run', 'tauri', '-w', 'apps/desktop', '--', 'dev'],
    ],
  );
  assert.equal(result.status, null);
  // 长时间 child 仍只有 server 与 desktop 两个——CLI 不进 lifecycle。
  assert.equal(result.children.length, 2);
});

test('startDevEnvironment：prerequisite 输出直通终端', () => {
  const { calls, deps } = trackedDeps();
  startDevEnvironment(deps);

  for (const call of calls.filter((entry) => entry.kind === 'sync')) {
    assert.equal(call.options.stdio, 'inherit');
  }
});

test('startDevEnvironment：CLI build 非零状态即中止，不建前端也不 spawn 长时间 child', () => {
  const { calls, deps } = trackedDeps([{ status: 101 }]);
  const result = startDevEnvironment(deps);

  assert.equal(result.status, 101);
  assert.deepEqual(result.children, []);
  assert.equal(spawnCount(calls), 0);
  assert.deepEqual(calls.map((call) => call.cmd), ['cargo']);
});

test('startDevEnvironment：CLI build 无法启动时以 1 退出并点名 specseal-cli', () => {
  const { calls, errors, deps } = trackedDeps([
    { status: null, error: new Error('spawn cargo ENOENT') },
  ]);
  const result = startDevEnvironment(deps);

  assert.equal(result.status, 1);
  assert.deepEqual(result.children, []);
  assert.equal(spawnCount(calls), 0);
  assert.match(errors.join('\n'), /specseal-cli/);
});

test('startDevEnvironment：prerequisite 只有 cargo，不走 shell', () => {
  const { calls, deps } = trackedDeps();
  startDevEnvironment(deps);

  const syncCalls = calls.filter((call) => call.kind === 'sync');
  assert.equal(syncCalls.length, 1, 'full 模式的 prerequisite 只剩 CLI build');
  assert.equal(syncCalls[0].options.shell, false, 'cargo 是真 binary，不需要 shell');
});

// --- 模式分流（规格「单独启动 server」「单独启动 desktop」） ---

test('parseDevMode：--server → server、--desktop → desktop、无旗标 → full', () => {
  assert.equal(parseDevMode(['node', 'scripts/dev/dev.mjs', '--server']), 'server');
  assert.equal(parseDevMode(['node', 'scripts/dev/dev.mjs', '--desktop']), 'desktop');
  assert.equal(parseDevMode(['node', 'scripts/dev/dev.mjs']), 'full');
});

test('server 模式：不建 CLI、不建前端，只 spawn server', () => {
  const { calls, deps } = trackedDeps();
  const result = startDevEnvironment({ ...deps, mode: 'server' });

  assert.deepEqual(
    calls.map((call) => [call.kind, call.cmd, ...call.args]),
    [
      [
        'spawn', 'cargo',
        'run', '-p', 'specseal-server', '--',
        '--config', '.dev/config.yaml', '--addr', '127.0.0.1:8080',
      ],
    ],
  );
  assert.equal(result.status, null);
  assert.equal(result.children.length, 1);
});

test('desktop 模式：无任何 prerequisite，只 spawn tauri dev，不建 CLI 也不含 server', () => {
  const { calls, deps } = trackedDeps();
  const result = startDevEnvironment({ ...deps, mode: 'desktop' });

  // 前端由 tauri dev 的 beforeDevCommand 起 vite dev server 供应，编排层不再预先建置。
  assert.deepEqual(
    calls.map((call) => [call.kind, call.cmd, ...call.args]),
    [['spawn', 'npm', 'run', 'tauri', '-w', 'apps/desktop', '--', 'dev']],
  );
  assert.equal(result.status, null);
  assert.equal(result.children.length, 1);
});

// --- dev server 设置一致性（规格「dev 模式前端由 dev server 供应且变更免重编」） ---
// tauri.conf.json 的 devUrl 是写死字符串，vite 的 server.port 决定实际监听端口——两份设置
// 各改一边时 dev 窗口只会加载失败，没有任何错误指向真正的原因。此测试把两者钉在一起。

/// vite.config.ts 是 TypeScript，无法 import；以 server 区块为界抓设置值。
function viteServerBlock() {
  const source = readFileSync(path.join(ROOT, 'apps/desktop/vite.config.ts'), 'utf8');
  return source.match(/server:\s*\{[\s\S]*?\}/)?.[0] ?? '';
}

function tauriBuildConfig() {
  const source = readFileSync(
    path.join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'),
    'utf8',
  );
  return JSON.parse(source).build ?? {};
}

test('tauri devUrl 的端口号与 vite server.port 相同', () => {
  const { devUrl } = tauriBuildConfig();
  assert.ok(
    devUrl,
    'tauri.conf.json 缺少 build.devUrl——没有它 tauri dev 会加载编译期嵌入的静态 dist，前端改动不重编 Rust 就进不了窗口',
  );

  const vitePort = viteServerBlock().match(/port:\s*(\d+)/)?.[1];
  assert.ok(vitePort, 'apps/desktop/vite.config.ts 的 server 区块未固定 port');
  assert.equal(
    new URL(devUrl).port,
    vitePort,
    `devUrl（${devUrl}）与 vite server.port（${vitePort}）不一致，dev 窗口会加载失败`,
  );
});

test('devUrl 指向本机 loopback：dev 窗口不得加载外部来源', () => {
  const { devUrl } = tauriBuildConfig();
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(devUrl).hostname),
    `devUrl（${devUrl}）指向非本机地址——dev 窗口会加载远程内容并以 webview 的权限运行`,
  );
});

test('vite dev server 激活 strictPort：端口被占用时明确失败而非静默改端口', () => {
  assert.match(
    viteServerBlock(),
    /strictPort:\s*true/,
    'strictPort 未激活——vite 会在端口被占用时自动换端口，devUrl 随即指向错误地址，窗口开出空白页而无错误消息',
  );
});

test('tauri.conf.json 设置 beforeDevCommand 以启动 vite dev server', () => {
  const { beforeDevCommand } = tauriBuildConfig();
  assert.ok(
    beforeDevCommand,
    'tauri.conf.json 缺少 build.beforeDevCommand——devUrl 指向的 dev server 不会有人启动',
  );
  // Tauri 于 apps/desktop（tauri.conf.json 所属的 npm 项目）运行此指令，不是 repo root：
  // 带 -w／--workspace 会以「No workspaces found」收场，且只有实际启动才看得出来。
  assert.doesNotMatch(
    beforeDevCommand,
    /\s(-w|--workspace)[\s=]/,
    `beforeDevCommand（${beforeDevCommand}）带了 workspace 旗标——其 cwd 已是 apps/desktop，该旗标会让 npm 找不到 workspace 而中止启动`,
  );
});

test('tauri.conf.json 保留 frontendDist：release 与 bundle 仍读静态产物', () => {
  const { frontendDist } = tauriBuildConfig();
  assert.equal(frontendDist, '../dist', 'frontendDist 遭改动会影响 release bundle 的前端来源');
});

// --- sidecar 布署挂载点（规格「dev 启动自动布署当前 checkout 的 sidecar」，决策一） ---
// predev 是三个 dev 入口的共同前置：tauri dev 的 beforeDevCommand 是于 apps/desktop
// 运行的 npm run dev，npm 对 dev 会自动先跑 predev。这个 hook 被删掉只会表现为
// 「全新 checkout 编译失败」或「dev 用着过期 sidecar」，没有消息指向真正的原因。

function desktopScripts() {
  const source = readFileSync(path.join(ROOT, 'apps/desktop/package.json'), 'utf8');
  return JSON.parse(source).scripts ?? {};
}

test('apps/desktop 有 predev script 布署 sidecar：dev 启动前必经此步', () => {
  const { predev } = desktopScripts();
  assert.ok(
    predev,
    'apps/desktop/package.json 缺少 predev——没有它，全新 checkout 会因缺 binaries/specseal-<triple> 编译失败，既有 checkout 则以过期 sidecar 盖掉 target/debug/specseal',
  );
  assert.match(
    predev,
    /desktop-sidecar\.mjs/,
    `predev（${predev}）未调用 desktop-sidecar.mjs——sidecar 布署已不在 dev 启动路径上`,
  );
});

test('predev 布 debug profile：与 npm run cli 验证所用同一颗 CLI', () => {
  const { predev } = desktopScripts();
  assert.match(
    predev,
    /--profile\s+debug/,
    `predev（${predev}）未带 --profile debug——退回缺省 release 后，dev 布的 sidecar 与 target/debug/specseal 内容不同，tauri-build 会拿 release 盖掉 npm run cli 用的 debug CLI`,
  );
});

// --- 两模式沿用既有设置验证（规格「设置不合法即拒绝启动」） ---
// 黑箱子进程测试：验证失败发生在任何 build／spawn 之前，子进程立即以 1 收场。

for (const flag of ['--server', '--desktop']) {
  test(`dev.mjs ${flag}：postgres 缺 URL 时非零拒绝启动，错误同 npm run dev`, () => {
    const result = spawnSync(process.execPath, [DEV_SCRIPT, flag], {
      env: {
        ...process.env,
        SPECSEAL_STORE_DRIVER: 'postgres',
        SPECSEAL_POSTGRES_URL: '',
      },
      encoding: 'utf8',
      timeout: 15_000,
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /SPECSEAL_POSTGRES_URL/);
  });
}

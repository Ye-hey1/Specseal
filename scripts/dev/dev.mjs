#!/usr/bin/env node
// 一键 remote 开发编排：读 repo root 的 .env（若存在）与 process env 合并，
// 插值生成 .dev/config.yaml 后同起 specseal-server 与 desktop 的 tauri dev。
// --server／--desktop 只起单边（dev:server、dev:desktop），设置验证三模式共用。
// server 的组态 YAML 不做环境变量展开——插值只发生在这一层（同 deploy compose 的决策）。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VALID_DRIVERS = ['sqlite', 'serverfs', 'postgres', 'memory'];

/// .env 逐行解析：KEY=VALUE、跳过注解与空行；不支持多行值与变量展开。
export function parseDotenv(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

/// env → { configYaml, addr }。processEnv 盖过 fileEnv（dotenv 惯例）。
/// 设置不合法（未知 driver、postgres 缺 URL）时直接 throw——启动前 fail-closed。
export function buildDevConfig(fileEnv, processEnv) {
  const env = { ...fileEnv };
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined) env[key] = value;
  }

  const driver = env.SPECSEAL_STORE_DRIVER ?? 'sqlite';
  const port = env.SPECSEAL_PORT ?? '8080';
  const publicUrl = env.SPECSEAL_PUBLIC_URL ?? `http://localhost:${port}`;
  const identityPath = env.SPECSEAL_IDENTITY_PATH ?? '.dev/identity.db';

  let storeSection;
  switch (driver) {
    case 'sqlite':
      storeSection = `  driver: sqlite\n  path: ${env.SPECSEAL_STORE_PATH ?? '.dev/store.db'}`;
      break;
    case 'serverfs':
      storeSection = `  driver: serverfs\n  path: ${env.SPECSEAL_STORE_PATH ?? '.dev/store'}`;
      break;
    case 'postgres': {
      const url = env.SPECSEAL_POSTGRES_URL;
      if (!url) {
        throw new Error(
          'SPECSEAL_STORE_DRIVER=postgres 需要设置 SPECSEAL_POSTGRES_URL（连接 URL 可不含密码，由 SPECSEAL_POSTGRES_PASSWORD 补全）',
        );
      }
      storeSection = `  driver: postgres\n  url: ${url}`;
      break;
    }
    case 'memory':
      storeSection = '  driver: memory';
      break;
    default:
      throw new Error(
        `SPECSEAL_STORE_DRIVER=${driver} 不是合法的 store driver（合法值：${VALID_DRIVERS.join('、')}）`,
      );
  }

  const configYaml = `# 本档由 npm run dev 生成（scripts/dev/dev.mjs），每次启动整档重写——手改无效。
# 调整设置请编辑 repo root 的 .env（对照 .env.example）。
store:
${storeSection}
identity:
  driver: sqlite
  path: ${identityPath}
public_url: ${publicUrl}
`;

  return { configYaml, addr: `127.0.0.1:${port}` };
}

// --- 编排主流程 ---

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IS_WINDOWS = process.platform === 'win32';

/// detached：child 自成 process group，收束时整组终止——cargo/npm 的孙 process
///（server binary、vite、tauri）不残留。代价是终端 Ctrl+C 不会直达 child，
/// 由 main() 的 SIGINT/SIGTERM handler 转送。
function spawnDevChild(cmd, args) {
  return spawn(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: IS_WINDOWS && cmd === 'npm',
    detached: !IS_WINDOWS,
  });
}

/// argv → 启动模式。--server／--desktop 对应 package.json 的 dev:server 与
/// dev:desktop，无旗标即整套编排（npm run dev 行为不变）。
export function parseDevMode(argv) {
  if (argv.includes('--server')) return 'server';
  if (argv.includes('--desktop')) return 'desktop';
  return 'full';
}

/// 长时间进程启动前的同步前置条件：只有目前 checkout 的 CLI——测试者用
/// npm run cli 验证的就是这颗 binary。server 与 desktop 单独模式皆不含前置
/// 条件（规格「单独启动 server」「单独启动 desktop」）。
///
/// 此处不建 Desktop 前端：前端由 tauri dev 依 tauri.conf.json 的
/// beforeDevCommand 起 vite dev server 供应（devUrl）。在此预先建置只是白费一趟
/// ——dev 窗口加载的是 dev server，不是 apps/desktop/dist。
function devPrerequisites(mode) {
  if (mode !== 'full') return [];
  return [
    {
      message: 'specseal dev: 建置当前 checkout 的 specseal-cli…',
      failure: 'specseal dev: 无法建置当前 checkout 的 specseal-cli',
      cmd: 'cargo',
      args: ['build', '-p', 'specseal-cli'],
      // cargo 是真 binary，不需要 shell。
      shell: false,
    },
  ];
}

/// prerequisite → 长时间 child 的启动编排。任一 prerequisite 以非零状态结束或
/// 无法启动时回传其状态（无可用状态时为 1）且 children 为空——不留「环境看似
/// 成功、CLI 尚不可用」的半完成状态。全部成功时 status 为 null。
export function startDevEnvironment({
  addr,
  mode = 'full',
  runSync = spawnSync,
  spawnChild = spawnDevChild,
  log = console.log,
  logError = console.error,
}) {
  for (const step of devPrerequisites(mode)) {
    log(step.message);
    const result = runSync(step.cmd, step.args, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: step.shell,
    });
    if (result.error || result.status !== 0) {
      // spawn 失败时 stdio: 'inherit' 不会留下任何线索，必须自己点名。
      if (result.error) logError(`${step.failure}：${result.error.message}`);
      return { status: result.status ?? 1, children: [] };
    }
  }

  const children = [];
  if (mode !== 'desktop') {
    children.push(
      spawnChild('cargo', [
        'run', '-p', 'specseal-server', '--',
        '--config', '.dev/config.yaml', '--addr', addr,
      ]),
    );
  }
  if (mode !== 'server') {
    children.push(spawnChild('npm', ['run', 'tauri', '-w', 'apps/desktop', '--', 'dev']));
  }
  return { status: null, children };
}

function main() {
  const devDir = path.join(ROOT, '.dev');

  // --reset：只删 .dev/（不碰 .env 与 deploy/），对不存在的目录幂等成功。
  // postgres 的数据在外部数据库，不在 reset 范围（见 .env.example）。
  if (process.argv.includes('--reset')) {
    rmSync(devDir, { recursive: true, force: true });
    console.log('specseal dev: .dev/ 已清空，下次 npm run dev 回到全新 /setup。');
    return;
  }

  const envPath = path.join(ROOT, '.env');
  const fileEnv = existsSync(envPath) ? parseDotenv(readFileSync(envPath, 'utf8')) : {};
  const mode = parseDevMode(process.argv);

  // 设置验证三模式共用——坏掉的 .env 在任何入口都应立即被点名，
  // 而不是等到唯一会用到它的入口才爆。
  let generated;
  try {
    generated = buildDevConfig(fileEnv, process.env);
  } catch (err) {
    console.error(`specseal dev: ${err.message}`);
    process.exit(1);
  }

  // desktop 单独模式没有 server 会读 config，不落地 .dev/。
  if (mode !== 'desktop') {
    mkdirSync(devDir, { recursive: true });
    writeFileSync(path.join(devDir, 'config.yaml'), generated.configYaml);
  }

  const started = startDevEnvironment({ addr: generated.addr, mode });
  if (started.status !== null) process.exit(started.status);
  const children = started.children;

  let closing = false;
  let exitCode = 0;
  let alive = children.length;

  const killTree = (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (IS_WINDOWS) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
    }
  };

  const beginShutdown = (code) => {
    if (!closing) {
      closing = true;
      exitCode = code;
    }
    for (const child of children) killTree(child);
  };

  for (const child of children) {
    child.on('exit', (code) => {
      alive -= 1;
      // 任一 child 先退出：终止另一个并以其 exit code 退出（避免半死状态）。
      if (!closing) beginShutdown(code ?? 1);
      if (alive === 0) process.exit(exitCode);
    });
  }

  process.on('SIGINT', () => beginShutdown(0));
  process.on('SIGTERM', () => beginShutdown(0));
}

// node --test 导入本模块时只取纯函数，不触发编排。
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}

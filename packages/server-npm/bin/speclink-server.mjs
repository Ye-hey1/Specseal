#!/usr/bin/env node
// specseal-server 的 npm launcher（server-release spec「npm 套件一行启动 server」；
// 设计 D9）。binary 只吃单一 YAML 且 fail closed；快速启动仿 compose 的插件法——
// 把环境变量插值成 YAML 落地数据目录，再带 --config spawn 对应平台子套件里的
// binary。带参数或 SPECSEAL_CONFIG 时纯透传，行为与直接运行 binary 一致。

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 快速启动只开放持久化 driver；memory 是测试组态，不在此列。
const QUICKSTART_DRIVERS = ['sqlite', 'serverfs', 'postgres'];

/** os/cpu → 平台子套件名尾码；无对应（未支持平台）回 null。 */
export function platformPackageSuffix(platform, arch) {
  const supported = {
    'darwin-arm64': true,
    'darwin-x64': true,
    'linux-x64': true,
    'linux-arm64': true,
    'win32-x64': true,
  };
  const key = `${platform}-${arch}`;
  return supported[key] ? `server-${key}` : null;
}

/** YAML 双引号 scalar：JSON 字符串是合法 YAML，URL 带冒号也安全。 */
const yamlString = (value) => JSON.stringify(String(value));

/** 环境变量 → 快速启动计划（组态 YAML、数据目录、绑定地址）；错误以 error 字段回报。 */
export function buildQuickstart(env) {
  const driver = env.SPECSEAL_STORE || 'sqlite';
  if (!QUICKSTART_DRIVERS.includes(driver)) {
    return {
      error: `SPECSEAL_STORE「${driver}」不支持；可用值：${QUICKSTART_DRIVERS.join('、')}`,
    };
  }
  const dataDir = path.resolve(env.SPECSEAL_DATA_DIR || './specseal-data');
  const port = env.SPECSEAL_PORT || '8080';
  const publicUrl = env.SPECSEAL_PUBLIC_URL || `http://localhost:${port}`;

  let storeBlock;
  if (driver === 'postgres') {
    const url = env.SPECSEAL_POSTGRES_URL;
    if (!url) {
      return {
        error:
          'SPECSEAL_STORE=postgres 需要 SPECSEAL_POSTGRES_URL（连接 URL；密码可另拆 SPECSEAL_POSTGRES_PASSWORD）',
      };
    }
    storeBlock = `store:\n  driver: ${yamlString('postgres')}\n  url: ${yamlString(url)}\n`;
  } else {
    const storePath =
      driver === 'sqlite' ? path.join(dataDir, 'store.db') : path.join(dataDir, 'store');
    storeBlock = `store:\n  driver: ${yamlString(driver)}\n  path: ${yamlString(storePath)}\n`;
  }

  const configYaml =
    `# 由 npm launcher 依环境变量产生（specseal-server 只吃单一 YAML；设计 D9）。\n` +
    storeBlock +
    `identity:\n  driver: ${yamlString('sqlite')}\n  path: ${yamlString(path.join(dataDir, 'identity.db'))}\n` +
    `public_url: ${yamlString(publicUrl)}\n`;

  return {
    dataDir,
    configPath: path.join(dataDir, 'config.yaml'),
    configYaml,
    addr: `127.0.0.1:${port}`,
  };
}

/** 参数与环境 → spawn 模式：零参数且无 SPECSEAL_CONFIG 走快速启动，其余透传。 */
export function decideSpawnArgs(args, env) {
  if (env.SPECSEAL_CONFIG && !args.includes('--config')) {
    return { mode: 'passthrough', args: ['--config', env.SPECSEAL_CONFIG, ...args] };
  }
  if (args.length === 0 && !env.SPECSEAL_CONFIG) {
    return { mode: 'quickstart' };
  }
  return { mode: 'passthrough', args };
}

function resolveBinary() {
  const suffix = platformPackageSuffix(process.platform, process.arch);
  if (!suffix) {
    throw new Error(
      `此平台（${process.platform}/${process.arch}）没有对应的 specseal-server 套件；` +
        `支持：macOS（arm64／x64）、Linux（x64／arm64）、Windows（x64）`,
    );
  }
  const require = createRequire(import.meta.url);
  const ownScope = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ).name.split('/')[0];
  const binaryName = process.platform === 'win32' ? 'specseal-server.exe' : 'specseal-server';
  try {
    const pkgJson = require.resolve(`${ownScope}/${suffix}/package.json`);
    return path.join(path.dirname(pkgJson), binaryName);
  } catch {
    throw new Error(
      `找不到平台子套件 ${ownScope}/${suffix}——npm 安装时的 optionalDependencies 可能被略过，` +
        `重新安装并确认未带 --no-optional`,
    );
  }
}

function main() {
  const args = process.argv.slice(2);
  let binary;
  try {
    binary = resolveBinary();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }

  const decision = decideSpawnArgs(args, process.env);
  let spawnArgs;
  if (decision.mode === 'quickstart') {
    const plan = buildQuickstart(process.env);
    if (plan.error) {
      process.stderr.write(`${plan.error}\n`);
      process.exit(1);
    }
    mkdirSync(plan.dataDir, { recursive: true });
    writeFileSync(plan.configPath, plan.configYaml);
    spawnArgs = ['--config', plan.configPath, '--addr', plan.addr];
  } else {
    spawnArgs = decision.args;
  }

  const child = spawn(binary, spawnArgs, { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('error', (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    process.exit(signal ? 1 : (code ?? 1));
  });
}

// 测试直接 import 本档取用上面的纯函数；只有作为运行入口时才 spawn。
// npm 的 bin shim 是 symlink：argv[1] 是 symlink 路径、import.meta.url 是 node
// 解析后的实体路径，必须先 realpath 再比对——比对原始 argv[1] 会让 npx 调用
// 静默不运行 main()。
const invokedAs = (() => {
  if (!process.argv[1]) return null;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return null;
  }
})();
if (invokedAs === import.meta.url) {
  main();
}

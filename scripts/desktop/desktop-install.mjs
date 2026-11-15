#!/usr/bin/env node
// 本机建置安装入口（desktop-release spec「本机安装的新鲜度断言」，决策 7）：
// 把 sidecar 布署 → 前端建置 → tauri bundle → 版号断言收成单一指令，以机械断言
// 取代「刚建的应该是新的」这种信任——2026-08-05 就是这份信任让 v1.11 的 app 装了
// 进来，横幅把 v1.14 的文件标成旧版、按下更新静默降级 30 档。
//
// 用法：node scripts/desktop/desktop-install.mjs [--install]
//   无旗标：建置并断言 bundle 内 CLI 的引擎版号等于源码版号
//   --install：续行覆盖安装 /Applications/Specseal.app 并再断言一次（仅 macOS）
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APP = '/Applications/Specseal.app';
const BUNDLE_APP = path.join(ROOT, 'target/release/bundle/macos/Specseal.app');
/// bundle 内的 sidecar CLI（Tauri externalBin 在 macOS 落到 Contents/MacOS/）。
const SIDECAR_IN_APP = 'Contents/MacOS/specseal';

/// 源码的产物层版号：specseal-core 的 ASSET_VERSION 常数是唯一真相。
export function sourceAssetVersion(initRs) {
  const version = initRs.match(/ASSET_VERSION:\s*&str\s*=\s*"([^"]+)"/)?.[1];
  if (!version) throw new Error('crates/engine/specseal-core/src/workspace/init.rs 读不到 ASSET_VERSION 常数');
  return version;
}

/// 从 `specseal --version` 的输出取引擎版号。旧 binary 不含 engine 段——那本身
/// 就是「这颗 CLI 比守门还旧」的证据，明确失败而非当成通过。
export function engineVersionOf(versionOutput) {
  const version = versionOutput.match(/engine (\S+?)\)?\s*$/m)?.[1];
  if (!version) {
    throw new Error(`--version 输出不含 engine 版号（过期的 binary？）：${versionOutput.trim()}`);
  }
  return version;
}

/// 版号断言：不等即带两边版号失败（差在哪一眼可见）。
export function assertSameEngineVersion(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label} 的引擎版号是 ${actual}，源码是 ${expected}——建置链沿用了过期 binary`);
  }
}

/// tauri build 签章需要的环境变量中缺了哪些（见 desktop-installer-and-updater：
/// 只认 TAURI_SIGNING_PRIVATE_KEY，_PATH 会在最后签章步骤才失败）。
export function missingSigningEnv(env) {
  return ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'].filter(
    (key) => !env[key],
  );
}

/// 进入任何建置之前的一次性把关：非 macOS 带 --install 不该先花十分钟建置才发现
/// 装不了；签章 env 缺失时 tauri 会在最后一步才失败，同样白等整趟。
export function preflight({ env, platform, install }) {
  if (install && platform !== 'darwin') {
    throw new Error(`--install 仅支持 macOS，目前平台为 ${platform}`);
  }
  const missing = missingSigningEnv(env);
  if (missing.length > 0) {
    throw new Error(`签章环境变量未设置：${missing.join('、')}——bundle 会在签章步骤失败`);
  }
}

/// spawnSync 的失败形状收拢：spawn 本身失败（ENOENT、权限）与被信号收束时
/// status 为 null，不能一律报成「非零结束（null）」而丢掉真正的原因。
function checkSpawn(result, command, args) {
  if (result.error) {
    throw new Error(`${command} ${args.join(' ')} 无法运行：${result.error.message}`);
  }
  if (result.status !== 0) {
    const how = result.status === null ? `signal ${result.signal}` : result.status;
    throw new Error(`${command} ${args.join(' ')} 以非零结束（${how}）`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
  checkSpawn(result, command, args);
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
  checkSpawn(result, command, args);
  return result.stdout ?? '';
}

/// 某颗 CLI binary 自报的引擎版号。
function engineVersionOfBinary(binary) {
  if (!existsSync(binary)) throw new Error(`找不到 CLI：${binary}`);
  return engineVersionOf(capture(binary, ['--version']));
}

function main(argv) {
  const install = argv.includes('--install');
  // (0) 进任何建置之前把关：平台限定与签章 env 一次验完。
  preflight({ env: process.env, platform: process.platform, install });

  // (1) 这棵树是什么——安装版只保证等于这棵树，不保证等于 origin 最新。
  const head = capture('git', ['rev-parse', '--short', 'HEAD']).trim();
  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const dirty = capture('git', ['status', '--porcelain']).trim() !== '';
  const expected = sourceAssetVersion(
    readFileSync(path.join(ROOT, 'crates/engine/specseal-core/src/workspace/init.rs'), 'utf8'),
  );
  console.log(`来源：${branch} @ ${head}${dirty ? '（工作树有未提交变更）' : '（工作树干净）'}`);
  console.log(`源码引擎版号：${expected}`);

  // (2) sidecar 永远重建：src-tauri/binaries/ 残留的旧 CLI 会被 externalBin 静默
  // 打包，那正是 2026-08-05 装进 v1.11 引擎的路径。
  run('node', ['scripts/desktop/desktop-sidecar.mjs']);

  // (3) 前端建置与 bundle（签章 env 已于 preflight 验过）。
  run('npm', ['run', 'build', '-w', 'apps/desktop']);
  run('npm', ['run', '-w', 'apps/desktop', 'tauri', '--', 'build', '--bundles', 'app']);

  // (4) 第一道断言：打包进去的 CLI 是不是这棵树的。
  assertSameEngineVersion(
    'bundle 内的 CLI',
    engineVersionOfBinary(path.join(BUNDLE_APP, SIDECAR_IN_APP)),
    expected,
  );
  console.log(`✓ bundle 内的 CLI 引擎版号为 ${expected}`);

  if (!install) {
    console.log(`建置完成：${path.relative(ROOT, BUNDLE_APP)}（加 --install 覆盖安装）`);
    return;
  }

  // (5) 运行中的 app 不代关：用户可能正在里面工作。pattern 锚定安装版的
  // 运行档路径，避免 argv 恰含「Specseal.app」的无关进程（tail、grep）误拦。
  // pgrep 的 exit code 语意：0＝有符合、1＝没有符合、其余＝pgrep 本身失败——
  // 失败不能当成「没在跑」。
  const pg = spawnSync('pgrep', ['-f', `${APP}/Contents/MacOS/specseal-desktop`]);
  if (pg.error || (pg.status !== 0 && pg.status !== 1)) {
    throw new Error(`无法确认 app 是否运行中（pgrep：${pg.error?.message ?? `exit ${pg.status}`}）`);
  }
  if (pg.status === 0) {
    throw new Error('Specseal 正在运行——请先结束 app 再重跑（不代为结束进程）');
  }

  // (6) 覆盖安装：先整份拷到暂存路径，cp 失败时既有的 app 原封不动；成功后
  // 才删旧换新，把「app 消失」的窗口缩到 rm＋rename 两步。
  const staging = `${APP}.new`;
  rmSync(staging, { recursive: true, force: true });
  run('cp', ['-R', BUNDLE_APP, staging]);
  rmSync(APP, { recursive: true, force: true });
  try {
    renameSync(staging, APP);
  } catch (error) {
    throw new Error(
      `旧版已移除但改名失败（${error.message}）——新版完整保留在 ${staging}，手动改名为 ${APP} 即可完成安装`,
    );
  }

  // (7) 第二道断言：装进去的才算数。
  assertSameEngineVersion(
    '安装版的 CLI',
    engineVersionOfBinary(path.join(APP, SIDECAR_IN_APP)),
    expected,
  );
  console.log(`✓ 已安装至 ${APP}，引擎版号为 ${expected}`);
}

// node --test 导入本模块时只取函数，不运行安装。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`desktop-install: ${error.message}`);
    process.exit(1);
  }
}

// 桌面建置前置：把 specseal CLI binary 布到 Tauri externalBin 要求的
// target-triple 命名位置（desktop-release spec「桌面安装档内含同版 CLI」，design D5；
// dev-harness spec「dev 启动自动布署当前 checkout 的 sidecar」）。
//
// 用法：node scripts/desktop/desktop-sidecar.mjs [--profile <debug|release>] [--target <triple>]
//   --profile：debug｜release，无旗标缺省 release（本机安装与 CI 的既有调用形状）
//   有 --target：cargo build -p specseal-cli --target <triple>（交叉编译）
//   --target universal-apple-darwin：对 aarch64 与 x86_64 两个 Apple target 各建一次，
//     布三份档（release-assets-trim 设计 D2）：两份 per-triple 复本给 tauri-build——
//     `tauri build --target universal-apple-darwin` 对两个 triple 各跑一次 cargo build，
//     build script 各以 cargo 的 TARGET 找 specseal-<triple>，缺即失败；再以 lipo 合成
//     一份 specseal-universal-apple-darwin 给 bundler（它要求 universal 建置的 external
//     binary 也是 universal，且命名带 -universal-apple-darwin）
//   无 --target：host 编译，triple 取自 rustc -vV 的 host
// 产出：apps/desktop/src-tauri/binaries/specseal-<triple>[.exe]
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/// cargo 的两个 profile；dev 布 debug（与 npm run cli 验证所用同一颗），
/// 其余调用者维持 release。
export const PROFILES = ['debug', 'release'];

/// spawnSync 的失败形状收拢（同 scripts/desktop/desktop-install.mjs 的 checkSpawn）：spawn 本身
/// 失败（ENOENT、权限）与被信号收束时 status 同为 null，一律报成「非零结束（null）」会
/// 丢掉真正的原因——predev 让这支脚本每次 dev 启动都跑，这消息是缺 cargo 时唯一的线索。
export function checkSpawn(result, command, args) {
  if (result.error) {
    throw new Error(`${command} ${args.join(' ')} 无法运行：${result.error.message}`);
  }
  if (result.status !== 0) {
    const how = result.status === null ? `signal ${result.signal}` : result.status;
    throw new Error(`${command} ${args.join(' ')} 以非零结束（${how}）`);
  }
}

function run(command, args) {
  checkSpawn(spawnSync(command, args, { cwd: root, stdio: 'inherit' }), command, args);
}

function hostTriple() {
  const args = ['-vV'];
  const result = spawnSync('rustc', args, { encoding: 'utf8' });
  checkSpawn(result, 'rustc', args);
  const host = result.stdout?.match(/^host: (\S+)$/m)?.[1];
  if (!host) throw new Error('无法从 rustc -vV 取得 host triple');
  return host;
}

/// 某旗标后面接的值，没给该旗标时为 null；旗标存在却没接值（或下一个 token 是
/// 另一个旗标）即失败，不静默当成「没给」而落回缺省。
function flagValue(argv, flag, expects) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} 后必须接 ${expects}`);
  return value;
}

/// argv → {profile, target}。白名单外的 profile 值不静默吞掉：设置选项要大声失败，
/// 否则 predev 被改成错误的值时只会表现为「dev 布了不该布的东西」。
export function parseSidecarArgs(argv) {
  const target = flagValue(argv, '--target', 'triple');
  const profile = flagValue(argv, '--profile', PROFILES.join(' 或 '));
  if (profile !== null && !PROFILES.includes(profile)) {
    throw new Error(`--profile 的值 ${profile} 不合法，合法值为 ${PROFILES.join('、')}`);
  }

  return { profile: profile ?? 'release', target };
}

function exeSuffix(triple) {
  return triple.includes('windows') ? '.exe' : '';
}

/// cargo 把产物放在哪：有 --target 时多一层 triple 目录。
export function builtBinaryPath(rootDir, { profile, target, triple }) {
  return path.join(
    rootDir,
    'target',
    ...(target ? [target] : []),
    profile,
    `specseal${exeSuffix(triple)}`,
  );
}

/// Tauri 的 universal 目标名与其展开的两个 rustup target。
const UNIVERSAL_TRIPLE = 'universal-apple-darwin';
const UNIVERSAL_TARGETS = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];

/// 建置计划（纯函数，可测）：跑哪几次 cargo（null＝host 编译）、产出哪几个档——每个输出
/// 列出来源与目的档，来源两个以上即以 lipo 合成。universal 以外的 target 维持既有的
/// 单次建置、单一输出形状。
export function sidecarPlan(rootDir, { profile, target, triple }) {
  const destFor = (name) => path.join(rootDir, 'apps/desktop/src-tauri/binaries', `specseal-${name}${exeSuffix(name)}`);
  if (target === UNIVERSAL_TRIPLE) {
    const built = UNIVERSAL_TARGETS.map((t) => builtBinaryPath(rootDir, { profile, target: t, triple: t }));
    return {
      cargoTargets: UNIVERSAL_TARGETS,
      outputs: [
        ...UNIVERSAL_TARGETS.map((t, i) => ({ sources: [built[i]], dest: destFor(t) })),
        { sources: built, dest: destFor(UNIVERSAL_TRIPLE) },
      ],
    };
  }
  return {
    cargoTargets: [target],
    outputs: [{ sources: [builtBinaryPath(rootDir, { profile, target, triple })], dest: destFor(triple) }],
  };
}

/// 内容相同即跳过（决策三的防抖）：binaries/specseal-<triple> 在 cargo 的
/// rerun-if-changed 清单内，无条件覆盖会更新 mtime，使每次 dev 启动都多付一轮
/// specseal-desktop 重编。来源档缺失时报错而非回 false——那不是「内容相同」。
export function shouldCopy(source, dest) {
  if (!existsSync(source)) throw new Error(`找不到建置产物：${source}`);
  if (!existsSync(dest)) return true;
  return !readFileSync(source).equals(readFileSync(dest));
}

/// 布一个输出：多来源先 lipo 到暂存盘，再走同一套「内容相同即跳过」——合成结果才是
/// 要比对的东西。暂存目录在 lipo 之前创建、finally 收掉，lipo 失败也不留残档。
function deploy(output, profile) {
  const [built] = output.sources;
  const shown = path.relative(root, output.dest);
  const scratch = output.sources.length > 1 ? mkdtempSync(path.join(os.tmpdir(), 'specseal-lipo-')) : null;
  try {
    let source = built;
    if (scratch) {
      source = path.join(scratch, 'specseal');
      run('lipo', ['-create', ...output.sources, '-output', source]);
    }
    mkdirSync(path.dirname(output.dest), { recursive: true });
    if (!shouldCopy(source, output.dest)) {
      console.log(`sidecar 内容未变，跳过拷贝：${shown}`);
      return;
    }
    copyFileSync(source, output.dest);
    console.log(`sidecar 布署完成（${profile}${scratch ? '，universal' : ''}）：${shown}`);
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

function main(argv) {
  const { profile, target } = parseSidecarArgs(argv);
  const triple = target ?? hostTriple();
  const plan = sidecarPlan(root, { profile, target, triple });

  for (const cargoTarget of plan.cargoTargets) {
    run('cargo', [
      'build',
      ...(profile === 'release' ? ['--release'] : []),
      '-p',
      'specseal-cli',
      ...(cargoTarget ? ['--target', cargoTarget] : []),
    ]);
  }

  for (const output of plan.outputs) deploy(output, profile);
}

// node --test 导入本模块时只取函数，不运行布署。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`desktop-sidecar: ${error.message}`);
    process.exit(1);
  }
}

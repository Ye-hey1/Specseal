#!/usr/bin/env node
// npm run cli -- <args>：固定运行目前 checkout 的 debug CLI。
// 存在的理由是版本正确性——PATH 上可能没有 specseal，或装的是另一个 checkout 的
// 版本；本 wrapper 让「启动环境」与「以同版 CLI 验证」落在同一份原代码上。
// binary 不存在时先自动于 checkout root 建置再运行——仍绝不 fallback 到 PATH。
// 需要纯 machine-readable stdout 时用 npm run --silent cli -- <args>：wrapper
// 本身不写任何 stdout，剩下的杂讯只有 npm 的 lifecycle 消息。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/// 目前 checkout 的 debug CLI binary 绝对路径；Windows 需要 .exe。
/// 固定回传 checkout 内路径——不查 PATH，也不 fallback 到已安装的 specseal。
export function checkoutCliPath(platform = process.platform) {
  return path.join(ROOT, 'target', 'debug', platform === 'win32' ? 'specseal.exe' : 'specseal');
}

/// 运行 checkout CLI 并回传它的 exit code。<args> 不解析、不改写、原序转送；
/// stdio 全 inherit（交互输入与既有 --json／--no-color 输出直通终端）；环境原样
/// 继承。child cwd 优先取 npm 的 INIT_CWD，让 npm --prefix <checkout> run cli
/// 仍作用于调用者所在的测试 repo；该值不存在时退回 wrapper 的 process.cwd()。
/// 不设 shell：<args> 必须只被 CLI 解析一次。
export function runCheckoutCli({
  args,
  env = process.env,
  platform = process.platform,
  fallbackCwd = process.cwd(),
  exists = existsSync,
  runSync = spawnSync,
  logError = console.error,
}) {
  const binary = checkoutCliPath(platform);

  // binary 不存在：先于 checkout root 自动建置（不受调用端 cwd 影响），
  // 建置失败即收场——绝不 fallback 到 PATH 上的 specseal。build 的 stdout
  // 导向 stderr，保证 --json 等 machine-readable 输出不被建置进度污染。
  if (!exists(binary)) {
    const build = runSync('cargo', ['build', '-p', 'specseal-cli'], {
      cwd: ROOT,
      env,
      stdio: ['inherit', 2, 'inherit'],
    });
    if (build.error) {
      logError(`specseal cli: 无法自动建置 specseal-cli：${build.error.message}`);
      return 1;
    }
    if (build.status !== 0) {
      logError('specseal cli: 自动建置 specseal-cli 失败（见上方 cargo 输出），未运行任何 CLI。');
      return build.status ?? 1;
    }
  }

  // 空的 INIT_CWD（残留的 export、外部工具设空值）语意上就是「没提供」；
  // 原样传给 spawn 只会换来一个看起来像 binary 不存在的 ENOENT。
  const cwd = env.INIT_CWD || fallbackCwd;
  const result = runSync(binary, args, { cwd, env, stdio: 'inherit' });

  // binary 缺失、不可运行或 spawn 失败：stdio inherit 不会留下任何线索，必须
  // 自己点名，并且明确失败——绝不静默改用 PATH 上的 specseal。
  // ENOENT 只会点名 binary，但 cwd 不存在时形状一模一样，因此两者都印出来。
  if (result.error) {
    logError(`specseal cli: 无法运行 checkout CLI ${binary}（cwd ${cwd}）：${result.error.message}`);
    // 自动建置已确保 binary 存在，走到这里多半是 cwd 不存在或权限问题。
    logError('specseal cli: 请确认 cwd 存在且 binary 具运行权限。');
    return 1;
  }

  // 被 signal 收束时 status 为 null，不能当成成功。
  if (result.status === null) {
    logError(`specseal cli: checkout CLI 因 ${result.signal} 结束。`);
    return 1;
  }

  return result.status;
}

// node --test 导入本模块时只取函数，不运行 CLI。
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  process.exit(runCheckoutCli({ args: process.argv.slice(2) }));
}

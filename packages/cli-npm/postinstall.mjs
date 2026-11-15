// @specseal/cli 的 postinstall（cli-distribution spec「CLI 以 npm 套件发布」；release-assets-trim
// 设计 D4，esbuild 的做法）：macOS／Linux 上把 bin/specseal 这个 JS shim 原地换成本机平台的
// 原生 binary——npm 建好的全域 symlink 直接指到原生运行档，之后每次调用零 Node 启动成本。
//
// 不置换的情况一律保留 shim、以 0 结束：Windows（npm 的 .cmd 壳以 node 运行 bin，换成
// 原生档会坏）、Yarn（Yarn Berry 一律以 node 运行套件的 bin，非 JS 的 bin 跑不起来；
// esbuild 同款守门，依 npm_config_user_agent 判断）、找不到平台 binary（optionalDependencies
// 被略过或平台不支持——错误留到运行时由 shim 报，安装本身不该失败）。
import { chmodSync, copyFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveBinary } from './platform.mjs';

/** 置换决策与运行：回传 {replaced, binary} 或 {replaced: false, reason}。userAgent 是
 * 套件管理器设的 npm_config_user_agent（直接运行时未设置）。 */
export function replaceShim({ platform, arch, shimPath, userAgent = '' }) {
  if (platform === 'win32') return { replaced: false, reason: 'win32' };
  if (userAgent.startsWith('yarn/')) return { replaced: false, reason: 'yarn' };
  const binary = resolveBinary(pathToFileURL(shimPath).href, platform, arch);
  if (!binary) return { replaced: false, reason: 'binary-missing' };

  // 同目录暂存名写好、设权限，再 rename 覆盖——rename 是原子的，不会留下半个 shim。
  const staging = path.join(path.dirname(shimPath), `.specseal-${process.pid}`);
  try {
    copyFileSync(binary, staging);
    chmodSync(staging, 0o755);
    renameSync(staging, shimPath);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
  return { replaced: true, binary };
}

// 入口判定先 realpath 再比对（同 packages/server-npm/bin/specseal-server.mjs）：argv[1]
// 可能是经 symlink 的路径，import.meta.url 则是 node 解析后的实体路径，不 realpath 会
// 静默不跑 main、shim 留着——安装看起来成功，每次调用却多付一次 Node 启动。
const invokedAs = (() => {
  if (!process.argv[1]) return null;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return null;
  }
})();
if (invokedAs === import.meta.url) {
  const shimPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'specseal');
  try {
    const outcome = replaceShim({
      platform: process.platform,
      arch: process.arch,
      shimPath,
      userAgent: process.env.npm_config_user_agent,
    });
    if (!outcome.replaced) {
      console.log(`specseal: 保留 JS shim（${outcome.reason}）`);
    }
  } catch (error) {
    // 置换失败不挡安装：shim 仍可用，只是多一次 Node 启动。
    console.warn(`specseal: 置换 shim 失败，保留 JS shim：${error.message}`);
  }
}

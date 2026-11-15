// @specseal/cli 的平台映射与 binary 定位（cli-distribution spec「CLI 以 npm 套件发布」；
// release-assets-trim 设计 D4）。shim（bin/specseal）与 postinstall 共用：两者都以自身
// 位置往上找 node_modules 解析平台子套件，与 npm 实际安装的布局同一条路。
import { createRequire } from 'node:module';
import path from 'node:path';

const SCOPE = '@specseal';

/** 五个平台子套件（os-cpu），与 scripts/npm/npm-platform-package.mjs 的 TARGETS 同序。 */
export const SUPPORTED_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'];

/** os/cpu → 平台子套件名；无对应（未支持平台）回 null。 */
export function platformPackage(platform, arch) {
  const key = `${platform}-${arch}`;
  return SUPPORTED_PLATFORMS.includes(key) ? `${SCOPE}/cli-${key}` : null;
}

export function binaryName(platform) {
  return platform === 'win32' ? 'specseal.exe' : 'specseal';
}

/** 自 fromUrl（shim 或 postinstall 所在档）解析对应子套件内 binary 的绝对路径；
 * 平台不支持、或子套件未安装（optionalDependencies 被略过）回 null。 */
export function resolveBinary(fromUrl, platform, arch) {
  const pkg = platformPackage(platform, arch);
  if (!pkg) return null;
  try {
    const pkgJson = createRequire(fromUrl).resolve(`${pkg}/package.json`);
    return path.join(path.dirname(pkgJson), binaryName(platform));
  } catch {
    return null;
  }
}

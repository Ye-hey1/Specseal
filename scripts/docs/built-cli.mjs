// 文档守门测试用来对照 help 的 CLI（remote-docs.test.mjs、docs-surface.test.mjs 共用）。
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/// 没有建出 CLI 时的 skip 理由。
export const NO_BUILT_CLI = '尚未建置 CLI（target/{debug,release} 皆无）';

/// 这个 repo 建出来的 CLI。刻意不走 PATH 上的 `specseal`：那可能是用户安装的旧版
/// （于是文档比对的是过期的 help surface），而 CI 上根本没有，spawn 直接 ENOENT。
/// debug 与 release 都在时取较新的那个：本机开发者平常建的是 debug，但 `cargo test`
/// 会把 target/debug/specseal 换回旧的缓存产物；CI 只建 release，于是只有它。
export function builtCli(root = ROOT) {
  const exe = process.platform === 'win32' ? 'specseal.exe' : 'specseal';
  const candidates = ['debug', 'release']
    .map((profile) => path.join(root, 'target', profile, exe))
    .filter((candidate) => existsSync(candidate));
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

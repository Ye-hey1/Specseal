// 更新日志两支脚本的测试夹具：脚本由自身位置解析 repo 根（JSON 与两份更新日志路径固定），
// 测试把脚本拷贝进暂存目录、自建同样的目录形状——不碰真 repo 的 CHANGELOG.md 与 CHANGELOG.zh-CN.md。
// tmpdir 先 realpath：macOS 的 /var 是 /private/var 的 symlink，而 ESM 加载器会把
// import.meta.url 解到真实路径，脚本的「直接运行」守门才对得上。
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 建一个暂存 repo：拷贝指定脚本到 <dir>/scripts/release、把 notes 写进固定的 JSON 路径
 * （notes 为字符串时原样写入，供坏 JSON 情境）。回传 dir、英文 CHANGELOG.md 与繁中
 * CHANGELOG.zh-CN.md 的路径与运行器。
 */
export function scratchRepo({ scripts, notes }) {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'release-notes-'));
  mkdirSync(path.join(dir, 'scripts', 'release'), { recursive: true });
  mkdirSync(path.join(dir, 'apps', 'desktop', 'src', 'release-notes'), { recursive: true });
  for (const name of scripts) {
    copyFileSync(path.join(ROOT, 'scripts', 'release', name), path.join(dir, 'scripts', 'release', name));
  }
  writeFileSync(
    path.join(dir, 'apps', 'desktop', 'src', 'release-notes', 'release-notes.json'),
    typeof notes === 'string' ? notes : `${JSON.stringify(notes, null, 2)}\n`,
  );
  const run = (script, args) =>
    spawnSync(process.execPath, [path.join(dir, 'scripts', 'release', script), ...args], { encoding: 'utf8' });
  return {
    dir,
    run,
    changelog: path.join(dir, 'CHANGELOG.md'),
    changelogZh: path.join(dir, 'CHANGELOG.zh-CN.md'),
  };
}

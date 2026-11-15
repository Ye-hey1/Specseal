// 组装 Tauri updater 的 latest.json（desktop-release spec「更新描述档随 release 发布」，
// design D2：由 workflow 组装、端点固定 GitHub Releases）。
//
// 用法：node scripts/release/release-latest-json.mjs --tag v0.2.0 --dir <artifacts> \
//         --repo owner/repo [--out latest.json]
//
// --dir 契约：每个「更新包目录」对应一或多个 updater 平台键——darwin-universal 一个
// 目录喂 darwin-aarch64 与 darwin-x86_64 两键（macOS 出 universal，设计 D2／D3），
// windows-x86_64 与 linux-x86_64 各对应同名键，linux-aarch64 可选；每个目录内含恰好
// 一个更新包与其同名 .sig。键名是 Tauri updater 依运行机器查表的契约，目录名是我们
// 的布置契约，两者刻意分开。缺任一必要目录、缺更新包或缺签章一律以非零结束
// （fail-closed）——宁可不发布，不产出缺平台或无签章的描述档。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// 更新包目录 → 该目录喂的平台键。
const REQUIRED_DIRS = {
  'darwin-universal': ['darwin-aarch64', 'darwin-x86_64'],
  'windows-x86_64': ['windows-x86_64'],
  'linux-x86_64': ['linux-x86_64'],
};
const OPTIONAL_DIRS = { 'linux-aarch64': ['linux-aarch64'] };

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!/^--(tag|dir|repo|out)$/.test(flag) || value === undefined) {
      throw new Error(`无法解析的参数：${flag}`);
    }
    args[flag.slice(2)] = value;
  }
  for (const required of ['tag', 'dir', 'repo']) {
    if (!args[required]) throw new Error(`缺少必要参数 --${required}`);
  }
  return args;
}

/// 读出更新包目录里的更新包与签章；任何缺漏都丢出点名该目录的错误。目录不存在的错误带
/// code MISSING_DIR，可选目录只放过这一种——目录在却缺更新包或缺签章，一样是 fail-closed。
function readPackageEntry(dir, dirName, tag, repo) {
  let files;
  try {
    files = readdirSync(path.join(dir, dirName));
  } catch {
    throw Object.assign(
      new Error(`缺少更新包目录 ${dirName}：找不到子目录 ${path.join(dir, dirName)}`),
      { code: 'MISSING_DIR' },
    );
  }
  const sigs = files.filter((name) => name.endsWith('.sig'));
  if (sigs.length !== 1) {
    throw new Error(`更新包目录 ${dirName}：预期恰好一个 .sig 签章档，实际 ${sigs.length} 个`);
  }
  const pkg = sigs[0].slice(0, -'.sig'.length);
  if (!files.includes(pkg)) {
    throw new Error(`更新包目录 ${dirName}：签章 ${sigs[0]} 找不到对应更新包 ${pkg}`);
  }
  return {
    url: `https://github.com/${repo}/releases/download/${tag}/${pkg}`,
    signature: readFileSync(path.join(dir, dirName, sigs[0]), 'utf8').trim(),
  };
}

function main() {
  const { tag, dir, repo, out } = parseArgs(process.argv.slice(2));

  const platforms = {};
  for (const [dirName, platformKeys] of Object.entries(REQUIRED_DIRS)) {
    const entry = readPackageEntry(dir, dirName, tag, repo);
    for (const platformKey of platformKeys) platforms[platformKey] = entry;
  }
  for (const [dirName, platformKeys] of Object.entries(OPTIONAL_DIRS)) {
    try {
      const entry = readPackageEntry(dir, dirName, tag, repo);
      for (const platformKey of platformKeys) platforms[platformKey] = entry;
    } catch (error) {
      // 可选目录缺席不挡发布；目录在但缺更新包或缺签章仍要挡。
      if (error.code !== 'MISSING_DIR') throw error;
    }
  }

  const manifest = {
    version: tag.replace(/^v/, ''),
    pub_date: new Date().toISOString(),
    platforms,
  };

  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  if (out) {
    writeFileSync(out, json);
  } else {
    process.stdout.write(json);
  }
}

try {
  main();
} catch (error) {
  console.error(`release-latest-json: ${error.message}`);
  process.exit(1);
}

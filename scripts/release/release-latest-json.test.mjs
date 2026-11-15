// latest.json 组装脚本的单元测试（desktop-release spec「更新描述档随 release 发布」，
// design D2／release-assets-trim D3）。以子行程运行 scripts/release/release-latest-json.mjs：
// 给定 tag 与各更新包目录＋签章档，验证输出字段；缺任一必要目录输入时必须以非零结束
// （fail-closed）。
//
// 目录契约：--dir 之下每个「更新包目录」对应一或多个平台键——darwin-universal 一个
// 目录喂 darwin-aarch64 与 darwin-x86_64 两键（universal 更新包），windows-x86_64 与
// linux-x86_64 各对应同名键，linux-aarch64 可选；每个目录内含恰好一个更新包与其同名
// .sig——由 release workflow 的 artifact 下载步骤布置。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/release/release-latest-json.mjs');

const REPO = 'MomoChenisMe/speclink';
const TAG = 'v0.5.0';

// 必要三个更新包目录与各自的更新包文件名。
const REQUIRED_DIRS = {
  'darwin-universal': 'Specseal_0.5.0_universal.app.tar.gz',
  'windows-x86_64': 'Specseal_0.5.0_x64-setup.exe',
  'linux-x86_64': 'Specseal_0.5.0_amd64.AppImage',
};

/// 布置 --dir 目录：每个更新包目录放更新包与 .sig（内容为目录专属字符串）。
function layoutArtifacts(dir, dirs) {
  for (const [key, fileName] of Object.entries(dirs)) {
    const packageDir = path.join(dir, key);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(path.join(packageDir, fileName), `binary-${key}`);
    writeFileSync(path.join(packageDir, `${fileName}.sig`), `sig-${key}\n`);
  }
}

function runScript(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

/// 布置一组更新包目录到暂存 --dir，回传目录与预期的输出路径。
function layout(t, dirs) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'latest-json-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  layoutArtifacts(dir, dirs);
  return { dir, out: path.join(dir, 'latest.json') };
}

function assemble(t, dirs) {
  const { dir, out } = layout(t, dirs);
  const result = runScript(['--tag', TAG, '--dir', dir, '--repo', REPO, '--out', out]);
  return { dir, out, result };
}

test('组装出的 latest.json：version 去 v 前缀、四个必要平台键齐备、url 指向 Release asset、signature 为签章内容', (t) => {
  const { out, result } = assemble(t, REQUIRED_DIRS);
  assert.equal(result.status, 0, `脚本应成功结束\nstderr: ${result.stderr}`);

  const manifest = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(manifest.version, '0.5.0', 'version 必须是 tag 去除 v 前缀');
  assert.ok(
    !Number.isNaN(Date.parse(manifest.pub_date)),
    `pub_date 必须是可解析的时间，实际 ${manifest.pub_date}`,
  );

  // Tauri updater 依运行机器查 darwin-aarch64／darwin-x86_64／windows-x86_64／linux-x86_64，
  // 键名是 updater 的契约，四键缺一不可。
  const expected = {
    'darwin-aarch64': REQUIRED_DIRS['darwin-universal'],
    'darwin-x86_64': REQUIRED_DIRS['darwin-universal'],
    'windows-x86_64': REQUIRED_DIRS['windows-x86_64'],
    'linux-x86_64': REQUIRED_DIRS['linux-x86_64'],
  };
  for (const [key, fileName] of Object.entries(expected)) {
    const entry = manifest.platforms?.[key];
    assert.ok(entry, `platforms 缺少 ${key}`);
    assert.equal(
      entry.url,
      `https://github.com/${REPO}/releases/download/${TAG}/${fileName}`,
      `${key} 的 url 必须指向该 Release asset 下载路径`,
    );
  }
  assert.equal(manifest.platforms['windows-x86_64'].signature, 'sig-windows-x86_64', 'signature 必须是签章档内容（去尾端空白）');
  assert.equal(manifest.platforms['linux-x86_64'].signature, 'sig-linux-x86_64');
});

test('darwin-aarch64 与 darwin-x86_64 两键共用 universal 更新包：url 与 signature 相同', (t) => {
  const { out, result } = assemble(t, REQUIRED_DIRS);
  assert.equal(result.status, 0, `脚本应成功结束\nstderr: ${result.stderr}`);

  const { platforms } = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(
    platforms['darwin-aarch64'].url,
    `https://github.com/${REPO}/releases/download/${TAG}/Specseal_0.5.0_universal.app.tar.gz`,
  );
  assert.deepEqual(platforms['darwin-x86_64'], platforms['darwin-aarch64'], 'darwin 两键必须指向同一档、同一签章');
  assert.equal(platforms['darwin-aarch64'].signature, 'sig-darwin-universal');
  assert.equal(platforms['darwin-universal'], undefined, 'darwin-universal 是目录名，不是 updater 的平台键');
});

test('额外目录（linux-aarch64）存在时一并收录', (t) => {
  const { out, result } = assemble(t, {
    ...REQUIRED_DIRS,
    'linux-aarch64': 'Specseal_0.5.0_aarch64.AppImage',
  });
  assert.equal(result.status, 0, `脚本应成功结束\nstderr: ${result.stderr}`);

  const manifest = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(
    manifest.platforms['linux-aarch64']?.url,
    `https://github.com/${REPO}/releases/download/${TAG}/Specseal_0.5.0_aarch64.AppImage`,
  );
  assert.equal(manifest.platforms['linux-aarch64']?.signature, 'sig-linux-aarch64');
});

test('可选目录（linux-aarch64）存在但缺 .sig 时同样非零结束（只有「目录不存在」才放过）', (t) => {
  const { dir, out } = layout(t, { ...REQUIRED_DIRS, 'linux-aarch64': 'Specseal_0.5.0_aarch64.AppImage' });
  rmSync(path.join(dir, 'linux-aarch64', 'Specseal_0.5.0_aarch64.AppImage.sig'));

  const result = runScript(['--tag', TAG, '--dir', dir, '--repo', REPO, '--out', out]);
  assert.notEqual(result.status, 0, '可选目录有更新包却缺签章时必须以非零结束');
  assert.match(result.stderr, /linux-aarch64/, 'stderr 必须点名缺签章的目录');
  assert.throws(() => readFileSync(out), '缺签章时不得写出 latest.json');
});

test('缺任一必要目录时以非零结束并点名（fail-closed），不写出描述档', (t) => {
  for (const missing of Object.keys(REQUIRED_DIRS)) {
    const partial = { ...REQUIRED_DIRS };
    delete partial[missing];
    const { out, result } = assemble(t, partial);
    assert.notEqual(result.status, 0, `缺 ${missing} 时必须以非零结束`);
    assert.match(result.stderr, new RegExp(missing), `stderr 必须点名缺失的目录 ${missing}`);
    assert.throws(() => readFileSync(out), `缺 ${missing} 时不得写出 latest.json`);
  }
});

test('更新包存在但缺 .sig 时以非零结束（签章 fail-closed）', (t) => {
  const { dir, out } = layout(t, REQUIRED_DIRS);
  rmSync(path.join(dir, 'darwin-universal', `${REQUIRED_DIRS['darwin-universal']}.sig`));

  const result = runScript(['--tag', TAG, '--dir', dir, '--repo', REPO, '--out', out]);
  assert.notEqual(result.status, 0, '缺签章档时必须以非零结束');
  assert.match(result.stderr, /darwin-universal/, 'stderr 必须点名缺签章的目录');
  assert.throws(() => readFileSync(out), '缺签章时不得写出 latest.json');
});

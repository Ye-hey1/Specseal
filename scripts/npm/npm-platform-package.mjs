// 「主套件＋五平台子套件」的 npm 物化共用层：CLI（cli-distribution spec「CLI 以 npm 套件发布」；
// release-assets-trim 设计 D4）与 server（server-release spec「npm 套件一行启动 server」；
// 设计 D9）的套件形状相同——repo 内只维护带 private 的主套件，发布时产出去掉 private、盖上
// 版本、补 optionalDependencies 的主套件副本，以及五个只含对应平台 binary 的子套件。两支
// 入口脚本（npm-cli-package.mjs、npm-server-package.mjs）只负责解析参数，物化规则在这里一份。
//
// 缺任一平台 binary 或版号不合形即丢错，且在写任何档之前——不留下半套输出。

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// release build artifact（<name>-<target>，内容为 raw binary）→ npm 平台子套件（os／cpu）的映射契约。
// Linux 的 binary 是 glibc 动态链接（*-unknown-linux-gnu），声明 libc 让 npm／pnpm 在 musl
// （Alpine）跳过子套件，由 shim／launcher 报「找不到 binary」，而不是装进去后 loader 缺席。
const TARGETS = [
  { target: 'aarch64-apple-darwin', os: 'darwin', cpu: 'arm64' },
  { target: 'x86_64-apple-darwin', os: 'darwin', cpu: 'x64' },
  { target: 'x86_64-unknown-linux-gnu', os: 'linux', cpu: 'x64', libc: 'glibc' },
  { target: 'aarch64-unknown-linux-gnu', os: 'linux', cpu: 'arm64', libc: 'glibc' },
  { target: 'x86_64-pc-windows-msvc', os: 'win32', cpu: 'x64' },
];

/// 物化套件。name 是套件家族名（cli／server）：artifact 目录叫 <name>-<target>，主套件叫
/// <scope>/<name>，子套件叫 <scope>/<name>-<os>-<cpu>。binary 是 binary 的基底文件名（Windows
/// 自动加 .exe）。sourceDir 是 repo 内的主套件目录，其 package.json 的 files 就是要一并带进
/// 副本的文件清单（bin 内的档设为可运行）。回传物化的套件数。
export function materializePackages({ name, binary, description, sourceDir, version, binariesDir, outDir, scope }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`版本「${version}」不符 X.Y.Z 格式（不带 v 前缀）`);

  const binaryFor = (os) => (os === 'win32' ? `${binary}.exe` : binary);
  const artifactBinary = ({ target, os }) => path.join(binariesDir, `${name}-${target}`, binaryFor(os));

  // fail closed：先验五个 binary 全数到位，再开始物化。
  const missing = TARGETS.filter((entry) => !existsSync(artifactBinary(entry)));
  if (missing.length > 0) throw new Error(`缺少平台 binary：${missing.map((m) => m.target).join('、')}`);

  // 平台子套件：os/cpu 圈定，内容物只有 binary。
  for (const entry of TARGETS) {
    const { os, cpu, libc } = entry;
    const pkgDir = path.join(outDir, `${name}-${os}-${cpu}`);
    mkdirSync(pkgDir, { recursive: true });
    writeJson(path.join(pkgDir, 'package.json'), {
      name: `${scope}/${name}-${os}-${cpu}`,
      version,
      description: `${description} for ${os}/${cpu}`,
      license: 'MIT',
      os: [os],
      cpu: [cpu],
      ...(libc ? { libc: [libc] } : {}),
      // Yarn PnP 会把套件留在 zip 里；binary 要真的落在磁盘上，主套件才 spawn 得到。
      preferUnplugged: true,
    });
    const dest = path.join(pkgDir, binaryFor(os));
    copyFileSync(artifactBinary(entry), dest);
    chmodSync(dest, 0o755);
  }

  // 主套件副本：以 repo 的主套件为底，去 private 与说明栏、盖版本与 scope、补五组同版
  // optionalDependencies；files 列的档原样带上。
  const source = JSON.parse(readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));
  delete source.private;
  delete source['//'];
  source.name = `${scope}/${name}`;
  source.version = version;
  source.optionalDependencies = Object.fromEntries(TARGETS.map(({ os, cpu }) => [`${scope}/${name}-${os}-${cpu}`, version]));
  const mainDir = path.join(outDir, name);
  mkdirSync(mainDir, { recursive: true });
  writeJson(path.join(mainDir, 'package.json'), source);
  for (const file of source.files) {
    const dest = path.join(mainDir, file);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(sourceDir, file), dest);
    if (file.startsWith('bin/')) chmodSync(dest, 0o755);
  }

  return TARGETS.length + 1;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

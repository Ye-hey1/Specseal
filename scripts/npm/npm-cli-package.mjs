#!/usr/bin/env node
// 从 build artifacts 物化 CLI 的 npm 套件（cli-distribution spec「CLI 以 npm 套件发布」；
// release-assets-trim 设计 D4）：主套件 @specseal/cli（以 packages/cli-npm 为底）加五个平台
// 子套件 @specseal/cli-<os>-<cpu>。物化规则与 server 共用（npm-platform-package.mjs），这里
// 只解析参数。缺任一平台即 fail closed，且不留下半套输出。
//
// 用法：npm-cli-package.mjs --version X.Y.Z --binaries <dir> --out <dir>

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { materializePackages } from './npm-platform-package.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const version = arg('--version');
const binariesDir = arg('--binaries');
const outDir = arg('--out');
if (!version || !binariesDir || !outDir) {
  process.stderr.write('用法：npm-cli-package.mjs --version X.Y.Z --binaries <dir> --out <dir>\n');
  process.exit(1);
}

try {
  const count = materializePackages({
    name: 'cli',
    binary: 'specseal',
    description: 'Specseal CLI binary',
    sourceDir: path.join(root, 'packages/cli-npm'),
    version,
    binariesDir,
    outDir,
    scope: '@specseal',
  });
  process.stdout.write(`已物化 ${count} 个套件至 ${outDir}（版本 ${version}）\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

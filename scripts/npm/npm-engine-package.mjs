#!/usr/bin/env node
// engine 的 npm 发布版号盖章（node-sdk-release spec「engine npm 套件家族与版号盖章」；
// 设计 D2）。repo 内 crates/adapters/specseal-node/package.json 的版号只是占位符；发布版本一律
// 由 release tag 决定，于 CI 的抛弃式 checkout 上盖章：主套件与 napi create-npm-dir
// 产生的每个平台子套件同版，主套件 optionalDependencies 物化为各子套件名钉同版。
// 平台子套件清单自 npm/ 目录实际内容枚举（napi.triples 是唯一来源），不硬编码 triple。

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const version = arg('--version');
const dir = arg('--dir');
if (!version || !dir) {
  fail('用法：npm-engine-package.mjs --version X.Y.Z --dir <套件根>');
}
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`版本「${version}」不符 X.Y.Z 格式（不带 v 前缀）`);

function readPkg(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writePkg(file, pkg) {
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

// fail closed：没有平台子套件目录代表 napi create-npm-dir 未跑，此时发布的主套件会
// 带空 optionalDependencies——安装得到没有 binary 的套件，比红灯更糟。
const npmDir = path.join(dir, 'npm');
let platforms;
try {
  platforms = readdirSync(npmDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
} catch {
  fail(`找不到平台子套件目录 ${npmDir}——napi create-npm-dir 尚未运行？`);
}
if (platforms.length === 0) fail(`${npmDir} 没有任何平台子套件目录`);

// 平台子套件：只盖版号，名称与 os／cpu 字段维持 napi 产出的原样。
const subNames = platforms.map((platform) => {
  const file = path.join(npmDir, platform, 'package.json');
  const pkg = readPkg(file);
  pkg.version = version;
  writePkg(file, pkg);
  return pkg.name;
});

// 主套件：盖版号并把 optionalDependencies 整组换成本次枚举到的子套件（旧清单不留残留）。
// 占位符注解只对 repo 内的版号成立，发布产物不带（与 npm-server-package.mjs 同惯例）。
const mainFile = path.join(dir, 'package.json');
const main = readPkg(mainFile);
delete main['//'];
main.version = version;
main.optionalDependencies = Object.fromEntries(subNames.map((name) => [name, version]));
writePkg(mainFile, main);

process.stdout.write(`已盖章 ${main.name} 与 ${subNames.length} 个平台子套件为 ${version}\n`);

// 本机安装入口的断言链（desktop-release spec「本机安装的新鲜度断言」）。
// 覆盖纯函数部分：源码版号读取、--version 的引擎版号解析、版号断言的失败形状，
// 以及 --install 的平台限定与签章环境变量检查。实际建置与安装为手动验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertSameEngineVersion,
  engineVersionOf,
  missingSigningEnv,
  preflight,
  sourceAssetVersion,
} from './desktop-install.mjs';

const SIGNED = {
  TAURI_SIGNING_PRIVATE_KEY: 'k',
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'p',
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('源码版号取自 specseal-core 的 ASSET_VERSION 常数', () => {
  const text = readFileSync(path.join(root, 'crates/engine/specseal-core/src/workspace/init.rs'), 'utf8');
  const version = sourceAssetVersion(text);
  assert.match(version, /^v\d+\.\d+\.\d+$/);
  assert.ok(text.includes(`"${version}"`), '读出的版号须确实出现在源码中');
});

test('读不到 ASSET_VERSION 常数时明确失败，不回空字符串', () => {
  assert.throws(() => sourceAssetVersion('没有常数的文件\n'), /ASSET_VERSION/);
});

test('--version 输出的引擎版号可解析', () => {
  assert.equal(engineVersionOf('specseal 0.1.0 (arm64, engine v1.14.0)\n'), 'v1.14.0');
});

test('--version 不含引擎版号时明确失败（旧 binary 的形状）', () => {
  assert.throws(() => engineVersionOf('specseal 0.1.0 (arm64)\n'), /engine/);
});

test('版号不符的断言印出两边版号', () => {
  assert.throws(
    () => assertSameEngineVersion('bundle', 'v1.11.0', 'v1.14.0'),
    (error) => {
      assert.match(error.message, /v1\.11\.0/);
      assert.match(error.message, /v1\.14\.0/);
      assert.match(error.message, /bundle/);
      return true;
    },
  );
  assert.doesNotThrow(() => assertSameEngineVersion('bundle', 'v1.14.0', 'v1.14.0'));
});

test('签章环境变量缺失时点名缺的变量，齐备时回空', () => {
  assert.deepEqual(missingSigningEnv({}), [
    'TAURI_SIGNING_PRIVATE_KEY',
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
  ]);
  assert.deepEqual(missingSigningEnv({ TAURI_SIGNING_PRIVATE_KEY: 'k' }), [
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
  ]);
  assert.deepEqual(
    missingSigningEnv({ TAURI_SIGNING_PRIVATE_KEY: 'k', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'p' }),
    [],
  );
});

test('preflight：非 macOS 带 --install 即拒绝，点名平台', () => {
  assert.throws(() => preflight({ env: SIGNED, platform: 'linux', install: true }), /macOS/);
  assert.throws(() => preflight({ env: SIGNED, platform: 'win32', install: true }), /win32/);
});

test('preflight：签章环境变量缺失即拒绝并点名变量', () => {
  assert.throws(
    () => preflight({ env: {}, platform: 'darwin', install: false }),
    /TAURI_SIGNING_PRIVATE_KEY/,
  );
});

test('preflight：macOS 且签章 env 齐备即通过（带不带 --install 皆然）', () => {
  assert.doesNotThrow(() => preflight({ env: SIGNED, platform: 'darwin', install: false }));
  assert.doesNotThrow(() => preflight({ env: SIGNED, platform: 'darwin', install: true }));
});

test('preflight：不带 --install 时平台不设限（建置步骤平台中立）', () => {
  assert.doesNotThrow(() => preflight({ env: SIGNED, platform: 'linux', install: false }));
});

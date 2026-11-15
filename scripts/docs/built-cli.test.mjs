// 文档守门测试共用的 CLI 定位：只认这个 repo 建出来的 binary，两种 profile 都在时取较新的。
// 测试只在暂存目录里造假的 target/ 结构，不碰真正的 target/。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { builtCli } from './built-cli.mjs';

const exe = process.platform === 'win32' ? 'specseal.exe' : 'specseal';

function fakeRoot(profiles) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'specseal-built-cli-'));
  for (const [profile, seconds] of Object.entries(profiles)) {
    const file = path.join(root, 'target', profile, exe);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
    utimesSync(file, seconds, seconds);
  }
  return root;
}

test('两种 profile 都在时取较新的那个（本机的 cargo test 会把 debug 换回旧产物）', () => {
  const root = fakeRoot({ debug: 1_000, release: 2_000 });
  try {
    assert.equal(builtCli(root), path.join(root, 'target', 'release', exe));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('只有一种 profile 时就用它；都没有时回 null，调用端据此 skip', () => {
  const debugOnly = fakeRoot({ debug: 1_000 });
  const none = fakeRoot({});
  try {
    assert.equal(builtCli(debugOnly), path.join(debugOnly, 'target', 'debug', exe));
    assert.equal(builtCli(none), null);
  } finally {
    rmSync(debugOnly, { recursive: true, force: true });
    rmSync(none, { recursive: true, force: true });
  }
});

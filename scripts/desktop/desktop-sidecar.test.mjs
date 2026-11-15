// sidecar 布署脚本的纯函数层（dev-harness spec「dev 启动自动布署当前 checkout 的
// sidecar」，决策二～四）。覆盖 --profile 白名单、建置产物来源路径推导、以及
// 「内容相同即跳过拷贝」的防抖判定；实际 cargo 建置与 dev 启动为手动验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { builtBinaryPath, checkSpawn, parseSidecarArgs, shouldCopy, sidecarPlan } from './desktop-sidecar.mjs';

const ROOT = '/repo';

/// 每个测试自己的暂存目录，离开时整份删掉。
function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sidecar-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// --- 参数解析（决策二：dev 布 debug，无参数维持 release） ---

test('无旗标时 profile 缺省 release、target 为 null（既有调用者的行为不变）', () => {
  assert.deepEqual(parseSidecarArgs([]), { profile: 'release', target: null });
});

test('--profile debug 与 --profile release 皆为合法值', () => {
  assert.deepEqual(parseSidecarArgs(['--profile', 'debug']), { profile: 'debug', target: null });
  assert.deepEqual(parseSidecarArgs(['--profile', 'release']), { profile: 'release', target: null });
});

test('--profile 与 --target 正交，可同时给（CI 交叉编译的形状）', () => {
  assert.deepEqual(parseSidecarArgs(['--target', 'x86_64-pc-windows-msvc']), {
    profile: 'release',
    target: 'x86_64-pc-windows-msvc',
  });
  assert.deepEqual(parseSidecarArgs(['--profile', 'debug', '--target', 'aarch64-apple-darwin']), {
    profile: 'debug',
    target: 'aarch64-apple-darwin',
  });
});

test('白名单外的 profile 值即拒绝，错误点名该值与两个合法值', () => {
  assert.throws(
    () => parseSidecarArgs(['--profile', 'bogus']),
    (error) => {
      assert.match(error.message, /bogus/);
      assert.match(error.message, /debug/);
      assert.match(error.message, /release/);
      return true;
    },
  );
});

test('--profile 后没接值时明确失败，不静默回退成 release', () => {
  assert.throws(() => parseSidecarArgs(['--profile']), /--profile/);
  assert.throws(() => parseSidecarArgs(['--profile', '--target', 'aarch64-apple-darwin']), /--profile/);
});

test('--target 后没接值时明确失败（既有行为）', () => {
  assert.throws(() => parseSidecarArgs(['--target']), /--target/);
});

// --- 子进程失败形状（predev 让这支脚本每次 dev 启动都跑，消息是唯一的线索） ---

test('spawn 本身失败时点名真正的原因，不报成「非零结束（null）」', () => {
  assert.throws(
    () => checkSpawn({ error: new Error('spawn cargo ENOENT'), status: null }, 'cargo', ['build']),
    (error) => {
      assert.match(error.message, /cargo build/);
      assert.match(error.message, /ENOENT/);
      assert.doesNotMatch(error.message, /null/);
      return true;
    },
  );
});

test('被信号收束时点名该信号（status 为 null 但没有 error）', () => {
  assert.throws(
    () => checkSpawn({ status: null, signal: 'SIGKILL' }, 'cargo', ['build']),
    /signal SIGKILL/,
  );
});

test('非零状态码原样点名', () => {
  assert.throws(() => checkSpawn({ status: 101 }, 'cargo', ['build']), /101/);
});

test('status 0 即通过', () => {
  assert.doesNotThrow(() => checkSpawn({ status: 0 }, 'cargo', ['build']));
});

// --- 来源路径推导（profile × --target × Windows .exe） ---

test('无 --target：路径为 target/<profile>/specseal', () => {
  assert.equal(
    builtBinaryPath(ROOT, { profile: 'debug', target: null, triple: 'aarch64-apple-darwin' }),
    path.join(ROOT, 'target/debug/specseal'),
  );
  assert.equal(
    builtBinaryPath(ROOT, { profile: 'release', target: null, triple: 'aarch64-apple-darwin' }),
    path.join(ROOT, 'target/release/specseal'),
  );
});

test('有 --target：路径多一层 triple，为 target/<triple>/<profile>/specseal', () => {
  assert.equal(
    builtBinaryPath(ROOT, {
      profile: 'release',
      target: 'x86_64-unknown-linux-gnu',
      triple: 'x86_64-unknown-linux-gnu',
    }),
    path.join(ROOT, 'target/x86_64-unknown-linux-gnu/release/specseal'),
  );
});

test('Windows triple 带 .exe 后缀（交叉编译与 host 编译皆然）', () => {
  assert.equal(
    builtBinaryPath(ROOT, {
      profile: 'release',
      target: 'x86_64-pc-windows-msvc',
      triple: 'x86_64-pc-windows-msvc',
    }),
    path.join(ROOT, 'target/x86_64-pc-windows-msvc/release/specseal.exe'),
  );
  assert.equal(
    builtBinaryPath(ROOT, { profile: 'debug', target: null, triple: 'x86_64-pc-windows-msvc' }),
    path.join(ROOT, 'target/debug/specseal.exe'),
  );
});

// --- 建置计划（release-assets-trim 设计 D2：macOS universal sidecar） ---
//
// 计划层决定「跑哪几次 cargo、产出哪几个档（各自的来源与目的档）」，实际 cargo／lipo
// 由 main 运行；来源两个以上的输出以 lipo 合成。universal 建置要三份档：tauri-build 在
// `tauri build --target universal-apple-darwin` 对两个 triple 各跑一次的 cargo build 期间，
// 各以 cargo 的 TARGET 找 specseal-<triple>（缺即 ResourcePathNotFound 失败）；bundler
// 最后阶段才拿命名 specseal-universal-apple-darwin 的 universal 档进 app bundle。

const BINARIES = path.join(ROOT, 'apps/desktop/src-tauri/binaries');

test('universal-apple-darwin：对两个 Apple target 各建一次；输出两份 per-triple 复本＋一份 lipo 合成的 universal', () => {
  const plan = sidecarPlan(ROOT, { profile: 'release', target: 'universal-apple-darwin', triple: 'universal-apple-darwin' });
  assert.deepEqual(plan.cargoTargets, ['aarch64-apple-darwin', 'x86_64-apple-darwin']);
  const arm = path.join(ROOT, 'target/aarch64-apple-darwin/release/specseal');
  const intel = path.join(ROOT, 'target/x86_64-apple-darwin/release/specseal');
  assert.deepEqual(plan.outputs, [
    { sources: [arm], dest: path.join(BINARIES, 'specseal-aarch64-apple-darwin') },
    { sources: [intel], dest: path.join(BINARIES, 'specseal-x86_64-apple-darwin') },
    { sources: [arm, intel], dest: path.join(BINARIES, 'specseal-universal-apple-darwin') },
  ]);
});

test('universal 也吃 --profile debug：来源改指 debug 目录', () => {
  const plan = sidecarPlan(ROOT, { profile: 'debug', target: 'universal-apple-darwin', triple: 'universal-apple-darwin' });
  assert.deepEqual(plan.outputs.at(-1).sources, [
    path.join(ROOT, 'target/aarch64-apple-darwin/debug/specseal'),
    path.join(ROOT, 'target/x86_64-apple-darwin/debug/specseal'),
  ]);
});

test('一般交叉编译 target：单次 cargo build、单一输出不 lipo、目的档为 specseal-<triple>（Windows 带 .exe）', () => {
  const plan = sidecarPlan(ROOT, { profile: 'release', target: 'x86_64-pc-windows-msvc', triple: 'x86_64-pc-windows-msvc' });
  assert.deepEqual(plan.cargoTargets, ['x86_64-pc-windows-msvc']);
  assert.deepEqual(plan.outputs, [
    {
      sources: [path.join(ROOT, 'target/x86_64-pc-windows-msvc/release/specseal.exe')],
      dest: path.join(BINARIES, 'specseal-x86_64-pc-windows-msvc.exe'),
    },
  ]);
});

test('无 --target（host 编译）：cargoTargets 为 [null]、来源为 target/<profile>/specseal、目的档以 host triple 命名', () => {
  const plan = sidecarPlan(ROOT, { profile: 'debug', target: null, triple: 'aarch64-apple-darwin' });
  assert.deepEqual(plan.cargoTargets, [null]);
  assert.deepEqual(plan.outputs, [
    { sources: [path.join(ROOT, 'target/debug/specseal')], dest: path.join(BINARIES, 'specseal-aarch64-apple-darwin') },
  ]);
});

// --- 跳过拷贝判定（决策三：binaries/ 在 cargo 重编触发清单内，无谓改写要避免） ---

test('目的档不存在即拷贝', (t) => {
  const dir = tempDir(t);
  const source = path.join(dir, 'source');
  writeFileSync(source, 'built');
  assert.equal(shouldCopy(source, path.join(dir, 'dest')), true);
});

test('目的档内容与来源相同即跳过（不触碰文件，避免触发重编）', (t) => {
  const dir = tempDir(t);
  const source = path.join(dir, 'source');
  const dest = path.join(dir, 'dest');
  writeFileSync(source, 'built');
  writeFileSync(dest, 'built');
  assert.equal(shouldCopy(source, dest), false);
});

test('目的档内容与来源相异即拷贝（过期 sidecar 照常覆盖）', (t) => {
  const dir = tempDir(t);
  const source = path.join(dir, 'source');
  const dest = path.join(dir, 'dest');
  writeFileSync(source, 'built');
  writeFileSync(dest, 'stale');
  assert.equal(shouldCopy(source, dest), true);
});

test('来源档缺失时明确报错点名该路径，不当成「内容相同」静默跳过', (t) => {
  const dir = tempDir(t);
  const source = path.join(dir, 'missing');
  assert.throws(() => shouldCopy(source, path.join(dir, 'dest')), (error) => {
    assert.match(error.message, /missing/);
    return true;
  });
});

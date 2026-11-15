// 技能评测套件的守门（skill-authoring 规格「技能评测套件」）。
// compareResults 以 inline 的 aggregate-result.json 验证新旧比较的判定；compare 子指令以暂存
// 目录里的结果档实际运行，验证结束码与输出；最后一条扫过版本库实况：`specseal update` 写出的
// 每个 `.claude/skills/specseal-*` 技能，都要在 integrations/claude-code/skill-evals/evals/
// 至少有一题以 tags 标示 `skill:<短名>`。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OUT_ROOT, RESULT_FILE, compareResults, evalSpawnOptions, parseRunArgs, runPaths } from './skill-evals.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/claude-code/skill-evals.mjs');
const EVALS_DIR = 'integrations/claude-code/skill-evals/evals';

/// aggregate-result.json 的最小形状：题目名在 cases[].name、分数在 cases[].aggregates.score。
function aggregate(scores) {
  return { cases: Object.entries(scores).map(([name, score]) => ({ name, aggregates: { score } })) };
}

/// 在暂存目录创建一个 repo 根目录给 fn 用，结束后删掉。
function withTempRoot(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'skill-evals-test-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/// 把结果文档写成 <root>/<label>/aggregate-result.json，回传该结果目录。
function writeResult(root, label, doc) {
  const dir = path.join(root, label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, RESULT_FILE), typeof doc === 'string' ? doc : JSON.stringify(doc));
  return dir;
}

function compareCli(oldDir, newDir) {
  return spawnSync(process.execPath, [SCRIPT, 'compare', oldDir, newDir], { encoding: 'utf8' });
}

// 规格 Example「比较的判定」：一列一个 test。
for (const [name, oldScore, newScore, verdict, exitCode] of [
  ['propose-from-discussion', 0.67, 1, '进步', 0],
  ['apply-leaves-manual-task', 1, 1, '持平', 0],
  ['commit-gate-shows-plan', 1, 0.67, '退步', 1],
]) {
  test(`比较：Example「比较的判定」${name}（${verdict}）exit ${exitCode}`, () =>
    withTempRoot((root) => {
      const child = compareCli(writeResult(root, 'old', aggregate({ [name]: oldScore })), writeResult(root, 'new', aggregate({ [name]: newScore })));
      assert.equal(child.status, exitCode, child.stderr);
      assert.match(child.stdout, new RegExp(`${name}\\s+${oldScore.toFixed(2)}\\s+${newScore.toFixed(2)}`));
      assert.equal(child.stdout.includes(`退步：${name}`), verdict === '退步', child.stdout);
    }));
}

test('比较：Example 整张表——列出退步的题目，exit 1', () =>
  withTempRoot((root) => {
    const child = compareCli(
      writeResult(root, 'old', aggregate({ 'propose-from-discussion': 0.67, 'apply-leaves-manual-task': 1, 'commit-gate-shows-plan': 1 })),
      writeResult(root, 'new', aggregate({ 'propose-from-discussion': 1, 'apply-leaves-manual-task': 1, 'commit-gate-shows-plan': 0.67 })),
    );
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stdout, /退步：commit-gate-shows-plan（1\.00 → 0\.67）/);
    assert.ok(!child.stdout.includes('退步：propose-from-discussion'), child.stdout);
  }));

test('比较：每题新分数都不低于旧分数时 exit 0', () =>
  withTempRoot((root) => {
    const child = compareCli(writeResult(root, 'old', aggregate({ a: 0.5, b: 1 })), writeResult(root, 'new', aggregate({ a: 1, b: 1 })));
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /a\s+0\.50\s+1\.00\s+\+0\.50/);
  }));

test('比较：题目集合不同时在 stdout 列出缺题，exit 2', () =>
  withTempRoot((root) => {
    const child = compareCli(
      writeResult(root, 'old', aggregate({ 'trace-cites-archive': 1, 'drift-reports-only': 1 })),
      writeResult(root, 'new', aggregate({ 'drift-reports-only': 1 })),
    );
    assert.equal(child.status, 2, child.stderr);
    assert.match(child.stdout, /缺少的题目：trace-cites-archive/);
  }));

test('比较：结果档不存在时 stderr 指名该档，exit 3', () =>
  withTempRoot((root) => {
    const newDir = path.join(root, 'new');
    mkdirSync(newDir);
    const child = compareCli(writeResult(root, 'old', aggregate({ a: 1 })), newDir);
    assert.equal(child.status, 3);
    assert.ok(child.stderr.includes(path.join(newDir, RESULT_FILE)), child.stderr);
  }));

test('比较：结果档不是 JSON 时 stderr 指名该档，exit 3', () =>
  withTempRoot((root) => {
    const newDir = writeResult(root, 'new', 'not json');
    const child = compareCli(writeResult(root, 'old', aggregate({ a: 1 })), newDir);
    assert.equal(child.status, 3);
    assert.ok(child.stderr.includes(path.join(newDir, RESULT_FILE)), child.stderr);
  }));

test('比较：跑到花费上限的不完整结果不能比较——stderr 指名该档，exit 3，stdout 不印比较', () =>
  withTempRoot((root) => {
    const skipped = aggregate({ a: 1 });
    skipped.cases[0].arms = { with: [{ score: 1, skippedPaidGraders: true }] };
    for (const doc of [{ ...aggregate({ a: 1 }), partial: true }, skipped]) {
      const oldDir = writeResult(root, 'old', aggregate({ a: 0 }));
      const newDir = writeResult(root, 'new', doc);
      const child = compareCli(oldDir, newDir);
      assert.equal(child.status, 3, JSON.stringify(doc));
      assert.ok(child.stderr.includes(path.join(newDir, RESULT_FILE)), child.stderr);
      assert.equal(child.stdout, '');
    }
  }));

test('比较：每题新分数都不低于旧分数时没有退步', () => {
  const result = compareResults(aggregate({ a: 0.33, b: 1 }), aggregate({ a: 0.33, b: 1 }));
  assert.deepEqual(result.regressions, []);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(
    result.rows.map((row) => row.delta),
    [0, 0],
  );
});

test('比较：差值是新分数减旧分数', () => {
  const [row] = compareResults(aggregate({ a: 0.5 }), aggregate({ a: 1 })).rows;
  assert.equal(row.delta, 0.5);
});

test('比较：题目只出现在一边时列为缺题，并指出缺在哪一边', () => {
  const result = compareResults(
    aggregate({ 'trace-cites-archive': 1, 'drift-reports-only': 1 }),
    aggregate({ 'drift-reports-only': 1, 'audit-finds-dangerous-default': 1 }),
  );
  assert.deepEqual(result.missing, [
    { name: 'audit-finds-dangerous-default', missingFrom: 'old' },
    { name: 'trace-cites-archive', missingFrom: 'new' },
  ]);
  assert.deepEqual(
    result.rows.map((row) => row.name),
    ['drift-reports-only'],
  );
});

test('run：缺参数时列出缺少的参数，不启动评测', () => {
  const { errors } = parseRunArgs(['--specseal', 'target/debug/specseal', '--label', 'new-opus']);
  assert.ok(errors.some((error) => error.includes('--model')), errors.join('\n'));
  assert.ok(errors.some((error) => error.includes('--max-cost-usd')), errors.join('\n'));
});

/// 在暂存 repo 根目录放一支假的运行档，以及（选择性）一份已存在的结果。
function fakeRoot(root, { existingLabel } = {}) {
  writeFileSync(path.join(root, 'specseal bin'), '');
  if (existingLabel) writeResult(path.join(root, OUT_ROOT), existingLabel, '{}');
  return root;
}

function runArgs(root, overrides = {}) {
  const values = { specseal: path.join(root, 'specseal bin'), model: 'claude-haiku-5-5', label: 'old-haiku', 'max-cost-usd': '20', ...overrides };
  return Object.entries(values).flatMap(([name, value]) => [`--${name}`, value]);
}

test('run：参数齐全且合法时没有错误（运行档路径含空白也可以，脚本不经过 shell）', () =>
  withTempRoot((root) => {
    const { options, errors } = parseRunArgs(runArgs(fakeRoot(root)), root);
    assert.deepEqual(errors, []);
    assert.equal(options.runs, '3');
  }));

test('run：--label 只能是单一路径段，含 / 或 .. 时拒绝（否则会写出 target/skill-evals/ 之外）', () =>
  withTempRoot((root) => {
    for (const label of ['../escape', 'a/b', '..', '.hidden', 'a..b']) {
      const { errors } = parseRunArgs(runArgs(fakeRoot(root), { label }), root);
      assert.ok(errors.some((error) => error.includes('--label')), `${label}: ${errors.join('\n')}`);
    }
  }));

test('run：--max-cost-usd 必须是正数', () =>
  withTempRoot((root) => {
    for (const cost of ['abc', '0', '-5', 'Infinity', '20usd']) {
      const { errors } = parseRunArgs(runArgs(fakeRoot(root), { 'max-cost-usd': cost }), root);
      assert.ok(errors.some((error) => error.includes('--max-cost-usd')), `${cost}: ${errors.join('\n')}`);
    }
  }));

test('run：--runs 必须是 1 到 50 的整数', () =>
  withTempRoot((root) => {
    for (const runs of ['0', '1.5', '51', 'three']) {
      const { errors } = parseRunArgs([...runArgs(fakeRoot(root)), '--runs', runs], root);
      assert.ok(errors.some((error) => error.includes('--runs')), `${runs}: ${errors.join('\n')}`);
    }
  }));

test('run：--specseal 指向不存在的文件时拒绝', () =>
  withTempRoot((root) => {
    const { errors } = parseRunArgs(runArgs(fakeRoot(root), { specseal: path.join(root, 'nope') }), root);
    assert.ok(errors.some((error) => error.includes('--specseal')), errors.join('\n'));
  }));

test('run：同名 label 已有结果时拒绝，不覆盖付费跑出的结果', () =>
  withTempRoot((root) => {
    const { errors } = parseRunArgs(runArgs(fakeRoot(root, { existingLabel: 'old-haiku' })), root);
    assert.ok(errors.some((error) => error.includes('old-haiku')), errors.join('\n'));
  }));

test('run：任一 label 的暂存目录都不会落在另一个 label 的结果目录（重建暂存目录不会删到付费结果）', () => {
  const labels = ['old', 'plugin-old', 'bin-old', 'new-opus', 'staging'];
  const outDirs = labels.map((label) => runPaths(label, '/repo').outDir);
  const stagingDirs = labels.flatMap((label) => [runPaths(label, '/repo').binDir, runPaths(label, '/repo').pluginDir]);
  for (const staging of stagingDirs) {
    for (const out of outDirs) {
      assert.ok(staging !== out && !staging.startsWith(out + path.sep) && !out.startsWith(staging + path.sep), `${staging} vs ${out}`);
    }
  }
});

test('run：claude 子行程不读 stdin、输出不带颜色，PATH 以受测运行档的目录开头', () => {
  const options = evalSpawnOptions('/repo/bin', { PATH: '/usr/bin', HOME: '/home/user' });
  assert.equal(options.stdio[0], 'ignore');
  assert.equal(options.env.NO_COLOR, '1');
  assert.equal(options.env.PATH, `/repo/bin${path.delimiter}/usr/bin`);
  assert.equal(options.env.HOME, '/home/user');
});

/// prompt.md frontmatter 的 `tags: [skill:discuss, ...]`（题目一律写成 flow 形式）。
function caseTags(promptMarkdown) {
  const frontmatter = promptMarkdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const tags = frontmatter?.[1].match(/^tags:\s*\[([^\]]*)\]/m);
  return tags ? tags[1].split(',').map((tag) => tag.trim()) : [];
}

test('涵盖度：每个 specseal 技能都至少有一题评测', () => {
  const skills = readdirSync(path.join(ROOT, '.claude/skills'))
    .filter((name) => name.startsWith('specseal-'))
    .map((name) => name.slice('specseal-'.length));
  const covered = new Set(
    readdirSync(path.join(ROOT, EVALS_DIR), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => caseTags(readFileSync(path.join(ROOT, EVALS_DIR, entry.name, 'prompt.md'), 'utf8'))),
  );
  const missing = skills.filter((name) => !covered.has(`skill:${name}`)).sort();
  assert.deepEqual(missing, [], `这些技能没有评测题（${EVALS_DIR}/<题目>/prompt.md 的 tags 要含 skill:<短名>）：${missing.join(', ')}`);
});

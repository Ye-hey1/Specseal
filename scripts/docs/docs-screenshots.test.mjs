// 文档截屏场景脚本的把关与计划（user-documentation spec「用户文档以截屏呈现
// 实际接口」的脚本条款、design D1／D2）。
// 这支脚本唯一会碰用户环境的动作是搬移 desktop 的状态目录，因此测试一律以
// 注入的假路径与假侦测结果验证——本文档不得搬移、创建或删除任何真实目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  DEMO_CHANGES,
  DEMO_DISCUSSION,
  DEMO_MANUAL,
  DEMO_REVIEW,
  SHOT_DIR,
  SHOT_LIST,
  SHOT_LOCALES,
  appIsRunning,
  backupPlanFor,
  dryRunReport,
  manifestPathIn,
  pathsFor,
  prepareBackup,
  renderManualPage,
  restoreStepsFor,
  stateDirsFor,
} from './docs-screenshots.mjs';

const HOME = '/fake/home';
const TMP = '/fake/tmp';

/// 假的文档系统操作：只记录调用，永不动到真实路径。
function spyOps({ existing = [] } = {}) {
  const calls = [];
  return {
    calls,
    mutations: () => calls.filter((c) => c.op !== 'exists'),
    exists: (target) => {
      calls.push({ op: 'exists', target });
      return existing.includes(target);
    },
    mkdir: (target) => calls.push({ op: 'mkdir', target }),
    rename: (from, to) => calls.push({ op: 'rename', from, to }),
    writeFile: (target, body) => calls.push({ op: 'writeFile', target, body }),
  };
}

test('状态目录推导：macOS 上两个落点都挂在注入的 home 下，key 不重复', () => {
  const dirs = stateDirsFor({ home: HOME, platform: 'darwin' });
  assert.ok(dirs.length >= 2, '设置与 WebView 两份状态都要保护');
  for (const dir of dirs) {
    assert.ok(dir.path.startsWith(`${HOME}/`), `${dir.path} 必须落在注入的 home 下`);
    assert.ok(dir.label.length > 0, '每个落点要说明它装的是什幺');
  }
  assert.equal(new Set(dirs.map((d) => d.key)).size, dirs.length, 'key 不可重复');
});

test('状态目录推导：涵盖设置目录与 WebView 数据目录两处', () => {
  const paths = stateDirsFor({ home: HOME, platform: 'darwin' }).map((d) => d.path);
  // 连接设置在 appConfigDir；workspace 分页存在 WebView 的 localStorage，
  // 两者不同层，只搬其中一个会让截屏仍带着用户的真实 workspace 名称。
  assert.ok(
    paths.some((p) => p.includes('Application Support')),
    '要涵盖 appConfigDir（connections.json）',
  );
  assert.ok(paths.some((p) => p.includes('WebKit')), '要涵盖 WebView 数据目录（分页 localStorage）');
});

test('状态目录推导：非 macOS 明确拒绝并点名平台', () => {
  assert.throws(() => stateDirsFor({ home: HOME, platform: 'linux' }), /linux/);
  assert.throws(() => stateDirsFor({ home: HOME, platform: 'win32' }), /win32/);
});

test('工作路径推导：备份落在 home（可跨重开机救回）、示范 workspace 落在暂存区', () => {
  const { backupRoot, workspace } = pathsFor({ home: HOME, tmpdir: TMP });
  assert.ok(backupRoot.startsWith(`${HOME}/`), `备份路径 ${backupRoot} 要在 home 下`);
  assert.ok(workspace.startsWith(`${TMP}/`), `示范 workspace ${workspace} 要在暂存区`);
  assert.notEqual(backupRoot, workspace);
});

test('工作路径推导：示范 workspace 的目录名是中性的 acme-web（分页与窗口标题只显示这个名称）', () => {
  const { workspace } = pathsFor({ home: HOME, tmpdir: TMP });
  assert.equal(path.posix.basename(workspace), 'acme-web');
});

test('备份计划：每个来源有互不相同的落点，全部收在备份根目录下', () => {
  const stateDirs = stateDirsFor({ home: HOME, platform: 'darwin' });
  const backupRoot = `${HOME}/.backup`;
  const plan = backupPlanFor({ stateDirs, backupRoot, exists: () => true });

  assert.equal(plan.length, stateDirs.length);
  assert.equal(new Set(plan.map((e) => e.backup)).size, plan.length, '落点不可互相覆盖');
  for (const entry of plan) {
    assert.equal(path.dirname(entry.backup), backupRoot);
    assert.equal(entry.existed, true);
  }
});

test('备份计划：existed 逐项反映来源是否真的存在', () => {
  const stateDirs = [
    { key: 'a', label: 'A', path: '/fake/a' },
    { key: 'b', label: 'B', path: '/fake/b' },
  ];
  const plan = backupPlanFor({
    stateDirs,
    backupRoot: '/fake/backup',
    exists: (target) => target === '/fake/a',
  });
  assert.deepEqual(
    plan.map((e) => [e.key, e.existed]),
    [
      ['a', true],
      ['b', false],
    ],
  );
});

test('还原步骤：原本存在的搬回，原本不存在的删除而非搬回', () => {
  const steps = restoreStepsFor([
    { key: 'a', source: '/fake/a', backup: '/fake/backup/a', existed: true },
    { key: 'b', source: '/fake/b', backup: '/fake/backup/b', existed: false },
  ]);
  assert.deepEqual(
    steps.map((s) => [s.key, s.action]),
    [
      ['a', 'restore'],
      ['b', 'discard'],
    ],
  );
  // discard 这条不可带着备份路径走搬回分支——原本就没有备份可搬。
  assert.equal(steps[1].backup, undefined);
});

test('app 侦测：pgrep 找到即运行中，没找到即未运行', () => {
  assert.equal(appIsRunning({ status: 0 }), true);
  assert.equal(appIsRunning({ status: 1 }), false);
});

test('app 侦测：pgrep 本身失败不可当成「没在跑」', () => {
  assert.throws(() => appIsRunning({ status: 2 }), /pgrep|侦测/);
  assert.throws(() => appIsRunning({ error: new Error('ENOENT') }), /ENOENT|pgrep|侦测/);
  assert.throws(() => appIsRunning({ status: null, signal: 'SIGKILL' }), /SIGKILL|pgrep|侦测/);
});

test('备份把关：侦测到 app 运行中即以错误收场，且不搬移任何目录', () => {
  const ops = spyOps();
  assert.throws(
    () =>
      prepareBackup({
        platform: 'darwin',
        home: HOME,
        backupRoot: `${HOME}/.backup`,
        isRunning: true,
        ops,
      }),
    /运行中|结束/,
  );
  assert.deepEqual(ops.mutations(), [], '拒绝的路径上不得有任何创建或搬移');
});

test('备份把关：备份路径已存在（上一次没还原）即拒绝，不覆盖既有备份', () => {
  const backupRoot = `${HOME}/.backup`;
  const ops = spyOps({ existing: [backupRoot] });
  assert.throws(
    () => prepareBackup({ platform: 'darwin', home: HOME, backupRoot, isRunning: false, ops }),
    (error) => {
      assert.match(error.message, /--restore/, '要告诉用户怎幺救回上一次的备份');
      assert.ok(error.message.includes(backupRoot), '要点名备份路径');
      return true;
    },
  );
  assert.deepEqual(ops.mutations(), [], '拒绝的路径上不得有任何创建或搬移');
});

test('备份把关：非 macOS 即拒绝，不搬移任何目录', () => {
  const ops = spyOps();
  assert.throws(
    () =>
      prepareBackup({
        platform: 'linux',
        home: HOME,
        backupRoot: `${HOME}/.backup`,
        isRunning: false,
        ops,
      }),
    /linux/,
  );
  assert.deepEqual(ops.mutations(), [], '拒绝的路径上不得有任何创建或搬移');
});

test('备份运行：只搬移确实存在的来源，并写下供 --restore 判读的清单', () => {
  const backupRoot = `${HOME}/.backup`;
  const stateDirs = stateDirsFor({ home: HOME, platform: 'darwin' });
  const ops = spyOps({ existing: [stateDirs[0].path] });

  const plan = prepareBackup({
    platform: 'darwin',
    home: HOME,
    backupRoot,
    isRunning: false,
    ops,
  });

  const renames = ops.calls.filter((c) => c.op === 'rename');
  assert.deepEqual(renames, [{ op: 'rename', from: stateDirs[0].path, to: plan[0].backup }]);

  const manifest = ops.calls.find((c) => c.op === 'writeFile');
  assert.equal(manifest.target, manifestPathIn(backupRoot));
  assert.deepEqual(JSON.parse(manifest.body).entries, plan);
});

test('示范内容：提案中、进行中、已就绪、已封存四态齐备，至少两个已封存，另有一则讨论', () => {
  const states = DEMO_CHANGES.map((c) => c.state);
  for (const state of ['proposed', 'in-progress', 'ready', 'archived']) {
    assert.ok(states.includes(state), `示范内容缺少 ${state} 的变更，看板会有空栏`);
  }
  assert.ok(
    states.filter((state) => state === 'archived').length >= 2,
    '规格页要有两份以上的正式规格，至少要两个已封存的变更',
  );
  assert.equal(DEMO_DISCUSSION.status, 'concluded');
  assert.ok(DEMO_DISCUSSION.rounds.length >= 1, '讨论页要有回合内容才不是空的');
  assert.ok(DEMO_DISCUSSION.conclusion.length > 0);
});

test('示范内容：每个变更都是 kebab-case 并带齐四份 artifact', () => {
  for (const change of DEMO_CHANGES) {
    assert.match(change.name, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, `${change.name} 不是 kebab-case`);
    for (const key of ['proposal', 'design', 'tasks', 'spec']) {
      assert.ok(change.artifacts[key]?.trim().length > 0, `${change.name} 缺 ${key}`);
    }
    assert.match(change.artifacts.tasks, /- \[ \] /, '任务清单要有可勾选的项目');
  }
});

test('示范内容：已封存的变更带 Purpose（archive 对新 capability 的硬需求）', () => {
  for (const change of DEMO_CHANGES.filter((c) => c.state === 'archived')) {
    assert.match(change.artifacts.spec, /^## Purpose$/m, `${change.name} 少了 Purpose，archive 会拒绝`);
  }
});

test('示范内容：已就绪的变更任务全部勾完但不封存，才会落在已就绪栏', () => {
  for (const change of DEMO_CHANGES.filter((c) => c.state === 'ready')) {
    assert.equal(change.completedTasks, null, `${change.name} 要勾完全部任务`);
  }
});

test('示范内容：进行中的变更只完成一部分任务，卡片才看得到进度', () => {
  for (const change of DEMO_CHANGES.filter((c) => c.state === 'in-progress')) {
    const total = change.artifacts.tasks.match(/^- \[ \] /gm)?.length ?? 0;
    assert.ok(change.completedTasks > 0, `${change.name} 应有已完成任务`);
    assert.ok(change.completedTasks < total, `${change.name} 不该全部完成（那是已封存的形状）`);
  }
});

test('待拍清单：十七个文档名，中英接口各一组（截屏依语言分目录、文档名相同）', () => {
  assert.deepEqual(
    SHOT_LIST.map((s) => s.file),
    [
      'desktop-board.png',
      'desktop-change-detail.png',
      'desktop-discussion.png',
      'desktop-spec.png',
      'desktop-archived.png',
      'desktop-manual.png',
      'desktop-settings.png',
      'server-setup.png',
      'server-overview.png',
      'server-members.png',
      'server-project.png',
      'desktop-tray.png',
      'claude-code-panel.png',
      'claude-code-quality.png',
      'claude-code-hash-menu.png',
      'herdr-panel.png',
      'herdr-skill-picker.png',
    ],
  );
  assert.deepEqual(SHOT_LOCALES, ['en', 'zh-CN']);
  for (const shot of SHOT_LIST) {
    assert.match(shot.file, /^(desktop|server|claude-code|herdr)-[a-z-]+\.png$/, `${shot.file} 命名不符`);
    assert.ok(shot.what.length > 0, `${shot.file} 要说明拍什幺`);
  }
});

test('dry-run 报告：印出备份来源与落点、示范内容与待拍清单，且不触发任何搬移', () => {
  const backupRoot = `${HOME}/.backup`;
  const workspace = `${TMP}/workspace`;
  const stateDirs = stateDirsFor({ home: HOME, platform: 'darwin' });
  const plan = backupPlanFor({ stateDirs, backupRoot, exists: () => true });
  const report = dryRunReport({ plan, workspace }).join('\n');

  for (const entry of plan) {
    assert.ok(report.includes(entry.source), `报告要点名来源 ${entry.source}`);
    assert.ok(report.includes(entry.backup), `报告要点名落点 ${entry.backup}`);
  }
  assert.ok(report.includes(workspace), '报告要点名示范 workspace 路径');
  for (const change of DEMO_CHANGES) {
    assert.ok(report.includes(change.name), `报告要列出示范变更 ${change.name}`);
  }
  assert.ok(report.includes(DEMO_DISCUSSION.topic), '报告要列出示范讨论');
  for (const shot of SHOT_LIST) {
    assert.ok(report.includes(shot.file), `报告要列出待拍的 ${shot.file}`);
  }
  for (const locale of SHOT_LOCALES) {
    assert.ok(report.includes(`${SHOT_DIR}/${locale}/`), `报告要点名 ${locale} 的存放目录`);
  }
  for (const page of DEMO_MANUAL) {
    assert.ok(report.includes(page.title), `报告要列出示范手册页 ${page.title}`);
  }
  assert.match(
    report,
    new RegExp(`审查工单.*${DEMO_REVIEW.change}`),
    '报告要列出示范审查工单与它所属的变更',
  );
});

test('示范审查工单：开在已就绪的变更上，第一轮一条 WARNING、一条 SUGGESTION', () => {
  const change = DEMO_CHANGES.find((c) => c.name === DEMO_REVIEW.change);
  assert.ok(change, `${DEMO_REVIEW.change} 不在示范变更里`);
  assert.equal(change.state, 'ready', '只有已就绪的变更才会被送进品质关卡');
  assert.deepEqual(
    DEMO_REVIEW.findings.map((f) => f.severity),
    ['WARNING', 'SUGGESTION'],
  );
  for (const finding of DEMO_REVIEW.findings) {
    assert.ok(finding.text.trim().length > 0, '每条 finding 都要有内容');
  }
});

test('示范审查工单：finding 只落在示范档上（add-round 拒收冻结范围外的路径）', () => {
  const { file, findings } = DEMO_REVIEW;
  assert.match(file.path, /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\.[a-z]+$/, `${file.path} 要是 repo 相对路径`);
  assert.ok(file.body.trim().length > 0, '示范档要有内容，冻结的 patch 才不是空的');
  for (const finding of findings) {
    assert.equal(finding.path, file.path, `${finding.path} 不在冻结范围内`);
  }
});

test('示范手册：至少三页，含必产的 index.md 与 about.md，order 不重复', () => {
  const files = DEMO_MANUAL.map((page) => page.file);
  assert.ok(files.length >= 3, `示范手册只有 ${files.length} 页`);
  assert.ok(files.includes('index.md'), '手册缺 index.md');
  assert.ok(files.includes('about.md'), '手册缺 about.md');
  const orders = DEMO_MANUAL.map((page) => page.order);
  assert.equal(new Set(orders).size, orders.length, 'order 必须全手册唯一');
  for (const file of files) assert.match(file, /^[a-z][a-z0-9-]*\.md$/, `${file} 不是 kebab-case 文档名`);
});

test('示范手册：frontmatter 恰为六栏、generated 为带时区的秒级时戳、页脚有出处行', () => {
  const generated = '2026-10-15T10:00:00+08:00';
  for (const page of DEMO_MANUAL) {
    const text = renderManualPage(page, generated);
    const [, frontmatter, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? [];
    assert.ok(frontmatter, `${page.file} 没有 frontmatter`);
    const keys = frontmatter.split('\n').map((line) => line.split(':')[0]);
    assert.deepEqual(keys, ['title', 'section', 'order', 'keywords', 'sources', 'generated']);
    assert.match(frontmatter, new RegExp(`^generated: ${generated.replace('+', '\\+')}$`, 'm'));
    const lastLine = body.trim().split('\n').pop();
    assert.match(lastLine, /^\*\*出处\*\*：/, `${page.file} 的最后一行要是出处行`);
  }
});

test('示范手册：sources 只引用示范里已封存变更的 capability', () => {
  const canonical = new Set(DEMO_CHANGES.filter((c) => c.state === 'archived').map((c) => c.capability));
  for (const page of DEMO_MANUAL) {
    for (const source of page.sources) {
      assert.ok(canonical.has(source), `${page.file} 引用了不存在的规格 ${source}`);
    }
  }
  assert.ok(
    DEMO_MANUAL.some((page) => page.sources.length > 0),
    '至少一页要有出处，出处行的规格签才拍得到',
  );
});

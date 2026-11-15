// Herdr 面板的纯逻辑（integrations/herdr/mods/specseal/model.js）：CLI 输出怎么变成
// 面板的列、每一列有哪些技能钮、技能要送给谁。画面与 Herdr API 不在这里测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALL_SKILLS,
  APP_ID,
  PICKER_ROWS,
  PICKER_SKILLS,
  PICKER_VARIANTS,
  SKILL_GROUPS,
  customPlacePlan,
  customTabPlan,
  defaultAgent,
  hasSpecsealSkills,
  missingSkillsPlan,
  onlyClaude,
  pickerGroups,
  pickerStep,
  pluginFolders,
  skillEntries,
  skillFolders,
  skillRows,
  skillUse,
  usableAgents,
  attachPlan,
  agentChange,
  batchPlan,
  buildBoard,
  canOpenProject,
  changeActions,
  changeAgents,
  changeSkills,
  commandText,
  deliveryHint,
  discussionActions,
  unrecordedDiscussions,
  discussionAgents,
  discussionSkills,
  inside,
  isUninitialized,
  joinAgents,
  groupedOrder,
  lastOpenError,
  logoOpenAttempts,
  newTabPlan,
  parseStations,
  placePlan,
  planDelivery,
  rowChoices,
  sendArgs,
  commandLabels,
  hookLabels,
  promptLabels,
  skillLabels,
  skillTargets,
  statusCounts,
  statusSections,
  specsealUrl,
  stampedPaths,
  startChoices,
  stationStates,
  stationViews,
  waveToStart,
} from '../../integrations/herdr/mods/specseal/model.js';
import { TO_EN, TO_ZH, autoTr, langFrom, setLang, tr, translateHerdr } from '../../integrations/herdr/mods/specseal/i18n.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO = '/work/repo';
const TREE = '/work/repo.worktrees/add-a';

const row = (over = {}) => ({
  name: 'add-a',
  stage: 'in-progress',
  wave: 1,
  blockedBy: [],
  completed: 1,
  total: 3,
  worktree: null,
  restale: false,
  ...over,
});
const agent = (over = {}) => ({
  address: 't1',
  status: 'done',
  key: 'claude',
  cwd: REPO,
  title: '',
  labels: {},
  tab: 'tab1',
  ...over,
});
const CLAUDE = [{ key: 'claude', run: ['claude'], installed: true }];
const ctx = (over = {}) => ({
  root: REPO,
  agents: [],
  focus: { tab: 'tab1', terminal: null },
  known: CLAUDE,
  ...over,
});

// ---- 面板数据 ----

test('buildBoard：阶段、波次、顺序取自 plan，任务数与 worktree 取自 list', () => {
  const board = buildBoard(
    {
      changes: [
        { name: 'add-b', completedTasks: 2, totalTasks: 4, status: 'in-progress' },
        {
          name: 'add-a',
          completedTasks: 0,
          totalTasks: 3,
          status: 'in-progress',
          worktree: { path: TREE, branch: 'specseal/add-a' },
          restaleFrom: ['talk'],
        },
      ],
    },
    {
      changes: [
        { name: 'add-a', wave: 1, stage: 'proposed', blockedBy: [] },
        { name: 'add-b', wave: 2, stage: 'in-progress', blockedBy: ['add-a'] },
      ],
      skipped: [],
      unpromotedCuts: [],
    },
    { discussions: [] },
  );
  assert.deepEqual(board.stages.proposed, [
    {
      name: 'add-a',
      stage: 'proposed',
      wave: 1,
      blockedBy: [],
      completed: 0,
      total: 3,
      codeRemaining: null,
      worktree: { path: TREE, branch: 'specseal/add-a' },
      restale: true,
      stations: { review: 'none', verify: 'none' },
    },
  ]);
  assert.deepEqual(board.stages['in-progress'][0].blockedBy, ['add-a']);
  assert.deepEqual(board.stages.ready, []);
});

test('isUninitialized：只认没有项目的那句，设置档坏掉仍算错误', () => {
  assert.equal(isUninitialized("Error: Not initialized. Run 'specseal init' to initialize."), true);
  assert.equal(isUninitialized('Error: failed to parse .specseal.yaml'), false);
});

test('buildBoard：metadata 坏掉的变更不会凭空消失', () => {
  const skipped = [{ change: 'bad', reason: 'parse error' }];
  const board = buildBoard({ changes: [] }, { changes: [], skipped, unpromotedCuts: [] }, { discussions: [] });
  assert.deepEqual(board.skipped, skipped);
});

test('buildBoard：讨论依 status 分流，还有刀没转出的已转出讨论留在讨论卡', () => {
  const board = buildBoard(
    { changes: [] },
    {
      changes: [],
      skipped: [],
      unpromotedCuts: [
        { discussion: 'in-flight', cut: 'cut 2', title: '', changes: ['add-b', 'add-c'], unpromoted: ['add-c'] },
      ],
    },
    {
      discussions: [
        { slug: 'talk', topic: '主题', status: 'open' },
        { slug: 'done-talk', topic: '定案', status: 'concluded' },
        { slug: 'in-flight', topic: '转出一半', status: 'promoted' },
        { slug: 'all-out', topic: '全转出', status: 'promoted' },
      ],
    },
  );
  assert.deepEqual(
    board.discussions.map((d) => [d.slug, d.cuts]),
    [
      ['talk', []],
      ['done-talk', []],
      ['in-flight', ['add-c']],
    ],
  );
  assert.deepEqual(
    board.promoted.map((d) => d.slug),
    ['all-out'],
  );
});

// ---- 技能表 ----

const names = (skills) => skills.map((s) => s.skill);
const primary = (skills) => skills.filter((s) => s.primary).map((s) => s.skill);

test('buildBoard：程序任务数取自 instructions，已就绪一定是 0，查不到是 null', () => {
  const board = buildBoard(
    { changes: [] },
    {
      changes: [
        { name: 'add-a', wave: 1, stage: 'in-progress', blockedBy: [] },
        { name: 'add-b', wave: 1, stage: 'in-progress', blockedBy: [] },
        { name: 'add-c', wave: 1, stage: 'ready', blockedBy: [] },
      ],
    },
    { discussions: [] },
    { 'add-a': 2 },
  );
  assert.deepEqual(board.stages['in-progress'].map((r) => r.codeRemaining), [2, null]);
  assert.equal(board.stages.ready[0].codeRemaining, 0);
});

test('changeSkills：提案中且没被挡，建议 apply', () => {
  const skills = changeSkills(row({ stage: 'proposed' }));
  assert.deepEqual(names(skills), ['apply', 'analyze', 'ingest', 'drift', 'commit']);
  assert.deepEqual(primary(skills), ['apply']);
});

test('changeSkills：被挡时 apply 要等前一个变更，也不算建议', () => {
  const skills = changeSkills(row({ stage: 'proposed', blockedBy: ['add-z'] }));
  assert.deepEqual(skills.find((s) => s.skill === 'apply').waitingFor, ['add-z']);
  assert.deepEqual(primary(skills), []);
});

test('changeSkills：提案中可以选 worktree，建议仍是 apply', () => {
  const skills = changeSkills(row({ stage: 'proposed' }), true);
  assert.deepEqual(names(skills), ['apply', 'apply-with-worktree', 'analyze', 'ingest', 'drift', 'commit']);
  assert.deepEqual(primary(skills), ['apply']);
});

test('changeSkills：不能选 worktree 的情况不多这一颗', () => {
  const absent = (over, policy = true) =>
    assert.ok(!names(changeSkills(row({ stage: 'proposed', ...over }), policy)).includes('apply-with-worktree'), JSON.stringify(over));
  absent({}, false); // 工作流设置没开
  absent({ worktree: { path: TREE, branch: 'b' } }); // 已有 worktree，apply 钮会接续它
  absent({ blockedBy: ['add-z'] }); // 被挡住
  absent({ restale: true }); // 讨论重新定案，要先 ingest
  absent({ codeRemaining: 0 }); // 只剩手动任务
  absent({ stage: 'in-progress' }); // 已经开始做，地方已经决定了
  absent({ stage: 'ready' });
});

test('changeSkills：进行中建议 apply', () => {
  const skills = changeSkills(row());
  assert.deepEqual(names(skills), ['apply', 'ingest', 'drift', 'verify', 'quality', 'review', 'analyze', 'commit']);
  assert.deepEqual(primary(skills), ['apply']);
});

test('changeSkills：程序任务都做完、只剩手动任务时，建议 quality', () => {
  assert.deepEqual(primary(changeSkills(row({ codeRemaining: 0 }))), ['quality']);
  assert.deepEqual(primary(changeSkills(row({ codeRemaining: 1 }))), ['apply']);
});

test('changeSkills：有 worktree 时每个阶段都能合并，也都不能封存', () => {
  const worktree = { path: TREE, branch: 'b' };
  for (const stage of ['proposed', 'in-progress', 'ready']) {
    const skills = names(changeSkills(row({ stage, worktree })));
    assert.ok(skills.includes('worktree-merge'), stage);
    assert.ok(!skills.includes('archive'), stage);
  }
  assert.ok(!names(changeSkills(row({ stage: 'ready' }))).includes('worktree-merge'), '没有 worktree 就不能合并');
});

test('skillTargets：worktree-merge 列出有 worktree 的变更；quality、review 也列出进行中的变更', () => {
  const board = {
    stages: {
      proposed: [row({ name: 'add-new', stage: 'proposed' })],
      'in-progress': [row({ name: 'add-half', codeRemaining: 1 }), row({ name: 'add-tree', worktree: { path: TREE, branch: 'b' } })],
      ready: [row({ name: 'add-done', stage: 'ready' })],
    },
    discussions: [],
  };
  const targetNames = (skill) => skillTargets(skill, board).map((t) => t.name);
  assert.deepEqual(targetNames('worktree-merge'), ['add-tree']);
  assert.deepEqual(targetNames('quality'), ['add-half', 'add-tree', 'add-done']);
  assert.deepEqual(targetNames('review'), ['add-half', 'add-tree', 'add-done']);
});

test('quality、review：程序任务没做完时不能开也不能放，手动任务不算', () => {
  const left = { kind: 'change', name: 'add-a', args: 'add-a', row: row({ codeRemaining: 2 }) };
  const done = { kind: 'change', name: 'add-a', args: 'add-a', row: row({ codeRemaining: 0 }) };
  const here = { address: 't1', tab: 'tb1' };
  const agents = [agent({ tab: 'tb1', address: 't1', key: 'claude', status: 'idle' })];
  for (const skill of ['quality', 'review']) {
    assert.equal(newTabPlan({ ...TAB, skill, target: left }).reason, '还有 2 个程序任务没做完');
    assert.equal(newTabPlan({ ...TAB, skill, target: done }).kind, 'tab');
    assert.equal(placePlan({ skill, target: left, note: '', agents, focus: { tab: here.tab, terminal: here.address } }).reason, '还有 2 个程序任务没做完');
    assert.equal(placePlan({ skill, target: done, note: '', agents, focus: { tab: here.tab, terminal: here.address } }).kind, 'place');
  }
  assert.equal(newTabPlan({ ...TAB, skill: 'verify', target: left }).kind, 'tab', 'verify 可以中途跑');
  assert.equal(newTabPlan({ ...TAB, skill: 'worktree-merge', target: left }).kind, 'tab', '合并不看任务');
});

test('开工：只剩手动任务时没有开工钮，因为没有程序要写', () => {
  assert.equal(startChoices(row({ codeRemaining: 0 }), ctx({ worktreePolicy: true })), null);
  assert.ok(startChoices(row({ codeRemaining: 1 }), ctx({ worktreePolicy: true })));
});

test('changeSkills：已就绪且没有 worktree 可封存，建议 quality', () => {
  const skills = changeSkills(row({ stage: 'ready' }));
  assert.deepEqual(names(skills), ['quality', 'review', 'verify', 'archive', 'archive+commit', 'ingest', 'drift', 'commit']);
  assert.deepEqual(primary(skills), ['quality']);
});

test('changeSkills：已就绪且有 worktree 要先合并，不能封存', () => {
  const skills = changeSkills(row({ stage: 'ready', worktree: { path: TREE, branch: 'b' } }));
  assert.deepEqual(names(skills), ['quality', 'review', 'verify', 'ingest', 'drift', 'commit', 'worktree-merge']);
});

test('changeSkills：没有阶段限制的技能每个阶段都有', () => {
  for (const stage of ['proposed', 'in-progress', 'ready']) {
    const skills = names(changeSkills(row({ stage })));
    for (const skill of ['ingest', 'drift', 'commit']) assert.ok(skills.includes(skill), `${stage} 要有 ${skill}`);
  }
});

test('commandLabels：只认会动到变更或讨论的 specseal 指令，名称的引号要拿掉', () => {
  const change = (name) => [`specseal.change=${name}`, 'specseal.discussion='];
  assert.deepEqual(commandLabels('specseal instructions apply --change "add-a" --json'), change('add-a'));
  assert.deepEqual(commandLabels('cd /x && specseal instructions apply --change add-a --json'), change('add-a'));
  assert.deepEqual(commandLabels('SPECSEAL_WORKTREE=true specseal in-progress add add-a'), change('add-a'));
  assert.deepEqual(commandLabels('specseal new change "add-a" --schema spec-driven --agent claude'), change('add-a'));
  assert.deepEqual(commandLabels('specseal task done --change add-a tsk_1'), change('add-a'));
  assert.deepEqual(commandLabels('specseal review prepare "add-a" --base abc'), change('add-a'));
  assert.deepEqual(commandLabels('specseal verify prepare add-a'), change('add-a'));
  assert.deepEqual(commandLabels('specseal archive add-a -y'), change('add-a'));
  const talk = (slug) => ['specseal.change=', `specseal.discussion=${slug}`];
  assert.deepEqual(commandLabels('specseal discuss new "要不要改" --slug talk-a --kind x'), talk('talk-a'));
  assert.deepEqual(commandLabels("specseal discuss add-round talk-a --stdin <<'EOF'"), talk('talk-a'));
  assert.deepEqual(commandLabels('specseal discuss conclude talk-a --stdin'), talk('talk-a'));
});

test('commandLabels：specseal 带路径或先存进变量也认得', () => {
  const talk = (slug) => ['specseal.change=', `specseal.discussion=${slug}`];
  const change = (name) => [`specseal.change=${name}`, 'specseal.discussion='];
  assert.deepEqual(commandLabels("cd /x; ~/.local/bin/specseal discuss add-round talk-a --mode assumptions --stdin <<'EOF'"), talk('talk-a'));
  assert.deepEqual(commandLabels('"$HOME/.local/bin/specseal" archive add-a -y'), change('add-a'));
  assert.deepEqual(commandLabels('./target/debug/specseal task done --change add-a tsk_1'), change('add-a'));
  assert.deepEqual(commandLabels('S=~/.local/bin/specseal; $S discuss new "要不要改" --slug talk-a 2>&1 | tail -3'), talk('talk-a'));
  assert.deepEqual(commandLabels('cd /x && S=~/.local/bin/specseal; ${S} discuss conclude talk-a --stdin'), talk('talk-a'));
  // 变量不是 specseal、或 specseal 只是别的指令的参数时不算。
  assert.equal(commandLabels('T=/usr/bin/tar; $T archive add-a'), null);
  assert.equal(commandLabels('cat ~/.local/bin/specseal archive add-a'), null);
  assert.equal(commandLabels('S=~/.local/bin/specseal; echo $S discuss conclude talk-a'), null);
});

test('commandLabels：查找、提到和参数不是名称时都不算', () => {
  for (const command of [
    'specseal show add-a',
    'specseal status --change add-a --json',
    'specseal artifact cat tasks --change add-a',
    'specseal plan --json',
    'specseal discuss show talk-a --json',
    'specseal review prepare --base abc',
    'git commit -m "specseal archive add-a"',
    'echo specseal archive add-a',
    "cat <<'EOF'\nspecseal archive add-a\nEOF",
    'grep specseal README.md',
    '',
  ]) {
    assert.equal(commandLabels(command), null, command);
  }
});

test('hookLabels：依事件决定看哪个字段', () => {
  const apply = ['specseal.skill=specseal-apply', 'specseal.change=add-a', 'specseal.discussion='];
  assert.deepEqual(hookLabels({ hook_event_name: 'UserPromptSubmit', prompt: '/specseal-apply add-a' }), apply);
  assert.deepEqual(hookLabels({ hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'specseal-apply', args: 'add-a' } }), apply);
  assert.deepEqual(hookLabels({ hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'specseal-quality' } }), ['specseal.skill=specseal-quality', 'specseal.discussion=']);
  assert.equal(hookLabels({ hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'frontend-design' } }), null, '别的技能不算');
  assert.deepEqual(hookLabels({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'specseal archive add-a' } }), ['specseal.change=add-a', 'specseal.discussion=']);
  assert.equal(hookLabels({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'x' } }), null);
  const cleared = ['specseal.change=', 'specseal.discussion=', 'specseal.skill='];
  assert.deepEqual(hookLabels({ hook_event_name: 'SessionStart', source: 'clear' }), cleared);
  assert.deepEqual(hookLabels({ hook_event_name: 'SessionStart', source: 'resume' }), cleared);
  assert.equal(hookLabels({ hook_event_name: 'SessionStart', source: 'startup' }), null, 'hc run 开的 agent 一开始就有标签，不能清');
  assert.equal(hookLabels({ hook_event_name: 'SessionStart', source: 'compact' }), null, '压缩不换对话');
});

test('changeSkills：讨论重新定案时建议改成 ingest', () => {
  assert.deepEqual(primary(changeSkills(row({ restale: true }))), ['ingest']);
  const ready = changeSkills(row({ stage: 'ready', restale: true }));
  assert.deepEqual(primary(ready), ['ingest']);
  assert.ok(names(ready).includes('ingest'));
});

test('discussionSkills：依讨论状态决定建议', () => {
  const d = (over) => ({ slug: 's', topic: 't', status: 'open', cuts: [], ...over });
  assert.deepEqual(discussionSkills(d()), [{ skill: 'discuss', args: 's', primary: true }]);
  assert.deepEqual(discussionSkills(d({ status: 'concluded' })), [
    { skill: 'propose', args: '--from-discussion s', primary: true },
    { skill: 'discuss', args: 's', primary: false },
  ]);
  assert.deepEqual(names(discussionSkills(d({ status: 'promoted', cuts: ['add-c'] }))), ['propose', 'discuss']);
  assert.deepEqual(discussionSkills(d({ status: 'promoted' })), [{ skill: 'discuss', args: 's', primary: false }]);
});

test('技能选择器覆盖引擎注册表，不依赖当前项目是否启用 worktree', () => {
  const source = readFileSync(path.join(ROOT, 'crates/engine/specseal-core/src/workspace/skills.rs'), 'utf8');
  const registry = source.match(/pub fn registry\([^]*?\n}/)?.[0];
  assert.ok(registry, '找不到引擎技能注册表');
  const written = [...registry.matchAll(/\bSkill\s*\{\s*name:\s*"([^"]+)"/g)].map((match) => match[1]).sort();
  assert.ok(written.length > 0, '技能注册表不能为空');
  assert.deepEqual([...ALL_SKILLS].sort(), written);
});

// ---- 指令文本 ----

test('commandText：Claude Code、Copilot 用斜线，Codex 用钱字号', () => {
  assert.equal(commandText('claude', 'apply', 'add-a'), '/specseal-apply add-a');
  assert.equal(commandText('copilot', 'apply', 'add-a'), '/specseal-apply add-a');
  assert.equal(commandText('codex', 'apply', 'add-a'), '$specseal-apply add-a');
  assert.equal(commandText('claude', 'improve'), '/specseal-improve');
});

test('sendArgs：idle 用 --if idle；done 不带旗标（--if idle 会拒绝 done）；其余不送', () => {
  assert.deepEqual(sendArgs(agent({ status: 'idle' }), 'x'), ['send', '--if', 'idle', 't1', 'x']);
  assert.deepEqual(sendArgs(agent({ status: 'done' }), 'x'), ['send', 't1', 'x']);
  for (const status of ['working', 'blocked', 'error']) {
    assert.equal(sendArgs(agent({ status }), 'x'), null);
  }
});

// ---- 谁在做这个变更 ----

test('inside：同文件夹与子文件夹算在内，同前缀的兄弟文件夹不算', () => {
  assert.equal(inside(REPO, REPO), true);
  assert.equal(inside(`${REPO}/crates`, REPO), true);
  assert.equal(inside(TREE, REPO), false);
  assert.equal(inside(null, REPO), false);
});

test('changeAgents：依标签、worktree 路径、插件回报的焦点的顺序，同一个 agent 不重复', () => {
  const byFocus = agent({ address: 't3', labels: { 'specseal.focus': 'add-a' } });
  const byPath = agent({ address: 't2', cwd: TREE });
  const byLabel = agent({ address: 't1', labels: { 'specseal.change': 'add-a' } });
  const other = agent({ address: 't4', labels: { 'specseal.focus': 'add-z' } });
  const found = changeAgents(row({ worktree: { path: TREE, branch: 'b' } }), [byFocus, other, byPath, byLabel]);
  assert.deepEqual(
    found.map((a) => a.address),
    ['t1', 't2', 't3'],
  );
});

test('commandLabels：从讨论创建变更时，讨论标签留着', () => {
  const both = (name, slug) => [`specseal.change=${name}`, `specseal.discussion=${slug}`];
  assert.deepEqual(commandLabels('specseal new change "add-a" --schema spec-driven --agent claude --from-discussion talk'), both('add-a', 'talk'));
  assert.deepEqual(commandLabels('S=~/.local/bin/specseal; $S new change add-a --from-discussion "talk" --last'), both('add-a', 'talk'));
  // 同一行的别的指令提到 --from-discussion 不算
  assert.deepEqual(commandLabels('specseal new change add-a --agent claude; echo --from-discussion talk'), ['specseal.change=add-a', 'specseal.discussion=']);
});

test('changeAgents：写完提案停下来的 agent 不算在做这个变更，还在写或在等回答时才算', () => {
  const proposer = (status) => agent({ address: `t-${status}`, status, labels: { 'specseal.skill': 'specseal-propose', 'specseal.change': 'add-a' } });
  const found = changeAgents(row(), ['done', 'idle', 'working', 'blocked'].map(proposer)).map((a) => a.address);
  assert.deepEqual(found, ['t-working', 't-blocked']);
  // 同一个 session 之后自己跑 apply，就算回来
  const applying = agent({ labels: { 'specseal.skill': 'specseal-apply', 'specseal.change': 'add-a' } });
  assert.equal(changeAgents(row(), [applying]).length, 1);
  // 侧栏的进度也跟着：写完的提案 agent 不对应任何变更
  const board = { stages: { proposed: [row({ stage: 'proposed' })], 'in-progress': [], ready: [] } };
  assert.equal(agentChange(proposer('done'), board), null);
});

test('changeAgents：不看终端机标题，标题可能过时或只是提到变更', () => {
  const change = row({ name: 'add-a' });
  const titled = agent({ address: 't1', title: 'apply · add-a' });
  const none = agent({ address: 't2', title: 'apply · add-a', labels: { 'specseal.focus': '-' } });
  assert.deepEqual(changeAgents(change, [titled, none]), []);
});

test('skillLabels：做变更的技能记下变更，讨论的技能记下讨论，用不到的标签要清掉', () => {
  assert.deepEqual(skillLabels('apply', 'add-a'), ['specseal.skill=specseal-apply', 'specseal.change=add-a', 'specseal.discussion=']);
  assert.deepEqual(skillLabels('quality'), ['specseal.skill=specseal-quality', 'specseal.discussion='], '没指定就不动变更');
  assert.deepEqual(skillLabels('discuss', 'talk'), ['specseal.skill=specseal-discuss', 'specseal.change=', 'specseal.discussion=talk']);
  assert.deepEqual(skillLabels('propose'), ['specseal.skill=specseal-propose', 'specseal.change=', 'specseal.discussion=']);
  assert.deepEqual(skillLabels('improve', 'x'), ['specseal.skill=specseal-improve', 'specseal.change=', 'specseal.discussion=']);
});

test('promptLabels：只认开头的 specseal 技能指令，名称只看第一个参数', () => {
  const change = (skill, name) => [`specseal.skill=specseal-${skill}`, ...(name ? [`specseal.change=${name}`] : []), 'specseal.discussion='];
  assert.deepEqual(promptLabels('/specseal-apply add-a'), change('apply', 'add-a'));
  assert.deepEqual(promptLabels('  /specseal-ingest add-a 补充说明'), change('ingest', 'add-a'));
  assert.deepEqual(promptLabels('/specseal-quality'), change('quality'));
  assert.deepEqual(promptLabels('/specseal-apply 请接着做'), change('apply'), '中文不是变更名称');
  assert.deepEqual(promptLabels('/specseal-apply --flag'), change('apply'));
  assert.equal(promptLabels('请跑 /specseal-apply add-a'), null, '句子里提到不算');
  assert.equal(promptLabels('/specseal-unknown add-a'), null);
  assert.equal(promptLabels('/herdr-dispatch add-a'), null);
  assert.equal(promptLabels(''), null);
});

test('promptLabels：讨论记下 slug，提案接续讨论也算，slug 可以有中文', () => {
  const talk = (skill, slug) => [`specseal.skill=specseal-${skill}`, 'specseal.change=', `specseal.discussion=${slug}`];
  assert.deepEqual(promptLabels('/specseal-discuss agent-tool-sdk-layering'), talk('discuss', 'agent-tool-sdk-layering'));
  assert.deepEqual(promptLabels('/specseal-propose --from-discussion talk'), talk('propose', 'talk'));
  assert.deepEqual(promptLabels('/specseal-discuss 提示词分开'), talk('discuss', '提示词分开'));
  assert.deepEqual(promptLabels('/specseal-discuss'), talk('discuss', ''));
});

test('讨论：标签认得出这场讨论的 agent，技能优先送给它，它在做事就等', () => {
  const d = { slug: 'talk', status: 'open', cuts: [] };
  const here = agent({ address: 't1', tab: 'tab1', cwd: REPO, status: 'idle' });
  const mine = agent({ address: 't2', tab: 'tab2', cwd: REPO, status: 'idle', labels: { 'specseal.discussion': 'talk' } });
  const other = agent({ address: 't3', labels: { 'specseal.discussion': 'other' } });
  assert.deepEqual(discussionAgents(d, [here, mine, other]).map((a) => a.address), ['t2']);
  const context = ctx({ agents: [here, mine], focus: { tab: 'tab1', terminal: 't1' } });
  const [sent] = discussionActions(d, context);
  assert.equal(sent.delivery.agent.address, 't2', '不是送给目前分页');
  assert.equal(deliveryHint({ kind: 'send', where: sent.delivery.where }), '送给这场讨论的 agent');
  assert.deepEqual(sent.delivery.labels, ['specseal.skill=specseal-discuss', 'specseal.change=', 'specseal.discussion=talk']);
  const [busy] = discussionActions(d, ctx({ agents: [{ ...mine, status: 'working' }], focus: { tab: 'tab1', terminal: 't1' } }));
  assert.equal(busy.delivery.kind, 'busy');
  assert.equal(deliveryHint(busy.delivery), '这场讨论的 agent 正在做事');
});

test('讨论：没有 agent 时开新分页，分页名称和标签都写出讨论', () => {
  const d = { slug: 'talk', status: 'open', cuts: [] };
  const [fresh] = discussionActions(d, ctx({ agents: [] }));
  assert.equal(fresh.delivery.kind, 'new');
  assert.equal(fresh.delivery.tabName, 'discuss · talk');
  assert.deepEqual(fresh.delivery.labels, ['specseal.skill=specseal-discuss', 'specseal.change=', 'specseal.discussion=talk']);
  const plan = newTabPlan({ ...TAB, skill: 'discuss', target: { kind: 'discussion', name: 'talk', args: 'talk' } });
  assert.equal(plan.tabName, 'discuss · talk');
  assert.ok(plan.hc.includes('specseal.discussion=talk'));
  assert.ok(plan.hc.includes('specseal.skill=specseal-discuss'));
});

test('送达：送给现有 agent 时带上标签，apply 改走 worktree 时用实际的技能', () => {
  const here = agent({ address: 't1', tab: 'tab1', cwd: REPO, status: 'idle' });
  const d = planDelivery({ skill: 'quality', change: row(), args: 'add-a', ...ctx({ agents: [here], focus: { tab: 'tab1', terminal: 't1' } }) });
  assert.equal(d.kind, 'send');
  assert.deepEqual(d.labels, ['specseal.skill=specseal-quality', 'specseal.change=add-a', 'specseal.discussion=']);
  const moved = planDelivery({ skill: 'apply', change: row({ worktree: { path: TREE, branch: 'b' } }), args: 'add-a', ...ctx({ agents: [here], focus: { tab: 'tab1', terminal: 't1' } }) });
  assert.deepEqual(moved.labels, ['specseal.skill=specseal-apply-with-worktree', 'specseal.change=add-a', 'specseal.discussion=']);
});

test('放到输入框：技能指令带标签，附加名称不带', () => {
  const agents = [agent({ tab: 'tb1', address: 't1', key: 'claude', status: 'idle' })];
  const focus = { tab: 'tb1', terminal: 't1' };
  const target = { kind: 'change', name: 'add-a', args: 'add-a', row: row() };
  assert.deepEqual(placePlan({ skill: 'apply', target, note: '', agents, focus }).labels, ['specseal.skill=specseal-apply', 'specseal.change=add-a', 'specseal.discussion=']);
  assert.deepEqual(placePlan({ skill: 'discuss', target: { kind: 'discussion', name: 'talk', args: 'talk' }, note: '', agents, focus }).labels, ['specseal.skill=specseal-discuss', 'specseal.change=', 'specseal.discussion=talk']);
  assert.deepEqual(placePlan({ skill: 'discuss', target: null, note: '主题', agents, focus }).labels, ['specseal.skill=specseal-discuss', 'specseal.change=', 'specseal.discussion=']);
  assert.equal(attachPlan({ name: 'add-a', agents, focus }).labels, undefined);
});

test('changeAgents：开工时贴了标签的 agent 专做那个变更，焦点提到别的变更不算', () => {
  const change = row({ name: 'add-a' });
  const owned = agent({ address: 't1', labels: { 'specseal.change': 'add-b', 'specseal.focus': 'add-a' } });
  assert.deepEqual(changeAgents(change, [owned]), []);
});

test('送达：这个变更的 agent 在做事时，不会把技能送给只是提到它的讨论分页（实际发生过）', () => {
  const change = row({ name: 'add-a' });
  const apply = agent({ address: 't1', status: 'working', labels: { 'specseal.change': 'add-a' } });
  const talk = agent({ address: 't2', status: 'done', title: 'propose · add-a', labels: { 'specseal.skill': 'specseal-discuss' } });
  const d = planDelivery({ skill: 'apply', change, args: 'add-a', ...ctx({ agents: [apply, talk] }) });
  assert.equal(d.kind, 'busy');
  assert.equal(d.agent.address, 't1');
});

test('joinAgents：状态用 core 的原始字（done 不会被 Herdr 改写成 idle）', () => {
  const [a] = joinAgents(
    [{ address: 't1', status: 'idle', program: { key: 'claude', name: 'Claude Code' }, title: 'x', pane: 'p1', tab: 'tab1', tab_name: '1', space_name: 's' }],
    [{ address: 't1', status: 'done', name: 'add-a', labels: { a: 'b' } }],
    [{ pane: 'p1', terminal: 't1', cwd: REPO }],
  );
  assert.equal(a.status, 'done');
  assert.equal(a.name, 'add-a');
  assert.equal(a.view, 'idle');
  assert.equal(a.cwd, REPO);
  assert.equal(a.key, 'claude');
  assert.deepEqual(a.labels, { a: 'b' });
});

// ---- 送达 ----

const deliver = (over) => planDelivery({ skill: 'apply', change: row(), args: 'add-a', ...ctx(over) });

test('送达第一顺位：正在做这个变更的 agent', () => {
  const mine = agent({ address: 't9', tab: 'other', labels: { 'specseal.change': 'add-a' } });
  const current = agent({ address: 't1' });
  const d = deliver({ agents: [current, mine], focus: { tab: 'tab1', terminal: 't1' } });
  assert.equal(d.kind, 'send');
  assert.equal(d.where, 'change');
  assert.equal(d.agent.address, 't9');
  assert.equal(d.text, '/specseal-apply add-a');
  assert.deepEqual(d.hc, ['send', 't9', '/specseal-apply add-a']);
});

test('送达第二顺位：目前分页的 agent，焦点所在的优先', () => {
  const left = agent({ address: 't1' });
  const right = agent({ address: 't2' });
  const d = deliver({ agents: [left, right], focus: { tab: 'tab1', terminal: 't2' } });
  assert.equal(d.where, 'tab');
  assert.equal(d.agent.address, 't2');
});

test('送达第三顺位：都没有就开新分页，开在该去的文件夹', () => {
  const d = deliver({ agents: [agent({ tab: 'other' })] });
  assert.deepEqual(d, {
    kind: 'new',
    where: 'new',
    key: 'claude',
    folder: REPO,
    argv: ['claude'],
    text: '/specseal-apply add-a',
    tabName: 'apply · add-a',
    change: 'add-a',
    skill: 'apply',
    labels: ['specseal.skill=specseal-apply', 'specseal.change=add-a', 'specseal.discussion='],
  });
});

test('新分页选最常用且已安装的 agent；Codex 要带 --no-daemon', () => {
  const known = [
    { key: 'opencode', run: ['opencode'], installed: true },
    { key: 'codex', run: ['codex'], installed: true },
    { key: 'claude', run: ['claude'], installed: true },
  ];
  const d = deliver({ known });
  assert.deepEqual(d.argv, ['codex', '--no-daemon']);
  assert.equal(d.text, '$specseal-apply add-a');
});

test('没有可用的 agent 时不开分页并说明原因', () => {
  assert.equal(deliver({ known: [{ key: 'opencode', run: ['opencode'], installed: true }] }).kind, 'none');
  assert.equal(deliver({ known: null }).kind, 'none');
});

test('agent 忙碌时不送，也不改送别人，并写出原因', () => {
  const reasons = { working: '正在做事', blocked: '在等你回答', error: '出错了', sending: '正在收指令' };
  for (const [status, reason] of Object.entries(reasons)) {
    const mine = agent({ address: 't9', status, labels: { 'specseal.change': 'add-a' } });
    const d = deliver({ agents: [mine, agent({ address: 't1' })] });
    assert.equal(d.kind, 'busy');
    assert.equal(d.reason, reason);
    assert.equal(d.agent.address, 't9');
  }
});

test('同一个变更有多个 agent 时，先送给有空的', () => {
  const busy = agent({ address: 't8', status: 'working', labels: { 'specseal.change': 'add-a' } });
  const free = agent({ address: 't9', labels: { 'specseal.change': 'add-a' } });
  assert.equal(deliver({ agents: [busy, free] }).agent.address, 't9');
});

test('没有 specseal 技能的 agent 不当送达对象', () => {
  const d = deliver({ agents: [agent({ key: 'opencode' })] });
  assert.equal(d.kind, 'new');
});

test('文件夹检查：目前分页的 agent 在别的 repo 就跳过', () => {
  const d = deliver({ agents: [agent({ cwd: '/work/other' })] });
  assert.equal(d.kind, 'new');
  assert.equal(d.folder, REPO);
});

const inTree = row({ worktree: { path: TREE, branch: 'specseal/add-a' } });
const treeCase = (over, skill = 'quality') => planDelivery({ skill, change: inTree, args: 'add-a', ...ctx(over) });

test('有 worktree 的变更：技能要在 worktree 里跑，主文件夹的 agent 不算', () => {
  const d = treeCase({ agents: [agent()] });
  assert.equal(d.kind, 'new');
  assert.equal(d.folder, TREE);
});

test('有 worktree 的变更：worktree 里的 agent 优先于标签标在主文件夹的 agent', () => {
  const labelled = agent({ address: 't1', labels: { 'specseal.change': 'add-a' } });
  const there = agent({ address: 't2', cwd: TREE });
  assert.equal(treeCase({ agents: [labelled, there] }).agent.address, 't2');
});

test('有 worktree 的变更：标签标明的 agent 即使文件夹还在主文件夹也算（agent 用 cd 进 worktree）', () => {
  const labeled = agent({ labels: { 'specseal.change': 'add-a' } });
  assert.equal(treeCase({ agents: [labeled] }).where, 'change');
});

test('worktree-merge 要在主文件夹跑，不送进 worktree', () => {
  const d = treeCase({ agents: [agent({ address: 't2', cwd: TREE })] }, 'worktree-merge');
  assert.equal(d.kind, 'new');
  assert.equal(d.folder, REPO);
});

test('apply：worktree 里有 agent 就送 apply', () => {
  const d = treeCase({ agents: [agent({ cwd: TREE })] }, 'apply');
  assert.equal(d.text, '/specseal-apply add-a');
});

test('apply：worktree 里没有 agent，就从主文件夹用 apply-with-worktree 接续', () => {
  const current = treeCase({ agents: [agent()] }, 'apply');
  assert.equal(current.where, 'tab');
  assert.equal(current.text, '/specseal-apply-with-worktree add-a');
  const fresh = treeCase({}, 'apply');
  assert.equal(fresh.kind, 'new');
  assert.equal(fresh.folder, REPO);
  assert.equal(fresh.text, '/specseal-apply-with-worktree add-a');
  assert.equal(fresh.skill, 'apply-with-worktree');
});

test('apply：标签标明但文件夹在主文件夹的 agent，用 apply-with-worktree 接续', () => {
  const labelled = agent({ labels: { 'specseal.change': 'add-a' } });
  const d = treeCase({ agents: [labelled] }, 'apply');
  assert.equal(d.where, 'change');
  assert.equal(d.text, '/specseal-apply-with-worktree add-a');
  // 按钮要写实际送出的技能，不是原本的 apply
  assert.equal(d.skill, 'apply-with-worktree');
  assert.equal(treeCase({ agents: [{ ...labelled, status: 'working' }] }, 'apply').skill, 'apply-with-worktree');
  // agent 已经在 worktree 里，就照原本的 apply
  assert.equal(treeCase({ agents: [{ ...labelled, cwd: TREE }] }, 'apply').skill, 'apply');
});

test('不带变更的技能：送给目前分页，没有就开新分页', () => {
  const sent = planDelivery({ skill: 'discuss', change: null, args: '要讨论的主题', ...ctx({ agents: [agent()] }) });
  assert.equal(sent.text, '/specseal-discuss 要讨论的主题');
  const fresh = planDelivery({ skill: 'improve', change: null, ...ctx() });
  assert.equal(fresh.kind, 'new');
  assert.equal(fresh.tabName, 'improve');
  assert.equal(fresh.change, null);
});

// ---- 列上的按钮 ----

test('changeActions：被挡的 apply 不算送达，analyze 只在 Claude Code 出现', () => {
  const blocked = changeActions(row({ stage: 'proposed', blockedBy: ['add-z'] }), ctx());
  assert.equal(blocked.find((a) => a.skill === 'apply').delivery, null);
  const codex = changeActions(row({ stage: 'proposed' }), ctx({ agents: [agent({ key: 'codex' })] }));
  assert.deepEqual(names(codex), ['apply', 'ingest', 'drift', 'commit']);
  const claude = changeActions(row({ stage: 'proposed' }), ctx({ agents: [agent()] }));
  assert.deepEqual(names(claude), ['apply', 'analyze', 'ingest', 'drift', 'commit']);
});

test('changeActions：提案时的 agent 停着时，apply-with-worktree 送给它', () => {
  const proposing = agent({ address: 't7', labels: { 'specseal.change': 'add-a' } });
  const actions = changeActions(row({ stage: 'proposed' }), ctx({ worktreePolicy: true, agents: [proposing] }));
  const { delivery } = actions.find((a) => a.skill === 'apply-with-worktree');
  assert.equal(delivery.kind, 'send');
  assert.equal(delivery.agent.address, 't7');
  assert.equal(delivery.text, '/specseal-apply-with-worktree add-a');
  // agent 还在忙时，和 apply 一样不能按
  const busy = changeActions(row({ stage: 'proposed' }), ctx({ worktreePolicy: true, agents: [{ ...proposing, status: 'working' }] }));
  assert.equal(busy.find((a) => a.skill === 'apply-with-worktree').delivery.kind, 'busy');
  // 工作流设置没开时没有这一颗
  const off = changeActions(row({ stage: 'proposed' }), ctx({ agents: [proposing] }));
  assert.ok(!names(off).includes('apply-with-worktree'));
});

test('unrecordedDiscussions：在讨论、但讨论还没记录的 agent', () => {
  const board = { discussions: [{ slug: 'talk' }], promoted: [{ slug: 'done-talk' }] };
  const discuss = (over = {}) => agent({ labels: { 'specseal.skill': 'specseal-discuss', 'specseal.discussion': 'Copilot' }, ...over });
  const asking = discuss({ address: 't1' });
  const recorded = discuss({ address: 't2', labels: { 'specseal.skill': 'specseal-discuss', 'specseal.discussion': 'talk' } });
  const promoted = discuss({ address: 't3', labels: { 'specseal.skill': 'specseal-discuss', 'specseal.discussion': 'done-talk' } });
  const noTopic = discuss({ address: 't4', labels: { 'specseal.skill': 'specseal-discuss', 'specseal.discussion': '' } });
  const otherProject = discuss({ address: 't5', cwd: '/work/other' });
  const applying = agent({ address: 't6', labels: { 'specseal.skill': 'specseal-apply', 'specseal.change': 'add-a' } });
  const found = unrecordedDiscussions(board, [asking, recorded, promoted, noTopic, otherProject, applying], REPO);
  assert.deepEqual(found.map((a) => a.address), ['t1', 't4']);
});

test('discussionActions：带讨论 slug 送达', () => {
  const d = { slug: 'talk', topic: '主题', status: 'concluded', cuts: [] };
  const [propose] = discussionActions(d, ctx({ agents: [agent()] }));
  assert.equal(propose.delivery.text, '/specseal-propose --from-discussion talk');
});

test('目前分页：英文的标签大写开头，接在句子里时另有一句', () => {
  const busy = { kind: 'busy', reason: '正在做事' };
  assert.equal(deliveryHint(busy), '目前分页的 agent 正在做事');
  setLang('en');
  try {
    assert.equal(tr('目前分页'), 'Current tab');
    assert.match(deliveryHint(busy), /^Agent on the current tab: /);
  } finally {
    setLang('zh');
  }
});

test('deliveryHint：说明会送去哪里，或为什么不能送', () => {
  assert.equal(deliveryHint(deliver({ agents: [agent({ labels: { 'specseal.change': 'add-a' } })] })), '送给这个变更的 agent');
  assert.equal(deliveryHint(deliver({ agents: [agent()] })), '送给目前分页的 agent');
  assert.equal(deliveryHint(deliver({})), '开新分页');
  assert.equal(deliveryHint(deliver({ agents: [agent({ status: 'blocked' })] })), '目前分页的 agent 在等你回答');
  assert.equal(
    deliveryHint(deliver({ agents: [agent({ status: 'working', labels: { 'specseal.change': 'add-a' } })] })),
    '这个变更的 agent 正在做事',
  );
  assert.equal(deliveryHint(deliver({ known: null })), '还在确认可用的 agent');
});

// ---- 技能跳窗 ----

test('技能表：前四组依工作流程，都有东西可以搭配；项目组不搭配', () => {
  assert.deepEqual([...new Set(PICKER_SKILLS.map((w) => w.group))], ['规划', '实作', '品质', '收尾', '项目']);
  assert.ok(PICKER_SKILLS.every((w) => w.about));
  assert.ok(PICKER_SKILLS.every((w) => (w.group === '项目' ? w.pair === null : w.pair)));
  assert.deepEqual(
    PICKER_SKILLS.filter((w) => w.pair === '讨论').map((w) => w.skill),
    ['discuss', 'propose'],
  );
});

const board = () =>
  buildBoard(
    {
      changes: [
        { name: 'add-p', completedTasks: 0, totalTasks: 2 },
        { name: 'add-i', completedTasks: 1, totalTasks: 2 },
        { name: 'add-r', completedTasks: 2, totalTasks: 2 },
        { name: 'add-w', completedTasks: 2, totalTasks: 2, worktree: { path: TREE } },
      ],
    },
    {
      changes: [
        { name: 'add-p', stage: 'proposed', wave: 1, blockedBy: [] },
        { name: 'add-i', stage: 'in-progress', wave: 1, blockedBy: [] },
        { name: 'add-r', stage: 'ready', wave: 1, blockedBy: [] },
        { name: 'add-w', stage: 'ready', wave: 1, blockedBy: [] },
      ],
    },
    {
      discussions: [
        { slug: 'talk-open', topic: '还在谈', status: 'open' },
        { slug: 'talk-done', topic: '谈完了', status: 'concluded' },
        { slug: 'talk-old', topic: '已转出', status: 'promoted' },
      ],
    },
  );
const targetNames = (skill) => skillTargets(skill, board()).map((t) => t.name);

test('skillTargets：只列这个技能能搭配的变更，规则和面板的技能钮相同', () => {
  assert.deepEqual(targetNames('apply'), ['add-p', 'add-i']);
  assert.deepEqual(targetNames('apply-with-worktree'), ['add-p', 'add-i']);
  assert.deepEqual(targetNames('archive'), ['add-r']);
  assert.deepEqual(targetNames('worktree-merge'), ['add-w']);
  assert.deepEqual(targetNames('verify'), ['add-i', 'add-r', 'add-w']);
});

test('skillTargets：讨论带对应的参数，已转出完的不列', () => {
  assert.deepEqual(
    skillTargets('discuss', board()).map((t) => t.args),
    ['talk-open', 'talk-done'],
  );
  assert.deepEqual(
    skillTargets('propose', board()).map((t) => t.args),
    ['--from-discussion talk-done'],
  );
});

test('skillTargets：不搭配东西的技能没有选项；表上的 pair 和实际列出的种类一致', () => {
  assert.deepEqual(targetNames('improve'), []);
  for (const w of PICKER_SKILLS) {
    const kinds = new Set(skillTargets(w.skill, board()).map((t) => t.kind));
    if (w.pair === null) assert.equal(kinds.size, 0, w.skill);
    if (w.pair === '变更') assert.ok(!kinds.has('discussion'), w.skill);
    if (w.pair === '讨论') assert.ok(!kinds.has('change'), w.skill);
  }
});

const place = (over) => placePlan({ skill: 'apply', target: null, agents: [agent()], focus: { tab: 'tab1', terminal: 't1' }, ...over });

test('placePlan：放进目前分页的 agent，结尾留空白好接着打字', () => {
  const plan = place({ skill: 'improve' });
  assert.equal(plan.kind, 'place');
  assert.equal(plan.agent.address, 't1');
  assert.equal(plan.text, '/specseal-improve ');
});

test('placePlan：什么字都贴得进去，Codex 的钱字号和中文都可以', () => {
  assert.equal(place({ agents: [agent({ key: 'codex' })] }).text, '$specseal-apply ');
  assert.equal(place({ skill: 'discuss', note: '要谈的主题', agents: [agent({ key: 'copilot' })] }).text, '/specseal-discuss 要谈的主题 ');
  assert.equal(place({ skill: 'discuss', target: { args: '中文讨论' } }).text, '/specseal-discuss 中文讨论 ');
});

test('placePlan：控制字符换成空白，粘贴时换行才不会变成送出', () => {
  assert.equal(place({ skill: 'discuss', note: 'a\nb\u001b[201~c' }).text, '/specseal-discuss a b [201~c ');
});

test('placePlan：带搭配的变更或讨论', () => {
  assert.equal(place({ target: { args: 'add-a' } }).text, '/specseal-apply add-a ');
  assert.equal(place({ skill: 'propose', target: { args: '--from-discussion s' } }).text, '/specseal-propose --from-discussion s ');
});

test('placePlan：焦点所在的 agent 优先，焦点不在 agent 时用同分页的第一个', () => {
  const two = [agent({ address: 't1' }), agent({ address: 't2' })];
  assert.equal(place({ agents: two, focus: { tab: 'tab1', terminal: 't2' } }).agent.address, 't2');
  assert.equal(place({ agents: two, focus: { tab: 'tab1', terminal: 't9' } }).agent.address, 't1');
});

test('placePlan：agent 在做事也可以放，因为不会送出', () => {
  assert.equal(place({ agents: [agent({ status: 'working' })] }).kind, 'place');
});

test('placePlan：这些情况不放，并写出原因', () => {
  assert.match(place({ agents: [] }).reason, /目前分页没有 agent/);
  assert.match(place({ agents: [agent({ tab: 'other' })] }).reason, /目前分页没有 agent/);
  assert.match(place({ agents: [agent({ key: 'shell' })] }).reason, /目前分页没有 agent/);
  assert.match(place({ agents: [agent({ status: 'blocked' })] }).reason, /在等你回答/);
  assert.match(place({ skill: 'analyze', agents: [agent({ key: 'copilot' })] }).reason, /只有 Claude Code/);
});

test('placePlan：补充说明接在搭配的东西后面', () => {
  assert.equal(place({ skill: 'discuss', target: { args: 's' }, note: 'next' }).text, '/specseal-discuss s next ');
});

const attach = (over) => attachPlan({ name: 'add-a', agents: [agent()], focus: { tab: 'tab1', terminal: 't1' }, ...over });

test('attachPlan：名称前后留空白，agent 在做事也可以附加，中文名称也可以', () => {
  assert.equal(attach().text, ' add-a ');
  assert.equal(attach({ agents: [agent({ status: 'working' })] }).kind, 'place');
  assert.equal(attach({ agents: [agent({ key: 'codex' })] }).kind, 'place');
  assert.equal(attach({ name: '中文讨论' }).text, ' 中文讨论 ');
});

test('attachPlan：没有 agent 或在等回答时不放', () => {
  assert.equal(attach({ agents: [] }).reason, '目前分页没有 agent');
  assert.equal(attach({ agents: [agent({ status: 'blocked' })] }).reason, '目前分页的 agent 在等你回答');
});

const TAB = { skill: 'improve', target: null, note: '', root: REPO, agents: [], known: CLAUDE, worktreePolicy: true, space: 'sp1', on: null };
const tab = (over) =>
  newTabPlan({ ...TAB, ...over });
const changeTarget = (over = {}) => ({ kind: 'change', name: 'add-a', args: 'add-a', row: row(over) });

test('newTabPlan：和 herdr-dispatch 相同，用 hc run 开在目前的 space，不接在谁底下', () => {
  const plan = tab({ skill: 'review', target: changeTarget() });
  assert.equal(plan.kind, 'tab');
  assert.equal(plan.tabName, 'review · add-a');
  assert.deepEqual(plan.hc, [
    'run', '--bg', '--json', '--no-parent',
    '--cwd', REPO,
    '--label', 'herdr.space=sp1',
    '--name', 'add-a',
    '--label', 'specseal.change=add-a',
    '--label', 'specseal.skill=specseal-review',
    'claude', '/specseal-review add-a',
  ]);
});

test('newTabPlan：不带变更时不取名也不贴变更标签，补充说明接在指令后面', () => {
  const plan = tab({ skill: 'discuss', note: '要谈的主题' });
  assert.equal(plan.tabName, 'discuss');
  assert.ok(!plan.hc.includes('--name'));
  assert.equal(plan.hc.at(-1), '/specseal-discuss 要谈的主题');
  assert.equal(tab({ skill: 'discuss', target: { kind: 'discussion', args: 's' }, note: '接着谈' }).hc.at(-1), '/specseal-discuss s 接着谈');
});

test('newTabPlan：有 worktree 的变更开在 worktree；apply 从主文件夹接续；另一台机器带 --on', () => {
  const worktree = { worktree: { path: TREE } };
  assert.equal(tab({ skill: 'review', target: changeTarget(worktree) }).folder, TREE);
  const apply = tab({ skill: 'apply', target: changeTarget(worktree) });
  assert.equal(apply.folder, REPO);
  assert.equal(apply.hc.at(-1), '/specseal-apply-with-worktree add-a');
  assert.deepEqual(tab({ on: 'vps' }).hc.slice(4, 6), ['--on', 'vps']);
});

test('newTabPlan：变更的 agent 在忙才挡，做完停着的不算', () => {
  const on = (status) => agent({ status, labels: { 'specseal.change': 'add-a' } });
  const merge = (status) => tab({ skill: 'worktree-merge', target: changeTarget(), agents: [on(status)] });
  for (const status of ['working', 'blocked', 'error']) assert.equal(merge(status).reason, '已经有 agent 在做', status);
  for (const status of ['idle', 'done']) assert.equal(merge(status).kind, 'tab', status);
  // 一个在忙一个停着，还是挡
  const both = tab({ skill: 'worktree-merge', target: changeTarget(), agents: [on('idle'), on('working')] });
  assert.equal(both.reason, '已经有 agent 在做');
});

test('newTabPlan：主文件夹的 apply 还没做完时，agent 停着也不能再开一个', () => {
  const row = changeTarget().row;
  const board = { stages: { proposed: [], 'in-progress': [{ ...row, stage: 'in-progress' }], ready: [] } };
  const idle = agent({ status: 'idle', labels: { 'specseal.change': 'add-a', 'specseal.skill': 'specseal-apply' } });
  assert.equal(tab({ skill: 'apply', target: changeTarget(), agents: [idle], board }).reason, 'add-a 的 apply 还没做完');
});

test('newTabPlan：名称被别的终端机占用时不取名，其他照旧', () => {
  const held = agent({ status: 'idle', name: 'add-a', labels: { 'specseal.change': 'add-a' } });
  const plan = tab({ skill: 'worktree-merge', target: changeTarget(), agents: [held] });
  assert.ok(!plan.hc.includes('--name'));
  assert.ok(plan.hc.includes('specseal.change=add-a'));
  assert.ok(plan.hc.includes('specseal.skill=specseal-worktree-merge'));
  // 标签已经换到别的变更，名称还占着
  const moved = agent({ status: 'idle', name: 'add-a', labels: { 'specseal.change': 'add-z' } });
  assert.ok(!tab({ skill: 'review', target: changeTarget(), agents: [moved] }).hc.includes('--name'));
  // 名称没人用就照旧取名，hc 的名称最多 32 个字
  const free = tab({ skill: 'review', target: changeTarget(), agents: [agent({ name: 'other' })] });
  assert.equal(free.hc[free.hc.indexOf('--name') + 1], 'add-a');
  const long = 'a'.repeat(33);
  const cut = agent({ status: 'idle', name: 'a'.repeat(32), labels: {} });
  const target = changeTarget({ name: long });
  assert.ok(!tab({ skill: 'review', target: { ...target, name: long, args: long }, agents: [cut] }).hc.includes('--name'));
});

test('batchPlan：做完停着的 agent 不会让那一列被略过', () => {
  const target = (name) => ({ kind: 'change', name, args: name, row: row({ name, stage: 'ready' }) });
  const idle = agent({ status: 'idle', labels: { 'specseal.change': 'add-a' } });
  const plan = batchPlan({ ...ctx({ agents: [idle] }), skill: 'review', targets: [target('add-a'), target('add-b')], space: 's1', on: null });
  assert.equal(plan.kind, 'tabs');
  assert.equal(plan.plans.length, 2);
});

test('newTabPlan：Codex 用钱字号并带 --no-daemon', () => {
  const plan = tab({ known: [{ key: 'codex', run: ['codex'], installed: true }] });
  assert.deepEqual(plan.hc.slice(-3), ['codex', '--no-daemon', '$specseal-improve']);
});

test('newTabPlan：这些情况不开，并写出原因', () => {
  const mine = agent({ status: 'working', labels: { 'specseal.change': 'add-a' } });
  assert.equal(tab({ skill: 'review', target: changeTarget(), agents: [mine] }).reason, '已经有 agent 在做');
  assert.match(tab({ skill: 'apply', target: changeTarget({ blockedBy: ['add-b'] }) }).reason, /要等 add-b 落地/);
  assert.match(tab({ skill: 'analyze', known: [{ key: 'copilot', run: ['copilot'], installed: true }] }).reason, /只有 Claude Code/);
  assert.equal(tab({ known: null }).reason, '还在确认可用的 agent');
});

test('newTabPlan：没开 worktree 流程时 apply-with-worktree 不开，因为技能会自己停下来', () => {
  assert.equal(tab({ skill: 'apply-with-worktree', worktreePolicy: false }).reason, '这个项目没开 worktree 流程');
  assert.equal(tab({ skill: 'apply', worktreePolicy: false }).kind, 'tab');
});

const batch = (over) => batchPlan({ ...TAB, skill: 'quality', targets: [], ...over });
const named = (name, over = {}) => ({ kind: 'change', name, args: name, row: row({ name, ...over }) });

test('batchPlan：一个变更开一个分页，互不相干', () => {
  const plan = batch({ targets: [named('add-a'), named('add-b')] });
  assert.equal(plan.kind, 'tabs');
  assert.deepEqual(plan.plans.map((p) => p.hc.at(-1)), ['/specseal-quality add-a', '/specseal-quality add-b']);
  assert.deepEqual(plan.plans.map((p) => p.tabName), ['quality · add-a', 'quality · add-b']);
  assert.equal(plan.text, '/specseal-quality add-a　/specseal-quality add-b');
});

test('batchPlan：没有勾或勾的都不能开时不做事', () => {
  assert.equal(batch().reason, '勾选要开工的变更');
  const mine = agent({ status: 'working', labels: { 'specseal.change': 'add-a' } });
  assert.equal(batch({ targets: [named('add-a')], agents: [mine] }).reason, '勾选要开工的变更');
});

test('batchPlan：不能开的变更略过，其他照开', () => {
  const mine = agent({ status: 'working', labels: { 'specseal.change': 'add-a' } });
  const plan = batch({ targets: [named('add-a'), named('add-b')], agents: [mine] });
  assert.deepEqual(plan.plans.map((p) => p.change), ['add-b']);
});

test('batchPlan：两个 apply 都在主文件夹就挡下；有 worktree 的接续 worktree，不算', () => {
  const two = [named('add-a'), named('add-b')];
  assert.match(batch({ skill: 'apply', targets: two }).reason, /一次只能跑一个 apply/);
  const one = [named('add-a'), named('add-b', { worktree: { path: TREE } })];
  assert.deepEqual(batch({ skill: 'apply', targets: one }).plans.map((p) => p.skill), ['apply', 'apply-with-worktree']);
  assert.equal(batch({ skill: 'apply-with-worktree', targets: two }).plans.length, 2);
});

// ---- 叫 Specseal 开页面 ----

test('specsealUrl：与 desktop-app「以 specseal 网址打开详情页」的格式相同', () => {
  assert.equal(
    specsealUrl('change', '/Users/dev/specseal', 'desktop-deep-link'),
    'specseal://change/desktop-deep-link?project=%2FUsers%2Fdev%2Fspecseal',
  );
  assert.equal(
    specsealUrl('discussion', '/Users/dev/specseal', 'herdr-specseal-panel'),
    'specseal://discussion/herdr-specseal-panel?project=%2FUsers%2Fdev%2Fspecseal',
  );
  assert.equal(specsealUrl('roadmap', '/Users/dev/specseal'), 'specseal://roadmap?project=%2FUsers%2Fdev%2Fspecseal');
});

test('specsealUrl：名称与路径要百分比编码', () => {
  assert.equal(specsealUrl('change', '/Users/我 的/app', 'add a'), 'specseal://change/add%20a?project=%2FUsers%2F%E6%88%91%20%E7%9A%84%2Fapp');
});

test('specsealUrl：项目网址不带名称，路径要百分比编码', () => {
  assert.equal(specsealUrl('project', '/Users/dev/specseal'), 'specseal://project?project=%2FUsers%2Fdev%2Fspecseal');
  assert.equal(specsealUrl('project', '/Users/我 的/app'), 'specseal://project?project=%2FUsers%2F%E6%88%91%20%E7%9A%84%2Fapp');
});

test('canOpenProject：读得到项目，而且项目在这台机器上，才能用网址开', () => {
  assert.equal(canOpenProject({ hasBoard: true, on: null }), true);
  assert.equal(canOpenProject({ hasBoard: false, on: null }), false);
  assert.equal(canOpenProject({ hasBoard: true, on: 'build-box' }), false);
});

const LOGO_ROOT = '/Users/dev/specseal';
const BRING_UP = ['-b', APP_ID];

test('logoOpenAttempts：本机已初始化的项目先送网址，送不出去再退回只叫出 app', () => {
  assert.deepEqual(logoOpenAttempts({ root: LOGO_ROOT, hasBoard: true, on: null }), [
    ['specseal://project?project=%2FUsers%2Fdev%2Fspecseal'],
    BRING_UP,
  ]);
});

test('logoOpenAttempts：没初始化、还在加载或读不到项目时只叫出 app', () => {
  assert.deepEqual(logoOpenAttempts({ root: LOGO_ROOT, hasBoard: false, on: null }), [BRING_UP]);
  assert.deepEqual(logoOpenAttempts({ root: null, hasBoard: false, on: null }), [BRING_UP]);
});

test('logoOpenAttempts：别台机器的 space 只叫出 app，路径在这台开不了', () => {
  assert.deepEqual(logoOpenAttempts({ root: LOGO_ROOT, hasBoard: true, on: 'build-box' }), [BRING_UP]);
});

// 假的 exec：依序回传给定的结果，Error 代表 exec 本身失败（例如系统没有 open 指令）。
function fakeExec(...results) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, args]);
    const result = results.shift();
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, exec };
}

const URL_ARGS = ['specseal://project?project=%2Fa'];
const NOT_REGISTERED = { code: 1, stderr: 'No application knows how to open URL specseal://project?project=%2Fa\nmore' };

test('lastOpenError：第一组成功就停，没有错误', async () => {
  const { calls, exec } = fakeExec({ code: 0, stderr: '' });
  assert.equal(await lastOpenError([URL_ARGS, BRING_UP], exec), null);
  assert.deepEqual(calls, [['open', URL_ARGS]]);
});

test('lastOpenError：没有注册网址的旧版 app 退回下一组，成功就没有错误', async () => {
  const { calls, exec } = fakeExec(NOT_REGISTERED, { code: 0, stderr: '' });
  assert.equal(await lastOpenError([URL_ARGS, BRING_UP], exec), null);
  assert.deepEqual(calls, [['open', URL_ARGS], ['open', BRING_UP]]);
});

test('lastOpenError：全部失败回传最后一次有内容的错误', async () => {
  const { exec } = fakeExec(NOT_REGISTERED, { code: 1, stderr: 'Unable to find application' });
  assert.equal(await lastOpenError([URL_ARGS, BRING_UP], exec), 'Unable to find application');
});

test('lastOpenError：后一次没有错误消息时，保留前一次的消息', async () => {
  const { exec } = fakeExec(NOT_REGISTERED, { code: 1, stderr: '' });
  assert.equal(await lastOpenError([URL_ARGS, BRING_UP], exec), NOT_REGISTERED.stderr);
});

test('lastOpenError：exec 抛例外算失败，错误是例外的消息', async () => {
  const { exec } = fakeExec(new Error('open: command not found'));
  assert.equal(await lastOpenError([BRING_UP], exec), 'open: command not found');
});

// ---- 开工 ----

const start = (over = {}, ctxOver = {}) => startChoices(row(over), ctx({ worktreePolicy: true, space: 'sp1', ...ctxOver }));
const planOf = (choices, label) => choices.find((c) => c.label === label).plan;

test('开工：开 worktree 政策、还没有 worktree 时要问，两种都开在目前的工作区和主文件夹', () => {
  const choices = start({ stage: 'proposed', completed: 0 });
  assert.deepEqual(choices.map((c) => c.label), ['用 worktree', '直接 apply']);
  const tree = planOf(choices, '用 worktree');
  assert.equal(tree.kind, 'tab');
  assert.equal(tree.folder, REPO);
  assert.equal(tree.text, '/specseal-apply-with-worktree add-a');
  assert.equal(tree.tabName, 'apply-with-worktree · add-a');
  assert.equal(tree.change, 'add-a');
  assert.ok(tree.hc.includes('herdr.space=sp1'), '开在目前的工作区，不开新工作区');
  assert.ok(tree.hc.includes('specseal.change=add-a'));
  assert.equal(planOf(choices, '直接 apply').text, '/specseal-apply add-a');
  assert.equal(planOf(choices, '直接 apply').folder, REPO);
});

const applyAgent = (change, over = {}) =>
  agent({ labels: { 'specseal.change': change, 'specseal.skill': 'specseal-apply' }, ...over });
const boardWith = (...rows) => ({ stages: { proposed: rows.filter((r) => r.stage === 'proposed'), 'in-progress': rows.filter((r) => r.stage === 'in-progress'), ready: rows.filter((r) => r.stage === 'ready') } });

test('开工：主文件夹的 apply 还没做完时，直接 apply 不能选并写出是哪个变更，worktree 还可以', () => {
  const board = boardWith(row({ name: 'add-z', stage: 'in-progress' }));
  // 分页闲置也算：做到一半停下来，文件还在主文件夹。
  const choices = start({}, { board, agents: [applyAgent('add-z', { status: 'idle' })] });
  assert.equal(planOf(choices, '直接 apply').reason, 'add-z 的 apply 还没做完');
  assert.equal(planOf(choices, '用 worktree').kind, 'tab');
});

test('开工：apply 跑完了分页还开着，不算占用主文件夹', () => {
  // 已经封存，不在清单里；这就是分页留着、标签还在的情况。
  const archived = start({}, { board: boardWith(row({ name: 'add-a', stage: 'proposed' })), agents: [applyAgent('add-z', { status: 'done' })] });
  assert.equal(planOf(archived, '直接 apply').kind, 'tab');
  // 任务都做完，接着在同一个分页跑 quality。
  const ready = start({}, { board: boardWith(row({ name: 'add-z', stage: 'ready' })), agents: [applyAgent('add-z', { status: 'working' })] });
  assert.equal(planOf(ready, '直接 apply').kind, 'tab');
});

test('newTabPlan：apply-with-worktree 不受主文件夹的 apply 影响', () => {
  const board = boardWith(row({ name: 'add-z', stage: 'in-progress' }));
  assert.equal(tab({ skill: 'apply', board, agents: [applyAgent('add-z')] }).reason, 'add-z 的 apply 还没做完');
  assert.equal(tab({ skill: 'apply-with-worktree', board, agents: [applyAgent('add-z')] }).kind, 'tab');
});

test('开工：未开 worktree 政策时不问，直接 apply', () => {
  const choices = start({}, { worktreePolicy: false });
  assert.deepEqual(choices.map((c) => c.label), ['开工']);
  assert.equal(choices[0].plan.text, '/specseal-apply add-a');
  assert.equal(choices[0].plan.folder, REPO);
});

test('开工：已有 worktree 时不问，从主文件夹接续', () => {
  const choices = start({ worktree: { path: TREE, branch: 'specseal/add-a' } });
  assert.deepEqual(choices.map((c) => c.label), ['开工']);
  assert.equal(choices[0].plan.folder, REPO);
  assert.equal(choices[0].plan.text, '/specseal-apply-with-worktree add-a');
});

test('开工：Codex 用钱字号并带 --no-daemon', () => {
  const plan = planOf(start({}, { known: [{ key: 'codex', run: ['codex'], installed: true }] }), '用 worktree');
  assert.equal(plan.text, '$specseal-apply-with-worktree add-a');
  assert.ok(plan.hc.includes('--no-daemon'));
});

test('开工：没有可用的 agent 时钮还在，并说明原因', () => {
  assert.equal(planOf(start({}, { known: null }), '用 worktree').reason, '还在确认可用的 agent');
  assert.equal(planOf(start({}, { known: [] }), '直接 apply').kind, 'none');
});

test('开工：这些情况没有开工钮', () => {
  assert.equal(start({ stage: 'ready' }), null, '任务都做完了');
  assert.equal(start({ blockedBy: ['add-z'] }), null, '被挡住');
  assert.equal(start({ restale: true }), null, '讨论重新定案，要先 ingest');
  assert.equal(start({}, { agents: [agent({ labels: { 'specseal.change': 'add-a' } })] }), null, '已有 agent 在做');
  assert.equal(start({}, { starting: new Set(['add-a']) }), null, '刚按过，agent 还没开好');
});

const stages = (...rows) => ({
  proposed: rows.filter((r) => r.stage === 'proposed'),
  'in-progress': rows.filter((r) => r.stage === 'in-progress'),
  ready: rows.filter((r) => r.stage === 'ready'),
});
const waveCtx = (over = {}) => ctx({ worktreePolicy: true, ...over });

test('整波开工：开工最前面那一波能开工的变更，波次取自 plan', () => {
  const wave = waveToStart(
    stages(
      row({ name: 'add-a', stage: 'proposed' }),
      row({ name: 'add-b', stage: 'in-progress' }),
      row({ name: 'add-c', stage: 'proposed', wave: 2, blockedBy: ['add-a'] }),
    ),
    waveCtx(),
  );
  assert.equal(wave.wave, 1);
  assert.deepEqual(
    wave.plans.map((p) => p.text),
    ['/specseal-apply-with-worktree add-a', '/specseal-apply-with-worktree add-b'],
  );
  assert.ok(wave.plans.every((p) => p.kind === 'tab'));
});

test('整波开工：已有 agent、已就绪、被挡的变更不算在内', () => {
  const wave = waveToStart(
    stages(
      row({ name: 'add-a', stage: 'proposed' }),
      row({ name: 'add-b', stage: 'proposed' }),
      row({ name: 'add-c', stage: 'proposed' }),
      row({ name: 'add-d', stage: 'ready' }),
      row({ name: 'add-e', stage: 'proposed', wave: 2, blockedBy: ['add-a'] }),
    ),
    waveCtx({ agents: [agent({ labels: { 'specseal.change': 'add-c' } })] }),
  );
  assert.deepEqual(wave.plans.map((p) => p.change), ['add-a', 'add-b']);
});

test('整波开工：能开工的不到两个时不提供，因为列上的开工钮就够了', () => {
  assert.equal(waveToStart(stages(row({ name: 'add-a', stage: 'proposed' })), waveCtx()), null);
  assert.equal(waveToStart(stages(), waveCtx()), null);
});

test('整波开工：未开 worktree 政策时不提供', () => {
  const two = stages(row({ name: 'add-a', stage: 'proposed' }), row({ name: 'add-b', stage: 'proposed' }));
  assert.equal(waveToStart(two, waveCtx({ worktreePolicy: false })), null);
});

test('整波开工：没有可用的 agent 时不提供', () => {
  const two = stages(row({ name: 'add-a', stage: 'proposed' }), row({ name: 'add-b', stage: 'proposed' }));
  assert.equal(waveToStart(two, waveCtx({ known: [] })), null);
});

const seat = (over) => ({ address: 't1', labels: {}, cwd: '/p', title: '', ...over });
const boardOf = (...rows) => ({ stages: { proposed: rows, 'in-progress': [], ready: [] } });

test('agentChange：和面板同一套比对，标签、worktree、插件回报都算；查不到是 null', () => {
  const foo = { name: 'add-foo', worktree: null };
  const bar = { name: 'add-bar', worktree: { path: '/p/.wt/add-bar' } };
  const board = boardOf(foo, bar);
  assert.equal(agentChange(seat({ labels: { 'specseal.change': 'add-foo' } }), board), foo);
  assert.equal(agentChange(seat({ cwd: '/p/.wt/add-bar/src' }), board), bar);
  assert.equal(agentChange(seat({ labels: { 'specseal.focus': 'add-bar' } }), board), bar);
  assert.equal(agentChange(seat({ labels: { 'specseal.focus': '-' } }), board), null);
  assert.equal(agentChange(seat(), board), null);
});

test('groupedOrder：等你回答的放最前面，其他照 Spaces 顺序，同一个 space 里急的和新的在前面', () => {
  const rank = { blocked: 4, done: 3, working: 2, idle: 1 };
  const a = (address, space, status, at, seq = 0) => ({ address, space, status, at, seq });
  const list = [
    a('c-idle', 'c', 'idle', 9),
    a('b-idle-old', 'b', 'idle', 1),
    a('b-idle-new', 'b', 'idle', 2),
    a('b-working', 'b', 'working', 0),
    a('c-blocked', 'c', 'blocked', 0),
    a('gone', 'z', 'idle', 0),
    a('a-done', 'a', 'done', 0),
  ];
  const order = groupedOrder(list, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], (x) => rank[x.status], (x) => x.at);
  assert.deepEqual(order.map((x) => x.address), ['c-blocked', 'a-done', 'b-working', 'b-idle-new', 'b-idle-old', 'c-idle', 'gone']);
});

test('statusSections：状态相同的相邻成一段，顺序照排好的清单', () => {
  const rank = { done: 3, working: 2, idle: 1 };
  const members = ['done', 'working', 'idle', 'idle'].map((status, i) => ({ status, i }));
  const sections = statusSections(members, (a) => rank[a.status]);
  assert.deepEqual(sections.map((s) => [s.rank, s.members.map((a) => a.i)]), [[3, [0]], [2, [1]], [1, [2, 3]]]);
  assert.deepEqual(statusSections([], () => 1), []);
});

test('statusCounts：最急的在前面，没有的不列', () => {
  const members = ['idle', 'working', 'idle', 'done'].map((status) => ({ status }));
  assert.deepEqual(statusCounts(members), [['done', 1], ['working', 1], ['idle', 2]]);
  assert.deepEqual(statusCounts([]), []);
});

test('langFrom：第一个语言算数，中文之外都用英文', () => {
  assert.equal(langFrom('(\n    "zh-Hant-TW"\n)\n'), 'zh');
  assert.equal(langFrom('(\n    "en-US",\n    "zh-Hant-TW"\n)\n'), 'en');
  assert.equal(langFrom('  zh_TW.UTF-8\n'), 'zh');
  assert.equal(langFrom('ja_JP.UTF-8'), 'en');
  assert.equal(langFrom(''), 'en');
});

test('tr：中文系统翻 Herdr 的英文，其他系统翻面板的中文，查不到用原文，占位符照顺序', () => {
  try {
    setLang('zh');
    assert.equal(tr('Needs you'), '需要你');
    assert.equal(tr('要等 {0} 落地', 'a'), '要等 a 落地');
    assert.equal(tr('apply'), 'apply');
    setLang('en');
    assert.equal(tr('Needs you'), 'Needs you');
    assert.equal(tr('要等 {0} 落地', 'a'), 'Waiting for a to land');
    assert.equal(tr('第 {0} 波可以一起开工：{1}', 2, 'x'), 'Wave 2 can start together: x');
    assert.equal(tr('apply'), 'apply');
    assert.equal(tr('$&{0}', 'x'), '$&x', '参数和原文里的特殊字符不会被取代样式吃掉');
  } finally {
    setLang('zh');
  }
});

test('placePlan：原因跟着语系', () => {
  try {
    setLang('en');
    const plan = placePlan({ skill: 'apply', target: null, note: '', agents: [], focus: {} });
    assert.equal(plan.reason, 'The current tab has no agent. You can open a new tab');
  } finally {
    setLang('zh');
  }
});

// ---- 品质关卡的章 ----

const META = `schema: spec-driven
created: 2026-11-04T15:00:22+08:00
reviewed_at: 2026-11-04T17:09:58+08:00
reviewed_by: M <m@example.com>
reviewed_tasks_total: 12
reviewed_rounds: 3
reviewed_scope:
  - path: src/a.js
    hash: aaa
  - path: "src/b c.js"
    hash: bbb
verified_at: 2026-11-04T17:09:58+08:00
verified_tasks_total: 12
verified_scope:
  - path: src/a.js
    hash: aaa
`;
const STAMP_R = { total: 12, scope: [{ path: 'src/a.js', hash: 'aaa' }, { path: 'src/b c.js', hash: 'bbb' }] };
const STAMP_V = { total: 12, scope: [{ path: 'src/a.js', hash: 'aaa' }] };

test('parseStations：读 .meta.yaml 的章和工单', () => {
  assert.deepEqual(parseStations(META), {
    review: { ticket: false, stamp: STAMP_R },
    verify: { ticket: false, stamp: STAMP_V },
  });
  assert.deepEqual(parseStations(`${META}\nopen_ticket: verify\n`).verify.ticket, true);
  assert.deepEqual(parseStations('schema: spec-driven\n'), {
    review: { ticket: false, stamp: null },
    verify: { ticket: false, stamp: null },
  });
  assert.equal(parseStations('').review.stamp, null);
});

test('parseStations：字段不全不算章（引擎的 is_stamped）', () => {
  const noScope = 'reviewed_at: x\nreviewed_tasks_total: 3\n';
  const noTotal = 'reviewed_at: x\nreviewed_scope:\n  - path: a\n    hash: b\n';
  const noTime = 'reviewed_tasks_total: 3\nreviewed_scope:\n  - path: a\n    hash: b\n';
  for (const meta of [noScope, noTotal, noTime]) assert.equal(parseStations(meta).review.stamp, null);
});

test('stampedPaths：要查的文件不重复', () => {
  assert.deepEqual(stampedPaths(parseStations(META)), ['src/a.js', 'src/b c.js']);
  assert.deepEqual(stampedPaths(parseStations('')), []);
});

test('stationStates：判断和引擎的封存守门相同', () => {
  const fresh = { 'src/a.js': 'aaa', 'src/b c.js': 'bbb' };
  const facts = (over = {}) => ({ ...parseStations(META), hashes: fresh, ...over });
  const base = { total: 12, codeRemaining: 0 };
  assert.deepEqual(stationStates(facts(), base), { review: 'stamped', verify: 'stamped' });
  // 任务数变了
  assert.deepEqual(stationStates(facts(), { ...base, total: 13 }), { review: 'stale', verify: 'stale' });
  // 程序任务又多了没做完的
  assert.deepEqual(stationStates(facts(), { ...base, codeRemaining: 1 }), { review: 'stale', verify: 'stale' });
  // 只有范围内的文件算：b 只在 review 的范围内
  assert.deepEqual(stationStates(facts({ hashes: { ...fresh, 'src/b c.js': 'xxx' } }), base), { review: 'stale', verify: 'stamped' });
  // 文件不见了
  assert.deepEqual(stationStates(facts({ hashes: { 'src/a.js': 'aaa' } }), base), { review: 'stale', verify: 'stamped' });
  // 查不到哈希时只看任务，和引擎没有工作树时相同
  assert.deepEqual(stationStates(facts({ hashes: null }), base), { review: 'stamped', verify: 'stamped' });
  // 查不到程序任务数不算过期
  assert.deepEqual(stationStates(facts(), { total: 12, codeRemaining: null }), { review: 'stamped', verify: 'stamped' });
  // 工单开着就不看章
  const open = parseStations(`${META}\nopen_ticket: review\n`);
  assert.deepEqual(stationStates({ ...open, hashes: { 'src/a.js': 'xxx' } }, base), { review: 'open', verify: 'stale' });
  // 没有数据
  assert.deepEqual(stationStates(undefined, base), { review: 'none', verify: 'none' });
});

test('buildBoard：列上带两站的状态', () => {
  const list = { changes: [{ name: 'a', completedTasks: 12, totalTasks: 12 }, { name: 'b', completedTasks: 0, totalTasks: 12 }] };
  const plan = {
    changes: [
      { name: 'a', wave: 1, stage: 'ready', blockedBy: [] },
      { name: 'b', wave: 1, stage: 'proposed', blockedBy: [] },
    ],
  };
  const hashes = { 'src/a.js': 'aaa', 'src/b c.js': 'bbb' };
  const board = buildBoard(list, plan, { discussions: [] }, {}, { a: { ...parseStations(META), hashes } });
  assert.deepEqual(board.stages.ready[0].stations, { review: 'stamped', verify: 'stamped' });
  assert.deepEqual(board.stages.proposed[0].stations, { review: 'none', verify: 'none' });
  // 技能跳窗不查章，也不会坏
  assert.deepEqual(buildBoard(list, plan, { discussions: [] }).stages.ready[0].stations, { review: 'none', verify: 'none' });
});

test('stationViews：agent 正在跑的站显示 running，没有状态的站不画', () => {
  const on = (skill, status = 'working') => agent({ status, labels: { 'specseal.change': 'add-a', 'specseal.skill': `specseal-${skill}` } });
  const stations = (review, verify) => row({ stage: 'ready', stations: { review, verify } });
  const states = (r, agents = []) => stationViews(r, agents).map((v) => [v.station, v.state]);
  assert.deepEqual(states(stations('none', 'none')), []);
  assert.deepEqual(states(row({ stage: 'ready' })), [], '没有查过章的列');
  assert.deepEqual(states(stations('stamped', 'open')), [['review', 'stamped'], ['verify', 'open']]);
  // quality 跑两站，还没有工单时也要显示
  assert.deepEqual(states(stations('none', 'none'), [on('quality')]), [['review', 'running'], ['verify', 'running']]);
  assert.deepEqual(states(stations('none', 'none'), [on('review')]), [['review', 'running']]);
  assert.deepEqual(states(stations('none', 'none'), [on('verify')]), [['verify', 'running']]);
  // 盖好的站就算盖好了，另一站还在跑
  assert.deepEqual(states(stations('stamped', 'open'), [on('quality')]), [['review', 'stamped'], ['verify', 'running']]);
  // 重跑过期的章
  assert.deepEqual(states(stations('stale', 'stale'), [on('quality')]), [['review', 'running'], ['verify', 'running']]);
  // agent 停下来、做别的事、或做别的变更，都不算在跑
  assert.deepEqual(states(stations('open', 'none'), [on('quality', 'blocked')]), [['review', 'open']]);
  assert.deepEqual(states(stations('none', 'none'), [on('apply')]), []);
  const other = agent({ status: 'working', labels: { 'specseal.change': 'add-z', 'specseal.skill': 'specseal-quality' } });
  assert.deepEqual(states(stations('none', 'none'), [other]), []);
});

test('changeSkills：两站都盖章后，建议封存加提交', () => {
  const primary = (over) => changeSkills(row({ stage: 'ready', ...over })).find((s) => s.primary)?.skill;
  const both = { review: 'stamped', verify: 'stamped' };
  assert.equal(primary({}), 'quality');
  assert.equal(primary({ stations: both }), 'archive+commit');
  // 只盖了一站、章过期、工单开着，都还要跑
  for (const verify of ['none', 'stale', 'open']) assert.equal(primary({ stations: { review: 'stamped', verify } }), 'quality');
  // 有 worktree 要先合并，封存不能选
  const merged = changeSkills(row({ stage: 'ready', stations: both, worktree: { path: TREE, branch: 'b' } }));
  assert.equal(merged.find((s) => s.primary).skill, 'worktree-merge');
  assert.ok(!merged.some((s) => s.skill.startsWith('archive')));
  // 讨论重新定案优先
  assert.equal(primary({ stations: both, restale: true }), 'ingest');
  // 盖了章但手动任务还没做：不用再跑一次 quality，也还不能封存
  const manual = changeSkills(row({ stage: 'in-progress', codeRemaining: 0, stations: both }));
  assert.equal(manual.find((s) => s.primary).skill, 'apply');
  assert.ok(!manual.some((s) => s.skill.startsWith('archive')));
  assert.equal(changeSkills(row({ stage: 'in-progress', codeRemaining: 0 })).find((s) => s.primary).skill, 'quality');
});

test('rowChoices：建议的那一颗放外面，其他的按 ⋯ 才展开', () => {
  const quality = { skill: 'quality', primary: true };
  const review = { skill: 'review', primary: false };
  const merge = { skill: 'worktree-merge', primary: false };
  assert.deepEqual(rowChoices([review, quality, merge]), { next: quality, beside: [], others: [review, merge] });
  // apply 被挡时没有建议，列上放第一颗
  assert.deepEqual(rowChoices([review, merge]), { next: review, beside: [], others: [merge] });
  // 讨论中只有一个技能，没有东西可以展开
  assert.deepEqual(rowChoices([quality]), { next: quality, beside: [], others: [] });
});

test('rowChoices：apply-with-worktree 放 apply 旁边，有开工钮时收进 ⋯', () => {
  const apply = { skill: 'apply', primary: true };
  const tree = { skill: 'apply-with-worktree', primary: false };
  const drift = { skill: 'drift', primary: false };
  assert.deepEqual(rowChoices([apply, tree, drift]), { next: apply, beside: [tree], others: [drift] });
  // 开工已经能选 worktree，列上不用重复
  assert.deepEqual(rowChoices([apply, tree, drift], [{ label: '用 worktree' }]), { next: apply, beside: [], others: [tree, drift] });
});

test('rowChoices：做完 apply 的 worktree 变更，建议合并，展开后还能跑 quality', () => {
  const actions = changeActions(row({ stage: 'ready', worktree: { path: TREE, branch: 'b' } }), ctx());
  const { next, others } = rowChoices(actions);
  assert.equal(next.skill, 'worktree-merge');
  assert.ok(others.some((a) => a.skill === 'quality'));
  assert.ok(others.every((a) => a.skill !== 'worktree-merge'));
});

test('changeSkills：有 worktree 时，程序任务做完就建议合并，不管有没有盖章', () => {
  const tree = { path: TREE, branch: 'b' };
  const primary = (over) => changeSkills(row({ worktree: tree, ...over })).find((s) => s.primary)?.skill;
  assert.equal(primary({ stage: 'ready' }), 'worktree-merge');
  for (const verify of ['none', 'stale', 'open', 'stamped']) {
    assert.equal(primary({ stage: 'ready', stations: { review: 'stamped', verify } }), 'worktree-merge', verify);
  }
  // 只剩手动任务
  assert.equal(primary({ stage: 'in-progress', codeRemaining: 0 }), 'worktree-merge');
  // 程序还没做完、查不到进度、还没开工，都留在 apply
  assert.equal(primary({ stage: 'in-progress', codeRemaining: 2 }), 'apply');
  assert.equal(primary({ stage: 'in-progress', codeRemaining: null }), 'apply');
  assert.equal(primary({ stage: 'proposed' }), 'apply');
  // 讨论重新定案优先
  assert.equal(primary({ stage: 'ready', restale: true }), 'ingest');
  // 没有 worktree 不受影响
  assert.equal(changeSkills(row({ stage: 'ready' })).find((s) => s.primary).skill, 'quality');
  assert.equal(changeSkills(row({ stage: 'in-progress', codeRemaining: 0 })).find((s) => s.primary).skill, 'quality');
});

// ---- archive+commit ----

const readyRow = (over = {}) => row({ stage: 'ready', stations: { review: 'stamped', verify: 'stamped' }, ...over });

test('archive+commit：指令和 Claude Code mod 相同，两个都带前缀', () => {
  assert.equal(commandText('claude', 'archive+commit', 'add-a'), '/specseal-archive + /specseal-commit add-a');
  assert.equal(commandText('codex', 'archive+commit', 'add-a'), '$specseal-archive + $specseal-commit add-a');
  assert.equal(commandText('claude', 'archive+commit'), '/specseal-archive + /specseal-commit');
  assert.equal(commandText('claude', 'archive', 'add-a'), '/specseal-archive add-a');
});

test('archive+commit：跳窗放在封存后面，对象和封存相同', () => {
  const names = PICKER_SKILLS.filter((w) => w.group === '收尾').map((w) => w.skill);
  assert.deepEqual(names, ['archive', 'archive+commit', 'worktree-merge', 'commit']);
  const board = {
    stages: { proposed: [], 'in-progress': [], ready: [readyRow(), readyRow({ name: 'add-t', worktree: { path: TREE, branch: 'b' } })] },
    discussions: [],
  };
  assert.deepEqual(skillTargets('archive+commit', board).map((t) => t.name), skillTargets('archive', board).map((t) => t.name));
  assert.deepEqual(skillTargets('archive+commit', board).map((t) => t.name), ['add-a']);
});

test('archive+commit：面板的钮送到主文件夹的 agent，标签算 archive', () => {
  const idle = agent({ labels: { 'specseal.change': 'add-a' } });
  const send = planDelivery({ ...ctx({ agents: [idle] }), skill: 'archive+commit', change: readyRow(), args: 'add-a' });
  assert.equal(send.kind, 'send');
  assert.equal(send.text, '/specseal-archive + /specseal-commit add-a');
  assert.deepEqual(send.labels, ['specseal.skill=specseal-archive', 'specseal.change=add-a', 'specseal.discussion=']);
  const fresh = planDelivery({ ...ctx(), focus: { tab: 'other', terminal: null }, skill: 'archive+commit', change: readyRow(), args: 'add-a' });
  assert.equal(fresh.kind, 'new');
  assert.equal(fresh.folder, REPO);
  assert.equal(fresh.tabName, 'archive+commit · add-a');
});

test('archive+commit：跳窗放到输入框和开新分页', () => {
  const target = { kind: 'change', name: 'add-a', args: 'add-a', row: readyRow() };
  const placed = placePlan({ skill: 'archive+commit', target, note: '', agents: [agent()], focus: { tab: 'tab1', terminal: 't1' } });
  assert.equal(placed.text, '/specseal-archive + /specseal-commit add-a ');
  assert.deepEqual(placed.labels, ['specseal.skill=specseal-archive', 'specseal.change=add-a', 'specseal.discussion=']);
  const tab = newTabPlan({ ...ctx(), skill: 'archive+commit', target, note: '', space: 's1', on: null });
  assert.equal(tab.kind, 'tab');
  assert.ok(tab.hc.includes('specseal.skill=specseal-archive'));
  assert.equal(tab.hc.at(-1), '/specseal-archive + /specseal-commit add-a');
});

test('archive+commit：一次只开一个，同时提交会互相影响', () => {
  const targets = ['add-a', 'add-b'].map((name) => ({ kind: 'change', name, args: name, row: readyRow({ name }) }));
  const plan = batchPlan({ ...ctx(), skill: 'archive+commit', targets, space: 's1', on: null });
  assert.equal(plan.kind, 'none');
  assert.equal(batchPlan({ ...ctx(), skill: 'archive', targets, space: 's1', on: null }).kind, 'tabs');
});

test('promptLabels：认得叠加的指令', () => {
  const labels = ['specseal.skill=specseal-archive', 'specseal.change=add-a', 'specseal.discussion='];
  assert.deepEqual(promptLabels('/specseal-archive + /specseal-commit add-a'), labels);
  assert.deepEqual(hookLabels({ tool_name: 'Skill', tool_input: { skill: 'specseal-archive', args: '+ /specseal-commit add-a' } }), labels);
  assert.deepEqual(promptLabels('/specseal-archive + /specseal-commit'), ['specseal.skill=specseal-archive', 'specseal.discussion=']);
});

// ---- 内置画面的翻译 ----

test('autoTr：中文系统查对照表，英文系统维持原文', () => {
  try {
    setLang('zh');
    assert.equal(autoTr('Settings'), '设置');
    assert.equal(autoTr('Commit'), '提交');
    assert.equal(autoTr('LAYOUT'), '版面');
    setLang('en');
    assert.equal(autoTr('Settings'), 'Settings');
    assert.equal(autoTr('7 agents'), '7 agents');
  } finally {
    setLang('zh');
  }
});

test('autoTr：带变量的句子要整句符合才翻', () => {
  assert.equal(autoTr('7 agents'), '7 个 agent');
  assert.equal(autoTr('· 1 needs you'), '· 1 个需要你');
  assert.equal(autoTr('⌘⇧P  commands'), '⌘⇧P  指令');
  assert.equal(autoTr('12 files'), '12 个文件');
  assert.equal(autoTr('Theme: graphite'), '主题：graphite');
  assert.equal(autoTr('Default (Geist)'), '缺省（Geist）');
  assert.equal(autoTr('Up to date. Checked at 09:30.'), '已是最新版本。检查时间 09:30。');
  // Herdr 0.1.14 侧栏收起时的提示
  assert.equal(autoTr('New space on this computer'), '在这台电脑添加工作区');
  assert.equal(autoTr('New space on vps'), '在 vps 添加工作区');
  // Herdr 0.1.15 机器需要登录时的提示
  assert.equal(autoTr('vps needs a login: run hc machine login vps. Click for Copy.'), 'vps 需要登录，请运行 hc machine login vps。按一下到设置拷贝指令。');
  assert.equal(autoTr('vps needs a login: run'), 'vps 需要登录，请运行');
  assert.equal(autoTr('needs a login: run'), '需要登录，请运行');
  assert.equal(autoTr('Copy'), '拷贝');
  assert.equal(autoTr('Copied'), '已拷贝');
  assert.equal(autoTr('Could not check installed agents'), '检查不了已安装的 agent');
  assert.equal(autoTr('0.1.13 is ready. Restart to switch now; it also switches when you quit.'), '0.1.13 已经准备好。重新启动就会切换，结束 Herdr 时也会切换。');
  // 用户取的名称不算
  for (const name of ['two agents', 'specseal', 'add-team-invites', 'my files', 'main']) assert.equal(autoTr(name), name);
});

test('translateHerdr：画面上的字符串都查对照表，其他东西原样传下去', () => {
  class Fake {
    child(c) {
      this.got = c;
      return this;
    }
    children(items) {
      this.got = [...items];
      return this;
    }
    tooltip(t) {
      this.got = t;
      return this;
    }
  }
  const inputs = { new: (options) => options };
  const ui = { div: () => new Fake(), InputState: inputs };
  translateHerdr(ui);
  const element = new Fake();
  assert.equal(element.child('Settings').got, '设置');
  assert.equal(element.child('add-team-invites').got, 'add-team-invites');
  assert.equal(element.child(3).got, 3);
  const inner = new Fake();
  assert.equal(element.child(inner).got, inner);
  assert.deepEqual(element.children(['Look', 5, 'x']).got, ['外观', 5, 'x']);
  assert.equal(element.tooltip('Rename').got, '重命名');
  assert.deepEqual(inputs.new({ placeholder: 'Commit message', value: 'a' }), { placeholder: '提交消息', value: 'a' });
  assert.equal(inputs.new(), undefined);
  // 再装一次（mod 重新加载）不会包两层
  const once = Fake.prototype.child;
  translateHerdr(ui);
  assert.equal(Fake.prototype.child, once);
  assert.equal(new Fake().child('Settings').got, '设置');
});

test('dock-panel：文件树的名称不会被翻，改不到时不挡停靠', () => {
  const source = readFileSync(fileURLToPath(new URL('dock-panel.mjs', import.meta.url)), 'utf8');
  assert.match(source, /as: 'specseal-files'.*optional: UNPROTECTED/);
  for (const name of ['specseal-status', 'specseal-chrome']) assert.ok(!source.includes(name), name);
});

test('dock-panel：卷动页签列不切换页签，改不到时不挡停靠', () => {
  const source = readFileSync(fileURLToPath(new URL('dock-panel.mjs', import.meta.url)), 'utf8');
  assert.match(source, /const TABS_EDITS = \[\['[^']*on_scroll_wheel[^']*tab\.prev[^']*', ''\]\];/);
  assert.match(source, /as: 'specseal-tabs', edits: TABS_EDITS.*optional: '/);
});

const HERDR_DIR = fileURLToPath(new URL('../../integrations/herdr/', import.meta.url));
const code = (file) =>
  readFileSync(path.join(HERDR_DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

test('语系守门：显示的中文都有英文，也不用样板字符串绕过 tr', () => {
  const files = ['mods/specseal/main.js', 'mods/specseal/skill-picker.js', 'mods/specseal/my-skills.js', 'mods/specseal/shared.js', 'mods/specseal/model.js', 'spaces-badge/stage-badge.js', 'agents-list/specseal-rows.js'];
  for (const file of files) {
    const source = code(file).replace(/\s\/\/.*$/gm, '');
    for (const line of source.split('\n')) {
      assert.doesNotMatch(line.replace(/"[^"]*"/g, '""'), /`[^`]*\p{Script=Han}[^`]*`/u, `${file} 有中文样板字符串`);
    }
    for (const [, text] of source.matchAll(/"([^"\n]*)"/g)) {
      if (/\p{Script=Han}/u.test(text)) assert.ok(Object.hasOwn(TO_EN, text), `${file} 的「${text}」没有英文`);
    }
  }
  for (const { group, about } of PICKER_SKILLS) {
    assert.ok(Object.hasOwn(TO_EN, group) && Object.hasOwn(TO_EN, about), `${group}／${about} 没有英文`);
  }
});

test('dock-panel：「New space there」的改法对 Herdr 0.1.13 和 0.1.14 的写法都找得到', () => {
  const source = readFileSync(fileURLToPath(new URL('dock-panel.mjs', import.meta.url)), 'utf8');
  const [, from] = source.match(/\['([^']*New space there[^']*)', '[^']*'\]/);
  const versions = [
    '.child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));',
    '.when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New space there"));',
  ];
  for (const line of versions) assert.equal(line.split(from).length, 2, line);
});

test('语系守门：dock-panel 翻译的英文都有中文', () => {
  const source = readFileSync(fileURLToPath(new URL('dock-panel.mjs', import.meta.url)), 'utf8');
  const keys = [...source.matchAll(/tr\([^"()]*"([^"]+)"(?: : "([^"]+)")?/g)].flatMap((m) => m.slice(1)).filter(Boolean);
  assert.ok(keys.length > 10);
  for (const key of keys) assert.ok(Object.hasOwn(TO_ZH, key), `「${key}」没有中文`);
});

// ---- Codex、Pi 和 Cursor ----

const ALL_AGENTS = [
  { key: 'claude', name: 'Claude Code', run: ['claude'], installed: true },
  { key: 'codex', name: 'Codex', run: ['codex'], installed: true },
  { key: 'pi', name: 'Pi', run: ['pi'], installed: true },
  { key: 'cursor', name: 'Cursor', run: ['cursor-agent'], installed: true },
  { key: 'opencode', name: 'OpenCode', run: ['opencode'], installed: true },
  { key: 'copilot', name: 'Copilot', run: ['copilot'], installed: false },
];

test('叫用写法：每个 agent 用自己的前缀，叠加的技能也一样', () => {
  assert.equal(commandText('claude', 'apply', 'a'), '/specseal-apply a');
  assert.equal(commandText('codex', 'apply', 'a'), '$specseal-apply a');
  assert.equal(commandText('pi', 'apply', 'a'), '/skill:specseal-apply a');
  assert.equal(commandText('pi', 'archive+commit', 'a'), '/skill:specseal-archive + /skill:specseal-commit a');
  assert.equal(commandText('cursor', 'apply', 'a'), '/specseal-apply a');
});

test('Pi 是送达对象；开新分页时直接带指令', () => {
  const d = planDelivery({ ...ctx({ agents: [agent({ key: 'pi' })] }), skill: 'apply', args: 'add-a' });
  assert.equal(d.kind, 'send');
  assert.equal(d.text, '/skill:specseal-apply add-a');
  const fresh = planDelivery({ ...ctx({ known: ALL_AGENTS, preferred: 'pi' }), skill: 'apply', args: 'add-a' });
  assert.equal(fresh.kind, 'new');
  assert.deepEqual(fresh.argv, ['pi']);
  assert.equal(fresh.text, '/skill:specseal-apply add-a');
});

test('可以选的 agent：要装好、要有 specseal 技能', () => {
  assert.deepEqual(usableAgents(ALL_AGENTS).map((a) => a.key), ['claude', 'codex', 'pi', 'cursor']);
  assert.deepEqual(usableAgents(null), []);
});

test('开新分页用选的 agent；选的没装就用最常用的', () => {
  const plan = (preferred) => newTabPlan({ ...ctx({ known: ALL_AGENTS, preferred, space: 's1' }), skill: 'discuss', target: null, note: 'x' });
  assert.deepEqual(plan('codex').hc.slice(-3), ['codex', '--no-daemon', '$specseal-discuss x']);
  assert.deepEqual(plan('pi').hc.slice(-2), ['pi', '/skill:specseal-discuss x']);
  assert.deepEqual(plan('copilot').hc.slice(-2), ['claude', '/specseal-discuss x']);
});

test('跳窗缺省给目前分页的 agent，再来是上次选的，最后是最常用的', () => {
  const pick = (over) => defaultAgent({ known: ALL_AGENTS, agents: [], focus: { tab: 'tab1', terminal: null }, preferred: null, ...over });
  assert.equal(pick({}), 'claude');
  assert.equal(pick({ preferred: 'pi' }), 'pi');
  assert.equal(pick({ preferred: 'pi', agents: [agent({ key: 'codex' })] }), 'codex');
  assert.equal(pick({ preferred: 'copilot' }), 'claude', '选的已经没装');
  assert.equal(defaultAgent({ known: [], agents: [], focus: {}, preferred: 'pi' }), null);
});

test('放到输入框：选的 agent 和目前分页不同时不放', () => {
  const base = { skill: 'discuss', target: null, note: '', agents: [agent({ program: { name: 'Claude Code' } })], focus: { tab: 'tab1', terminal: 't1' } };
  assert.equal(placePlan({ ...base, agentKey: 'claude' }).kind, 'place');
  assert.equal(placePlan(base).kind, 'place', '没有选时照旧');
  const other = placePlan({ ...base, agentKey: 'pi' });
  assert.equal(other.kind, 'none');
  assert.match(other.reason, /Claude Code/);
});

test('analyze 只有 Claude Code 有', () => {
  assert.equal(onlyClaude('analyze', 'claude'), false);
  assert.equal(onlyClaude('analyze', 'pi'), true);
  assert.equal(onlyClaude('apply', 'pi'), false);
  assert.equal(onlyClaude('analyze', 'cursor'), true);
});

test('项目没有这个 agent 的技能时，说明要怎么装；Pi 和 Cursor 各有自己的工具名', () => {
  assert.equal(missingSkillsPlan('Pi', 'pi').kind, 'none');
  assert.match(missingSkillsPlan('Pi', 'pi').reason, /Pi.*--tools pi/);
  assert.match(missingSkillsPlan('Cursor', 'cursor').reason, /Cursor.*--tools cursor/);
  assert.match(missingSkillsPlan('Claude Code', 'claude').reason, /--tools claude/);
});

test('hook：认得三种叫用写法', () => {
  for (const prefix of ['/', '$', '/skill:']) {
    assert.deepEqual(promptLabels(`${prefix}specseal-apply add-a`), skillLabels('apply', 'add-a'), prefix);
    assert.deepEqual(promptLabels(`${prefix}specseal-archive + ${prefix}specseal-commit add-a`), skillLabels('archive', 'add-a'), prefix);
    assert.deepEqual(promptLabels(`${prefix}specseal-propose --from-discussion d`), skillLabels('propose', 'd'), prefix);
  }
  assert.equal(promptLabels('$other add-a'), null);
  assert.equal(promptLabels('/skill:other add-a'), null);
});

// ---- 跳窗的 Specseal 页 ----

test('合成一列：每个做法都是真的技能，清单少掉其他做法', () => {
  const names = new Set(PICKER_SKILLS.map((w) => w.skill));
  for (const [row, choices] of Object.entries(PICKER_VARIANTS)) {
    assert.equal(choices[0].skill, row, '第一个是缺省，也是那一列的名字');
    for (const { skill } of choices) assert.ok(names.has(skill), skill);
  }
  assert.deepEqual(PICKER_ROWS.map((row) => row.skill), [
    'discuss', 'propose', 'ingest', 'apply', 'analyze', 'drift', 'quality',
    'archive', 'worktree-merge', 'commit', 'improve', 'bugfix', 'audit', 'trace', 'manual', 'baseline', 'config',
  ]);
  for (const hidden of ['apply-with-worktree', 'review', 'verify', 'archive+commit']) {
    assert.ok(!PICKER_ROWS.some((w) => w.skill === hidden), hidden);
  }
});

test('清单只列现在能做的：没有变更时只剩规划；有变更时藏掉没得搭配的；项目缺省收合', () => {
  const empty = pickerGroups(() => 0);
  assert.deepEqual(empty.map((g) => [g.group, g.state]), [['规划', 'open'], ['实作', 'closed'], ['品质', 'closed'], ['收尾', 'closed'], ['项目', 'closed']]);
  assert.deepEqual(empty[0].rows.map((w) => w.skill), ['discuss', 'propose']);
  const counts = { ingest: 5, apply: 5, analyze: 5, drift: 5, quality: 3, 'worktree-merge': 3, commit: 5 };
  const busy = pickerGroups((skill) => counts[skill] ?? 0);
  assert.deepEqual(busy.flatMap((g) => g.rows.map((w) => w.skill)), ['discuss', 'propose', 'ingest', 'apply', 'analyze', 'drift', 'quality', 'worktree-merge', 'commit']);
  assert.equal(busy.find((g) => g.group === '项目').state, 'closed');
});

test('点过的组照用户的：all 全列，closed 收起来', () => {
  const groups = pickerGroups(() => 0, { 项目: 'all', 规划: 'closed' });
  assert.deepEqual(groups.find((g) => g.group === '项目').rows.map((row) => row.skill),
    ['improve', 'bugfix', 'audit', 'trace', 'manual', 'baseline', 'config']);
  assert.equal(groups.find((g) => g.group === '规划').rows.length, 0);
});

test('↑↓ 走得到收合的组，走进去就展开；头尾相接', () => {
  const groups = pickerGroups(() => 0);
  assert.deepEqual(pickerStep(groups, 'discuss', 1), { skill: 'propose', open: null });
  assert.deepEqual(pickerStep(groups, 'propose', 1), { skill: 'apply', open: '实作' });
  assert.deepEqual(pickerStep(groups, 'discuss', -1), { skill: 'config', open: '项目' });
  assert.deepEqual(pickerStep(groups, 'not-shown', 1), { skill: 'discuss', open: null });
});

// ---- 我的技能 ----

const skill = (name, source = 'project', about = `${name} 的说明`) => ({ name, source, path: `.claude/skills/${name}`, about, use: skillUse(name) });

test('用途：实际的技能名称都分得对，对不到的是其他', () => {
  const expected = {
    'remotion-render': 'video',
    'motion-graphics': 'anim',
    'gsap-core': 'anim',
    'threejs-shaders': '3d',
    'momo-social-publish': 'content',
    'momo-short-video-publish': 'video',
    'frontend-design:frontend-design': 'design',
    'ui-ux-pro-max': 'design',
    'conventional-commit': 'ship',
    release: 'ship',
    'tdd-workflow': 'dev',
    'herdr-dispatch': 'tool',
    'skill-creator:skill-creator': 'tool',
    'terminal-inserts': 'other',
  };
  for (const [name, use] of Object.entries(expected)) assert.equal(skillUse(name), use, name);
  const ids = new Set(SKILL_GROUPS.map((g) => g.id));
  for (const use of Object.values(expected)) assert.ok(ids.has(use), use);
});

test('每个 agent 读自己的文件夹', () => {
  const dirs = (key) => skillFolders(key).map((f) => f.dir);
  assert.deepEqual(dirs('claude'), ['.claude/skills', '~/.claude/skills']);
  assert.ok(dirs('codex').includes('~/.codex/skills'));
  assert.ok(dirs('pi').includes('.agents/skills') && dirs('pi').includes('~/.pi/agent/skills'));
  assert.deepEqual(dirs('pi'), ['.pi/skills', '.agents/skills', '~/.pi/agent/skills', '~/.agents/skills']);
  assert.deepEqual(dirs('cursor'), [
    '.cursor/skills',
    '.agents/skills',
    '.claude/skills',
    '.codex/skills',
    '~/.cursor/skills',
    '~/.agents/skills',
    '~/.claude/skills',
    '~/.codex/skills',
  ]);
  assert.deepEqual(dirs('opencode'), []);
});

test('插件：只算已激活的；项目范围只算这个项目；不扫缓存里的旧版', () => {
  const installed = {
    plugins: {
      'a@m': [{ scope: 'user', installPath: '/c/a/2' }],
      'b@m': [{ scope: 'project', projectPath: '/work/repo', installPath: '/c/b/1' }],
      'c@m': [{ scope: 'project', projectPath: '/work/other', installPath: '/c/c/1' }],
      'd@m': [{ scope: 'user', installPath: '/c/d/1' }],
    },
  };
  const settings = [{ enabledPlugins: { 'a@m': true, 'c@m': true, 'd@m': true } }, { enabledPlugins: { 'b@m': true, 'd@m': false } }, null];
  assert.deepEqual(pluginFolders(installed, settings, '/work/repo'), [
    { source: 'plugin', prefix: 'a:', dir: '/c/a/2/skills' },
    { source: 'plugin', prefix: 'b:', dir: '/c/b/1/skills' },
  ]);
  assert.deepEqual(pluginFolders(null, [null], '/work/repo'), []);
});

test('清单：不列 Specseal 和不能手动叫用的，同名只留第一个，说明整理过', () => {
  const found = [
    { source: 'project', name: 'specseal-apply', description: 'x', invocable: '', path: 'p' },
    { source: 'project', name: 'shadcn', description: 'x', invocable: 'false', path: 'p' },
    { source: 'project', name: 'release', description: '"引号"', invocable: '', path: '.claude/skills/release' },
    { source: 'personal', name: 'release', description: '同名', invocable: '', path: '~/.claude/skills/release' },
    { source: 'plugin', name: 'frontend-design:frontend-design', description: '> 折叠 的值', invocable: '', path: '/c/x' },
    { source: 'personal', name: 'long', description: 'a'.repeat(300), invocable: '', path: 'p' },
  ];
  const list = skillEntries(found);
  assert.deepEqual(list.map((x) => x.name), ['frontend-design:frontend-design', 'long', 'release']);
  assert.equal(list[2].about, '引号');
  assert.equal(list[2].source, 'project');
  assert.equal(list[0].about, '折叠 的值');
  assert.equal(list[0].path, 'frontend-design', '插件显示插件的名称');
  assert.equal(list[1].about.length, 201);
  assert.equal(hasSpecsealSkills(found), true);
  assert.equal(hasSpecsealSkills(found.slice(1)), false);
});

test('列：依用途分组；三个以上同开头收成系列；整组同系列时不多一层', () => {
  const skills = ['gsap-a', 'gsap-b', 'gsap-c', 'motion-graphics', 'threejs-a', 'threejs-b', 'threejs-c', 'release'].map((n) => skill(n));
  const rows = skillRows({ skills });
  assert.deepEqual(rows.map((r) => r.key), ['g:ship', 's:release', 'g:anim', 'f:anim/gsap', 's:motion-graphics', 'g:3d', 's:threejs-a', 's:threejs-b', 's:threejs-c']);
  assert.deepEqual(rows.find((r) => r.kind === 'family'), { kind: 'family', key: 'f:anim/gsap', id: 'anim/gsap', name: 'gsap', count: 3, open: false, hint: 'a、b、c' });
  const opened = skillRows({ skills, familyOpen: { 'anim/gsap': true } });
  assert.ok(opened.find((r) => r.key === 's:gsap-a').nested);
  assert.equal(skillRows({ skills, groupOpen: { ship: false } }).some((r) => r.key === 's:release'), false);
});

test('列：一组太长就缺省收合，点过就照用户的', () => {
  const skills = Array.from({ length: 13 }, (_, i) => skill(`threejs-${i}`));
  assert.deepEqual(skillRows({ skills }).map((r) => r.key), ['g:3d']);
  assert.equal(skillRows({ skills, groupOpen: { '3d': true } }).length, 14);
});

test('列：有搜索字时全部摊开，名称和说明都比对', () => {
  const skills = [...['gsap-a', 'gsap-b', 'gsap-c', 'motion-graphics'].map((n) => skill(n)), skill('release', 'project', '发版流程')];
  assert.deepEqual(skillRows({ skills, query: 'gsap-B' }).map((r) => r.key), ['g:anim', 's:gsap-b']);
  assert.deepEqual(skillRows({ skills, query: '发版' }).map((r) => r.key), ['g:ship', 's:release']);
  assert.deepEqual(skillRows({ skills, query: 'zzz' }), []);
});

test('我的技能放到输入框：用目前分页的 agent 的写法，不送出，也不贴 specseal 标签', () => {
  const base = { name: 'release', note: '', focus: { tab: 'tab1', terminal: 't1' } };
  const plan = customPlacePlan({ ...base, agents: [agent({ key: 'pi' })], agentKey: 'pi' });
  assert.equal(plan.text, '/skill:release ');
  assert.equal(plan.labels, undefined);
  assert.equal(customPlacePlan({ ...base, agents: [agent({ key: 'codex' })], agentKey: 'codex', note: 'x\ny' }).text, '$release x y ');
  assert.equal(customPlacePlan({ ...base, agents: [], agentKey: 'claude' }).kind, 'none');
  assert.equal(customPlacePlan({ ...base, agents: [agent()], agentKey: 'pi' }).kind, 'none');
});

test('我的技能开新分页：用选的 agent，分页取技能的名字', () => {
  const base = { name: 'release', note: 'v1', root: REPO, known: ALL_AGENTS, space: 's1', on: null };
  const claude = customTabPlan({ ...base, agentKey: 'claude' });
  assert.equal(claude.kind, 'tab');
  assert.equal(claude.tabName, 'release');
  assert.deepEqual(claude.hc, ['run', '--bg', '--json', '--no-parent', '--cwd', REPO, '--label', 'herdr.space=s1', 'claude', '/release v1']);
  assert.deepEqual(customTabPlan({ ...base, agentKey: 'codex' }).hc.slice(-3), ['codex', '--no-daemon', '$release v1']);
  assert.deepEqual(customTabPlan({ ...base, agentKey: 'pi', on: 'vps' }).hc.slice(4, 6), ['--on', 'vps']);
  assert.equal(customTabPlan({ ...base, known: null, agentKey: 'claude' }).kind, 'none');
  assert.equal(customTabPlan({ ...base, known: [], agentKey: 'claude' }).kind, 'none');
});

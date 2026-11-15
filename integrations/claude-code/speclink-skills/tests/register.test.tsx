import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { afterPrompt, changeIn, commandChange, focusFromHistory, focusFromTitle, specsealCommand, titleOf, verbOf, withVerb } from '../hooks/focus'
import { buildBoard, discussionBody, isNoTicket, parseTasks, proposedRows, specsealArgv, toTicket } from '../hooks/board'
import type { PlanJson } from '../hooks/board'
import { cells } from '../hooks/register'
import { commandHead, groupSkills, withArgument, withCommand } from '../hooks/skills'
import { resolveLang } from '../hooks/text'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 140,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const PANE = {
  component: 'Pane',
  requestId: 'specseal-panel',
  props: {
    title: 'specseal',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const TYPED = {
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

const LIST = {
  changes: [
    {
      name: 'add-auth',
      completedTasks: 5,
      totalTasks: 12,
      worktree: { path: '/repo/.worktrees/add-auth', branch: 'specseal/add-auth' },
    },
    { name: 'refactor-store', completedTasks: 0, totalTasks: 8 },
  ],
}
const PLAN: PlanJson = {
  changes: [
    { name: 'add-auth', wave: 1, stage: 'in-progress', blockedBy: [] },
    { name: 'refactor-store', wave: 2, stage: 'proposed', blockedBy: ['add-auth'] },
  ],
  next: 'add-auth',
  skipped: [],
}
const TALK = {
  discussions: [
    { slug: 'hold-auto-close', topic: 'hold 收尾', rounds: 2, status: 'open' },
    { slug: 'ship-it', topic: '收尾流程', rounds: 4, status: 'concluded' },
    { slug: 'old-idea', topic: '已转出', rounds: 3, status: 'promoted' },
  ],
}
const TASKS = `## 1. 登录

- [x] 1.1 加上 OAuth 设置 <!-- specseal-task:tsk_01 -->
- [ ] 1.2 接上回呼路由 <!-- specseal-task:tsk_02 -->

## 2. 验收

- [ ] [M] 2.1 在浏览器手动登录一次 <!-- specseal-task:tsk_03 -->
`
const ARTIFACTS = {
  artifacts: [
    { id: 'proposal', status: 'done' },
    { id: 'design', status: 'done' },
    { id: 'specs', status: 'done' },
    { id: 'tasks', status: 'ready' },
  ],
}
const TICKET = {
  change: 'add-auth',
  lastRound: {
    index: 2,
    findings: [
      { severity: 'CRITICAL', path: 'src/auth.ts', text: 'token 没有检查过期' },
      { severity: 'WARNING', path: 'src/routes.ts', text: '回呼路由缺少错误处理' },
    ],
  },
}

type Run = { argv: readonly string[]; cwd?: string }

// CLI 的替身：依参数回 JSON；没有工单时照 CLI 的样子以 exit 1 失败。
const cli = (argv: readonly string[]) => {
  const [verb, sub, name] = argv.slice(1)
  if (verb === 'list') return LIST
  if (verb === 'plan') return PLAN
  if (verb === 'discuss' && sub === 'list') return TALK
  if (verb === 'discuss' && sub === 'show') return { content: `---\ntopic: ${name}\n---\n\n# 背景\n\n讨论 ${name} 的内文。\n`, info: {} }
  if (verb === 'show') return { tasks: TASKS }
  if (verb === 'status') return ARTIFACTS
  if (verb === 'review' && name === 'add-auth') return TICKET
  return null
}

// 引擎在测试里的替身：已安装的技能、设置、输入框与 CLI 输出。
// panes：开着的面板（ui.panes 的答案）。
const engine = (on: On, filled: string[], claudeLanguage: string, runs: Run[] = [], panes: () => string[] = () => [], env: Record<string, string> = {}) => {
  mock.env(on, env)
  on('settings.read', () => ({ value: { language: claudeLanguage } }))
  on('command.list', () => ({
    value: [
      { name: 'specseal-apply', description: '', source: 'user' },
      { name: 'specseal-propose', description: 'Use when a change needs planning', source: 'user' },
      { name: 'specseal-archive', description: 'Use when a change is finished', source: 'user' },
      { name: 'specseal-commit', description: '', source: 'user' },
      { name: 'commit', description: '', source: 'user' },
    ],
  }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.read', () => ({ value: { text: 'add-x', cursor: 5 } }))
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('process.run', ($, e) => {
    runs.push({ argv: e.argv, cwd: e.init?.cwd })
    const out = cli(e.argv)
    const station = e.argv[1] ?? ''
    return {
      value: {
        exitCode: out === null ? 1 : 0,
        stdout: out === null ? '' : JSON.stringify(out),
        stderr: out === null ? `Error: no ${station} ticket for change '${e.argv[3] ?? ''}'` : '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.panes', () => ({ value: panes().map(id => ({ id, title: id })) }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}

test('从送出的指令、技能调用与 specseal 指令认出步骤和 change', () => {
  const names = ['add-auth', 'refactor-store']
  expect(verbOf('/specseal-apply add-auth', 'specseal-panel')).toBe('apply')
  expect(verbOf('/specseal-archive + /specseal-commit add-auth', 'specseal-panel')).toBe('archive+commit')
  expect(verbOf('<command-name>/specseal-quality</command-name>\n<command-args>add-auth</command-args>', 'specseal-panel')).toBe('quality')
  expect(verbOf('/specseal-panel', 'specseal-panel')).toBe(null)
  expect(verbOf('/commit', 'specseal-panel')).toBe(null)
  expect(verbOf('帮我看 /specseal-apply 怎幺用', 'specseal-panel')).toBe(null)

  expect(changeIn('specseal status --change "add-auth" --json', names)).toBe('add-auth')
  expect(changeIn('specseal review scope refactor-store --json', names)).toBe('refactor-store')
  expect(changeIn('specseal list --json', names)).toBe(null)
  expect(changeIn('cat add-auth-notes.md', names)).toBe(null)
  expect(specsealCommand('cd /repo && specseal task done x')).not.toBe(null)
  expect(specsealCommand('cat specseal.toml')).toBe(null)

  // 新的技能指令换步骤；没写名称时留着上一个 change，其他消息不动。
  const start = { verb: null, change: null }
  const applying = afterPrompt(start, '/specseal-apply add-auth', names, 'specseal-panel')
  expect(applying).toEqual({ verb: 'apply', change: 'add-auth' })
  expect(afterPrompt(applying, '/specseal-quality', names, 'specseal-panel')).toEqual({ verb: 'quality', change: 'add-auth' })
  expect(afterPrompt(applying, '继续工作', names, 'specseal-panel')).toBe(applying)

  // 接回的对话：最后的技能调用与 specseal 指令为准。
  const history = [
    { role: 'user', text: '/specseal-apply add-auth', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool: 'Skill', input: { skill: 'specseal-review' } }] },
    { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command: 'specseal review scope refactor-store --json' } }] },
  ]
  expect(focusFromHistory(history, names, 'specseal-panel')).toEqual({ verb: 'review', change: 'refactor-store' })

  expect(titleOf({ verb: 'apply', change: 'add-auth' })).toBe('apply · add-auth')
  expect(titleOf({ verb: 'archive', change: 'add-auth', archived: true })).toBe('archive · add-auth ✓')

  // 标题解析回焦点：要是现有的 change，或标了 ✓ 的封存；你自己取的标题不算。
  expect(focusFromTitle('apply · add-auth', names)).toEqual({ verb: 'apply', change: 'add-auth' })
  expect(focusFromTitle('refactor-store', names)).toEqual({ verb: null, change: 'refactor-store' })
  expect(focusFromTitle('archive · gone-change ✓', names)).toEqual({ verb: 'archive', change: 'gone-change', archived: true })
  expect(focusFromTitle('apply · gone-change', names)).toBe(null)
  expect(focusFromTitle('整理 statusbar 的按钮', names)).toBe(null)
  expect(focusFromTitle('Claude Code', names)).toBe(null)
  expect(focusFromTitle(undefined, names)).toBe(null)
  expect(titleOf({ verb: null, change: 'add-auth' })).toBe('add-auth')
  expect(titleOf(start)).toBe(null)
})

test('指令放最前面，已经打的字留在后面当参数', () => {
  expect(withCommand('', '/specseal-apply')).toBe('/specseal-apply ')
  expect(withCommand('add-x', '/specseal-apply')).toBe('/specseal-apply add-x')
  expect(withCommand('/specseal-review add-x', '/specseal-verify')).toBe('/specseal-verify add-x')
})

test('archive+commit 一次填入两个指令，换别的技能时两个一起换掉', () => {
  const head = commandHead('archive+commit')

  expect(head).toBe('/specseal-archive + /specseal-commit')
  expect(withCommand('add-x', head)).toBe('/specseal-archive + /specseal-commit add-x')
  expect(withCommand('/specseal-archive + /specseal-commit add-x', '/specseal-apply')).toBe('/specseal-apply add-x')
  expect(withArgument('/specseal-archive + /specseal-commit ', 'add-x')).toBe('/specseal-archive + /specseal-commit add-x')
})

test('名称成为最前面指令的参数；没有指令时接在已打的字后面', () => {
  expect(withArgument('', 'add-auth')).toBe('add-auth')
  expect(withArgument('/specseal-apply', 'add-auth')).toBe('/specseal-apply add-auth')
  expect(withArgument('/specseal-apply old-one', 'add-auth')).toBe('/specseal-apply add-auth')
  expect(withArgument('look at', 'add-auth')).toBe('look at add-auth')
})

test('技能依工作流程分页，表上没有的落到 other，合并钮要两个技能都在', () => {
  const groups = groupSkills([
    'specseal-verify',
    'specseal-apply',
    'specseal-archive',
    'specseal-commit',
    'specseal-new-thing',
  ])
  expect(groups.map(g => [g.id, g.skills])).toEqual([
    ['build', ['apply']],
    ['quality', ['verify']],
    ['ship', ['archive', 'archive+commit']],
    ['other', ['commit', 'new-thing']],
  ])

  expect(groupSkills(['specseal-archive']).map(g => [g.id, g.skills])).toEqual([['ship', ['archive']]])
})

test('面板数据：顺序与阶段取 plan，任务数取 list，已转出的讨论不列', () => {
  const board = buildBoard(LIST, PLAN, TALK)

  expect(board.changes).toEqual([
    {
      name: 'add-auth',
      stage: 'in-progress',
      wave: 1,
      blockedBy: [],
      done: 5,
      total: 12,
      branch: 'specseal/add-auth',
      cwd: '/repo/.worktrees/add-auth',
    },
    {
      name: 'refactor-store',
      stage: 'proposed',
      wave: 2,
      blockedBy: ['add-auth'],
      done: 0,
      total: 8,
      branch: null,
      cwd: null,
    },
  ])
  expect(board.discussions.map(d => d.slug)).toEqual(['hold-auto-close', 'ship-it'])
  expect(board.next).toBe('add-auth')
})

test('输入框 # 菜单：只列提案中的 change，# 后面的字筛选名称，不分大小写', () => {
  const changes = [...PLAN.changes, { name: 'Add-Search', wave: 2, stage: 'proposed' as const, blockedBy: [] }]

  expect(proposedRows(changes, '#', '提案中')).toEqual([
    { text: 'refactor-store', description: 'specseal · 提案中' },
    { text: 'Add-Search', description: 'specseal · 提案中' },
  ])
  expect(proposedRows(changes, '#add', '提案中').map(r => r.text)).toEqual(['Add-Search'])
  expect(proposedRows(changes, '#auth', '提案中')).toEqual([])
})

test('Windows 经 cmd.exe 运行 specseal，其他平台直接运行', () => {
  expect(specsealArgv(['list', '--json'], false)).toEqual(['specseal', 'list', '--json'])
  expect(specsealArgv(['list', '--json'], true)).toEqual(['cmd.exe', '/d', '/c', 'specseal', 'list', '--json'])
})

test('语言：auto 跟着 Claude Code 的 language 设置，明选的值优先', () => {
  expect(resolveLang('auto', '台湾繁体中文zh-tw')).toBe('zh-CN')
  expect(resolveLang('auto', 'Chinese')).toBe('zh-CN')
  expect(resolveLang('auto', 'English')).toBe('en')
  expect(resolveLang('auto', undefined)).toBe('en')
  expect(resolveLang('en', '台湾繁体中文zh-tw')).toBe('en')
  expect(resolveLang('zh-CN', 'English')).toBe('zh-CN')
})

test('技能列：切分页、点技能把指令填进输入框', async ($, on) => {
  const filled: string[] = []
  engine(on, filled, 'English')

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'specseal-skills', surface: 'terminal', ...BAND })

  expect(await ui.find({ type: 'Text', text: ' Plan ' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'tab:plan' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'propose' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'apply' })).toBeUndefined()

  await ui.press({ key: 'tab:build' })
  await ui.press({ key: 'apply' })
  expect(filled).toEqual(['/specseal-apply add-x'])
})

for (const source of ['clear', 'resume'] as const) {
  test(`/${source} 之后没有 session.start，技能列仍然补抓清单、画得出来`, async ($, on) => {
    engine(on, [], 'English')
    on('classic.SessionStart', () => ({}))

    await $.classic.SessionStart({ source })
    const ui = await $.ui.mount({ plugin: 'specseal-skills', surface: 'terminal', ...BAND })

    expect(await ui.find({ type: 'Button', key: 'propose' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'panel', text: '◧ Panel' })).toBeDefined()
  })
}

test('Claude Code 设置是中文时，技能列用繁中标签', async ($, on) => {
  engine(on, [], '台湾繁体中文zh-tw')

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'specseal-skills', surface: 'terminal', ...BAND })

  expect(await ui.find({ type: 'Text', text: ' 规划 ' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'tab:build', text: '实作' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'panel', text: '◧ 面板' })).toBeDefined()
})

test('设置选项 language 明选 en 时，不跟 Claude Code 的中文设置', { options: { language: 'en' } }, async ($, on) => {
  engine(on, [], '台湾繁体中文zh-tw')

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'specseal-skills', surface: 'terminal', ...BAND })

  expect(await ui.find({ type: 'Button', key: 'tab:build', text: 'Build' })).toBeDefined()
})

test('分页与面板钮放不下一列时，面板钮移到 specseal 那一列', async ($, on) => {
  engine(on, [], '台湾繁体中文zh-tw')
  expect(cells('specseal')).toBe(8)
  expect(cells('◧ 面板')).toBe(6)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  // 规划、实作、收尾、其他四个分页加上面板钮：「分页 │ 面板」那一列要 31 + 5 + 6 = 42 格。
  const narrow = await $.ui.mount({
    plugin: 'specseal-skills',
    surface: 'terminal',
    ...BAND,
    props: { ...BAND.props, bodyColumns: 41 },
  })
  expect(await narrow.find({ type: 'Text', text: ' 规划 ' })).toBeDefined()
  expect(await narrow.find({ type: 'Button', key: 'panel', text: '◧ 面板' })).toBeDefined()
  expect(await narrow.find({ type: 'Button', key: 'propose' })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: ' │ ' })).toBeUndefined()
  expect(await narrow.find({ type: 'Text', text: 'Use when a change needs planning' })).toBeUndefined()
  await narrow.unmount()

  const wide = await $.ui.mount({
    plugin: 'specseal-skills',
    surface: 'terminal',
    ...BAND,
    props: { ...BAND.props, bodyColumns: 42 },
  })
  expect(await wide.find({ type: 'Text', text: ' │ ' })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: 'Use when a change needs planning' })).toBeDefined()
})

test('技能说明：平常藏着、鼠标移上去才显示；合并钮的说明只列两个指令', async ($, on) => {
  engine(on, [], 'English')

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'specseal-skills', surface: 'terminal', ...BAND })

  expect(await ui.find({ type: 'Text', text: 'Use when a change needs planning' })).toBeDefined()

  await ui.press({ key: 'tab:ship' })
  expect(await ui.find({ type: 'Text', text: 'Use when a change is finished' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '/specseal-archive → /specseal-commit' })).toBeDefined()
})

test('/specseal-panel 打开面板，点 change 名称填进输入框当参数', async ($, on) => {
  const filled: string[] = []
  engine(on, filled, '台湾繁体中文zh-tw')

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ran = await $.command.run({ command: 'specseal-panel', ...TYPED })
  expect(ran.text).toBe('specseal 面板已打开。')

  const ui = await $.ui.mount({ plugin: 'specseal-skills', surface: 'terminal', ...PANE })

  expect(await ui.find({ type: 'Button', key: 'next', text: 'add-auth' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ 进行中 1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▰▰▰▱▱▱ 5/12' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /等 add-auth/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 看板 ' })).toBeDefined()

  await ui.press({ key: 'change:add-auth' })
  expect(filled).toEqual(['add-x add-auth'])
})

test('任务清单：依 ## 分组，已勾与未勾分开，[M] 是手动任务，行尾 ID 不显示', () => {
  expect(parseTasks(TASKS)).toEqual([
    {
      title: '1. 登录',
      tasks: [
        { done: true, manual: false, label: '1.1 加上 OAuth 设置' },
        { done: false, manual: false, label: '1.2 接上回呼路由' },
      ],
    },
    { title: '2. 验收', tasks: [{ done: false, manual: true, label: '2.1 在浏览器手动登录一次' }] },
  ])
  expect(parseTasks('- [X] 没有标题的任务')).toEqual([{ title: '', tasks: [{ done: true, manual: false, label: '没有标题的任务' }] }])
})

test('工单只取最后一轮；没有工单的失败不算错误；讨论内文去掉 front matter', () => {
  expect(toTicket(TICKET)).toEqual({ round: 2, findings: TICKET.lastRound.findings })
  expect(isNoTicket("Error: no verify ticket for change 'add-auth'")).toBe(true)
  expect(isNoTicket('Error: Change not found')).toBe(false)
  expect(discussionBody('---\ntopic: x\n---\n\n# 背景\r\n内文\n')).toBe('# 背景\n内文')
  expect(discussionBody('# 讨论\n\n<!--\n规则\n-->\n\n## 背景\n内文')).toBe('# 讨论\n\n## 背景\n内文')
})

test('看板：展开 change 在 worktree 里读文档与任务；区块可以收起', async ($, on) => {
  const runs: Run[] = []
  engine(on, [], '台湾繁体中文zh-tw', runs)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'specseal-panel', ...TYPED })
  const ui = await $.ui.mount({ plugin: 'specseal-skills', surface: 'terminal', ...PANE })

  expect(await ui.find({ type: 'Text', text: /1\.2 接上回呼路由/ })).toBeUndefined()
  await ui.press({ key: 'open:change:add-auth' })

  expect(runs.filter(r => r.argv[1] === 'show' || r.argv[1] === 'status').map(r => [r.argv[1], r.cwd])).toEqual([
    ['show', '/repo/.worktrees/add-auth'],
    ['status', '/repo/.worktrees/add-auth'],
  ])
  expect(await ui.find({ type: 'Text', text: '✓ 提案  ✓ 设计  ✓ 规格  ○ 任务  ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1. 登录' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1/2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '☑ 1.1 加上 OAuth 设置' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '☐ [手动] 2.1 在浏览器手动登录一次' })).toBeDefined()

  await ui.press({ key: 'open:change:add-auth' })
  expect(await ui.find({ type: 'Text', text: /1\.1 加上 OAuth 设置/ })).toBeUndefined()

  await ui.press({ key: 'section:stage:in-progress' })
  expect(await ui.find({ type: 'Button', key: 'change:add-auth' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'change:refactor-store' })).toBeDefined()
})

test('讨论分页：讨论中与已结论分开，已转出的不列，展开显示内文', async ($, on) => {
  engine(on, [], '台湾繁体中文zh-tw')

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'specseal-panel', ...TYPED })
  const ui = await $.ui.mount({ plugin: 'specseal-skills', surface: 'terminal', ...PANE })

  expect(await ui.find({ type: 'Button', key: 'talk:hold-auto-close' })).toBeUndefined()
  await ui.press({ key: 'view:talk' })

  expect(await ui.find({ type: 'Text', text: /^ 讨论中 1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ 已结论 1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'talk:hold-auto-close' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'talk:old-idea' })).toBeUndefined()

  await ui.press({ key: 'open:talk:hold-auto-close' })
  expect(await ui.find({ type: 'Markdown', text: '# 背景\n\n讨论 hold-auto-close 的内文。' })).toBeDefined()
})

test('品质分页：只列有工单的 change，显示轮数与各严重度条数，展开看发现', async ($, on) => {
  engine(on, [], '台湾繁体中文zh-tw')

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'specseal-panel', ...TYPED })
  const ui = await $.ui.mount({ plugin: 'specseal-skills', surface: 'terminal', ...PANE })

  await ui.press({ key: 'view:quality' })

  expect(await ui.find({ type: 'Button', key: 'ticket:add-auth' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'ticket:refactor-store' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '   审查  第 2 轮 · 1 CRITICAL 1 WARNING ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '   验证  没有工单' })).toBeDefined()

  await ui.press({ key: 'open:ticket:add-auth' })
  expect(await ui.find({ type: 'Text', text: '审查 · 2 条' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'token 没有检查过期' })).toBeDefined()
})

test('送出 specseal 技能指令后，技能列标出步骤与 change，session 标题也换成它；specseal 指令里的 change 跟着更新', async ($, on) => {
  engine(on, [], 'English')
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.messages', () => ({ value: [] }))
  on('classic.UserPromptSubmit', () => ({}))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const result = await $.classic.UserPromptSubmit({ prompt: '/specseal-apply add-auth' })
  expect(result.sessionTitle).toBe('apply · add-auth')

  const ui = await $.ui.mount({ plugin: 'specseal-skills', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'apply' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'add-auth' })).toBeDefined()

  // 技能中途用另一个 change 调用 CLI：技能列立刻换，标题等下一次送出。
  await $.tool.call({ tool: 'Bash', command: 'specseal status --change "refactor-store" --json' } as never)
  expect(await ui.find({ type: 'Text', text: 'refactor-store' })).toBeDefined()
  const next = await $.classic.UserPromptSubmit({ prompt: '继续工作' })
  expect(next.sessionTitle).toBe('apply · refactor-store')
})

test('还没碰过 specseal 的 session 不画焦点，也不改标题', async ($, on) => {
  engine(on, [], 'English')
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.messages', () => ({ value: [] }))
  on('classic.UserPromptSubmit', () => ({}))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const result = await $.classic.UserPromptSubmit({ prompt: '帮我看一下 README' })
  expect(result.sessionTitle).toBeUndefined()
  const ui = await $.ui.mount({ plugin: 'specseal-skills', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: '▸ ' })).toBeUndefined()
})

test('在某个 change 的 worktree 里开的 session，一开始就标出那个 change', async ($, on) => {
  engine(on, [], 'English')
  on('session.cwd', () => ({ value: '/repo/.worktrees/add-auth' }))
  on('session.messages', () => ({ value: [] }))

  await $.session.start({ cwd: '/repo/.worktrees/add-auth', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'specseal-skills', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'add-auth' })).toBeDefined()
})

// 焦点测试的引擎替身：技能、CLI、对话纪录与 classic 事件的底层。
const focusEngine = (on: On, cwd = '/repo') => {
  engine(on, [], 'English')
  on('session.cwd', () => ({ value: cwd }))
  on('session.messages', () => ({ value: [] }))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
}

test('讨论、查来源这类步骤不做 change：消息和指令里提到的名称不算，propose 之后建的 change 才算', () => {
  const names = ['add-auth', 'refactor-store']
  const applying = { verb: 'apply', change: 'add-auth' }
  const talking = afterPrompt(applying, '/specseal-discuss 来源是 refactor-store 的稽核', names, 'specseal-panel')
  expect(talking).toEqual({ verb: 'discuss', change: null })
  expect(commandChange(talking, 'specseal show refactor-store --json', names)).toBe(null)

  const proposing = afterPrompt(talking, '/specseal-propose --from-discussion talk', names, 'specseal-panel')
  expect(proposing).toEqual({ verb: 'propose', change: null })
  expect(commandChange(proposing, 'specseal status --change add-auth --json', names)).toBe('add-auth')

  expect(withVerb(applying, 'review')).toEqual({ verb: 'review', change: 'add-auth' })
  expect(withVerb(applying, 'trace')).toEqual({ verb: 'trace', change: null })

  const history = [
    { role: 'user', text: '/specseal-discuss 提到 add-auth', toolUses: [{ tool: 'Bash', input: { command: 'specseal show add-auth --json' } }] },
  ]
  expect(focusFromHistory(history, names, 'specseal-panel')).toEqual({ verb: 'discuss', change: null })
})

test('在 Herdr 的终端机里，焦点变了就写标签回报，同一个 change 不重复写', async ($, on) => {
  const runs: Run[] = []
  engine(on, [], 'English', runs, () => [], { HC_TERMINAL_ID: 't7' })
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.messages', () => ({ value: [] }))
  on('classic.UserPromptSubmit', () => ({}))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const labels = () => runs.filter(r => r.argv[0] === 'hc').map(r => r.argv.join(' '))
  expect(labels().at(-1)).toBe('hc label t7 specseal.focus=-')

  await $.classic.UserPromptSubmit({ prompt: '/specseal-apply add-x' })
  const named = labels().at(-1) ?? ''
  await $.classic.UserPromptSubmit({ prompt: '继续' })
  expect(labels().at(-1)).toBe(named)
})

test('不在 Herdr 的终端机里不跑 hc', async ($, on) => {
  const runs: Run[] = []
  engine(on, [], 'English', runs)
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.messages', () => ({ value: [] }))
  on('classic.UserPromptSubmit', () => ({}))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.classic.UserPromptSubmit({ prompt: '/specseal-apply add-x' })
  expect(runs.filter(r => r.argv[0] === 'hc')).toEqual([])
})

test('/clear：技能列清空；标题是这个 mod 设的，下一次送出时改回 Claude Code，你自己取的不动', async ($, on) => {
  focusEngine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  // /clear 当下引擎不让 mod 改标题，等下一次送出。
  const cleared = await $.classic.SessionStart({ source: 'clear', session_title: 'apply · add-auth' })
  expect(cleared.sessionTitle).toBeUndefined()
  const first = await $.classic.UserPromptSubmit({ prompt: '帮我看 README', session_title: 'apply · add-auth' })
  expect(first.sessionTitle).toBe('Claude Code')
  const ui = await $.ui.mount({ plugin: 'specseal-skills', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: '▸ ' })).toBeUndefined()

  await $.classic.SessionStart({ source: 'clear', session_title: '我的工作' })
  const mine = await $.classic.UserPromptSubmit({ prompt: '帮我看 README', session_title: '我的工作' })
  expect(mine.sessionTitle).toBeUndefined()
})

test('/resume：从接回 session 的标题找回步骤与 change，封存过的带 ✓', async ($, on) => {
  focusEngine(on)
  await $.classic.SessionStart({ source: 'resume', session_title: 'review · refactor-store' })
  const ui = await $.ui.mount({ plugin: 'specseal-skills', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'review' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'refactor-store' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' ✓' })).toBeUndefined()
})

test('封存指令跑完、change 从清单消失后，技能列与标题标上 ✓', async ($, on) => {
  focusEngine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.classic.UserPromptSubmit({ prompt: '/specseal-archive add-auth' })

  const before = LIST.changes
  LIST.changes = LIST.changes.filter(c => c.name !== 'add-auth')
  try {
    await $.tool.call({ tool: 'Bash', command: 'specseal archive add-auth --yes' } as never)
    const ui = await $.ui.mount({ plugin: 'specseal-skills', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: 'add-auth' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' ✓' })).toBeDefined()
    const next = await $.classic.UserPromptSubmit({ prompt: '好' })
    expect(next.sessionTitle).toBe('archive · add-auth ✓')
  } finally {
    LIST.changes = before
  }
})

test('送出技能指令后马上按 Esc（还没跑任何工具）：技能列回到原本的步骤；工具开始跑之后才中断就留着', async ($, on) => {
  focusEngine(on)
  on('turn.complete', () => ({ text: '' }))
  const turn = $.turn as unknown as { complete: (e: unknown) => Promise<unknown> }
  const finish = (isAborted: boolean) =>
    turn.complete({ turnId: 't', durationMs: 1000, answer: '', isAborted, reason: isAborted ? 'aborted' : 'answer' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.classic.UserPromptSubmit({ prompt: '/specseal-apply add-auth' })
  await finish(false)
  const ui = await $.ui.mount({ plugin: 'specseal-skills', surface: 'terminal', ...BAND })

  await $.classic.UserPromptSubmit({ prompt: '/specseal-quality add-auth' })
  expect(await ui.find({ type: 'Text', text: 'quality' })).toBeDefined()
  await finish(true)
  expect(await ui.find({ type: 'Text', text: 'apply' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'quality' })).toBeUndefined()
  // 标题只能在送出时改：下一次送出就回到原本的步骤。
  const next = await $.classic.UserPromptSubmit({ prompt: '继续工作' })
  expect(next.sessionTitle).toBe('apply · add-auth')
  await finish(false)

  await $.classic.UserPromptSubmit({ prompt: '/specseal-quality add-auth' })
  await $.tool.call({ tool: 'Bash', command: 'git status' } as never)
  await finish(true)
  expect(await ui.find({ type: 'Text', text: 'quality' })).toBeDefined()
})

test('/clear、/resume 换成新 session 时，开着的面板重新读取，不会一直停在读取中', async ($, on) => {
  const runs: Run[] = []
  let isOpen = false
  engine(on, [], 'English', runs, () => (isOpen ? ['specseal-panel'] : []))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.messages', () => ({ value: [] }))
  on('classic.SessionStart', () => ({}))
  const readsBoard = () => runs.some(r => r.argv.includes('plan'))

  for (const source of ['clear', 'resume'] as const) {
    isOpen = false
    runs.length = 0
    await $.classic.SessionStart({ source })
    expect(readsBoard()).toBe(false)

    isOpen = true
    runs.length = 0
    await $.classic.SessionStart({ source })
    expect(readsBoard()).toBe(true)
  }
})

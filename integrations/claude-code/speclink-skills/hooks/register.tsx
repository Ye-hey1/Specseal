import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Board, Detail, Focus, Lang, PanelChange, PanelDiscussion, PanelTab, PanelView, Quality, Skill, Ticket } from '../types'

import { buildBoard, discussionBody, isNoTicket, parseTasks, proposedRows, specsealArgv, toTicket } from './board'
import type { DiscussJson, DiscussShowJson, ListJson, PlanJson, ShowJson, StatusJson, TicketJson } from './board'
import { afterPrompt, commandChange, focusFromHistory, focusFromTitle, PLAIN_TITLE, specsealCommand, titleOf, withVerb } from './focus'
import type { GroupId } from './groups'
import { commandHead, groupSkills, PREFIX, withArgument, withCommand } from './skills'
import { resolveLang, TEXT } from './text'

const PANE = 'specseal-panel'
const PANEL_COMMAND = 'specseal-panel'
const skills = atom({ plugin: 'specseal-skills', key: 'skills' } as const, [] as Skill[])
const tab = atom({ plugin: 'specseal-skills', key: 'tab' } as const, '')
const board = atom({ plugin: 'specseal-skills', key: 'board' } as const, null as Board | null)
const lang = atom({ plugin: 'specseal-skills', key: 'lang' } as const, 'en' as Lang)
const view = atom({ plugin: 'specseal-skills', key: 'view' } as const, { tab: 'board', closed: [], open: [] } as PanelView)
const details = atom({ plugin: 'specseal-skills', key: 'details' } as const, {} as Record<string, Detail>)
const quality = atom({ plugin: 'specseal-skills', key: 'quality' } as const, null as Quality | null)
// 这个 session 正在跑的步骤与 change，画在技能列上，也拿来当 session 标题。
const focus = atom({ plugin: 'specseal-skills', key: 'focus' } as const, { verb: null, change: null } as Focus)

// 已知的 change 名称与 worktree 文件夹（`specseal list`），用来从指令里认出 change。
let known: { names: string[]; worktrees: { name: string; path: string }[]; loadedAt: number } = { names: [], worktrees: [], loadedAt: 0 }
// /clear 带过来的标题是这个 mod 设的：下一次送出时改回「Claude Code」（/clear 当下引擎不让 mod 改标题）。
let staleTitle = false
// 送出的技能指令换掉焦点之前的那一个；模型开始跑工具时清掉。这一轮在那之前就被 Esc 中断，焦点回到它。
let undo: Focus | null = null
// 输入框 `#` 菜单用的 change 与阶段（`specseal plan`）。每打一个字都会问一次，5 秒内用同一份。
let planned: { changes: PlanJson['changes']; loadedAt: number } = { changes: [], loadedAt: 0 }

// 上一次回报给 Herdr 的 change。undefined 是还没回报过。
let reported: string | null | undefined

// 用 `$` 的函数都留在这个档：`$` 只能传进同档声明的函数，不能跨 import。

// 在 Herdr 的终端机里，把目前的 change 写成标签，Herdr 面板才能和技能列同步：标题只有送出消息时才能改。
// 没有 change 也要写（`-`），面板才知道不用再看标题。不在 Herdr 里就什么都不做，回报失败也不影响技能列。
const reportFocus = async ($: EngineInterface, change: string | null) => {
  if (reported === change) {
    return
  }
  reported = change
  const terminal = await $.env.get('HC_TERMINAL_ID')
  if (terminal !== undefined && terminal !== '') {
    await $.process.run(['hc', 'label', terminal, `specseal.focus=${change ?? '-'}`]).catch(() => undefined)
  }
}

const setFocus = async ($: EngineInterface, change: (f: Focus) => Focus) => {
  await update($, focus, change)
  await reportFocus($, (await read($, focus)).change)
}

const refresh = async ($: EngineInterface) => {
  const found = (await $.command.list())
    .filter(c => c.name.startsWith(PREFIX) && c.name !== PANEL_COMMAND)
    .map(c => ({ name: c.name, description: c.description }))
  await update($, skills, () => found)
}

// 语言、面板指令与技能清单都跟着 session 走。
const setup = async ($: EngineInterface, language: unknown) => {
  const chosen = resolveLang(language, (await $.settings.read()).language)
  await update($, lang, () => chosen)
  await $.command.register({ name: PANEL_COMMAND, description: TEXT[chosen].panelCommand })
  await refresh($)
  await loadKnown($)
}

// 读不到（不是 specseal 项目、没装 CLI）就当作没有 change。
const loadKnown = async ($: EngineInterface) => {
  try {
    const list = await specsealJson<ListJson>($, ['list'])
    known = {
      names: list.changes.map(c => c.name),
      worktrees: list.changes.flatMap(c => (c.worktree === undefined ? [] : [{ name: c.name, path: c.worktree.path }])),
      loadedAt: Date.now(),
    }
  } catch {
    known = { names: [], worktrees: [], loadedAt: Date.now() }
  }
}

// 读不到时当作没有 change，菜单不出现。
const loadPlanned = async ($: EngineInterface) => {
  if (Date.now() - planned.loadedAt > 5_000) {
    const changes = await specsealJson<PlanJson>($, ['plan']).then(
      p => p.changes,
      () => [],
    )
    planned = { changes, loadedAt: Date.now() }
  }
  return planned.changes
}

// 还不知道焦点时（刚开 session、/resume 接回）：在某个 change 的 worktree 里开的 session 就是那个
// change；否则从对话纪录找最后的步骤与 change，再找不到就看 session 标题是不是这个 mod 设的。
const recall = async ($: EngineInterface, title?: string) => {
  const current = await read($, focus)
  if (current.verb !== null || current.change !== null) {
    return current
  }
  const cwd = await $.session.cwd()
  const here = known.worktrees.find(w => cwd === w.path || cwd.startsWith(`${w.path}/`))
  const history = here !== undefined ? { verb: null, change: here.name } : focusFromHistory(await $.session.messages(), known.names, PANEL_COMMAND)
  const found = history.verb !== null || history.change !== null ? history : (focusFromTitle(title, known.names) ?? history)
  await setFocus($, () => found)
  return found
}

// specseal 指令跑完后认 change；认不出来时可能是刚建的 change，重读一次清单（最多每 10 秒一次）。
// 封存指令跑完也重读：change 从清单消失就是封存好了，标上 ✓。名称要用封存前的清单认。
const noteCommand = async ($: EngineInterface, command: string) => {
  const current = await read($, focus)
  let change = commandChange(current, command, known.names)
  const archiving = /(^|[\s;&|(])specseal\s+archive\b/.test(command)
  if (archiving || (change === null && Date.now() - known.loadedAt > 10_000)) {
    await loadKnown($)
    change ??= commandChange(current, command, known.names)
  }
  if (change === null) {
    return
  }
  const archived = archiving && !known.names.includes(change)
  await setFocus($, f =>
    f.change === change && (f.archived === true) === archived ? f : archived ? { ...f, change, archived: true as const } : { verb: f.verb, change },
  )
}

const putCommand = async ($: EngineInterface, skill: string) => {
  const { text } = await $.prompt.read()
  await $.prompt.fill({ text: withCommand(text, commandHead(skill)) })
}

const putArgument = async ($: EngineInterface, arg: string) => {
  const { text } = await $.prompt.read()
  await $.prompt.fill({ text: withArgument(text, arg) })
}

// worktree 里的 change 要在它的文件夹跑，才读得到它那份 tasks.md。
const runSpecseal = async ($: EngineInterface, args: string[], cwd: string | null = null) => {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  return $.process.run(specsealArgv([...args, '--json'], isWindows), cwd === null ? undefined : { cwd })
}

const failure = (args: string[], ran: { exitCode: number; stderr: string }) =>
  new Error(`specseal ${args.join(' ')}: ${ran.stderr.trim() || `exit ${ran.exitCode}`}`)

const specsealJson = async <T,>($: EngineInterface, args: string[], cwd: string | null = null): Promise<T> => {
  const ran = await runSpecseal($, args, cwd)
  if (ran.exitCode !== 0) {
    throw failure(args, ran)
  }
  return JSON.parse(ran.stdout) as T
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

// 读取失败时保留上一份数据，并记下原因。
const loadBoard = async ($: EngineInterface, last: Board | null): Promise<Board> => {
  const loadedAt = new Date().toISOString()
  try {
    const [list, plan, talk] = await Promise.all([
      specsealJson<ListJson>($, ['list']),
      specsealJson<PlanJson>($, ['plan']),
      specsealJson<DiscussJson>($, ['discuss', 'list']),
    ])
    return { ...buildBoard(list, plan, talk), loadedAt, error: null }
  } catch (err) {
    return { changes: [], discussions: [], next: null, skipped: [], ...last, loadedAt, error: errorText(err) }
  }
}

// 展开一列时才读：change 读文档状态与任务，讨论读内文。重读时先留着旧内容，画面不闪。
const loadDetail = async ($: EngineInterface, id: string) => {
  await update($, details, d => (d[id] === undefined ? { ...d, [id]: { kind: 'loading' as const } } : d))
  let detail: Detail
  try {
    if (id.startsWith('change:')) {
      const name = id.slice('change:'.length)
      const cwd = (await read($, board))?.changes.find(c => c.name === name)?.cwd ?? null
      const [shown, status] = await Promise.all([
        specsealJson<ShowJson>($, ['show', name], cwd),
        specsealJson<StatusJson>($, ['status', '--change', name], cwd),
      ])
      detail = {
        kind: 'change',
        artifacts: status.artifacts.map(a => ({ id: a.id, done: a.status === 'done' })),
        groups: parseTasks(shown.tasks),
      }
    } else {
      const shown = await specsealJson<DiscussShowJson>($, ['discuss', 'show', id.slice('talk:'.length)])
      detail = { kind: 'talk', body: discussionBody(shown.content) }
    }
  } catch (err) {
    detail = { kind: 'error', message: errorText(err) }
  }
  await update($, details, d => ({ ...d, [id]: detail }))
}

// 没有工单时 CLI 以失败回报，算「没有」；其他失败才是错误。
const ticketOf = async ($: EngineInterface, station: 'review' | 'verify', change: string, cwd: string | null) => {
  const args = [station, 'show', change]
  const ran = await runSpecseal($, args, cwd)
  if (ran.exitCode === 0) {
    return toTicket(JSON.parse(ran.stdout) as TicketJson)
  }
  if (isNoTicket(ran.stderr)) {
    return null
  }
  throw failure(args, ran)
}

// 每个 change 各问一次 review 与 verify，所以只在品质分页开着时读。
const loadQuality = async ($: EngineInterface) => {
  const changes = (await read($, board))?.changes ?? []
  let loaded: Quality
  try {
    const rows = await Promise.all(
      changes.map(async c => {
        const [review, verify] = await Promise.all([
          ticketOf($, 'review', c.name, c.cwd),
          ticketOf($, 'verify', c.name, c.cwd),
        ])
        return { change: c.name, review, verify }
      }),
    )
    loaded = { rows: rows.filter(r => r.review !== null || r.verify !== null), error: null }
  } catch (err) {
    loaded = { rows: (await read($, quality))?.rows ?? [], error: errorText(err) }
  }
  await update($, quality, () => loaded)
}

// 按钮不等这些读完：读取跑超过 10 秒，按钮会被引擎判逾时。
const toggleRow = async ($: EngineInterface, id: string) => {
  const opening = !(await read($, view)).open.includes(id)
  await update($, view, v => ({ ...v, open: opening ? [...v.open, id] : v.open.filter(o => o !== id) }))
  // ticket 列的发现已在品质数据里，不用另外读。
  if (opening && !id.startsWith('ticket:')) {
    await loadDetail($, id)
  }
}

const toggleSection = ($: EngineInterface, id: string) =>
  update($, view, v => ({ ...v, closed: v.closed.includes(id) ? v.closed.filter(c => c !== id) : [...v.closed, id] }))

const chooseTab = async ($: EngineInterface, tab: PanelTab) => {
  await update($, view, v => ({ ...v, tab }))
  if (tab === 'quality') {
    await loadQuality($)
  }
}

const isPanelOpen = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE)

// 展开中的列与品质分页跟着重读；不等它们，免得拖住调用的 hook。
const refreshBoard = async ($: EngineInterface) => {
  const loaded = await loadBoard($, await read($, board))
  await update($, board, () => loaded)
  const { open, tab } = await read($, view)
  const alive = new Set([
    ...loaded.changes.map(c => `change:${c.name}`),
    ...loaded.discussions.map(d => `talk:${d.slug}`),
  ])
  for (const id of open.filter(o => alive.has(o))) {
    void loadDetail($, id)
  }
  if (tab === 'quality') {
    void loadQuality($)
  }
}

// 回传切换后面板是否开着。
const togglePanel = async ($: EngineInterface) => {
  if (await isPanelOpen($)) {
    await $.ui.close({ id: PANE })
    return false
  }
  await $.ui.open({ id: PANE, title: 'specseal' })
  await refreshBoard($)
  return true
}

// 分页颜色用主题色键，跟着用户的深浅主题走。
const GROUP_COLOR: Record<GroupId, string> = {
  plan: 'merged',
  build: 'ide',
  quality: 'claude',
  ship: 'success',
  other: 'inactive',
}

const TABS: readonly PanelTab[] = ['board', 'talk', 'quality']

const SEVERITIES = ['CRITICAL', 'WARNING', 'SUGGESTION'] as const
const SEVERITY_COLOR: Record<string, string> = { CRITICAL: 'error', WARNING: 'warning', SUGGESTION: 'suggestion' }

const STAGES = [
  { id: 'proposed', color: undefined },
  { id: 'in-progress', color: 'suggestion' },
  { id: 'ready', color: 'success' },
] as const

const cut = (text: string, room: number) =>
  text.length <= room ? text : `${text.slice(0, Math.max(1, room - 1))}…`

// 文本在终端机占几格：中日韩文本（U+2E80 起）一个字两格。
export const cells = (text: string) => [...text].reduce((n, ch) => n + (ch.codePointAt(0)! >= 0x2e80 ? 2 : 1), 0)

const mini = (done: number, total: number) => {
  const filled = Math.round((done / total) * 6)
  return '▰'.repeat(filled) + '▱'.repeat(6 - filled)
}

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await setup($, options.language)
    await recall($)

    return next(e)
  })

  // `/clear`、`/resume` 换成另一个 session，却不发 session.start；技能清单空着，技能列就整列不画。
  // 面板留在画面上，数据却是新 session 的（空的），开着就重读，否则会一直停在「读取中」。
  // /clear：新 session 没有焦点；Claude Code 会把旧标题带过来，是这个 mod 设的就在下一次送出时改回
  // 「Claude Code」，你自己取的不动。/resume：接回的 session 带着它的标题，从标题找回步骤与 change。
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source !== 'clear' && e.source !== 'resume') {
      return next(e)
    }
    await setup($, options.language)
    if (await isPanelOpen($)) {
      await refreshBoard($)
    }
    const fromTitle = focusFromTitle(e.session_title, known.names)
    if (e.source === 'clear') {
      staleTitle = fromTitle !== null
    } else if (fromTitle !== null) {
      await setFocus($, f => (f.verb === null && f.change === null ? fromTitle : f))
    }
    // /clear、/resume 换了 session，焦点也跟着换。
    await reportFocus($, (await read($, focus)).change)

    return next(e)
  })

  // `specseal update` 可能在 session 中途增减技能；这一轮也可能动到面板上的 change。送出技能指令后
  // 还没跑任何工具就按了 Esc：那一步没有开始，技能列回到原本的焦点（标题等下一次送出才改得回来）。
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      const back = e.isAborted ? undo : null
      undo = null
      if (back !== null) {
        await setFocus($, () => back)
      }
    }
    await refresh($)
    if (await isPanelOpen($)) {
      await refreshBoard($)
    }

    return done
  })

  // 一轮做到一半的 `specseal task done`（或任何 specseal 调用）立刻反映到面板；指令里的 change 名称
  // 就是这个 session 正在处理的 change。subagent 的指令（带 agentId）不算。
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const command = specsealCommand(e.command)
    if (command !== null) {
      if (e.agentId === undefined) {
        await noteCommand($, command)
      }
      if (await isPanelOpen($)) {
        await refreshBoard($)
      }
    }

    return ran
  }).catch(($, e, next) => next(e))

  // 主对话开始跑工具，送出的那一步就算开始了，之后被中断也不回到上一步。
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) {
      undo = null
    }

    return next(e)
  })

  // 模型自己调用的 specseal 技能（例如 quality 里接着跑 review）：换成那一步。
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    if (e.agentId === undefined && e.skill.startsWith(PREFIX)) {
      await setFocus($, f => withVerb(f, e.skill.slice(PREFIX.length)))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // 你送出消息时：specseal 技能指令换成新的步骤；然后把「步骤 · change」设成 session 标题，Warp
  // 侧栏的分页名称就是它。标题只能在送出消息与开 session 时改，所以技能中途才认出的 change，
  // 要到下一次送出才会出现在标题上。
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const done = await next(e)
    const before = staleTitle ? await read($, focus) : await recall($, e.session_title)
    const after = afterPrompt(before, e.prompt, known.names, PANEL_COMMAND)
    undo = after !== before ? before : null
    if (after !== before) {
      await setFocus($, () => after)
    }
    const title = titleOf(after) ?? (staleTitle ? PLAIN_TITLE : null)
    staleTitle = false

    return title === null ? done : { ...done, sessionTitle: title }
  }).catch(($, e, next) => next(e))

  // 输入框打 `#`：下拉列表列出提案中的 change，选了就填入名称，例如 `/specseal-apply #` 再选一个。
  on('prompt.autocomplete', { token: /^#/ }, async ($, e, next) => {
    const below = await next(e)
    const t = TEXT[await read($, lang)]

    return { suggestions: [...below.suggestions, ...proposedRows(await loadPlanned($), e.token, t.stages.proposed)] }
  })

  on('command.run', { command: PANEL_COMMAND }, async $ => {
    const t = TEXT[await read($, lang)]
    const isOpen = await togglePanel($)

    return { text: isOpen ? t.panelOpened : t.panelClosed }
  })

  // 上方空一列，和 Claude Code 自己的消息分开。每个分页前面一颗同色圆点，选中的
  // 分页是有底色的胶囊；没选中的左右各留一格，切换分页时位置不会跳动。鼠标移到技能上，
  // 技能和技能列右边的说明同属一个 hover scope，一起亮起来；说明平常藏着，不占位置。
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const installed = await read($, skills)
    const groups = groupSkills(installed.map(s => s.name))
    if (e.props.hasSurvey || groups.length === 0) {
      return below
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const t = TEXT[await read($, lang)]
    const chosen = await read($, tab)
    const current = groups.find(g => g.id === chosen) ?? groups[0]!
    const color = GROUP_COLOR[current.id]
    // 合并钮没有自己的 description，只列指令，不分语言。
    const about = (skill: string) =>
      skill.includes('+')
        ? skill.split('+').map(commandHead).join(' → ')
        : (installed.find(s => s.name === PREFIX + skill)?.description ?? '')

    const tabs = (
      <Box flexWrap="wrap" columnGap={1}>
        {groups.map(g => (
          <Box>
            <Text color={GROUP_COLOR[g.id]}>●</Text>
            {g.id === current.id ? (
              <Text backgroundColor={color} color="inverseText" bold>{` ${t.groups[g.id]} `}</Text>
            ) : (
              <Box paddingX={1}>
                <Button
                  key={`tab:${g.id}`}
                  label={t.groups[g.id]}
                  plain
                  dimColor
                  onPress={() => update($, tab, () => g.id)}
                />
              </Box>
            )}
          </Box>
        ))}
      </Box>
    )
    const panelButton = <Button key="panel" label={`◧ ${t.panel}`} plain dimColor onPress={() => togglePanel($)} />
    // 这个 session 正在跑的步骤与 change：「▸ apply · add-x」，步骤用它所在分页的颜色。
    const now = await read($, focus)
    const nowGroup = groups.find(g => now.verb !== null && g.skills.includes(now.verb))
    const nowLine = (now.verb !== null || now.change !== null) && (
      <Box>
        <Text dimColor>▸ </Text>
        {now.verb !== null && (
          <Text color={nowGroup === undefined ? undefined : GROUP_COLOR[nowGroup.id]} bold>
            {now.verb}
          </Text>
        )}
        {now.verb !== null && now.change !== null && <Text dimColor> · </Text>}
        {now.change !== null && <Text wrap="truncate-end">{now.change}</Text>}
        {now.archived === true && <Text color="success"> ✓</Text>}
      </Box>
    )
    const skillButtons = (
      <Box flexWrap="wrap" columnGap={2} flexShrink={1}>
        {current.skills.map(skill => (
          <Button
            key={skill}
            label={skill}
            plain
            hover={{ scope: `skill:${skill}`, color }}
            onPress={() => putCommand($, skill)}
          />
        ))}
      </Box>
    )

    // 第一列是「specseal」与目前在处理的步骤、change，下面一列分页与面板钮，再下面一列技能。技能列的
    // 宽度（终端机扣掉引擎右边放 [-] 的五格）放不下「分页 │ 面板」时改窄版：面板钮移到第一列最右边，
    // 分页不会从中间拆开。窄版右边没有地方放技能说明，所以不显示。
    const title = (
      <Box columnGap={2} flexShrink={1}>
        <Text dimColor>specseal</Text>
        {nowLine}
      </Box>
    )
    const tabsWidth = groups.reduce((n, g) => n + cells(t.groups[g.id]) + 3, groups.length - 1)
    const wideWidth = tabsWidth + 5 + cells(`◧ ${t.panel}`)
    if (e.props.bodyColumns < wideWidth) {
      return (
        <Box flexDirection="column">
          <Box marginTop={1} flexDirection="column" alignSelf="flex-start">
            <Box justifyContent="space-between" columnGap={2}>
              {title}
              {panelButton}
            </Box>
            {tabs}
            <Box paddingLeft={2}>{skillButtons}</Box>
          </Box>
          {below}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box marginTop={1} flexDirection="column">
          {title}
          <Box flexWrap="wrap" columnGap={1}>
            {tabs}
            <Text dimColor> │ </Text>
            {panelButton}
          </Box>
          <Box paddingLeft={2}>
            {skillButtons}
            <Box width={0} flexGrow={1} marginLeft={3} flexDirection="column" overflow="hidden">
              {current.skills.map(skill => (
                <Box display="none" hover={{ scope: `skill:${skill}`, display: 'flex' }}>
                  <Text dimColor wrap="truncate-end">
                    {about(skill)}
                  </Text>
                </Box>
              ))}
            </Box>
          </Box>
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const t = TEXT[await read($, lang)]
    const b = await read($, board)
    const v = await read($, view)
    const shown = await read($, details)
    const q = await read($, quality)
    const width = e.props.bodyColumns
    const isOpen = (id: string) => v.open.includes(id)

    const toggle = (id: string) => (
      <Button key={`open:${id}`} label={isOpen(id) ? '▾' : '▸'} plain dimColor onPress={() => void toggleRow($, id)} />
    )

    // 可收合的区块：`▾ 提案中 8`，点 ▾ 收起、点 ▸ 打开。
    const section = (id: string, title: string, color: string | undefined, rows: RenderChildren[]) => {
      const closed = v.closed.includes(id)
      return (
        <Box key={`section:${id}`} flexDirection="column" marginTop={1}>
          <Box>
            <Button key={`section:${id}`} label={closed ? '▸' : '▾'} plain dimColor onPress={() => void toggleSection($, id)} />
            <Text bold color={color}>
              {` ${title} `}
              <Text dimColor>{rows.length}</Text>
            </Text>
          </Box>
          {!closed && rows}
        </Box>
      )
    }

    const pending = (detail: Detail | undefined) =>
      detail === undefined || detail.kind === 'loading' ? (
        <Text dimColor>{t.loading}</Text>
      ) : detail.kind === 'error' ? (
        <Text color="error" wrap="truncate-end">
          {detail.message}
        </Text>
      ) : null

    // 展开的 change：文档打勾，再列任务（已勾的画暗，手动任务标出来）。
    const changeDetail = (c: PanelChange) => {
      const detail = shown[`change:${c.name}`]
      return (
        <Box flexDirection="column" paddingLeft={5}>
          {pending(detail)}
          {detail?.kind === 'change' && (
            <Text wrap="truncate-end">
              {detail.artifacts.map(a => (
                <Text color={a.done ? 'success' : undefined} dimColor={!a.done}>
                  {`${a.done ? '✓' : '○'} ${t.artifacts[a.id] ?? a.id}  `}
                </Text>
              ))}
            </Text>
          )}
          {detail?.kind === 'change' && detail.groups.length === 0 && <Text dimColor>{t.noTasks}</Text>}
          {detail?.kind === 'change' &&
            detail.groups.map(g => (
              <Box flexDirection="column">
                {g.title !== '' && (
                  <Box>
                    <Box flexShrink={1}>
                      <Text dimColor wrap="truncate-end">
                        {g.title}
                      </Text>
                    </Box>
                    <Box flexShrink={0} marginLeft={2}>
                      <Text dimColor>{`${g.tasks.filter(task => task.done).length}/${g.tasks.length}`}</Text>
                    </Box>
                  </Box>
                )}
                {g.tasks.map(task => (
                  <Text wrap="truncate-end" dimColor={task.done}>
                    {task.done ? '☑ ' : '☐ '}
                    {task.manual && <Text color="warning">{`[${t.manual}] `}</Text>}
                    {task.label}
                  </Text>
                ))}
              </Box>
            ))}
        </Box>
      )
    }

    const changeRow = (c: PanelChange) => {
      const isBlocked = c.blockedBy.length > 0
      const tasks = c.total > 0 ? `${mini(c.done, c.total)} ${c.done}/${c.total}` : ''
      const mark = c.branch === null ? '' : ' ⎇'
      const room = width - 5 - mark.length - tasks.length - 1
      return (
        <Box key={`row:${c.name}`} flexDirection="column">
          <Box>
            {toggle(`change:${c.name}`)}
            <Text dimColor>{`${c.wave}`.padStart(3)} </Text>
            <Button
              key={`change:${c.name}`}
              label={cut(c.name, room)}
              plain
              dimColor={isBlocked}
              onPress={() => putArgument($, c.name)}
            />
            {mark !== '' && <Text color="suggestion">{mark}</Text>}
            <Box flexGrow={1} />
            <Text dimColor={isBlocked}>{tasks}</Text>
          </Box>
          {isBlocked && <Text dimColor wrap="truncate-end">{`     ${t.waitsFor(c.blockedBy.join(', '))}`}</Text>}
          {isOpen(`change:${c.name}`) && changeDetail(c)}
        </Box>
      )
    }

    const talkRow = (d: PanelDiscussion) => {
      const detail = shown[`talk:${d.slug}`]
      return (
        <Box key={`talk-row:${d.slug}`} flexDirection="column">
          <Box>
            {toggle(`talk:${d.slug}`)}
            <Text> </Text>
            <Button key={`talk:${d.slug}`} label={cut(d.slug, width - 12)} plain onPress={() => putArgument($, d.slug)} />
            <Box flexGrow={1} />
            <Text dimColor>
              {d.status === 'open' ? t.rounds(d.rounds) : d.status === 'concluded' ? t.concluded : d.status}
            </Text>
          </Box>
          <Text dimColor wrap="truncate-end">{`  ${d.topic}`}</Text>
          {isOpen(`talk:${d.slug}`) && (
            <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
              {pending(detail)}
              {detail?.kind === 'talk' && <Markdown text={detail.body} />}
            </Box>
          )}
        </Box>
      )
    }

    // `审查 第 2 轮 · 1 CRITICAL 2 WARNING`
    const ticketLine = (label: string, ticket: Ticket | null) => (
      <Text wrap="truncate-end">
        <Text dimColor>{`   ${label}  `}</Text>
        {ticket === null && <Text dimColor>{t.noTicket}</Text>}
        {ticket !== null && `${t.round(ticket.round)} · `}
        {ticket !== null && ticket.findings.length === 0 && <Text color="success">{t.noFindings}</Text>}
        {ticket !== null &&
          SEVERITIES.map(severity => {
            const n = ticket.findings.filter(f => f.severity === severity).length
            return n > 0 && <Text color={SEVERITY_COLOR[severity]}>{`${n} ${severity} `}</Text>
          })}
      </Text>
    )

    const findings = (label: string, ticket: Ticket | null) =>
      ticket !== null &&
      ticket.findings.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{`${label} · ${t.findings(ticket.findings.length)}`}</Text>
          {ticket.findings.map(f => (
            <Box flexDirection="column">
              <Text wrap="truncate-end">
                <Text color={SEVERITY_COLOR[f.severity]}>{f.severity}</Text>
                <Text dimColor>{` ${f.path}`}</Text>
              </Text>
              <Text wrap="wrap">{f.text}</Text>
            </Box>
          ))}
        </Box>
      )

    const next = b?.next ?? null
    const discussions = b?.discussions ?? []
    const changes = b?.changes ?? []

    const boardTab = (
      <Box flexDirection="column">
        {next !== null && (
          <Box marginTop={1}>
            <Text bold>{t.next}</Text>
            <Button key="next" label={cut(next, width - 9)} plain onPress={() => putArgument($, next)} />
          </Box>
        )}
        {STAGES.map(stage => {
          const items = changes.filter(c => c.stage === stage.id)
          return items.length > 0 && section(`stage:${stage.id}`, t.stages[stage.id], stage.color, items.map(changeRow))
        })}
        {b !== null && b.error === null && changes.length === 0 && (
          <Box marginTop={1}>
            <Text dimColor>{t.noChanges}</Text>
          </Box>
        )}
        {b !== null && b.skipped.length > 0 && <Text dimColor wrap="wrap">{t.skipped(b.skipped.join(', '))}</Text>}
      </Box>
    )

    const open = discussions.filter(d => d.status === 'open')
    const rest = discussions.filter(d => d.status !== 'open')
    const talkTab = (
      <Box flexDirection="column">
        {open.length > 0 && section('talks-open', t.open, 'suggestion', open.map(talkRow))}
        {rest.length > 0 && section('talks-rest', t.concluded, 'success', rest.map(talkRow))}
        {b !== null && b.error === null && discussions.length === 0 && (
          <Box marginTop={1}>
            <Text dimColor>{t.noDiscussions}</Text>
          </Box>
        )}
      </Box>
    )

    const qualityTab = (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor wrap="wrap">
          {t.ticketNote}
        </Text>
        {q === null && <Text dimColor>{t.loading}</Text>}
        {q?.error && <Text color="error">{q.error}</Text>}
        {q !== null && q.error === null && q.rows.length === 0 && <Text dimColor>{t.noTickets}</Text>}
        {q?.rows.map(r => (
          <Box key={`ticket-row:${r.change}`} flexDirection="column" marginTop={1}>
            <Box>
              {toggle(`ticket:${r.change}`)}
              <Text> </Text>
              <Button
                key={`ticket:${r.change}`}
                label={cut(r.change, width - 3)}
                plain
                onPress={() => putArgument($, r.change)}
              />
            </Box>
            {ticketLine(t.review, r.review)}
            {ticketLine(t.verify, r.verify)}
            {isOpen(`ticket:${r.change}`) && (
              <Box flexDirection="column" paddingLeft={3}>
                {findings(t.review, r.review)}
                {findings(t.verify, r.verify)}
              </Box>
            )}
          </Box>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box>
          {TABS.map(id =>
            id === v.tab ? (
              <Text backgroundColor="suggestion" color="inverseText" bold>{` ${t.tabs[id]} `}</Text>
            ) : (
              <Box paddingX={1}>
                <Button key={`view:${id}`} label={t.tabs[id]} plain dimColor onPress={() => void chooseTab($, id)} />
              </Box>
            ),
          )}
          <Box flexGrow={1} />
          <Button key="refresh" label={t.refresh} plain dimColor onPress={() => void refreshBoard($)} />
        </Box>
        <Text dimColor>{b === null ? t.loading : t.updated(hhmm(new Date(b.loadedAt)))}</Text>
        {b?.error && <Text color="error">{b.error}</Text>}
        {b?.error && <Text dimColor>{t.cliHint}</Text>}
        {v.tab === 'board' && boardTab}
        {v.tab === 'talk' && talkTab}
        {v.tab === 'quality' && qualityTab}
      </Box>
    )
  })
}

import type { Stage, TaskGroup, Ticket } from '../types'

// 面板从 CLI `--json` 输出读的字段。
export type ListJson = {
  changes: {
    name: string
    completedTasks: number
    totalTasks: number
    worktree?: { path: string; branch: string }
  }[]
}
export type PlanJson = {
  changes: { name: string; wave: number; stage: Stage; blockedBy: string[] }[]
  next: string | null
  skipped: { change: string }[]
}
export type DiscussJson = {
  discussions: { slug: string; topic: string; rounds: number; status: string }[]
}
export type ShowJson = { tasks: string }
export type StatusJson = { artifacts: { id: string; status: string }[] }
export type DiscussShowJson = { content: string }
export type TicketJson = { lastRound: { index: number; findings: { severity: string; path: string; text: string }[] } }

// 顺序与阶段取 plan（与 desktop 看板同一条规则），任务数与 worktree 取 list。
export const buildBoard = (list: ListJson, plan: PlanJson, talk: DiscussJson) => {
  const listed = new Map(list.changes.map(c => [c.name, c]))
  return {
    changes: plan.changes.map(p => {
      const c = listed.get(p.name)
      return {
        name: p.name,
        stage: p.stage,
        wave: p.wave,
        blockedBy: p.blockedBy,
        done: c?.completedTasks ?? 0,
        total: c?.totalTasks ?? 0,
        branch: c?.worktree?.branch ?? null,
        cwd: c?.worktree?.path ?? null,
      }
    }),
    discussions: talk.discussions
      .filter(d => d.status !== 'promoted')
      .map(({ slug, topic, rounds, status }) => ({ slug, topic, rounds, status })),
    next: plan.next,
    skipped: plan.skipped.map(s => s.change),
  }
}

// 输入框里 `#` 开头的字：列出提案中的 change，`#` 后面打的字用来筛选名称（不分大小写）。
// 选了一列，那个字就换成 change 名称。
export const proposedRows = (changes: PlanJson['changes'], token: string, stage: string) => {
  const typed = token.slice(1).toLowerCase()
  return changes
    .filter(c => c.stage === 'proposed' && c.name.toLowerCase().includes(typed))
    .map(c => ({ text: c.name, description: `specseal · ${stage}` }))
}

// tasks.md 的 `## 标题` 分组与 `- [ ]`／`- [x]` 任务列；`[M]` 紧贴核取框的是手动任务。
// 行尾的 `<!-- specseal-task:… -->` 是引擎的 ID，不显示。
export const parseTasks = (markdown: string): TaskGroup[] => {
  const groups: TaskGroup[] = []
  for (const line of markdown.split('\n')) {
    const heading = line.match(/^#{2,}\s+(.+?)\s*$/)
    if (heading) {
      groups.push({ title: heading[1] ?? '', tasks: [] })
      continue
    }
    const task = line.match(/^\s*- \[([ xX])\]\s+(\[M\]\s+)?(.*?)\s*(<!--.*-->)?\s*$/)
    if (task) {
      if (groups.length === 0) {
        groups.push({ title: '', tasks: [] })
      }
      groups[groups.length - 1]?.tasks.push({ done: task[1] !== ' ', manual: task[2] !== undefined, label: task[3] ?? '' })
    }
  }
  return groups.filter(g => g.tasks.length > 0)
}

// 工单只看最后一轮：第几轮、还有哪些发现。
export const toTicket = (json: TicketJson): Ticket => ({
  round: json.lastRound.index,
  findings: json.lastRound.findings,
})

// `review show`／`verify show` 在没有工单时以这句话失败，不算错误。
export const isNoTicket = (stderr: string) => /no (review|verify) ticket/.test(stderr)

// 讨论档开头的 YAML front matter 是 metadata，`<!-- -->` 是范本给写作者的规则；
// 面板只画内文，Markdown 会把注解原样印出来。
export const discussionBody = (content: string) =>
  content
    .replace(/\r/g, '')
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/<!--[\s\S]*?-->\n?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

// `$.process.run` 不经 shell。Windows 上 npm 装的 `specseal` 是 `.cmd` 壳，只能经
// cmd.exe 运行；桌面版装的 `specseal.exe` 经 cmd.exe 也一样找得到。
export const specsealArgv = (args: string[], isWindows: boolean) =>
  isWindows ? ['cmd.exe', '/d', '/c', 'specseal', ...args] : ['specseal', ...args]

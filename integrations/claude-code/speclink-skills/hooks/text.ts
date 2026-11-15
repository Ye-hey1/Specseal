import type { Lang, PanelTab, Stage } from '../types'

import type { GroupId } from './groups'

type Text = {
  groups: Record<GroupId, string>
  panel: string
  panelCommand: string
  panelOpened: string
  panelClosed: string
  loading: string
  updated: (time: string) => string
  refresh: string
  next: string
  tabs: Record<PanelTab, string>
  rounds: (n: number) => string
  open: string
  concluded: string
  stages: Record<Stage, string>
  waitsFor: (names: string) => string
  noChanges: string
  noDiscussions: string
  artifacts: Record<string, string>
  manual: string
  noTasks: string
  review: string
  verify: string
  round: (n: number) => string
  findings: (n: number) => string
  noFindings: string
  noTicket: string
  noTickets: string
  ticketNote: string
  skipped: (names: string) => string
  cliHint: string
}

// 接口文本。阶段、轮数、空状态、文档、任务与工单沿用 desktop 的正典词汇（packages/ui 的
// stage.*、common.rounds、board.empty、common.tab*、tasks.*、ticket.*、discussion.status*），
// 中英两版对等。
export const TEXT: Record<Lang, Text> = {
  en: {
    groups: { plan: 'Plan', build: 'Build', quality: 'Quality', ship: 'Ship', other: 'More' },
    panel: 'Panel',
    panelCommand: 'Toggle the specseal side panel',
    panelOpened: 'specseal panel opened.',
    panelClosed: 'specseal panel closed.',
    loading: 'Loading…',
    updated: time => `Updated ${time}`,
    refresh: '↻ Refresh',
    next: 'Next ▸ ',
    tabs: { board: 'Board', talk: 'Discussions', quality: 'Quality' },
    rounds: n => `${n} rounds`,
    open: 'Open',
    concluded: 'Concluded',
    stages: { proposed: 'Proposed', 'in-progress': 'In progress', ready: 'Ready' },
    waitsFor: names => `Waiting on ${names}`,
    noChanges: 'No active changes',
    noDiscussions: 'No discussions',
    artifacts: { proposal: 'Proposal', design: 'Design', specs: 'Specs', tasks: 'Tasks' },
    manual: 'Manual',
    noTasks: '(no tasks)',
    review: 'Review',
    verify: 'Verify',
    round: n => `Round ${n}`,
    findings: n => `${n} findings`,
    noFindings: 'No findings this round',
    noTicket: 'No ticket',
    noTickets: 'No open review or verify tickets.',
    ticketNote: 'A stamp deletes its ticket, so only open tickets show.',
    skipped: names => `Skipped (bad meta): ${names}`,
    cliHint: 'The panel needs the specseal CLI on PATH.',
  },
  'zh-CN': {
    groups: { plan: '规划', build: '实作', quality: '品质', ship: '收尾', other: '其他' },
    panel: '面板',
    panelCommand: '开关 specseal 侧边面板',
    panelOpened: 'specseal 面板已打开。',
    panelClosed: 'specseal 面板已关闭。',
    loading: '读取中…',
    updated: time => `更新于 ${time}`,
    refresh: '↻ 刷新',
    next: '下一步 ▸ ',
    tabs: { board: '看板', talk: '讨论', quality: '品质' },
    rounds: n => `${n} 轮`,
    open: '讨论中',
    concluded: '已结论',
    stages: { proposed: '提案中', 'in-progress': '进行中', ready: '已就绪' },
    waitsFor: names => `等 ${names}`,
    noChanges: '没有 active change',
    noDiscussions: '没有讨论',
    artifacts: { proposal: '提案', design: '设计', specs: '规格', tasks: '任务' },
    manual: '手动',
    noTasks: '（无任务）',
    review: '审查',
    verify: '验证',
    round: n => `第 ${n} 轮`,
    findings: n => `${n} 条`,
    noFindings: '本轮无发现',
    noTicket: '没有工单',
    noTickets: '没有未结的审查或验证工单。',
    ticketNote: '盖章后工单会删除，这里只列未结的工单。',
    skipped: names => `略过（meta 有误）：${names}`,
    cliHint: '面板需要 PATH 上有 specseal CLI。',
  },
}

// `auto` 跟着 Claude Code 自己的 `language` 设置：写的是中文就用繁中，其余用英文。
export const resolveLang = (option: unknown, claudeLanguage: unknown): Lang => {
  if (option === 'en' || option === 'zh-CN') {
    return option
  }
  return typeof claudeLanguage === 'string' && /中文|chinese|zh/i.test(claudeLanguage) ? 'zh-CN' : 'en'
}

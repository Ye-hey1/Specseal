// 已安装的 specseal 技能：完整名称与输入框提示用的那行说明。
export type Skill = { name: string; description: string }

export type Lang = 'en' | 'zh-CN'

export type Stage = 'proposed' | 'in-progress' | 'ready'

export type PanelChange = {
  name: string
  stage: Stage
  wave: number
  blockedBy: string[]
  done: number
  total: number
  branch: string | null
  // worktree 的文档夹；change 在 worktree 里时，show／status 要在这里跑才读得到它那份。
  cwd: string | null
}

export type PanelDiscussion = { slug: string; topic: string; rounds: number; status: string }

export type Board = {
  changes: PanelChange[]
  discussions: PanelDiscussion[]
  next: string | null
  skipped: string[]
  loadedAt: string
  error: string | null
}

export type PanelTab = 'board' | 'talk' | 'quality'

// 面板的分页、收起的区块、展开的列（`change:<name>`、`talk:<slug>`、`ticket:<name>`）。
export type PanelView = { tab: PanelTab; closed: string[]; open: string[] }

export type TaskItem = { done: boolean; manual: boolean; label: string }

export type TaskGroup = { title: string; tasks: TaskItem[] }

export type Finding = { severity: string; path: string; text: string }

export type Ticket = { round: number; findings: Finding[] }

// 展开一列时才读的内容。
export type Detail =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'change'; artifacts: { id: string; done: boolean }[]; groups: TaskGroup[] }
  | { kind: 'talk'; body: string }

export type QualityRow = { change: string; review: Ticket | null; verify: Ticket | null }

// 品质分页：切过去才读；null 是还没读完。
export type Quality = { rows: QualityRow[]; error: string | null }

// 这个 session 正在跑的 specseal 步骤（技能名称去掉 specseal-，例如 apply）与 change；还不知道是 null。
// archived：这个 change 已经在这个 session 封存。
export type Focus = { verb: string | null; change: string | null; archived?: true }

declare module 'claude-code' {
  interface PluginState {
    'specseal-skills': {
      skills: Skill[]
      tab: string
      board: Board | null
      lang: Lang
      view: PanelView
      details: Record<string, Detail>
      quality: Quality | null
      focus: Focus
    }
  }
}

import { GROUPS } from './groups'
import type { GroupId } from './groups'

export const PREFIX = 'specseal-'

// 输入框最前面的斜线指令；合并钮填入的多个指令以 ` + ` 相连，视为同一段。
export const COMMAND_HEAD = /^\/\S+(?:\s+\+\s+\/\S+)*/

// 已安装技能（完整名称）分进各分页；合并钮要每个技能都在才出现。
export const groupSkills = (installed: string[]): { id: GroupId; skills: string[] }[] => {
  const short = installed.map(n => n.slice(PREFIX.length))
  const known = new Set(GROUPS.flatMap(g => g.skills.flatMap(s => s.split('+'))))
  const unknown = short.filter(s => !known.has(s))
  return GROUPS.map(g => ({
    id: g.id,
    skills: [
      ...g.skills.filter(s => s.split('+').every(part => short.includes(part))),
      ...(g.id === 'other' ? unknown : []),
    ],
  })).filter(g => g.skills.length > 0)
}

// `archive+commit` → `/specseal-archive + /specseal-commit`
export const commandHead = (skill: string) =>
  skill
    .split('+')
    .map(part => `/${PREFIX}${part}`)
    .join(' + ')

// 指令放最前面，已经打的字留在后面当参数；原本最前面的指令会被换掉。
export const withCommand = (draft: string, head: string) =>
  `${head} ${draft.replace(COMMAND_HEAD, '').trimStart()}`

// 最前面有指令时，`arg` 成为它的参数（换掉原本的参数）；没有指令时接在已打的字后面。
export const withArgument = (draft: string, arg: string) => {
  const head = draft.match(COMMAND_HEAD)?.[0]
  if (head !== undefined) {
    return `${head} ${arg}`
  }
  return draft.trim() === '' ? arg : `${draft.trimEnd()} ${arg}`
}

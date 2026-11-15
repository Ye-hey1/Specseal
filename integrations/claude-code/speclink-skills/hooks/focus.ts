import type { Focus } from '../types'

import { COMMAND_HEAD, PREFIX } from './skills'

// 这个 session 正在跑的 specseal 步骤与 change：从你送出的技能指令、模型调用的技能，以及 specseal
// CLI 参数里的 change 名称找出来。技能一定会用 change 名称调用 CLI，所以就算你没打名称也找得到。

// `/specseal-apply add-x` → apply；`/specseal-archive + /specseal-commit` → archive+commit。对话纪录里
// 的技能指令写成 `<command-name>/specseal-apply</command-name>`。不是 specseal 技能（含面板指令）回 null。
export const verbOf = (prompt: string, panelCommand: string) => {
  const text = prompt.trimStart().replace(/^<command-name>/, '')
  const head = text.match(COMMAND_HEAD)?.[0] ?? ''
  const names = [...head.matchAll(/\/(\S+)/g)].map(m => m[1]!).filter(n => n.startsWith(PREFIX) && n !== panelCommand)
  return names.length === 0 ? null : names.map(n => n.slice(PREFIX.length).replace(/<.*$/, '')).join('+')
}

// 文本里出现的已知 change 名称，最后一个为准；只比完整的词，不会把名称的一部分当成 change。
export const changeIn = (text: string, names: readonly string[]) =>
  text.split(/[^A-Za-z0-9._-]+/).filter(word => names.includes(word)).at(-1) ?? null

// specseal CLI 的指令（`specseal status --change x`），不是就回 null。
export const specsealCommand = (command: unknown) =>
  typeof command === 'string' && /(^|[\s;&|(])specseal\s/.test(command) ? command : null

// 这些步骤不是在做某个 change，消息或指令里的 change 名称多半只是提到（讨论的背景、查来源）。
// propose 也没有现成的 change，但它会建一个，所以之后的 CLI 指令还是认。
const NO_CHANGE_VERBS = new Set(['discuss', 'propose', 'improve', 'audit', 'trace', 'manual', 'baseline', 'config'])
const IGNORES_COMMANDS = new Set([...NO_CHANGE_VERBS].filter(verb => verb !== 'propose'))

// 换步骤：不做 change 的步骤要放掉上一个 change。
export const withVerb = (focus: Focus, verb: string): Focus =>
  NO_CHANGE_VERBS.has(verb) ? { verb, change: null } : { ...focus, verb }

// specseal 指令里的 change 名称就是正在处理的 change。讨论、查来源这类步骤除外。
export const commandChange = (focus: Focus, command: string, names: readonly string[]) =>
  focus.verb !== null && IGNORES_COMMANDS.has(focus.verb) ? null : changeIn(command, names)

// 送出的消息带来的变动：specseal 技能指令换成新的步骤，指令里有 change 名称就换掉 change，
// 没有就留着上一个（通常是同一个 change 的下一步）。其他消息不动。
export const afterPrompt = (focus: Focus, prompt: string, names: readonly string[], panelCommand: string): Focus => {
  const verb = verbOf(prompt, panelCommand)
  if (verb === null) {
    return focus
  }
  return NO_CHANGE_VERBS.has(verb) ? withVerb(focus, verb) : { verb, change: changeIn(prompt, names) ?? focus.change }
}

// 接回的对话（/resume）里最后的步骤与 change：依序看你送出的技能指令、模型调用的技能与 specseal 指令。
export const focusFromHistory = (
  messages: readonly { role: string; text: string; toolUses: readonly { tool: string; input: Record<string, unknown> }[] }[],
  names: readonly string[],
  panelCommand: string,
): Focus => {
  let focus: Focus = { verb: null, change: null }
  for (const message of messages) {
    if (message.role === 'user') {
      focus = afterPrompt(focus, message.text, names, panelCommand)
    }
    for (const use of message.toolUses) {
      const skill = use.tool === 'Skill' ? use.input.skill : undefined
      if (typeof skill === 'string' && skill.startsWith(PREFIX)) {
        focus = withVerb(focus, skill.slice(PREFIX.length))
      }
      const command = use.tool === 'Bash' ? specsealCommand(use.input.command) : null
      const change = command === null ? null : commandChange(focus, command, names)
      if (change !== null) {
        focus = { ...focus, change }
      }
    }
  }
  return focus
}

// session 标题：「apply · add-x」，封存完是「archive · add-x ✓」；两个都还不知道时回 null，标题维持原样。
export const titleOf = (focus: Focus) => {
  const title = [focus.verb, focus.change].filter(part => part !== null).join(' · ')
  return title === '' ? null : focus.archived === true ? `${title} ✓` : title
}

// /clear 时标题改回的字样（Claude Code 缺省显示的）；空字符串会被引擎忽略，清不掉。
export const PLAIN_TITLE = 'Claude Code'

// 把这个 mod 设的标题解析回步骤与 change。/resume 接回的对话若被 compact 过，纪录里已经没有 specseal
// 指令，靠标题找回。change 要是现有的 change，或是标了 ✓ 的封存，免得把你自己取的标题当成 change。
export const focusFromTitle = (title: string | undefined, names: readonly string[]): Focus | null => {
  const m = title?.match(/^(?:([a-z][a-z+-]*) · )?([A-Za-z0-9._-]+)( ✓)?$/)
  if (m === undefined || m === null) {
    return null
  }
  const [, verb = null, change = '', done] = m
  if (done !== undefined) {
    return verb === null ? null : { verb, change, archived: true }
  }
  return names.includes(change) ? { verb, change } : null
}

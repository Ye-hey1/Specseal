// dispatch 的流程设置动词（spec node-sdk「dispatch 的流程设置动词」、command-runtime
// 「动词覆盖与跨入口一致性」的 workflow-config 情境）。宿主 Store 的写入走选填方法
// writeWorkflowConfig；没有它时，会写入的动词在动手前被拒绝。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createEngine } from '../index.js'
import { cliJson, fixtureProject, makeFsFixture, memoryStore, rejection } from './helpers'

const CONFIG = 'schema: spec-driven\nlocale: tw\ntdd: false\n'
const BAD_CONFIG = ': not yaml : [\n'

/** A host store holding `config`, with the names of every method called on it. */
function hostStore(config: string | undefined, options: { writable: boolean }) {
  const project = fixtureProject()
  project.workflowConfig = config
  const calls: string[] = []
  const written: string[] = []
  const base: Record<string, unknown> = { ...memoryStore(project) }
  if (options.writable) {
    base.writeWorkflowConfig = async (content: string) => {
      written.push(content)
      project.workflowConfig = content
    }
  }
  const store = Object.fromEntries(
    Object.entries(base).map(([name, method]) => [
      name,
      (...args: unknown[]) => {
        calls.push(name)
        return (method as (...a: unknown[]) => unknown)(...args)
      },
    ]),
  )
  const writes = () => calls.filter((name) => /^(write|create|delete|archive)/.test(name))
  return { store, project, calls, written, writes }
}

/** An fs fixture project whose workflow config is `config`. */
function fsProject(config: string): string {
  const root = makeFsFixture()
  mkdirSync(join(root, 'specseal'), { recursive: true })
  writeFileSync(join(root, '.specseal.yaml'), 'tools: []\n')
  writeFileSync(join(root, 'specseal', 'config.yaml'), config)
  return root
}

describe('workflow-config show 经命令运行层', () => {
  it('fs 形式的结果等于 CLI 的 --json', async () => {
    const root = fsProject(CONFIG)
    const engine = createEngine({ store: { type: 'fs', root } })
    const shown = await engine.dispatch(['workflow-config', 'show'])
    expect(shown).toEqual(cliJson(root, ['workflow-config', 'show', '--json']))
    expect(shown).toMatchObject({ schema: 'spec-driven', locale: 'tw', tdd: false, specLocale: null })
  })

  it('宿主 Store 形式对同一份内容得到同一个结果', async () => {
    const root = fsProject(CONFIG)
    const { store } = hostStore(CONFIG, { writable: false })
    const engine = createEngine({ store })
    expect(await engine.dispatch(['workflow-config', 'show', '--json'])).toEqual(
      cliJson(root, ['workflow-config', 'show', '--json']),
    )
  })

  it('坏的流程设置以 invalid_config 拒绝', async () => {
    const { store } = hostStore(BAD_CONFIG, { writable: true })
    const err = await rejection(createEngine({ store }).dispatch(['workflow-config', 'show']))
    expect(err.code).toBe('invalid_config')
    expect(err.message).toContain('specseal/config.yaml')
  })
})

describe('宿主 Store 提供 writeWorkflowConfig', () => {
  it('set 调用它正好一次，收到的内容里 tdd 是 true', async () => {
    const { store, written, writes } = hostStore(CONFIG, { writable: true })
    const result = await createEngine({ store }).dispatch(['workflow-config', 'set', 'tdd', 'true'])
    expect(result).toEqual({ output: '✓ tdd = true\n' })
    expect(written).toEqual(['schema: spec-driven\nlocale: tw\ntdd: true\n'])
    expect(writes()).toEqual(['writeWorkflowConfig'])
  })

  it('读 stdin 的动词带 --stdin 写入内容', async () => {
    const { store, written } = hostStore(CONFIG, { writable: true })
    const engine = createEngine({ store })
    const result = await engine.dispatch(['workflow-config', 'rules', 'tasks', '--stdin'], {
      stdin: 'Use checkbox format\n',
    })
    expect(result).toEqual({ output: '✓ rules.tasks = 1 entries\n' })
    expect(written).toHaveLength(1)
    expect(written[0]).toContain('rules:\n  tasks:\n  - Use checkbox format\n')
    // 少了 --stdin 是 argv 的错，内容不会被默默丢掉。
    const err = await rejection(engine.dispatch(['workflow-config', 'context']))
    expect(err.code).toBe('invalid_argv')
    expect(err.message).toBe('content is read from stdin — run: specseal workflow-config context --stdin')
  })

  it('写入方法直接回传（不是 Promise）也可以', async () => {
    // spec node-sdk：writeWorkflowConfig(content) 回传值或 Promise 皆可。
    const { store, project } = hostStore(CONFIG, { writable: true })
    const received: string[] = []
    store.writeWorkflowConfig = (content: string) => {
      received.push(content)
      project.workflowConfig = content
    }
    const result = await createEngine({ store }).dispatch(['workflow-config', 'set', 'audit', 'true'])
    expect(result).toEqual({ output: '✓ audit = true\n' })
    expect(received).toHaveLength(1)
    expect(received[0]).toContain('audit: true\n')
  })

  it('带 --stdin 却没有给 stdin 内容时以 invalid_argv 拒绝，不清掉现有的值', async () => {
    // 宿主漏传 options.stdin 时，内容会被读成空的；清单会被默默清空。
    const config = `${CONFIG}rules:\n  tasks:\n  - Use checkbox format\n`
    const { store, project, writes } = hostStore(config, { writable: true })
    const engine = createEngine({ store })
    for (const argv of [
      ['workflow-config', 'rules', 'tasks', '--stdin'],
      ['workflow-config', 'context', '--stdin'],
      ['workflow-config', 'review', 'critical', '--stdin', '--dry-run'],
      ['workflow-config', 'subagent-model', 'choices', 'codex', '--stdin'],
    ]) {
      const err = await rejection(engine.dispatch(argv))
      expect(err.code, argv.join(' ')).toBe('invalid_argv')
      expect(err.message, argv.join(' ')).toContain('--stdin but no stdin content')
    }
    expect(writes()).toEqual([])
    expect(project.workflowConfig).toBe(config)
    // 空字符串是「刻意清掉」的写法。
    const cleared = await engine.dispatch(['workflow-config', 'rules', 'tasks', '--stdin'], { stdin: '' })
    expect(cleared).toEqual({ output: '✓ rules.tasks removed\n' })
    // 写明的 `tdd: false` 也被改写函数拿掉：false 不落键。
    expect(project.workflowConfig).toBe('schema: spec-driven\nlocale: tw\n')
  })

  it('值没有变时不调用写入方法', async () => {
    const { store, written } = hostStore('schema: spec-driven\ntdd: true\n', { writable: true })
    const result = await createEngine({ store }).dispatch(['workflow-config', 'set', 'tdd', 'true'])
    expect(result).toEqual({ output: '✓ tdd = true\n' })
    expect(written).toEqual([])
  })

  it('不合法的值在写入前被拒绝', async () => {
    const { store, written } = hostStore(CONFIG, { writable: true })
    const err = await rejection(
      createEngine({ store }).dispatch(['workflow-config', 'set', 'locale', 'fr']),
    )
    expect(err.code).toBe('invalid_config')
    expect(written).toEqual([])
  })

  it('写入方法失败时 dispatch 以该方法的错误拒绝', async () => {
    const { store } = hostStore(CONFIG, { writable: true })
    store.writeWorkflowConfig = async () => {
      throw Object.assign(new Error('the policy is locked'), { code: 'policy_locked' })
    }
    const err = await rejection(
      createEngine({ store }).dispatch(['workflow-config', 'set', 'tdd', 'true']),
    )
    expect(err.code).toBe('policy_locked')
    expect(err.message).toBe('writeWorkflowConfig: the policy is locked')
  })
})

describe('同一个引擎上并行的写入', () => {
  it('一个接一个运行，两个改动都留下', async () => {
    // 写入是「读、改、整份写回」，宿主 Store 的接口没有版本检查：两次写入要是同时
    // 读到旧内容，后写的会盖掉先写的。
    const { store, project } = hostStore('schema: spec-driven\n', { writable: true })
    const read = store.readWorkflowConfig
    store.readWorkflowConfig = async () => {
      const text = await read()
      await new Promise((resolve) => setTimeout(resolve, 30))
      return text
    }
    const engine = createEngine({ store })
    await Promise.all([
      engine.dispatch(['workflow-config', 'set', 'tdd', 'true']),
      engine.dispatch(['workflow-config', 'set', 'audit', 'true']),
    ])
    expect(project.workflowConfig).toContain('tdd: true\n')
    expect(project.workflowConfig).toContain('audit: true\n')
  })
})

describe('宿主 Store 没有 writeWorkflowConfig', () => {
  it('写入动词以 refused 拒绝，没有任何写入方法被调用', async () => {
    const { store, project, writes } = hostStore(CONFIG, { writable: false })
    const engine = createEngine({ store })
    for (const [argv, stdin] of [
      [['workflow-config', 'set', 'tdd', 'true'], undefined],
      [['workflow-config', 'context', '--stdin'], 'New context.\n'],
      [['workflow-config', 'review', 'baseline', 'replace'], undefined],
      [['workflow-config', 'subagent-model', 'review', 'claude', 'opus'], undefined],
    ] as Array<[string[], string | undefined]>) {
      const err = await rejection(engine.dispatch(argv, { stdin }))
      expect(err.code, argv.join(' ')).toBe('refused')
      expect(err.message, argv.join(' ')).toContain('writeWorkflowConfig')
    }
    expect(writes()).toEqual([])
    expect(project.workflowConfig).toBe(CONFIG)
  })

  it('读取与 dry-run 不需要它', async () => {
    const { store, writes } = hostStore(CONFIG, { writable: false })
    const engine = createEngine({ store })
    await expect(engine.dispatch(['workflow-config', 'show'])).resolves.toMatchObject({ tdd: false })
    const dry = (await engine.dispatch(['workflow-config', 'set', 'tdd', 'true', '--dry-run'])) as {
      output: string
    }
    expect(dry.output).toBe(
      '--- a/specseal/config.yaml\n+++ b/specseal/config.yaml\n@@ -1,3 +1,3 @@\n schema: spec-driven\n locale: tw\n-tdd: false\n+tdd: true\n',
    )
    expect(writes()).toEqual([])
  })
})

describe('fs 形式', () => {
  it('直接写入规格文件夹的 config.yaml', async () => {
    const root = fsProject(CONFIG)
    const engine = createEngine({ store: { type: 'fs', root } })
    const result = await engine.dispatch(['workflow-config', 'set', 'locale', 'ja'])
    expect(result).toEqual({ output: '✓ locale = ja\n' })
    // 写明的 `tdd: false` 被改写函数拿掉：false 不落键（既有的写入语意）。
    expect(readFileSync(join(root, 'specseal', 'config.yaml'), 'utf8')).toBe(
      'schema: spec-driven\nlocale: ja\n',
    )
  })
})

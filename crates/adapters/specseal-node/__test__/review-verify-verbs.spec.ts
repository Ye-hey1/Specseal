// dispatch 的盖章动词（spec：dispatch 的盖章动词）。宿主 Store 形式没有工作树，
// 指纹是宿主自己的真相——scope／missing 走 stdin 的 JSON（server stamp request
// body 的 scope／missing 子集；accept／agent 走 argv 旗标）。
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import { createEngine } from '../index.js'
import { cliBin, fixtureProject, makeFsFixture, memoryStore } from './helpers'

const ACTOR = 'Rev <rev@example.com>'
// beta 的任务全数完成——盖章守门的前提。
const CHANGE = 'beta'
const SCOPE_FILE = 'crates/b/src/util.rs'
// SUGGESTION 不挡章；CRITICAL 挡。
const CLEAN_ROUND = `**Scope**: ${SCOPE_FILE}\n\n- [SUGGESTION] ${SCOPE_FILE} — rename helper\n`
const BLOCKING_ROUND = `**Scope**: ${SCOPE_FILE}\n\n- [CRITICAL] ${SCOPE_FILE} — unwrap on user input\n`
const STAMP_PAYLOAD = JSON.stringify({ scope: [{ path: SCOPE_FILE, hash: '0f9c' }] })

function engineWithActor(actor?: string) {
  const store = memoryStore(fixtureProject())
  const engine = actor === undefined ? createEngine({ store }) : createEngine({ store, actor })
  return { store, engine }
}

const metaOf = (store: ReturnType<typeof memoryStore>) =>
  store.readArtifact(CHANGE, '.openspec.yaml').then((m) => m ?? '')

describe('review 盖章链', () => {
  it('add-round 创建工单、stamp 以建构期 actor 落 reviewed_by', async () => {
    const { store, engine } = engineWithActor(ACTOR)
    const added = await engine.dispatch(['review', 'add-round', CHANGE, '--stdin'], {
      stdin: CLEAN_ROUND,
    })
    expect(added).toEqual({ change: CHANGE, round: 1 })
    expect(await store.readArtifact(CHANGE, 'review.md')).toContain('## Round 1')

    const stamped = await engine.dispatch(['review', 'stamp', CHANGE, '--stdin'], {
      stdin: STAMP_PAYLOAD,
    })
    expect(stamped).toEqual({ change: CHANGE })
    const meta = await metaOf(store)
    expect(meta).toContain(`reviewed_by: ${ACTOR}\n`)
    // 盖章是 read-modify-write：既有字段必须原样保留，不得整份洗掉。
    expect(meta).toContain('schema: spec-driven\n')
    expect(meta).toContain('created_by: tester\n')
    // 盖章效果的另一半：工单删除。
    expect(await store.readArtifact(CHANGE, 'review.md')).toBeNull()
  })
})

describe('verify 盖章链', () => {
  it('同一 actor 落 verified_by', async () => {
    const { store, engine } = engineWithActor(ACTOR)
    const added = await engine.dispatch(['verify', 'add-round', CHANGE, '--stdin'], {
      stdin: CLEAN_ROUND,
    })
    expect(added).toEqual({ change: CHANGE, round: 1 })

    await engine.dispatch(['verify', 'stamp', CHANGE, '--stdin'], { stdin: STAMP_PAYLOAD })
    expect(await metaOf(store)).toContain(`verified_by: ${ACTOR}\n`)
  })
})

describe('盖章守门与 argv 契约', () => {
  it('末轮未解必修 findings 让 stamp 以语义化消息拒绝，且不落任何章', async () => {
    const { store, engine } = engineWithActor(ACTOR)
    await engine.dispatch(['review', 'add-round', CHANGE, '--stdin'], { stdin: BLOCKING_ROUND })
    await expect(
      engine.dispatch(['review', 'stamp', CHANGE, '--stdin'], { stdin: STAMP_PAYLOAD }),
    ).rejects.toThrow(/CRITICAL|unresolved|must-fix/i)
    expect(await metaOf(store)).not.toContain('reviewed_by:')
  })

  it('--accept 豁免必修条件后落章', async () => {
    const { store, engine } = engineWithActor(ACTOR)
    await engine.dispatch(['review', 'add-round', CHANGE, '--stdin'], { stdin: BLOCKING_ROUND })
    await engine.dispatch(['review', 'stamp', CHANGE, '--accept', '--stdin'], {
      stdin: STAMP_PAYLOAD,
    })
    expect(await metaOf(store)).toContain(`reviewed_by: ${ACTOR}\n`)
  })

  it('--agent 落 reviewed_with', async () => {
    const { store, engine } = engineWithActor(ACTOR)
    await engine.dispatch(['review', 'add-round', CHANGE, '--stdin'], { stdin: CLEAN_ROUND })
    await engine.dispatch(['review', 'stamp', CHANGE, '--agent', 'claude', '--stdin'], {
      stdin: STAMP_PAYLOAD,
    })
    expect(await metaOf(store)).toContain('reviewed_with: claude\n')
  })

  it('未给 actor 时盖章无 _by 字段（宿主 Store 无回退）', async () => {
    const { store, engine } = engineWithActor()
    await engine.dispatch(['review', 'add-round', CHANGE, '--stdin'], { stdin: CLEAN_ROUND })
    await engine.dispatch(['review', 'stamp', CHANGE, '--stdin'], { stdin: STAMP_PAYLOAD })
    const meta = await metaOf(store)
    expect(meta).toContain('reviewed_at:')
    expect(meta).not.toContain('reviewed_by:')
  })

  it('宿主 Store 未实作 deleteArtifact 时盖章在动手前拒绝、工单不动', async () => {
    const store = memoryStore(fixtureProject())
    // deleteArtifact 是盖章前置的选配方法——拿掉它，其余动词照走。
    delete (store as Partial<typeof store>).deleteArtifact
    const engine = createEngine({ store, actor: ACTOR })
    await engine.dispatch(['review', 'add-round', CHANGE, '--stdin'], { stdin: CLEAN_ROUND })
    await expect(
      engine.dispatch(['review', 'stamp', CHANGE, '--stdin'], { stdin: STAMP_PAYLOAD }),
    ).rejects.toThrow(/deleteArtifact/)
    // 前置检查挡在任何写入之前：工单还在、章没落。
    expect(await store.readArtifact(CHANGE, 'review.md')).toContain('## Round 1')
    expect(await metaOf(store)).not.toContain('reviewed_by:')
    await expect(engine.dispatch(['list', '--json'])).resolves.toBeTruthy()
  })

  it('宿主 Store 未实作 writeChangeMeta 时盖章在删工单前拒绝', async () => {
    const store = memoryStore(fixtureProject())
    // 盖章顺序是先删工单再写 meta——缺 writeChangeMeta 若不挡在前面，
    // 工单会先被删掉、章却落不下来（全部轮次永久遗失）。
    delete (store as Partial<typeof store>).writeChangeMeta
    const engine = createEngine({ store, actor: ACTOR })
    await engine.dispatch(['review', 'add-round', CHANGE, '--stdin'], { stdin: CLEAN_ROUND })
    await expect(
      engine.dispatch(['review', 'stamp', CHANGE, '--stdin'], { stdin: STAMP_PAYLOAD }),
    ).rejects.toThrow(/writeChangeMeta/)
    expect(await store.readArtifact(CHANGE, 'review.md')).toContain('## Round 1')
  })

  it('宿主 Store 未实作 readChangeMeta 时盖章拒绝，不得静默洗掉既有 meta', async () => {
    const store = memoryStore(fixtureProject())
    // 缺 readChangeMeta 时桥接层读作「无 metadata」，盖章写回会把
    // schema／created_by 整份丢掉——必须拒绝，不能静默数据流失。
    delete (store as Partial<typeof store>).readChangeMeta
    const engine = createEngine({ store, actor: ACTOR })
    await engine.dispatch(['review', 'add-round', CHANGE, '--stdin'], { stdin: CLEAN_ROUND })
    await expect(
      engine.dispatch(['review', 'stamp', CHANGE, '--stdin'], { stdin: STAMP_PAYLOAD }),
    ).rejects.toThrow(/readChangeMeta/)
    expect(await metaOf(store)).toContain('created_by: tester\n')
  })

  it('同一 engine 的 review 与 verify 并发盖章不互吃', async () => {
    const { store, engine } = engineWithActor(ACTOR)
    await engine.dispatch(['review', 'add-round', CHANGE, '--stdin'], { stdin: CLEAN_ROUND })
    await engine.dispatch(['verify', 'add-round', CHANGE, '--stdin'], { stdin: CLEAN_ROUND })
    // stamp 是整份 meta 的 read-modify-write：同实例内串行化，后盖的章
    // 必须叠在前一个章之上，不得以旧快照覆盖。
    await Promise.all([
      engine.dispatch(['review', 'stamp', CHANGE, '--stdin'], { stdin: STAMP_PAYLOAD }),
      engine.dispatch(['verify', 'stamp', CHANGE, '--stdin'], { stdin: STAMP_PAYLOAD }),
    ])
    const meta = await metaOf(store)
    expect(meta).toContain(`reviewed_by: ${ACTOR}\n`)
    expect(meta).toContain(`verified_by: ${ACTOR}\n`)
  })

  it('未支持的子动词以 invalid_argv 拒绝，消息说明只能在有 checkout 的一端运行', async () => {
    const { engine } = engineWithActor(ACTOR)
    await expect(engine.dispatch(['review', 'prepare', CHANGE])).rejects.toMatchObject({
      code: 'invalid_argv',
      message: "'review prepare' only runs where a checkout exists — dispatch has none",
    })
  })

  it('stamp 的 stdin JSON 坏掉时以 invalid_argv 拒绝', async () => {
    const { engine } = engineWithActor(ACTOR)
    await engine.dispatch(['review', 'add-round', CHANGE, '--stdin'], { stdin: CLEAN_ROUND })
    await expect(
      engine.dispatch(['review', 'stamp', CHANGE, '--stdin'], { stdin: 'not json' }),
    ).rejects.toMatchObject({ code: 'invalid_argv' })
  })

  it('stamp 带了 stdin 却没带 --stdin 时以 invalid_argv 拒绝、不落章', async () => {
    const { store, engine } = engineWithActor(ACTOR)
    await engine.dispatch(['review', 'add-round', CHANGE, '--stdin'], { stdin: CLEAN_ROUND })
    // 忘了旗标的 JSON 不能被静默丢掉、改用空范围盖章。
    await expect(
      engine.dispatch(['review', 'stamp', CHANGE], { stdin: STAMP_PAYLOAD }),
    ).rejects.toMatchObject({ code: 'invalid_argv' })
    expect(await store.readArtifact(CHANGE, 'review.md')).toContain('## Round 1')
    expect(await metaOf(store)).not.toContain('reviewed_by:')
  })

  it('宿主 Store 缺盖章方法时先回报缺方法，再看 stdin 的 JSON', async () => {
    const store = memoryStore(fixtureProject())
    delete (store as Partial<typeof store>).deleteArtifact
    const engine = createEngine({ store, actor: ACTOR })
    await engine.dispatch(['review', 'add-round', CHANGE, '--stdin'], { stdin: CLEAN_ROUND })
    await expect(
      engine.dispatch(['review', 'stamp', CHANGE, '--stdin'], { stdin: 'not json' }),
    ).rejects.toThrow(/deleteArtifact/)
  })

  it('stamp 不带 --stdin 时 scope 与 missing 读作空清单', async () => {
    const { engine } = engineWithActor(ACTOR)
    await engine.dispatch(['review', 'add-round', CHANGE, '--stdin'], { stdin: CLEAN_ROUND })
    // 工单联集非空、scope 为空 → 引擎的分割守门拒绝（拒绝消息由引擎产生）。
    await expect(engine.dispatch(['review', 'stamp', CHANGE])).rejects.toThrow()
  })
})

// spec「读取与丢弃工单」：show 与 CLI 的 --json 同内容；discard 之后没有工单。
describe('读取与丢弃工单', () => {
  for (const station of ['review', 'verify'] as const) {
    it(`${station} show 与 CLI 的 --json 相同，discard 后 show 查无工单`, async () => {
      const root = makeFsFixture()
      const engine = createEngine({ store: { type: 'fs', root }, actor: ACTOR })
      await engine.dispatch([station, 'add-round', CHANGE, '--stdin'], { stdin: BLOCKING_ROUND })
      await engine.dispatch([station, 'add-round', CHANGE, '--stdin'], { stdin: CLEAN_ROUND })

      const shown = (await engine.dispatch([station, 'show', CHANGE])) as {
        change: string
        rounds: unknown[]
        lastRound: { index: number }
      }
      const cli = execFileSync(cliBin, [station, 'show', CHANGE, '--json'], { cwd: root, encoding: 'utf8' })
      expect(shown).toEqual(JSON.parse(cli))
      expect(shown.change).toBe(CHANGE)
      expect(shown.rounds).toHaveLength(2)
      expect(shown.lastRound.index).toBe(2)

      const discarded = (await engine.dispatch([station, 'discard', CHANGE])) as { output: string }
      expect(discarded.output).toMatch(/^✓ Discarded (review|verification) ticket for change 'beta'\n$/)
      await expect(engine.dispatch([station, 'show', CHANGE])).rejects.toThrow(
        new RegExp(`no ${station} ticket for change '${CHANGE}'`),
      )
    })
  }

  it('宿主 Store 上 show 与 discard 同样可用', async () => {
    const { store, engine } = engineWithActor(ACTOR)
    await engine.dispatch(['review', 'add-round', CHANGE, '--stdin'], { stdin: CLEAN_ROUND })
    expect(await engine.dispatch(['review', 'show', CHANGE])).toMatchObject({
      change: CHANGE,
      lastRound: { index: 1, scope: [SCOPE_FILE] },
    })
    await engine.dispatch(['review', 'discard', CHANGE])
    expect(await store.readArtifact(CHANGE, 'review.md')).toBeNull()
  })
})

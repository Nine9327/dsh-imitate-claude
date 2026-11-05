/**
 * 指令插件接线测试：用假 ctx 驱动 pre-step，验证注入时机与内容。
 *
 * 注入语义对齐 0.2.1 内置指令插件：消息拼进 decision.messages，
 * 而不是 agent.inbox.inject（该方法 0.2.1 已移除）。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../src/index.js'

/**
 * 造 fake ctx，捕获 pre-step 监听器。
 * @returns {{ ctx: object, listeners: Function[] }}
 */
function makeFakeCtx() {
  const listeners = []
  const ctx = {
    logger: { warn() {} },
    on(event, handler) {
      if (event === 'agent/pre-step') listeners.push(handler)
    },
  }
  return { ctx, listeners }
}

/**
 * 造 agent 桩。新注入方式不再经过 inbox；保留 inbox 桩是为了
 * 断言插件确实没有调用它（回归锁：0.2.1 无此方法）。
 * @param {string} cwd
 * @returns {object}
 */
function makeAgent(cwd) {
  const injected = []
  return {
    session: { header: { cwd } },
    inbox: {
      // 0.2.1 已移除 inject；故意不提供，任何调用都会抛 TypeError。
      nextStep: [],
      remove() {},
      prepend() {},
    },
    _injected: injected,
  }
}

/**
 * 造临时项目。
 * @param {(root: string) => Promise<void>} body
 */
async function withProjectAsync(body) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-instr-'))
  try {
    mkdirSync(join(root, '.git'), { recursive: true })
    await body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** 构造一个带已领取消息的 decision。 */
function decisionWith(messages, overrides = {}) {
  return { kind: 'enter', messages, ...overrides }
}

/** 造一条已领取消息（模拟用户输入）。 */
const claimedMessage = { role: 'user', content: [{ type: 'text', text: 'hi' }] }

test('注册了 pre-step 监听器', () => {
  const { ctx, listeners } = makeFakeCtx()
  apply(ctx)
  assert.equal(listeners.length, 1)
})

test('有指令文件时把指令拼进 decision.messages', async () => {
  await withProjectAsync(async (root) => {
    mkdirSync(join(root, '.dsh'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'DSH.md'), '# hello from dsh', 'utf8')

    const { ctx, listeners } = makeFakeCtx()
    apply(ctx)
    const agent = makeAgent(root)

    const result = await listeners[0](
      { agent, messages: [claimedMessage], step: 2, signal: undefined },
      async () => decisionWith([claimedMessage]),
    )

    // 不走 inbox。
    assert.equal(agent._injected.length, 0)
    // 指令出现在 decision.messages 里，且位于已领取消息之后。
    assert.equal(result.messages.length, 2)
    assert.equal(result.messages[0], claimedMessage)
    assert.match(result.messages[1].content[0].text, /hello from dsh/)
  })
})

test('同一个 agent 不会被重复注入', async () => {
  await withProjectAsync(async (root) => {
    mkdirSync(join(root, '.dsh'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'DSH.md'), 'once only', 'utf8')

    const { ctx, listeners } = makeFakeCtx()
    apply(ctx)
    const agent = makeAgent(root)

    const next = async () => decisionWith([claimedMessage])
    const r1 = await listeners[0]({ agent, messages: [claimedMessage], step: 2, signal: undefined }, next)
    const r2 = await listeners[0]({ agent, messages: [claimedMessage], step: 3, signal: undefined }, next)

    assert.equal(r1.messages.length, 2, '第一次注入')
    assert.equal(r2.messages.length, 1, '第二次不再注入')
  })
})

test('无指令文件时不改消息列表', async () => {
  await withProjectAsync(async (root) => {
    const { ctx, listeners } = makeFakeCtx()
    apply(ctx)
    const agent = makeAgent(root)

    const result = await listeners[0](
      { agent, messages: [claimedMessage], step: 2, signal: undefined },
      async () => decisionWith([claimedMessage]),
    )
    assert.equal(result.messages.length, 1)
  })
})

test('decision 被拒绝时不注入', async () => {
  await withProjectAsync(async (root) => {
    mkdirSync(join(root, '.dsh'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'DSH.md'), 'should not appear', 'utf8')

    const { ctx, listeners } = makeFakeCtx()
    apply(ctx)
    const agent = makeAgent(root)

    const result = await listeners[0](
      { agent, messages: [claimedMessage], step: 2, signal: undefined },
      async () => ({ kind: 'reject' }),
    )
    assert.equal(result.kind, 'reject')
    assert.equal(result.messages, undefined)
  })
})

test('首个空批次（step 1 无已领取消息）不注入', async () => {
  await withProjectAsync(async (root) => {
    mkdirSync(join(root, '.dsh'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'DSH.md'), 'later step', 'utf8')

    const { ctx, listeners } = makeFakeCtx()
    apply(ctx)
    const agent = makeAgent(root)

    const result = await listeners[0](
      { agent, messages: [], step: 1, signal: undefined },
      async () => decisionWith([]),
    )
    assert.equal(result.messages.length, 0, '空批次保持原样，留到有输入的 step 再注入')
  })
})

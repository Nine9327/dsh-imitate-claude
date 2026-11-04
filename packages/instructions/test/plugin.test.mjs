/**
 * 指令插件接线测试：用假 ctx 驱动 pre-step，验证注入时机与内容。
 *
 * 注意：composeContext 需要 dsh 的渲染器，测试环境里以桩替代，
 * 以便把被测逻辑（发现 + 注入时机）与外部包解耦。
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
 * 造 agent 桩。
 * @param {string} cwd
 * @returns {object}
 */
function makeAgent(cwd) {
  const injected = []
  return {
    session: { header: { cwd } },
    inbox: { inject: (message) => injected.push(message) },
    _injected: injected,
  }
}

/**
 * 造临时项目。
 * @param {(root: string) => void} body
 */
function withProject(body) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-instr-'))
  try {
    mkdirSync(join(root, '.git'), { recursive: true })
    body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** 一个最小 decision 桩。 */
function decision(overrides = {}) {
  return { kind: 'enter', messages: [], ...overrides }
}

test('注册了 pre-step 监听器', () => {
  const { ctx, listeners } = makeFakeCtx()
  apply(ctx)
  assert.equal(listeners.length, 1)
})

test('有指令文件时注入一次', async () => {
  await withProjectAsync(async (root) => {
    mkdirSync(join(root, '.dsh'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'DSH.md'), '# hello from dsh', 'utf8')

    const { ctx, listeners } = makeFakeCtx()
    apply(ctx)
    const agent = makeAgent(root)

    await listeners[0]({ agent, signal: undefined }, async () => decision())
    assert.equal(agent._injected.length, 1)

    // 内容应当是渲染后的 system-reminder 块。
    const text = agent._injected[0].content[0].text
    assert.match(text, /hello from dsh/)
  })
})

test('同一个 agent 不会被重复注入', async () => {
  await withProjectAsync(async (root) => {
    mkdirSync(join(root, '.dsh'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'DSH.md'), 'once only', 'utf8')

    const { ctx, listeners } = makeFakeCtx()
    apply(ctx)
    const agent = makeAgent(root)

    const next = async () => decision()
    await listeners[0]({ agent, signal: undefined }, next)
    await listeners[0]({ agent, signal: undefined }, next)
    await listeners[0]({ agent, signal: undefined }, next)

    assert.equal(agent._injected.length, 1, '重复 pre-step 不应重复注入')
  })
})

test('无指令文件时不注入', async () => {
  await withProjectAsync(async (root) => {
    const { ctx, listeners } = makeFakeCtx()
    apply(ctx)
    const agent = makeAgent(root)

    await listeners[0]({ agent, signal: undefined }, async () => decision())
    assert.equal(agent._injected.length, 0)
  })
})

test('decision 被拒绝时不注入', async () => {
  await withProjectAsync(async (root) => {
    mkdirSync(join(root, '.dsh'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'DSH.md'), 'should not appear', 'utf8')

    const { ctx, listeners } = makeFakeCtx()
    apply(ctx)
    const agent = makeAgent(root)

    const result = await listeners[0]({ agent, signal: undefined }, async () => ({ kind: 'reject' }))
    assert.equal(result.kind, 'reject')
    assert.equal(agent._injected.length, 0)
  })
})

/**
 * withProject 的异步版本。
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

void withProject

/**
 * 插件接线测试：用假的 cordis ctx 驱动 apply()，验证注册与注入时机。
 *
 * 这样测的意义：dsh 进程启动依赖符号链接（沙箱里不可用），
 * 但插件自身的逻辑（何时注入、注入什么、是否重复）完全可以离线验证。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply as applyInit } from '../../command-init/src/index.js'
import { renderInstructionSkeleton } from '../../core/src/scaffold.js'

/**
 * 造一个临时的假 ctx，记录注册与注入。
 * @returns {{ ctx: object, commands: object[], injected: object[], followed: object[] }}
 */
function makeFakeCtx() {
  const commands = []
  const injected = []
  const followed = []

  const ctx = {
    logger: { warn() {} },
    commands: {
      register(definition) {
        commands.push(definition)
      },
    },
    on() {
      // 本测试不驱动 pre-step。
    },
  }

  return { ctx, commands, injected, followed }
}

/**
 * 造一个 agent 桩。
 * @param {string} cwd - 会话工作目录。
 * @returns {object} agent 桩。
 */
function makeAgent(cwd) {
  const injected = []
  const followed = []
  return {
    session: { header: { cwd } },
    inbox: { inject: (message) => injected.push(message) },
    followup: (message) => followed.push(message),
    _injected: injected,
    _followed: followed,
  }
}

/**
 * 造临时项目。
 * @param {(root: string) => void} body
 */
function withProject(body) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-init-'))
  try {
    mkdirSync(join(root, '.git'), { recursive: true })
    body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('/init 注册了名为 init 的命令', () => {
  const { ctx, commands } = makeFakeCtx()
  applyInit(ctx)
  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'init')
  assert.match(commands[0].input.hint, /force/)
})

test('/init 在空项目创建 .dsh 并触发模型补全', () => {
  withProject((root) => {
    const { ctx, commands } = makeFakeCtx()
    applyInit(ctx)
    const agent = makeAgent(root)

    const result = commands[0].handler({ agent, rawInput: '', attachments: [] })

    assert.equal(result.kind, 'success')
    assert.match(result.text, /已.*初始化/)
    // 骨架里写了 DSH.md，因此应当让模型去补全内容。
    assert.equal(agent._followed.length, 1)
    assert.match(agent._followed[0].content[0].text, /DSH\.md/)
  })
})

test('/init 幂等：已存在时不覆盖，也不重复烧 token', () => {
  withProject((root) => {
    mkdirSync(join(root, '.dsh'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'DSH.md'), 'USER CONTENT', 'utf8')
    const { ctx, commands } = makeFakeCtx()
    applyInit(ctx)
    const agent = makeAgent(root)

    const result = commands[0].handler({ agent, rawInput: '', attachments: [] })

    assert.equal(result.kind, 'success')
    // 第二次运行没有写 DSH.md，不应该触发补全。
    assert.equal(agent._followed.length, 0)
    assert.match(result.text, /已存在/)
  })
})

test('/init --force 允许重建', () => {
  withProject((root) => {
    const { ctx, commands } = makeFakeCtx()
    applyInit(ctx)
    const agent = makeAgent(root)

    const result = commands[0].handler({ agent, rawInput: '--force', attachments: [] })
    assert.equal(result.kind, 'success')
  })
})

test('已有项目但 DSH.md 仍是骨架：不覆盖文件，但触发补全', () => {
  withProject((root) => {
    mkdirSync(join(root, '.dsh'), { recursive: true })
    // 用真实的骨架渲染器写出占位文件，模拟"跑过 /init 但没填写"的项目。
    writeFileSync(
      join(root, '.dsh', 'DSH.md'),
      renderInstructionSkeleton({ projectName: 'legacy-project' }),
      'utf8',
    )

    const { ctx, commands } = makeFakeCtx()
    applyInit(ctx)
    const agent = makeAgent(root)

    const result = commands[0].handler({ agent, rawInput: '', attachments: [] })

    assert.equal(result.kind, 'success')
    // 文件未被覆盖。
    const after = readFileSync(join(root, '.dsh', 'DSH.md'), 'utf8')
    assert.match(after, /legacy-project/)
    // 但补全被触发了，且提示语点明这是"补全骨架"而非"新建"。
    assert.equal(agent._followed.length, 1)
    assert.match(result.text, /仍是初始骨架/)
    assert.match(agent._followed[0].content[0].text, /DSH\.md/)
  })
})

test('已有项目且 DSH.md 已填写：不覆盖也不触发补全', () => {
  withProject((root) => {
    mkdirSync(join(root, '.dsh'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'DSH.md'), '# legacy\n\n用 pnpm test 跑测试。\n', 'utf8')

    const { ctx, commands } = makeFakeCtx()
    applyInit(ctx)
    const agent = makeAgent(root)

    const result = commands[0].handler({ agent, rawInput: '', attachments: [] })
    assert.equal(result.kind, 'success')
    assert.equal(agent._followed.length, 0)
  })
})

test('/init 拒绝未知参数而不是静默忽略', () => {
  withProject((root) => {
    const { ctx, commands } = makeFakeCtx()
    applyInit(ctx)
    const agent = makeAgent(root)

    const result = commands[0].handler({ agent, rawInput: '--nope', attachments: [] })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /未知参数/)
  })
})

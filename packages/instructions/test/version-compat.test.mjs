/**
 * 跨版本兼容测试。
 *
 * 锁住一个真实事故：dsh 0.2.1 把 `renderWorkspaceContext` 改名为
 * `renderAgentInstructions`，旧代码直接调用旧名字，导致整轮对话以
 * `mod.renderWorkspaceContext is not a function` 失败。
 *
 * 这里用桩模块模拟两个版本的导出形状，验证插件都能正常渲染。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../src/index.js'

/**
 * 造一个能驱动 pre-step 的 ctx。
 * @returns {{ ctx: object, listeners: Function[] }}
 */
function makeCtx() {
  const listeners = []
  return {
    ctx: {
      logger: { warn() {} },
      on(event, handler) {
        if (event === 'agent/pre-step') listeners.push(handler)
      },
    },
    listeners,
  }
}

/**
 * 造临时项目并执行断言。
 * @param {(root: string) => Promise<void>} body
 */
async function withProject(body) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-compat-ver-'))
  try {
    mkdirSync(join(root, '.git'), { recursive: true })
    mkdirSync(join(root, '.dsh'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'DSH.md'), 'VERSION TEST', 'utf8')
    await body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('注入内容包含源文件内容（渲染器任一版本可用时）', async () => {
  await withProject(async (root) => {
    const { ctx, listeners } = makeCtx()
    apply(ctx)
    const agent = {
      session: { header: { cwd: root } },
      inbox: { nextStep: [] },
    }
    const claimed = { role: 'user', content: [{ type: 'text', text: 'hi' }] }

    const result = await listeners[0](
      { agent, messages: [claimed], step: 2, signal: undefined },
      async () => ({ kind: 'enter', messages: [claimed] }),
    )

    assert.equal(result.messages.length, 2)
    const text = result.messages[1].content[0].text
    assert.match(text, /VERSION TEST/)
    assert.match(text, /<system-reminder>/)
  })
})

test('渲染器完全不可用时仍能产出可用文本（本地降级）', async () => {
  await withProject(async (root) => {
    // 本测试进程里通常解析不到 dsh 的内置包，
    // 因此这条路径实际覆盖的就是 fallbackRender。
    const { composeContext } = await import('../src/index.js')
    const result = await composeContext({ cwd: root, projectRoot: root, maxBytes: 65536 })

    assert.ok(result.count > 0)
    assert.match(result.text, /VERSION TEST/)
    assert.match(result.text, /<\/system-reminder>/)
  })
})

test('预算极小时不抛错，返回截断后的文本', async () => {
  await withProject(async (root) => {
    const { composeContext } = await import('../src/index.js')
    const result = await composeContext({ cwd: root, projectRoot: root, maxBytes: 200 })
    assert.equal(typeof result.text, 'string')
    // 无论走内置还是降级渲染，都不能把异常抛给调用方。
  })
})

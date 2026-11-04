/**
 * 端到端验收：对每个 fixture 跑一次真实的发现 + 渲染，
 * 断言最终模型可见文本符合预期。
 *
 * 与单元测试的区别：这里走的是**完整链路**（发现 → 导入 → rules → 渲染），
 * 断言的是模型实际会看到的文本，而不是中间结构。
 *
 * 运行：node test/acceptance.mjs
 */

import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadInstructions } from '../packages/instructions/src/load.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

/**
 * 渲染器：优先用 dsh 内置实现；不可用时退回本地最小渲染。
 *
 * 验收脚本要能在"只装了源码、没装 dsh"的环境里跑，
 * 所以这里与插件本体采用同样的降级策略。
 * @returns {Promise<Function>}
 */
async function getRenderer() {
  try {
    const mod = await import('@deepseek-ai/dsh-agent-instructions')
    return (files, maxBytes) => mod.renderWorkspaceContext(files, { maxBytes }).text
  } catch {
    return (files, maxBytes) => {
      const body = files
        .flatMap((f) => [`Instructions from: ${f.displayPath}`, '', f.content, ''])
        .join('\n')
      const text = `<system-reminder>\n${body}\n</system-reminder>`
      return Buffer.byteLength(text, 'utf8') <= maxBytes ? text : text.slice(0, maxBytes)
    }
  }
}

/**
 * 跑一个 fixture。
 * @param {string} name - fixture 目录名。
 * @returns {Promise<{ text: string, files: object[] }>}
 */
async function runFixture(name) {
  const projectRoot = join(repoRoot, 'fixtures', name)
  const { files } = loadInstructions({ projectRoot, cwd: projectRoot })
  const render = await getRenderer()
  return { text: render(files, 65536), files }
}

/**
 * 断言辅助：文本必须包含 / 必须不包含某段。
 * @param {string} text
 * @param {string} needle
 * @param {string} label
 */
function expectContains(text, needle, label) {
  assert.ok(text.includes(needle), `${label}: 期望包含 "${needle}"，实际文本：\n${text}`)
}

/**
 * @param {string} text
 * @param {string} needle
 * @param {string} label
 */
function expectAbsent(text, needle, label) {
  assert.ok(!text.includes(needle), `${label}: 不应包含 "${needle}"，实际文本：\n${text}`)
}

let passed = 0
let failed = 0

/**
 * 执行一个用例并汇总。
 * @param {string} label
 * @param {() => Promise<void>} body
 */
async function check(label, body) {
  try {
    await body()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(String(error.message).split('\n').slice(0, 12).join('\n'))
  }
}

console.log('dsh-claude-compat 端到端验收\n')

await check('empty：空项目不产生任何注入', async () => {
  const { text, files } = await runFixture('empty')
  assert.equal(files.length, 0)
  // 没有文件时不产生任何指令内容（无论用内置还是降级渲染器）。
  assert.ok(!text.includes('Instructions from:'), '空项目不应渲染出任何指令段')
})

await check('with-dsh：.dsh/DSH.md 被加载', async () => {
  const { text } = await runFixture('with-dsh')
  expectContains(text, '.dsh/DSH.md', 'with-dsh')
})

await check('with-dsh：@import 被展开', async () => {
  const { text } = await runFixture('with-dsh')
  expectContains(text, '被导入的内容', 'with-dsh import')
  expectAbsent(text, '@extra.md', 'with-dsh import')
})

await check('with-dsh：rules 被合并', async () => {
  const { text } = await runFixture('with-dsh')
  expectContains(text, '所有提交前必须跑测试', 'with-dsh rules')
})

await check('with-claude：纯 Claude 项目可读（只读兼容）', async () => {
  const { text } = await runFixture('with-claude')
  expectContains(text, '纯 Claude 布局项目', 'with-claude main')
  expectContains(text, '这条规则来自', 'with-claude rules')
})

await check('mixed：.dsh 优先于 .claude', async () => {
  const { text, files } = await runFixture('mixed')
  // 关键断言：主指令来自 .dsh，且没有把 .claude 的内容也塞进来。
  assert.ok(
    files.some((file) => file.displayPath === '.dsh/DSH.md'),
    '应当发现 .dsh/DSH.md',
  )
  expectContains(text, '混合布局项目', 'mixed main')
  expectAbsent(text, '.claude/CLAUDE.md', 'mixed 不应注入 claude 主指令')
})

await check('mixed：同名规则取 .dsh 版本，不重复注入', async () => {
  const { text } = await runFixture('mixed')
  expectContains(text, '取这一份', 'mixed rule winner')
  expectAbsent(text, '说明优先级实现有 bug', 'mixed rule loser')
})

await check('import-cycle：环形导入被终止而非死循环', async () => {
  const { text } = await runFixture('import-cycle')
  assert.ok(text.length > 0, '应当仍有内容返回')
  expectContains(text, 'circular import skipped', 'import-cycle')
})

await check('全部 fixture：注入文本始终带 system-reminder 帧', async () => {
  for (const name of ['with-dsh', 'with-claude', 'mixed', 'import-cycle']) {
    const { text } = await runFixture(name)
    expectContains(text, '<system-reminder>', name)
    expectContains(text, '</system-reminder>', name)
  }
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed === 0 ? 0 : 1

/**
 * preset 生成器测试。
 *
 * 重点锁住一个曾经真实发生的 bug：替换区间把下一节的注释块吞掉了。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildPresetText } from '../src/preset.js'

/** 构造一个精简但结构真实的 composition。 */
const SOURCE = [
  '# identity',
  '',
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    suffix: hi',
  '',
  '- id: agent-instructions',
  "  name: '@deepseek-ai/dsh-agent-instructions'",
  '  config:',
  '    maxBytes: 65536',
  '',
  '# shell',
  '# 这段注释属于下一节，绝不能被吞掉。',
  '',
  '- id: tool-bash',
  "  name: '@deepseek-ai/dsh-tool-bash'",
  '',
].join('\n')

test('替换 agent-instructions 行为我们的实现', () => {
  const result = buildPresetText({ sourceText: SOURCE })
  assert.equal(result.changed, true)
  assert.match(result.text, /name: 'dsh-claude-compat\/instructions'/)
  assert.ok(!result.text.includes("name: '@deepseek-ai/dsh-agent-instructions'"))
})

test('回归：不吞掉下一节的注释块与标题', () => {
  const result = buildPresetText({ sourceText: SOURCE })

  // 这三行是历史 bug 的受害者，必须完好保留。
  assert.match(result.text, /# shell/)
  assert.match(result.text, /这段注释属于下一节/)
  assert.match(result.text, /- id: tool-bash/)
})

test('保留未涉及的行与顺序', () => {
  const result = buildPresetText({ sourceText: SOURCE })
  const lines = result.text.split('\n')

  // persona 在前，tool-bash 在后，顺序不变。
  const personaAt = lines.indexOf('- id: persona')
  const bashAt = lines.indexOf('- id: tool-bash')
  assert.ok(personaAt >= 0 && bashAt > personaAt)
})

test('追加 /init 命令行', () => {
  const result = buildPresetText({ sourceText: SOURCE })
  assert.match(result.text, /- id: claude-compat-command-init/)
  assert.match(result.text, /name: 'dsh-claude-compat\/command-init'/)
})

test('源文件缺少目标行时明确报告而不是静默通过', () => {
  const result = buildPresetText({ sourceText: '- id: persona\n  name: x\n' })
  assert.equal(result.changed, false)
  assert.match(result.reason, /not found/)
})

test('自定义 maxBytes 被写入', () => {
  const result = buildPresetText({ sourceText: SOURCE, maxBytes: 4096 })
  assert.match(result.text, /maxBytes: 4096/)
})

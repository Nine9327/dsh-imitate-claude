/**
 * 骨架判定测试：/init 对已有项目的行为核心。
 *
 * 锁住这次需求：已有项目的 .dsh/DSH.md 若仍是占位骨架，
 * /init 必须触发"根据项目填写内容"，而不是静默跳过。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isInstructionSkeleton, renderInstructionSkeleton } from '../src/scaffold.js'

test('刚生成的骨架被判定为未填写', () => {
  const skeleton = renderInstructionSkeleton({ projectName: 'demo' })
  assert.equal(isInstructionSkeleton(skeleton), true)
})

test('用户填写了实质内容后不再是骨架', () => {
  const filled = [
    '# demo',
    '',
    '## 项目概览',
    '',
    '这是一个 Vue 3 + Vite 的前端项目。',
    '',
    '## 开发约定',
    '',
    '提交前跑 pnpm test。',
    '',
  ].join('\n')
  assert.equal(isInstructionSkeleton(filled), false)
})

test('只有标题没有内容仍视为骨架', () => {
  assert.equal(isInstructionSkeleton('# demo\n\n## 项目概览\n'), true)
})

test('一句自然语言即视为已填写（判定保守）', () => {
  assert.equal(isInstructionSkeleton('# demo\n\n保持代码简洁。\n'), false)
})

test('注释里写再多内容也算未填写（占位说明不是内容）', () => {
  const skeleton = renderInstructionSkeleton({ projectName: 'demo' })
  // 骨架的占位说明全部在注释里，这正是判定依据。
  assert.equal(isInstructionSkeleton(skeleton), true)
})

test('用户在章节下补了内容同时保留了部分注释，判定为已填写', () => {
  const mixed = [
    '# demo',
    '',
    '## 项目概览',
    '',
    '<!-- 旧占位没删干净 -->',
    '',
    '用 pnpm 作为包管理器。',
    '',
  ].join('\n')
  assert.equal(isInstructionSkeleton(mixed), false)
})

test('空内容与空白内容都算未填写', () => {
  assert.equal(isInstructionSkeleton(''), true)
  assert.equal(isInstructionSkeleton('\n\n  \n'), true)
})

test('非字符串输入安全返回 false', () => {
  assert.equal(isInstructionSkeleton(undefined), false)
  assert.equal(isInstructionSkeleton(null), false)
  assert.equal(isInstructionSkeleton(123), false)
})

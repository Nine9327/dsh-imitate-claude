/**
 * 指令发现层测试：验证 .dsh 优先、导入展开、rules 合并、顺序正确。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { loadInstructions } from '../src/load.js'

/**
 * 造临时项目并执行断言。
 * @param {(root: string) => void} body
 */
function withProject(body) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-load-'))
  try {
    mkdirSync(join(root, '.git'), { recursive: true })
    body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('发现 .dsh/DSH.md（内置实现做不到的带目录候选）', () => {
  withProject((root) => {
    mkdirSync(join(root, '.dsh'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'DSH.md'), 'FROM DOT DSH', 'utf8')

    const { files } = loadInstructions({ projectRoot: root, cwd: root })
    assert.equal(files.length, 1)
    assert.equal(files[0].displayPath, '.dsh/DSH.md')
    assert.match(files[0].content, /FROM DOT DSH/)
  })
})

test('.dsh/DSH.md 优先于根目录 DSH.md 与 AGENTS.md', () => {
  withProject((root) => {
    mkdirSync(join(root, '.dsh'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'DSH.md'), 'DSH-DIR', 'utf8')
    writeFileSync(join(root, 'DSH.md'), 'DSH-ROOT', 'utf8')
    writeFileSync(join(root, 'AGENTS.md'), 'AGENTS', 'utf8')

    const { files } = loadInstructions({ projectRoot: root, cwd: root })
    const paths = files.map((f) => f.displayPath)

    // 三个内容不同 => 都保留，且顺序由宽到具体。
    assert.deepEqual(paths, ['.dsh/DSH.md', 'DSH.md', 'AGENTS.md'])
  })
})

test('内容完全相同的候选被去重', () => {
  withProject((root) => {
    writeFileSync(join(root, 'AGENTS.md'), 'SAME CONTENT', 'utf8')
    writeFileSync(join(root, 'CLAUDE.md'), 'SAME CONTENT', 'utf8')

    const { files } = loadInstructions({ projectRoot: root, cwd: root })
    assert.equal(files.length, 1)
    assert.equal(files[0].displayPath, 'AGENTS.md')
  })
})

test('纯 Claude 项目可被读取（只读兼容）', () => {
  withProject((root) => {
    mkdirSync(join(root, '.claude', 'rules'), { recursive: true })
    writeFileSync(join(root, 'CLAUDE.md'), 'CLAUDE MAIN', 'utf8')
    writeFileSync(join(root, '.claude', 'rules', 'a.md'), 'RULE A', 'utf8')

    const { files } = loadInstructions({ projectRoot: root, cwd: root })
    const joined = files.map((f) => f.content).join('\n')
    assert.match(joined, /CLAUDE MAIN/)
    assert.match(joined, /RULE A/)
  })
})

test('@import 在发现阶段被展开', () => {
  withProject((root) => {
    mkdirSync(join(root, '.dsh'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'extra.md'), 'INCLUDED BY IMPORT', 'utf8')
    writeFileSync(join(root, '.dsh', 'DSH.md'), 'main\n@extra.md\n', 'utf8')

    const { files, imported } = loadInstructions({ projectRoot: root, cwd: root })
    assert.match(files[0].content, /INCLUDED BY IMPORT/)
    assert.equal(imported.length, 1)
  })
})

test('rules 按目录优先级合并且 .dsh 版本胜出', () => {
  withProject((root) => {
    mkdirSync(join(root, '.dsh', 'rules'), { recursive: true })
    mkdirSync(join(root, '.claude', 'rules'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'rules', 'same.md'), 'DSH RULE', 'utf8')
    writeFileSync(join(root, '.claude', 'rules', 'same.md'), 'CLAUDE RULE', 'utf8')

    const { files } = loadInstructions({ projectRoot: root, cwd: root })
    const joined = files.map((f) => f.content).join('\n')
    assert.match(joined, /DSH RULE/)
    assert.ok(!joined.includes('CLAUDE RULE'), '.claude 同名规则不应重复注入')
  })
})

test('嵌套目录的指令按 broad → specific 排序', () => {
  withProject((root) => {
    const nested = join(root, 'packages', 'app')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(root, 'AGENTS.md'), 'ROOT LEVEL', 'utf8')
    writeFileSync(join(nested, 'AGENTS.md'), 'NESTED LEVEL', 'utf8')

    const { files } = loadInstructions({ projectRoot: root, cwd: nested })
    const paths = files.map((f) => f.displayPath)
    assert.deepEqual(paths, ['AGENTS.md', 'packages/app/AGENTS.md'])
  })
})

test('空项目返回空列表而非报错', () => {
  withProject((root) => {
    const { files, warnings } = loadInstructions({ projectRoot: root, cwd: root })
    assert.deepEqual(files, [])
    assert.deepEqual(warnings, [])
  })
})

test('关闭导入时保留 @path 字面量', () => {
  withProject((root) => {
    mkdirSync(join(root, '.dsh'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'extra.md'), 'SHOULD NOT APPEAR', 'utf8')
    writeFileSync(join(root, '.dsh', 'DSH.md'), '@extra.md\n', 'utf8')

    const { files } = loadInstructions({
      projectRoot: root,
      cwd: root,
      enableImports: false,
    })
    assert.match(files[0].content, /@extra\.md/)
    assert.ok(!files[0].content.includes('SHOULD NOT APPEAR'))
  })
})

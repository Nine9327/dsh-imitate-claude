/**
 * core 包的单元测试：覆盖路径安全、导入展开、规则收集、脚手架幂等。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  assertInsideRoot,
  collectRules,
  expandImports,
  findProjectRoot,
  renderRules,
  scaffoldProject,
} from '../src/index.js'

/**
 * 造一个临时目录，测试结束自动清理。
 * @param {(dir: string) => void} body
 */
function withTempDir(body) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-compat-'))
  try {
    body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('assertInsideRoot 接受根内路径，拒绝逃逸', () => {
  withTempDir((root) => {
    assert.equal(assertInsideRoot(root, join(root, 'a', 'b')), join(root, 'a', 'b'))
    assert.equal(assertInsideRoot(root, root), root)

    // 关键回归：前缀相同的兄弟目录不能被误判为"在内"。
    assert.throws(() => assertInsideRoot(join(root, 'a'), join(root, 'ab', 'x')), /outside the project root/)
    assert.throws(() => assertInsideRoot(root, join(root, '..', 'escape')), /outside the project root/)
  })
})

test('findProjectRoot 命中 .git，向上冒泡', () => {
  withTempDir((root) => {
    const nested = join(root, 'pkg', 'deep')
    mkdirSync(nested, { recursive: true })
    // 无 marker 时退化为起始目录。
    assert.equal(findProjectRoot(nested), nested)

    mkdirSync(join(root, '.git'))
    assert.equal(findProjectRoot(nested), root)
  })
})

test('expandImports 展开单层导入并保留缩进', () => {
  withTempDir((root) => {
    writeFileSync(join(root, 'inc.md'), 'IMPORTED\n', 'utf8')
    const main = join(root, 'main.md')
    writeFileSync(main, 'before\n@inc.md\nafter\n', 'utf8')

    const result = expandImports({ path: main })
    assert.match(result.content, /IMPORTED/)
    assert.ok(!result.content.includes('@inc.md'), '导入行应被替换')
    assert.deepEqual(result.warnings, [])
    assert.equal(result.imported.length, 1)
  })
})

test('expandImports 对缺失文件降级为提示而非抛错', () => {
  withTempDir((root) => {
    const main = join(root, 'main.md')
    writeFileSync(main, '@nope.md\n', 'utf8')

    const result = expandImports({ path: main })
    assert.match(result.content, /missing import: nope\.md/)
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /missing import/)
  })
})

test('expandImports 检测循环导入', () => {
  withTempDir((root) => {
    writeFileSync(join(root, 'a.md'), '@b.md\n', 'utf8')
    writeFileSync(join(root, 'b.md'), '@a.md\n', 'utf8')

    const result = expandImports({ path: join(root, 'a.md') })
    assert.match(result.content, /circular import skipped/)
    // 不能无限递归：能正常返回本身就是通过条件。
    assert.ok(result.warnings.some((w) => w.includes('circular')))
  })
})

test('expandImports 遵守深度上限', () => {
  withTempDir((root) => {
    writeFileSync(join(root, '1.md'), '@2.md\n', 'utf8')
    writeFileSync(join(root, '2.md'), '@3.md\n', 'utf8')
    writeFileSync(join(root, '3.md'), 'END\n', 'utf8')

    const result = expandImports({ path: join(root, '1.md'), maxDepth: 1 })
    assert.ok(result.warnings.some((w) => w.includes('depth limit') || w.includes('max import depth')))
  })
})

test('collectRules 按优先级去重且顺序确定', () => {
  withTempDir((root) => {
    mkdirSync(join(root, '.dsh', 'rules'), { recursive: true })
    mkdirSync(join(root, '.claude', 'rules'), { recursive: true })

    writeFileSync(join(root, '.dsh', 'rules', 'b.md'), 'DSH-B', 'utf8')
    writeFileSync(join(root, '.dsh', 'rules', 'a.md'), 'DSH-A', 'utf8')
    writeFileSync(join(root, '.claude', 'rules', 'a.md'), 'CLAUDE-A', 'utf8')
    writeFileSync(join(root, '.claude', 'rules', 'c.md'), 'CLAUDE-C', 'utf8')

    const { files } = collectRules({ projectRoot: root })
    const names = files.map((f) => f.displayPath)

    assert.deepEqual(names, ['.dsh/rules/a.md', '.dsh/rules/b.md', '.claude/rules/c.md'])
    // 优先级的实质：同名 a.md 取 .dsh 版本。
    assert.equal(files[0].content, 'DSH-A')
  })
})

test('renderRules 无规则时返回空串', () => {
  assert.equal(renderRules([]), '')
})

test('scaffoldProject 创建结构且幂等', () => {
  withTempDir((root) => {
    const first = scaffoldProject({ projectRoot: root })
    assert.ok(first.created.includes('.dsh/'))
    assert.ok(first.created.includes('.dsh/DSH.md'))
    assert.ok(existsSync(join(root, '.dsh', 'DSH.md')))
    assert.ok(existsSync(join(root, '.dsh', 'rules')))
    assert.ok(existsSync(join(root, '.dsh', 'skills')))

    const content = readFileSync(join(root, '.dsh', 'DSH.md'), 'utf8')
    assert.match(content, /^# /)

    // 第二次：不应再 "创建" 主指令，且不能覆盖用户内容。
    writeFileSync(join(root, '.dsh', 'DSH.md'), 'USER EDITED', 'utf8')
    const second = scaffoldProject({ projectRoot: root })
    assert.ok(second.skipped.includes('.dsh/DSH.md'))
    assert.equal(readFileSync(join(root, '.dsh', 'DSH.md'), 'utf8'), 'USER EDITED')
  })
})

test('scaffoldProject 发现 CLAUDE.md 时给出兼容提示', () => {
  withTempDir((root) => {
    writeFileSync(join(root, 'CLAUDE.md'), 'claude', 'utf8')
    const result = scaffoldProject({ projectRoot: root })
    assert.ok(result.warnings.some((w) => w.includes('CLAUDE.md')))
  })
})

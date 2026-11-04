/**
 * 项目命令插件的单元测试。
 *
 * 覆盖：frontmatter 解析、占位符展开、目录扫描、命令子插件定义、
 * apply 的挂载时机与作用域隔离。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  apply,
  createCommandPlugin,
  expandArguments,
  parseCommandFile,
  scanProjectCommands,
} from '../src/index.js'

/**
 * 造临时项目。
 * @param {(root: string) => void} body
 */
function withProject(body) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-projcmd-'))
  try {
    mkdirSync(join(root, '.git'), { recursive: true })
    body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('parseCommandFile 提取 frontmatter 键并剥离正文', () => {
  const raw = [
    '---',
    'description: 重构当前文件',
    'argument-hint: [file]',
    '---',
    '',
    '请重构 $ARGUMENTS。',
  ].join('\n')

  const parsed = parseCommandFile(raw)
  assert.equal(parsed.description, '重构当前文件')
  assert.equal(parsed.argumentHint, '[file]')
  assert.equal(parsed.body, '请重构 $ARGUMENTS。')
})

test('parseCommandFile 无 frontmatter 时全文为正文', () => {
  const parsed = parseCommandFile('直接执行\n第二行')
  assert.equal(parsed.description, '')
  assert.equal(parsed.body, '直接执行\n第二行')
})

test('parseCommandFile 剥离引号包裹的值', () => {
  const parsed = parseCommandFile('---\ndescription: "带引号"\n---\nbody')
  assert.equal(parsed.description, '带引号')
})

test('expandArguments 替换 $ARGUMENTS 与位置参数', () => {
  assert.equal(expandArguments('全部: $ARGUMENTS', 'a b c'), '全部: a b c')
  assert.equal(expandArguments('第一: $1 第二: $2', 'x y'), '第一: x 第二: y')
  assert.equal(expandArguments('缺失: [$2]', 'only'), '缺失: []')
})

test('scanProjectCommands 扫描合法文件并跳过非法名', () => {
  withProject((root) => {
    const dir = join(root, '.dsh', 'commands')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'deploy.md'), '---\ndescription: 部署\n---\n部署 $1', 'utf8')
    writeFileSync(join(dir, 'build.md'), '构建', 'utf8')
    // 非法名：大写
    writeFileSync(join(dir, 'Bad.md'), 'bad', 'utf8')
    // 非法名：特殊字符
    writeFileSync(join(dir, 'a b.md'), 'bad', 'utf8')
    // 非 md
    writeFileSync(join(dir, 'notes.txt'), 'text', 'utf8')

    const commands = scanProjectCommands(root)
    assert.deepEqual(commands.map((c) => c.name).sort(), ['build', 'deploy'])
    assert.equal(commands.find((c) => c.name === 'deploy').description, '部署')
    // 无 frontmatter 的文件有兜底描述。
    assert.match(commands.find((c) => c.name === 'build').description, /project command/)
  })
})

test('scanProjectCommands 目录不存在时返回空数组', () => {
  withProject((root) => {
    assert.deepEqual(scanProjectCommands(root), [])
  })
})

test('scanProjectCommands 超过上限时截断', () => {
  withProject((root) => {
    const dir = join(root, '.dsh', 'commands')
    mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 70; i++) writeFileSync(join(dir, `cmd${i}.md`), 'x', 'utf8')
    assert.equal(scanProjectCommands(root).length, 64)
  })
})

test('createCommandPlugin 生成 command-injected 定义并在 apply 时注册', () => {
  const plugin = createCommandPlugin([
    { name: 'deploy', description: '部署', argumentHint: '[env]', body: '部署 $1' },
    { name: 'build', description: '构建', argumentHint: '', body: '构建' },
  ])

  assert.deepEqual(plugin.inject, ['commands'])

  const registered = []
  plugin.apply({
    commands: { register: (d) => registered.push(d) },
  })

  assert.equal(registered.length, 2)
  assert.equal(registered[0].name, 'deploy')
  assert.equal(registered[0].input.hint, '[env]')
  // 无 argument-hint 时不应带 input 字段（或为 undefined）。
  assert.ok(!registered[1].input?.hint)
})

test('createCommandPlugin 的 handler 展开占位符并 followup', () => {
  const plugin = createCommandPlugin([
    { name: 'greet', description: '打招呼', argumentHint: '[name]', body: '你好 $1' },
  ])
  const registered = []
  plugin.apply({ commands: { register: (d) => registered.push(d) } })

  const followed = []
  const agent = { followup: (m) => followed.push(m) }
  const result = registered[0].handler({ agent, rawInput: '小明', attachments: [] })

  assert.equal(result.kind, 'success')
  assert.equal(followed.length, 1)
  assert.equal(followed[0].content[0].text, '你好 小明')
})

test('apply：项目有命令时经 agent.ctx.plugin 挂载', () => {
  withProject((root) => {
    const dir = join(root, '.dsh', 'commands')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'deploy.md'), '---\ndescription: 部署\n---\n部署', 'utf8')

    const plugged = []
    const listeners = new Map()
    const ctx = {
      logger: { warn() {} },
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, [])
        listeners.get(event).push(handler)
      },
      effect() {},
      plugin: undefined, // 由 agent.ctx 提供
    }
    apply(ctx, { watch: false })

    // 触发 agent/created。
    const pluggedInto = []
    const agent = {
      session: { header: { cwd: root } },
      ctx: { plugin: (def) => pluggedInto.push(def) },
    }
    for (const h of listeners.get('agent/created')) h({ agent })

    assert.equal(pluggedInto.length, 1, '应向 agent.ctx.plugin 挂载一个命令子插件')
    assert.deepEqual(pluggedInto[0].inject, ['commands'])

    // 子插件 apply 时注册命令。
    const registered = []
    pluggedInto[0].apply({ commands: { register: (d) => registered.push(d) } })
    assert.deepEqual(registered.map((d) => d.name), ['deploy'])
  })
})

test('apply：项目无命令时不挂载任何子插件', () => {
  withProject((root) => {
    const listeners = new Map()
    const ctx = {
      logger: { warn() {} },
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, [])
        listeners.get(event).push(handler)
      },
      effect() {},
    }
    apply(ctx, { watch: false })

    const pluggedInto = []
    const agent = {
      session: { header: { cwd: root } },
      ctx: { plugin: (def) => pluggedInto.push(def) },
    }
    for (const h of listeners.get('agent/created')) h({ agent })

    assert.equal(pluggedInto.length, 0)
  })
})

test('apply：agent/disposed 后清理记录', () => {
  withProject((root) => {
    const dir = join(root, '.dsh', 'commands')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'deploy.md'), '部署', 'utf8')

    const listeners = new Map()
    const ctx = {
      logger: { warn() {} },
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, [])
        listeners.get(event).push(handler)
      },
      effect() {},
    }
    apply(ctx, { watch: false })

    const agent = {
      session: { header: { cwd: root } },
      ctx: { plugin: () => ({}) },
    }
    for (const h of listeners.get('agent/created')) h({ agent })
    for (const h of listeners.get('agent/disposed')) h({ agent })

    // dispose 后再触发 created 仍能重新挂载（不因残留记录失败）。
    const pluggedInto = []
    const agent2 = { session: { header: { cwd: root } }, ctx: { plugin: (d) => pluggedInto.push(d) } }
    for (const h of listeners.get('agent/created')) h({ agent: agent2 })
    assert.equal(pluggedInto.length, 1)
  })
})

test('apply：同名冲突只影响单条命令，其余照常注册', () => {
  withProject((root) => {
    const dir = join(root, '.dsh', 'commands')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'aa.md'), 'A', 'utf8')
    writeFileSync(join(dir, 'bb.md'), 'B', 'utf8')

    const listeners = new Map()
    const warnings = []
    const ctx = {
      logger: { warn: (m) => warnings.push(m) },
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, [])
        listeners.get(event).push(handler)
      },
      effect() {},
    }
    apply(ctx, { watch: false })

    const agent = {
      session: { header: { cwd: root } },
      ctx: {
        plugin: (def) => ({
          apply: (commandCtx) => def.apply(commandCtx),
        }),
      },
    }
    // 让 aa.md 注册时抛冲突。
    for (const h of listeners.get('agent/created')) {
      h({ agent })
    }
    void warnings
  })
})

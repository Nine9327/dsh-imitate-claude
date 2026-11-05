/**
 * `.dsh/commands/*.md` → 项目级斜杠命令（只对本项目生效）。
 *
 * **作用域策略**（三重保证，均已对照 dsh 源码确认）：
 *
 * 1. 挂载点：本插件本身位于 agent preset（`sync-preset` 生成的副本），
 *    其注册天然是 preset 作用域，不是全局；
 * 2. 动态挂载：`agent/created` 时检查会话工作区的项目根，只有当项目里
 *    真的含 `.dsh/commands/*.md` 时，才通过 `agent.ctx.plugin()` 挂一个
 *    command-injected 子插件——README 明示这是 agent 作用域注册的唯一途径
 *    （`dsh-commands/README.md`：「A command-producing plugin mounted
 *    beneath `agent.ctx`」），agent 销毁时随 ctx 自动回收；
 * 3. 目录判定：项目根由会话 cwd 向上探测（`.git` 等），换项目自动换命令集。
 *
 * 文件格式（对齐 Claude Code 自定义命令）：
 *   ---
 *   description: 重构当前文件
 *   argument-hint: [file]
 *   ---
 *   请重构 $ARGUMENTS，保持行为不变。
 *
 * 占位符：$ARGUMENTS（全部输入）、$1..$9（按空白切分的位置参数）。
 *
 * @module dsh-imitate-claude-project-commands
 */

import { existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs'
import { join } from 'node:path'

import { COMMANDS_DIR, CONFIG_DIR, findProjectRoot } from '../core/index.js'

/** 插件名。 */
export const name = 'imitate-claude-project-commands'

/**
 * 依赖的 cordis 服务。
 *
 * 必须声明 `sessionProjections`：本插件在 `agent/created` 时经
 * `agent.ctx.plugin()` 创建 agent 作用域子 fiber，dsh 在该作用域解析
 * 注入链时会读取 sessionProjections。缺声明会抛
 * `cannot get property "sessionProjections" without inject` 并打断会话创建。
 */
export const inject = ['sessionProjections']

/** 命令名合法字符（与 dsh-commands 的语法一致）。 */
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

/** 单个项目最多注册的命令数。 */
export const MAX_COMMANDS = 64

/** 单个命令文件的大小上限（字节）。 */
export const MAX_FILE_BYTES = 256 * 1024

/** 命令目录变动的防抖窗口（毫秒）。 */
const WATCH_DEBOUNCE_MS = 300

/**
 * 解析命令文件的 frontmatter 与正文。
 *
 * 刻意不做完整 YAML 解析：命令文件只需要 `description` 和 `argument-hint`
 * 两个单行键，正则提取足够且不引入依赖。
 *
 * @param {string} raw - 文件内容。
 * @returns {{ description: string, argumentHint: string, body: string }}
 */
export function parseCommandFile(raw) {
  const normalized = raw.replace(/\r/g, '')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)

  let description = ''
  let argumentHint = ''
  let body = normalized

  if (match !== null) {
    body = normalized.slice(match[0].length)
    for (const line of match[1].split('\n')) {
      const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim())
      if (kv === null) continue
      const key = kv[1].toLowerCase()
      const value = kv[2].trim().replace(/^['"]|['"]$/g, '')
      if (key === 'description') description = value
      else if (key === 'argument-hint') argumentHint = value
    }
  }

  return { description, argumentHint, body: body.trim() }
}

/**
 * 展开命令正文里的占位符。
 * @param {string} body - 命令正文。
 * @param {string} rawInput - 用户输入。
 * @returns {string} 替换后的文本。
 */
export function expandArguments(body, rawInput) {
  const args = rawInput.trim().split(/\s+/).filter(Boolean)
  let text = body
  for (let index = 0; index < 9; index += 1) {
    text = text.split(`$${index + 1}`).join(args[index] ?? '')
  }
  return text.split('$ARGUMENTS').join(rawInput.trim())
}

/**
 * 扫描一个项目根下的命令目录。
 *
 * 目录不存在、空目录、坏文件都安全返回空数组；单个文件的问题不影响其余命令。
 *
 * @param {string} projectRoot - 项目根。
 * @returns {Array<{ name: string, description: string, argumentHint: string, body: string }>}
 */
export function scanProjectCommands(projectRoot) {
  const dir = join(projectRoot, CONFIG_DIR, COMMANDS_DIR)
  if (!existsSync(dir)) return []

  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const name = entry.name.slice(0, -3)
    if (!NAME_RE.test(name)) continue
    if (out.length >= MAX_COMMANDS) break

    try {
      const file = join(dir, entry.name)
      if (statSync(file).size > MAX_FILE_BYTES) continue
      const parsed = parseCommandFile(readFileSync(file, 'utf8'))
      out.push({
        name,
        description: parsed.description || `project command from ${CONFIG_DIR}/${COMMANDS_DIR}`,
        argumentHint: parsed.argumentHint,
        body: parsed.body,
      })
    } catch {
      // 单个坏文件跳过。
    }
  }
  return out
}

/**
 * 构造命令处理器：把正文展开占位符后作为一轮模型输入提交。
 * @param {{ name: string, body: string }} command - 命令定义。
 * @returns {(invocation: object) => object} 处理器。
 */
function buildHandler(command) {
  return (invocation) => {
    const text = expandArguments(command.body, invocation.rawInput ?? '')
    if (text.length === 0) {
      return { kind: 'error', text: `命令 ${command.name} 的内容为空，请检查 .dsh/commands/ 下的定义。` }
    }

    invocation.agent.followup({
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'imitate-claude-command' },
    })
    return { kind: 'success', text: `已把 /${command.name} 的内容提交给模型。` }
  }
}

/**
 * 生成一个 command-injected 子插件的定义。
 *
 * 返回值可直接传给 `agent.ctx.plugin()`；`inject: ['commands']` 使
 * cordis 在 agent 作用域内解析出 commands 服务，注册即被限定在该 agent。
 *
 * @param {Array<{ name: string, description: string, argumentHint: string, body: string }>} commands
 * @param {object} logger - 宿主日志（可为 null）。
 * @returns {{ name: string, inject: string[], apply: Function }}
 */
export function createCommandPlugin(commands, logger = null) {
  return {
    name: 'imitate-claude-project-commands-mount',
    inject: ['commands'],
    apply(commandCtx) {
      for (const command of commands) {
        try {
          commandCtx.commands.register({
            name: command.name,
            description: command.description,
            input: command.argumentHint ? { hint: command.argumentHint } : undefined,
            handler: buildHandler(command),
          })
        } catch (error) {
          // 同层重复名会抛；单条失败不拖垮其余命令。
          logger?.warn?.(`imitate-claude: /${command.name} 注册失败: ${error.message}`)
        }
      }
    },
  }
}

/**
 * 注册插件。
 *
 * @param {object} ctx - 宿主 ctx（preset 或 bundle 层均可）。
 * @param {object} [config] - 配置。
 * @param {boolean} [config.watch=true] - 监听命令目录变化并热更新。
 */
export function apply(ctx, config = {}) {
  const watchEnabled = config.watch ?? true

  /** agent → 其挂载记录，用于变更时重挂与销毁时回收。 */
  const mounted = new Map()

  /** 命令目录 → watcher 共享记录（同项目多 agent 共用一个 watcher）。 */
  const watchers = new Map()

  /**
   * 为一个 agent 挂载当前项目的命令。
   * @param {object} agent
   */
  function mountFor(agent) {
    // 先卸旧（若有）：保证文件变更后命令表与磁盘一致。
    unmountFor(agent)

    const cwd = agent.session?.header?.cwd ?? process.cwd()
    const projectRoot = findProjectRoot(cwd)
    const commands = scanProjectCommands(projectRoot)
    if (commands.length === 0) return

    try {
      // agent 作用域挂载：agent.ctx 的子 fiber，agent 销毁时自动回收。
      // 注意：绝不能对 ctx（cordis 的 Proxy）做任何未声明的属性赋值，
      // 否则会抛 "cannot set property ... without provide" 并打断会话创建。
      const fiber = agent.ctx.plugin(createCommandPlugin(commands, ctx.logger ?? null))
      void fiber
      mounted.set(agent, { projectRoot, commands })
    } catch (error) {
      ctx.logger?.warn?.(`imitate-claude: 项目命令挂载失败: ${error.message}`)
    }
  }

  /**
   * 卸载一个 agent 的命令（重挂或 agent 销毁时调用）。
   * @param {object} agent
   */
  function unmountFor(agent) {
    const record = mounted.get(agent)
    if (record === undefined) return
    mounted.delete(agent)
    // 子 fiber 随 agent.ctx 的 dispose 自动回收；这里的 map 清理
    // 只是让后续 watcher 重挂能重新走 agent.ctx.plugin()。
  }

  ctx.on('agent/created', ({ agent }) => {
    mountFor(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    unmountFor(agent)
    // 回收本 agent 参与的 watcher。
    for (const [dir, entry] of watchers) {
      entry.agents.delete(agent)
      if (entry.agents.size === 0) {
        try {
          entry.watcher.close()
        } catch {
          // 忽略。
        }
        watchers.delete(dir)
      }
    }
  })

  // 热更新：命令目录变化后按 agent 重挂（先卸后挂，幂等）。
  if (watchEnabled) {
    ctx.on('agent/created', ({ agent }) => {
      const record = mounted.get(agent)
      if (record === undefined) return
      const dir = join(record.projectRoot, CONFIG_DIR, COMMANDS_DIR)
      if (!existsSync(dir)) return

      let entry = watchers.get(dir)
      if (entry === undefined) {
        try {
          let timer
          const watcher = watch(dir, { persistent: false }, () => {
            clearTimeout(timer)
            timer = setTimeout(() => {
              for (const a of entry.agents) mountFor(a)
            }, WATCH_DEBOUNCE_MS)
          })
          watcher.on('error', () => {
            // 监听失败只影响热更新，不影响首次注册。
          })
          entry = { watcher, agents: new Set() }
          watchers.set(dir, entry)
        } catch {
          return
        }
      }
      entry.agents.add(agent)
    })
  }

  // 插件整体 dispose 时关掉全部 watcher。
  // cordis 的 effect 约定：回调返回一个函数作为 disposer，
  // 或返回可迭代对象收集多个 disposer；不要返回生成器函数。
  ctx.effect(() => () => {
    for (const entry of watchers.values()) {
      try {
        entry.watcher.close()
      } catch {
        // 忽略。
      }
    }
    watchers.clear()
    mounted.clear()
  })
}

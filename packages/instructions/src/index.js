/**
 * `.dsh` 指令加载插件。
 *
 * 形态：**旁挂**而非 fork。复用内置 `dsh-agent-instructions` 的
 * `renderWorkspaceContext`（公开导出）做预算裁剪与 frame 转义，
 * 自己只接管"发现哪些文件、文件内容是什么"。
 *
 * 关键契约（均已核对 dsh 0.1.5-rc.2 类型定义）：
 *   - `agent/pre-step` 是 waterfall，签名见 dsh-agent `runtime-types.d.ts:313`；
 *   - 工作目录在 `agent.session.header.cwd`（内置插件同款取值方式）；
 *   - 注入用 `agent.inbox.inject(message)`，消息须由 `createUserMessage` 构造。
 *
 * @module dsh-claude-compat-instructions
 */

import { findProjectRoot } from 'dsh-claude-compat-core'

import { loadInstructions } from './load.js'

/** 插件名。 */
export const name = 'claude-compat-instructions'

/** 本插件依赖的 cordis 服务。 */
export const inject = []

/**
 * 构造一条用户消息。
 *
 * 优先用 dsh 的 `createUserMessage`（它会补上稳定 id 并冻结对象）；
 * 该包不可解析时退化成本地构造，保证插件在测试或精简环境下仍可加载。
 *
 * 之所以不写成顶层 import：`@deepseek-ai/*` 由 dsh 的模块回退机制提供，
 * 顶层强依赖会让插件在没有该回退的环境里（例如单测）直接加载失败。
 *
 * @param {string} text - 消息正文。
 * @returns {object} 消息对象。
 */
async function createTextUserMessage(text) {
  try {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'claude-compat-instructions' },
    })
  } catch {
    return {
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'claude-compat-instructions' },
    }
  }
}

/**
 * 组合一次上下文注入所需的文本。
 *
 * @param {object} options - 组合选项。
 * @param {string} options.cwd - 会话工作目录。
 * @param {string} options.projectRoot - 项目根。
 * @param {number} options.maxBytes - 预算。
 * @param {boolean} [options.enableImports=true] - 是否展开 `@path`。
 * @param {number} [options.maxImportDepth=5] - 导入递归上限。
 * @returns {Promise<{ text: string, warnings: string[], count: number }>}
 */
export async function composeContext(options) {
  const { cwd, projectRoot, maxBytes, enableImports = true, maxImportDepth = 5 } = options

  const { files, warnings } = loadInstructions({
    projectRoot,
    cwd,
    enableImports,
    maxImportDepth,
  })

  if (files.length === 0) {
    return { text: '', warnings, count: 0 }
  }

  const renderer = await loadRenderer()

  // 与内置实现共用同一套渲染：预算裁剪、超限提示、frame 转义全部复用，
  // 保证模型看到的形状与原生一致。
  const rendered = renderer(files, maxBytes)

  if (rendered.omitted.length > 0) {
    warnings.push(
      `instruction budget omitted: ${rendered.omitted.map((file) => file.displayPath).join(', ')}`,
    )
  }
  if (rendered.truncated.length > 0) {
    warnings.push(
      `instruction budget truncated: ${rendered.truncated.map((file) => file.displayPath).join(', ')}`,
    )
  }

  return { text: rendered.text, warnings, count: files.length }
}

/**
 * 加载渲染器。
 *
 * 首选复用内置 `dsh-agent-instructions` 的公开导出，保证输出形状
 * （`<system-reminder>` 帧、预算裁剪、去重提示）与 dsh 原生完全一致。
 * 该包不可解析时退化为本地最小渲染，使插件在精简环境下仍能工作，
 * 而不是直接抛错让整个 agent 启动失败。
 *
 * @returns {Promise<(files: object[], maxBytes: number) => { text: string, omitted: object[], truncated: object[] }>}
 */
async function loadRenderer() {
  try {
    const mod = await import('@deepseek-ai/dsh-agent-instructions')
    return (files, maxBytes) => mod.renderWorkspaceContext(files, { maxBytes })
  } catch {
    return fallbackRender
  }
}

/** 与内置实现一致的引导语。 */
const INTRO =
  'The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.'

/**
 * 本地最小渲染：仅在拿不到内置渲染器时使用。
 *
 * 预算裁剪策略与内置一致：超预算时先丢弃较"宽"的文件，保留最具体的。
 *
 * @param {object[]} files - 由宽到具体的文件列表。
 * @param {number} maxBytes - 字节预算。
 * @returns {{ text: string, omitted: object[], truncated: object[] }}
 */
function fallbackRender(files, maxBytes) {
  const build = (included) =>
    [
      '<system-reminder>',
      INTRO,
      '',
      ...included.flatMap((file) => [`Instructions from: ${file.displayPath}`, '', file.content, '']),
      '</system-reminder>',
    ].join('\n')

  const full = build(files)
  if (Buffer.byteLength(full, 'utf8') <= maxBytes) {
    return { text: full, omitted: [], truncated: [] }
  }

  // 逐个丢弃最宽的文件，直到满足预算。
  for (let start = 1; start < files.length; start += 1) {
    const included = files.slice(start)
    const text = build(included)
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
      return {
        text,
        omitted: files.slice(0, start).map((f) => ({
          absolutePath: f.absolutePath,
          displayPath: f.displayPath,
        })),
        truncated: [],
      }
    }
  }

  // 只剩一个文件仍超预算：截断它。
  const last = files[files.length - 1]
  const cut = Buffer.from(last.content, 'utf8').subarray(0, Math.max(0, maxBytes - 512)).toString('utf8')
  return {
    text: build([{ ...last, content: cut }]),
    omitted: files.slice(0, -1).map((f) => ({
      absolutePath: f.absolutePath,
      displayPath: f.displayPath,
    })),
    truncated: [{ absolutePath: last.absolutePath, displayPath: last.displayPath }],
  }
}

/**
 * 注册插件。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {object} [config] - 插件配置。
 * @param {number} [config.maxBytes=65536] - 注入内容字节预算。
 * @param {boolean} [config.enableImports=true] - 是否展开 `@path` 导入。
 * @param {number} [config.maxImportDepth=5] - 导入递归上限。
 */
export function apply(ctx, config = {}) {
  const maxBytes = config.maxBytes ?? 65536
  const enableImports = config.enableImports ?? true
  const maxImportDepth = config.maxImportDepth ?? 5

  // 每个 agent 只注入一次：指令是基线，不需要每步重复消耗上下文。
  const injected = new WeakSet()

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (injected.has(agent)) return decision

    // 与内置插件相同的取值方式：会话头里的 cwd，缺失时退回进程 cwd。
    const cwd = agent.session?.header?.cwd ?? process.cwd()
    const projectRoot = findProjectRoot(cwd)

    const composed = await composeContext({
      cwd,
      projectRoot,
      maxBytes,
      enableImports,
      maxImportDepth,
    })

    signal?.throwIfAborted()
    if (composed.text.length === 0) return decision

    for (const warning of composed.warnings) ctx.logger?.warn?.(warning)

    const message = await createTextUserMessage(composed.text)

    // 走 inbox 注入而不是手改 decision.messages：
    // 后者绕过投递与日志语义，且与内置插件的去重逻辑冲突。
    agent.inbox.inject(message)
    injected.add(agent)

    return decision
  })
}

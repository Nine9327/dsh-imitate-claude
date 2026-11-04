/**
 * `/init` 命令：初始化项目级 `.dsh` 配置目录。
 *
 * 行为对齐 Claude Code 的 `/init`：
 *   - 创建目录骨架与 `DSH.md`；
 *   - 已存在时不覆盖（幂等），除非传 `--force`；
 *   - 生成完成后，把"分析仓库并补全 DSH.md"作为一轮 followup 交给 agent，
 *     让内容由模型根据真实代码写出来，而不是套模板。
 *
 * @module dsh-imitate-claude-command-init
 */

import { findProjectRoot, hasDshConfig } from '../core/discover.js'
import { isInstructionSkeleton, scaffoldProject } from '../core/scaffold.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 插件名。 */
export const name = 'imitate-claude-command-init'

/** 需要 `commands` 服务。 */
export const inject = ['commands']

/** 用法说明。 */
const USAGE = '用法：/init [--force]'

/**
 * 解析 `/init` 的参数。
 * @param {string} rawInput - 命令名之后的原始输入。
 * @returns {{ force: boolean, unknown: string[] }} 解析结果。
 */
function parseArgs(rawInput) {
  const tokens = rawInput.trim().split(/\s+/).filter(Boolean)
  const unknown = tokens.filter((token) => token !== '--force')
  return { force: tokens.includes('--force'), unknown }
}

/**
 * 构造交给模型的补全指令。
 *
 * 这里刻意要求模型**只补内容、不重建结构**，避免它覆盖刚建好的骨架。
 *
 * @param {string} projectRoot - 项目根（用于在提示里给出绝对路径）。
 * @returns {string} 提示文本。
 */
function buildCompletionPrompt(projectRoot) {
  return [
    '刚刚执行了 /init，项目中的 .dsh/DSH.md 目前是占位骨架（各章节下是 HTML 注释占位）。',
    '',
    '请分析这个仓库，把 .dsh/DSH.md 补全为一份真正有用的工作区指令文件：',
    '- 先读取真实文件（README、包清单、目录结构、构建与测试配置、CI 脚本）再动笔，不要臆测；',
    '- 保留文件已有的标题与章节结构，只替换注释占位处的内容；',
    '- 覆盖：项目用途、关键目录职责、构建/测试/代码风格约定、容易踩坑的地方；',
    '- 只写对后续会话有实际指导意义的约定，不要复述显而易见的目录树；',
    '- 命令必须来自项目的真实配置（如 package.json scripts），不要发明不存在的命令。',
    '',
    `项目根：${projectRoot}`,
    '',
    '若发现 .dsh/rules/ 下有需要拆分的主题，可以拆成独立规则文件；否则保持单文件即可。',
  ].join('\n')
}

/**
 * 注册命令。
 * @param {object} ctx - cordis 上下文。
 * @param {object} [config] - 插件配置（当前未使用，保留扩展位）。
 */
export function apply(ctx, config = {}) {
  void config

  ctx.commands.register({
    name: 'init',
    description: 'initialize a .dsh/ project configuration directory',
    input: { hint: '[--force]' },
    handler: (invocation) => {
      const { force, unknown } = parseArgs(invocation.rawInput ?? '')

      if (unknown.length > 0) {
        return {
          kind: 'error',
          text: `未知参数：${unknown.join(' ')}\n${USAGE}`,
        }
      }

      const cwd = invocation.agent?.session?.header?.cwd ?? process.cwd()
      const projectRoot = findProjectRoot(cwd)

      try {
        const alreadyExists = hasDshConfig(projectRoot)
        const result = scaffoldProject({ projectRoot, force })

        // 关键分支：项目里已有 .dsh/，但 DSH.md 仍是 /init 的占位骨架。
        // 此时用户需要的是"根据项目填写内容"，而不是重建结构——
        // 所以不覆盖文件，只触发模型补全。这正是已有项目跑 /init 的主场景。
        const instructionPath = join(projectRoot, '.dsh', 'DSH.md')
        let skeletonNeedsFilling = false
        if (result.skipped.some((path) => path.endsWith('DSH.md')) && !force) {
          try {
            skeletonNeedsFilling = isInstructionSkeleton(readFileSync(instructionPath, 'utf8'))
          } catch {
            skeletonNeedsFilling = false
          }
        }

        const lines = []
        if (alreadyExists && !force) {
          lines.push(`.dsh/ 已存在，未覆盖已有内容（如需重建请用 /init --force）。`)
        } else {
          lines.push(`已在 ${projectRoot} 初始化 .dsh/`)
        }

        if (result.created.length > 0) {
          lines.push('', '新建：', ...result.created.map((path) => `  ${path}`))
        }
        if (result.skipped.length > 0) {
          lines.push('', '已存在，跳过：', ...result.skipped.map((path) => `  ${path}`))
        }
        for (const warning of result.warnings) {
          lines.push('', `提示：${warning}`)
        }

        // 触发模型补全的两种情况：
        //   a. 本次新建了 DSH.md（骨架刚落地）；
        //   b. DSH.md 已存在但仍是未填写的骨架（已有项目跑 /init 的主场景）。
        // 已填写的文件永远不触发，避免覆盖用户内容和重复烧 token。
        const wroteInstruction = result.created.some((path) => path.endsWith('DSH.md'))
        if (wroteInstruction || skeletonNeedsFilling) {
          if (skeletonNeedsFilling) {
            lines.push('', '.dsh/DSH.md 仍是初始骨架，正在根据项目内容补全……')
          } else {
            lines.push('', '正在让模型补全 .dsh/DSH.md 的内容……')
          }
          invocation.agent.followup(
            createTextMessage(buildCompletionPrompt(projectRoot)),
          )
        }

        return { kind: 'success', text: lines.join('\n') }
      } catch (error) {
        return {
          kind: 'error',
          text: `/init 失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  })
}

/**
 * 构造一条纯文本用户消息。
 *
 * 与指令插件不同，这里的消息需要真正唤醒模型，所以用 followup 提交；
 * 结构上与 dsh 其它 user 消息保持一致。
 *
 * @param {string} text - 消息正文。
 * @returns {object} 消息对象。
 */
function createTextMessage(text) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

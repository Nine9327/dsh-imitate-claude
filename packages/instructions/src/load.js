/**
 * 指令文件发现层。
 *
 * 职责：在内置 `dsh-agent-instructions` 的发现能力之外，补上三件事：
 *   1. 支持 `.dsh/DSH.md` 这类**带子目录**的候选名（内置实现禁止路径分隔符）；
 *   2. 展开 `@path` 导入；
 *   3. 合并 `.dsh/rules` 与 `.claude/rules`。
 *
 * 设计取向：本模块只产出"已加载的文件列表"，渲染与预算交给内置的
 * `renderWorkspaceContext`（公开导出），从而避免 fork 整套 53KB 逻辑。
 *
 * @module dsh-claude-compat/instructions
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

import {
  collectRules,
  expandImports,
  INSTRUCTION_CANDIDATES,
  renderRules,
  RULES_DIRS,
} from 'dsh-claude-compat-core'

/**
 * 把一个绝对路径转成用于展示的、相对项目根的路径（始终用 `/`）。
 * @param {string} projectRoot - 项目根。
 * @param {string} absolutePath - 绝对路径。
 * @returns {string} 展示路径。
 */
function toDisplayPath(projectRoot, absolutePath) {
  const rel = relative(projectRoot, absolutePath)
  return rel.split(sep).join('/')
}

/**
 * 枚举从项目根到 cwd 的目录链（由宽到具体）。
 * @param {string} projectRoot - 项目根。
 * @param {string} cwd - 会话工作目录。
 * @returns {string[]} 目录绝对路径，broad → specific。
 */
function ancestorChain(projectRoot, cwd) {
  const rootAbs = resolve(projectRoot)
  const cwdAbs = resolve(cwd)
  const chain = []
  let current = cwdAbs

  for (;;) {
    chain.push(current)
    if (current === rootAbs) break
    const parent = dirname(current)
    // cwd 不在 root 之下时，只返回 cwd 自身，避免无限回溯。
    if (parent === current) return [cwdAbs]
    current = parent
    // 防御：cwd 与 root 无包含关系时退化为只用 cwd。
    if (chain.length > 64) return [cwdAbs]
  }

  return chain.reverse()
}

/**
 * 读取单个候选文件；不可读或不是文件时返回 undefined。
 * @param {string} absolutePath - 绝对路径。
 * @param {number} maxSourceBytes - 单文件字节上限。
 * @returns {string | undefined} 文件内容。
 */
function readCandidate(absolutePath, maxSourceBytes) {
  try {
    const info = statSync(absolutePath)
    if (!info.isFile()) return undefined
    if (info.size > maxSourceBytes) return undefined
    return readFileSync(absolutePath, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 发现并加载项目内的指令文件。
 *
 * 去重规则（与内置实现保持一致的语义，但不依赖其内部状态）：
 *   - **同一目录内**，候选按 {@link INSTRUCTION_CANDIDATES} 顺序尝试，
 *     第一个存在于某个"槽位"的候选胜出；内容 trim 后重复的后续候选被丢弃。
 *   - 规则文件作为独立段附加在最后，标注来源。
 *
 * @param {object} options - 发现选项。
 * @param {string} options.projectRoot - 项目根绝对路径。
 * @param {string} options.cwd - 会话工作目录。
 * @param {number} [options.maxSourceBytes=1048576] - 单文件字节上限。
 * @param {boolean} [options.enableImports=true] - 是否展开 `@path`。
 * @param {number} [options.maxImportDepth=5] - 导入递归上限。
 * @param {readonly string[]} [options.candidates] - 覆盖内置候选顺序。
 * @param {readonly string[]} [options.rulesDirs] - 覆盖规则目录顺序。
 * @returns {{ files: Array<{ absolutePath: string, displayPath: string, content: string }>, warnings: string[], imported: string[] }}
 *   `files` 按 broad → specific 排序，可直接交给渲染器。
 */
export function loadInstructions(options) {
  const {
    projectRoot,
    cwd,
    maxSourceBytes = 1024 * 1024,
    enableImports = true,
    maxImportDepth = 5,
    candidates = INSTRUCTION_CANDIDATES,
    rulesDirs = RULES_DIRS,
  } = options

  const warnings = []
  const imported = []
  const files = []

  // 内容去重用的集合：trim 后的文本。
  const seenContent = new Set()

  for (const dir of ancestorChain(projectRoot, cwd)) {
    for (const candidate of candidates) {
      const absolutePath = join(dir, candidate)
      if (!existsSync(absolutePath)) continue

      const raw = readCandidate(absolutePath, maxSourceBytes)
      if (raw === undefined) {
        warnings.push(`skipped unreadable or oversized instruction file: ${candidate}`)
        continue
      }

      const expanded = expandImports({
        path: absolutePath,
        content: raw,
        enabled: enableImports,
        maxDepth: maxImportDepth,
        maxBytes: maxSourceBytes,
      })
      warnings.push(...expanded.warnings)
      imported.push(...expanded.imported)

      const key = expanded.content.trim()
      if (seenContent.has(key)) {
        // 同目录或跨目录的完全重复内容只保留第一份，避免重复注入。
        continue
      }
      seenContent.add(key)

      files.push({
        absolutePath,
        displayPath: toDisplayPath(projectRoot, absolutePath),
        content: expanded.content,
      })
    }

    // 规则文件跟随其所属目录注入，保证"越具体越靠后"的优先级。
    const { files: ruleFiles, warnings: ruleWarnings } = collectRules({
      projectRoot: dir,
      dirs: rulesDirs,
    })
    warnings.push(...ruleWarnings)

    const rendered = renderRules(ruleFiles)
    if (rendered.length > 0 && !seenContent.has(rendered.trim())) {
      seenContent.add(rendered.trim())
      const dirDisplay = toDisplayPath(projectRoot, dir)
      // 项目根目录显示为 `.`，其余保持相对路径，避免出现 `./.dsh/rules` 这类噪声。
      const prefix = dirDisplay.length === 0 ? '' : `${dirDisplay}/`
      files.push({
        absolutePath: join(dir, 'rules'),
        displayPath: `${prefix}${rulesDirs[0]}`,
        content: rendered,
      })
    }
  }

  return { files, warnings, imported }
}

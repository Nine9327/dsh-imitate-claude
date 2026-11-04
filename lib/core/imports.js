/**
 * `@path` 导入展开。
 *
 * 语法（对齐 Claude Code）：
 *   - 行首（允许前置空白）以 `@` 开头的行视为导入；
 *   - 相对路径相对**当前文件所在目录**解析；
 *   - `~/` 开头展开到用户 home。
 *
 * 容错策略：缺失文件或读取失败**不抛错**，保留原始字面量并在末尾追加一行提示，
 * 因为指令文件是用户手写的，一个坏导入不应该让整个上下文加载失败。
 *
 * @module dsh-claude-compat/imports
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'

/**
 * 匹配整行的导入指令。
 *
 * - 组 1：前导空白（保留用于缩进）；
 * - 组 2：路径部分（不含行尾注释）。
 */
const IMPORT_LINE = /^([ \t]*)@([^\s#]+)\s*$/

/**
 * 把导入路径解析为绝对路径。
 * @param {string} spec - 导入语句里的原始路径。
 * @param {string} baseDir - 当前文件所在目录。
 * @returns {string} 绝对路径。
 */
function resolveSpec(spec, baseDir) {
  if (spec === '~') return homedir()
  if (spec.startsWith('~/') || spec.startsWith('~\\')) {
    return resolve(homedir(), spec.slice(2))
  }
  if (isAbsolute(spec)) return resolve(spec)
  return resolve(baseDir, spec)
}

/**
 * 展开一个指令文件里的全部 `@path` 导入。
 *
 * @param {object} options - 展开选项。
 * @param {string} options.path - 当前文件的绝对路径。
 * @param {string} [options.content] - 已读到的内容；省略时按需从磁盘读取。
 * @param {boolean} [options.enabled=true] - 关闭时原样返回内容。
 * @param {number} [options.maxDepth=5] - 最大递归深度。
 * @param {number} [options.maxBytes=65536] - 单文件展开后的字节上限，防止极端放大。
 * @param {Set<string>} [options._stack] - 内部使用的环检测栈。
 * @returns {{ content: string, warnings: string[], imported: string[] }} 展开结果。
 */
export function expandImports(options) {
  const {
    path,
    content,
    enabled = true,
    maxDepth = 5,
    maxBytes = 65536,
    _stack = new Set(),
  } = options

  const result = { content: content ?? '', warnings: [], imported: [] }
  if (!enabled) return result

  let source
  if (content !== undefined) {
    source = content
  } else {
    try {
      source = readFileSync(path, 'utf8')
    } catch (error) {
      result.warnings.push(`cannot read ${path}: ${error.message}`)
      return result
    }
  }

  const baseDir = dirname(path)
  const lines = source.split(/\r?\n/)
  const out = []

  for (const line of lines) {
    const match = IMPORT_LINE.exec(line)
    if (match === null) {
      out.push(line)
      continue
    }

    const [, indent, spec] = match
    const target = resolveSpec(spec, baseDir)

    // 环检测：同一条链上重复出现即跳过。
    if (_stack.has(target) || target === path) {
      result.warnings.push(`circular import skipped: ${spec} (${target})`)
      out.push(`${indent}<!-- circular import skipped: ${spec} -->`)
      continue
    }

    if (maxDepth <= 0) {
      result.warnings.push(`max import depth reached, skipped: ${spec}`)
      out.push(`${indent}<!-- import depth limit reached: ${spec} -->`)
      continue
    }

    let nested
    try {
      nested = readFileSync(target, 'utf8')
    } catch (error) {
      // 缺失文件不致命：保留字面量 + 提示。
      result.warnings.push(`missing import: ${spec} (${error.code ?? error.message})`)
      out.push(`${indent}<!-- missing import: ${spec} -->`)
      continue
    }

    const expanded = expandImports({
      path: target,
      content: nested,
      enabled,
      maxDepth: maxDepth - 1,
      maxBytes,
      _stack: new Set([..._stack, target]),
    })

    result.warnings.push(...expanded.warnings)
    result.imported.push(target, ...expanded.imported)

    // 保留缩进，便于嵌套内容在列表里仍可读。
    const body = expanded.content
      .split(/\r?\n/)
      .map((inner) => (inner.length === 0 ? inner : `${indent}${inner}`))
      .join('\n')
    out.push(body)
  }

  result.content = out.join('\n')

  // 防御性上限：极端嵌套可能放大内容，截断并告警。
  const bytes = Buffer.byteLength(result.content, 'utf8')
  if (bytes > maxBytes) {
    result.warnings.push(
      `expanded content of ${path} exceeded ${maxBytes} bytes (${bytes}); truncated`,
    )
    result.content = Buffer.from(result.content, 'utf8').subarray(0, maxBytes).toString('utf8')
  }

  return result
}

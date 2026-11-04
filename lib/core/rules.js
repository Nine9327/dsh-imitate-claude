/**
 * `.dsh/rules` 与 `.claude/rules` 的模块化规则收集。
 *
 * 规则：目录按优先级排序，同名文件取高优先级的；每个目录内按文件名字典序拼接，
 * 保证注入顺序确定（不依赖 readdir 的返回顺序）。
 *
 * @module dsh-imitate-claude/rules
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import { RULES_DIRS } from './naming.js'

/**
 * 收集项目内的规则文件。
 *
 * @param {object} options - 收集选项。
 * @param {string} options.projectRoot - 项目根绝对路径。
 * @param {readonly string[]} [options.dirs=RULES_DIRS] - 规则目录（相对项目根），顺序即优先级。
 * @returns {{ files: Array<{ path: string, displayPath: string, content: string }>, warnings: string[] }}
 */
export function collectRules(options) {
  const { projectRoot, dirs = RULES_DIRS } = options
  const seen = new Set()
  const files = []
  const warnings = []

  for (const dir of dirs) {
    const absoluteDir = join(projectRoot, dir)
    if (!existsSync(absoluteDir)) continue

    let entries
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true })
    } catch (error) {
      warnings.push(`cannot read rules directory ${dir}: ${error.message}`)
      continue
    }

    // 显式排序，避免依赖文件系统返回顺序。
    const names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort()

    for (const name of names) {
      // 同名规则只取优先级最高的那一份。
      if (seen.has(name)) continue
      seen.add(name)

      const absolutePath = join(absoluteDir, name)
      try {
        files.push({
          path: absolutePath,
          displayPath: `${dir}/${name}`,
          content: readFileSync(absolutePath, 'utf8'),
        })
      } catch (error) {
        warnings.push(`cannot read rule ${dir}/${name}: ${error.message}`)
      }
    }
  }

  return { files, warnings }
}

/**
 * 把规则文件渲染成一段可注入的 markdown。
 *
 * @param {Array<{ displayPath: string, content: string }>} files - 规则文件列表。
 * @returns {string} 渲染后的文本；无规则时返回空串。
 */
export function renderRules(files) {
  if (files.length === 0) return ''
  const sections = files.map(
    (file) => `<!-- rule: ${basename(file.displayPath)} -->\n${file.content.trim()}`,
  )
  return sections.join('\n\n')
}

/**
 * 一次性改名脚本：dsh-claude-compat → dsh-imitate-claude。
 *
 * 用精确的字符串映射表而不是正则泛替换，避免误伤：
 *   - `claude-compat` 子串出现在包名、行 id、preset 目录名里，映射不同；
 *   - README 里 "Claude Code" 是对标对象的正常提法，不应改动。
 *
 * 运行：node scripts/rename.mjs [--dry]
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const dry = process.argv.includes('--dry')

/**
 * 需要扫描的文件扩展名。
 */
const EXTS = new Set(['.js', '.mjs', '.json', '.yml', '.yaml', '.md', '.ps1'])

/**
 * 跳过的目录。
 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'lib', '.dev-home', '.verify-home', '.pnpm-store'])

/**
 * 跳过自身与锁文件：前者含映射表字面量，后者由 pnpm 重建。
 */
const SKIP_FILES = new Set(['rename.mjs', 'pnpm-lock.yaml'])

/**
 * 精确替换表。**顺序重要**：先长的、具体的，再短的、泛的。
 */
const REPLACEMENTS = [
  // 子包名
  ['dsh-claude-compat-instructions', 'dsh-imitate-claude-instructions'],
  ['dsh-claude-compat-command-init', 'dsh-imitate-claude-command-init'],
  ['dsh-claude-compat-core', 'dsh-imitate-claude-core'],
  ['dsh-claude-compat-cli', 'dsh-imitate-claude-cli'],
  ['dsh-claude-compat-repo', 'dsh-imitate-claude'],
  // 插件行 id（cordis patch 里的 id）
  ['claude-compat-command-init', 'imitate-claude-command-init'],
  ['claude-compat-instructions', 'imitate-claude-instructions'],
  // 顶层包名与 preset 目录标识
  ['dsh-claude-compat', 'dsh-imitate-claude'],
  ['GENERATED_PRESET_ID = \'dsh-compat\'', "GENERATED_PRESET_ID = 'imitate-claude'"],
]

/**
 * 递归收集目标文件。
 * @param {string} dir
 * @param {string[]} out
 * @returns {string[]}
 */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const info = statSync(full)
    if (info.isDirectory()) collect(full, out)
    else if (EXTS.has(name.slice(name.lastIndexOf('.'))) && !SKIP_FILES.has(name)) out.push(full)
  }
  return out
}

const files = collect(repoRoot)
let changed = 0
const report = []

for (const file of files) {
  const before = readFileSync(file, 'utf8')
  let after = before
  for (const [from, to] of REPLACEMENTS) {
    after = after.split(from).join(to)
  }
  if (after === before) continue

  changed += 1
  if (!dry) writeFileSync(file, after, 'utf8')
  report.push(relative(repoRoot, file))
}

process.stdout.write(`${dry ? '[dry run] ' : ''}修改文件数：${changed}\n`)
for (const file of report.sort()) process.stdout.write(`  ${file}\n`)

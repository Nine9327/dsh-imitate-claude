/**
 * 项目根探测与路径安全断言。
 *
 * 所有写操作都必须先过 {@link assertInsideRoot}，这是防目录逃逸的单点收口。
 *
 * @module dsh-claude-compat/discover
 */

import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { PROJECT_ROOT_MARKERS } from './naming.js'

/**
 * 判断某个路径是否存在且是目录。
 * @param {string} path - 待检查路径。
 * @returns {boolean}
 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 从起始目录向上查找项目根。
 *
 * 规则：第一个含有任意 marker（默认 `.git`）的祖先目录即为根；
 * 一直找不到则退化为起始目录本身（与 dsh 内置插件行为一致）。
 *
 * 注意：这里用 `existsSync` 而非 stat 判断 marker，与内置实现保持一样的"存在即命中"语义，
 * 因为 `.git` 在 worktree 中可能是文件而不是目录。
 *
 * @param {string} startDir - 起始目录（通常是会话工作区）。
 * @param {readonly string[]} [markers] - 根标记名列表。
 * @returns {string} 项目根的绝对路径。
 */
export function findProjectRoot(startDir, markers = PROJECT_ROOT_MARKERS) {
  let current = resolve(startDir)
  for (;;) {
    for (const marker of markers) {
      if (existsSync(join(current, marker))) return current
    }
    const parent = dirname(current)
    if (parent === current) return resolve(startDir)
    current = parent
  }
}

/**
 * 断言 `target` 位于 `root` 之内（含 root 自身）。
 *
 * 这是防目录逃逸的唯一收口点：`/init` 等一切写操作都必须先调用它。
 *
 * 实现要点：不能用字符串 `startsWith`，因为 `D:\a` 会错误匹配 `D:\ab`。
 * 这里用 `relative()` 并显式拒绝 `..` 与绝对路径。
 *
 * @param {string} root - 项目根绝对路径。
 * @param {string} target - 待校验的目标绝对路径。
 * @returns {string} 规范化后的 target 绝对路径。
 * @throws {Error} 当 target 逃逸出 root 时。
 */
export function assertInsideRoot(root, target) {
  const rootAbs = resolve(root)
  const targetAbs = resolve(target)
  if (targetAbs === rootAbs) return targetAbs
  const rel = relative(rootAbs, targetAbs)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(
      `dsh-claude-compat: refusing to write outside the project root (${rootAbs}): ${targetAbs}`,
    )
  }
  return targetAbs
}

/**
 * 判断一个已有目录是否看起来已经初始化过 `.dsh`。
 * @param {string} projectRoot - 项目根。
 * @returns {boolean}
 */
export function hasDshConfig(projectRoot) {
  return isDirectory(join(projectRoot, '.dsh'))
}

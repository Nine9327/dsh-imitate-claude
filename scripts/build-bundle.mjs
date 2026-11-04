/**
 * 把各包源码组装成单一可安装包 `packages/bundle`。
 *
 * 为什么需要这一步：dshmarket 与 `dsh plugin add` 都期望**一个包**
 * 自带 `cordis.patch.yml` 与 `lib/`，而不是依赖 pnpm workspace 的
 * `workspace:*` 链接——profile 目录里没有 workspace 拓扑。
 *
 * 做法是机械的路径改写（包名 → 相对路径），不引入打包器，
 * 保持产物可读、可审查。
 *
 * 运行：node scripts/build-bundle.mjs
 */

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
// 输出到仓库根的 lib/：仓库根**就是**可安装的插件包，
// 这样 `pnpm add <git url>` 装到的才是带 dsh.bundle.patch 的包本身。
const outLib = join(repoRoot, 'lib')

/** 源包 → 产物子目录。 */
const SOURCES = [
  { from: join(repoRoot, 'packages', 'core', 'src'), to: join(outLib, 'core') },
  { from: join(repoRoot, 'packages', 'instructions', 'src'), to: join(outLib, 'instructions') },
  { from: join(repoRoot, 'packages', 'command-init', 'src'), to: join(outLib, 'command-init') },
]

/** 需要改写的模块引用。 */
const REWRITES = [
  // core 的入口被其它层引用
  { pattern: /from 'dsh-claude-compat-core'/g, replace: (depth) => `from '${'../'.repeat(depth)}core/index.js'` },
  // 旧的跨包相对路径（源码里曾有一版）
  { pattern: /from '\.\.\/\.\.\/core\/src\/([a-z]+\.js)'/g, replace: (_depth, file) => `from '../core/${file}'` },
]

/**
 * 计算某个文件到 lib 根需要退几层。
 * @param {string} filePath - 产物文件绝对路径。
 * @returns {number} 层级数。
 */
function depthFromLib(filePath) {
  const rel = filePath.slice(outLib.length + 1)
  return rel.split(/[\\/]/).length - 1
}

/** 包入口内容：只做能力再导出。 */
const PACKAGE_ENTRY = `/**
 * \`dsh-claude-compat\` 包入口。
 *
 * 本包是一个 **bundle**：真正被 dsh 挂载的是 \`cordis.patch.yml\` 里声明的两行
 * （\`/instructions\` 与 \`/command-init\`），而不是这个文件。
 * 这里只做能力再导出，方便外部按包名引用核心工具函数。
 *
 * @module dsh-claude-compat
 */

export {
  assertInsideRoot,
  buildPresetText,
  collectRules,
  CONFIG_DIR,
  expandImports,
  findProjectRoot,
  GENERATED_PRESET_ID,
  generatePreset,
  hasDshConfig,
  INIT_DIRECTORIES,
  INSTRUCTION_CANDIDATES,
  PRIMARY_INSTRUCTION,
  renderRules,
  resolveSourcePreset,
  scaffoldProject,
} from './core/index.js'
`

/** 主流程。 */
function build() {
  rmSync(outLib, { recursive: true, force: true })

  for (const { from, to } of SOURCES) {
    mkdirSync(to, { recursive: true })
    for (const entry of readdirSync(from)) {
      if (!entry.endsWith('.js')) continue
      cpSync(join(from, entry), join(to, entry))
    }
  }

  // 逐文件改写引用。
  for (const { to } of SOURCES) {
    for (const entry of readdirSync(to)) {
      if (!entry.endsWith('.js')) continue
      const filePath = join(to, entry)
      const depth = depthFromLib(filePath)
      let text = readFileSync(filePath, 'utf8')

      for (const { pattern, replace } of REWRITES) {
        text = text.replace(pattern, (...args) => replace(depth, ...args.slice(1)))
      }

      writeFileSync(filePath, text, 'utf8')
    }
  }

  writeFileSync(join(outLib, 'index.js'), PACKAGE_ENTRY, 'utf8')

  // 产物清单，便于人工核对。
  const files = ['index.js']
  for (const { to } of SOURCES) {
    for (const entry of readdirSync(to)) {
      if (entry.endsWith('.js')) files.push(join(to, entry).slice(outLib.length + 1))
    }
  }
  process.stdout.write(`bundle built: ${files.length} files\n`)
  for (const file of files.sort()) process.stdout.write(`  lib/${file}\n`)
}

build()

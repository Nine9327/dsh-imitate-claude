/**
 * 从当前安装的 `standard` preset 生成定制 preset。
 *
 * 背景：web 界面把指令加载器放在 agent preset 里，而且 preset 是**整份
 * composition**、没有 patch 叠加机制。手抄 254 行会随上游版本漂移，
 * 所以这里做"读取 → 定点替换 → 落盘"的生成式方案。
 *
 * 上游升级后重跑一次即可，不需要人工比对。
 *
 * @module dsh-claude-compat/preset
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 生成的 preset 目录名（放在 `<dshHome>/.agent-presets/` 下）。 */
export const GENERATED_PRESET_ID = 'dsh-compat'

/** 需要被替换掉的插件行 id。 */
const REPLACED_ROW_ID = 'agent-instructions'

/**
 * 定位当前安装的 standard preset 的 composition 文件。
 *
 * 优先用显式传入的路径；否则尝试从本模块所在位置沿 node_modules 向上找。
 *
 * @param {string} [explicitPath] - 调用方指定的 agent.cordis.yml 路径。
 * @returns {string} 找到的绝对路径。
 * @throws {Error} 找不到时抛错，并给出可操作的提示。
 */
export function resolveSourcePreset(explicitPath) {
  if (explicitPath !== undefined) {
    if (!existsSync(explicitPath)) {
      throw new Error(`dsh-claude-compat: source preset not found: ${explicitPath}`)
    }
    return explicitPath
  }

  /** 相对某个基准目录枚举可能的标准 preset 位置。 */
  const candidatesUnder = (base) => [
    // npm 全局安装：<node_modules>/@deepseek-ai/dsh/node_modules/@deepseek-ai/...
    join(
      base,
      'node_modules', '@deepseek-ai', 'dsh',
      'node_modules', '@deepseek-ai', 'dsh-agent-presets',
      'presets', 'standard', 'agent.cordis.yml',
    ),
    // 提升安装（hoisted）：两个包是兄弟
    join(base, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml'),
    // 直接就是 dsh-agent-presets 的安装目录
    join(base, 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml'),
  ]

  // 从本模块位置向上逐级探测：兼容源码运行、bundle 装在 profile、装在 dsh 树内。
  let current = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 10; depth += 1) {
    for (const candidate of candidatesUnder(current)) {
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  // 以 node 可执行文件为锚点：npm 全局包就在它同级的 node_modules 下。
  // 这比 PATH 可靠——dsh 由桌面端或服务启动时，PATH 常常不含 node 目录。
  const nodeDir = dirname(process.execPath)
  for (const base of [nodeDir, process.env.APPDATA ? join(process.env.APPDATA, 'npm') : undefined]) {
    if (base === undefined) continue
    for (const candidate of candidatesUnder(base)) {
      if (existsSync(candidate)) return candidate
    }
  }

  // 最后尝试 PATH 上的各目录（某些安装把 npm 全局前缀挂进 PATH）。
  const pathEntries = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  for (const entry of pathEntries) {
    if (entry.length === 0) continue
    for (const candidate of candidatesUnder(dirname(entry))) {
      if (existsSync(candidate)) return candidate
    }
  }

  throw new Error(
    'dsh-claude-compat: cannot locate the installed standard agent preset. ' +
      'Pass an explicit path to agent.cordis.yml.',
  )
}

/**
 * 在文本中定位一个顶层行的索引范围。
 *
 * 只识别 **顶层**（列 0）的 `- id: xxx`，因此不会误伤 group 内部同名的行。
 *
 * 区间语义至关重要：`end` 停在**下一个顶层行**处，但要把紧邻的注释块
 * 与空行留在区间之外——否则替换会把下一节的小标题和说明一并吞掉。
 * 这里采取保守策略：从目标行起，先把属于该行的 `name` / `config` 等
 * 缩进行与空行收进区间，遇到注释行即停止。
 *
 * @param {string[]} lines - 文件行数组。
 * @param {string} rowId - 目标行 id。
 * @returns {{ start: number, end: number } | undefined} 行范围（end 为下一行起点）。
 */
function findTopLevelRow(lines, rowId) {
  const startPattern = new RegExp(`^- id: ${rowId}$`)
  let start = -1

  for (let index = 0; index < lines.length; index += 1) {
    if (startPattern.test(lines[index])) {
      start = index
      break
    }
  }
  if (start === -1) return undefined

  let end = start + 1
  let lastContent = start

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]

    // 下一节的顶层行或注释块开始了：就地结束，不吞并它们。
    if (/^- (id|insert|group):/.test(line)) break
    if (line.startsWith('#')) break

    if (line.trim().length === 0) {
      end = index + 1
      continue
    }
    // 缩进行属于当前行（name/config/子键）。
    lastContent = index
    end = index + 1
    void lastContent
  }

  return { start, end }
}

/**
 * 生成定制 preset 的 composition 内容。
 *
 * 改动是**定点**的：把 `agent-instructions` 行换成我们的实现，
 * 其余所有行原样保留，从而最大限度降低与上游的差异面。
 *
 * @param {object} options - 生成选项。
 * @param {string} options.sourceText - 源 composition 的完整文本。
 * @param {number} [options.maxBytes=65536] - 传给指令插件的预算。
 * @param {string} [options.pluginSpecifier] - 指令插件的模块名。
 * @param {string} [options.commandSpecifier] - `/init` 插件的模块名。
 * @returns {{ text: string, changed: boolean, reason?: string }} 生成结果。
 */
export function buildPresetText(options) {
  const {
    sourceText,
    maxBytes = 65536,
    // 指向安装后的 bundle 子路径：preset 在 profile 里解析模块，
    // 用包名比用绝对路径稳定，包被移动或重装都不用重新生成。
    pluginSpecifier = 'dsh-claude-compat/instructions',
    commandSpecifier = 'dsh-claude-compat/command-init',
  } = options

  const lines = sourceText.split(/\r?\n/)
  const range = findTopLevelRow(lines, REPLACED_ROW_ID)

  if (range === undefined) {
    return {
      text: sourceText,
      changed: false,
      reason: `top-level row "${REPLACED_ROW_ID}" not found in source preset`,
    }
  }

  const replacement = [
    '# Replaced by dsh-claude-compat: loads .dsh/DSH.md, @import chains, and rules dirs.',
    `- id: ${REPLACED_ROW_ID}`,
    `  name: '${pluginSpecifier}'`,
    '  config:',
    `    maxBytes: ${maxBytes}`,
    '    enableImports: true',
    '    maxImportDepth: 5',
    '',
    '# Project-level /init for .dsh/ (Claude Code parity).',
    '- id: claude-compat-command-init',
    `  name: '${commandSpecifier}'`,
  ]

  const next = [
    ...lines.slice(0, range.start),
    ...replacement,
    ...lines.slice(range.end),
  ]

  return { text: next.join('\n'), changed: true }
}

/**
 * 生成 preset 目录到 `<dshHome>/.agent-presets/<id>/`。
 *
 * @param {object} options - 生成选项。
 * @param {string} options.dshHome - DSH home 目录。
 * @param {string} [options.sourcePath] - 显式指定源 preset 路径。
 * @param {number} [options.maxBytes=65536] - 预算。
 * @param {string} [options.presetId=GENERATED_PRESET_ID] - 目标 preset id。
 * @param {boolean} [options.force=false] - 已存在时是否覆盖。
 * @returns {{ outDir: string, compositionPath: string, metadataPath: string, sourcePath: string, changed: boolean }}
 */
export function generatePreset(options) {
  const {
    dshHome,
    sourcePath,
    maxBytes = 65536,
    presetId = GENERATED_PRESET_ID,
    force = false,
  } = options

  const resolvedSource = resolveSourcePreset(sourcePath)
  const sourceText = readFileSync(resolvedSource, 'utf8')

  const built = buildPresetText({ sourceText, maxBytes })
  if (!built.changed) {
    throw new Error(`dsh-claude-compat: ${built.reason ?? 'preset generation produced no change'}`)
  }

  const outDir = join(dshHome, '.agent-presets', presetId)
  const compositionPath = join(outDir, 'agent.cordis.yml')
  const metadataPath = join(outDir, 'preset.yml')

  if (existsSync(compositionPath) && !force) {
    throw new Error(
      `dsh-claude-compat: preset already exists at ${compositionPath}; pass --force to overwrite`,
    )
  }

  mkdirSync(outDir, { recursive: true })
  writeFileSync(compositionPath, built.text, 'utf8')

  // 元数据只影响展示名；没有它 preset 也能挂载。
  if (!existsSync(metadataPath) || force) {
    writeFileSync(
      metadataPath,
      [
        'name: 兼容模式',
        'description: 在 standard 模式基础上支持项目级 .dsh 指令（DSH.md、@import、rules）。',
        'order: 90',
        '',
      ].join('\n'),
      'utf8',
    )
  }

  return {
    outDir,
    compositionPath,
    metadataPath,
    sourcePath: resolvedSource,
    changed: true,
  }
}

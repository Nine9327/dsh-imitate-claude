/**
 * `/init` 的脚手架生成。
 *
 * 只负责"创建目录结构 + 写入 DSH.md 骨架"，不负责模型分析内容。
 * 所有写入前都过 {@link assertInsideRoot}。
 *
 * @module dsh-claude-compat/scaffold
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { assertInsideRoot } from './discover.js'
import {
  CONFIG_DIR,
  INIT_DIRECTORIES,
  INIT_PLACEHOLDERS,
  LOCAL_INSTRUCTION,
  PRIMARY_INSTRUCTION,
  SETTINGS_FILE,
} from './naming.js'

/**
 * 生成 `DSH.md` 的初始骨架。
 *
 * 这里刻意保持"薄骨架"：项目结构分析由模型在 `/init` 触发的一轮里补全，
 * 而不是用模板糊弄出一份看似专业的假内容。
 *
 * @param {object} options - 生成选项。
 * @param {string} options.projectName - 项目名（用于标题）。
 * @returns {string} markdown 文本。
 */
export function renderInstructionSkeleton({ projectName }) {
  return `# ${projectName}

<!--
这是项目的 dsh 工作区指令文件（对应 Claude Code 的 CLAUDE.md）。
保留你希望每个会话都遵守的约定；更具体的规则放到 ${CONFIG_DIR}/rules/ 下。
-->

## 项目概览

<!-- 由 /init 生成后补充：项目用途、主要模块、技术栈 -->

## 目录结构

<!-- 关键目录及其职责 -->

## 开发约定

<!-- 构建、测试、代码风格等 -->

## 注意事项

<!-- 容易踩坑的地方 -->
`
}

/**
 * 生成 `settings.yml` 的初始内容。
 * @returns {string} YAML 文本。
 */
export function renderSettingsSkeleton() {
  return `# 项目级 dsh 设置（对应 Claude Code 的 .claude/settings.json）
# 当前为最小占位，按需补充。
{}
`
}

/**
 * 初始化 `.dsh` 项目配置。
 *
 * 语义与 Claude 的 `/init` 对齐：已存在时不覆盖，除非显式 `force`。
 *
 * @param {object} options - 初始化选项。
 * @param {string} options.projectRoot - 项目根绝对路径。
 * @param {boolean} [options.force=false] - 是否覆盖已存在的文件。
 * @returns {{ created: string[], skipped: string[], warnings: string[] }} 操作结果。
 */
export function scaffoldProject({ projectRoot, force = false }) {
  const created = []
  const skipped = []
  const warnings = []

  // 目录创建。
  for (const dir of INIT_DIRECTORIES) {
    const absolute = assertInsideRoot(projectRoot, join(projectRoot, dir))
    if (existsSync(absolute)) {
      skipped.push(dir)
      continue
    }
    mkdirSync(absolute, { recursive: true })
    created.push(`${dir}/`)
  }

  // 占位文件（.gitkeep）：空目录进不了 git。
  for (const file of INIT_PLACEHOLDERS) {
    const absolute = assertInsideRoot(projectRoot, join(projectRoot, file))
    if (existsSync(absolute) && !force) {
      skipped.push(file)
      continue
    }
    writeFileSync(absolute, '', 'utf8')
    created.push(file)
  }

  // 主指令文件：默认放 .dsh/DSH.md（推荐布局）。
  const instructionPath = `${CONFIG_DIR}/${PRIMARY_INSTRUCTION}`
  const absoluteInstruction = assertInsideRoot(projectRoot, join(projectRoot, instructionPath))
  if (existsSync(absoluteInstruction) && !force) {
    skipped.push(instructionPath)
  } else {
    writeFileSync(
      absoluteInstruction,
      renderInstructionSkeleton({ projectName: basename(projectRoot) }),
      'utf8',
    )
    created.push(instructionPath)
  }

  // 设置文件。
  const settingsPath = `${CONFIG_DIR}/${SETTINGS_FILE}`
  const absoluteSettings = assertInsideRoot(projectRoot, join(projectRoot, settingsPath))
  if (existsSync(absoluteSettings) && !force) {
    skipped.push(settingsPath)
  } else {
    writeFileSync(absoluteSettings, renderSettingsSkeleton(), 'utf8')
    created.push(settingsPath)
  }

  // 提示用户：若已有 Claude 布局，说明兼容关系而不是静默忽略。
  if (existsSync(join(projectRoot, 'CLAUDE.md'))) {
    warnings.push(
      '发现项目根已有 CLAUDE.md：它仍会被读取，但优先级低于 DSH.md；如需统一命名可自行迁移。',
    )
  }
  if (existsSync(join(projectRoot, '.claude'))) {
    warnings.push(
      '发现已有 .claude/ 目录：其 rules 会被只读兼容读取，本插件不会修改其中任何文件。',
    )
  }

  void LOCAL_INSTRUCTION
  return { created, skipped, warnings }
}

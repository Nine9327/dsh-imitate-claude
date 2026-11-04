#!/usr/bin/env node
/**
 * `dsh-imitate-claude` 命令行。
 *
 * 目前只有一个子命令：`sync-preset` —— 从当前安装的 standard preset
 * 生成带 .dsh 指令支持的 agent preset。上游升级后重跑即可。
 *
 * @module dsh-imitate-claude/cli
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { generatePreset, GENERATED_PRESET_ID } from 'dsh-imitate-claude-core'

const USAGE = [
  'dsh-imitate-claude — 让 dsh 支持项目级 .dsh 约定',
  '',
  '用法：',
  '  dsh-imitate-claude sync-preset [选项]',
  '',
  '选项：',
  '  --dsh-home <path>    DSH home 目录（默认 $DSH_HOME 或 ~/.dsh）',
  '  --source <path>      standard preset 的 agent.cordis.yml 路径（默认自动探测）',
  '  --max-bytes <n>      注入预算（默认 65536）',
  '  --force              覆盖已生成的 preset',
  '  -h, --help           显示帮助',
  '',
].join('\n')

/**
 * 解析形如 `--key value` / `--flag` 的简单参数。
 * @param {string[]} argv - 参数数组。
 * @returns {Record<string, string | boolean>} 解析结果。
 */
function parseFlags(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      index += 1
    } else {
      flags[key] = true
    }
  }
  return flags
}

/**
 * 解析 DSH home。
 * @param {string | undefined} explicit - 显式传入的值。
 * @returns {string} 绝对路径。
 */
function resolveDshHome(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * 执行 sync-preset。
 * @param {Record<string, string | boolean>} flags - 解析后的参数。
 * @returns {number} 退出码。
 */
function runSyncPreset(flags) {
  const dshHome = resolveDshHome(
    typeof flags['dsh-home'] === 'string' ? flags['dsh-home'] : undefined,
  )
  const sourcePath = typeof flags.source === 'string' ? flags.source : undefined
  const rawMax = typeof flags['max-bytes'] === 'string' ? Number(flags['max-bytes']) : undefined
  const force = flags.force === true

  if (rawMax !== undefined && (!Number.isFinite(rawMax) || rawMax <= 0)) {
    process.stderr.write('dsh-imitate-claude: --max-bytes must be a positive number\n')
    return 2
  }

  try {
    const result = generatePreset({ dshHome, sourcePath, maxBytes: rawMax, force })

    const report = [
      '已生成 preset: ' + GENERATED_PRESET_ID,
      '  源文件: ' + result.sourcePath,
      '  输出:   ' + result.compositionPath,
      '',
      '下一步：',
      '  1. 重启 dsh（preset 在启动时扫描）；',
      '  2. 在界面里把会话的 agent preset 切到「兼容模式」。',
      '',
      '上游 dsh 升级后，重跑本命令即可同步。',
      '',
    ].join('\n')

    process.stdout.write(report)
    return 0
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write('dsh-imitate-claude: ' + detail + '\n')
    return 1
  }
}

/**
 * 入口。
 * @returns {number} 退出码。
 */
function main() {
  const [command, ...rest] = process.argv.slice(2)

  if (command === undefined || command === '-h' || command === '--help') {
    process.stdout.write(USAGE)
    return 0
  }

  if (command === 'sync-preset') {
    const flags = parseFlags(rest)
    if (flags.help === true) {
      process.stdout.write(USAGE)
      return 0
    }
    return runSyncPreset(flags)
  }

  process.stderr.write('dsh-imitate-claude: unknown command "' + command + '"\n\n' + USAGE)
  return 2
}

process.exitCode = main()

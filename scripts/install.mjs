/**
 * 把 `dsh-imitate-claude` 装进指定 profile 的安装脚本。
 *
 * 为什么不直接点市场安装：dshmarket 的 `/dsh-market/install` 会先查精选
 * registry，任何不在 `awesome-dsh-plugin` 列表里的来源一律 400
 * `plugin is not in the curated registry`（lib/routes.js:6399）。本地路径
 * 永远不会出现在那个列表里，所以**市场界面装不了本地插件**。
 *
 * 但市场识别已装插件的方式是读 bundle patch + loader entry，而不是读安装
 * 来源。因此走 `dsh plugin add`（与市场底层同一条 pnpm 链路）装好之后，
 * 这个插件在市场里会被当作正常已装插件管理与开关。
 *
 * 运行：node scripts/install.mjs --profile <name> [--dsh-home <path>] [--preset]
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generatePreset } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
// 仓库根就是可安装的插件包本身。
const bundleDir = repoRoot

/**
 * 解析命令行参数。
 * @param {string[]} argv
 * @returns {Record<string, string | boolean>}
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
 * 执行一个命令并把输出透传出来。
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
function run(command, args, env) {
  execFileSync(command, args, { stdio: 'inherit', env, shell: process.platform === 'win32' })
}

const flags = parseFlags(process.argv.slice(2))
const profile = typeof flags.profile === 'string' ? flags.profile : null

if (profile === null) {
  process.stderr.write('用法：node scripts/install.mjs --profile <name> [--dsh-home <path>] [--preset]\n')
  process.exitCode = 2
} else {
  const dshHome =
    typeof flags['dsh-home'] === 'string'
      ? flags['dsh-home']
      : process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')

  const env = { ...process.env, DSH_HOME: dshHome }

  if (!existsSync(join(bundleDir, 'lib', 'index.js'))) {
    process.stderr.write('bundle 尚未构建，先运行：node scripts/build-bundle.mjs\n')
    process.exitCode = 1
  } else {
    process.stdout.write(`安装 dsh-imitate-claude 到 profile "${profile}"\n`)
    process.stdout.write(`  DSH_HOME = ${dshHome}\n\n`)

    // 与 dshmarket 底层同一条 pnpm 链路：装好后 bundle 会自动进入 patch 栈。
    run('dsh', ['plugin', '--profile', profile, 'add', bundleDir], env)

    process.stdout.write('\n安装完成。\n')

    if (flags.preset === true) {
      process.stdout.write('\n生成 agent preset（web 界面必需）...\n')
      try {
        const result = generatePreset({ dshHome, force: true })
        process.stdout.write(`  ${result.compositionPath}\n`)
      } catch (error) {
        process.stderr.write(
          `  preset 生成失败：${error instanceof Error ? error.message : String(error)}\n` +
            '  可用 --source 指定 agent.cordis.yml 路径，或手动运行 sync-preset。\n',
        )
      }
    }

    process.stdout.write(
      [
        '',
        '下一步：',
        '  1. 重启 dsh；',
        '  2. web 界面：在插件页确认 dsh-imitate-claude 已列出，并在会话里把',
        '     agent preset 切到「兼容模式」（由 --preset 生成）。',
        '',
        '说明：市场界面不能装本地来源（只接受精选 registry），',
        '但装好后市场会把它当作已装插件管理。',
        '',
      ].join('\n'),
    )
  }
}

/**
 * 把桌面端从旧包名 `dsh-claude-compat` 迁移到 `dsh-imitate-claude`。
 *
 * 为什么需要脚本而不是两句 pnpm 命令：
 *   - desktop profile 被 CLI 拒绝管理，只能直接改 package.json；
 *   - 包名出现在 dependencies、dsh.profile.bundles 两处，漏一处就不生效；
 *   - 旧 preset 目录（.agent-presets/dsh-compat）与新 id 并存会产生
 *     两个 preset 选项，需要清理。
 *
 * 运行：node scripts/migrate-install.mjs
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OLD_NAME = 'dsh-claude-compat'
const NEW_NAME = 'dsh-imitate-claude'
const NEW_REPO = 'https://github.com/Nine9327/dsh-imitate-claude.git'
const OLD_PRESET = 'dsh-compat'

const profileDir = process.env.DSH_PROFILE_DIR
if (!profileDir) {
  process.stderr.write('请设置 DSH_PROFILE_DIR 环境变量\n')
  process.exitCode = 2
} else {
  const manifestPath = join(profileDir, 'package.json')
  const backup = manifestPath + '.bak-rename'
  if (!existsSync(backup)) copyFileSync(manifestPath, backup)

  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))

  // 1) 移除旧依赖与旧 bundle 行。
  delete pkg.dependencies[OLD_NAME]
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== OLD_NAME)

  // 2) 写入新依赖（先不落 bundles，等 pnpm 装好再加，避免中间态）。
  pkg.dependencies[NEW_NAME] = `github:${NEW_REPO.replace('https://github.com/', '').replace('.git', '')}`
  writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  process.stdout.write(`已写入新依赖：${NEW_NAME}\n`)

  // 3) 卸载旧包目录残留 + 安装新包。
  const run = (args) =>
    execFileSync('pnpm', args, {
      cwd: profileDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })

  try {
    run(['install'])
  } catch (error) {
    process.stderr.write(`pnpm install 失败：${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }

  if (process.exitCode === undefined || process.exitCode === 0) {
    // 4) 加入 bundles（幂等）。
    const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!after.dsh.profile.bundles.includes(NEW_NAME)) {
      after.dsh.profile.bundles.push(NEW_NAME)
      writeFileSync(manifestPath, JSON.stringify(after, null, 2) + '\n', 'utf8')
    }
    process.stdout.write(`已注册到 dsh.profile.bundles：${NEW_NAME}\n`)

    // 5) 清理旧 preset 目录（与新 id 并存会造成重复选项）。
    const home = process.env.DSH_HOME
    if (home) {
      const oldPresetDir = join(home, '.agent-presets', OLD_PRESET)
      if (existsSync(oldPresetDir)) {
        rmSync(oldPresetDir, { recursive: true, force: true })
        process.stdout.write(`已清理旧 preset：${oldPresetDir}\n`)
      }
    }

    process.stdout.write(
      [
        '',
        '迁移完成。请重启 dsh。',
        `备份：${backup}`,
        '',
      ].join('\n'),
    )
  }
}

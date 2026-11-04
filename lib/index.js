/**
 * `dsh-claude-compat` 包入口。
 *
 * 本包是一个 **bundle**：真正被 dsh 挂载的是 `cordis.patch.yml` 里声明的两行
 * （`/instructions` 与 `/command-init`），而不是这个文件。
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

/**
 * `dsh-imitate-claude` 核心库：命名映射、根探测、导入展开、规则收集、脚手架。
 *
 * 该包不含任何 dsh 插件依赖，可独立测试。
 *
 * @module dsh-imitate-claude-core
 */

export {
  COMMANDS_DIR,
  CONFIG_DIR,
  INIT_DIRECTORIES,
  INIT_PLACEHOLDERS,
  INSTRUCTION_CANDIDATES,
  LOCAL_INSTRUCTION,
  PRIMARY_INSTRUCTION,
  PROJECT_ROOT_MARKERS,
  RULES_DIR,
  RULES_DIRS,
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  SKILLS_DIR,
} from './naming.js'

export { assertInsideRoot, findProjectRoot, hasDshConfig } from './discover.js'
export { expandImports } from './imports.js'
export { collectRules, renderRules } from './rules.js'
export {
  isInstructionSkeleton,
  renderInstructionSkeleton,
  renderSettingsSkeleton,
  scaffoldProject,
} from './scaffold.js'

export {
  buildPresetText,
  GENERATED_PRESET_ID,
  generatePreset,
  resolveSourcePreset,
} from './preset.js'

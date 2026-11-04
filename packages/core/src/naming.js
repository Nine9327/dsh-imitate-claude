/**
 * 命名映射：Claude Code 约定 → dsh 约定。
 *
 * 这是全项目唯一的事实来源。任何地方需要知道"某个 claude 名字在 dsh 里叫什么"，
 * 都从这里取，不要硬编码字面量。
 *
 * @module dsh-imitate-claude/naming
 */

/** 主指令文件名（Claude: CLAUDE.md → dsh: DSH.md）。 */
export const PRIMARY_INSTRUCTION = 'DSH.md'

/** 本地覆盖文件名（Claude: CLAUDE.local.md → dsh: DSH.local.md）。 */
export const LOCAL_INSTRUCTION = 'DSH.local.md'

/** 项目配置目录名（Claude: .claude → dsh: .dsh）。 */
export const CONFIG_DIR = '.dsh'

/** 设置文件名（Claude: settings.json → dsh: settings.yml）。 */
export const SETTINGS_FILE = 'settings.yml'

/** 本地设置文件名。 */
export const SETTINGS_LOCAL_FILE = 'settings.local.yml'

/** 模块化规则目录。 */
export const RULES_DIR = 'rules'

/** 自定义斜杠命令目录。 */
export const COMMANDS_DIR = 'commands'

/** 技能目录（dsh 原生已扫描，此处仅作一致性引用）。 */
export const SKILLS_DIR = 'skills'

/**
 * 指令文件的发现顺序，**顺序即优先级**（靠前者胜出）。
 *
 * 设计意图：
 * - `.dsh/DSH.md` 是本插件的推荐布局，排在最高优先级；
 * - 根目录 `DSH.md` 次之，兼容"不建目录"的用法；
 * - `AGENTS.md` / `CLAUDE.md` 兜底，保持与 dsh 生态和已有 Claude 仓库兼容。
 */
export const INSTRUCTION_CANDIDATES = Object.freeze([
  `${CONFIG_DIR}/${PRIMARY_INSTRUCTION}`,
  `${CONFIG_DIR}/${LOCAL_INSTRUCTION}`,
  PRIMARY_INSTRUCTION,
  LOCAL_INSTRUCTION,
  'AGENTS.md',
  'CLAUDE.md',
  'AGENTS.local.md',
  'CLAUDE.local.md',
])

/** 规则目录的搜索顺序，顺序即优先级。 */
export const RULES_DIRS = Object.freeze([
  `${CONFIG_DIR}/${RULES_DIR}`,
  '.claude/rules',
])

/** 目录名标记：命中即认为是项目根。 */
export const PROJECT_ROOT_MARKERS = Object.freeze(['.git'])

/** `/init` 需要创建的空目录（相对项目根）。 */
export const INIT_DIRECTORIES = Object.freeze([
  CONFIG_DIR,
  `${CONFIG_DIR}/${RULES_DIR}`,
  `${CONFIG_DIR}/${COMMANDS_DIR}`,
  `${CONFIG_DIR}/${SKILLS_DIR}`,
])

/** `/init` 需要创建的空占位文件（相对项目根）。 */
export const INIT_PLACEHOLDERS = Object.freeze([
  `${CONFIG_DIR}/${RULES_DIR}/.gitkeep`,
  `${CONFIG_DIR}/${COMMANDS_DIR}/.gitkeep`,
  `${CONFIG_DIR}/${SKILLS_DIR}/.gitkeep`,
])

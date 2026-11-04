# dsh-imitate-claude 插件计划（项目级 .dsh 约定 + Claude Code 兼容）

> 状态：**P0–P2 已实现，35 个单元测试 + 9 项端到端验收全部通过**（详见 README.md）
> 目标读者：实现者、评审者
> 范围：**仅项目级**。不动 `$DSH_HOME`（`~/.dsh`）与 `~/.claude` 的既有约定。

## 实现落地情况（相对本计划）

| 计划项 | 状态 | 说明 |
|---|---|---|
| §2.8 preset 架构修正 | ✅ 已按 C 方案实现 | web 下插件确实必须进 preset |
| `/init` 命令 | ✅ 已实现 | 幂等、`--force`、只在新建时触发模型补全 |
| `.dsh/DSH.md` 加载 | ✅ 已实现 | 旁挂插件，未 fork |
| `@path` 导入 | ✅ 已实现 | 环检测、深度上限、缺失降级 |
| `.dsh/rules` 合并 | ✅ 已实现 | `.dsh` 优先于 `.claude` |
| `sync-preset` 生成器 | ✅ 已实现 | 定点替换，不再手工维护 254 行 |
| 真实 dsh 进程内启动验证 | ⚠️ 受限 | 沙箱禁止建符号链接，改用假 ctx 驱动测试 |

---

---

## 1. 目标与验收标准

### 1.1 一句话目标

做一个 dsh 插件，让 dsh 在**项目级**完整复刻 Claude Code 的配置约定，但所有 `claude` 命名一律改成 `dsh`：

- `/init` 在项目里生成 `.dsh/` 目录（而不是 `.claude/`）；
- 项目内的 `CLAUDE.md` → `DSH.md`，`.claude/` → `.dsh/`，`.claude/settings.json` → `.dsh/settings.yml`，以此类推；
- 同时**仍能识别**真实存在的 Claude 布局（`.claude/`、`CLAUDE.md`），做只读兼容读取。

### 1.2 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| A1 | 空项目执行 `/init`，生成 `.dsh/` 目录树，且不含任何 `claude`/`CLAUDE` 字样的文件名或目录名 | 命令执行后 `Get-ChildItem -Recurse .dsh` 检查 |
| A2 | `/init` 生成的 `.dsh/DSH.md` 会在**下一个请求**进入模型上下文 | 会话日志中出现 workspace instruction baseline |
| A3 | 已有 `.claude/CLAUDE.md` 的项目，不做任何改动即可被 dsh 读到 | 同上，且源文件未被修改 |
| A4 | `DSH.md` 里的 `@path` 导入被展开 | 被导入文件的内容出现在上下文中 |
| A5 | `.dsh/rules/*.md` 与 `.claude/rules/*.md` 按文件名排序注入 | 上下文顺序可验证 |
| A6 | 同名冲突时 `.dsh` 优先于 `.claude`，且不会重复注入 | 两者内容不同时，只有 `.dsh` 版本出现 |
| A7 | 安装到 profile 后 `dsh --profile web` 可启动，`/init` 出现在命令面板 | 手动验证 |
| A8 | 卸载插件后，dsh 行为回到基线，无残留 | 对比 `dsh --dump-config` |

### 1.3 明确不做（Non-goals）

- 不修改 `$DSH_HOME` 下的用户全局 `~/.dsh/AGENTS.md` 与 `~/.claude/CLAUDE.md` 的加载逻辑。
- 不改写、不迁移用户已有的 `.claude/` 目录（只读兼容，不动文件）。
- 不实现 Claude Code 的 `.claude/agents`（子代理定义）与 `hooks` 桥接（后者 dsh 已有 `dsh-hooks-claude-code`，属于另一条线）。
- 不追求 Claude 的 `.claude/commands/*.md` 全套 slash command 语义（见 §9 分期，先做 P0/P1）。

---

## 2. 现状调研（已核实）

这一节是计划的全部事实基础，均来自本机实际安装的 dsh `0.1.5-rc.2` 源码。

### 2.1 dsh 的插件体系

dsh 是 cordis 插件树。`dsh` CLI 启动一个 **profile**，profile 由多层 patch 叠加而成：

```
空根 cordis.yml ([])
  ← bundle 层（package.json 的 dsh.profile.bundles，按序）
  ← profile 自己的 cordis.patch.yml   ← 用户定制写这里
  ← $DSH_HOME/cordis.patch.yml        ← 机器级，优先级更高
  ← --patch 覆盖层
```

关键文件位置（本机）：

- 源码：`C:\nvm4w\nodejs\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\*`
- 当前 profile：`C:\Users\陈涵斌\.dsh\profiles\desktop\`
- 启动器：`C:\nvm4w\nodejs\node_modules\@deepseek-ai\dsh\lib\bin.js`

### 2.2 patch 语义（`dsh-app-boot/lib/index.js:59` `applyEntryPatches`）

- `- insert:` 向某个 group 追加行，或 `- id` 定位后 `insert`；
- `- {id, config}`：**整块替换** `config`，不是字段深合并（源码注释明确写了 "A patch replaces the targeted row's whole `config` rather than merging into it"）；
- 未匹配到 id 的 patch 会 warning 并被跳过。

> 这条直接决定了 §4.1 的配置策略：要改 `agent-instructions` 的 `instructionFileCandidates`，必须**完整重写整块 config**，包括 `maxBytes`。

### 2.3 项目指令文件加载：`@deepseek-ai/dsh-agent-instructions`

已读 `README.md` 与 `lib/index.js`，事实如下：

- 默认候选：`instructionFileCandidates = ['AGENTS.md', 'CLAUDE.md']`，`localInstructionFileCandidates = ['AGENTS.local.md', 'CLAUDE.local.md']`；
- **`CLAUDE.md` 已经被内置支持**（这是当前最大的已有能力，不要重复实现）；
- 用户全局固定为 `$DSH_HOME/AGENTS.md`（`USER_GLOBAL_FILE`），项目范围向上找根（默认 marker `.git`），从根到 cwd 逐目录收集；
- 候选名**不允许含路径分隔符**：
  ```js
  // lib/index.js:75
  function resolveInstructionFileCandidates(candidates, fallback) {
    return (candidates ?? [...fallback]).filter((candidate) =>
      !RESERVED_PATH_SEGMENTS.has(candidate) && !/[\\/]/.test(candidate))
  }
  ```
  **结论：`.dsh/DSH.md` 这种带目录的候选名无法通过配置实现**，必须写插件或改结构。
- 不支持：`@path` 导入、`.claude/rules/`、小写文件名；
- 同目录内按内容去重（trim 后逐字节比较），保留发现顺序中最早的候选；
- 注入是**下一个请求生效**，不是即时。

### 2.4 斜杠命令：`@deepseek-ai/dsh-commands`

- `ctx.commands.register({ name, description, input: { hint, attachments }, handler })`；
- handler 返回 `{ kind: 'success' | 'error', text }`；
- 命令**不进入模型消息**，只在 UI 侧渲染结果；
- agent 作用域：挂在某个 agent 的 ctx 下注册即对该 agent 生效，并 shadow 全局同名命令；
- 现有命令：`/compact`、`/record`、`/workspace-write`、`/plan`、`/export`、`/goal`。**没有 `/init`**，名字不冲突。

### 2.5 `/goal` 是最佳实现模板

`dsh-command-goal/lib/index.js` 是本计划要照抄的结构：

```js
const name = 'command-goal'
const inject = ['commands', 'goals']

function apply(ctx) {
  ctx.commands.register({
    name: 'goal',
    description: '...',
    input: { hint: '[...]', attachments: true },
    handler: (invocation) => { /* 用 ctx + invocation.agent + invocation.rawInput */ },
  })
}
export { apply, inject, name }
```

### 2.6 skills 扫描根（`dsh-skill-filesystem`）

| 优先级 | 来源 | 路径 |
|---|---|---|
| 100 | project-dsh | `<projectRoot>/.dsh/skills` |
| 200 | project-agents | `<projectRoot>/.agents/skills` |
| 300 | custom | `config.customSkillDirs` |
| 400 | user-dsh | `<dshHome>/skills` |
| 500 | user-agents | `<agentsHome>/skills` |

- **`.dsh/skills` 已经是原生约定**，无需改造；
- `customSkillDirs` 走 `resolve(root)`，**相对路径按进程 cwd 解析**，不是一个可用的项目相对机制；
- 技能格式：`<name>/SKILL.md` 或 `<name>.md`，YAML frontmatter 必需 `name` + `description`。

### 2.7 安装与验证路径

- `dsh plugin --profile <name> add <pkg>` 转发给 pnpm，成功后扫描 `dsh.bundle.patch` 自动并入 bundle 栈（`plugin-Ddi42qoW.js:46` `reconcilePlugins`）；
- 相对路径 spec 会被重写锚定到调用目录，**`add .` 是安全的**（`anchorPathSpec`）；
- ⚠️ **`desktop` profile 被 CLI 硬拒绝**：`error: profile "desktop" is managed exclusively by the Electron application`（`bin.js:29`）。所以插件不能直接装进 desktop，开发期必须用独立 profile。

---

## 2.8 开发中发现的硬约束（**覆盖前文部分假设**）

以下是实际动手时从配置 dump 与 preset 源码里读出来的，直接影响插件形态。

### (1) web 界面下，指令加载器不在宿主平面

`dsh-web-app` 的 `cordis.patch.yml` 显式禁用了 `agent-instructions`，并把一批 agent 平面行搬到**每个会话挂载的 agent preset**：

```yaml
# dsh-web-app/cordis.patch.yml
- id: agent-instructions
  disabled: true
```

真正的加载器在 preset 里：

```yaml
# dsh-agent-presets/presets/standard/agent.cordis.yml:29
- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536
```

**后果**：只改 profile 的 `cordis.patch.yml` 在 web 下**完全无效**，因为那一行根本没被挂载。原计划的"bundle patch"形态在 web 下不成立。

### (2) preset 是整份 composition，没有 patch 叠加

用户自建 preset 放在 `<dshHome>/.agent-presets/<id>/agent.cordis.yml`（`discovery.js:48` `USER_PRESET_DIR`），以**目录为单位整份定义**，没有 "继承 standard 再改一行" 的机制。优先级：靠前的 root 赢得同名 id。

**后果**：定制版 preset 必须**复制整份** `standard/agent.cordis.yml`（254 行、18 个顶层行）再改，会随上游版本漂移。这是本方案最大的长期维护成本。

### (3) 两种可行形态

| 形态 | 适用 | 代价 |
|---|---|---|
| **A. 宿主插件 + 宿主命令** | headless / TUI 等非 preset 表面 | web 下指令加载不生效 |
| **B. 自建 preset**（复制 standard 改一行） | web（即当前使用场景） | 需跟随上游同步 254 行 |
| **C. A+B 并存** | 全表面 | 两套要都维护 |

**本计划采用 C**，但把 B 的整份复制改为**生成式**：提供 `dsh-imitate-claude sync-preset` 命令，从当前安装的 `standard/agent.cordis.yml` 读取、只替换 `agent-instructions` 行并追加本插件行，输出到 `.agent-presets/dsh-compat/`。上游升级后重跑一次即可，不手工维护副本。

### (4) 其它已核实的约束

- `desktop` profile 被 CLI 硬拒绝，且本会话沙箱不允许写 `~/.dsh`；开发期统一用工作区内 `DSH_HOME`（已建 `.dev-home`）。
- patch 的 `config` 是**整块替换**，已实测确认（`--dump-config` 验证）。
- `renderWorkspaceContext(files, {maxBytes, replacePreviousBaseline})`、`discoverBaselineInstructionFiles(options)` 均为**公开导出**，可复用渲染与预算逻辑，只需自写发现层——**不必 fork 53KB 全量代码**。

---

## 3. 命名映射表（唯一事实来源）

实现时所有路径/常量都从这张表派生，不要散落硬编码。

| Claude Code | **dsh（本插件目标）** | 说明 |
|---|---|---|
| `CLAUDE.md` | `DSH.md` | 项目根主指令文件 |
| `CLAUDE.local.md` | `DSH.local.md` | 本地覆盖，gitignore |
| `.claude/` | `.dsh/` | 项目配置目录 |
| `.claude/CLAUDE.md` | `.dsh/DSH.md` | 目录内主指令 |
| `.claude/settings.json` | `.dsh/settings.yml` | 项目设置 |
| `.claude/settings.local.json` | `.dsh/settings.local.yml` | 本地设置 |
| `.claude/commands/*.md` | `.dsh/commands/*.md` | 自定义斜杠命令 |
| `.claude/skills/` | `.dsh/skills/` | 技能目录（**dsh 原生已支持**） |
| `.claude/agents/*.md` | `.dsh/agents/*.md` | 子代理定义（本期不做） |
| `.claude/rules/*.md` | `.dsh/rules/*.md` | 模块化规则（本期做） |
| `@path/to/file` | 同语法保留 | 指令文件内导入 |
| `~/.claude/` | （不变） | 用户级，不在本期范围 |

**兼容读取方向**：`.dsh/*` 为**主**，`.claude/*` 为**兜底兼容**。冲突时 `.dsh` 优先（见 §5.3）。

---

## 4. 方案设计

### 4.1 关键取舍：指令文件到底放哪？

这是全计划的**核心决策**，有两个互斥选项：

**选项 A：`.dsh/DSH.md`（目录内）**
- 与 Claude 布局 1:1 对应，迁移直观；
- 但 `instructionFileCandidates` 不支持带目录的候选名（§2.3），**必须 fork/替换指令插件**。

**选项 B：根目录 `DSH.md` + `.dsh/` 只放附属物**
- 可以只靠 `cordis.patch.yml` 完成，**零代码**；
- 但 `/init` 产物分裂在两处，与"复制 Claude 约定"的直觉有偏差。

**本计划采用 A 为主、B 为兼容**：

- 主路径：`.dsh/DSH.md`（由自研指令插件加载，满足 A1）；
- 同时继续加载根目录 `DSH.md` / `AGENTS.md` / `CLAUDE.md`（保持与现有生态兼容，退化为 B）；
- 这样既符合"`.dsh` 目录化"的诉求，又不破坏其它项目。

> 若评审后倾向选 B，可把整个 P0 阶段砍成一段 `cordis.patch.yml`，工期从约 5 天降到半天——这是本计划最大的可裁剪点，请在评审时明确。

### 4.2 插件拆分

```
dsh-imitate-claude/                 (monorepo, pnpm workspace)
├── packages/
│   ├── core/                       @dsh-compat/core
│   │   ├── src/naming.ts           命名映射表（§3）唯一实现
│   │   ├── src/discover.ts         项目根探测 + 候选文件枚举
│   │   ├── src/imports.ts          @path 导入展开（带环检测/深度上限）
│   │   └── src/rules.ts            rules/*.md 收集与排序
│   ├── instructions/               @dsh-compat/instructions
│   │   └── src/index.ts            替换 dsh-agent-instructions 的加载器
│   ├── command-init/               @dsh-compat/command-init
│   │   └── src/index.ts            /init 命令
│   ├── command-dsh/                @dsh-compat/command-dsh
│   │   └── src/index.ts            /dsh 命令族（P2）
│   └── bundle/                     @dsh-compat/bundle
│       ├── cordis.patch.yml        bundle 层：禁用内置行 + 插入本插件行
│       └── package.json            声明 dsh.bundle.patch
└── fixtures/                       三个样例项目（空 / .dsh / .claude）
```

安装时只需 `dsh plugin --profile <p> add <本仓库或 npm 包>`，`bundle` 包会自动并入 bundle 栈。

### 4.3 bundle 的 patch 内容（草案）

```yaml
# packages/bundle/cordis.patch.yml
- id: agent-instructions
  disabled: true                      # 关掉内置加载器，避免双份注入

- insert:                              # 插到与内置行同级位置
    - id: compat-instructions
      name: '@dsh-compat/instructions'
      config:
        maxBytes: 65536
        projectRootMarkers: ['.git']
        candidates:                    # 顺序即优先级
          - '.dsh/DSH.md'
          - '.dsh/DSH.local.md'
          - 'DSH.md'
          - 'DSH.local.md'
          - 'AGENTS.md'
          - 'CLAUDE.md'
        compatCandidates:              # 兜底只读兼容
          - '.claude/CLAUDE.md'
          - '.claude/CLAUDE.local.md'
        rules:
          - '.dsh/rules'
          - '.claude/rules'
        enableImports: true
        maxImportDepth: 5

    - id: compat-command-init
      name: '@dsh-compat/command-init'
```

要点：
- **必须**同时 `disabled: true` 内置行，否则两套加载器会把同一份 `CLAUDE.md` 注入两次；
- `insert` 不带 `id` 时追加到根列表（`applyEntryPatches` 的 `else data.push(...insert)`），这是可用的，但优先用带 `id` 的 group 插入以保证位置可控。

---

## 5. 行为规格

### 5.1 `/init` 命令

**输入**：`/init`（无参数）；可选 `--force` 覆盖已存在文件。

**行为**：
1. 确定项目根（复用 core 的根探测：`.git` → 否则 cwd）；
2. 若 `.dsh/` 已存在且无 `--force`，**不覆盖**，返回 `kind: 'success'` + 已有文件清单（幂等，Claude 的 `/init` 也是这个语义）；
3. 否则生成：

```
.dsh/
├── DSH.md                # 主指令，含项目骨架分析结果
├── settings.yml          # 最小可用设置
├── rules/
│   └── .gitkeep
├── commands/
│   └── .gitkeep
└── skills/
    └── .gitkeep
```

4. `DSH.md` 内容由 **agent 自己探索仓库后生成**（Claude 的 `/init` 是让模型分析代码库再写），不是模板填充。这里有一个实现选择：

   - **方案 1（推荐）**：`/init` 的 handler 只负责"落骨架 + 把分析任务作为 followup 提交给 agent"，让模型自己写 `DSH.md`（用 `invocation.agent.followup(...)`，参考 `dsh-command-goal` 的 `submitObjectiveAttachments`）；
   - 方案 2：纯模板 + 静态探测（读 `package.json` / `pyproject.toml` 等），不花模型 token，但内容质量差。

   推荐方案 1，与 Claude Code 保持一致体验。

5. **安全性**：任何写入前检查目标路径是否在项目根内（防 `..` 逃逸），并遵守 dsh 的文件 sandbox 策略。

**输出**：`{ kind: 'success', text: 'Initialized .dsh/ — N files created:\n...' }`。

### 5.2 `@path` 导入展开

Claude Code 的语法：

```markdown
主指令...
@docs/architecture.md
@~/.dsh/global-rules.md
```

规格：
- 行首 `@` 开头（允许前置空白）视为导入；
- 相对路径相对**当前文件所在目录**解析；
- 缺失文件 → 保留原文字面量并加一行提示，**不报错**（Claude 的行为是忽略并提示）；
- 循环导入 → 检测并跳过，记 warning；
- 深度上限 `maxImportDepth`（默认 5）；
- 展开后的内容计入 `maxBytes` 预算，超预算按内置策略裁剪（广的优先丢，最具体的截断）。

### 5.3 冲突与去重

按 §3 的方向，实现三层规则：

1. **路径层**：候选按 `candidates` 顺序枚举，同一逻辑槽位（如"项目主指令"）若 `.dsh/DSH.md` 存在，则 `.claude/CLAUDE.md` **不再加载**；
2. **内容层**：不同槽位但内容 trim 后完全一致 → 只保留优先级高的（沿用内置的去重思路，避免 `DSH.md` 与 `AGENTS.md` 重复）；
3. **预算层**：超 `maxBytes` 时丢整个较广的文件，再截断最具体的文件，并输出与内置一致的 `Workspace instruction budget ...` 提示。

### 5.4 rules 收集

`.dsh/rules/*.md` 与 `.claude/rules/*.md`：
- 只在同一层级比较（`.dsh/rules` 优先于 `.claude/rules`，同名文件取 `.dsh` 版）；
- 按**文件名字典序**拼接，确定性；
- 每个文件自带标题，注入时标注来源路径；
- 总大小计入预算。

---

## 6. 技术实现要点

### 6.1 插件骨架（照抄 `dsh-command-goal`）

```ts
// packages/command-init/src/index.ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'compat-command-init'
export const inject = ['commands']

export function apply(ctx: Context) {
  ctx.commands.register({
    name: 'init',
    description: 'initialize a .dsh/ project configuration directory',
    input: { hint: '[--force]' },
    handler: async (invocation) => {
      // 1. 解析 rawInput
      // 2. 根探测 + 存在性检查
      // 3. 落骨架
      // 4. agent.followup(...) 触发模型生成 DSH.md
    },
  })
}
```

### 6.2 替换指令插件时的复用边界

内置 `dsh-agent-instructions` 有约 53KB 逻辑（`lib/index.js`），包含：baseline 身份、内容 digest、增量刷新（`read`/`write`/`edit` 触发）、投影对账、`<system-reminder>` 转义、PTC 延迟。

**不要重写全部**。建议：

- 保留其"注入消息"与"增量刷新"机制，只替换 `discover` 与 `render` 两个接缝；
- 具体做法：**fork 该包到 `packages/instructions`**，改动限定在：
  - `resolveInstructionFileCandidates`：放宽路径分隔符限制，允许 `.dsh/DSH.md`；
  - `files.ts` 的 `allExistingInstructionFiles`：支持子目录候选；
  - 新增 imports 展开与 rules 收集两个纯函数阶段；
- 保留升级路径：在 README 与代码注释中记录 fork 基准版本（`0.1.5-rc.2`），并在 CI 加一条"上游 README 变更提醒"的检查。

> 风险提示：fork 意味着上游升级时要手工 rebase。若评审不愿意承担这个成本，退回 §4.1 的选项 B。

### 6.3 配置 schema

用 `@deepseek-ai/schemastery`（内置包都在用）：

```ts
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  maxBytes: z.natural().default(65536),
  projectRootMarkers: z.array(z.string()).default(['.git']),
  candidates: z.array(z.string()).default([...]),
  compatCandidates: z.array(z.string()).default([...]),
  rules: z.array(z.string()).default([]),
  enableImports: z.boolean().default(true),
  maxImportDepth: z.natural().default(5),
})
```

---

## 7. 开发与验证

### 7.1 开发 profile（因为 desktop 装不进去）

```powershell
# 一次性：从 web 模板造一个独立 profile
dsh --profile compat-dev --from-default-profile web

# 安装本地插件（`add .` 会锚定到当前目录，安全）
dsh plugin --profile compat-dev add .

# 启动
dsh --profile compat-dev
```

### 7.2 快速迭代：`--patch` 免安装

改配置阶段不需要反复 `add`，直接用覆盖层验证：

```powershell
dsh --profile compat-dev --patch ./dev/override.yml
```

### 7.3 验证矩阵

| 用例 | fixture | 期望 |
|---|---|---|
| 空目录 | `fixtures/empty` | `/init` 生成 5 个路径，无 claude 字样 |
| 已有 `.dsh` | `fixtures/with-dsh` | `/init` 幂等，不覆盖 |
| 纯 Claude 项目 | `fixtures/with-claude` | 无写入，`CLAUDE.md` + `.claude/rules` 被读到 |
| 混合项目 | `fixtures/mixed` | `.dsh` 优先，无重复 |
| 导入环 | `fixtures/import-cycle` | 不死循环，有 warning |
| 超预算 | `fixtures/huge` | 有 budget 提示，渲染 ≤ maxBytes |

自动化：每个 fixture 起一次 headless 会话断言注入内容：

```powershell
dsh --profile compat-dev --patch ./dev/override.yml --dump-config   # 先看配置对不对
```

### 7.4 回归检查

- 改动前后各跑一次 `dsh --profile compat-dev --dump-config`，diff 应当**只有** `agent-instructions` 相关行变化；
- 确认没有残留的双份注入（A6）。

---

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| **fork 内置指令插件，上游升级冲突** | 高 | 改动面压到 2 个函数；记录基准版本；CI 提示上游 README 变更 |
| patch 整块替换 config，漏字段被静默重置 | 中 | 每次改 `cordis.patch.yml` 后必须 `--dump-config` 比对 |
| `dsh` 版本迭代导致 `commands.register` 签名变化 | 中 | 锁定 peer 版本范围；CI 跑最小冒烟 |
| `/init` 让模型生成 `DSH.md` 产生 token 成本 | 低 | 明确 `--template` 开关提供纯模板路径 |
| `.dsh` 与 `.claude` 同时存在导致语义混乱 | 中 | 严格 §5.3 优先级；`/dsh status` 命令展示实际生效来源（P2） |
| 写入越界（`../` 逃逸） | 高 | core 里统一做 `isInsideProjectRoot` 断言，单点收口 |

---

## 9. 分期与排期

### P0 — 配置层打通（0.5 天）
- 写 `packages/bundle/cordis.patch.yml`，只做候选名替换：`DSH.md` / `DSH.local.md` 加入候选；
- 在 `compat-dev` profile 验证根目录 `DSH.md` 被加载。
- **产出**：不写代码就能验证"改名字"这条路通不通。

### P1 — `/init` + core 命名层（1.5 天）
- `packages/core`：命名表、根探测、骨架生成、越界断言；
- `packages/command-init`：`/init` 命令 + 幂等 + `--force`；
- fixtures 与 A1/A2 验收。

### P2 — 指令加载器替换 + 导入 + rules（2 天）
- fork 指令插件，放宽候选路径；
- `@path` 导入展开（环检测、深度上限）；
- `.dsh/rules` / `.claude/rules`；
- A3/A4/A5/A6 验收。

### P3 — 打磨（1 天）
- `/dsh status`：展示当前生效的指令来源、预算占用、兼容命中情况；
- 文档：README（中英）、迁移指南（`claude` → `dsh` 一键重命名脚本）；
- 发布：npm 包命名、`dsh.bundle.patch` 声明、版本策略。

**合计约 5 个工作日**。若 §4.1 选 B，可压缩到约 1 天（砍掉 P2）。

---

## 10. 待决问题

1. **§4.1 的 A/B 选择**——是否接受 fork 内置指令插件？（决定整个工期量级）
2. `/init` 的 `DSH.md` 由模型生成（token 成本、质量好）还是纯模板（零成本、质量一般）？建议默认模型生成 + `--template` 可选。
3. 是否需要迁移脚本，把现有 `.claude/` 批量改名成 `.dsh/`？（本期建议只提供脚本，不自动执行）
4. 打包发布形态：仅本地 `file:` 安装，还是要发 npm？
5. 是否需要同时支持 **用户级**（`~/.dsh` 对应 `~/.claude`）？——本期已明确排除，但会影响 P3 的架构预留，建议在 core 里预留 `scope: 'project' | 'user'` 参数而不实现。

---

## 附录 A：关键源码位置索引

| 主题 | 位置 |
|---|---|
| patch 应用语义 | `dsh-app-boot/lib/index.js:59` `applyEntryPatches` |
| 指令插件默认候选 | `dsh-agent-instructions/lib/index.js:17-18` |
| 候选名路径限制 | `dsh-agent-instructions/lib/index.js:75` |
| 指令插件配置字段 | `dsh-agent-instructions/README.md:59-67` |
| 命令注册 API | `dsh-commands/README.md:30-46` |
| 命令实现模板 | `dsh-command-goal/lib/index.js:173-185` |
| skills 扫描根 | `dsh-skill-filesystem/lib/index.js:153-170` |
| 插件安装与 bundle 归一 | `dsh/lib/plugin-Ddi42qoW.js:46` |
| desktop profile 拒绝 | `dsh/lib/bin.js:29` |
| base bundle patch 结构 | `dsh-base/cordis.patch.yml` |

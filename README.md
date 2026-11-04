# dsh-claude-compat

让 dsh 支持项目级的 **Claude Code 约定**，但所有命名改为 `dsh`：`CLAUDE.md` → `DSH.md`，`.claude/` → `.dsh/`。

同时**只读兼容**已有的 Claude 布局，不改动其中任何文件。

## 它解决什么

dsh 内置的指令加载器默认已认识 `CLAUDE.md`，但有三样做不到：

| 能力 | dsh 内置 | 本插件 |
|---|---|---|
| `CLAUDE.md` / `AGENTS.md` | ✅ | ✅ |
| `.dsh/DSH.md`（带目录的候选） | ❌ 候选名禁止路径分隔符 | ✅ |
| `@path` 导入展开 | ❌ | ✅ |
| `.dsh/rules` 与 `.claude/rules` | ❌ | ✅ |
| `/init` 生成 `.dsh/` | ❌ | ✅ |

## 安装

本插件是一个标准 **dsh bundle**（`package.json` 里声明 `dsh.bundle.patch`），
所以安装后会自动进入 profile 的 patch 栈。

```powershell
# 构建产物（把各层源码组装成单一可安装包）
node scripts/build-bundle.mjs

# 装进某个 profile；--preset 同时生成 web 界面需要的 agent preset
node scripts/install.mjs --profile <你的 profile> --preset
```

装上之后重启 dsh，在会话里把 agent preset 切到「兼容模式」。

### 与 dshmarket 的关系

**市场界面装不了本地插件**，这不是配置问题，是市场自己的安全策略：
`/dsh-market/install` 会先查精选 registry，任何不在 `awesome-dsh-plugin`
列表里的来源一律返回 400 `plugin is not in the curated registry`
（`dshmarket/lib/routes.js:6399`）。本地路径永远不会出现在那个列表里。

但市场**识别已装插件**的方式不是看安装来源，而是读两样东西：

| 市场读什么 | 本插件提供什么 |
|---|---|
| `package.json` 的 `dsh.bundle.patch` | `./cordis.patch.yml` |
| patch 里的 `insert` 行 id | `claude-compat-instructions`、`claude-compat-command-init` |

（见 `dshmarket/lib/patch.js:264` `rowIdsForPackage`）

所以：**用 `install.mjs` 装好之后，市场会把它当作正常已装插件**，
可以出现在插件列表里、被开关、被分组和备注，只是不能从市场界面首次安装。

想让其他人也能在市场里一键装，需要把包发布到 npm 并提交到
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。

### 为什么需要 sync-preset

web 界面下，dsh 并不在宿主层加载指令文件：`dsh-web-app` 把 `agent-instructions` 这一行禁用了，
真正的加载发生在**每个会话挂载的 agent preset** 里（`presets/standard/agent.cordis.yml`）。
而 preset 是**整份 composition**，没有 patch 叠加机制。

`sync-preset` 的做法是：读取当前安装的 `standard` preset，**只替换** `agent-instructions` 一行、
追加 `/init` 一行，其余原样保留，输出到 `$DSH_HOME/.agent-presets/dsh-compat/`。
上游 dsh 升级后重跑一次即可同步，不需要手工维护 254 行副本。

> 只有 web 界面需要这一步。TUI / headless 等表面从 bundle patch 直接生效。

## 用法

### `/init`

在项目里创建：

```
.dsh/
├── DSH.md              # 主指令（模型会接着补全内容）
├── settings.yml
├── rules/
├── commands/
└── skills/
```

- 已存在时不覆盖（幂等）；`/init --force` 才重建。
- 只有本次确实写出了 `DSH.md` 才会让模型去补全内容，已初始化的项目重复执行不烧 token。
- 发现已有 `CLAUDE.md` / `.claude/` 时会给出提示，但**不修改**它们。

### `@path` 导入

```markdown
主指令...

@docs/architecture.md
@.dsh/rules/shared.md
```

相对路径相对当前文件所在目录解析；环状导入会被检测并跳过；缺失文件降级为一行提示而不是报错。

## 优先级

越靠前优先级越高，同名内容只注入一次：

1. `.dsh/DSH.md`
2. `.dsh/DSH.local.md`
3. `DSH.md`
4. `DSH.local.md`
5. `AGENTS.md`
6. `CLAUDE.md`
7. `AGENTS.local.md`
8. `CLAUDE.local.md`

规则目录：`.dsh/rules` 优先于 `.claude/rules`，同名文件取 `.dsh` 版本。

## 开发

```powershell
pnpm install
node test/acceptance.mjs          # 端到端验收
node packages/core/test/core.test.mjs
node packages/core/test/preset.test.mjs
node packages/instructions/test/load.test.mjs
node packages/instructions/test/plugin.test.mjs
node packages/command-init/test/init.test.mjs
```

开发用的独立 profile（不碰 `~/.dsh`）：

```powershell
$env:DSH_HOME = "<本仓库>\.dev-home"
dsh --profile dev --from-default-profile web --dump-config
```

## 结构

```
packages/
├── core/          命名映射、根探测、越界断言、@import、rules、preset 生成
├── instructions/  旁挂式指令加载器（复用内置渲染，只接管发现）
├── command-init/  /init 命令
├── cli/           sync-preset 命令行
└── bundle/        可安装产物：dsh.bundle.patch + lib/（由 build-bundle 生成）
scripts/
├── build-bundle.mjs  把各层源码组装成单一可安装包
└── install.mjs       装进 profile 并按需生成 preset
fixtures/          empty / with-dsh / with-claude / mixed / import-cycle
test/              端到端验收
```

> `packages/bundle/lib/` 是**生成产物**，不要手改；改源码后重跑
> `node scripts/build-bundle.mjs`。

## 设计要点

- **旁挂而非 fork**：复用内置 `renderWorkspaceContext` 做预算裁剪与帧转义，
  只替换发现层。避免 fork 53KB 逻辑后与上游持续漂移。
- **单一事实来源**：所有命名集中在 `packages/core/src/naming.js`，其它地方不写字面量。
- **写操作单点收口**：一切落盘前都过 `assertInsideRoot`，用 `path.relative` 判包含关系
  （不用 `startsWith`，否则 `D:\a` 会误判 `D:\ab`）。
- **降级优先于崩溃**：拿不到 dsh 的渲染器/消息构造器时退化为本地实现，
  不让一个兼容层把整个 agent 启动搞挂。

## 已知限制

- 仅项目级；`~/.dsh` 与 `~/.claude` 的用户级约定不在本期范围。
- 不实现 `.claude/agents` 与 hooks 桥接。
- 指令刷新是**下一轮生效**，不是文件改动即时推送。

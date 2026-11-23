# AGENTS.md —— 给接手这个项目的 AI / 开发者

> 本文档是交接入口。任何改动项目结构、命令或红线的提交，都必须同步更新本文档并一并提交。

## 项目一句话

《同频不同词》：12 篇关于朋友、家人与恋人的互动生活故事。静态前端（hash 路由）+ 可选的云端 Function 双人房间。线上体验版见 README 顶部链接。

## 上手顺序

1. [README.md](README.md) —— 产品是什么、怎么玩、命令表、接口与隐私
2. 本文档 —— 交接规则与红线
3. [docs/homepage-ia-spec.md](docs/homepage-ia-spec.md) —— 首页两级导航改版的规格与验收记录（已上线）
4. [shared/types.ts](shared/types.ts) —— 前后端共享类型与命令协议
5. [functions/engine.mjs](functions/engine.mjs) —— 唯一规则模块（创建、命令、投影、校验）

## 环境要求

- Node.js `^22.13.0` 或 `>=24.0.0`
- Windows / macOS / Linux 均可，本地房间数据写入 `.local/rooms.sqlite`（自动创建）

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm ci` | 安装依赖（首次或 lockfile 变化后） |
| `npm run dev` | 前端 + 本地房间服务（默认 `http://127.0.0.1:5175`） |
| `npm test` | 76 项 `node:test` 规则、内容、接口与恢复测试 |
| `npm run build` | 类型检查并生成 `dist/`（prebuild 会校验并同步故事内容） |
| `npm run preview` | 本地预览 `dist/` |

## 工作闭环（每次任务都走一遍）

1. 开始：确认工作区干净（`git status`），需要时先 `git pull`。
2. 只做被要求的任务，不顺手改无关代码。
3. 结束：`npm test` 全过 + `npm run build` 通过。
4. 汇报：列出改了哪些文件、为什么。
5. 提交：中文提交信息，一句话说清"为什么改"。若改动影响了项目结构、命令或红线，同步更新 AGENTS.md / README / 相关 docs 并一并提交。

## 架构关键点

- **内容只有一份**：`content/stories.json` 是唯一内容源。`functions/story-data.mjs` 由 prebuild 从它生成，**永远不要手改**。
- **规则只有一份**：`functions/engine.mjs` 无依赖，本地服务、测试、云端 Function 共用同一套规则。改玩法逻辑只改这里。
- **前端是静态站点**：hash 路由（`#library`、`#room/:id`、`#join/:id` 等），核心文件 `src/App.tsx`、`src/StoryLibrary.tsx`（导航转场状态机）、`src/Game.tsx`（对局与回放）。
- **双人房间需要后端**：云端实现面向 Qoder Sites 的 Deno Function + 私有数据库（`function_backend` 模式）。仓库里**没有** `functions/_qoder/backend.mjs`，它由部署运行时注入，禁止伪造或用 fixture 替代。
- **动画只动 `transform` / `opacity`**，进入二级页 280ms、返回 240ms，`cubic-bezier(0.22, 1, 0.36, 1)`；系统减少动态效果时降级为淡入淡出。

## 红线（不可协商）

1. 12 篇故事文案、storyId、API 接口、房间与命令协议、双轨回放、我的回声、单机/双人模式流程 —— 现有文案一个字不改，除非用户明确要求。
2. 不手改 `functions/story-data.mjs`、`dist/`、`.qoder.site` 描述文件（描述文件由 Sites 工具生成和维护）。
3. 不伪造 `functions/_qoder/backend.mjs`，不用本地 fixture 冒充真实后端对外发布。
4. secrets 不进对话、不进仓库、不进 URL；数据库只存凭证的 SHA-256 摘要。
5. 内部 ID（projectId、siteId、actionId 等）不写入任何会进仓库或对外展示的文案。
6. 发布上线是单独动作：`git push` 不会更新线上站点，线上发布需要 Qoder Sites 工具且必须得到用户明确授权。

## 协作注意事项

- 回退保障靠 git 历史；改版前的本地快照在 `backups/`（不进仓库），只有本机才有。
- 仓库是公开的：提交前检查没有密钥、内部 ID 或本地路径泄露。
- 只通过 GitHub 仓库接手的协作者做不了线上发布（没有 Sites 上下文），发布由项目所有者在本机完成。

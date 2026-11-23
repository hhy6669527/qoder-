# 首页信息架构与交互改版 · 实施规格

> 状态：**已落地并上线（2026-11-23）**。实现位于 `src/StoryLibrary.tsx`、`src/homepage.css` 与 `src/App.tsx`；本文档保留为改版背景、交互数值依据与验收清单。
> 目标项目：本仓库（React 19 + Vite + TS + Tailwind 4，线上地址 `https://same-wavelength-fhfo7md2auf.qoder.website`）

## 1. 问题与目标

**现状问题**：首页把 3 个关系大类（朋友间 / 家人间 / 情侣间）和 12 张故事卡平铺在同一屏。用户一进来就被 12 张卡淹没，"分类"失去了入口的意义。

**目标信息架构**

| 层级 | 内容 |
| --- | --- |
| 一级页（故事馆） | 只展示 3 个分类入口（大卡片），**不出现任何故事卡** |
| 二级页 | 顶部「返回」按钮 + 当前分类名，主体是该关系下的 4 个场景卡（一起吃饭 / 出去走走 / 消息往来 / 帮个小忙） |
| 三级 | 点击场景卡 → 沿用现有故事预览弹窗（Radix Dialog）与开局流程，**原样复用，不改一行逻辑** |

## 2. 交互规格（严格按数值实现）

- 点击分类：卡片 `scale(0.97)` 按压 **120ms** → 原位淡出并上移 **8px**；同时二级页从 `translateX(24px)` 滑入到 `0`；**总时长 280ms**。
- 缓动统一 `cubic-bezier(0.22, 1, 0.36, 1)`；返回动画反向，**240ms**。
- 位移动画只用 `transform` / `opacity`，**禁止动画 width / height / top / left**。
- hover：`translateY(-3px)` + 阴影加深，**180ms**；触摸设备改为按下 `scale(0.98)`。
- 二级页标题延迟 **60ms** 上浮淡入，不要闪烁。
- 移动端支持左边缘右滑返回；桌面端支持 **Esc** 返回。
- `prefers-reduced-motion`：关闭位移，只保留 **120ms** 淡入淡出。

## 3. 视觉规格

- 分类入口做成大尺寸可点击卡片（桌面 **≥260px 宽**，移动端通栏），不是小按钮。
- 沿用现有插画、墨绿 / 赭红 / 暖米配色与颗粒质感，**插画内容不要改**。
- 场景卡复用现有卡片视觉语言（`.story-card` / `.card-copy` / `.card-bottom` / `.art-topic` 这套 CSS 目前在 TSX 里未被使用，正好拿来用），用插画局部区分，**不新增装饰元素**。
- 间距遵循 8pt 网格，圆角 **16px**，标题层级保持现状。

## 4. 绝对不要改动

12 篇故事文案、storyId、API 接口、房间与命令协议、双轨回放、我的回声、单机 / 双人模式流程。
**现有文案一个字都不改**（指故事正文；为返回按钮等新增的 UI 标签除外）。

## 5. 验收标准

1. 一级页只有 3 个分类入口，看不到 12 张故事卡。
2. 点任一分类，280ms 内平滑进入二级页，能看到该关系的 4 个场景。
3. 点场景能正常进入原有故事流程。
4. 返回后滚动位置和已读状态保持。
5. 375px 手机端无横向溢出、无错位、动画不掉帧。
6. Tab / Enter 可走完全流程；开启"减少动态效果"后降级正常。

## 6. 实施落点（已勘察，可直接照做）

### 6.1 `src/App.tsx`（改版前 204 行）

- 路由是 hash 制：`getRoute() = window.location.hash.slice(1) || 'library'`，`navigate(path)` 写 hash；`hashchange` 会 `setRoute / setError / setSelected / window.scrollTo(top)`。
  **二级页建议用组件内部 state 实现，不新增 hash 路由**，避免干扰游戏路由与回放流程。
- 现有关键状态：`route, stories, loading, catalogError, relation, topic, query, mode, selected, help, joinDialog, joinInput, toast, busy, error, uncertain, view, session, resume, echoes`。
- 首页现有结构（要替换的部分）：`.opening-spread`（hero，保留）→ `.resume-banner`（保留）→ `.story-library`（内含 `.section-heading` + `.search-box` + `.relation-filters` + `.topic-row` + `.story-chapters`（3 × `.story-chapter`，每章 `.chapter-art` + 4 个 `.story-entry`））→ `.library-bottom`（"让缘分选一篇"，保留）。
- **要移除**：`.search-box`、`.relation-filters`、`.topic-filters`、`.result-count`、`.story-chapters`（12 张卡的来源）。移除后 `relation / topic / query` 三个 state 与 `visible` 派生值成为死代码，一并清掉（确认无其他引用后再删）。
- **保留**：`.opening-spread`、`.resume-banner`、`.library-bottom`、`.section-heading`（"找一件熟悉的小事 / THE STORY LIBRARY"）作为一级页分区标题。
- 开局流程（不可改）：
  ```
  onOpen(story) → setSelected(story) → <Dialog open={Boolean(selected)}> 预览弹窗
    → <Primary onClick={() => void begin(selected)}> → begin(): api.create(story.id, mode, attempt.token, attempt.id)
    → navigate('room/' + created.id)
  ```
  二级页场景卡只调用同一个 `onOpen`，即完全复用。
- 已读状态：`completedIds = new Set(echoes.map(e => e.storyId))`，`echoes` 来自 `readEchoes()`（localStorage），天然跨页保持 —— 不要另建状态。

### 6.2 转场实现建议（transform / opacity only）

用「网格同格叠加」避免两块内容互相顶位：

```css
.library-stage { display: grid; }
.library-stage > * { grid-area: 1 / 1; }
```

状态机建议：`category`（当前分类，null = 一级页）、`sceneMounted`、`sceneReady`（是否已滑到位）、`hubLeaving`。
- 进入：置 `category` + `sceneMounted` → 连两帧 `requestAnimationFrame` 后置 `sceneReady` → CSS 过渡 280ms 到位。
- 返回：`sceneReady=false` 且 `hubLeaving=false` → 反向过渡 240ms → 结束后卸载二级页。
- 过渡期间被遮挡的一侧加 `inert`（React 19 支持 `inert` 布尔属性）或 `pointer-events:none`，避免重复 Tab 焦点。
- 滚动：进入二级页时 `window.scrollTo({top:0})`；返回一级页时恢复进入前保存的 `window.scrollY`（用 ref 保存）。

### 6.3 `src/ui.tsx`（当前 46 行）

现成可复用：`relations`（label / subtitle / icon / color: sage|peach|rose）、`topics`（label / icon）、`StoryArt`、`StoryCard`（`.story-entry` 列表项，二级页不再需要，可删）、`Mark`、`Avatar`、`Primary`、`Secondary`、`Kicker`、`Choice`。

建议新增两个组件（放在 `src/ui.tsx`）：
- `RelationCard({ relation, index, count, onOpen })` —— 一级页分类大卡：插画 + 序号 + 图标 + `relations[key].label` + `subtitle` + 箭头。
- `SceneCard({ relation, topic, story, onOpen, completed })` —— 二级页场景卡：裁切插画 + `.art-topic` 芯片 + 故事标题 + mood / duration + 已体验标记。

插画裁切（`object-position`，源图 1536×1024，卡片图框约 1.95:1 会裁掉上下）：

| 关系 | 一起吃饭 | 出去走走 | 消息往来 | 帮个小忙 |
| --- | --- | --- | --- | --- |
| friends（橙篷咖啡馆） | `46% 68%` 桌面与两只杯 | `12% 30%` 左侧街景与篷布 | `66% 36%` 粉衣女生捧杯 | `90% 50%` 右侧盆栽 |
| family（餐桌与台灯） | `50% 74%` 桌上饭菜 | `16% 46%` 左侧窗与绿植 | `30% 30%` 母亲的脸 | `74% 32%` 女儿与茶杯 |
| couple（公园小路） | `84% 56%` 相机与野花草地 | `50% 60%` 两人并肩走 | `46% 28%` 两人相对说话 | `16% 62%` 左侧草丛小路 |

### 6.4 `src/globals.css`（65KB，247 长行）

- **可直接复用的现成卡片语言（当前 TSX 未使用）**：`.story-card`（圆角 `calc(var(--site-radius) - 5px)`、hover `translateY(-4px)` + `box-shadow: 0 10px 28px #293f360b`）、`.story-card > .story-art { aspect-ratio: 1.95 }`、`.card-copy`、`.card-meta`、`.card-copy h3`（衬线体）、`.card-bottom`（含 `.tone-peach` / `.tone-rose` 变体）、`.art-topic`（图标 + 主题标签芯片）、`.story-grid { grid-template-columns: repeat(3,1fr); gap: 24px }`。
- 主页容器：`.library-main { max-width: 1208px; padding: 47px…28px }`、`.story-library`、`.section-heading`、`.library-bottom`。
- **⚠️ 关键坑**：文件末尾第 246 行是全局降级块
  ```css
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    *, *:before, *:after { animation: none !important; transition: none !important; }
    .story-card:hover, .primary:hover { transform: none; }
  }
  ```
  它会杀掉所有过渡，包括需求要求的 120ms 淡入淡出。
  **必须在该块之后追加更具体、带 `!important` 的覆盖规则**，例如
  ```css
  @media (prefers-reduced-motion: reduce) {
    .hub-panel, .scene-panel { transition: opacity 120ms linear !important; transform: none !important; }
    .scene-title { animation: scene-title-fade 120ms linear 60ms both !important; }
  }
  ```
  （类选择器特异性高于通配符，可覆盖 `*` 的 `!important`；`animation: none !important` 同样会被覆盖。）
- 触摸设备判定用 `@media (hover: none) and (pointer: coarse)`。

### 6.5 其他

- `shared/types.ts`：`Relation = 'friends'|'family'|'couple'`，`Topic = 'meal'|'travel'|'message'|'help'`；`StorySummary` 含 `id, number, relation, topic, title, subtitle, quote, location, mood, duration, setup, objective, cast`。
- 12 篇故事 = 3 关系 × 4 场景，每个关系下 4 个场景各对应 1 篇故事；二级页按 `topics` 顺序渲染存在的 4 个场景。
- 插画资源只有 3 张 webp：`public/art/{friends,family,couple}.webp`。

## 7. 自查清单（2026-11-23 验收）

- [x] 一级页 DOM 中不存在任何故事卡 / 故事标题
- [x] 进入二级页的过渡总时长 280ms，缓动 `cubic-bezier(0.22,1,0.36,1)`，只动 transform / opacity
- [x] 返回 240ms 反向；二级页标题 60ms 延迟上浮淡入
- [x] 桌面 Esc 返回、移动端左边缘右滑返回均生效
- [x] 375px 宽度无横向溢出；分类卡通栏（帧率未在实体手机上长时间测量）
- [x] Tab / Enter 可完成「分类 → 场景 → 预览弹窗 → 开局」全流程；被遮挡层级不进 Tab 序列
- [x] `prefers-reduced-motion: reduce` 下只剩 120ms 淡入淡出，无位移
- [x] 返回后滚动位置与已读状态（我的回声）保持
- [x] 故事文案、storyId、API、房间协议零改动（与原版快照逐文件比对）

# Obsidian Paper2MD 论文阅读视图设计

## 1. 项目定位

当前目标不是开发独立桌面阅读器，而是在现有 Obsidian 插件中增加一种专门面向科研论文的阅读视图。

各组件职责如下：

```text
Paper2MD
  PDF → Markdown、Figure/Table、图注、版面与溯源数据

Obsidian 插件
  提供论文阅读界面、文件入口、跳转和交互

AI
  提供论文总结、段落解释、Figure 分析和问答
```

Obsidian 已经提供 Markdown 渲染、Vault 文件管理、标签页、侧边栏、主题、搜索和内部链接。因此不需要重新开发完整桌面应用，只需实现一个自定义论文阅读视图。

## 2. 要解决的问题

普通 Markdown 会把 Figure 和长图注插入正文流，容易打断连续阅读。科研论文还经常包含较大的多面板图，直接内嵌时会出现以下问题：

- 正文被 Figure 和长图注截断；
- 阅读正文时需要频繁上下滚动寻找图片；
- 图片缩小后难以查看面板细节；
- Figure、图注和正文引用之间缺乏联动；
- AI 分析结果与当前段落、当前 Figure 缺乏上下文关联。

目标是在保留标准 `article.md` 的同时，提供正文主栏和 Figure/AI 侧栏。

## 3. 推荐界面

```text
┌──────────────────────────────┬────────────────────────┐
│ 正文主栏                      │ 右侧上下文栏            │
│                              │                        │
│ Introduction                 │ [Figures] [AI 分析]    │
│ 连续正文……                    │                        │
│                              │ 当前 Figure            │
│ Results……                     │ 图片、图注、缩略图      │
│                              │                        │
│ 正文中的 Fig. 3 可点击跳转     │ [放大] [分析这张图]     │
└──────────────────────────────┴────────────────────────┘
```

右侧栏建议包含两个标签页：

### Figures

- 显示与当前正文位置最相关的 Figure/Table；
- 显示完整图注；
- 提供全文 Figure 缩略图列表；
- 点击图片打开高清查看或全屏 Lightbox；
- 点击正文中的 `Fig. 3`、`Figure 3` 或 `Table 2` 时切换到对应资源；
- 图注过长时默认折叠，允许展开。

### AI 分析

- 生成或显示全文总结；
- 解释选中的正文；
- 分析当前 Figure；
- 将当前段落、当前 Figure 和图注作为联合上下文提问；
- 保存用户希望长期保留的分析结果。

窄窗口或移动端应自动退化为单栏，Figure 恢复到对应正文位置附近，避免侧栏过窄。

## 4. 实现方式

建议使用 Obsidian 自定义 `ItemView`，提供插件命令：

```text
Open in Paper2MD Reader
```

基本流程：

```text
用户打开 article.md
        ↓
插件读取 article.md 和 reader.json
        ↓
主栏渲染连续正文
        ↓
右栏渲染 Figure、Table 和图注
        ↓
正文滚动、Figure 引用与侧栏联动
        ↓
AI 使用当前正文/Figure 上下文进行分析
```

不建议直接改写 Obsidian 默认 Markdown 阅读视图。独立 `ItemView` 更容易控制双栏布局、滚动同步和 AI 面板，同时不影响普通笔记。

插件仅用于显示文件时，应优先使用 Obsidian `Vault.cachedRead()`。自定义视图应在真正显示时再加载论文数据，避免增加 Obsidian 启动时间。

## 5. 文档包结构

继续保留标准 Markdown 和图片目录，同时增加面向阅读器的机器数据：

```text
paper-folder/
├── article.md
├── analysis.md
├── images/
│   ├── figure-0001.png
│   ├── figure-0002.png
│   └── table-0001.png
└── _paper2md/
    ├── reader.json
    ├── manifest.json
    ├── 04-provenance/
    │   └── layout-provenance.json
    └── 05-validation/
        └── validation-report.json
```

文件用途：

- `article.md`：标准、可移植的最终 Markdown；
- `images/`：最终 Figure/Table 图片；
- `reader.json`：阅读器使用的正文锚点、Figure、图注和引用关系；
- `analysis.md`：用户希望长期保留、可搜索和链接的 AI 分析；
- `_paper2md/`：机器数据、溯源和验证结果。

普通 Markdown 不应依赖插件才能阅读。即使插件未安装，`article.md` 仍应在 Obsidian、GitHub、VS Code 等环境中正常显示。

## 6. reader.json 已实现结构

Reader 只消费 Paper2MD 已发布的 `paper2md-reader-v0.1`，不兼容早期设计草案中的 `figures/references` 结构。正文与图注位于 `blocks`，视觉占位是 `kind: "visual_slot"`；资源通过单一 `placement_block_id` 和可空的 `caption_block_id` 指向 block；关系使用 `id/type/source_id/target_id/label`。

示例：

```json
{
  "contract_version": "paper2md-reader-v0.1",
  "source_sha256": "<sha256>",
  "article": {
    "path": "article.md",
    "sha256": "<sha256>",
    "anchor_contract": "paper2md-markdown-anchor-v0.1",
    "block_fingerprint_version": "paper2md-visible-block-fingerprint-v0.1"
  },
  "capabilities": {
    "layout_semantics": "reviewed",
    "caption_binding": "reviewed-layout-geometry",
    "body_references": "unavailable"
  },
  "blocks": [
    {
      "id": "slot_<24hex>",
      "kind": "visual_slot",
      "order": 42,
      "anchor": { "syntax": "p2md:slot", "id": "slot_<24hex>" },
      "fingerprint": { "visible_text_sha256": "<sha256>", "simhash64": "<16hex>", "text_length": 0 },
      "source_spans": ["<source-span>"],
      "asset_id": "ast_<24hex>"
    }
  ],
  "assets": [
    {
      "id": "ast_<24hex>",
      "kind": "figure",
      "path": "images/figure-0003.png",
      "sha256": "<sha256>",
      "size_bytes": 12345,
      "width_px": 1600,
      "height_px": 900,
      "display_label": "Figure 3",
      "caption_block_id": "blk_<24hex>",
      "placement_block_id": "slot_<24hex>",
      "source_spans": ["<source-span>"]
    }
  ],
  "relations": [
    {
      "id": "rel_<24hex>",
      "type": "places",
      "source_id": "slot_<24hex>",
      "target_id": "ast_<24hex>",
      "label": null
    }
  ]
}
```

关键要求：

- Figure/Table ID 稳定；
- 图片、图注和正文锚点可以相互追踪；
- 路径使用 Vault 内相对路径；
- 保存源页码和 bbox，便于后续跳回 PDF 或调试；
- `reader.json` 不复制论文全文，正文仍以 `article.md` 为权威来源；
- Reader 同时校验 block fingerprint、资源大小/哈希，以及 manifest v0.8 的 Reader 摘要绑定；
- v0.1 明确声明 `body_references: "unavailable"`，不得从 `Fig. N` 文本猜测引用关系；
- 实际字段和约束以 Paper2MD 的 `reader.schema.json` 为准。

## 7. 正文与 Figure 的联动

第一版可以只按照 Figure 在原 Markdown 中的位置建立锚点。后续再增强引用识别：

```text
正文滚动到 Figure 原位置
        → 右栏切换到对应 Figure

用户点击 Fig. 3
        → 右栏切换 Figure 3
        → 高亮图注或打开大图

用户点击 Figure 缩略图
        → 正文滚动到首次引用或原始锚点
```

滚动同步建议使用 `IntersectionObserver` 观察正文 block，而不是持续监听并计算所有元素位置。

如果一个段落引用多张图，右栏可以显示主 Figure，并在顶部提供相关 Figure 标签。

## 8. AI 分析集成

AI 请求应明确区分上下文范围：

### 当前段落分析

输入：

- 当前段落；
- 前后少量段落；
- 当前章节标题。

### 当前 Figure 分析

输入：

- Figure 图片；
- 完整图注；
- 正文中引用该 Figure 的段落；
- 必要时加入论文摘要和研究目标。

### 全文问答

输入应通过检索选择相关段落，不必每次发送整篇论文。

AI 输出分为两类：

- 临时对话和缓存：保存在插件数据或 `_paper2md/analysis.json`；
- 用户确认需要长期保留的结论：写入 `analysis.md`。

API 密钥不得写入 Vault Markdown、`reader.json` 或 Git，应使用 Obsidian Secret Storage。

## 9. 分阶段实施

### 第一阶段：静态论文阅读视图

- 注册 `Paper2MD Reader` 自定义视图；
- 读取当前 `article.md`；
- 主栏显示正文；
- 右栏显示 Figure、图注和缩略图；
- 支持点击放大；
- 不修改原 Markdown。

验收标准：

- 现有 Paper2MD 文档包可以直接打开；
- 图片链接全部有效；
- 正文顺序不因抽离 Figure 而变化；
- 普通 Markdown 视图仍正常。

### 第二阶段：reader.json 与滚动同步

- Paper2MD 生成 `reader.json`；
- 正文 block、Figure 和 caption 具有稳定 ID；
- 滚动正文时切换 Figure；
- 点击 Figure 引用可以跳转；
- 支持 Figure/Table 区分。

验收标准：

- Figure、caption、正文锚点一一可追踪；
- 切换 Figure 不造成主栏跳动；
- 长图注不会挤压正文主栏；
- 窄窗口可以正常退化。

### 第三阶段：AI 分析面板

- 增加 `AI 分析` 标签；
- 支持选中文字解释；
- 支持当前 Figure 分析；
- 支持全文总结和问答；
- 用户可将结果保存到 `analysis.md`。

验收标准：

- 请求中明确显示将发送的上下文范围；
- Figure 分析同时包含图片、图注和引用段落；
- API 失败不影响论文阅读；
- 未经用户操作不自动覆盖已有分析。

### 第四阶段：阅读体验完善

- 全文搜索；
- 章节目录与当前位置；
- Figure 键盘切换；
- PDF 源页跳转；
- 阅读位置记忆；
- Figure/Table 过滤；
- 主题和字号适配。

## 10. 非目标

当前阶段不包括：

- 独立桌面应用；
- Tauri/Electron 打包；
- 替代 Obsidian 默认 Markdown 编辑器；
- 在插件中重新解析 PDF；
- 自动修改用户原始论文笔记；
- 在没有确认的情况下把 AI 输出写入知识库。

## 11. 难度判断

该方案属于低到中等难度，明显小于完整桌面 Reader。

主要开发难点是：

- Figure、图注和正文锚点的稳定映射；
- 滚动位置与侧栏 Figure 的同步；
- 大型多面板 Figure 和长图注的显示；
- AI 上下文范围和持久化边界；
- 不破坏普通 Markdown 的可移植性。

Paper2MD 当前已经具有 layout provenance、caption binding、图片和 manifest，可直接作为 `reader.json` 的基础。第一版应优先验证阅读体验，不急于加入复杂 AI 工作流。

## 12. 参考资料

- Obsidian Vault API：<https://docs.obsidian.md/Plugins/Vault>
- Obsidian Deferred Views：<https://docs.obsidian.md/plugins/guides/defer-views>
- Obsidian 插件启动性能：<https://docs.obsidian.md/plugins/guides/load-time>
- Obsidian Secret Storage：<https://docs.obsidian.md/plugins/guides/secret-storage>

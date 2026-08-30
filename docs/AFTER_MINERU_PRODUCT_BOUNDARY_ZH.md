# After-MinerU Repair / Paper2MD Reader 产品边界

## 当前边界

- **After-MinerU Repair** 读取原始 MinerU ZIP，并可读取用户明确选择的源 PDF。它负责生成确定性视觉修复、物化派生 Markdown、写入 provenance / sidecar / validation，并导出新包。
- **Paper2MD Reader** 只读取文件。原始 MinerU ZIP 以结构化原始内容显示；带 `after-mineru.manifest.json` 的包只有在所有路径、大小、SHA-256、validation 与 Reader projection 全部验证后才启用派生内容。
- **After-MinerU Converter 扩展** 仍只负责 PDF 到原始 MinerU ZIP，不依赖 Repair 或 Reader。

桌面版 v0.1.3 的 `_extraction/manifest.json`、`_extraction/validation.json`、viewer-index、visual-repair 和 visual-candidates ABI 暂由严格验证的兼容别名保留。兼容层不是新包的信任根；新 Reader 优先使用下面的共享契约。

## `after-mineru-package-v1`

包根包含 `after-mineru.manifest.json`，并将内容分为：

- `source/`：原始 MinerU ZIP、逐字节保留的解包条目，以及可选源 PDF。
- `derived/`：当前为 `article.after-mineru.md`；不得覆盖源 Markdown。
- `sidecars/`：Reader projection、viewer index、visual repair、visual candidates、provenance、validation、可选的 `repair-report.json` 与 v0.1.3 兼容记录。
- 根路径及 `_extraction/` 下的兼容别名：每个别名都必须绑定到一个 canonical 文件的同一大小与 SHA-256。

manifest 记录算法版本以及 source / derived / sidecar / compatibility 文件的路径、字节数和 SHA-256。`sidecars/provenance.json` 的 `source_tree` 记录原始 ZIP 根前缀，并把每个原始 ZIP 条目逐项绑定到对应的 `source/` 路径；验证器会重新走受限 ZIP32 解析并核对路径、大小和 SHA-256。用户明确选择的外部 PDF 固定为 `source/source.pdf`，不冒充原始 ZIP 条目；ZIP 内的 PDF 则必须出现在 source tree 中。`sidecars/validation.json` 还必须绑定源 ZIP 哈希和各分区计数。Reader projection 再次绑定源 Markdown、MinerU JSON 和派生 Markdown，并仅引用 manifest 已登记的资源。

验证器遇到未知字段、不安全或 Windows 冲突路径、大小或哈希不匹配、角色路径复用、源 ZIP 投影不一致、未登记资源、计数不一致、无效 bbox 或不支持的版本时拒绝整个派生投影。正式 Map/ZIP 适配器还会要求实际文件全集与 manifest、aliases 和 manifest 根文件精确相等，拒绝夹带文件。目录型宿主无法原子递归枚举时不宣称“目录中没有额外文件”，而是只向 Reader 暴露经过 manifest 绑定并在每次读取时重新校验的内容能力；额外目录文件不可被正文、视觉或 PDF 渲染路径访问。该机制提供包内完整性与来源链记录，不提供发布者身份认证或数字签名。

## 不可变性与确定性

Repair 不修改原 ZIP、`full.md`、content-list JSON、原图或源 PDF。它在进入异步处理前先对调用方提供的 ZIP/PDF 字节建立快照，把每个源条目复制到 `source/`，并在导出和导入时重新逐字节核对。ZIP 条目按规范化路径排序，使用固定时间戳；算法大小写归一化不依赖系统默认 locale，因此同一输入和算法版本应跨环境产生相同字节。

`sidecars/repair-report.json` 使用 `after-mineru-repair-report-v1`，只记录稳定的算法版本、输入/派生哈希、检查结果、结构化计数与警告代码，不记录时间、耗时、平台、本地文件名或本地化消息。它作为普通 sidecar 进入 manifest 的大小与 SHA-256 清单，不增加 v1 manifest 的必需字段，也不建立 v0.1.3 兼容别名；旧 Reader 可以安全忽略其语义，但仍会验证其字节完整性。

## `after-mineru-portable-markdown-v1`

通用 Markdown ZIP 与可验证论文包是两个独立输出，portable 契约不改变 `after-mineru-package-v1` 或桌面版 v0.1.3 ABI。它只包含根目录的 `article.after-mineru.md`、正文实际引用的本地图片，以及 `after-mineru-portable.json`；不包含源 ZIP、PDF、MinerU JSON、Reader sidecar 或交互样式，因此不建立 Reader 信任语义。

portable manifest 绑定算法版本、源 ZIP SHA-256、正文和排序后的图片文件记录，并区分 `portable-derived` 与 `source-assets-fallback`。构建和验证使用与阅读渲染一致的 Markdown AST 收集图片引用，并拒绝 Reader 专用 slot、未被解析为图片的 `![` 语法、带括号的歧义目标、绝对路径、URL/data scheme、查询或 fragment、目录穿越、反斜杠、Windows/NFKC/大小写落盘冲突、缺失图片、非图片资源、未登记或额外文件，以及任意大小或 SHA-256 不匹配。HTML 图片只接受仅含单一带引号 `src` 的 `<img>`；其他 raw HTML 除无属性的安全排版标签与注释外一律 fail closed，因此 `srcset`、`<source>`、SVG/MathML 图片、CSS 背景、多行资源标签与额外属性都不能绕过闭包，`<sup>` 等不加载资源的排版标签仍按正文保留。portable 闭包上限为 256 个文件、64 MB 解压总量；超过上限或独立封装复验失败时只关闭 portable 输出，可验证论文包仍继续生成。portable ZIP 使用 store 模式避免合法的高重复位图触发自身压缩比防护，封装后仍会重新受限解包并复验精确库存。

当前尚不在浏览器中栅格化 PDF crop 或 fragment-set。只有当派生 Markdown 仍完整引用该视觉对象的全部源图片时，portable 导出才允许 `source-assets-fallback`，并记录 `pdf-crop-not-materialized` 或 `fragment-set-not-materialized`；否则 portable 输出独立 fail closed。可验证论文包仍保留经过哈希绑定的 Reader 投影，不会把这种回退宣称为已物化裁剪图。

## 浏览器执行边界

站点 `/repair` 每次运行创建一个一次性 module Worker。主线程只负责选择文件、展示进度和下载；ZIP 与可选 PDF 的 `ArrayBuffer` 通过 transferable 移交，Worker 内只运行一次修复分析，再分别验证和压缩 portable ZIP 与可验证论文包。Worker 使用版本化协议一次性返回完整结果：portable 可用时转移两个最终 ZIP buffer；portable 因资源闭包不完整而安全关闭时，只转移可验证包并返回稳定原因代码。取消会立即终止该 Worker，并通过 request ID / generation 隔离迟到消息；不会退回主线程继续计算，也不会保留半成品。Worker 化避免长计算阻塞界面，但不会消除解压、快照和双重压缩阶段的峰值内存，因此输入边界仍为每个文件 64 MB。

## 第一条完整切片及限制

当前切片已实现：真实 MinerU ZIP → Worker 中的确定性视觉契约 → `derived/article.after-mineru.md` → sidecar / provenance / validation / repair report → portable Markdown ZIP + 可验证论文包 → Reader 只读加载。Repair 提供阶段进度、强取消、两种导出和报告下载；站点提供同级的 `/repair` 与 `/reader` 入口。Reader 也可以在不生成 Markdown 的情况下直接只读打开原始 PDF。正式派生包的正文、图片与 PDF 均从 manifest-bound 内容能力读取，原始 MinerU 包则忠实显示并忽略未验证 sidecar。

Repair 到 Reader 已支持由用户明确触发的同源、一次性内存预览交接：发送端复制可验证包后通过随机 handoff ID 与 nonce 绑定目标窗口，接收端在专用 Worker 中执行 ZIP 库存预检、共享契约验证和受限解包，只有 Reader 实际进入 ready 或 degraded 状态才确认成功。交接限制为 32 MiB 压缩包、256 MiB 解压总量和 2,048 个文件；取消或超时会终止 Worker 并丢弃迟到消息。该流程不使用云传输、IndexedDB、localStorage 或持久论文库。

站点通用 Reader、首页嵌入 Reader 与内存预览使用 `strict-readonly` 能力档位：旧版 v0.1.3 MinerU 包只显示原始结构化内容，不在运行时应用 legacy sidecar、用户 review 或 PDF 文字恢复；正式 `after-mineru-package-v1` 仍在完整验证后显示物化派生正文。DebyeCalculator 真实示例当前仍是预制的 v0.1.3 哈希绑定包，因此显式使用 `legacy-v0.1.3` 兼容投影，但关闭用户 review 与 PDF 文字恢复；后续应将该示例重新物化为正式 v1 包。桌面 v0.1.3 暂保留显式兼容档位及现有 sidecar IPC/文件契约。

尚未纳入本版本的能力包括通用 PDF 正文自动恢复、完整 display-repair 生成，以及将 PDF 裁切或碎图组合物化为新的派生位图。PDF crop 仍是已验证 Reader projection 中的显示指令；portable ZIP 会明确回退到完整源图片而不会伪装成已裁剪原图。证据不足的修复保留为候选或原始显示；大型包仍需继续进行跨浏览器内存压力测试。

# 独立 Web Reader 第一版迁移边界

第一版以现有共享 Reader 为基础，不再把 Obsidian 作为运行时依赖。

## 已接入的来源

1. Paper2MD 内容包：读取 `article.md`、Reader 契约、manifest 与本地资源。
2. MinerU 完整结果：读取 Markdown、稳定版或 v2 `content_list.json` 与图片目录。
3. 普通 Markdown / Web Clipper 文档：在内存显示层配对独立图片与紧邻图注，补充缺失的 Figure 编号，不改写源文件。

三类来源最终都转换为 `LoadedPaperPackage`，Reader 只消费该统一模型，不在组件中重新判断论文结构。

## PDF 处理边界（第二阶段已接通）

公共浏览器不能直接执行用户电脑上的 `mineru-open-api`。PDF 通道必须由受控任务服务实现：上传到隔离暂存区，调用 precision `extract` 生成 `md,json`，执行确定性规则修复和校验，然后原子发布为可读包。浏览器不得保存 MinerU token，也不得接受任意命令或输出路径。

当前已经提供 `apps/processing-service/`：

- 原始请求体只接受带 `%PDF-` 签名的 `application/pdf`，默认上限 64 MB；
- 用户只能选择受限的 MinerU model/language，实际命令固定为 precision `extract` 与 `md,json`；
- 每个任务使用随机隔离目录，先生成 `extract/` 和 `package-stage/`；
- 规则层将输出规范化为 `article.md`、`mineru-result.json`、`images/`，校验所有本地资源路径与引用；
- 规则层从参考的 Research Agent Reader 配套流程中独立抽离，不依赖 Obsidian API；它生成哈希绑定的 `viewer-index.json`、`visual-repair.json` 与 `visual-candidates.json`；
- 包内保留 `_extraction/source.pdf`，网页端使用 PDF.js 将高置信度碎图组重新裁切为完整大图；原始 Markdown、JSON 和图片不被修改；
- Reader 根据哈希绑定的 Markdown 图片 occurrence 和 UTF-16 区间生成只读显示投影：左栏隐藏已由右栏接管的图片与可验证图注，绝不写回 `article.md`；
- Reader 使用 KaTeX 渲染 MinerU Markdown 中的行内与块级 LaTeX；若 MinerU 以 `�` 丢失单个字符且包内保留原 PDF，则只在页码、bbox、源段落和 PDF 文本上下文能够唯一对应时恢复该字符，重复字体字形会确定性折叠；任何歧义均放弃恢复，全部处理只存在于内存显示层；
- 同页图注保持 MinerU 原子边界：正式图注未结束时，只有唯一后继续段按源序出现、以终止标点闭合，并且每个原子都能唯一贴合其绑定图片前后时，Reader 才拼成完整右栏图注并同时从左栏显示投影隐藏；不完整、重复或位置失配时整组保留；
- 对 MinerU 将双栏图注后半段误并入前一页正文块的情况，Reader 仅在“不完整正式图注 + 唯一相邻空白文本栏 + 连续面板序列 + Markdown 唯一正文后缀”全部成立时，从原 PDF 的精确 bbox 文本层恢复后半段；右栏显示完整图注，左栏只隐藏已验证的正式图注和污染后缀，正文前缀保持不变；
- 对“唯一自动修复组 + 紧邻下一页首个正式图注”的情况，可从原始 `mineru-result.json` 恢复跨页图注；
- 对 MinerU 把一整页多面板 Figure 拆成多个自动组、并漏掉边缘碎片的情况，只有当源页除页眉页脚外全部为视觉块、自动组均无审核歧义、至少存在三个独立面板标签、下一页首个语义块是唯一且完整的正式图注时，Reader 才在运行时把该页全部视觉块合成一个 PDF crop；任一条件不满足就保留各原始组；
- 右栏分别标记图所在页与跨页图注所在页，partial 图注会明确提示仅显示已验证部分；
- 生成 manifest/validation 后才将 stage 目录原子重命名为 `package/`；
- Reader 通过远程只读文件系统适配器消费已发布包；失败任务没有可访问的文件接口；
- MinerU token 仍只存在于 CLI 配置或服务端环境变量中。

本地 Web 开发默认发现回环地址上的处理服务。公共站点只有显式配置 HTTPS 处理端点时才显示 PDF 入口。正式多人部署仍需在反向代理层补齐用户登录、TLS、用户配额和保留期清理；Cloudflare/Codex Sites Worker 本身不执行 MinerU CLI。

当前已经完成高置信度碎图识别、派生契约校验和网页端 PDF 裁切重建。无法通过哈希绑定、缺少原 PDF 或处于 `review/ambiguous` 状态的组合会安全回退到 MinerU 原图。

连续 PDF 页流已迁入共享 Reader：网页右栏可在“原始 PDF”和“图片与图注”之间切换，并按可视区懒渲染页面、控制页码与缩放。正文可视区顶部是 PDF 自动跟随的唯一权威；用户操作 PDF 时跟随会暂时暂停，回到正文交互后恢复。无法唯一落到可见正文的页面不会被猜测映射。PDF 版面框、唯一 Figure 点击定位和 PDF.js 空白大图兼容补绘也已迁入；这些能力只消费哈希绑定 ViewerIndex 和通过包内路径/大小校验的 MinerU 资产。分栏比例、正文位置、参考模式、PDF 页码/缩放/跟随和当前 Figure 以 article SHA-256 为键保存在宿主 sidecar state，不写回内容包。超出当前唯一空白栏协议的整段 PDF 文本层补全，以及人工/可选 AI 审核界面尚待迁移。这里所说的参考实现是独立的 Research Agent Reader Obsidian 插件及其配套转换规则；本仓库早期的 Paper2MD Reader 旧代码只是待替换实现，二者不是同一个项目。

## 网页全文边界

后续分成两种适配器：

- 公共页面：服务端抓取，但必须防 SSRF、限制重定向/响应大小/内容类型，并下载允许的图片为包内资源。
- 登录态或客户端渲染页面：由轻量浏览器扩展在当前页面运行 Defuddle/Web Clipper 提取，将版本化元数据、Markdown、源 HTML 快照和本地化图片提交到 processing service；服务端重新构包、暂存校验、原子发布并返回 Reader 深链。

网页导入产物与 MinerU 包使用同一个 Reader 模型，但保留来源类型和诊断信息；显示层 Figure 编号不写回原始 Markdown。

扩展桥接已移除正常流程中的 ZIP 中转。发布动作必须由用户点击触发，并按需请求固定回环服务与图片域名权限；服务端 `/api/v1/clippings` 只接受默认稳定扩展 ID（或显式配置 ID）的精确 `chrome-extension://` Origin。普通网页、未知扩展及无 Origin 请求均 fail closed。ZIP 只保留为显式导出/备份。

## WebMCP 渐进增强边界

网页 Reader 已在浏览器提供当前 `document.modelContext` API 时注册窄型 WebMCP 工具，并对旧版
`navigator.modelContext` 做兼容回退。不支持 WebMCP 的浏览器不会加载 polyfill，也不影响打开论文、
大纲、图片、PDF 和双栏跟随。当前工具仅覆盖 Reader 状态、分页大纲/视觉列表、精确导航、参考模式、
跟随模式、分页视觉候选和只读修复预览；不会返回图片字节、文件路径、DOM 或 HTML。论文标题、图注和
正文片段均标记为不可信内容。

`preview_visual_correction` 只在内存中使用当前哈希绑定候选、ViewerIndex、MinerU 结果与 Markdown
重新执行确定性校验，并固定返回 `writesSidecar: false`。网页没有注册
`apply_visual_correction`；后续写入能力必须先增加明确用户确认，且只能写用户 sidecar，不能覆盖
Markdown、MinerU JSON、原图或 PDF。WebMCP 仍是草案能力，核心 Reader 不依赖其可用性。

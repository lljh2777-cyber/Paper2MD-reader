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
- 对“唯一自动修复组 + 紧邻下一页首个正式图注”的情况，可从原始 `mineru-result.json` 恢复跨页图注；存在多个候选时保留原文，不自动绑定；
- 右栏分别标记图所在页与跨页图注所在页，partial 图注会明确提示仅显示已验证部分；
- 生成 manifest/validation 后才将 stage 目录原子重命名为 `package/`；
- Reader 通过远程只读文件系统适配器消费已发布包；失败任务没有可访问的文件接口；
- MinerU token 仍只存在于 CLI 配置或服务端环境变量中。

本地 Web 开发默认发现回环地址上的处理服务。公共站点只有显式配置 HTTPS 处理端点时才显示 PDF 入口。正式多人部署仍需在反向代理层补齐用户登录、TLS、用户配额和保留期清理；Cloudflare/Codex Sites Worker 本身不执行 MinerU CLI。

当前已经完成高置信度碎图识别、派生契约校验和网页端 PDF 裁切重建。无法通过哈希绑定、缺少原 PDF 或处于 `review/ambiguous` 状态的组合会安全回退到 MinerU 原图。

尚待继续迁移的是连续 PDF 页阅读、更复杂的多组跨页图注投影、PDF 文本层补全以及人工/可选 AI 审核界面。这里所说的参考实现是独立的 Research Agent Reader Obsidian 插件及其配套转换规则；本仓库早期的 Paper2MD Reader 旧代码只是待替换实现，二者不是同一个项目。

## 网页全文边界

后续分成两种适配器：

- 公共页面：服务端抓取，但必须防 SSRF、限制重定向/响应大小/内容类型，并下载允许的图片为包内资源。
- 登录态或客户端渲染页面：由轻量浏览器扩展在当前页面运行 Defuddle/Web Clipper 提取，将净化后的 Markdown 和资源发送给 Reader。

网页导入产物与 MinerU 包使用同一个 Reader 模型，但保留来源类型和诊断信息；显示层 Figure 编号不写回原始 Markdown。

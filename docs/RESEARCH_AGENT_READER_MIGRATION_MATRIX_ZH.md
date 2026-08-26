# Research Agent Reader → 独立网页端迁移矩阵

本文件以 `D:\Obsidian Vault\paper-knowledge-base\knowledge-base\.obsidian\plugins\agent-Dashboard`
中的 Research Agent Reader 为参考实现，以 `E:\Paper2MD-Reader` 为独立网页端目标。
早期 Paper2MD Reader 旧代码不作为功能真值；确认已被共享实现替代后应删除，而不是继续维护两套规则。

## 不变量

- `article.md`、MinerU JSON、原图片和原 PDF 始终只读；所有修复均为派生契约或内存显示投影。
- 不唯一、哈希失配、坐标冲突或 PDF 不可用时放弃修复并保留原文。
- 浏览器不持有 MinerU Token；PDF 处理只通过受控服务端暂存、校验、原子发布。
- Obsidian API 只属于参考宿主，不进入共享算法或网页端核心。

## 能力状态

| 参考能力 | 独立网页端状态 | 迁移说明 |
|---|---|---|
| MinerU precision `extract` + `md,json` | 已迁移 | processing-service 固定命令参数，隔离暂存后发布 |
| manifest/validation/路径/大小/哈希校验 | 已迁移 | 正式 MinerU 包先核验 validation=passed、全部 outputs、source.pdf 与派生契约的路径/大小/SHA-256；核心异常拒绝，派生异常降级 |
| ViewerIndex/VisualRepair 哈希绑定 | 已迁移 | 契约失效时回退原始图片与正文 |
| 同页图注原子拼接与隐藏 | 已迁移 | 仅隐藏唯一验证区间 |
| 跨页图注匹配 | 已迁移 | 仅接受紧邻下一页的唯一正式图注 |
| 碎图组合、整页多面板 crop、嵌套重复折叠 | 已迁移（高置信规则） | PDF 缺失或歧义时保留原始碎片 |
| PDF 文本层缺失字符恢复 | 已迁移 | bbox/正文上下文唯一时才恢复 |
| 双栏图注后半段 PDF 恢复 | 已迁移 | 唯一空栏、连续面板、唯一 Markdown 后缀共同约束 |
| 连续 PDF 页、页码、缩放、懒渲染 | 已迁移 | 网页端使用同一 PDF.js 文档缓存；不使用浏览器 iframe |
| 正文页→PDF 页跟随及交互暂停 | 已迁移 | 正文可视区顶部是唯一自动权威；操作 PDF 时暂停，返回正文后恢复 |
| PDF 版面框与点击定位 Figure | 已迁移 | 只暴露哈希绑定的 ViewerIndex 页面块；图块必须唯一归属 Figure 才可点击 |
| PDF.js 空白图像兼容补绘 | 已迁移 | 大图区域空白时重试 PDF.js，并以已校验 MinerU 大图资产覆盖对应 bbox |
| 阅读位置、缩放、分栏比例持久化 | 已迁移 | 以 article SHA-256 隔离保存浏览器/桌面 sidecar state，不写内容包 |
| 普通 Markdown/Web Clipper 图文配对 | 已迁移 | Figure 编号只在显示层补齐 |
| Web Clipper Markdown/本地 HTML 导入 | 已迁移 | 网页端可选择一个 Markdown/HTML 文档与本地图片，或直接选择保存网页文件夹；HTML 仅转换为内存 Markdown 投影，脚本、活动嵌入、远程/越界/缺失图片均不进入 Reader，源文件保持不变 |
| 网页 URL 直接抓取与资源本地化 | 待迁移 | 必须经受控服务端执行 HTTPS、DNS/私网、重定向、MIME、大小、超时和资源数量校验；浏览器不携带站点 cookie，也不直接信任远程图片 |
| 受限 PDF 整段文本补全 | 已迁移 | 仅处理 bbox 有效的空白正文块；要求前后原文锚点唯一、Markdown 间隙为空、至少一侧同栏相邻，且 PDF 文本是未在正文出现的完整正文段落；图注、页眉、半句续接、重复内容或任一关系失配时保留原文 |
| 人工候选裁决与结构化纠错 UI | 已迁移 | 可接受/拒绝/暂缓既有候选；碎图可重新指定同页组合，跨页图注可重新指定来源视觉块及紧邻下一页的 1–2 个文本块；页序、坐标、Figure key、阅读边界和 Markdown 唯一区间均重新检测，只写浏览器 sidecar |
| 人工修复 sidecar 安全边界 | 已迁移 | 决定绑定 manifest 已验证的 `visual-candidates.json` 文件 SHA-256；限制 64 KiB、候选/决定/页块数量，拒绝重复页码、block ID、阅读顺序、重叠图注区间和冲突占用；接受既有碎图候选时也重新执行几何与 Markdown 映射检测 |
| AI 候选裁决 | 当前不引入 | 当前版本明确采用纯代码规则与用户显式选择，不配置或调用任何 AI 服务 |
| Obsidian ItemView/Vault/MarkdownRenderer | 不迁移 | 已由 Web 路由、PackageStorage 与安全 Markdown 渲染替换 |

## 分阶段提交顺序

1. 跨栏 PDF 图注恢复（已完成，`5b64938`）。
2. 连续 PDF 页运行时与右栏模式切换。
3. Markdown/PDF/Visual 单一权威同步状态机（已完成正文页与 PDF 页；Visual 使用稳定 visual ID）。
4. 版面框与 PDF 图像兼容补绘（已完成）；继续迁移剩余确定性显示修复。
5. Web Clipper Markdown/本地 HTML 导入适配与本地资源收拢（已完成）；URL 服务端抓取仍待迁移。
6. 阅读状态持久化（已完成）。
7. 人工候选审阅、碎图与跨页图注结构化纠错（已完成）。AI 当前不纳入项目。
8. 人工修复 sidecar 哈希绑定、资源上限、歧义与冲突检测安全加固（已完成）。
9. 受限 PDF 空白正文块整段补全（已完成）。
10. Web Clipper Markdown/本地 HTML 导入与资源边界（已完成）；下一步实现受控的网页 URL 抓取、正文抽取与远程资源本地化。

每个阶段都必须通过 typecheck、单元测试、各宿主构建和真实论文浏览器回归后，单独提交并推送。

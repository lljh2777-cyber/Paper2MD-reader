# Paper2MD Processing Service

这是独立网页 Reader 的受控 PDF 处理后端。它不属于 Obsidian 插件，也不在浏览器里执行本机命令。

流程固定为：

1. 接收一个带 `%PDF-` 文件签名且不超过配置上限的 PDF；
2. 写入随机任务目录中的 `source.pdf`；
3. 以参数数组调用 MinerU precision `extract`，固定要求 `md,json`；
4. 将原始输出复制为 `article.md`、`mineru-result.json` 和 `images/`；
5. 在暂存包内保留 `_extraction/source.pdf`，供 Reader 非破坏性重建完整图；
6. 运行从 Research Agent Reader 配套流程抽离的确定性规则，生成并校验 `viewer-index.json`、`visual-repair.json` 和 `visual-candidates.json`；
7. 校验 Markdown、JSON、图片引用、派生契约、路径和资源上限；
8. 生成 `_extraction/manifest.json` 与 `_extraction/validation.json`；
9. 原子发布，随后 Reader 才能读取文件。

服务不会修改 MinerU 生成的正文、JSON 或图片。视觉修复只写入哈希绑定的派生契约；高置信度碎图组由网页 Reader 从包内原 PDF 重新裁切，不覆盖原始图片。不确定组合继续使用原始资源。

## 本地启动

从仓库根目录启动完整 Reader 时，推荐只运行一个命令：

```powershell
npm run reader:dev
```

该命令会检查并启动网页和处理服务，避免只启动网页或重复占用 `8787` 端口。

先确保 `mineru-open-api` 已安装并完成 CLI 自身认证，同时提供 Python 3.10+ 运行确定性契约生成器。token 只保留在 MinerU CLI 配置或 `MINERU_TOKEN` 环境变量中。

```powershell
$env:MINERU_CLI_PATH = "C:\path\to\mineru-open-api.cmd"
$env:PAPER2MD_PYTHON_PATH = "D:\python\python.exe"
npm run processing:build
npm run processing:start
```

默认仅监听 `127.0.0.1:8787`，允许 `http://127.0.0.1:4174` 和 `http://localhost:4174` 访问。随后运行 `npm run web:dev`。

## 对外部署边界

- 监听非回环地址时必须设置 `PAPER2MD_SERVICE_TOKEN`；生产环境还应由反向代理提供用户登录、TLS、配额和审计。
- 使用 `PAPER2MD_ALLOWED_ORIGINS` 配置精确来源列表，不支持通配符。
- 不要把 `MINERU_TOKEN`、服务 token 或 MinerU 命令路径写入网页构建产物。
- Cloudflare Worker / Codex Sites 只适合托管 Reader 前端，不能直接执行本地 MinerU CLI。处理服务应部署在独立的受控 Node 主机或容器中。
- 当前任务数据不会自动删除，便于失败审计。投入多人使用前需增加明确的保留期和逐任务删除策略。

常用变量：`PAPER2MD_DATA_ROOT`、`PAPER2MD_SERVICE_HOST`、`PAPER2MD_SERVICE_PORT`、`PAPER2MD_ALLOWED_ORIGINS`、`PAPER2MD_MAX_PDF_BYTES`、`PAPER2MD_MAX_ACTIVE_JOBS`、`PAPER2MD_MINERU_TIMEOUT`、`PAPER2MD_PYTHON_PATH`、`MINERU_CLI_PATH`、`MINERU_BASE_URL`。

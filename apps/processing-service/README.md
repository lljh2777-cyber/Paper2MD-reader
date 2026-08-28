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

先确保 `mineru-open-api` 已安装并完成 CLI 自身认证。确定性 Viewer/视觉修复契约由带超时和内存上限的 TypeScript Worker生成，不再需要 Python。token 只保留在 MinerU CLI 配置或 `MINERU_TOKEN` 环境变量中。

```powershell
$env:MINERU_CLI_PATH = "C:\path\to\mineru-open-api.cmd"
npm run processing:build
npm run processing:start
```

默认仅监听 `127.0.0.1:8787`，允许 `http://127.0.0.1:4174` 和 `http://localhost:4174` 访问。随后运行 `npm run web:dev`。

## Clipper 直连发布

浏览器扩展在用户点击 **提取、校验并在 Reader 打开** 后，通过
`POST /api/v1/clippings` 提交受限 multipart：一个版本化元数据对象、提取后的 Markdown、
同一隔离 DOM 的源 HTML 快照，以及逐张本地化图片。服务端不接受扩展生成的 manifest，
而是重新调用共享 `clipper-core`，然后复用暂存校验与原子发布器。成功响应只返回不透明
`package_id`、已验证包描述和 `/reader/{package_id}`，扩展随即打开 Reader。

该端点必须带精确 `chrome-extension://` Origin；缺失 Origin、普通网页 Origin 和未知扩展
Origin 都会被拒绝。仓库 manifest 使用稳定本地扩展 ID，默认白名单与其一致；发布版可用
`PAPER2MD_ALLOWED_CLIPPER_IDS` 配置逗号分隔的精确扩展 ID。请求体上限由
`PAPER2MD_MAX_CLIPPING_BYTES` 控制，默认 84 MiB。扩展只在点击发布后请求固定
`http://127.0.0.1/*` 权限，不会默认取得所有本地网络权限。

扩展不会存储或发送 `PAPER2MD_SERVICE_TOKEN`。Reader 先创建 10 分钟有效的一次性配对码，
扩展从精确允许的 Origin 兑换后，只保存作用域为 `clippings:publish` 的随机凭证。
`POST /api/v1/clipper/credentials/revoke` 可撤销全部扩展凭证；主服务 token 与 MinerU token
始终不进入扩展。

## 本地 MCP stdio sidecar

构建 processing service 后，Codex、Claude 等本地 MCP host 可以直接启动
`apps/processing-service/dist/mcp-server.mjs`。该进程只通过 stdio 传输 MCP，并把经过
共享契约校验的命令转发到已经运行的本地 processing service：

```powershell
npm run processing:build
npm run processing:start
```

在 MCP host 中将 command 配置为 `node`，args 配置为上述 `mcp-server.mjs` 的绝对路径。
`npm run mcp:start` 可用于直接诊断，但正常情况下应由 MCP host 启动和管理该进程。
标准输出完全保留给 JSON-RPC；诊断信息只写标准错误。

当前注册 `get_service_status`、`resolve_paper`、`ingest_paper`、`get_ingest_job`，以及
只读的包查询与视觉候选查询。视觉写入必须先调用 `validate_visual_correction`，再用返回的
短时 token、完全相同的 correction 和 `confirm=true` 调用 `apply_visual_correction`；服务端
只原子更新包外 sidecar，并重新校验当前候选哈希。
`ingest_paper` 会产生网络与发布副作用，工具说明和 MCP annotations 均将其标为非只读、
非幂等，只有用户明确要求获取并发布时才应调用。高风险视觉修复不能单步直写，必须经过
候选查询、无写验证、短时 token 和 `confirm=true`，且只写用户 sidecar。

sidecar 默认只连接 `http://127.0.0.1:8787/`。可用
`PAPER2MD_MCP_SERVICE_URL` 改为另一个精确的 loopback HTTP origin，用
`PAPER2MD_MCP_TIMEOUT_MS` 设置 1000–120000 毫秒的命令超时。如果 processing service
启用了 `PAPER2MD_SERVICE_TOKEN`，sidecar 从同名环境变量读取并通过 Bearer header
传递；token 不写入命令行参数、工具结果或网页。sidecar 拒绝远程地址、凭据 URL、
路径、查询和 fragment。Reader WebMCP 是独立的浏览器渐进增强层。

### 可选本地 Streamable HTTP MCP

设置 `PAPER2MD_ENABLE_MCP_HTTP=true` 后，同一 processing service 会在
`POST /api/v1/mcp` 提供无状态 Streamable HTTP MCP，并复用 stdio sidecar 的同一组
窄工具与 command 校验。该入口默认关闭，只允许服务绑定在 loopback；Host、Origin、
Bearer token（若配置）和请求速率仍先由 processing service 校验。当前版本会明确拒绝在
非 loopback 绑定上启用它，因为远程多用户必须先接入真实 OAuth issuer、租户身份和独立
data root，不能把一个共享 service token 冒充成多用户隔离。

## 对外部署边界

- 监听非回环地址时必须设置 `PAPER2MD_SERVICE_TOKEN`；生产环境还应由反向代理提供用户登录、TLS、配额和审计。
- 使用 `PAPER2MD_ALLOWED_ORIGINS` 配置精确来源列表，不支持通配符。
- 不要把 `MINERU_TOKEN`、服务 token 或 MinerU 命令路径写入网页构建产物。
- Cloudflare Worker / Codex Sites 只适合托管 Reader 前端，不能直接执行本地 MinerU CLI。处理服务应部署在独立的受控 Node 主机或容器中。
- 当前任务数据不会自动删除，便于失败审计。投入多人使用前需增加明确的保留期和逐任务删除策略。

常用变量：`PAPER2MD_DATA_ROOT`、`PAPER2MD_SERVICE_HOST`、`PAPER2MD_SERVICE_PORT`、`PAPER2MD_ALLOWED_ORIGINS`、`PAPER2MD_ALLOWED_CLIPPER_IDS`、`PAPER2MD_MAX_PDF_BYTES`、`PAPER2MD_MAX_CLIPPING_BYTES`、`PAPER2MD_MAX_ACTIVE_JOBS`、`PAPER2MD_MINERU_TIMEOUT`、`PAPER2MD_READER_BASE_URL`、`MINERU_CLI_PATH`、`MINERU_BASE_URL`。

## 论文身份解析命令

服务端提供受限的 `POST /api/v1/commands` 命令入口。当前实现
`get_service_status`、`resolve_paper`、`ingest_paper`、`get_ingest_job`、四个只读包查询和
视觉修复三步命令；不会退化为任意路径、命令或 `eval`。例如：

```json
{
  "command": "resolve_paper",
  "input": { "query": "PMCID: PMC3531190" }
}
```

## 只读包查询

`list_packages` 会从 `PAPER2MD_DATA_ROOT` 下两种固定发布位置发现完整包：MinerU
任务的 `jobs/{package_id}/package`，以及自动剪藏的 `packages/{package_id}`。发现过程
不会依赖进程内任务状态，因此服务重启后仍可读取已发布包。目录必须没有符号链接，
文件清单、大小、哈希、源快照和 `validation.json` 必须一致；不完整、被修改、类型冲突
或含额外文件的目录会 fail closed，不会出现在列表中。

`read_package_manifest` 只接受不透明 `package_id`，返回已验证的 manifest 与 validation；
`read_article_section` 按稳定 `heading-0001` 形式的标题 ID 或绝对行号返回有行数和字节上限
的 Markdown，并提供 `next_start_line`；`list_figures` 返回包内相对路径、显示标签、图注与
已验证的页码/坐标元数据，不返回图片字节。论文正文和图注始终是数据，不是 Agent 指令。

新生成的剪藏 manifest 会为每张本地化图片写入 SHA-256。旧版完整剪藏包仍可发现，但若
图片条目只有大小绑定，会明确标记为 `legacy-size-bound`；正文与原始 HTML 仍须通过哈希。

解析器接受 PMID、PMCID、DOI、完整题名，以及包含明确标识的 doi.org、PubMed、PMC
和 Europe PMC URL。已知 URL 只在本地规范化为标识，不会抓取页面。题名查询并行使用
Europe PMC 与 Crossref，只有两个 provider 对同一带标识候选形成共识、题名相似度达到
严格门槛且相对其他候选有安全领先时才自动继续；否则返回最多五个确定性排序候选和
`AMBIGUOUS_MATCH`，要求改用候选的精确标识。解析器使用 Europe PMC 查询生物医学
元数据与开放全文，使用 Crossref 交叉验证 DOI 元数据；配置
`PAPER2MD_CONTACT_EMAIL` 后，才会调用要求 email 参数的 Unpaywall v2 API
补充合法开放获取位置。结果只包含结构化身份、不透明来源 ID、HTTPS 候选和
确定性提取路线，不会在解析阶段抓取第三方全文。

匹配规则为 fail closed：请求标识必须与返回记录精确一致；Europe PMC 与
Crossref 的题名或年份明显冲突时返回 `AMBIGUOUS_MATCH`；没有可验证开放全文
时返回 `FULL_TEXT_NOT_AVAILABLE` 及可行下一步。任意出版商 URL 仍不会在身份解析
阶段被抓取；这类页面应由用户打开后交给 Clipper，或改用其 DOI/PMID/PMCID。

## 自动导入合法开放全文

`ingest_paper` 是有副作用的显式命令。它复用同一身份解析结果，按 PMC JATS XML/HTML、
无需会话的开放 HTML、合法开放 PDF 的顺序选择来源。前两者确定性转换为 clipping 包；
PDF 回退复用 MinerU precision extract、完整校验和原子发布：

```json
{
  "command": "ingest_paper",
  "input": { "query": "PMCID: PMC3531190" }
}
```

命令立即返回不透明 `job_id`；使用 `get_ingest_job` 轮询。状态按
`queued → resolving → matched → acquiring → clipping → validating → publishing → ready`
推进。成功结果包含 `package_id` 和 `reader_url`。Reader 深链为
`/reader/{package_id}`，网页随后从 `GET /api/v1/packages/{package_id}` 和受限的
`.../files/{package-path}` 读取已发布包，不再要求 ZIP 中转。

服务端使用与浏览器扩展相同的 `clipper-core` 生成 `article.md`、图片索引与
`_clipping/manifest.json`；原始 HTML 只读保存在 `_clipping/source.html`。所有文件
先写入随机任务暂存目录，核对正文哈希、源快照哈希、图片索引、路径和容量后，
才通过同卷重命名原子发布。完整包目录已存在时拒绝覆盖。正文与网页内容只作为
不可信数据处理，不进入命令、路径或 Agent 指令解析。

通用获取层只接受无凭据 HTTPS；DNS 的全部结果必须是公网地址，连接固定到已验证地址，
最多三次重定向且每跳重新校验，并限制 MIME、正文/图片/PDF 大小和超时。请求不带 cookie，
不会绕过登录、付费墙、验证码或反机器人机制。需要浏览器会话/域名权限时任务返回结构化
`LOGIN_REQUIRED`/`DOMAIN_PERMISSION_REQUIRED` handoff。`PAPER2MD_READER_BASE_URL` 控制返回的 Reader 基址；仅允许
HTTPS，回环开发地址允许 HTTP。

相关配置：

- `PAPER2MD_CONTACT_EMAIL`：可选联系邮箱；同时用于服务标识和启用 Unpaywall。
- `PAPER2MD_RESOLVER_TIMEOUT_MS`：单个元数据请求超时，默认 12000。
- `PAPER2MD_ALLOWED_HOSTS`：逗号分隔的精确 Host 允许列表。回环默认仅允许
  当前端口上的 `127.0.0.1`、`localhost` 和 `[::1]`，用于抵御 DNS rebinding。

接口依据：[Europe PMC REST API](https://europepmc.org/RestfulWebService)、
[Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)、
[Unpaywall REST API](https://unpaywall.org/api)。

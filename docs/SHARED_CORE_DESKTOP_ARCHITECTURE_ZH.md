# Paper2MD Reader 共享核心与桌面端架构

## 目标结构

```text
Paper2MD-Reader/
├─ apps/
│  ├─ web/
│  └─ desktop/
├─ packages/
│  ├─ reader-core/
│  ├─ reader-ui/
│  ├─ agent-contracts/
│  └─ clipper-core/
├─ local-reader/     # 旧 URL/构建兼容入口
├─ sites-reader/     # 当前公开部署壳
└─ src/              # Obsidian 与逐步迁移中的旧实现
```

这是渐进式迁移。`local-reader/main.ts` 和 Sites 继续工作，但都转到新的 Web
入口；Obsidian 插件暂时保留现有构建路径。共享包通过源码入口复用已验证的契约，
后续可以在不改变公开 API 的前提下继续移动旧 `src/` 模块。

## 进程与能力边界

- `reader-core`：Reader/manifest 契约、PackageLoader、文件系统接口和平台选择接口；
- `reader-ui`：正文、Figure、图注、诊断、联动滚动和图片查看；
- `agent-contracts`：MCP/WebMCP 共用的强类型命令、论文查询、任务状态机和错误码；
- `clipper-core`：不依赖浏览器扩展 API 的确定性 Markdown、图片本地化与剪藏包投影；
- `apps/web`：浏览器目录选择与 `FileSystemDirectoryHandle`/`FileList` 适配；
- `apps/clipper-extension`：只负责当前标签页、登录态、按域权限和下载；
- Electron renderer：只使用 DOM、共享 UI 和 preload 暴露的类型化方法；
- Electron preload：通过 `contextBridge` 暴露固定方法，不暴露 `ipcRenderer`；
- Electron main：唯一可以读本地文件、显示系统选择框和启动 Paper2MD 的层。

Electron 窗口启用 `contextIsolation`、sandbox 和 `webSecurity`，关闭
`nodeIntegration`。渲染器只持有随机 root/PDF token，不能提交任意绝对路径。
main 对每个包内路径执行相对路径、根目录逃逸和符号链接检查。

## 当前桌面能力

1. 通过系统目录选择器初始化或切换本地 Paper2MD 论文库；
2. 左侧栏列出、搜索、收藏并打开论文库中重新校验通过的已发布内容包；
3. Renderer 只使用不透明 `package_id`，绝对路径解析和二次校验留在 main；
4. 通过系统目录选择器打开独立的已有 Paper2MD/MinerU 结果包；
5. 通过系统文件选择器选择并预览本地 PDF；
6. 选择输出父目录并启动 `paper2md convert`；
7. 显示 queued/running/succeeded/failed/cancelled 任务状态；
8. 取消运行中的任务并在成功后直接打开结果；
9. 引导用户打开 MinerU 官方 Token 管理页，并用操作系统保护的加密存储保存自有 Token；
10. 每次远程提取都单独确认 PDF 离开设备，使用固定 MinerU API 上传、轮询和下载；
11. 对远程 ZIP 执行网络、路径、类型、数量、解压大小与语义边界检查，隔离暂存后确定性校验并原子发布；
12. 使用与 Web/Obsidian 相同的 Reader v0.1、锚点、Figure/图注和联动逻辑；
13. 接受 Paper2MD manifest v0.8、v0.9 和文本复核派生包 v0.10 的 Reader 绑定。

论文库使用既有 processing-service 的发布布局，根目录下为固定的
`packages/`、`jobs/`、`staging/`、`sidecars/` 和 `state/`。选择整个盘符会被拒绝；
缺少版本标记的已保存路径、符号链接根目录、损坏状态文件和未通过清单绑定校验的
内容包均 fail closed。收藏只写论文库的用户状态，不写入源 PDF、Markdown、MinerU
JSON、原图或内容包 manifest。

Token 不下发 Reader，不进入论文库、日志、环境变量或命令行参数；Renderer 只获得
配置状态和末四位掩码。远程提取由 main 在请求内存中短暂解密 Token，只向固定 MinerU
API 发送 Bearer 凭据；上传和下载所用签名 URL 不携带该 Token。PDF 上传具有独立确认门，
默认选择取消。远程任务最多并发两个；在最终原子发布开始前取消可阻止本地发布，进入提交
边界后不再接受取消。取消不能保证已经提交的 MinerU 任务在远端停止。

MinerU 下载结果始终视为不可信数据：仅允许公开 HTTPS 默认端口，逐跳校验 DNS 和重定向，
限制 MIME、下载大小、超时、ZIP 条目数、路径深度、单文件与总解压大小，并且只接受唯一
Markdown、唯一 content-list JSON 和受支持位图。结果先写入隔离 job/staging，源 PDF、
Markdown、MinerU JSON 和原图保持不可变；只有确定性契约与清单校验通过才原子发布到
`packages/`，既有完整包不覆盖，失败或歧义一律 fail closed。

确定性 Viewer Index、视觉修复计划与人工审阅候选包均已迁移到共享 TypeScript
Worker运行时，并用迁移前 Python实现生成的金样本做输出等价测试。Worker具有提前资源
预算、内存上限和执行期限；桌面构建不再复制脚本，也不要求用户安装或配置 Python解释器。

直接转换目前不会替代 Paper2MD 的视觉复核流程。未来桌面任务层可在独立步骤中
加入 ROI 确认、`layout-prepare`、视觉 Agent 结果导入、`layout-apply` 和
`text-package`，共享 Reader 不需要因此获得 Node/Electron 权限。

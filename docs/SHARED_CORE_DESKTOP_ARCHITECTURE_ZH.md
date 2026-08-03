# Paper2MD Reader 共享核心与桌面端架构

## 目标结构

```text
Paper2MD-Reader/
├─ apps/
│  ├─ web/
│  └─ desktop/
├─ packages/
│  ├─ reader-core/
│  └─ reader-ui/
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
- `apps/web`：浏览器目录选择与 `FileSystemDirectoryHandle`/`FileList` 适配；
- Electron renderer：只使用 DOM、共享 UI 和 preload 暴露的类型化方法；
- Electron preload：通过 `contextBridge` 暴露固定方法，不暴露 `ipcRenderer`；
- Electron main：唯一可以读本地文件、显示系统选择框和启动 Paper2MD 的层。

Electron 窗口启用 `contextIsolation`、sandbox 和 `webSecurity`，关闭
`nodeIntegration`。渲染器只持有随机 root/PDF token，不能提交任意绝对路径。
main 对每个包内路径执行相对路径、根目录逃逸和符号链接检查。

## 当前桌面能力

1. 通过系统目录选择器打开已有 Paper2MD 包；
2. 通过系统文件选择器选择并预览本地 PDF；
3. 选择输出父目录并启动 `paper2md convert`；
4. 显示 queued/running/succeeded/failed/cancelled 任务状态；
5. 取消运行中的任务并在成功后直接打开结果；
6. 使用与 Web/Obsidian 相同的 Reader v0.1、锚点、Figure/图注和联动逻辑；
7. 接受 Paper2MD manifest v0.8、v0.9 和文本复核派生包 v0.10 的 Reader 绑定。

直接转换目前不会替代 Paper2MD 的视觉复核流程。未来桌面任务层可在独立步骤中
加入 ROI 确认、`layout-prepare`、视觉 Agent 结果导入、`layout-apply` 和
`text-package`，共享 Reader 不需要因此获得 Node/Electron 权限。

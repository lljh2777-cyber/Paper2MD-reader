# After-MinerU Converter — Unofficial

After‑MinerU Converter 是一个单一用途的 Chrome 扩展：把你明确选择的 PDF 直接交给你自己的 MinerU API 账户处理，在浏览器本地校验返回的 ZIP，然后下载未经改写的 MinerU 原始结果。

## 工作方式

1. 选择一个不超过 200MB 的 PDF。
2. 临时输入你自己的 MinerU Token，并确认数据边界。
3. 扩展按本次任务申请三个固定 MinerU 域名权限。
4. PDF 直传 MinerU 的签名上传地址；扩展轮询任务、下载并校验结果 ZIP。
5. ZIP 校验通过后由浏览器下载，随后扩展尝试撤销本次域名权限。

## 隐私边界

- 你的 MinerU Token 会直接用于访问 MinerU API；你选择的 PDF 将直接上传至 MinerU 提供的存储地址，并由 MinerU 服务处理。转换结果随后从 MinerU/OpenXLab 下载。Paper2MD 不接收或保存 Token、PDF及转换结果。请勿上传包含机密、个人隐私或无权处理的文件。
- 扩展会在你的设备内临时处理 Token、PDF 与结果 ZIP，并按上述边界直接发送或接收；Paper2MD 服务器不接收、不托管或保存这些数据。
- Token 只保存在当前扩展页内存，不写 localStorage、IndexedDB、cookie、chrome.storage、URL 或日志。
- 扩展不读取当前网页标签页，不注入内容脚本，不访问浏览历史，不连接本地桌面服务。
- 取消只停止浏览器端请求；已经上传的数据和 MinerU 任务仍受 MinerU 自身政策约束。

## 安全校验

扩展拒绝意外域名、自定义端口、重定向、不安全 ZIP 路径、重复条目、异常大小，以及缺少唯一 Markdown、缺少 content-list 或同版本 content-list 重复的结果。MinerU 同时返回 stable 与 v2 两种 content-list 时可通过。校验通过后下载的 MinerU 原始 ZIP 不会被扩展改写。

这是独立第三方工具，与 MinerU / OpenDataLab 无隶属或背书关系。MinerU Token 由用户在 MinerU 官方网站创建和管理。

支持与问题反馈：https://github.com/lljh2777-cyber/Paper2MD-reader/issues

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "支持 | After-MinerU",
  description: "After-MinerU Chrome 扩展的安装、转换与隐私支持。"
};

export default function SupportPage() {
  return (
    <main className="site-legal">
      <nav className="legal-nav" aria-label="页面导航">
        <a className="site-brand" href="/">After‑<span>MinerU</span><small>by Paper2MD</small></a>
        <a href="/privacy">隐私政策</a>
      </nav>
      <article>
        <header>
          <p className="site-kicker">Extension Support</p>
          <h1>扩展支持</h1>
          <p>适用于 After‑MinerU Converter Chrome 商店版。</p>
        </header>

        <section>
          <h2>开始转换</h2>
          <p>上传前须知：你的 MinerU Token 会直接用于访问 MinerU API；你选择的 PDF 将直接上传至 MinerU 提供的存储地址，并由 MinerU 服务处理。转换结果随后从 MinerU/OpenXLab 下载。Paper2MD 不接收或保存 Token、PDF及转换结果。请勿上传包含机密、个人隐私或无权处理的文件。</p>
          <ol>
            <li>点击浏览器工具栏中的 After‑MinerU 图标，打开独立转换页。</li>
            <li>选择不超过 200MB 的 PDF，输入你自己的 MinerU Token，并阅读、勾选数据边界。</li>
            <li>同意本次任务所需的三个固定 MinerU 域名权限。</li>
            <li>等待上传、解析、下载与 ZIP 校验完成，再保存结果。</li>
          </ol>
        </section>

        <section>
          <h2>常见问题</h2>
          <details><summary>为什么需要三个网站权限？</summary><p><code>mineru.net</code> 创建和查询任务，阿里云 OSS 接收签名上传的 PDF，OpenXLab CDN 提供结果 ZIP。扩展不申请任意网站权限。</p></details>
          <details><summary>为什么网页端不能直接输入 Token？</summary><p>普通网站环境的 MinerU API 跨域预检当前不可用。扩展在浏览器明确授权后直连，不增加会经手 Token 或 PDF 的 Paper2MD 云代理。</p></details>
          <details><summary>取消后 MinerU 会立即删除文件吗？</summary><p>不一定。取消只停止浏览器端请求并清除当前页面内存中的 Token；已经上传的数据与任务由 MinerU 的政策控制。必要时请在 MinerU Token 管理页吊销 Token。</p></details>
          <details><summary>ZIP 为什么被拒绝？</summary><p>扩展会拒绝路径穿越、重复条目、异常大小、非唯一 Markdown、完全缺少 content-list，或同一版本 content-list 重复的结果。MinerU 同时返回 stable 与 v2 两种 content-list 属于支持的正常结构。</p></details>
        </section>

        <section>
          <h2>联系开发者</h2>
          <p>请通过公开的 <a href="https://github.com/lljh2777-cyber/Paper2MD-reader/issues" target="_blank" rel="noreferrer">Paper2MD Reader GitHub Issues</a> 联系开发者，并附上扩展版本、Chrome 版本、失败阶段和界面错误文字。Chrome Web Store 商品详情页也会指向同一支持渠道。</p>
          <p>GitHub Issue 是公开内容。不要发送 MinerU Token、PDF、签名上传地址、结果下载地址、私人论文内容或其他敏感信息。</p>
          <p>隐私与数据处理说明见 <a href="/privacy">After‑MinerU 隐私政策</a>。</p>
        </section>

        <section lang="en">
          <h2>English support</h2>
          <p>Your MinerU Token is used directly to access the MinerU API. The PDF you select is uploaded directly to a storage address provided by MinerU and processed by MinerU. The conversion result is then downloaded from MinerU/OpenXLab. Paper2MD does not receive or retain the Token, PDF, or conversion result. Do not upload files that contain confidential or personal information, or that you are not authorized to process.</p>
          <p>Open an issue at <a href="https://github.com/lljh2777-cyber/Paper2MD-reader/issues" target="_blank" rel="noreferrer">Paper2MD Reader GitHub Issues</a>. Include the extension version, Chrome version, failed stage, and visible error text. Issues are public: never include your MinerU token, PDF, signed upload URL, result URL, private paper content, or other sensitive information.</p>
        </section>
      </article>
      <footer className="legal-footer"><a href="/">返回 After‑MinerU</a><span>Paper2MD 不提供云端论文库。</span></footer>
    </main>
  );
}

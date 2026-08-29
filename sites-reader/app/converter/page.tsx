import type { Metadata } from "next";
import { ProjectLinks } from "../project-links";

export const metadata: Metadata = {
  title: "After-MinerU Converter | Chrome 精准转换扩展",
  description: "使用自己的 MinerU Token，把明确选择的 PDF 直传 MinerU，在浏览器本地校验并下载原始结果 ZIP。"
};

export default function ConverterPage() {
  return (
    <main className="converter-page">
      <nav className="legal-nav" aria-label="页面导航">
        <a className="site-brand" href="/converter">After‑<span>MinerU</span><small>Converter · Unofficial</small></a>
        <div className="converter-nav-links"><a href="/privacy">隐私政策</a><a href="/support">支持</a></div>
      </nav>

      <section className="converter-hero">
        <div>
          <p className="site-kicker">Chrome Extension · Single Purpose</p>
          <h1>PDF 直传 MinerU，<br />结果仍由你带走。</h1>
          <p className="converter-lede">After‑MinerU Converter 只做一件事：使用你自己的 MinerU API 账户处理你明确选择的 PDF，在当前设备校验结果，并下载未经改写的 MinerU 原始 ZIP。</p>
          <p className="converter-disclosure">你的 MinerU Token 会直接用于访问 MinerU API；你选择的 PDF 将直接上传至 MinerU 提供的存储地址，并由 MinerU 服务处理。转换结果随后从 MinerU/OpenXLab 下载。Paper2MD 不接收或保存 Token、PDF及转换结果。请勿上传包含机密、个人隐私或无权处理的文件。</p>
          <div className="converter-actions">
            <button className="site-disabled" type="button" disabled>Chrome Web Store 审核准备中</button>
            <a href="https://mineru.net/apiManage/token" target="_blank" rel="noreferrer">管理 MinerU Token</a>
          </div>
          <p className="converter-status"><span aria-hidden="true">●</span> 2026-08-29 已用无敏感 PDF 完成真实 MinerU 上传、处理、下载和本地 ZIP 校验；公开安装入口将在审核通过后开放。</p>
        </div>
        <aside className="converter-flow" aria-label="精准转换数据流">
          <p><span>01</span><b>本地选择</b><small>扩展先检查 PDF 文件头和大小，不会自动上传。</small></p>
          <p><span>02</span><b>明确授权</b><small>你确认边界后，扩展仅为本次任务申请三个固定 MinerU 域名。</small></p>
          <p><span>03</span><b>直连处理</b><small>Token 发往 MinerU API；PDF 直传其签名 OSS 地址。</small></p>
          <p><span>04</span><b>校验下载</b><small>结果从 OpenXLab CDN 下载，在设备内校验后保存原始 ZIP。</small></p>
        </aside>
      </section>

      <section className="converter-boundaries" aria-labelledby="converter-boundaries-title">
        <div>
          <p className="site-kicker">Data Boundary</p>
          <h2 id="converter-boundaries-title">扩展临时处理；Paper2MD 服务器不接收。</h2>
        </div>
        <div className="converter-boundary-grid">
          <article><b>Token</b><p>仅由当前扩展页临时持有并发送到 <code>mineru.net</code>；不写入浏览器持久存储、URL 或日志。</p></article>
          <article><b>PDF</b><p>只在你点击开始后，直接上传到 MinerU 返回的阿里云 OSS 签名地址。</p></article>
          <article><b>结果 ZIP</b><p>从 MinerU 返回的 OpenXLab CDN 地址下载；路径、CRC、大小和文件清单通过检查后保持原字节不变。</p></article>
          <article><b>浏览器权限</b><p>无必需权限，不读取标签页、历史、cookie、剪贴板或本地桌面服务；任务后尝试自动撤销三个域名权限。</p></article>
        </div>
      </section>

      <section className="converter-caveat">
        <div><p className="site-kicker">Before You Start</p><h2>这是实验性的临时 Token 路径。</h2></div>
        <ul>
          <li>它不等同于桌面端安全凭据库；刷新、关闭或任务结束会清除页面中的 Token 引用，但 Token 本身会持续有效，直到你在 MinerU 吊销。</li>
          <li>取消只停止浏览器端请求，不能保证删除已经上传的文件或远端任务；第三方保留由 MinerU 及其基础设施政策决定。</li>
          <li>请勿上传包含机密、个人隐私或你无权交由 MinerU 处理的文件。</li>
          <li>这是独立第三方兼容工具，与 MinerU、OpenDataLab、Alibaba Cloud 或 OpenXLab 无隶属或背书关系。</li>
        </ul>
      </section>

      <footer className="legal-footer"><a href="/">返回 After‑MinerU 工作台</a><div className="legal-footer-links"><a href="/support">扩展支持</a><ProjectLinks /></div></footer>
    </main>
  );
}

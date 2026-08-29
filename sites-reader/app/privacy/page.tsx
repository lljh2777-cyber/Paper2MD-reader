import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "隐私政策 | After-MinerU",
  description: "After-MinerU 网页工作台与 Chrome 扩展的数据处理、权限和第三方服务边界。"
};

export default function PrivacyPage() {
  return (
    <main className="site-legal">
      <nav className="legal-nav" aria-label="页面导航">
        <a className="site-brand" href="/">After‑<span>MinerU</span><small>by Paper2MD</small></a>
        <a href="/support">支持</a>
      </nav>
      <article>
        <header>
          <p className="site-kicker">Privacy Policy</p>
          <h1>隐私政策</h1>
          <p>最后更新：2026 年 8 月 29 日</p>
        </header>

        <section>
          <h2>简明结论</h2>
          <p>你的 MinerU Token 会直接用于访问 MinerU API；你选择的 PDF 将直接上传至 MinerU 提供的存储地址，并由 MinerU 服务处理。转换结果随后从 MinerU/OpenXLab 下载。Paper2MD 不接收或保存 Token、PDF及转换结果。请勿上传包含机密、个人隐私或无权处理的文件。</p>
          <p>After‑MinerU 不提供云端论文库。Paper2MD 服务器不接收、托管或保存你在网页工作台或扩展中选择的论文、MinerU Token 或转换结果，也不使用广告、用户行为分析、数据销售或个性化推荐。</p>
          <p>Chrome 扩展会在你的设备内临时处理你主动提供的数据，并按下述边界直接发送给 MinerU 相关第三方。精准转换不是纯本地处理。</p>
        </section>

        <section>
          <h2>网页工作台</h2>
          <ul>
            <li>你打开的 Markdown、ZIP、论文包、目录和浏览器本地 PDF 投影仅在当前设备中处理。</li>
            <li>站点默认不把论文写入 IndexedDB、localStorage、cookie 或 Paper2MD 后端。</li>
            <li>结果由你下载为 ZIP，或写入你明确授权的本地目录；源文件保持不变。</li>
            <li>站点托管与 CDN 提供方 Cloudflare 可能为页面交付、防滥用与安全目的处理标准 HTTP 元数据（例如 IP、请求时间、User-Agent、请求路径），并设置必要的安全 cookie（例如 <code>__cf_bm</code>）。Paper2MD 不使用这些数据分析你的论文内容或建立用户画像。</li>
          </ul>
        </section>

        <section>
          <h2>Chrome 扩展的精准转换</h2>
          <div className="legal-table" role="table" aria-label="精准转换数据流">
            <div role="row"><b role="columnheader">数据</b><b role="columnheader">接收方与用途</b><b role="columnheader">Paper2MD 服务器</b></div>
            <div role="row"><span role="cell">文件名、由本页临时持有的 MinerU Token、转换选项</span><span role="cell">MinerU / OpenDataLab，通过 <code>https://mineru.net</code> 创建并查询转换任务</span><span role="cell">不接收、不保存</span></div>
            <div role="row"><span role="cell">你选择的 PDF</span><span role="cell">Alibaba Cloud OSS，通过 MinerU 返回的 <code>mineru.oss-cn-shanghai.aliyuncs.com</code> 签名地址接收上传</span><span role="cell">不接收、不保存</span></div>
            <div role="row"><span role="cell">结果 ZIP</span><span role="cell">OpenXLab CDN，通过 MinerU 返回的 <code>cdn-mineru.openxlab.org.cn</code> 签名地址提供下载；扩展随后在本地校验</span><span role="cell">不接收、不保存</span></div>
          </div>
          <p>扩展只向这三个固定 HTTPS 域名申请可选权限，并在单次任务结束后尝试自动撤销。扩展不申请当前标签页、网页脚本、浏览历史、cookie、剪贴板、下载管理或持久存储权限。</p>
          <p>MinerU / OpenDataLab、Alibaba Cloud OSS、OpenXLab CDN 与 Cloudflare 是独立第三方，其数据保留、安全和跨境处理受各自政策约束。After‑MinerU 与这些第三方无隶属或背书关系。</p>
        </section>

        <section>
          <h2>Token、保留与删除</h2>
          <ul>
            <li>MinerU API Token 仅由当前扩展页临时持有，不写入 localStorage、IndexedDB、cookie、chrome.storage、URL 或应用日志。Token 本身会继续有效，直到你在 MinerU 吊销。</li>
            <li>开始任务后输入框立即清空；任务结束、取消、刷新或关闭页面时，当前页面持有的 Token 引用会被释放。</li>
            <li>“取消”只能停止浏览器端请求并清除本页 Token，不能保证撤销已经上传的 PDF、已创建的 MinerU 任务或第三方侧的保留。</li>
            <li>你可以在 <a href="https://mineru.net/apiManage/token" target="_blank" rel="noreferrer">MinerU Token 管理</a>中吊销 Token，并通过 <a href="https://mineru.net/ecosystem" target="_blank" rel="noreferrer">MinerU 法律协议入口</a>查看其政策。</li>
            <li>网页工作台没有 Paper2MD 云端论文记录可供删除；关闭页面会结束内存会话。浏览器本地下载文件或获授权目录内容由你自行管理。</li>
          </ul>
        </section>

        <section>
          <h2>安全、用途限制与用户控制</h2>
          <p>扩展拒绝非固定域名、非默认 HTTPS 端口、重定向、带凭据 URL、不安全 ZIP 路径、重复条目、异常数量或异常大小的结果。MinerU 原始 ZIP 只在结构、路径、大小与 CRC 校验通过后下载，且不会被扩展重写。</p>
          <p>扩展收集、使用和传输用户数据仅用于用户主动发起的 PDF 转换、结果校验与下载。它遵守 Chrome Web Store User Data Policy 及其 Limited Use 要求：不会出售数据，不用于广告、信用判断、与单一用途无关的分析或建立用户画像，也不会允许人工读取内容，除非为用户明确请求的安全或支持目的且取得额外同意，或法律要求。</p>
          <p>后续 Reader 显示修复只产生派生投影或 sidecar；源 PDF、Markdown、MinerU JSON、原图和通过校验的原始 ZIP 保持不变，冲突或证据不足时安全停止。</p>
        </section>

        <section>
          <h2>联系、儿童与变更</h2>
          <p>隐私或安全问题请通过公开的 <a href="https://github.com/lljh2777-cyber/Paper2MD-reader/issues" target="_blank" rel="noreferrer">Paper2MD Reader GitHub Issues</a> 或 <a href="/support">支持页面</a>联系。Issue 内容公开；不要粘贴 Token、签名 URL，也不要发送论文内容或其他敏感信息。</p>
          <p>本产品不是面向儿童设计的服务，也不会有意收集儿童个人信息。政策发生实质变化时，本页会更新日期和说明。</p>
        </section>

        <section lang="en">
          <h2>English privacy policy</h2>
          <p><b>Precision conversion notice.</b> Your MinerU Token is used directly to access the MinerU API. The PDF you select is uploaded directly to a storage address provided by MinerU and processed by MinerU. The conversion result is then downloaded from MinerU/OpenXLab. Paper2MD does not receive or retain the Token, PDF, or conversion result. Do not upload files that contain confidential or personal information, or that you are not authorized to process.</p>
          <p><b>Scope and controller.</b> After‑MinerU covers the local web workbench and the After‑MinerU Converter Chrome extension. It does not operate a cloud paper library. Paper2MD servers do not receive, host, or retain PDFs, MinerU tokens, or result archives selected in these products.</p>
          <p><b>Local web workbench.</b> Markdown, ZIP packages, directories, and local PDF projections are processed on the current device by default and are not written to IndexedDB, localStorage, cookies, or a Paper2MD backend. Results are downloaded or written only to a directory the user explicitly authorizes. Cloudflare, as the site hosting/CDN provider, may process standard HTTP metadata and use necessary security cookies such as <code>__cf_bm</code> for delivery, abuse prevention, and security.</p>
          <p><b>Extension data and recipients.</b> When the user explicitly starts precision conversion, the extension temporarily processes the filename, MinerU token, selected PDF, conversion options, and result ZIP on the user&apos;s device. The filename, token, and options go to MinerU / OpenDataLab at <code>mineru.net</code>; the PDF goes directly to the MinerU-provided signed Alibaba Cloud OSS address; the result ZIP comes from the MinerU-provided OpenXLab CDN address. Paper2MD servers receive none of these items.</p>
          <p><b>Permissions and retention.</b> The extension requests only the three disclosed optional HTTPS origins for the current task and attempts to remove them afterward. It does not request active-tab, content-script, history, cookie, clipboard, download-management, or persistent-storage permissions. The token stays only in live page memory and is cleared from the page on start, completion, cancellation, refresh, or close. The token itself remains valid until the user revokes it at MinerU. Cancellation cannot guarantee deletion of an already uploaded PDF or remote task; third-party retention is controlled by the respective provider.</p>
          <p><b>Security and Limited Use.</b> The extension validates fixed origins and ports, rejects redirects and credential-bearing URLs, and checks ZIP structure, paths, sizes, aliases, CRC values, and required files before download. User data is used only to perform the user-initiated conversion, validation, and download. Use complies with the Chrome Web Store User Data Policy, including Limited Use requirements. Data is not sold or used for advertising, credit decisions, unrelated analytics, profiling, or human review except with additional consent for user-requested support/security or when legally required.</p>
          <p><b>User control and contact.</b> Close the local session, delete locally downloaded files, revoke directory permission, or revoke the MinerU token to exercise the controls available to you. For privacy or security questions, use the public <a href="https://github.com/lljh2777-cyber/Paper2MD-reader/issues" target="_blank" rel="noreferrer">Paper2MD Reader GitHub Issues</a> or the <a href="/support">support page</a>. Issues are public; do not send tokens, signed URLs, paper content, or other sensitive information. This product is not directed to children. Material changes will be reflected by an updated date on this page.</p>
        </section>
      </article>
      <footer className="legal-footer"><a href="/">返回 After‑MinerU</a><span>独立第三方工具，与 MinerU / OpenDataLab 无隶属或背书关系。</span></footer>
    </main>
  );
}

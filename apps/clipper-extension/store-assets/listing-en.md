# Draft only — do not submit until the extension UI is fully localized

# After-MinerU Converter — Unofficial

After‑MinerU Converter has one purpose: send a PDF you explicitly select through your own MinerU API account, validate the returned archive locally in Chrome, and download the unchanged MinerU result ZIP.

## How it works

1. Select a PDF up to 200 MB.
2. Temporarily enter your own MinerU Token and accept the data-boundary notice.
3. The extension requests access to three fixed MinerU-related HTTPS origins for this task.
4. The PDF is uploaded directly to MinerU's signed upload URL. The extension polls the task, downloads the result, and validates the ZIP locally.
5. After the download is triggered, the extension attempts to remove the three host permissions.

## Privacy boundary

- Your MinerU Token is used directly to access the MinerU API. The PDF you select is uploaded directly to a storage address provided by MinerU and processed by MinerU. The conversion result is then downloaded from MinerU/OpenXLab. Paper2MD does not receive or retain the Token, PDF, or conversion result. Do not upload files that contain confidential or personal information, or that you are not authorized to process.
- The extension temporarily processes the Token, PDF, and result ZIP on your device and transfers them directly as described above. Paper2MD servers do not receive or retain them.
- The Token exists only in the live extension page memory. It is not written to localStorage, IndexedDB, cookies, chrome.storage, URLs, or logs.
- The Store extension does not read the active tab, inject content scripts, access browsing history, or connect to a local desktop service.
- Cancel stops the browser-side request and clears the page's Token reference; data already uploaded to MinerU remains governed by MinerU's own policies.

## Local validation

The extension rejects unexpected origins or ports, redirects, unsafe ZIP paths, duplicate entries, excessive sizes, and archives without exactly one Markdown file or at least one recognized content-list variant. At most one stable and one v2 content-list are accepted; MinerU may return both together. The original result ZIP is never rewritten.

This is an independent third-party tool and is not affiliated with or endorsed by MinerU or OpenDataLab. Users create and manage their MinerU Token on the official MinerU website.

Public support: https://github.com/lljh2777-cyber/Paper2MD-reader/issues

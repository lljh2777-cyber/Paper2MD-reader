# Paper2MD Web Clipper

This is a standalone Chromium Manifest V3 extension for extracting the currently
rendered paper page into a local Paper2MD clipping package. It does not depend on
Obsidian and does not call AI.

Deterministic Markdown/image localization rules live in `packages/clipper-core/`.
This extension remains the browser adapter responsible for the active tab, publisher
session and per-origin permission prompts. It submits structured clipping parts to the
loopback processing service for staged validation and atomic publication; ZIP is a
separate export/backup action.

## Build and load

```powershell
npm install
npm run clipper:build
```

Load `apps/clipper-extension/dist/` as an unpacked extension from
`chrome://extensions` or `edge://extensions`.

## Workflow

1. In Reader, choose **连接浏览器 Clipper** and create a 10-minute pairing ID/code.
2. Open the extension, approve only the fixed loopback origin, and redeem that one-time code.
3. Open a paper full-text page and select **提取、校验并在 Reader 打开**.
4. Approve only the image origins needed for this page.
5. The extension submits metadata, extracted Markdown, the source HTML snapshot and localized
   images as bounded multipart fields. The service rebuilds the package with `clipper-core`,
   validates it in staging, atomically publishes it and returns an opaque `package_id`.
6. The extension opens the returned `/reader/{package_id}` URL. No ZIP selection is required.

Use **导出 ZIP 备份** only when an offline export is desired.

The package contains an immutable `article.md`, localized raster images under
`images/`, and `_clipping/manifest.json`. Reader display pairing remains a runtime
projection and does not write back to the Markdown.

Before extraction, the extension normalizes publisher figure markup in an isolated
DOM copy. In particular, Nature/Springer pages that keep a short figure title in
`figcaption` and the descriptive legend in a separate, figure-bound element are
joined into one adjacent Markdown caption. The live page is not modified.

## Security boundary

- Page access is granted by `activeTab` only after the user clicks the extension.
- The manifest pins a stable unpacked-extension identity. The processing service accepts
  `/api/v1/clippings` only from that exact `chrome-extension://` origin by default and also
  requires an origin-bound, revocable `clippings:publish` credential.
- No persistent content script is installed on arbitrary pages.
- Image access uses optional per-origin host permissions.
- Image requests omit credentials and referrers, reject redirects, and do not target literal private/local network addresses.
- SVG, unsupported MIME types, oversized images and unsafe archive paths are rejected.
- Defuddle `useAsync` is disabled, preventing fallback calls to third-party extractors.
- Failed images become ordinary source links rather than remotely loaded Reader assets.
- The service ignores client manifests and rebuilds them from strictly typed fields. It never
  accepts arbitrary paths, fetch targets, commands or evaluation input through the bridge.

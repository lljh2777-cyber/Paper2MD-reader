# Paper2MD Web Clipper

This is a standalone Chromium Manifest V3 extension for extracting the currently
rendered paper page into a local Paper2MD clipping package. It does not depend on
Obsidian and does not call AI.

## Build and load

```powershell
npm install
npm run clipper:build
```

Load `apps/clipper-extension/dist/` as an unpacked extension from
`chrome://extensions` or `edge://extensions`.

## Workflow

1. Open a paper full-text page.
2. Click the extension and select **提取并保存阅读包**.
3. Approve only the image origins needed for this page, if prompted.
4. Save the generated `.paper2md.zip`.
5. In Paper2MD Web Reader choose **导入网页剪藏** and select that archive.

The package contains an immutable `article.md`, localized raster images under
`images/`, and `_clipping/manifest.json`. Reader display pairing remains a runtime
projection and does not write back to the Markdown.

## Security boundary

- Page access is granted by `activeTab` only after the user clicks the extension.
- No persistent content script is installed on arbitrary pages.
- Image access uses optional per-origin host permissions.
- Image requests omit credentials and referrers, reject redirects, and do not target literal private/local network addresses.
- SVG, unsupported MIME types, oversized images and unsafe archive paths are rejected.
- Defuddle `useAsync` is disabled, preventing fallback calls to third-party extractors.
- Failed images become ordinary source links rather than remotely loaded Reader assets.

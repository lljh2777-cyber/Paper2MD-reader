# After-MinerU Companion

This is a standalone Chromium Manifest V3 extension for extracting the currently
rendered paper page into a local Paper2MD clipping package. It does not depend on
Obsidian and does not call AI.

The companion also contains an experimental precision-conversion page. That page
asks for three explicit MinerU transfer origins, keeps the pasted MinerU Token only
in the live extension page, and uploads the selected PDF directly to MinerU's signed
object-storage URL for processing by MinerU. It validates the result downloaded from
MinerU/OpenXLab and saves the immutable ZIP for explicit import into the web Reader.
Closing or refreshing the page, or finishing the task, clears the Token input. No
Paper2MD backend receives or retains the Token, PDF, or result. Users must not upload
files containing confidential information, personal data, or material they are not
authorized to process.

The Chrome Web Store release is a separate, single-purpose build named
**After-MinerU Converter — Unofficial**. It contains only the precision page,
its archive-validation worker, a minimal toolbar service worker, fixed MinerU
optional host permissions, bundled fflate code, icons, locales, and third-party
notices. It does not contain web clipping, active-tab access, desktop pairing,
persistent storage, or the Companion's pinned developer key.

Version 0.2.0 is publicly available from the
[Chrome Web Store](https://chromewebstore.google.com/detail/bnbkbfepjoaidicdjcdmklofhnaleamm).
Its permanent extension ID is `bnbkbfepjoaidicdjcdmklofhnaleamm`.

Deterministic Markdown/image localization rules live in `packages/clipper-core/`.
This extension remains the browser adapter responsible for the active tab, publisher
session and per-origin permission prompts. Its default Sites-only path builds a bounded
ZIP locally for download and later import into the web Reader. Sending a clipping to the
loopback processing service remains an optional desktop workflow.

## Build and load

```powershell
npm install
npm run clipper:build
```

Load `apps/clipper-extension/dist/` as an unpacked extension from
`chrome://extensions` or `edge://extensions`.

Build and verify the Store upload ZIP separately:

```powershell
npm run clipper:store:package
```

Run `npm run clipper:store:unpack`, then load the hash-isolated unpacked
directory printed by the command for final testing. The exact verified upload
artifact is `output/after-mineru-converter-0.2.0.zip`. Store listing fields,
privacy declarations, reviewer instructions, and asset paths are documented in
`apps/clipper-extension/STORE_SUBMISSION.md`.

## Workflow

1. Open a paper full-text page and select **生成 ZIP 并下载**.
2. Approve only the image origins needed for this page.
3. Import the downloaded package into the web Reader. No Paper2MD backend is involved.

For precision conversion, open the extension and select **精准转换 PDF（实验性）**.
The dedicated extension page stays open for the full allocate/upload/poll/download
workflow and displays each external-data boundary before requesting permission.

To send directly into the desktop Reader instead, pair the extension with the loopback
processing service and use the optional desktop action.

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
- Precision conversion has no persistent Token storage and accepts only the documented
  MinerU API, upload, and result-download hostnames. A changed or unexpected hostname
  fails closed instead of requesting broader access.
- Precision ZIPs are size-, count-, path-, UTF-8-, JSON-, and content-list-validated
  before download. The MinerU archive itself is not rewritten.
- The service ignores client manifests and rebuilds them from strictly typed fields. It never
  accepts arbitrary paths, fetch targets, commands or evaluation input through the bridge.

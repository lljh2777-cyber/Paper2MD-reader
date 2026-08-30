# After-MinerU Converter — Chrome Web Store submission

This document describes the single-purpose Store build. It does not apply to
the broader unpacked `After-MinerU Companion` developer build.

## Upload artifact

- Build: `npm run clipper:store:package`
- Prepare an exact unpacked Chrome test directory: `npm run clipper:store:unpack`
- ZIP: `output/after-mineru-converter-0.2.0.zip`
- Manifest: `apps/clipper-extension/manifest.store.json`
- Default language: Chinese (Simplified)
- Category: Productivity
- Homepage: https://after-mineru.lljh2777.chatgpt.site/converter
- Privacy policy: https://after-mineru.lljh2777.chatgpt.site/privacy
- Support: https://after-mineru.lljh2777.chatgpt.site/support
- Public support channel: https://github.com/lljh2777-cyber/Paper2MD-reader/issues

## Published release

- Status: Publicly available after Chrome Web Store review
- Published version: 0.2.0
- Product ID: `bnbkbfepjoaidicdjcdmklofhnaleamm`
- Store listing: https://chromewebstore.google.com/detail/bnbkbfepjoaidicdjcdmklofhnaleamm

Do not upload `apps/clipper-extension/dist/`: that directory is the Companion
developer build and intentionally has broader clipping and desktop-pairing
capabilities.

For unpacked Chrome testing, load the hash-isolated directory printed by
`clipper:store:unpack`. Do not load the reusable `dist-store` staging directory,
because empty directories left by an older locale can make Chrome reject it even
though those directories are not present in the verified ZIP.

## Single purpose

Convert one PDF explicitly selected by the user through the user's MinerU API
account, validate the returned archive locally, and download the unchanged
MinerU result ZIP.

The Store build does not read browser tabs, inject scripts into sites, connect
to a loopback desktop service, store credentials, provide a cloud paper library,
or load executable code from the network.

## Permission justifications

The extension has no required permissions and no persistent host permissions.
It asks for these optional hosts only after the user selects a validated PDF,
enters a temporary Token, accepts the disclosure, and starts the task:

- `https://mineru.net/*`: allocate the upload and poll the user's extraction task.
- `https://mineru.oss-cn-shanghai.aliyuncs.com/*`: upload the selected PDF to the exact signed MinerU URL.
- `https://cdn-mineru.openxlab.org.cn/*`: download the exact signed MinerU result URL.

The extension attempts to remove all three permissions when the task finishes.
One in-memory Web Lock prevents parallel conversion tabs from revoking another
active tab's permission lease.

## Privacy-practices answers

Disclose the following in the Dashboard: the extension processes these data on
the user's device and sends them directly to the listed third parties, while
Paper2MD servers do not receive or retain them:

The user's MinerU Token directly accesses the MinerU API. The selected PDF is
uploaded directly to a MinerU-provided storage address and processed by MinerU.
The result is downloaded from MinerU/OpenXLab. Paper2MD does not receive or retain
the Token, PDF, or result. Users are warned not to upload confidential or personal
files, or files they are not authorized to process.

- Authentication information: the user-provided MinerU Token is sent only to
  `mineru.net` in an Authorization header and exists only in the live page memory.
- User-provided content: the filename is sent to `mineru.net`; the selected PDF
  is sent directly to the MinerU signed OSS URL; the result is requested from
  the MinerU/OpenXLab CDN URL.
- Third parties: MinerU/OpenDataLab and the infrastructure origins returned by
  MinerU receive the data strictly to perform the requested conversion.
- No advertising, analytics, sale, credit decisions, unrelated profiling, or
  Paper2MD server storage.

Certify that data is used only for the disclosed single purpose, is transmitted
over HTTPS, and is not sold or used for personalized advertising.

## Reviewer access

The core workflow requires a MinerU API Token. Before submission, create a
dedicated reviewer Token, place it only in the Chrome Web Store private test
instructions, and revoke it after review. Never commit it, put it in a screenshot,
or send it in support logs. If MinerU cannot provide a safely revocable reviewer
credential, explain that the extension uses the reviewer's own MinerU Token and
link the official Token management page.

Use `store-assets/reviewer-notes.md` for the exact workflow and expected result.

## Assets

- Package icons: `store-assets/icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png`
- Listing icon: `store-assets/icon-128.png`
- Small promo tile: `store-assets/promo-small.png` (440×280)
- Screenshot: `store-assets/screenshots/precision-success-1280x800.png` (real Chrome success state, 1280×800)

The icon is independently designed and does not use the MinerU or OpenDataLab logo.
The listing and UI must keep the statement that this is an independent third-party
tool with no affiliation or endorsement.

## Release and future-update gates

Version 0.2.0 passed review and was published publicly on 2026-08-30. If a
dedicated reviewer Token was supplied, revoke it after review.

For each future update:

1. Confirm the developer account still has Google two-step verification enabled.
2. Confirm the public support contact remains present on both the support and privacy pages.
3. Upload the newly verified Store ZIP and keep the listing/privacy fields aligned with its actual behavior. Do not add the English listing until the extension UI is fully localized.
4. Add a dedicated reviewer credential or the no-credential explanation in
   the private Test instructions field.
5. Review all permissions and data disclosures against the uploaded ZIP.
6. Submit only after the user explicitly approves the final public listing.

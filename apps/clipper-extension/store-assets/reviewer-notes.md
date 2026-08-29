# Chrome Web Store reviewer notes

## Purpose

Convert a user-selected PDF through the user's MinerU API account. The PDF is
uploaded to a storage address provided by MinerU and processed by MinerU; the
result is downloaded from MinerU/OpenXLab, validated locally, and saved unchanged.
No Paper2MD backend receives or retains the Token, PDF, or result. Reviewers should
use only the supplied non-sensitive sample and must not upload confidential or
personal files, or files they are not authorized to process.

The submitted version intentionally declares Simplified Chinese as its only UI
locale. The button labels below match that packaged interface.

## Test steps

1. Install the uploaded ZIP and pin **After-MinerU Converter — Unofficial**.
2. Click the toolbar icon. A persistent extension tab opens; the workflow is not
   placed in a popup because conversion can take several minutes.
3. Select a small, non-sensitive PDF. Invalid extensions, files over 200MB, or
   files without a `%PDF-` header are rejected locally before permissions or network use.
4. Enter the dedicated MinerU reviewer Token supplied in the private Dashboard
   field, check the disclosure box, and click **授权并开始精准转换**.
5. Approve the three optional MinerU origins. The page reports allocate, upload,
   extraction, download, and validation progress.
6. Expected result: Chrome downloads `<source-name>.mineru.zip`; the success line
   reports Markdown, JSON, and image counts; the Token field is empty; the three
   optional host permissions are removed after the task.

## Important boundaries

- The Token is sent only to `https://mineru.net`.
- The PDF is PUT directly to the exact signed URL on
  `mineru.oss-cn-shanghai.aliyuncs.com` without an Authorization or Content-Type header.
- The ZIP is downloaded from the exact signed URL on
  `cdn-mineru.openxlab.org.cn`.
- No active-tab, scripting, storage, downloads, tabs, cookies, history, clipboard,
  or broad host permissions are requested.
- All executable JavaScript and fflate ZIP-validation code is bundled in the upload.
- The extension does not use analytics, ads, remote configuration, or remotely
  hosted executable code.

Do not place a real Token in this file or in the public listing. Use only the
Chrome Web Store private Test instructions field for a dedicated, revocable
review credential.

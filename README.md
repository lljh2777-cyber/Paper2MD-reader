# Paper2MD Reader

The primary product track is local-first: an Electron desktop host combines the
shared Reader with a local processing boundary and a user-selected Paper2MD library.
The public `sites-reader/` build remains a lightweight Reader/demo. MinerU is an
optional remote extraction provider configured with each user's own Token; the Token
stays in operating-system protected desktop storage and is never exposed to browser
content. A self-hosted cloud backend is not required for the core product.

The active standalone paths share one contract-driven reading core:

- A public/browser Reader that opens one local Paper2MD/MinerU output directory without uploading it.
- A desktop library rail that lists only validated, atomically published local packages by opaque ID.
- A browser-extension clipping path based on Defuddle, plus standalone Markdown/HTML import.
- An optional desktop PDF upload path that calls the fixed MinerU API only after explicit consent,
  then validates untrusted output in isolation before atomic local publication.

Both hosts consume explicit Paper2MD contract data. They can also adapt official MinerU
Markdown and structured content-list output at load time without rewriting the source files.

For ordinary Markdown, the Reader pairs only standalone local images with immediately
adjacent caption paragraphs. It inserts temporary reading anchors, removes frontmatter from
the rendered view, and supplies missing Figure labels in the UI only. The selected Markdown
file is never rewritten. Markdown with local attachments should be opened through its folder
so the browser can resolve those assets inside the same read-only boundary.

## Standalone Reader features

- Local Paper2MD/MinerU folder import, standalone Markdown/HTML import, and bounded `.paper2md.zip` clipping import.
- Optional PDF processing through an isolated MinerU precision-extract service.
- Desktop MinerU extraction with OS-protected user credentials, bounded remote I/O,
  fail-closed ZIP inspection, deterministic validation, and automatic library opening.
- Continuous Markdown rendering in the main column.
- Contract-backed Figure rail with full rendered captions and thumbnails.
- Figure-rail **Follow reading** switch: automatic stage changes when enabled; separate reading-target highlight and manual selection when disabled.
- Image lightbox and return-to-placement action.
- `IntersectionObserver` synchronization driven by explicit `p2md:slot` anchors.
- Container-responsive narrow mode that restores Figure and caption content inline.
- Strict Reader v0.1 field/graph/path validation, manifest v0.8–v0.10 binding, article hash, and asset size/hash checks.
- Explicit package states: valid, edited with anchors, recoverable, ambiguous, missing, unsupported and invalid.
- Safe fallback: ordinary Markdown remains readable when no structured contract is available.
- Display-only pairing for standalone local images and immediately adjacent captions; source Markdown is not rewritten.

## Build

```powershell
npm install
npm run web:build
npm run processing:build
npm run clipper:build
```

For local PDF processing, start the complete Reader with one command:

```powershell
cd E:\Paper2MD-Reader
npm run reader:dev
```

After `Paper2MD Reader is ready` appears, open `http://127.0.0.1:4174/` and keep
that terminal window open. The launcher checks both ports and avoids starting a
second processing service when `127.0.0.1:8787` is already healthy.

## Local Reader

Run the independent local-folder host:

```powershell
npm run local:dev
```

Open `http://127.0.0.1:4174/local-reader/` in Chrome or Edge, choose a Paper2MD package
or MinerU result directory, and grant read-only access. The browser reads files directly
from the selected directory. It does not upload package content or write files back.

When the local processing service is configured, the welcome screen also shows
**Process PDF**. Only the selected PDF is sent to that configured service. See
`apps/processing-service/README.md` for the security and deployment boundary.

## Paper webpage clipping

`apps/clipper-extension/` is a separate Chromium Manifest V3 extension. It follows
the same browser-context extraction model as Obsidian Web Clipper: the extension
reads the currently rendered paper page, uses Defuddle to extract Markdown and
metadata, and localizes supported raster images with deterministic shared rules.

The public [After-MinerU Converter — Unofficial](https://chromewebstore.google.com/detail/bnbkbfepjoaidicdjcdmklofhnaleamm)
version 0.2.0 is a separate single-purpose Chrome Web Store build for explicit PDF
conversion through the user's MinerU account. Its extension ID is
`bnbkbfepjoaidicdjcdmklofhnaleamm`. The unpacked workflow below is the broader
Companion developer build for webpage clipping and desktop pairing, not the Store build.

```powershell
npm run clipper:build
```

Then open `chrome://extensions` or `edge://extensions`, enable developer mode,
choose **Load unpacked**, and select `E:\Paper2MD-Reader\apps\clipper-extension\dist`.
On a paper full-text page, click **Paper2MD Web Clipper** and choose
**提取、校验并在 Reader 打开**. The extension submits typed multipart fields to the
loopback processing service; the service rebuilds and validates the package, atomically
publishes it, and the extension opens the returned Reader deep link. **导出 ZIP 备份**
remains available, but ZIP is no longer the normal handoff.

The extension is user-initiated and uses `activeTab`; it has no always-on content
script. Image origins and the fixed loopback service origin are optional permissions
requested only during the corresponding action. Defuddle's asynchronous third-party
fallback is disabled and the extension never calls AI. If an image cannot be downloaded
or permission is declined, its embedded image is replaced with a normal source link so
the Reader never silently makes a remote resource request. Direct publication is limited
to the stable extension Origin; the service rejects missing, ordinary-web and unknown-
extension Origins, rebuilds the manifest itself, and accepts no arbitrary path, fetch
target, command or evaluation input.

## MinerU result compatibility

Official references: [MinerU output files](https://opendatalab.github.io/MinerU/reference/output_files/),
[MinerU Ecosystem](https://mineru.net/ecosystem), and the
[official MCP implementation](https://github.com/opendatalab/MinerU-Ecosystem/tree/main/mcp).

The Reader accepts four directory shapes, in this priority order:

1. A normalized MinerU package containing `article.md`, `mineru-result.json`, and optional `images/`.
2. A Paper2MD package containing `article.md` (and optionally `_paper2md/reader.json`).
3. A full MinerU result containing a same-stem Markdown/content-list pair and `images/`, or
   MinerU Desktop's `full.md` plus one UUID-named `*_content_list.json`.
4. A directory containing exactly one non-README Markdown file, including Markdown saved by MinerU MCP.

```text
paper-result/
├─ paper.md
├─ paper_content_list.json
├─ paper_content_list_v2.json   # optional; v1 remains preferred
└─ images/
   ├─ ...jpg
   └─ ...png
```

For full results, the Reader consumes visual records from the official stable
`*_content_list.json`: `type`, `img_path`, the type-specific caption, `page_idx`, and
the normalized 0–1000 `bbox`. It uses these fields to populate the visual rail, display
captions and page numbers, and bind a visual back to its Markdown image position. MinerU
3.0 `*_content_list_v2.json` is also recognized using its current public common fields,
but the Reader reports that format as provisional because MinerU documents it as a
development format. Unsafe paths, unsupported image types and missing assets are never
resolved outside the selected directory.

MinerU MCP and the full result bundle are different integration surfaces. The current
official `parse_documents` tool returns Markdown inline for a normal single-file request;
for batches or oversized output it saves `.md` and returns `extract_path`. It does not
return `content_list.json` through the MCP result. Such Markdown is readable immediately,
but Figure/caption/page/bbox linking requires the full result ZIP or CLI/API output folder.
Keep MinerU API tokens in the MCP/CLI/desktop process—never in the browser Reader.
The Reader does not consume `model.json` or `middle.json`; its structured compatibility
boundary is the public content-list format plus the corresponding Markdown and images.

In the Electron desktop host, opening an existing result folder is independent from the
conversion workflow panel. If the folder contains exactly one PDF, or one unambiguous
`*_origin.pdf`, the Reader opens that source PDF in the preview pane automatically. No
conversion or reviewed-layout workflow needs to be selected first.

The desktop reference pane has two tabs. `Images & captions` is selected when an
existing Paper2MD or MinerU result is opened and keeps the structured visual browser
linked to the article scroll position. `Original PDF` shows the source PDF in the same
pane. Switching tabs preserves the current article position and selected visual.

Build the static application with:

```powershell
npm run local:build
```

The output is written to `dist-local/`. Because browser directory access requires a secure context, serve that directory through localhost rather than opening the HTML through `file://`.

## Standalone architecture and legacy freeze

The standalone product uses these active boundaries:

```text
apps/web/                 browser-only package picker and Vite entry
apps/clipper-extension/   browser tab, session, permission, publication and ZIP-export adapter
apps/processing-service/  isolated processing service plus optional local MCP stdio sidecar
packages/agent-contracts/ shared MCP/WebMCP command, ingest-state and error contracts
packages/clipper-core/    deterministic Markdown/image/clipping package projection
packages/reader-core/     contracts, loading and host interfaces
packages/reader-ui/       shared article/Figure/caption workspace
```

The shared agent contract treats every external payload as untrusted. It normalizes
PMID, PMCID, DOI, URL and title queries, rejects arbitrary paths in favor of opaque
IDs, constrains ingest state transitions, and marks commands as read, network, write,
confirmed-write or UI effects. MCP and WebMCP adapters are intentionally not core
dependencies; adapters reuse this runtime-validated command boundary when enabled.
Visual corrections require validation plus explicit confirmation and may only produce
user sidecars. They never rewrite source Markdown, MinerU JSON, images or PDF files.

The processing service implements the shared command adapter at `POST /api/v1/commands`.
`resolve_paper` accepts titles, exact PMID/PMCID/DOI inputs, and identifier-bearing
doi.org, PubMed, PMC and Europe PMC URLs. Known URLs are normalized without fetching
their page. Title searches use fixed Europe PMC and Crossref endpoints and continue
automatically only when both providers corroborate one identifier-bearing candidate
above a strict similarity threshold with a safe lead; otherwise the result contains at
most five deterministic candidates and `AMBIGUOUS_MATCH`. Exact matches rank verified
open XML/HTML ahead of legal PDFs. Unpaywall OA discovery is enabled only when the
operator configures `PAPER2MD_CONTACT_EMAIL`.

`ingest_paper` and `get_ingest_job` provide the complete automatic path for session-free
open full text. The deterministic acquisition router prefers PMC JATS XML/HTML, then guarded
public OA HTML, then a legal OA PDF. Every generic network hop requires credential-free HTTPS,
public-only DNS answers, a pinned validated address, bounded redirects with per-hop revalidation,
declared MIME, timeout and byte limits. HTML/XML uses `clipper-core`; PDF reuses the existing
MinerU staging, validation and atomic publisher. Ready jobs return an
opaque `package_id` plus `/reader/{package_id}`; the Web Reader opens that package directly
through the service package API, so ZIP remains an export/backup format instead of an
internal handoff. Publisher-session pages return a structured Clipper handoff rather than receiving
cookies or login automation.

An optional local MCP stdio sidecar exposes the four processing commands
(`get_service_status`, `resolve_paper`, `ingest_paper`, and `get_ingest_job`) plus four
deterministic read tools (`list_packages`, `read_package_manifest`, `read_article_section`,
and `list_figures`). It forwards already validated command envelopes to the running loopback
processing service, so HTTP clients, MCP clients, package publication, and Reader deep links
share one authoritative job state. The sidecar does not accept arbitrary paths, commands,
URLs, or evaluation input. Visual corrections add three narrow tools: list candidates, validate
against current immutable hashes, then apply only with the short-lived token and `confirm=true`.
Application atomically writes a separate user sidecar and never edits package files. The persistent package
catalog discovers only atomically published packages in fixed storage roots, revalidates their
manifest-bound files, and continues to work after a service restart. Article reads are bounded
by line and byte limits, and figure reads return metadata rather than file contents. MCP remains
an external control surface and is not required by Reader or Clipper.

The Web Reader also adds an optional WebMCP progressive adapter. On browsers exposing the current
`document.modelContext` API (or the deprecated `navigator.modelContext` API), it registers the nine
bounded tools: Reader state, paged headings/visuals, exact heading/visual navigation, reference and
follow modes, paged visual-repair candidates, and no-write correction preview. Registrations share
one abort signal and are removed when the Reader unmounts. Unsupported browsers keep the complete
Reader behavior with no error or polyfill. Tool results never contain image bytes, source paths, DOM
or HTML; paper-derived labels, captions and text are marked as untrusted content. Correction preview
replays the existing hash/geometry/Markdown validator in memory and reports `writesSidecar: false`.
When the local processing service is configured, WebMCP also exposes the two-step validate/apply pair;
apply requires `confirm=true`, consumes a short-lived token and refreshes the Reader from the service
sidecar. WebMCP remains a draft enhancement, not
a Reader dependency. See the [Chrome imperative API documentation](https://developer.chrome.com/docs/ai/webmcp/imperative-api)
and the [WebMCP Community Group draft](https://webmachinelearning.github.io/webmcp/).

The Web empty state now contains one paper input. It resolves title/PMID/PMCID/DOI/supported URL,
shows bounded ambiguous candidates, requires an explicit **获取并发布** click, renders ingest state,
and opens the ready package in place. It also creates 10-minute Clipper pairing codes and revokes
scoped credentials. The extension stores only the resulting `clippings:publish` token; it never sees
the main service or MinerU token.

`PAPER2MD_ENABLE_MCP_HTTP=true` enables a stateless local Streamable HTTP MCP endpoint at
`/api/v1/mcp`, backed by exactly the same tools. It is off by default and configuration rejects
non-loopback enablement. A remote multi-user deployment still requires a real OAuth issuer and
tenant-isolated data roots; the project deliberately refuses to represent a shared bearer token as OAuth.

The early Paper2MD Reader Obsidian/Electron sources in this repository are legacy
implementations and receive no new functionality. The separate Research Agent Reader
Obsidian plugin is the behavioral reference for extraction repair and reading features;
its deterministic viewer/visual-repair contract generation and PDF-crop rendering have
now been extracted into the standalone processing and Web layers. Continuous PDF pages,
the complete cross-page caption projection path, and PDF text-layer recovery remain to
be migrated before the obsolete in-repository hosts can be removed.

The shared Reader toolbar includes an English/中文 language selector. The choice is
stored locally and reused by the Web entry; before a choice
is saved, the Reader follows the system language. Reader controls, package states,
and visual navigation are translated. Contract diagnostics
and unexpected backend errors retain their original text so technical evidence is not
silently rewritten.

Build the public Web entry with `npm run web:build`. Build and start the local
processing service with `npm run processing:build` and `npm run processing:start`.
An MCP host can then spawn `apps/processing-service/dist/mcp-server.mjs`; `npm run mcp:start`
is available for direct diagnostics.

## Expected package contract

The Reader looks for `_paper2md/reader.json` beside the selected article. It consumes the released Paper2MD `paper2md-reader-v0.1` shape, not the earlier Reader design draft.

```json
{
  "contract_version": "paper2md-reader-v0.1",
  "source_sha256": "<64 lowercase hex characters>",
  "article": {
    "path": "article.md",
    "sha256": "<64 lowercase hex characters>",
    "anchor_contract": "paper2md-markdown-anchor-v0.1",
    "block_fingerprint_version": "paper2md-visible-block-fingerprint-v0.1"
  },
  "capabilities": {
    "layout_semantics": "reviewed",
    "caption_binding": "reviewed-layout-geometry",
    "body_references": "unavailable"
  },
  "blocks": [
    {
      "id": "slot_0123456789abcdef01234567",
      "kind": "visual_slot",
      "order": 3,
      "anchor": { "syntax": "p2md:slot", "id": "slot_0123456789abcdef01234567" },
      "fingerprint": {
        "visible_text_sha256": "<64 lowercase hex characters>",
        "simhash64": "<16 lowercase hex characters>",
        "text_length": 0
      },
      "source_spans": ["<Paper2MD source span>"],
      "asset_id": "ast_89abcdef0123456789abcdef"
    }
  ],
  "assets": [
    {
      "id": "ast_89abcdef0123456789abcdef",
      "kind": "figure",
      "path": "images/figure-0001.png",
      "sha256": "<64 lowercase hex characters>",
      "size_bytes": 12345,
      "width_px": 1600,
      "height_px": 900,
      "display_label": "Figure 1",
      "caption_block_id": "blk_fedcba9876543210fedcba98",
      "placement_block_id": "slot_0123456789abcdef01234567",
      "source_spans": ["<Paper2MD source span>"]
    }
  ],
  "relations": [
    {
      "id": "rel_0123456789abcdef01234567",
      "type": "places",
      "source_id": "slot_0123456789abcdef01234567",
      "target_id": "ast_89abcdef0123456789abcdef",
      "label": null
    }
  ]
}
```

The example is structural; Paper2MD generates the hashes, stable IDs, complete source spans, all non-visual blocks, and required `places`/`caption-of` relations. `_paper2md/manifest.json` v0.8, v0.9 or v0.10 is used as an integrity binding for `reader.json` and `article.md`. A missing manifest is reported, while a contradictory Reader binding invalidates contract mode.

Expected public anchors in `article.md`:

```markdown
<!-- p2md:block id="blk_0123456789abcdef01234567" kind="body" -->
Body paragraph.

<!-- p2md:slot id="slot_89abcdef0123456789abcdef" asset="ast_fedcba9876543210fedcba98" -->
![Figure 1](images/figure-0001.png)

<!-- p2md:block id="blk_76543210fedcba9876543210" kind="caption" -->
**Figure 1.** Caption text.
```

Unknown contract versions are never guessed. The Reader renders ordinary Markdown and reports an unsupported-version diagnostic. Reader v0.1 declares body references unavailable, so the plugin does not infer `Fig. N` links or expose mention navigation.

## Development

- `npm run typecheck` — TypeScript validation.
- `npm test` — contract and anchor tests.
- `npm run processing:build` — isolated MinerU processing-service bundle.
- `npm run processing:start` — start the previously built processing service.
- `npm run mcp:start` — start the optional stdio MCP sidecar; the processing service must already be running.
- `npm run local:dev` — Local Reader at `http://127.0.0.1:4174/local-reader/`.
- `npm run local:build` — production Local Reader bundle.
- `npm run web:build` — workspace Web application bundle.
- `npm run clipper:build` — unpacked Chromium Web Clipper extension bundle.
- `npm run desktop:build` — frozen legacy migration-reference build; no new features.
- `npm run preview` — visual preview at `http://127.0.0.1:4173/preview/`.

The Quarto/HTML experiment under `test/` remains a visual prototype only and is not a production input path.

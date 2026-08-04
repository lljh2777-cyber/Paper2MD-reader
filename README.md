# Paper2MD Reader

The repository also contains a Codex Sites host in `sites-reader/`. It reuses
the independent Local Reader and shared Reader core, so hosted and desktop
browser behavior remain contract-driven without duplicating paper-structure
recognition.

Paper2MD Reader provides multiple hosts over the same contract-driven reading core:

- An Obsidian `ItemView`.
- A public/browser Reader that opens one Paper2MD output directory without uploading it.
- An Electron desktop Reader with local PDF preview, Paper2MD conversion tasks and a restricted filesystem adapter.

Both hosts consume explicit Paper2MD contract data. They can also adapt official MinerU
Markdown and structured content-list output at load time without rewriting the source files.

## Phase-one features

- `Open in Paper2MD Reader` command and Markdown file-menu action.
- Continuous Obsidian Markdown rendering in the main column.
- Contract-backed Figure rail with full rendered captions and thumbnails.
- Figure-rail **Follow reading** switch: automatic stage changes when enabled; separate reading-target highlight and manual selection when disabled.
- Image lightbox and return-to-placement action.
- `IntersectionObserver` synchronization driven by explicit `p2md:slot` anchors.
- Container-responsive narrow mode that restores Figure and caption content inline.
- Strict Reader v0.1 field/graph/path validation, manifest v0.8–v0.10 binding, article hash, and asset size/hash checks.
- Explicit package states: valid, edited with anchors, recoverable, ambiguous, missing, unsupported and invalid.
- Safe fallback: ordinary Markdown plus a filename-only `images/` list when `reader.json` is absent. No Figure/caption inference is performed.

## Build and install

```powershell
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` to:

```text
<vault>/.obsidian/plugins/paper2md-reader/
```

Enable **Paper2MD Reader** in Obsidian, open an `article.md`, then run **Open in Paper2MD Reader**.

## Local Reader

Run the independent local-folder host:

```powershell
npm run local:dev
```

Open `http://127.0.0.1:4174/local-reader/` in Chrome or Edge, choose a Paper2MD package
or MinerU result directory, and grant read-only access. The browser reads files directly
from the selected directory. It does not upload package content or write files back.

## MinerU result compatibility

Official references: [MinerU output files](https://opendatalab.github.io/MinerU/reference/output_files/),
[MinerU Ecosystem](https://mineru.net/ecosystem), and the
[official MCP implementation](https://github.com/opendatalab/MinerU-Ecosystem/tree/main/mcp).

The Reader accepts three directory shapes, in this priority order:

1. A Paper2MD package containing `article.md` (and optionally `_paper2md/reader.json`).
2. A full MinerU result containing a same-stem Markdown/content-list pair and `images/`, or
   MinerU Desktop's `full.md` plus one UUID-named `*_content_list.json`.
3. A directory containing exactly one non-README Markdown file, including Markdown saved by MinerU MCP.

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

Build the static application with:

```powershell
npm run local:build
```

The output is written to `dist-local/`. Because browser directory access requires a secure context, serve that directory through localhost rather than opening the HTML through `file://`.

## Shared Web and desktop applications

The gradual workspace migration now has two application entries and two shared boundaries:

```text
apps/web/                 browser-only package picker and Vite entry
apps/desktop/             Electron main, preload, renderer and task adapter
packages/reader-core/     contracts, loading and host interfaces
packages/reader-ui/       shared article/Figure/caption workspace
```

The shared Reader toolbar includes an English/中文 language selector. The choice is
stored locally and reused by the Web, Electron and Obsidian entries; before a choice
is saved, the Reader follows the system language. Reader controls, package states,
visual navigation and desktop workflow controls are translated. Contract diagnostics
and unexpected backend errors retain their original text so technical evidence is not
silently rewritten.

Build the public Web entry with `npm run web:build`. Build the Electron entry with
`npm run desktop:build`, then start it with `npm run desktop:start`. The desktop
renderer never imports Node or Electron modules. Directory reads, PDF bytes and
Paper2MD processes cross a context-isolated preload API with fixed IPC methods.

The desktop task rail offers two isolated workflows. `Process PDF (direct)` invokes
`paper2md convert` for a quick readable package. `Start reviewed layout` orchestrates
the non-destructive Paper2MD review gates: ROI proposal, confirmed ROI import,
per-page visual layout review, strict result validation, and `layout-apply`. The
renderer never supplies raw commands or paths; it advances only registered task IDs
through fixed IPC methods. Visual models and human reviewers work on the exported
review artifacts rather than receiving filesystem or Electron privileges.

Desktop task history is persisted under Electron `userData`. After a restart the
main process reconstructs temporary access tokens and resumes only from complete
on-disk review gates. Interrupted or partial writes are surfaced for inspection and
are never overwritten automatically.

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
- `npm run build` — production plugin bundle.
- `npm run local:dev` — Local Reader at `http://127.0.0.1:4174/local-reader/`.
- `npm run local:build` — production Local Reader bundle.
- `npm run web:build` — workspace Web application bundle.
- `npm run desktop:build` — Electron main/preload/renderer bundles.
- `npm run desktop:start` — start the previously built Electron desktop application.
- `npm run preview` — visual preview at `http://127.0.0.1:4173/preview/`.

The Quarto/HTML experiment under `test/` remains a visual prototype only and is not a production input path.

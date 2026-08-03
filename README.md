# Paper2MD Reader

The repository also contains a Codex Sites host in `sites-reader/`. It reuses
the independent Local Reader and shared Reader core, so hosted and desktop
browser behavior remain contract-driven without duplicating paper-structure
recognition.

Paper2MD Reader provides multiple hosts over the same contract-driven reading core:

- An Obsidian `ItemView`.
- A public/browser Reader that opens one Paper2MD output directory without uploading it.
- An Electron desktop Reader with local PDF preview, Paper2MD conversion tasks and a restricted filesystem adapter.

Both hosts consume explicit Paper2MD contract data; neither infers paper structure nor rewrites `article.md`.

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

Open `http://127.0.0.1:4174/local-reader/` in Chrome or Edge, choose a directory containing `article.md`, and grant read-only access. The browser reads files directly from the selected directory. It does not upload package content or write files back.

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

Build the public Web entry with `npm run web:build`. Build the Electron entry with
`npm run desktop:build`, then start it with `npm run desktop:start`. The desktop
renderer never imports Node or Electron modules. Directory reads, PDF bytes and
Paper2MD processes cross a context-isolated preload API with fixed IPC methods.

`Process PDF` currently invokes the installed `paper2md convert` command with the
PDFium backend and a new output directory. This produces a readable direct package;
reviewed hybrid layout remains a separate Paper2MD workflow until the desktop task
manager gains structured visual-review orchestration.

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

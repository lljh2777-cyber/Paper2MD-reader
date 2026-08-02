# Reader phase-one implementation boundary

## Implemented

The Reader owns contract consumption and presentation only:

1. Open an existing Markdown file in an Obsidian `ItemView`.
2. Load sibling `_paper2md/reader.json` lazily through the Vault API.
3. Accept only the released `paper2md-reader-v0.1` field shape and validate graph references, package-relative paths, article hash, public anchors, and asset size/hash.
4. When `_paper2md/manifest.json` is v0.8, verify its Reader summary and `outputs` bindings before enabling contract mode; report a missing or older manifest without inventing a binding.
5. Materialize only exact `p2md:block` and `p2md:slot` comments into stable DOM anchors.
6. Resolve each asset through its single `placement_block_id`, its optional `caption_block_id`, and explicit `source_id`/`target_id` relations.
7. Render contract assets and captions in the Figure rail, synchronize explicit slots, and restore inline content in a narrow view.
8. Let readers enable automatic Figure following or keep the displayed Figure stable while separately highlighting the current reading target.
9. Keep failures visible through diagnostics and degrade without modifying the paper package.

## Deliberately not implemented

- PDF parsing, caption recognition, body-reference recognition or Figure-number regexes.
- Writing repaired anchors, relations or hashes back into `article.md` or `reader.json`.
- Text-fingerprint recovery when public anchors have been deleted. Phase one reports `recoverable`; a later phase may offer non-persistent recovery candidates.
- File-change watchers and persisted reading position.
- AI analysis, API credentials or `analysis.md` writes.
- Body-reference navigation: Reader v0.1 declares `body_references: unavailable`, so no `Fig. N` matching is attempted.

## Fallback matrix

| State | Article | Figure rail | Slot synchronization |
|---|---|---|---|
| `valid` | contract-aware | contract assets/captions | enabled |
| `edited-with-anchors` | contract-aware, warning | contract assets/captions | enabled |
| `recoverable` | available anchors only | contract assets/captions | available slots only |
| `ambiguous` | ordinary Markdown | disabled | disabled |
| `reader-missing` | ordinary Markdown | filename-only `images/` list | disabled |
| `unsupported-version` | ordinary Markdown | disabled | disabled |
| `invalid-contract` | ordinary Markdown | disabled | disabled |

This division keeps Paper2MD authoritative for the content graph and prevents the Reader from creating a competing paper-structure parser.

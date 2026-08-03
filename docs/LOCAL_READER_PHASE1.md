# Local Reader phase-one boundary

The Local Reader is a separate browser entry over the same Reader contract loader, anchor materializer, Figure rail, and scroll synchronization used by the Obsidian plugin.

## Included

1. Read-only directory selection through the File System Access API, with `webkitdirectory` input fallback.
2. Strict loading of `article.md`, `_paper2md/reader.json`, optional manifest v0.8–v0.10, and declared image assets.
3. Host-neutral SHA-256, contract state derivation, anchor handling, diagnostics, and filename-only fallback.
4. Sanitized Markdown rendering with local image URLs scoped to the selected package.
5. Figure rail, thumbnail selection, lightbox, explicit slot synchronization, responsive inline restoration, reload, and directory switching.
6. A `Follow reading` switch. When enabled, the stage follows the active slot. When disabled, the stage remains stable while the active reading target receives a separate thumbnail outline and waits for manual selection.
7. Object URL revocation when a directory is replaced or the page closes.

## Security boundary

- Reject absolute, drive-prefixed, backslash, empty-segment, `.` and `..` paths.
- Remove executable/embedded Markdown HTML and block non-local image sources.
- Refuse SVG resources in the browser host.
- Never request permission to write and never modify selected files.
- Do not infer captions, placements, body references, or repaired anchors.

## Not included

- Multi-paper library browsing, recent directory persistence, file watchers, editing, repair, PDF conversion, annotations, AI, cloud sync, or a desktop application shell.
- Firefox, Safari, and mobile support guarantees. Chrome and Edge are the phase-one targets.

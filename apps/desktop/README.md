# Paper2MD Reader Desktop

```powershell
npm install
npx install-electron --no
npm run desktop:build
npm run desktop:start
```

Electron 43 downloads its platform binary on demand. Run `npx install-electron
--no` explicitly when the first start cannot reach the Electron download host.

## Reading an existing result

The left rail now opens a user-selected local Paper2MD library. Paper2MD writes a
versioned `.paper2md-library.json` marker and fixed `packages/`, `jobs/`, `staging/`,
`sidecars/`, and `state/` children in that dedicated directory. Do not select an
entire drive. The document list is rebuilt from the published-package catalog and
contains only packages whose manifest-bound files pass validation; malformed,
partial, ambiguous, or untrusted folders stay hidden. Favorites are user state in
`state/preferences.json` and never modify a paper package.

Selecting a document sends only its opaque `package_id` through preload. The main
process revalidates the package before opening it, and the renderer never receives
the library's absolute path. The existing Reader toolbar can still open a standalone
Paper2MD package or MinerU result folder. The article
stays in the main reading column. Use the right-side `Images & captions` and
`Original PDF` tabs to switch between the linked visual browser and the source PDF.
Opening an existing result defaults to images and captions; selecting a PDF for a new
conversion switches to the PDF tab. The visual selection and article scroll position
are retained across tab changes.

The app expects `paper2md` to be installed on `PATH`. Developers may set
`PAPER2MD_EXECUTABLE` in the Electron main-process environment to a trusted
Paper2MD executable path. This value is never accepted from renderer content.

## MinerU Token onboarding

Settings links to the official [MinerU Token management page](https://mineru.net/apiManage/token).
The link target is fixed in the main process. A pasted Token is sent through one
typed IPC method, validated, encrypted with Electron `safeStorage` (DPAPI on
supported Windows systems), and written to one mode-restricted credential envelope
under Electron `userData`. It is not written to the library, application database,
logs, or command-line arguments. The renderer receives only configured/not-configured
state and a four-character mask. Removing the Token deletes only that credential file.

`New extraction` can now use the official remote MinerU API. Before every upload,
the main process shows a separate warning dialog whose safe default is Cancel. After
confirmation it decrypts the Token only in request memory, obtains a signed upload
URL from the fixed MinerU endpoint, uploads the selected PDF without forwarding the
Token to the storage host, and polls the opaque MinerU task ID. At most two remote
extractions run concurrently.

Downloaded results are untrusted input. Paper2MD applies public-HTTPS and DNS checks,
redirect/MIME/timeout/byte limits, then accepts only a bounded ZIP containing one
Markdown file, one content-list JSON file, and supported raster images. Files are
written into an isolated job directory, deterministically validated, and atomically
published to the selected library. A failed or cancelled task never publishes a
partial package; once the final atomic publication begins it is no longer cancellable.
Remote MinerU processing may still finish after an earlier local cancellation.
Successful tasks refresh the library and open the package by opaque `package_id`.
Reading, local package import, and Clipper packages remain Token-free.

The deterministic Viewer Index, visual-repair plan, and review-candidate packet are
generated and validated inside a bounded TypeScript worker with a deadline and
memory limits. Packaged desktop builds do not require a separately installed
Python interpreter.

## Reviewed layout workflow

`Start reviewed layout` keeps extraction deterministic and puts review decisions
behind explicit gates:

1. Choose the extraction profile, review input mode, reference policy, evidence
   level, and whether to retain the source PDF.
2. Choose a source PDF and a new output parent. The desktop app creates one
   `<paper>-paper2md-workflow` directory without overwriting an existing path.
3. When the task says `roi-review`, open the review folder. Inspect
   `content-roi.json` and every `page-XXXX/content-roi.png`. A human or visual Agent
   may adjust each normalized ROI, but must set `review_status` to `confirmed` and
   provide a non-empty `reviewer`.
4. Use `Import confirmed ROI`. The app checks the contract, source hash, page set,
   and normalized geometry before Paper2MD prepares page layout tasks.
5. When the task says `layout-review`, open the new review folder. A visual Agent or
   human writes `final-layout.json` beside each `page-XXXX/layout-task.json`.
6. Use `Validate & build`. The app runs `validate-final-layout` for every page and
   invokes `layout-apply` only after all pages pass. The final Reader package is in
   `03-output` and can be opened directly.

The desktop app deliberately does not choose or call a visual model. This keeps the
review package portable across Codex, other Agent hosts, local models, and manual
review. It also prevents an unreviewed rule proposal from being silently promoted
to a confirmed ROI.

## Task persistence and recovery

The main process stores a versioned task index in Electron's per-user `userData`
directory. It contains task metadata, trusted source/output paths, and fixed enum
options; renderer root tokens are intentionally excluded. Writes are serialized so
an older task snapshot cannot overwrite a newer state.

On startup the desktop app checks disk evidence before restoring a state:

- a readable final `article.md` restores a successful result;
- a complete page review package returns to the layout review gate;
- a complete ROI proposal returns to the ROI review gate;
- a completed remote task is reopened only when its opaque package ID still resolves
  to a catalog-validated local package;
- an interrupted remote task becomes locally cancelled, while a package that crossed
  the atomic commit boundary before shutdown is recovered as succeeded;
- an interrupted process with no complete gate becomes failed and may be retried;
- a partial output directory is never overwritten and must be inspected and removed
  manually before retrying.

`Retry` only runs a fixed command for the task's recorded stage and refuses missing
source files or existing target directories. `Remove record` removes completed,
failed, or cancelled metadata from the task index; it never deletes the PDF,
workflow directory, review artifacts, or output package.

## Windows development releases

`npm run desktop:pack` builds and verifies an unpacked Windows x64 application.
`npm run desktop:dist` builds both an assisted per-user NSIS installer and a portable
executable under `apps/desktop/out`. Release packaging uses an explicit file allowlist,
keeps the deterministic contract worker outside ASAR for `worker_threads`, and rejects
retired Python scripts or source trees in the packaged application.

The resulting executables are intentionally unsigned development artifacts. Windows
SmartScreen may warn when opening them. The GitHub Actions workflow runs TypeScript
checks and the deterministic test suite before uploading the two executables; it does
not publish a release or require a signing certificate. Code signing, branded icons,
and upgrade compatibility remain separate release-hardening work.

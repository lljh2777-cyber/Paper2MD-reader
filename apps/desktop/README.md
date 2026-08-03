# Paper2MD Reader Desktop

```powershell
npm install
npx install-electron --no
npm run desktop:build
npm run desktop:start
```

Electron 43 downloads its platform binary on demand. Run `npx install-electron
--no` explicitly when the first start cannot reach the Electron download host.

The app expects `paper2md` to be installed on `PATH`. Developers may set
`PAPER2MD_EXECUTABLE` in the Electron main-process environment to a trusted
Paper2MD executable path. This value is never accepted from renderer content.

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

The task manager is currently in-memory. Workflow files remain on disk after the
app closes, but reopening and resuming an interrupted task is a later persistence
milestone.

The phase-one desktop build is a development application, not a signed installer.
Packaging and code signing should use a dedicated Electron Forge release step.

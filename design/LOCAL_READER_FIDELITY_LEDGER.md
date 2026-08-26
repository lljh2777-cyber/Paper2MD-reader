# Local Reader phase-one fidelity ledger

The Local Reader reuses the accepted Reader visual specification instead of creating a second design system.

Compared artifacts:

- `reader-desktop-concept.png` ↔ `local-reader-desktop-render.png`
- `reader-narrow-concept.png` ↔ `local-reader-narrow-render.png`
- `local-reader-welcome-render.png` verifies the new host-only empty state.
- `reader-follow-switch-render.png` verifies the enabled control at 1600×1000.
- `reader-follow-off-target-render.png` verifies separate selected/reading-target states.

Browser checks used 1600×1000 desktop and 720×1000 narrow viewports.

| Check | Concept evidence | Local Reader evidence | Result |
|---|---|---|---|
| Product skeleton | Quiet toolbar, 68/32 article/Figure split, vertical thumbnail rail | Same 46 px toolbar, 1084/516 px split and rail anatomy | Matched |
| Typography | Editorial serif paper with compact sans-serif chrome | Shared Reader tokens and 17 px/1.72 article rhythm | Matched |
| Palette | True-white paper, cool-gray chrome, deep-blue controls, semantic contract dot | Same shared CSS plus explicit browser-host theme variables | Matched |
| Figure treatment | Contained selected Figure, full caption and bottom actions | Local Object URL image, visible cloned caption, lightbox and return action | Matched |
| Narrow behavior | Sidebar removed and declared Figure restored at its slot | At 720 px the image and caption are inline and the aside is absent | Matched |
| Interaction | Selected thumbnail, Figure expansion and position return | Directory import, `Contract valid`, lightbox open/close and scroll controls verified | Matched |
| Follow behavior | Figure rail remains compact and reading-driven | Enabled switch follows slots; disabled switch keeps the stage stable while outlining the target thumbnail | Matched; required extension |
| Host controls | Obsidian back button and file label | Required local folder picker, directory label and reload control | Intentional host adaptation |

The visible host-specific copy is limited to the implementation plan's required directory-selection workflow. No decorative badges, extra navigation, gradients, alternate card system, or inferred paper controls were introduced. The browser console was clear after the local image handoff and favicon fixes.

## Shared workspace migration check

The `apps/web` entry was compared at the native 1600×900 size against
`local-reader-welcome-render.png`. The accepted implementation capture is
`web-shared-workspace-render.png`.

| Check | Existing design | Shared Web render | Result |
|---|---|---|---|
| App skeleton | Compact toolbar, main article and 32% visual rail | Same three-region composition | Matched |
| Copy | Local Reader title, folder labels and privacy note | Exact host copy restored after initial drift | Matched |
| Typography | Serif reading headline and compact sans-serif chrome | Same shared tokens and hierarchy | Matched |
| Palette | True white, cool gray and deep blue | No new tint, gradient or overlay | Matched |
| Spacing | Centered empty state with restrained controls | Same rhythm at the tested viewport | Matched |
| Figure rail | Visible heading, follow switch and empty state | Same responsive rail behavior | Matched |

No above-the-fold copy remains added, removed or reordered relative to the
existing Local Reader specification. The new desktop task and PDF panes are an
intentional host-only extension; they do not change shared article/Figure UI.

## Markdown import iteration

The standalone Markdown entry was verified on 2026-08-26. Persistent comparison
captures are `qa-latest-reader.png` for the import state and
`qa-latest-reader-loaded.png` for the loaded two-visual state.

| Check | Existing design | Current render | Result |
|---|---|---|---|
| Product skeleton | Quiet toolbar and 68/32 reading split | Import state and loaded state preserve the same regions | Matched |
| Typography | Editorial serif paper and compact sans-serif chrome | New headline and both import controls use the existing type system | Matched |
| Palette | True white, cool gray and restrained deep blue | Secondary Markdown action uses a hairline neutral border; no new palette | Matched |
| Figure treatment | Selected visual, complete caption and thumbnail rail | Loaded regression shows two thumbnails, full caption and pinned actions | Matched |
| Responsive behavior | Sidebar disappears below the shared breakpoint | 720×900 regression keeps both import actions readable without overflow | Matched |
| Copy boundary | Host copy explains local/read-only behavior | Added copy states supported sources and display-only Figure numbering | Intentional functional extension |

No material visual mismatch remains. The visible change is limited to the new
Markdown action and source explanation required by the import workflow.

## PDF processing entry iteration

The processing-service entry was verified at 1600×1000, 720×900 and 390×844.
The latest desktop capture is `qa-latest-reader.png`.

| Check | Existing design | Current render | Result |
|---|---|---|---|
| Product skeleton | Quiet toolbar and 68/32 reading split | Unchanged article and Figure regions | Matched |
| Action family | One primary folder action and neutral secondary Markdown action | PDF uses the same neutral secondary control family | Matched |
| Typography | Serif reading headline and compact sans-serif controls | No type-scale or weight drift | Matched |
| Palette | True white, cool gray and deep blue | No new tint, gradient, card or overlay | Matched |
| Privacy copy | Local-only behavior must be explicit | Copy switches when PDF processing is available and names the configured processor | Intentional functional extension |
| Responsive behavior | Actions remain readable in narrow mode | 390×844 wraps the Markdown action to a second row with `scrollWidth === clientWidth` | Matched |

Above-the-fold additions are limited to the requested **处理 PDF** action and its
privacy clarification. Browser console warning/error output was empty. No material
visual mismatch remains.

## Full-page multi-panel repair iteration

The 2026-08-26 real-package regression used the accepted loaded-reader capture
`qa-latest-reader-loaded.png` as the visual baseline and a 1280×720 in-app
browser viewport for the repaired paper.

| Check | Baseline evidence | Current render | Result |
|---|---|---|---|
| Product skeleton | Quiet toolbar, article/visual split and thumbnail rail | Same shell and proportions; no CSS changes | Matched |
| Typography | Editorial article and compact sans-serif chrome | Unchanged article, caption and control families | Matched |
| Palette | True white, cool gray and restrained blue selection | No tint, gradient or overlay added | Matched |
| Figure treatment | One selected visual with caption below | Full-page Figure 5 is one PDF crop with its complete next-page caption | Matched; content repair only |
| Interaction | Manual selection remains stable with follow disabled | Selecting Fig. 5 keeps it active and does not snap back | Matched |
| Source fidelity | Visual rail is a display projection | Left article contains zero image nodes and no duplicate Fig. 5 caption; source bytes remain unchanged | Matched |

The rail changed from 21 to 18 visual objects because four page-11 fragments
were proven to be one Figure 5. No above-the-fold copy, control, spacing, icon,
or responsive behavior changed.

## Math and missing-glyph repair iteration

The 2026-08-26 regression used the real `blampey_novae_2025` MinerU package at
the same 1280×720 reader viewport.

| Check | Before | Current render | Result |
|---|---|---|---|
| LaTeX | Literal `$...$` and `$$...$$` source was visible | KaTeX renders 110 inline/display expressions | Fixed |
| Missing glyphs | Eight U+FFFD replacement glyphs existed in source Markdown | Eight symbols were uniquely recovered from the packaged PDF text layer; zero U+FFFD remain in the rendered article | Fixed |
| Source fidelity | `article.md` is immutable | Recovery is an in-memory projection and source files are unchanged | Matched |
| Safety | Missing text must fail closed | Duplicate/missing context and non-unique source blocks abstain | Matched |
| Console | No relevant warning/error expected | Empty warning/error log after real-package import | Matched |

No reader chrome, split proportions, Figure controls, or palette changed.

## Same-page split-caption repair iteration

The 2026-08-26 regression used the real `blampey_novae_2025` MinerU package and
the Fig. 6 two-column caption shown in the reported failure.

| Check | Before | Current render | Result |
|---|---|---|---|
| Caption assembly | The rail stopped after the first non-terminal caption atom | The unique terminal continuation is appended in source order | Fixed |
| Article projection | Both caption fragments remained visible in the left article | Both exact, image-adjacent source ranges are hidden together | Fixed |
| Failure behavior | A partial suppression could leave an orphan continuation | Missing terminal punctuation, duplicate candidates, edited text or ambiguous adjacency preserves the whole caption | Matched |
| Source fidelity | `article.md` is immutable | Only derived visual metadata and the in-memory Markdown projection change | Matched |

No reader chrome, layout, typography, palette, or controls changed.

## PDF cross-column caption recovery iteration

The 2026-08-26 regression used the real `blampey_novae_2025` package and the
Fig. 3 caption whose right PDF column had been merged into a preceding body
paragraph by MinerU.

| Check | Before | Current render | Result |
|---|---|---|---|
| Caption assembly | Fig. 3 stopped at panel e | PDF bbox text locates the unique f–i continuation and the rail shows the complete caption | Fixed |
| Article projection | The formal prefix and polluted continuation remained in the article | Both verified caption spans are absent; the legitimate body prefix remains | Fixed |
| Failure behavior | A guessed suffix could delete prose | Competing empty columns, non-sequential panels, duplicate Markdown text or unavailable PDF text abstain | Matched |
| Source fidelity | `article.md` is immutable | PDF text is evidence for an in-memory projection only | Matched |
| Console | No relevant warning/error expected | Empty warning/error log after real-package import | Matched |

No reader chrome, layout, typography, palette, icons, or controls changed.

## Continuous PDF reference iteration

The 2026-08-26 browser regression used the real 20-page
`blampey_novae_2025` package after adding the original-PDF reference tab.

| Check | Expected | Current render | Result |
|---|---|---|---|
| Reference modes | Switch between original PDF and figures/captions | Both tabs remain inside the existing right rail | Matched |
| Continuous pages | Create all page placeholders and render only the nearby viewport | 20 wrappers; 6 pages rendered on the initial viewport | Matched |
| PDF controls | Page navigation, zoom and fit-width remain bounded | Next-page moved to page 2; 115% zoom rerendered without errors | Matched |
| Visual regression | Fig. 3 recovery survives mode switching | 1,693-character complete caption; both left-column duplicate counts remained zero | Matched |
| Console | No relevant warning/error expected | Empty warning/error log | Matched |

This iteration adds only the reference-mode header and PDF controls required by
the migrated behavior; the accepted article and figure presentation remain unchanged.

## PDF layout and image compatibility iteration

The 2026-08-26 regression used the same immutable 20-page
`blampey_novae_2025` package.

| Check | Expected | Current render | Result |
|---|---|---|---|
| Verified geometry | Only hash-bound ViewerIndex boxes reach the PDF layer | 87 boxes were visible after lazy rendering; stale-hash unit fixture produced no layout | Matched |
| Figure ownership | Only uniquely owned visual blocks are interactive | 20 interactive visual boxes on the initial pages; selecting `vr-p0004-g0000` highlighted its boxes and moved the article to scroll position 5850 | Matched |
| Layout toggle | Hide and restore overlays without rerendering source content | Box count changed 87 → 0 → 87 and `aria-pressed` tracked the state | Matched |
| PDF image fallback | Repaint only validated large MinerU image blocks | Pages 2, 3 and 6 received one compatibility image each | Matched |
| Source fidelity | No repair writes to the package | Source SHA-256 remains `821b58f2ec8bdea45499d9a4534faecf45515958d7c49673616f413b042276ff` | Matched |
| Console | No relevant warning/error expected | Empty warning/error log | Matched |

## Single-authority page following iteration

The 2026-08-26 regression again used the real `blampey_novae_2025` package.

| Check | Expected | Current render | Result |
|---|---|---|---|
| Page ownership | Map only uniquely located visible Markdown pages | 19/20 pages mapped; ambiguous page 5 abstained | Matched |
| Automatic authority | Markdown viewport top alone drives PDF page | Body page 8 opened PDF page 8; later body page 10 moved PDF to page 10 | Matched |
| Manual PDF interaction | Do not let background Markdown tracking steal the page | Manual page 9 displayed the paused follow state | Matched |
| Resume | Returning to Markdown restores automatic following | A left-pane wheel interaction resumed follow before the next page update | Matched |
| Source fidelity | Page markers exist in the display projection only | Source SHA-256 remains `821b58f2ec8bdea45499d9a4534faecf45515958d7c49673616f413b042276ff` | Matched |
| Console | No relevant warning/error expected | Empty warning/error log | Matched |

## Host-side reading state iteration

The 2026-08-26 browser regression reopened the immutable
`blampey_novae_2025` package after a full page reload.

| Check | Expected | Restored render | Result |
|---|---|---|---|
| Split ratio | Keyboard and pointer resizing remain bounded to 42–78% | Two left-arrow steps restored the article column at 64% | Matched |
| Article position | Restore the per-paper body scroll without source markers | Scroll position 1230 restored | Matched |
| PDF state | Restore mode, zoom, page and follow choice | Original-PDF mode, 115% zoom, page 2 and follow-off restored | Matched |
| Layout preference | Restore the display-only overlay switch | Layout boxes restored off | Matched |
| Isolation | Key state by immutable content identity | Sidecar key accepts only a 64-character SHA-256 | Matched |
| Console | No relevant warning/error expected | Empty warning/error log | Matched |

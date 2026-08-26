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

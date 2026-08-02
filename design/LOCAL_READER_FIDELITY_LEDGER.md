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

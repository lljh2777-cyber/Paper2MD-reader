# Phase-one visual fidelity ledger

Compared artifacts:

- `reader-desktop-concept.png` ↔ `reader-desktop-render.png`
- `reader-narrow-concept.png` ↔ `reader-narrow-render.png`

Final browser checks used a 1600×1000 desktop viewport and a 720×1000 narrow viewport.

| Check | Concept evidence | Render evidence | Result |
|---|---|---|---|
| Product skeleton | Quiet toolbar, article/Figure split and thumbnail rail | 1084/516 px columns, 46 px toolbar and independent article/sidebar scrolling | Matched |
| Typography | Editorial serif content with compact sans-serif chrome | Serif article hierarchy and deliberately sized 11–14 px control chrome | Matched; browser font metrics produce a three-line rather than two-line title |
| Palette and framing | True white paper, cool-gray chrome, blue selection, hairline borders | Theme-backed white/gray surfaces, `#184f91` accent, no gradient or heavy shadow | Matched |
| Figure treatment | Large selected Figure, caption, actions and four vertical thumbnails | Same anatomy; raster Figure uses `object-fit: contain`, caption remains readable and actions stay pinned low | Matched |
| Responsive behavior | No narrow sidebar; Figure restored inline at its slot | At 720 px the aside is `display:none`, inline Figure is `display:block`, and horizontal overflow is false | Matched |
| Interaction states | Selected thumbnail and image expansion | Figure 2 selection updated the stage; Lightbox opened and closed through unique accessible controls | Matched |
| Visible copy | Reader name, file, contract state, Figures, Figure labels and actions | Required strings are present verbatim | Matched; the concept's generated “Deader” typo was corrected to the specified “Reader” |

No material visual mismatch remains. The narrow Image Gen concept was returned at 879×1779 despite the requested 720×1000 canvas, so exact native-dimension comparison was not possible; responsive verification used the requested 720×1000 browser viewport instead.

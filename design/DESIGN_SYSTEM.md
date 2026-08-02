# Paper2MD Reader phase-one design system

The desktop and narrow concepts in this directory are the visual specification for phase one.

- Layout: quiet 46 px toolbar; desktop article/Figure split near 68/32; sidebar disappears below a 1040 px view-container width.
- Article: centered long-form measure, editorial serif, 17 px/1.72 body rhythm, large compact title, true white/light-theme paper.
- Chrome: Obsidian theme surfaces, hairline borders, minimal 5–6 px radii, no gradients and almost no shadow.
- Accent: restrained deep blue `#184f91`; green/amber/red are reserved for contract state.
- Figure panel: independently scrollable selected Figure, complete rendered caption, two compact actions, vertical thumbnail rail.
- Figure-follow control: compact switch in the Figure header; filled thumbnail state means displayed, outlined state means current reading target.
- Narrow state: Figure and caption return to their explicit placement slot in the article; no drawer or cramped sidebar.
- Interaction: visible focus rings, lazy-loaded images, selected thumbnails, slot-driven Figure synchronization, full-image lightbox.

The generated concept misspells one desktop toolbar word as “Deader”; the implementation intentionally uses the required exact label “Paper2MD Reader”.

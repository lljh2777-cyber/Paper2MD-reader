<!-- p2md:block id="blk_111111111111111111111111" kind="title" -->
# A contract-driven local reading fixture

<!-- p2md:block id="blk_222222222222222222222222" kind="body" -->
This package demonstrates that the Local Reader can open a directory without uploading or rewriting its contents. The article remains continuous while explicit Paper2MD slots drive the visual rail.

## Results

The central observation is shown in the declared figure. No filename ordering, caption regex, or inferred paper structure is required.

<!-- p2md:slot id="slot_444444444444444444444444" asset="ast_333333333333333333333333" -->
![Figure 1](images/figure-0001.png)

<!-- p2md:block id="blk_555555555555555555555555" kind="caption" -->
**Figure 1.** End-to-end Local Reader fixture used for browser and contract verification.

## Discussion

The Reader consumes the explicit relationship between this slot, the image asset, and the caption block. If that relationship becomes ambiguous, it falls back safely instead of guessing.

The second observation is intentionally separated from the first so browser tests can verify whether the visual rail follows reading position or only highlights the current target.

<!-- p2md:slot id="slot_888888888888888888888888" asset="ast_999999999999999999999999" -->
![Figure 2](images/figure-0002.png)

<!-- p2md:block id="blk_aaaaaaaaaaaaaaaaaaaaaaaa" kind="caption" -->
**Figure 2.** Secondary fixture used to verify manual selection and reading-target highlighting.

## Conclusion

Follow mode changes presentation behavior only. It never changes the Paper2MD contract or the underlying article package.

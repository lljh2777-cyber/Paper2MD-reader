import { describe, expect, it } from "vitest";
import {
  collectPdfCaptionContinuationRequests,
  recoverPdfCaptionContinuation,
  suppressRecoveredCaptionContinuation
} from "../src/model/mineru-caption-recovery";
import { RepairedMinerUVisual } from "../src/model/mineru-visual-repair";

const anchor = "Fig. 3 | Benchmark results. a, First panel. b, Second panel. c, Third panel. d, Fourth panel. e, Spatial domains assigned across two slides from the breast";
const continuation = "dataset (MERSCOPE and Xenium slides). f, ARI comparison across seeds. g, Same as f for FIDE. h, Runtime comparison across dataset sizes. i, UMAP of spatial representations.";
const bodyPrefix = "After running inference, the model can assign domains rapidly. During experimentation, researchers try multiple resolutions, hence ";
const mixedBody = `${bodyPrefix}${continuation}`;
const markdown = `# Paper\n\n${mixedBody}\n\n![](images/fig3-part.jpg)\n\n${anchor}\n`;

function fixture() {
  const visual: RepairedMinerUVisual = {
    id: "visual-fig3",
    kind: "figure",
    path: "images/fig3-part.jpg",
    label: "Fig. 3",
    pageIndex: 4,
    placementBlockId: "slot-fig3",
    memberBlockIds: ["p0004-s000001"],
    captionText: anchor
  };
  const viewerIndex = {
    schema_version: 1,
    pages: [
      {
        page_idx: 3,
        blocks: [{
          id: "p0003-s000000",
          source_index: 0,
          page_order: 0,
          role: "text",
          bbox_norm: [505, 711, 946, 944],
          text: { char_count: mixedBody.length }
        }]
      },
      {
        page_idx: 4,
        blocks: [
          {
            id: "p0004-s000001",
            source_index: 1,
            page_order: 1,
            role: "visual",
            bbox_norm: [727, 594, 939, 722],
            caption: {
              items: [{ text: anchor, kind: "formal-caption" }]
            }
          },
          {
            id: "p0004-s000002",
            source_index: 2,
            page_order: 2,
            role: "text",
            bbox_norm: [507, 740, 942, 882],
            text: { char_count: 0 }
          }
        ]
      }
    ]
  };
  const mineruPayload = [
    { type: "text", page_idx: 3, bbox: [505, 711, 946, 944], text: mixedBody },
    { type: "image", page_idx: 4, bbox: [727, 594, 939, 722], img_path: visual.path, image_caption: [anchor] },
    { type: "text", page_idx: 4, bbox: [507, 740, 942, 882], text: "" }
  ];
  return { visual, viewerIndex, mineruPayload };
}

describe("MinerU PDF caption continuation recovery", () => {
  it("recovers a continuation from one adjacent empty PDF column and suppresses only the mixed suffix", () => {
    const { visual, viewerIndex, mineruPayload } = fixture();
    const original = markdown;
    const requests = collectPdfCaptionContinuationRequests({
      visuals: [visual],
      viewerIndex,
      mineruPayload,
      markdown
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      visualId: "visual-fig3",
      sourceBlockId: "p0004-s000002",
      pageIndex: 4,
      bbox: { x: 0.507, y: 0.74, width: 0.435, height: 0.142 }
    });

    const recovered = recoverPdfCaptionContinuation(markdown, requests[0], continuation);
    expect(recovered).toMatchObject({
      continuation,
      captionText: `${anchor} ${continuation}`,
      captionStatus: "complete"
    });

    const projected = suppressRecoveredCaptionContinuation(markdown, recovered!);
    expect(projected).toContain(bodyPrefix.trimEnd());
    expect(projected).not.toContain(continuation);
    expect(projected).not.toContain(anchor);
    expect(markdown).toBe(original);
  });

  it("abstains when the recovered PDF text does not continue the panel sequence", () => {
    const { visual, viewerIndex, mineruPayload } = fixture();
    const [request] = collectPdfCaptionContinuationRequests({
      visuals: [visual], viewerIndex, mineruPayload, markdown
    });
    expect(recoverPdfCaptionContinuation(markdown, request, "This is ordinary body prose without panel labels.")).toBeUndefined();
  });

  it("does not emit a request when two empty columns compete for the same caption", () => {
    const { visual, viewerIndex, mineruPayload } = fixture();
    const page = viewerIndex.pages[1];
    page.blocks.push({
      id: "p0004-s000003",
      source_index: 3,
      page_order: 3,
      role: "text",
      bbox_norm: [507, 730, 942, 872],
      text: { char_count: 0 }
    });
    mineruPayload.push({ type: "text", page_idx: 4, bbox: [507, 730, 942, 872], text: "" });
    expect(collectPdfCaptionContinuationRequests({
      visuals: [visual], viewerIndex, mineruPayload, markdown
    })).toEqual([]);
  });
});

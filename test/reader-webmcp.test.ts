import { describe, expect, it, vi } from "vitest";
import {
  createReaderWebMcpTools,
  registerReaderWebMcp
} from "../apps/web/src/reader-webmcp";
import type { ReaderAgentController, ReaderAgentState } from "../packages/reader-ui/src/reader-agent-controller";
import type { MinerUVisualReviewPreview } from "../src/model/mineru-visual-review";

function controller(): ReaderAgentController {
  const reference: ReaderAgentState["reference"] = {
    available: true,
    mode: "visuals",
    pdfAvailable: true,
    selectedVisualId: "figure-1",
    visualFollowing: true,
    pdfFollowing: true,
    pdfPage: 1
  };
  return {
    getReaderState: vi.fn((): ReaderAgentState => ({
      lifecycle: "ready",
      headingCount: 1,
      visualCount: 1,
      repairCandidateCount: 0,
      reference
    })),
    listHeadings: vi.fn((start = 0) => ({
      items: [{ id: "heading-1", label: "Untrusted paper heading", level: 1, active: true }],
      total: 1,
      start
    })),
    listVisuals: vi.fn((start = 0) => ({ items: [], total: 0, start })),
    navigateToHeading: vi.fn((id) => ({ id, label: "Heading", level: 1, active: true })),
    navigateToVisual: vi.fn((id) => ({
      id,
      label: "Figure 1",
      kind: "figure",
      available: true,
      selected: true,
      hasArticleAnchor: true
    })),
    setReferenceMode: vi.fn((): ReaderAgentState["reference"] => ({ ...reference })),
    setFollowMode: vi.fn((): ReaderAgentState["reference"] => ({ ...reference, visualFollowing: false })),
    getVisualRepairCandidates: vi.fn((start = 0) => ({ items: [], total: 0, start })),
    previewVisualCorrection: vi.fn(async (decision): Promise<MinerUVisualReviewPreview> => ({
      valid: true,
      writesSidecar: false,
      candidateId: decision.candidate_id,
      effect: "leave-unchanged",
      requestedDecision: decision,
      validatedDecision: decision,
      diagnostics: []
    }))
  };
}

function parsedResult(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

describe("Reader WebMCP progressive adapter", () => {
  it("exposes the bounded Reader tools without an apply primitive", () => {
    const tools = createReaderWebMcpTools(controller());
    expect(tools.map((tool) => tool.name)).toEqual([
      "get_reader_state",
      "list_headings",
      "list_visuals",
      "navigate_to_heading",
      "navigate_to_visual",
      "set_reference_mode",
      "set_follow_mode",
      "get_visual_repair_candidates",
      "preview_visual_correction"
    ]);
    expect(tools.some((tool) => tool.name === "apply_visual_correction")).toBe(false);
    expect(tools.every((tool) => tool.annotations.untrustedContentHint)).toBe(true);
    expect(tools.find((tool) => tool.name === "preview_visual_correction")?.annotations.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "navigate_to_heading")?.annotations.readOnlyHint).toBe(false);
  });

  it("returns structured JSON and rejects extra or oversized paging arguments", async () => {
    const fake = controller();
    const tools = createReaderWebMcpTools(fake);
    const list = tools.find((tool) => tool.name === "list_headings")!;
    expect(parsedResult(await list.execute({ start: 0, limit: 20 }))).toMatchObject({ ok: true });
    expect(fake.listHeadings).toHaveBeenCalledWith(0, 20);
    expect(parsedResult(await list.execute({ start: 0, limit: 201 }))).toMatchObject({
      ok: false,
      error: { code: "READER_COMMAND_REJECTED" }
    });
    expect(parsedResult(await list.execute({ start: 0, path: "C:\\secret" }))).toMatchObject({ ok: false });
  });

  it("parses only the correction fields accepted by the deterministic review contract", async () => {
    const fake = controller();
    const preview = createReaderWebMcpTools(fake).find((tool) => tool.name === "preview_visual_correction")!;
    expect(parsedResult(await preview.execute({
      candidate_id: "fragment-123",
      verdict: "reject",
      correction: { kind: "fragment_group", member_block_ids: ["block-a", "block-b"] }
    }))).toMatchObject({ ok: true, data: { writesSidecar: false } });
    expect(fake.previewVisualCorrection).toHaveBeenCalledWith({
      candidate_id: "fragment-123",
      verdict: "reject",
      correction: { kind: "fragment_group", member_block_ids: ["block-a", "block-b"] }
    });
    expect(parsedResult(await preview.execute({
      candidate_id: "fragment-123",
      verdict: "reject",
      correction: { kind: "fragment_group", member_block_ids: ["block-a", "block-b"], bbox: [0, 0, 1, 1] }
    }))).toMatchObject({ ok: false });
  });

  it("adds two-step sidecar writes only when a service writer is available", async () => {
    const writer = {
      validate: vi.fn(async () => ({ valid: true, validation_token: "token-123" })),
      apply: vi.fn(async () => ({ applied: true, sidecar_only: true }))
    };
    const tools = createReaderWebMcpTools(controller(), writer);
    expect(tools.slice(-2).map((tool) => tool.name)).toEqual(["validate_visual_correction", "apply_visual_correction"]);
    const correction = { kind: "full_page_visual", visual_block_id: "block-a", member_block_ids: ["block-a", "block-b"] };
    const validate = tools.find((tool) => tool.name === "validate_visual_correction")!;
    expect(parsedResult(await validate.execute({ candidate_id: "fragment-123", correction }))).toMatchObject({ ok: true });
    const apply = tools.find((tool) => tool.name === "apply_visual_correction")!;
    expect(parsedResult(await apply.execute({ candidate_id: "fragment-123", correction, validation_token: "token-123", confirm: false }))).toMatchObject({ ok: false });
    expect(parsedResult(await apply.execute({ candidate_id: "fragment-123", correction, validation_token: "token-123", confirm: true }))).toMatchObject({ ok: true });
    expect(writer.apply).toHaveBeenCalledOnce();
  });

  it("prefers document.modelContext and unregisters every tool through one abort signal", async () => {
    const registered: Array<{ name: string; signal?: AbortSignal }> = [];
    const documentContext = {
      registerTool: vi.fn(async (tool, options) => {
        registered.push({ name: tool.name, signal: options?.signal });
      })
    };
    const navigatorContext = { registerTool: vi.fn(async () => undefined) };
    const registration = registerReaderWebMcp(
      controller(),
      { modelContext: documentContext } as never,
      { modelContext: navigatorContext } as never
    );
    expect(registration.supported).toBe(true);
    expect(await registration.ready).toBe(true);
    expect(registered).toHaveLength(9);
    expect(navigatorContext.registerTool).not.toHaveBeenCalled();
    expect(new Set(registered.map((item) => item.signal)).size).toBe(1);
    registration.dispose();
    expect(registered[0].signal?.aborted).toBe(true);
  });

  it("is a no-op when neither current nor legacy WebMCP is available", async () => {
    const registration = registerReaderWebMcp(controller(), {} as never, {} as never);
    expect(registration.supported).toBe(false);
    expect(registration.toolNames).toEqual([]);
    expect(await registration.ready).toBe(false);
    registration.dispose();
  });

  it("aborts every partial registration when one draft API call fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const signals: AbortSignal[] = [];
    let count = 0;
    const registration = registerReaderWebMcp(controller(), {
      modelContext: {
        registerTool: vi.fn(async (_tool, options) => {
          signals.push(options?.signal as AbortSignal);
          count += 1;
          if (count === 3) throw new Error("draft API disabled");
        })
      }
    } as never, {} as never);

    expect(await registration.ready).toBe(false);
    expect(signals.length).toBeGreaterThanOrEqual(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });
});

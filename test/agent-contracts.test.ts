import { describe, expect, it } from "vitest";
import {
  AGENT_COMMANDS,
  agentCommandEffect,
  assertIngestStateTransition,
  assertOpaqueId,
  canTransitionIngestState,
  parseAgentCommand,
  parsePaperQuery
} from "../packages/agent-contracts/src/index";

describe("shared agent and ingest contracts", () => {
  it("normalizes exact identifiers before falling back to title matching", () => {
    expect(parsePaperQuery("PMID: 12345678")).toMatchObject({ kind: "pmid", value: "12345678" });
    expect(parsePaperQuery("pmcid: pmc1234567")).toMatchObject({ kind: "pmcid", value: "PMC1234567" });
    expect(parsePaperQuery("DOI: 10.1038/S41586-024-00001-0.")).toMatchObject({
      kind: "doi",
      value: "10.1038/s41586-024-00001-0"
    });
    expect(parsePaperQuery("https://doi.org/10.1000/ABC%2Fdef#section")).toMatchObject({
      kind: "doi",
      value: "10.1000/abc/def"
    });
    expect(parsePaperQuery("  A   deterministic paper title  ")).toMatchObject({
      kind: "title",
      value: "A deterministic paper title"
    });
  });

  it("keeps ordinary paper URLs while dropping fragments", () => {
    expect(parsePaperQuery("https://example.org/papers/1?view=full#results")).toEqual({
      kind: "url",
      value: "https://example.org/papers/1?view=full",
      original: "https://example.org/papers/1?view=full#results"
    });
  });

  it("fails closed for unsafe or under-specified queries", () => {
    expect(() => parsePaperQuery("ftp://example.org/paper.pdf")).toThrow("HTTP(S)");
    expect(() => parsePaperQuery("https://user:secret@example.org/paper")).toThrow("credentials");
    expect(() => parsePaperQuery("DOI: definitely-not-a-doi")).toThrow("identifier is invalid");
    expect(() => parsePaperQuery("abc")).toThrow("too short");
    expect(() => parsePaperQuery(`Paper\u0000title`)).toThrow("printable");
  });

  it("allows only explicit ingest state-machine transitions", () => {
    expect(canTransitionIngestState("queued", "resolving")).toBe(true);
    expect(canTransitionIngestState("acquiring", "clipping")).toBe(true);
    expect(canTransitionIngestState("acquiring", "extracting")).toBe(true);
    expect(canTransitionIngestState("validating", "publishing")).toBe(true);
    expect(canTransitionIngestState("publishing", "ready")).toBe(true);
    expect(canTransitionIngestState("queued", "ready")).toBe(false);
    expect(canTransitionIngestState("failed", "resolving")).toBe(false);
    expect(() => assertIngestStateTransition("validating", "ready")).toThrow("Invalid ingest state transition");
  });

  it("classifies command effects so confirmed writes cannot masquerade as reads", () => {
    expect(agentCommandEffect("get_service_status")).toBe("read");
    expect(agentCommandEffect("resolve_paper")).toBe("network");
    expect(agentCommandEffect("ingest_paper")).toBe("write");
    expect(agentCommandEffect("apply_visual_correction")).toBe("confirmed_write");
    expect(Object.keys(AGENT_COMMANDS)).toContain("open_reader");
  });

  it("validates untrusted command envelopes at every adapter boundary", () => {
    expect(parseAgentCommand({ command: "ingest_paper", input: { query: "PMCID: PMC1234" } })).toEqual({
      command: "ingest_paper",
      input: { query: "PMCID: PMC1234" }
    });
    expect(parseAgentCommand({
      command: "validate_visual_correction",
      input: {
        package_id: "package-1",
        candidate_id: "candidate-1",
        correction: {
          kind: "cross_page_caption",
          visual_block_id: "visual-1",
          caption_block_ids: ["caption-1", "caption-2"]
        }
      }
    })).toMatchObject({ command: "validate_visual_correction" });
    expect(() => parseAgentCommand({
      command: "apply_visual_correction",
      input: {
        package_id: "package-1",
        candidate_id: "candidate-1",
        correction: { kind: "full_page_visual", visual_block_id: "visual-1", member_block_ids: ["a", "b"] },
        validation_token: "validation-1",
        confirm: false
      }
    })).toThrow("explicit confirmation");
    expect(() => parseAgentCommand({
      command: "read_package_manifest",
      input: { package_id: "../outside", arbitrary_path: "C:/secrets" }
    })).toThrow("unsupported fields");
    expect(() => parseAgentCommand({
      command: "read_package_manifest",
      input: { package_id: 1234 }
    })).toThrow("Invalid package_id");
    expect(() => parseAgentCommand({
      command: "validate_visual_correction",
      input: {
        package_id: "package-1",
        candidate_id: "candidate-1",
        correction: {
          kind: "cross_page_caption",
          visual_block_id: "visual-1",
          caption_block_ids: ["caption-1"],
          member_block_ids: ["visual-1", "visual-2"]
        }
      }
    })).toThrow("cannot contain member_block_ids");
  });

  it("accepts opaque handles but rejects paths and oversized values", () => {
    expect(assertOpaqueId("6f2277af-7a90-4f67-89ce-f0356951c587", "job_id")).toContain("6f2277af");
    for (const value of ["../package", "C:/package", "with space", "a".repeat(129)]) {
      expect(() => assertOpaqueId(value, "package_id")).toThrow("Invalid package_id");
    }
  });
});

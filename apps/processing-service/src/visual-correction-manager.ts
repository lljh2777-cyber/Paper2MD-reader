import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReaderFileInfo, ReaderFileSystem } from "../../../src/filesystem/reader-file-system";
import { PackageLoader } from "../../../src/model/package-loader";
import {
  createVisualReviewSidecar,
  MAX_VISUAL_REVIEW_SIDECAR_BYTES,
  previewMinerUVisualReviewDecision,
  visualReviewSidecarByteLength,
  type MinerUVisualReview,
  type MinerUVisualReviewDecision,
  type MinerUVisualReviewSidecar
} from "../../../src/model/mineru-visual-review";
import type { PublishedPackageDescriptor, VisualCorrectionInput } from "../../../packages/agent-contracts/src/index";
import { assertOpaqueId } from "../../../packages/agent-contracts/src/index";
import { PublishedPackageCatalog } from "./published-package-catalog";

const VALIDATION_TTL_MS = 5 * 60 * 1000;

interface ValidationGrant {
  packageId: string;
  candidateId: string;
  packageHash: string;
  correctionHash: string;
  expiresAt: number;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("Unsupported correction value");
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class CatalogFileSystem implements ReaderFileSystem {
  readonly rootLabel: string;
  private readonly files = new Map<string, { size: number }>();

  constructor(private readonly catalog: PublishedPackageCatalog, private readonly descriptor: PublishedPackageDescriptor) {
    this.rootLabel = descriptor.label;
    descriptor.files.forEach((file) => this.files.set(file.path, { size: file.size }));
  }

  resolvePath(relativePath: string): string { return `${this.rootLabel}/${relativePath}`; }
  async exists(relativePath: string): Promise<boolean> { return this.files.has(relativePath); }
  async fileInfo(relativePath: string): Promise<ReaderFileInfo | undefined> { return this.files.get(relativePath); }
  async readText(relativePath: string): Promise<string> { return readFile(await this.path(relativePath), "utf8"); }
  async readBinary(relativePath: string): Promise<ArrayBuffer> {
    const bytes = await readFile(await this.path(relativePath));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  async listFiles(relativeDirectory: string): Promise<string[]> {
    const prefix = relativeDirectory ? `${relativeDirectory.replace(/\/$/, "")}/` : "";
    return [...this.files.keys()].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"));
  }
  async resolveAssetUrl(relativePath: string): Promise<string> { return this.resolvePath(relativePath); }
  dispose(): void {}
  private async path(relativePath: string): Promise<string> {
    if (!this.files.has(relativePath)) throw new Error("Package file is not in the verified inventory");
    const path = await this.catalog.packageFilePath(this.descriptor.packageId, relativePath);
    if (!path) throw new Error("Verified package file is unavailable");
    return path;
  }
}

export class VisualCorrectionManager {
  private readonly grants = new Map<string, ValidationGrant>();
  private readonly writeTails = new Map<string, Promise<void>>();

  constructor(private readonly dataRoot: string, private readonly catalog: PublishedPackageCatalog) {}

  private sidecarPath(packageId: string): string {
    return join(this.dataRoot, "sidecars", assertOpaqueId(packageId, "package_id"), "visual-review.json");
  }

  private async rawSidecar(packageId: string): Promise<unknown | undefined> {
    const path = this.sidecarPath(packageId);
    const info = await lstat(path).catch(() => undefined);
    if (!info) return undefined;
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_VISUAL_REVIEW_SIDECAR_BYTES) {
      throw new Error("Visual correction sidecar is unsafe or oversized");
    }
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  }

  private async review(packageId: string): Promise<MinerUVisualReview> {
    const descriptor = await this.catalog.descriptor(assertOpaqueId(packageId, "package_id"));
    if (!descriptor) throw new Error("Package not found");
    const fileSystem = new CatalogFileSystem(this.catalog, descriptor);
    const loader = new PackageLoader(fileSystem);
    const initial = await loader.loadDetected();
    if (!initial.visualReview) throw new Error("Verified MinerU visual repair candidates are unavailable for this package");
    const sidecar = await this.rawSidecar(packageId);
    if (sidecar === undefined) return initial.visualReview;
    const loaded = await loader.loadDetected(sidecar);
    if (!loaded.visualReview) throw new Error("Visual correction sidecar failed current package validation");
    if (loaded.diagnostics.some((item) => item.code === "mineru-user-review-sidecar-invalid")) {
      throw new Error("Visual correction sidecar is stale or invalid for the current package");
    }
    return loaded.visualReview;
  }

  private decision(candidateId: string, correction: VisualCorrectionInput): MinerUVisualReviewDecision {
    return correction.kind === "full_page_visual"
      ? {
        candidate_id: candidateId,
        verdict: "reject",
        correction: { kind: "fragment_group", member_block_ids: [...(correction.member_block_ids ?? [])] }
      }
      : {
        candidate_id: candidateId,
        verdict: "reject",
        correction: {
          kind: "cross_page_caption",
          visual_block_id: correction.visual_block_id,
          caption_block_ids: [...(correction.caption_block_ids ?? [])]
        }
      };
  }

  async list(packageId: string): Promise<Record<string, unknown>> {
    const review = await this.review(packageId);
    return {
      package_id: packageId,
      candidate_package_sha256: review.packageHash,
      candidates: review.candidates.slice(0, 128).map((candidate) => ({ ...candidate })),
      decisions: review.decisions.map((decision) => structuredClone(decision)),
      blocks: review.blocks.slice(0, 2048).map((block) => ({ ...block, bbox: { ...block.bbox } })),
      blocks_truncated: review.blocks.length > 2048
    };
  }

  async validate(packageId: string, candidateId: string, correction: VisualCorrectionInput): Promise<Record<string, unknown>> {
    const now = Date.now();
    for (const [token, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(token);
    while (this.grants.size >= 256) this.grants.delete(this.grants.keys().next().value!);
    const review = await this.review(packageId);
    const candidate = review.candidates.find((item) => item.id === candidateId);
    if (!candidate) throw new Error("Visual repair candidate not found");
    if (correction.kind === "full_page_visual" && candidate.kind !== "fragment_group") throw new Error("Correction kind does not match the candidate");
    if (correction.kind === "cross_page_caption" && candidate.kind !== "cross_page_caption") throw new Error("Correction kind does not match the candidate");
    if (!candidate.memberBlockIds.includes(correction.visual_block_id)) throw new Error("visual_block_id is not bound to the selected candidate");
    const decision = this.decision(candidateId, correction);
    const preview = await previewMinerUVisualReviewDecision(review, decision);
    if (!preview.valid) return { ...preview, validation_token: null };
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + VALIDATION_TTL_MS;
    this.grants.set(token, {
      packageId, candidateId, packageHash: review.packageHash,
      correctionHash: sha256(canonicalJson(correction)), expiresAt
    });
    return { ...preview, validation_token: token, expires_at: new Date(expiresAt).toISOString() };
  }

  async apply(packageId: string, candidateId: string, correction: VisualCorrectionInput, token: string): Promise<Record<string, unknown>> {
    const grant = this.grants.get(token);
    this.grants.delete(token);
    if (!grant || grant.expiresAt <= Date.now()
      || grant.packageId !== packageId || grant.candidateId !== candidateId
      || grant.correctionHash !== sha256(canonicalJson(correction))) throw new Error("Visual correction validation token is invalid or expired");
    const prior = this.writeTails.get(packageId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    const chain = prior.then(() => tail);
    this.writeTails.set(packageId, chain);
    await prior;
    try {
      const review = await this.review(packageId);
      if (review.packageHash !== grant.packageHash) throw new Error("Visual correction source package changed after validation");
      const decision = this.decision(candidateId, correction);
      const preview = await previewMinerUVisualReviewDecision(review, decision);
      if (!preview.valid) throw new Error("Visual correction no longer validates against the current package");
      const decisions = new Map(review.decisions.map((item) => [item.candidate_id, item]));
      decisions.set(candidateId, decision);
      const sidecar = createVisualReviewSidecar(review.packageHash, [...decisions.values()]);
      if (visualReviewSidecarByteLength(sidecar) > MAX_VISUAL_REVIEW_SIDECAR_BYTES) throw new Error("Visual correction sidecar exceeds the safe limit");
      const path = this.sidecarPath(packageId);
      await mkdir(join(this.dataRoot, "sidecars", packageId), { recursive: true });
      const temporary = `${path}.next`;
      await writeFile(temporary, `${JSON.stringify(sidecar, null, 2)}\n`, { flag: "w", mode: 0o600 });
      await rename(temporary, path);
      return { package_id: packageId, candidate_id: candidateId, applied: true, sidecar_only: true, candidate_package_sha256: review.packageHash };
    } finally {
      release();
      if (this.writeTails.get(packageId) === chain) this.writeTails.delete(packageId);
    }
  }

  async readSidecar(packageId: string): Promise<MinerUVisualReviewSidecar> {
    const review = await this.review(packageId);
    return createVisualReviewSidecar(review.packageHash, review.decisions);
  }
}

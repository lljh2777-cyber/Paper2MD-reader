import type { IngestJob, PaperResolution, PaperResolutionCandidate } from "../../../packages/agent-contracts/src/index";
import { ProcessingClient } from "./processing-client";

function exactCandidateQuery(candidate: PaperResolutionCandidate): string | undefined {
  const identifiers = candidate.identity.identifiers;
  if (identifiers.pmcid) return `PMCID: ${identifiers.pmcid}`;
  if (identifiers.pmid) return `PMID: ${identifiers.pmid}`;
  if (identifiers.doi) return `DOI: ${identifiers.doi}`;
  return undefined;
}

function text(value: string, className?: string): HTMLElement {
  const node = document.createElement("p");
  if (className) node.className = className;
  node.textContent = value;
  return node;
}

export function mountPaperIngestPanel(
  host: HTMLElement,
  client: ProcessingClient,
  onReady: (packageId: string, readerUrl: string) => Promise<void>
): () => void {
  const panel = document.createElement("section");
  panel.className = "p2md-web-ingest";
  panel.setAttribute("aria-labelledby", "p2md-web-ingest-title");
  const title = document.createElement("h2");
  title.id = "p2md-web-ingest-title";
  title.textContent = "获取论文";
  const description = text("输入题名、PMID、PMCID、DOI 或受支持的论文 URL。系统会先确认身份，再由你决定是否获取并发布。", "p2md-web-ingest-copy");
  const form = document.createElement("form");
  form.className = "p2md-web-ingest-form";
  const label = document.createElement("label");
  label.htmlFor = "p2md-paper-query";
  label.textContent = "论文标识或题名";
  const row = document.createElement("div");
  row.className = "p2md-web-ingest-row";
  const input = document.createElement("input");
  input.id = "p2md-paper-query";
  input.name = "query";
  input.type = "text";
  input.maxLength = 2048;
  input.required = true;
  input.autocomplete = "off";
  input.placeholder = "例如：PMCID: PMC3531190";
  const resolveButton = document.createElement("button");
  resolveButton.type = "submit";
  resolveButton.className = "p2md-local-primary-button";
  resolveButton.textContent = "确认论文";
  row.append(input, resolveButton);
  form.append(label, row);
  const result = document.createElement("div");
  result.className = "p2md-web-ingest-result";
  result.setAttribute("aria-live", "polite");
  const pairing = document.createElement("div");
  pairing.className = "p2md-web-pairing";
  const pairButton = document.createElement("button");
  pairButton.type = "button";
  pairButton.className = "p2md-web-link-button";
  pairButton.textContent = "连接浏览器 Clipper";
  const revokeButton = document.createElement("button");
  revokeButton.type = "button";
  revokeButton.className = "p2md-web-link-button";
  revokeButton.textContent = "撤销 Clipper 凭证";
  const pairingStatus = document.createElement("div");
  pairingStatus.className = "p2md-web-pairing-status";
  pairingStatus.setAttribute("aria-live", "polite");
  pairing.append(pairButton, revokeButton, pairingStatus);
  panel.append(title, description, form, result, pairing);
  host.appendChild(panel);

  let disposed = false;
  let resolvedQuery = "";

  pairButton.addEventListener("click", () => {
    void (async () => {
      pairButton.disabled = true;
      try {
        const created = await client.createClipperPairing();
        const code = document.createElement("code");
        code.textContent = created.code;
        pairingStatus.replaceChildren(
          text("在 Clipper 扩展中输入以下配对 ID 和 8 位配对码（10 分钟内有效）："),
          text(created.pairing_id, "p2md-web-pairing-id"),
          code
        );
      } catch (error) {
        pairingStatus.replaceChildren(text(error instanceof Error ? error.message : "无法创建配对码。", "p2md-web-ingest-error"));
      } finally {
        pairButton.disabled = false;
      }
    })();
  });
  revokeButton.addEventListener("click", () => {
    void (async () => {
      revokeButton.disabled = true;
      try {
        const revoked = await client.revokeClipperCredentials();
        pairingStatus.replaceChildren(text(`已撤销 ${revoked} 个 Clipper 发布凭证。`));
      } catch (error) {
        pairingStatus.replaceChildren(text(error instanceof Error ? error.message : "撤销失败。", "p2md-web-ingest-error"));
      } finally {
        revokeButton.disabled = false;
      }
    })();
  });

  const busy = (value: boolean) => {
    input.disabled = value;
    resolveButton.disabled = value;
  };

  const showProblem = (resolution: PaperResolution) => {
    result.replaceChildren(text(resolution.problem?.message ?? "无法安全确认这篇论文。", "p2md-web-ingest-error"));
    const candidates = resolution.candidates ?? [];
    if (candidates.length) {
      const list = document.createElement("div");
      list.className = "p2md-web-candidates";
      candidates.forEach((candidate) => {
        const query = exactCandidateQuery(candidate);
        if (!query) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "p2md-web-candidate";
        button.textContent = `${candidate.identity.title}${candidate.identity.year ? ` (${candidate.identity.year})` : ""}`;
        button.addEventListener("click", () => {
          input.value = query;
          input.focus();
          void resolve(query);
        });
        list.appendChild(button);
      });
      result.appendChild(list);
    }
    resolution.problem?.next_steps.forEach((step) => result.appendChild(text(step, "p2md-web-ingest-next")));
  };

  const showResolved = (resolution: PaperResolution, query: string) => {
    const identity = resolution.match!.identity;
    const summary = document.createElement("div");
    summary.className = "p2md-web-paper-summary";
    const heading = document.createElement("strong");
    heading.textContent = identity.title;
    const metadata = [identity.authors.slice(0, 3).join(", "), identity.journal, identity.year].filter(Boolean).join(" · ");
    summary.append(heading, text(metadata || "已通过精确标识确认", "p2md-web-paper-meta"));
    const acquire = document.createElement("button");
    acquire.type = "button";
    acquire.className = "p2md-local-primary-button";
    acquire.textContent = "获取并发布";
    acquire.addEventListener("click", () => void ingest(query, acquire));
    summary.appendChild(acquire);
    result.replaceChildren(summary);
  };

  const resolve = async (query: string) => {
    busy(true);
    result.replaceChildren(text("正在核对论文身份和合法全文来源…"));
    try {
      const resolution = await client.resolvePaper(query);
      if (disposed) return;
      if (resolution.status === "resolved" && resolution.match) {
        resolvedQuery = query;
        showResolved(resolution, query);
      } else showProblem(resolution);
    } catch (error) {
      if (!disposed) result.replaceChildren(text(error instanceof Error ? error.message : "论文解析失败。", "p2md-web-ingest-error"));
    } finally {
      if (!disposed) busy(false);
    }
  };

  const renderJob = (job: IngestJob) => {
    result.replaceChildren(text(job.message, job.state === "failed" || job.state === "needs_attention" ? "p2md-web-ingest-error" : undefined));
    job.problem?.next_steps.forEach((step) => result.appendChild(text(step, "p2md-web-ingest-next")));
  };

  const ingest = async (query: string, button: HTMLButtonElement) => {
    if (query !== resolvedQuery) return;
    busy(true);
    button.disabled = true;
    try {
      const created = await client.ingestPaper(query);
      renderJob(created);
      const terminal = await client.waitForIngest(created.job_id, renderJob);
      if (disposed) return;
      if (terminal.state === "ready" && terminal.package_id && terminal.reader_url) {
        await onReady(terminal.package_id, terminal.reader_url);
      }
    } catch (error) {
      if (!disposed) result.replaceChildren(text(error instanceof Error ? error.message : "论文获取失败。", "p2md-web-ingest-error"));
    } finally {
      if (!disposed) busy(false);
    }
  };

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const query = input.value.trim();
    if (query) void resolve(query);
  };
  form.addEventListener("submit", submit);
  return () => {
    disposed = true;
    form.removeEventListener("submit", submit);
    panel.remove();
  };
}

import { ReaderFileSystem } from "../filesystem/reader-file-system";

export type DetectedPackageSource =
  | { format: "paper2md"; articlePath: "article.md" }
  | { format: "mineru"; articlePath: string; contentListPath: string }
  | { format: "markdown"; articlePath: string };

export class PackageSourceNotFoundError extends Error {
  constructor() {
    super("No supported Paper2MD or MinerU document was found in the selected folder");
    this.name = "PackageSourceNotFoundError";
  }
}

function markdownCandidates(files: string[]): string[] {
  return files
    .filter((path) => path.toLowerCase().endsWith(".md"))
    .filter((path) => !/(^|\/)readme(?:\.[a-z-]+)?\.md$/i.test(path))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function matchingMarkdown(contentListPath: string, markdown: string[]): string | undefined {
  const filename = contentListPath.split("/").pop() ?? contentListPath;
  const stem = filename
    .replace(/_content_list_v2\.json$/i, "")
    .replace(/_content_list\.json$/i, "")
    .replace(/^content_list(?:_v2)?\.json$/i, "");
  if (stem) return markdown.find((path) => path.toLowerCase() === `${stem}.md`.toLowerCase());
  return markdown.length === 1 ? markdown[0] : undefined;
}

export function contentListForMarkdown(articlePath: string, rootFiles: string[]): string | undefined {
  const markdown = markdownCandidates(rootFiles);
  const stableLists = rootFiles
    .filter((path) => /(?:^|\/)(?:.+_)?content_list\.json$/i.test(path))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const v2Lists = rootFiles
    .filter((path) => /(?:^|\/)(?:.+_)?content_list_v2\.json$/i.test(path))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  for (const contentListPath of [...stableLists, ...v2Lists]) {
    if (matchingMarkdown(contentListPath, markdown)?.toLowerCase() === articlePath.toLowerCase()) {
      return contentListPath;
    }
  }

  const isOnlyMarkdown = markdown.length === 1 && markdown[0].toLowerCase() === articlePath.toLowerCase();
  if (!isOnlyMarkdown) return undefined;
  if (stableLists.length === 1) return stableLists[0];
  if (stableLists.length === 0 && v2Lists.length === 1) return v2Lists[0];
  return undefined;
}

export async function detectPackageSource(fileSystem: ReaderFileSystem): Promise<DetectedPackageSource> {
  if (await fileSystem.exists("article.md")) {
    if (await fileSystem.exists("mineru-result.json")) {
      return { format: "mineru", articlePath: "article.md", contentListPath: "mineru-result.json" };
    }
    return { format: "paper2md", articlePath: "article.md" };
  }

  const rootFiles = await fileSystem.listFiles("");
  const markdown = markdownCandidates(rootFiles);

  for (const articlePath of markdown) {
    const contentListPath = contentListForMarkdown(articlePath, rootFiles);
    if (contentListPath) return { format: "mineru", articlePath, contentListPath };
  }
  if (markdown.length === 1) return { format: "markdown", articlePath: markdown[0] };
  throw new PackageSourceNotFoundError();
}

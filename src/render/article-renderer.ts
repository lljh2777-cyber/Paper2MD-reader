import { App, Component, MarkdownRenderer } from "obsidian";
import { ReaderFileSystem } from "../filesystem/reader-file-system";
import { collectAnchors, materializeContractAnchors } from "./contract-renderer";
import type { RenderedArticle } from "./contract-renderer";
import { assertMarkdownResourcesSafe } from "./markdown-resource-policy";

export { bindContractAssets, materializeContractAnchors } from "./contract-renderer";
export type { RenderedArticle } from "./contract-renderer";

export async function renderArticle(
  app: App,
  markdown: string,
  container: HTMLElement,
  sourcePath: string,
  component: Component,
  fileSystem: ReaderFileSystem,
  materializeAnchors: boolean
): Promise<RenderedArticle> {
  const source = materializeAnchors ? materializeContractAnchors(markdown) : markdown;
  await assertMarkdownResourcesSafe(source, fileSystem);
  container.empty();
  await MarkdownRenderer.render(app, source, container, sourcePath, component);
  return collectAnchors(container);
}

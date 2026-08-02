import { App, Component, MarkdownRenderer } from "obsidian";
import { collectAnchors, materializeContractAnchors, RenderedArticle } from "./contract-renderer";

export { bindContractAssets, materializeContractAnchors, RenderedArticle } from "./contract-renderer";

export async function renderArticle(
  app: App,
  markdown: string,
  container: HTMLElement,
  sourcePath: string,
  component: Component,
  materializeAnchors: boolean
): Promise<RenderedArticle> {
  container.empty();
  const source = materializeAnchors ? materializeContractAnchors(markdown) : markdown;
  await MarkdownRenderer.render(app, source, container, sourcePath, component);
  return collectAnchors(container);
}

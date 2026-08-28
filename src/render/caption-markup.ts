export interface SafeCaptionSegment {
  kind: "text" | "sup" | "sub";
  text: string;
}

export function parseSafeCaptionMarkup(value: string): SafeCaptionSegment[] {
  const segments: SafeCaptionSegment[] = [];
  const pattern = /<(sup|sub)>([^<>]{1,64})<\/\1>/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    if (match.index > cursor) segments.push({ kind: "text", text: value.slice(cursor, match.index) });
    segments.push({ kind: match[1].toLocaleLowerCase() as "sup" | "sub", text: match[2] });
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) segments.push({ kind: "text", text: value.slice(cursor) });
  return segments.length ? segments : [{ kind: "text", text: value }];
}

export function appendSafeCaptionMarkup(container: HTMLElement, value: string): void {
  const nodes = parseSafeCaptionMarkup(value).map((segment) => {
    if (segment.kind === "text") return document.createTextNode(segment.text);
    const node = document.createElement(segment.kind);
    node.textContent = segment.text;
    return node;
  });
  container.append(...nodes);
}

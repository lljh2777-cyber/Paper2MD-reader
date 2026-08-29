import katex from "katex";

export interface SafeCaptionSegment {
  kind: "text" | "sup" | "sub" | "math";
  text: string;
}

function escaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function splitSafeInlineMath(value: string): SafeCaptionSegment[] {
  const segments: SafeCaptionSegment[] = [];
  let cursor = 0;
  let scan = 0;
  while (scan < value.length) {
    const start = value.indexOf("$", scan);
    if (start < 0) break;
    if (escaped(value, start) || value[start + 1] === "$") {
      scan = start + 1;
      continue;
    }
    let end = start + 1;
    while (end < value.length) {
      end = value.indexOf("$", end);
      if (end < 0 || !escaped(value, end)) break;
      end += 1;
    }
    if (end < 0) break;
    const content = value.slice(start + 1, end);
    if (!content || content.length > 512 || /[\r\n]/.test(content) || /^\s|\s$/.test(content)) {
      scan = start + 1;
      continue;
    }
    if (start > cursor) segments.push({ kind: "text", text: value.slice(cursor, start) });
    segments.push({ kind: "math", text: content });
    cursor = end + 1;
    scan = cursor;
  }
  if (cursor < value.length) segments.push({ kind: "text", text: value.slice(cursor) });
  return segments.length ? segments : [{ kind: "text", text: value }];
}

export function parseSafeCaptionMarkup(value: string): SafeCaptionSegment[] {
  const markupSegments: SafeCaptionSegment[] = [];
  const pattern = /<(sup|sub)>([^<>]{1,64})<\/\1>/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    if (match.index > cursor) markupSegments.push(...splitSafeInlineMath(value.slice(cursor, match.index)));
    markupSegments.push({ kind: match[1].toLocaleLowerCase() as "sup" | "sub", text: match[2] });
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) markupSegments.push(...splitSafeInlineMath(value.slice(cursor)));
  return markupSegments.length ? markupSegments : [{ kind: "text", text: value }];
}

export function appendSafeCaptionMarkup(container: HTMLElement, value: string): void {
  const nodes = parseSafeCaptionMarkup(value).map((segment) => {
    if (segment.kind === "text") return document.createTextNode(segment.text);
    if (segment.kind === "math") {
      const node = document.createElement("span");
      node.className = "p2md-caption-math";
      try {
        katex.render(segment.text, node, {
          displayMode: false,
          output: "htmlAndMathml",
          strict: "warn",
          throwOnError: false,
          trust: false
        });
      } catch {
        node.textContent = `$${segment.text}$`;
        node.classList.add("p2md-math-error");
      }
      return node;
    }
    const node = document.createElement(segment.kind);
    node.textContent = segment.text;
    return node;
  });
  container.append(...nodes);
}

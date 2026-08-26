import katex from "katex";
import MarkdownIt from "markdown-it";

const PLACEHOLDER_CLASS = "p2md-math-source";

function escaped(source: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function encodedMath(content: string): string {
  try {
    return encodeURIComponent(content);
  } catch {
    return encodeURIComponent(content.replace(/[\uD800-\uDFFF]/g, "\uFFFD"));
  }
}

export function installMarkdownMath(markdown: MarkdownIt): void {
  markdown.inline.ruler.after("escape", "p2md_math_inline", (state, silent) => {
    const start = state.pos;
    if (state.src[start] !== "$" || state.src[start + 1] === "$" || escaped(state.src, start)) return false;
    let end = start + 1;
    while (end < state.posMax) {
      end = state.src.indexOf("$", end);
      if (end < 0 || end >= state.posMax) return false;
      if (!escaped(state.src, end)) break;
      end += 1;
    }
    const content = state.src.slice(start + 1, end);
    if (!content.trim() || /^\s|\s$/.test(content)) return false;
    if (!silent) {
      const token = state.push("p2md_math_inline", "math", 0);
      token.content = content;
    }
    state.pos = end + 1;
    return true;
  });

  markdown.block.ruler.before("fence", "p2md_math_block", (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const maximum = state.eMarks[startLine];
    const firstLine = state.src.slice(start, maximum);
    if (!firstLine.startsWith("$$")) return false;

    let content = firstLine.slice(2);
    let nextLine = startLine;
    let closed = false;
    const sameLineEnd = content.lastIndexOf("$$");
    if (sameLineEnd >= 0) {
      if (content.slice(sameLineEnd + 2).trim()) return false;
      content = content.slice(0, sameLineEnd);
      closed = true;
    } else {
      const lines: string[] = [content];
      while (++nextLine < endLine) {
        const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
        const lineEnd = state.eMarks[nextLine];
        const line = state.src.slice(lineStart, lineEnd);
        const marker = line.indexOf("$$");
        if (marker >= 0) {
          if (line.slice(marker + 2).trim()) return false;
          lines.push(line.slice(0, marker));
          closed = true;
          break;
        }
        lines.push(line);
      }
      content = lines.join("\n");
    }
    if (!closed) return false;
    if (silent) return true;
    const token = state.push("p2md_math_block", "math", 0);
    token.block = true;
    token.content = content.trim();
    token.map = [startLine, nextLine + 1];
    state.line = nextLine + 1;
    return true;
  });

  markdown.renderer.rules.p2md_math_inline = (tokens, index) =>
    `<span class="${PLACEHOLDER_CLASS}" data-p2md-math="${markdown.utils.escapeHtml(encodedMath(tokens[index].content))}"></span>`;
  markdown.renderer.rules.p2md_math_block = (tokens, index) =>
    `<div class="${PLACEHOLDER_CLASS} p2md-math-block" data-p2md-math="${markdown.utils.escapeHtml(encodedMath(tokens[index].content))}" data-p2md-display="true"></div>\n`;
}

export function renderMathPlaceholders(container: HTMLElement): number {
  let rendered = 0;
  container.querySelectorAll<HTMLElement>(`.${PLACEHOLDER_CLASS}`).forEach((element) => {
    const encoded = element.dataset.p2mdMath;
    if (!encoded) return;
    try {
      katex.render(decodeURIComponent(encoded), element, {
        displayMode: element.dataset.p2mdDisplay === "true",
        output: "htmlAndMathml",
        strict: "warn",
        throwOnError: false,
        trust: false
      });
      element.removeAttribute("data-p2md-math");
      rendered += 1;
    } catch {
      element.textContent = decodeURIComponent(encoded);
      element.classList.add("p2md-math-error");
    }
  });
  return rendered;
}

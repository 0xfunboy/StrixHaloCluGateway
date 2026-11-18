/** Deliberately small Markdown renderer. HTML, images and executable links are never interpreted. */
export function renderMarkdown(document: Document, text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.startsWith('```')) {
      const language = line.slice(3).trim(); const body: string[] = []; index++;
      while (index < lines.length && !lines[index]!.startsWith('```')) body.push(lines[index++]!);
      if (index < lines.length) index++;
      const pre = document.createElement('pre'); const code = document.createElement('code');
      if (/^[a-z0-9+-]{1,25}$/i.test(language)) code.dataset.language = language;
      code.textContent = body.join('\n'); pre.append(code); fragment.append(pre); continue;
    }
    if (!line.trim()) { index++; continue; }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const element = document.createElement(`h${Math.min(4, heading[1]!.length + 1)}`);
      inline(document, element, heading[2]!); fragment.append(element); index++; continue;
    }
    const list = /^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/.exec(line);
    if (list) {
      const ordered = /^\d/.test(line); const element = document.createElement(ordered ? 'ol' : 'ul');
      while (index < lines.length) {
        const match = /^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/.exec(lines[index]!); if (!match) break;
        const item = document.createElement('li'); inline(document, item, match[1]!); element.append(item); index++;
      }
      fragment.append(element); continue;
    }
    if (line.startsWith('> ')) {
      const quote = document.createElement('blockquote'); inline(document, quote, line.slice(2)); fragment.append(quote); index++; continue;
    }
    const paragraph = document.createElement('p'); const body: string[] = [line]; index++;
    while (index < lines.length && lines[index]!.trim() && !/^(?:```|#{1,4}\s|>\s|[-*+]\s|\d+[.)]\s)/.test(lines[index]!)) body.push(lines[index++]!);
    inline(document, paragraph, body.join('\n')); fragment.append(paragraph);
  }
  return fragment;
}

function inline(document: Document, parent: HTMLElement, text: string): void {
  const expression = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g;
  let previous = 0; let match: RegExpExecArray | null;
  while ((match = expression.exec(text))) {
    parent.append(document.createTextNode(text.slice(previous, match.index)));
    const token = match[0];
    if (token.startsWith('`')) { const code = document.createElement('code'); code.textContent = token.slice(1, -1); parent.append(code); }
    else if (token.startsWith('**')) { const strong = document.createElement('strong'); strong.textContent = token.slice(2, -2); parent.append(strong); }
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      try {
        const url = new URL(link[2]!);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsafe URL');
        const anchor = document.createElement('a'); anchor.textContent = link[1]!; anchor.href = url.href;
        anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; parent.append(anchor);
      } catch { parent.append(document.createTextNode(token)); }
    }
    previous = expression.lastIndex;
  }
  parent.append(document.createTextNode(text.slice(previous)));
}

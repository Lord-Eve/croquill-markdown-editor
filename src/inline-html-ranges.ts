export interface InlineSyntaxNode {
  type: string;
  value?: string;
  children?: InlineSyntaxNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

export interface InlineHtmlRange { from: number; to: number; raw: string }

const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
// Keep HTML that establishes a block container under the existing block guard.
const blockTags = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param pre script search section source style summary table tbody td textarea tfoot th thead title tr track ul').split(' '));

interface HtmlToken {
  node: InlineSyntaxNode;
  parent: InlineSyntaxNode;
  from: number;
  to: number;
}

/** Null means that some HTML cannot safely become an atom in this phrasing run. */
export function inlineHtmlRanges(node: InlineSyntaxNode, source: string): InlineHtmlRange[] | null {
  if (!['paragraph', 'heading', 'tableCell'].includes(node.type)) return null;
  const tokens: HtmlToken[] = [];
  let invalid = false;
  function collect(parent: InlineSyntaxNode): void {
    for (const child of parent.children || []) {
      if (['code', 'inlineCode', 'math', 'inlineMath'].includes(child.type)) continue;
      if (child.type === 'html') {
        const from = child.position?.start.offset, to = child.position?.end.offset;
        if (from == null || to == null || from < 0 || to <= from || to > source.length) invalid = true;
        else tokens.push({ node: child, parent, from, to });
      } else collect(child);
    }
  }
  collect(node);
  if (invalid) return null;
  const ranges: InlineHtmlRange[] = [];
  const stack: { tag: string; token: HtmlToken }[] = [];
  const add = (from: number, to: number) => ranges.push({ from, to, raw: source.slice(from, to) });
  for (const token of tokens) {
    const value = token.node.value || '';
    if (/^<!--[\s\S]*-->$/.test(value) && value.indexOf('-->') === value.length - 3) {
      if (!stack.length) add(token.from, token.to);
      continue;
    }
    // Quotes may contain >. The parser already classified this as an HTML
    // token; this check only identifies the tag without reconstructing it.
    const match = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])((?:[^<>"']|"[^"]*"|'[^']*')*)>$/.exec(value);
    if (!match) return null;
    const closing = !!match[1], tag = match[2].toLowerCase(), tail = match[3];
    if (blockTags.has(tag)) return null;
    if (closing) {
      if (!/^[\t \r\n]*$/.test(tail)) return null;
      const opening = stack.pop();
      // An atom must not consume half of a Markdown wrapper. For example,
      // **<span>x**</span> crosses a strong node and remains block protected.
      if (!opening || opening.tag !== tag || opening.token.parent !== token.parent) return null;
      if (!stack.length) add(opening.token.from, token.to);
    } else if (voidTags.has(tag) || /\/[\t \r\n]*$/.test(tail)) {
      if (!stack.length && !/^<br(?: ?\/)?>$/i.test(value)) add(token.from, token.to);
    } else stack.push({ tag, token });
  }
  return stack.length ? null : ranges;
}

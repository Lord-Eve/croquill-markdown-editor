import { parseAlerts } from './alerts';
import { parseMarkdownAst } from './fidelity';
import { parseHtmlBreaks } from './html-break';
import { parseHtmlComments, preserveInlineHtml } from './inline-raw';
import { flattenInlineSource } from './inline-source-markdown';
import { preserveRawMarkdown } from './raw-markdown';
import { parseTocFootnotes } from './toc-footnotes';

export const richMarkdownTransforms = [
  preserveRawMarkdown, parseHtmlComments, preserveInlineHtml, parseTocFootnotes,
  parseHtmlBreaks, flattenInlineSource, parseAlerts,
];

/** Keep the source positions before the editor's preset transforms can discard them. */
export function parsePositionedRichMarkdown(body: string) {
  const file = { value: body };
  let tree = parseMarkdownAst(body);
  for (const transform of richMarkdownTransforms) tree = transform()(tree, file);
  return tree;
}

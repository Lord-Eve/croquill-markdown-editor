export interface DocumentSyntaxNode {
  type: string;
  value?: string;
  label?: string;
  identifier?: string;
  depth?: number;
  children?: DocumentSyntaxNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: Record<string, unknown>;
}

/** TOC is a complete paragraph, never an escaped marker or part of prose. */
export function tocMarkerOf(node: DocumentSyntaxNode, source: string): string | null {
  const text = node.children?.[0];
  if (node.type !== 'paragraph' || node.children?.length !== 1 || text?.type !== 'text' || !/^\[toc\]$/i.test(text.value?.trim() || '')) return null;
  const from = text.position?.start.offset, to = text.position?.end.offset;
  if (from == null || to == null) return null;
  const raw = source.slice(from, to).trim();
  return /^\[toc\]$/i.test(raw) ? raw : null;
}

export function normalizeFootnoteLabel(label: string): string {
  return label.replace(/[\t\r\n ]+/g, ' ').trim().toUpperCase().toLowerCase();
}

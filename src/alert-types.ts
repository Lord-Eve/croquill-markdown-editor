export const alertTypes = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const;
export type AlertType = typeof alertTypes[number];

export interface AlertTreeNode {
  type: string;
  value?: string;
  alertType?: string;
  children?: AlertTreeNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

export function isAlertType(value: string): value is AlertType {
  return (alertTypes as readonly string[]).includes(value);
}

/** A standalone marker on the quote's first line identifies the five documented alerts. */
export function alertTypeOf(node: AlertTreeNode, source?: string): AlertType | null {
  if (node.type !== 'blockquote') return null;
  const paragraph = node.children?.[0], first = paragraph?.children?.[0];
  if (paragraph?.type !== 'paragraph' || first?.type !== 'text') return null;
  const marker = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/.exec(first.value || '');
  if (!marker) return null;
  // An escaped marker is ordinary quote text even though remark decodes it.
  const start = first.position?.start.offset;
  if (source != null && start != null && !source.slice(start).startsWith(`[!${marker[1]}]`)) return null;
  // Formatting after an otherwise standalone marker is on that same line.
  if (!/[\r\n]$/.test(marker[0]) && paragraph.children!.length > 1 && paragraph.children![1].type !== 'break') return null;
  return marker[1] as AlertType;
}

import { headingAttributes } from './inline-source';

export function customHeadingId(source: string, attributes = headingAttributes(source)): string | undefined {
  for (const { from, to } of attributes) {
    const id = /#([^\s}]+)/u.exec(source.slice(from, to))?.[1];
    if (id) return id;
  }
}

export function allocateIds(used = new Set<string>()) {
  const nextSuffix = new Map<string, number>();
  return (base: string) => {
    let id = base, suffix = nextSuffix.get(base) ?? 1;
    while (used.has(id)) id = base + '-' + suffix++;
    used.add(id); nextSuffix.set(base, suffix);
    return id;
  };
}

export function headingId(text: string, custom: string | undefined, allocate: (base: string) => string) {
  return allocate(custom || text.trim() || 'heading');
}

export function matchHeading(headings: { text: string; custom?: string }[], fragment: string): number {
  const allocate = allocateIds(), textId = allocateIds(), slugId = allocateIds();
  const targets = headings.map(({ text, custom }) => ({
    id: headingId(text, custom, allocate), custom, text: textId(text.trim()),
    slug: slugId(text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\s-]/gu, '').replace(/\s+/g, '-')),
  }));
  for (const key of ['custom', 'id', 'text', 'slug'] as const) {
    const index = targets.findIndex(h => h[key] === fragment);
    if (index >= 0) return index;
  }
  return -1;
}

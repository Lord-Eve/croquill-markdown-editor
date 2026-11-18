import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Root } from 'mdast';

const gfm = unified().use(remarkParse).use(remarkGfm);
const math = gfm().use(remarkMath);
interface Entry { math?: Root; gfm?: Root; owners: number }
const recent = new Map<string, Entry>();
const retained = new Map<string, Entry>();

function entryFor(text: string): Entry {
  const pinned = retained.get(text);
  if (pinned) return pinned;
  const entry = recent.get(text) ?? { owners: 0 };
  recent.delete(text);
  recent.set(text, entry);
  if (recent.size > 6) recent.delete(recent.keys().next().value!);
  return entry;
}

/** Shared trees are read-only. A transform that rewrites nodes must take a copy. */
export function parseMarkdownAst(text: string, dialect: 'math' | 'gfm' = 'math'): Root {
  const entry = entryFor(text);
  // remark-math has only dollar delimiters. Without one, the trees coincide.
  if (dialect === 'gfm' && text.includes('$')) return entry.gfm ??= gfm.parse(text);
  return entry.math ??= math.parse(text);
}

/** The open document's original spelling outlives the short recent-text cache. */
export function retainMarkdown(text: string): () => void {
  const entry = entryFor(text);
  retained.set(text, entry);
  entry.owners++;
  return () => { if (--entry.owners === 0) retained.delete(text); };
}

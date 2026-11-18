import { unified } from 'unified';
import remarkParse from 'remark-parse';

const parser = unified().use(remarkParse);
const entities = new Map<string, string>();

/** Decode a complete named or numeric character reference, without parsing HTML. */
export function decodeEntity(raw: string): string {
  const cached = entities.get(raw);
  if (cached !== undefined) return cached;
  const paragraph = parser.parse(`a${raw}b`).children[0];
  const first = paragraph?.type === 'paragraph' && paragraph.children.length === 1 ? paragraph.children[0] : undefined;
  const value = first?.type === 'text' && first.value.startsWith('a') && first.value.endsWith('b') ? first.value.slice(1, -1) : raw;
  if (entities.size >= 4000) entities.clear();
  entities.set(raw, value);
  return value;
}

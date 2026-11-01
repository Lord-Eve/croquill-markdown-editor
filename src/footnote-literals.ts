import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { DocumentSyntaxNode } from './document-syntax';

const parser = unified().use(remarkParse);
const decodedEntities = new Map<string, string>();
function entityValue(raw: string): string {
  if (!decodedEntities.has(raw)) {
    const paragraph = parser.parse(raw).children[0];
    decodedEntities.set(raw, paragraph?.type === 'paragraph' && paragraph.children[0]?.type === 'text' ? paragraph.children[0].value : raw);
  }
  return decodedEntities.get(raw)!;
}

interface ReferenceRange { from: number; to: number; index: number; endIndex: number; raw: string; label: string }

/** Locate real source brackets, excluding escaped and entity-generated brackets. */
export function literalFootnotes(node: DocumentSyntaxNode, source: string): ReferenceRange[] {
  const from = node.position?.start.offset, to = node.position?.end.offset;
  if (node.type !== 'text' || !node.value?.includes('[^') || from == null || to == null) return [];
  const valueLines = node.value.split(/\r\n|\r|\n/), valueEndings = node.value.match(/\r\n|\r|\n/g) || [];
  const ranges: ReferenceRange[] = [];
  let rawStart = from, valueStart = 0;
  for (const [lineIndex, rawLine] of source.slice(from, to).split(/\r\n|\r|\n/).entries()) {
    let decoded = '';
    const offsets: number[] = [];
    const candidates: { start: number; end: number; index: number; label: string }[] = [];
    for (let index = 0; index < rawLine.length;) {
      offsets[index] = decoded.length;
      const rest = rawLine.slice(index);
      const reference = /^\[\^((?:\\.|[^\[\]\\\r\n])+)\]/.exec(rest);
      if (reference && reference[1].trim()) candidates.push({ start: index, end: index + reference[0].length, index: decoded.length, label: reference[1] });
      const escaped = /^\\[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.exec(rest);
      const entity = /^&(?:#[xX][\da-fA-F]+|#\d+|[A-Za-z][A-Za-z\d]+);/.exec(rest);
      if (escaped) { decoded += escaped[0][1]; index += 2; }
      else if (entity) { decoded += entityValue(entity[0]); index += entity[0].length; }
      else decoded += rawLine[index++];
    }
    offsets[rawLine.length] = decoded.length;
    const line = valueLines[lineIndex] || '';
    if (decoded.endsWith(line)) for (const candidate of candidates) {
      const prefix = decoded.length - line.length, index = candidate.index - prefix;
      if (index >= 0 && offsets[candidate.end] != null) ranges.push({
        from: rawStart + candidate.start, to: rawStart + candidate.end,
        index: valueStart + index, endIndex: valueStart + offsets[candidate.end] - prefix,
        raw: rawLine.slice(candidate.start, candidate.end), label: candidate.label,
      });
    }
    valueStart += line.length + (valueEndings[lineIndex]?.length || 0);
    rawStart += rawLine.length + (/^(?:\r\n|\r|\n)/.exec(source.slice(rawStart + rawLine.length))?.[0].length || 0);
  }
  return ranges;
}

import type { Ctx } from '@milkdown/kit/ctx';
import { extendListItemSchemaForTask } from '@milkdown/kit/preset/gfm';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { hasEquivalentMarkdownStructure } from './fidelity';

const parser = unified().use(remarkParse).use(remarkGfm);
interface ListNode {
  type: string;
  ordered?: boolean;
  start?: number | null;
  children?: ListNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** Empty list items contain an editable paragraph, not an HTML placeholder. */
export function configureEmptyListItems(ctx: Ctx): void {
  ctx.update(extendListItemSchemaForTask.key, previous => innerCtx => {
    const schema = previous(innerCtx);
    return {
      ...schema,
      toMarkdown: {
        ...schema.toMarkdown,
        runner: (state, node) => {
          if (node.childCount === 1 && node.firstChild?.type.name === 'paragraph' && !node.firstChild.content.size && node.attrs.checked == null) {
            state.addNode('listItem', [], undefined, { spread: node.attrs.spread });
          } else schema.toMarkdown.runner(state, node);
        },
      },
    };
  });
}

function listsOf(root: ListNode): { node: ListNode; context: string }[] {
  const result: { node: ListNode; context: string }[] = [];
  function visit(node: ListNode, ancestors: unknown[]): void {
    if (node.type === 'list') result.push({ node, context: JSON.stringify(ancestors) });
    const context = node.type === 'root' ? ancestors : [...ancestors, { type: node.type, ordered: node.ordered, start: node.start }];
    node.children?.forEach(child => visit(child, context));
  }
  visit(root, []);
  return result;
}

function semantic(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(semantic);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).filter(([key]) => !['position', 'data', 'spread'].includes(key)).map(([key, value]) => [key, semantic(value)]));
}
function hasEmptyItem(node: ListNode): boolean {
  return node.type === 'listItem' && !node.children?.length || !!node.children?.some(hasEmptyItem);
}

/** Restore unchanged empty item markers by AST offsets, including their spaces. */
export function preserveEmptyListSource(original: string, serialized: string): string {
  const before = listsOf(parser.parse(original) as ListNode), after = listsOf(parser.parse(serialized) as ListNode);
  if (before.length !== after.length) return serialized;
  const changes: { from: number; to: number; text: string }[] = [];
  for (let index = 0; index < before.length; index++) {
    const left = before[index], right = after[index];
    if (left.context !== right.context || left.node.ordered !== right.node.ordered || left.node.start !== right.node.start || left.node.children?.length !== right.node.children?.length) continue;
    const a = left.node.position, b = right.node.position;
    if (b?.start.offset != null && changes.some(change => b.start.offset! >= change.from && b.end.offset! <= change.to)) continue;
    if (hasEmptyItem(left.node) && JSON.stringify(semantic(left.node)) === JSON.stringify(semantic(right.node)) &&
        a?.start.offset != null && a.end.offset != null && b?.start.offset != null && b.end.offset != null) {
      const oldTail = /^[ \t\r\n]*/.exec(original.slice(a.end.offset))![0];
      const newTail = /^[ \t\r\n]*/.exec(serialized.slice(b.end.offset))![0];
      changes.push({ from: b.start.offset, to: b.end.offset + newTail.length, text: original.slice(a.start.offset, a.end.offset) + oldTail });
      continue;
    }
    left.node.children?.forEach((item, itemIndex) => {
      const next = right.node.children![itemIndex];
      if (item.children?.length || next.children?.length) return;
      const a = item.position, b = next.position;
      if (a?.start.offset == null || a.end.offset == null || b?.start.offset == null || b.end.offset == null) return;
      changes.push({ from: b.start.offset, to: b.end.offset, text: original.slice(a.start.offset, a.end.offset) });
    });
  }
  if (!changes.length) return serialized;
  let result = serialized;
  for (const change of changes.sort((a, b) => b.from - a.from)) result = result.slice(0, change.from) + change.text + result.slice(change.to);
  return hasEquivalentMarkdownStructure(serialized, result) ? result : serialized;
}

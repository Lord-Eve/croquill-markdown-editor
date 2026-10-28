import type { Root } from '@milkdown/kit/transformer';
import { $node } from '@milkdown/kit/utils';
import { preservedMarkdownBlocks } from './fidelity';

interface RawTreeNode {
  type: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: RawTreeNode[];
}

/** Runs before the editor's HTML/GFM transforms, using the actual parse input. */
export function preserveRawMarkdown() {
  return (tree: Root, file: { value: unknown }) => {
    const rawTree = tree as unknown as RawTreeNode;
    const source = String(file.value ?? '');
    const blocks = preservedMarkdownBlocks(source);
    if (!blocks.length || !rawTree.children) return tree;
    const next: RawTreeNode[] = [];
    let index = 0;
    for (const child of rawTree.children) {
      const from = child.position?.start.offset;
      while (from != null && blocks[index] && from >= blocks[index].to) index++;
      const block = blocks[index];
      if (block && from != null && from >= block.from && from < block.to) {
        if (from === block.from) next.push({ type: 'croquillRawBlock', value: block.raw, position: child.position });
      } else next.push(child);
    }
    rawTree.children = next;
    return tree;
  };
}

export const rawMarkdownBlock = $node('croquill_raw_block', () => ({
  group: 'block', atom: true, selectable: true, draggable: true,
  attrs: { value: { default: '', validate: 'string' } },
  toDOM: node => ['pre', { 'data-croquill-raw': '', 'aria-label': '原文块，请在源码模式编辑' }, String(node.attrs.value)],
  parseDOM: [{ tag: 'pre[data-croquill-raw]', getAttrs: dom => ({ value: dom.textContent || '' }) }],
  parseMarkdown: {
    match: node => node.type === 'croquillRawBlock',
    runner: (state, node, type) => { state.addNode(type, { value: String(node.value ?? '') }); },
  },
  toMarkdown: {
    match: node => node.type.name === 'croquill_raw_block',
    // The HTML writer emits value verbatim; this is source, never live DOM HTML.
    runner: (state, node) => { state.addNode('html', undefined, String(node.attrs.value), { data: { croquillRaw: true } }); },
  },
}));

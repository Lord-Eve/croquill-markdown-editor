import type { Ctx } from '@milkdown/kit/ctx';
import type { Root } from '@milkdown/kit/transformer';
import { hardbreakFilterNodes, hardbreakSchema, paragraphSchema } from '@milkdown/kit/preset/commonmark';
import { tableCellSchema, tableHeaderSchema } from '@milkdown/kit/preset/gfm';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { isBareHtmlBreak } from './fidelity';

interface BreakTreeNode {
  type: string;
  value?: string;
  data?: Record<string, unknown>;
  children?: BreakTreeNode[];
  position?: unknown;
}

/** Avoid the default command's paragraph splitting in cells and literal BR runs. */
export function handleHtmlBreakKey(view: EditorView, event: KeyboardEvent): boolean {
  if (event.key !== 'Enter' || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
  const { selection, schema, tr } = view.state;
  if (!(selection instanceof TextSelection)) return false;
  const { $from } = selection;
  let inCell = false;
  for (let depth = $from.depth; depth > 0; depth--) {
    if (['table_cell', 'table_header'].includes($from.node(depth).type.name)) { inCell = true; break; }
  }
  if (!inCell && !$from.parent.lastChild?.attrs.croquillHtmlBreak) return false;
  // Stop the editor keymaps while leaving the native IME event untouched.
  if (event.isComposing || view.composing) return true;
  event.preventDefault();
  view.dispatch(tr.setMeta('hardbreak', true).replaceSelectionWith(schema.nodes.hardbreak.create(), false).scrollIntoView());
  return true;
}

/** Run after raw-block protection and before Milkdown's HTML transforms. */
export function parseHtmlBreaks() {
  return (tree: Root) => {
    function visit(parent: BreakTreeNode): void {
      parent.children = parent.children?.map(child => {
        if (child.type === 'html' && isBareHtmlBreak(child.value || '')) {
          const lineBreak: BreakTreeNode = {
            type: 'break', data: { croquillHtmlBreak: child.value }, position: child.position,
          };
          // A bare tag on its own line is an HTML block in CommonMark.
          return ['root', 'blockquote', 'listItem'].includes(parent.type)
            ? { type: 'paragraph', children: [lineBreak], position: child.position }
            : lineBreak;
        }
        visit(child);
        return child;
      });
    }
    visit(tree as unknown as BreakTreeNode);
    return tree;
  };
}

/** Keep each original tag on its own node, so deleting the break deletes the tag. */
export function configureHtmlBreaks(ctx: Ctx): void {
  ctx.update(hardbreakFilterNodes.key, nodes => nodes.filter(name => name !== 'table'));
  ctx.update(hardbreakSchema.key, previous => innerCtx => {
    const schema = previous(innerCtx);
    return {
      ...schema,
      attrs: { ...schema.attrs, croquillHtmlBreak: { default: '', validate: 'string' } },
      parseMarkdown: {
        ...schema.parseMarkdown,
        runner: (state, node, type) => {
          const raw = (node.data as Record<string, unknown> | undefined)?.croquillHtmlBreak;
          if (typeof raw === 'string' && isBareHtmlBreak(raw)) state.addNode(type, { croquillHtmlBreak: raw });
          else schema.parseMarkdown.runner(state, node, type);
        },
      },
      toMarkdown: {
        ...schema.toMarkdown,
        runner: (state, node) => {
          const raw = String(node.attrs.croquillHtmlBreak || '');
          if (isBareHtmlBreak(raw)) state.addNode('html', undefined, raw);
          else if (!node.attrs.isInline && state.top()?.type === 'tableCell') state.addNode('html', undefined, '<br>');
          else schema.toMarkdown.runner(state, node);
        },
      },
    };
  });
  // The stock paragraph writer drops a final hardbreak. A literal HTML break
  // must survive there too, even at the end of a paragraph.
  ctx.update(paragraphSchema.key, previous => innerCtx => {
    const schema = previous(innerCtx);
    return {
      ...schema,
      toMarkdown: {
        ...schema.toMarkdown,
        runner: (state, node) => {
          if (node.lastChild?.attrs.croquillHtmlBreak) state.openNode('paragraph').next(node.content).closeNode();
          else schema.toMarkdown.runner(state, node);
        },
      },
    };
  });
  // A cell's inline content is serialized directly. Keep trailing breaks as
  // well, including a newly inserted Shift+Enter at the end of the cell.
  for (const cell of [tableCellSchema, tableHeaderSchema]) {
    ctx.update(cell.key, previous => innerCtx => {
      const schema = previous(innerCtx);
      return {
        ...schema,
        toMarkdown: {
          ...schema.toMarkdown,
          runner: (state, node) => {
            const paragraph = node.firstChild;
            if (node.childCount === 1 && paragraph?.type.name === 'paragraph') {
              state.openNode('tableCell').next(paragraph.content).closeNode();
            } else schema.toMarkdown.runner(state, node);
          },
        },
      };
    });
  }
}

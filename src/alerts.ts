import type { Ctx } from '@milkdown/kit/ctx';
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import type { DOMOutputSpec } from '@milkdown/kit/prose/model';
import type { Root } from '@milkdown/kit/transformer';
import { $node } from '@milkdown/kit/utils';
import type { Handle, Options } from 'mdast-util-to-markdown';
import { alertTypeOf, isAlertType, type AlertTreeNode, type AlertType } from './alert-types';
import './alerts.css';

export { alertTypes, alertTypeOf, isAlertType, type AlertTreeNode, type AlertType } from './alert-types';

/** Runs after whole-block protection, before the editor's ordinary quote parser. */
export function parseAlerts() {
  return (tree: Root, file: { value: unknown }) => {
    const source = file.value == null ? undefined : String(file.value);
    function visit(node: AlertTreeNode): void {
      const type = alertTypeOf(node, source);
      if (type) {
        const first = node.children![0], text = first.children![0];
        const marker = /^\[![A-Z]+\][ \t]*(?:\r?\n|$)/.exec(text.value!)![0];
        text.value = text.value!.slice(marker.length);
        if (!text.value) {
          first.children!.shift();
          // Two source spaces after the marker become a remark hard break.
          if (!/[\r\n]$/.test(marker) && first.children![0]?.type === 'break') first.children!.shift();
        }
        if (!first.children!.length) node.children!.shift();
        if (!node.children!.length) node.children!.push({ type: 'paragraph', children: [] });
        node.type = 'croquillAlert';
        node.alertType = type;
      }
      node.children?.forEach(visit);
    }
    visit(tree as unknown as AlertTreeNode);
    return tree;
  };
}

/** Emit the marker literally; normal paragraph writers would escape its brackets. */
const writeAlert: Handle = (node, _parent, state, info) => {
  const alert = node as unknown as AlertTreeNode;
  const type = isAlertType(alert.alertType || '') ? alert.alertType! : 'NOTE';
  const exit = state.enter('blockquote');
  const tracker = state.createTracker(info);
  tracker.move(`> [!${type}]\n> `);
  tracker.shift(2);
  const body = state.containerFlow(node as Parameters<typeof state.containerFlow>[0], tracker.current());
  const result = `> [!${type}]` + (body ? '\n' + state.indentLines(body, (line, _index, blank) => '>' + (blank ? '' : ' ') + line) : '');
  exit();
  return result;
};

export const alertMarkdownHandlers = { croquillAlert: writeAlert } as NonNullable<Options['handlers']>;

export function configureAlerts(ctx: Ctx): void {
  ctx.update(remarkStringifyOptionsCtx, options => ({
    ...options, handlers: { ...options.handlers, ...alertMarkdownHandlers },
  }));
}

const titles: Record<AlertType, string> = {
  NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution',
};

/** Small original line icons communicate each alert's meaning without live HTML. */
function alertIcon(type: AlertType): DOMOutputSpec {
  const drawings: Record<AlertType, DOMOutputSpec[]> = {
    NOTE: [['circle', { cx: 8, cy: 8, r: 6.25 }], ['path', { d: 'M8 7v4M8 4.5v.5' }]],
    TIP: [['path', { d: 'M5.5 11c0-2-2-2.1-2-5a4.5 4.5 0 0 1 9 0c0 2.9-2 3-2 5M5.5 12h5M6.5 14h3' }]],
    IMPORTANT: [['path', { d: 'M2 2h12v9H8l-4 3v-3H2zM8 4v3M8 8.5v.5' }]],
    WARNING: [['path', { d: 'M8 1.5 15 14H1zM8 6v4M8 11.5v.5' }]],
    CAUTION: [['path', { d: 'M5 1h6l4 4v6l-4 4H5l-4-4V5zM8 4.5v4M8 10.5v.5' }]],
  };
  return ['http://www.w3.org/2000/svg svg', {
    viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor',
    'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  }, ...drawings[type]];
}

export const alertBlock = $node('croquill_alert', () => ({
  content: 'block+', group: 'block', defining: true,
  attrs: { alertType: { default: 'NOTE', validate: 'string' } },
  toDOM: node => {
    const type = isAlertType(String(node.attrs.alertType)) ? node.attrs.alertType as AlertType : 'NOTE';
    return ['blockquote', { 'data-croquill-alert': type },
      ['div', { class: 'croquill-alert-title', contenteditable: 'false' }, alertIcon(type), ['span', {}, titles[type]]],
      ['div', { class: 'croquill-alert-body' }, 0],
    ];
  },
  parseDOM: [{
    tag: 'blockquote[data-croquill-alert]', priority: 60, contentElement: '.croquill-alert-body',
    getAttrs: dom => {
      const type = dom.getAttribute('data-croquill-alert') || '';
      return isAlertType(type) ? { alertType: type } : false;
    },
  }],
  parseMarkdown: {
    match: node => node.type === 'croquillAlert',
    runner: (state, node, type) => {
      state.openNode(type, { alertType: node.alertType }).next(node.children).closeNode();
    },
  },
  toMarkdown: {
    match: node => node.type.name === 'croquill_alert',
    runner: (state, node) => {
      state.openNode('croquillAlert', undefined, { alertType: String(node.attrs.alertType) }).next(node.content).closeNode();
    },
  },
}));

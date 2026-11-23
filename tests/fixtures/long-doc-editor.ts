import { MarkdownSurface } from '../../src/editor';
import { detectUnsafeMarkdown, hasEquivalentMarkdownStructure, markdownOutline, markdownForWordCount, preservedMarkdownBlocks, splitFrontmatter } from '../../src/fidelity';
import { indexMarkdown } from '../../src/local-markdown';
import { parseMarkdownAst, retainMarkdown } from '../../src/markdown-ast';
import { parsePositionedRichMarkdown } from '../../src/rich-markdown';
import { preserveEmptyListSource } from '../../src/empty-list';
import { preserveRenderedSource } from '../../src/rendered-source';
import { preserveTableSource } from '../../src/table-source';
import { canJoin, canSplit } from '@milkdown/kit/prose/transform';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { Transaction } from '@milkdown/kit/prose/state';
import { TextSelection } from '@milkdown/kit/prose/state';
import { addRowAfter } from '@milkdown/kit/prose/tables';

function makeSurface() {
  const richRoot = document.createElement('div'), sourceRoot = document.createElement('div');
  document.body.append(richRoot, sourceRoot);
  return new MarkdownSurface({ richRoot, sourceRoot, onChange: () => {}, resolveImage: async () => '' }) as any;
}
function check(condition: unknown, message: string) {
  if (!condition) throw Error(message);
}

/** Compare the published decision, reason and every original range with the
 * complete pre-optimization writer, including when the gate rejects the file. */
export async function checkOpening(source: string) {
  const surface = makeSurface();
  try {
    await surface.load(source);
    const parses = (window as any).fullParses;
    const { body, frontmatter } = splitFrontmatter(source);
    let reason = detectUnsafeMarkdown(source);
    let index = null, notice = null;
    if (!reason) {
      const document = surface.richView().state.doc;
      const written = surface.serializeRichDocument(document, source, source);
      if (hasEquivalentMarkdownStructure(source, written)) {
        index = indexMarkdown(source, document);
        notice = [frontmatter && '本文含元数据，可在源码模式中编辑',
          preservedMarkdownBlocks(body).length ? '部分语法以原文块保留，可在源码模式中编辑这些块' : ''].filter(Boolean).join('；') || null;
      } else reason = '此文档的部分结构无法可靠往返转换，已保留原文并启用源码保护';
    }
    const same = surface.mode === (reason ? 'source' : 'rich') && surface.getSafetyReason() === reason &&
      surface.getRichNotice() === notice && JSON.stringify(surface.blockIndex) === JSON.stringify(index);
    return { same, parses };
  } finally { await surface.destroy(); }
}

// Exercise the production publishing path and compare it to the complete writer on
// the same transaction. Restore the snapshot so each corpus edit starts at the original.
export async function corpus(name: string, source: string) {
  const surface = makeSurface();
  try {
    await surface.load(source);
    check(surface.getMarkdown() === source, 'Open changed bytes: ' + name);
    if (surface.mode !== 'rich') return { protected: true, local: 0, cases: 0, differences: [] };
    const view: EditorView = surface.richView(), initial = view.state, doc = initial.doc;
    const baseIndex = surface.blockIndex;
    const positions: { pos: number; kind: string }[] = [];
    doc.descendants((node, pos) => {
      if (!node.isTextblock || !node.firstChild?.isText || !['heading','paragraph','table_header','table_cell'].includes(node.type.name)) return;
      const kind = doc.child(doc.resolve(pos + 1).index(0)).type.name;
      positions.push({ pos, kind: /<\w/.test(node.textContent) ? 'html' : node.textContent.includes('[[') ? 'wiki' : kind });
    });
    const targets = new Set([positions[0], positions[positions.length >> 1], positions.at(-1)]);
    for (const kind of new Set(positions.map(item => item.kind))) targets.add(positions.find(item => item.kind === kind));
    const differences = new Set<string>();
    let local = 0, cases = 0;
    function compare(tr: Transaction, action: string) {
      view.updateState(initial.apply(tr));
      surface.forceFullSerialization = true;
      const full = surface.serializeRich();
      const canonical = surface.serializeRichDocument(view.state.doc, source, source);
      check(hasEquivalentMarkdownStructure(full, canonical), name + ' / ' + action + ': full writer changed the structure');
      surface.blockIndex = structuredClone(baseIndex);
      const index = surface.blockIndex;
      surface.forceFullSerialization = false;
      const actual = surface.getMarkdown();
      const usedLocal = index && index === surface.blockIndex;
      check(hasEquivalentMarkdownStructure(actual, full), name + ' / ' + action + ': structure');
      if (usedLocal) {
        local++;
        const now = view.state.doc;
        let left = 0, oldEnd = doc.childCount, newEnd = now.childCount;
        while (left < oldEnd && left < newEnd && now.child(left) === doc.child(left)) left++;
        while (oldEnd > left && newEnd > left && now.child(newEnd - 1) === doc.child(oldEnd - 1)) { oldEnd--; newEnd--; }
        check(actual.startsWith(source.slice(0, baseIndex.ranges[left].from)) &&
          actual.endsWith(source.slice(baseIndex.ranges[oldEnd - 1].to)), name + ' / ' + action + ': untouched bytes');
      }
      if (actual !== full) differences.add(action);
      cases++;
      view.updateState(initial);
      surface.raw = source;
      surface.richInput = source;
      surface.richSnapshot = doc;
      surface.blockIndex = baseIndex;
    }
    for (const target of targets) {
      if (!target) continue;
      const {pos} = target, at = pos + 2;
      compare(initial.tr.insertText('改', at), 'insert');
      compare(initial.tr.delete(at - 1, at), 'delete');
      if (canSplit(doc, at)) {
        compare(initial.tr.split(at), 'split');
        const tr = initial.tr.insertText('粘贴甲', at).split(at + 3).insertText('粘贴乙', at + 5);
        compare(tr, 'paste');
      }
      if (canJoin(doc, pos)) compare(initial.tr.join(pos), 'join');
      const node = doc.nodeAt(pos)!;
      if (node.type.name === 'paragraph' && doc.resolve(pos).parent.canReplaceWith(doc.resolve(pos).index(), doc.resolve(pos).index() + 1, initial.schema.nodes.heading)) {
        compare(initial.tr.setNodeMarkup(pos, initial.schema.nodes.heading, { level: 2 }), 'heading');
      }
    }
    return { protected: false, local, cases, differences: [...differences] };
  } finally { await surface.destroy(); }
}

export async function repeated() {
  const surfaces = [makeSurface(), makeSurface()];
  const source = Array.from({length: 80}, (_, i) => '段落' + i + '正文').join('\r\n\r\n') + '\r\n';
  try {
    for (const surface of surfaces) await surface.load(source);
    surfaces[1].forceFullSerialization = true;
    let seed = 73007;
    for (let i = 0; i < 50; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const target = seed % 80;
      const index = surfaces[0].blockIndex;
      for (const surface of surfaces) {
        const view: EditorView = surface.richView();
        const block = view.state.doc.child(target);
        let offset = 0;
        for (let j = 0; j < target; j++) offset += view.state.doc.child(j).nodeSize;
        view.dispatch(view.state.tr.insertText(i % 2 ? '改' : '🌱', offset + 1 + (seed % block.content.size)));
      }
      const [actual, full] = surfaces.map(surface => surface.getMarkdown());
      check(index && surfaces[0].blockIndex === index, 'Expected local write ' + i);
      check(hasEquivalentMarkdownStructure(actual, full), 'Sequential edit ' + i);
      const lines = actual.trimEnd().split('\r\n\r\n');
      check(lines.length === 80 && index.ranges.every((r: any,j: number) => lines[j] === actual.slice(r.from,r.to)), 'Offset drift ' + i);
    }
  } finally { for (const surface of surfaces) await surface.destroy(); }
}

export async function fallback(prefix: string, suffix: string, insert: string, reason: string) {
  const s = makeSurface();
  try {
    const source = prefix + '编辑位置' + suffix;
    await s.load(source);
    const v: EditorView = s.richView();
    let at = -1;
    v.state.doc.descendants((node,pos) => { if (node.isText && node.text === '编辑位置') at = pos; });
    check(at >= 0, 'missing edit point ' + reason);
    if (reason === 'missing index') s.blockIndex = null;
    if (reason === 'mismatched source range') {
      // Simulate a stale index pointing one character into the edited paragraph.
      s.blockIndex.ranges[v.state.doc.resolve(at).index(0)].from++;
    }
    if (reason === 'changed context') s.richContextVersion = 'old';
    const index = s.blockIndex;
    v.dispatch(v.state.tr.insertText(insert, at));
    const doc = v.state.doc;
    if (reason === 'exact source') {
      const exact = source.replace('编辑位置', insert + '编辑位置') + '\n\n';
      s.richExactSources.set(JSON.stringify(doc.toJSON()), exact);
      s.serializeRich = () => { throw Error('Exact source invoked writer'); };
      check(s.getMarkdown() === exact && s.blockIndex !== index, reason);
      return;
    }
    const actual = s.getMarkdown();
    if (reason === 'mismatched source range') check(actual === source.replace('编辑位置', insert + '编辑位置'), 'Lost text after rejected splice');
    check(!index || s.blockIndex !== index, 'Expected fallback: ' + reason);
    check(actual.includes('编辑位置') && doc === v.state.doc, reason);
    const ref = makeSurface();
    try {
      await ref.load(source); ref.forceFullSerialization = true;
      const v2 = ref.richView(); v2.dispatch(v2.state.tr.insertText(insert, at));
      check(actual === ref.getMarkdown(), 'Full output: ' + reason);
    } finally { await ref.destroy(); }
  } finally { await s.destroy(); }
}

export function sharedTrees() {
  const original = '# 标题 {#id}\n\n| 表 |\n| --- |\n| <kbd>格</kbd> |\n\n- \n\n$math$ 和 [[双链]]';
  const edited = original.replace('格', '字');
  const release = retainMarkdown(original);
  try {
    const tree = parseMarkdownAst(original), gfm = parseMarkdownAst(original, 'gfm');
    const snapshots = [tree, gfm].map(t => JSON.stringify(t));
    preserveTableSource(original, edited);
    preserveRenderedSource(original, edited);
    preserveEmptyListSource(original, edited);
    preservedMarkdownBlocks(original);
    markdownForWordCount(original);
    markdownOutline(original);
    hasEquivalentMarkdownStructure(original, edited);
    parsePositionedRichMarkdown(original);
    for (let i = 0; i < 12; i++) parseMarkdownAst('文档' + i);
    check(tree === parseMarkdownAst(original) && gfm === parseMarkdownAst(original, 'gfm'), 'Pinned trees evicted');
    check(snapshots[0] !== snapshots[1] && snapshots[0] === JSON.stringify(tree) && snapshots[1] === JSON.stringify(gfm), 'Shared tree mutated');
  } finally { release(); }
}

export async function editSource(source: string, target: string, action: string) {
  const s = makeSurface();
  try {
    await s.load(source);
    check(s.mode === 'rich', 'Sample opened in source mode');
    const view: EditorView = s.richView();
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at >= 0 || !node.isText) return;
      if (!target && node.text && source.split(node.text).length === 2) target = node.text;
      if (target && node.text?.includes(target)) at = pos + node.text.indexOf(target) + target.length;
    });
    check(at >= 0, 'Missing target: ' + target);
    const select = (pos: number) => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
    select(at);
    const key = (key: string, shiftKey = false) => {
      const event = new KeyboardEvent('keydown', { key, shiftKey, keyCode: key === 'Enter' ? 13 : 8, bubbles: true, cancelable: true });
      view.dom.dispatchEvent(event);
    };
    if (action === 'split' || action === 'item') {
      key('Enter');
      if (action === 'item') view.dispatch(view.state.tr.insertText('新桨'));
    }
    else if (action === 'break') key('Enter', true);
    else if (action === 'join') { select(at - target.length); key('Backspace'); }
    else if (action === 'delete') {
      const pos = view.state.doc.resolve(at);
      view.dispatch(view.state.tr.delete(pos.before(1), pos.after(1)));
    } else if (action === 'row') {
      check(addRowAfter(view.state, view.dispatch), 'Could not add table row');
      const cells: number[] = [];
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'table_row' && !node.textContent) node.forEach((_cell, offset) => cells.push(pos + offset + 3));
      });
      const tr = view.state.tr;
      cells.reverse().forEach(pos => tr.insertText('新', pos));
      view.dispatch(tr);
    } else if (action === 'paste') view.pasteText('粘贴内容');
    else {
      if (action === 'composition') view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'zi' }));
      view.dispatch(view.state.tr.insertText('字', at));
      if (action === 'composition') view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '字' }));
    }
    const saved = s.getMarkdown();
    s.format('undo');
    return { target, saved, undone: s.getMarkdown() };
  } finally { await s.destroy(); }
}

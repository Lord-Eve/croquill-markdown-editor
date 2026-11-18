import { MarkdownSurface } from '../../src/editor';
import { hasEquivalentMarkdownStructure, markdownOutline, markdownForWordCount, preservedMarkdownBlocks } from '../../src/fidelity';
import { parseMarkdownAst, retainMarkdown } from '../../src/markdown-ast';
import { parsePositionedRichMarkdown } from '../../src/rich-markdown';
import { preserveEmptyListSource } from '../../src/empty-list';
import { preserveRenderedSource } from '../../src/rendered-source';
import { preserveTableSource } from '../../src/table-source';
import { canJoin, canSplit } from '@milkdown/kit/prose/transform';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { Transaction } from '@milkdown/kit/prose/state';

function makeSurface() {
  const richRoot = document.createElement('div'), sourceRoot = document.createElement('div');
  document.body.append(richRoot, sourceRoot);
  return new MarkdownSurface({ richRoot, sourceRoot, onChange: () => {}, resolveImage: async () => '' }) as any;
}
function check(condition: unknown, message: string) {
  if (!condition) throw Error(message);
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

import { describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/kit/prose/model';
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state';
import {
  buildDocumentAlignment,
  mapRawOffsetToRichSelection,
  mapRichSelectionToRawOffset,
} from '../src/mode-position';

const testSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0] },
    heading: {
      content: 'inline*',
      group: 'block',
      attrs: { level: { default: 1 } },
      toDOM: node => ['h' + node.attrs.level, 0],
    },
    blockquote: { content: 'block+', group: 'block', toDOM: () => ['blockquote', 0] },
    bullet_list: { content: 'list_item+', group: 'block', toDOM: () => ['ul', 0] },
    ordered_list: { content: 'list_item+', group: 'block', toDOM: () => ['ol', 0] },
    list_item: { content: 'block+', toDOM: () => ['li', 0] },
    table: { content: 'paragraph+', group: 'block', toDOM: () => ['table', 0] },
    code_block: { content: 'text*', group: 'block', toDOM: () => ['pre', 0] },
    'image-block': { group: 'block', atom: true, selectable: true, toDOM: () => ['figure'] },
    croquill_raw_block: {
      group: 'block',
      atom: true,
      selectable: true,
      attrs: { value: { default: '' }, kind: { default: 'markdown' } },
      toDOM: () => ['pre'],
    },
    croquill_toc: { group: 'block', atom: true, selectable: true, toDOM: () => ['nav'] },
    footnote_definition: { content: 'paragraph+', group: 'block', toDOM: () => ['div', 0] },
    hr: { group: 'block', atom: true, selectable: true, toDOM: () => ['hr'] },
    text: { group: 'inline' },
    hardbreak: { inline: true, group: 'inline', selectable: false, toDOM: () => ['br'] },
    custom_inline: { inline: true, group: 'inline', atom: true, toDOM: () => ['span'] },
    croquill_inline_raw: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: { value: { default: '' } },
      toDOM: () => ['span'],
    },
    footnote_reference: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: { label: { default: '' } },
      toDOM: () => ['sup'],
    },
  },
});

describe('mode-position deterministic alignment unit tests', () => {
  it('maps exact offsets inside headings, inline syntax markers, CJK text, and soft/hard breaks', () => {
    const raw = '# 标题 **一**\n\n中文 **加粗** 与 `代码` 与 [链接](https://a.com "t")\n\n第一行  \n第二行<br />第三行';
    const richDoc = testSchema.node('doc', null, [
      testSchema.node('heading', { level: 1 }, [testSchema.text('标题 **一**')]),
      testSchema.node('paragraph', null, [testSchema.text('中文 **加粗** 与 `代码` 与 [链接](https://a.com "t")')]),
      testSchema.node('paragraph', null, [
        testSchema.text('第一行'),
        testSchema.node('hardbreak'),
        testSchema.text('第二行'),
        testSchema.node('hardbreak'),
        testSchema.text('第三行'),
      ]),
    ]);

    const alignment = buildDocumentAlignment(raw, richDoc);

    // Heading offset between '**' and '一'
    const boldWordOffset = raw.indexOf('一');
    const richHeadingSel = mapRawOffsetToRichSelection(alignment, richDoc, boldWordOffset);
    expect(mapRichSelectionToRawOffset(alignment, raw.length, richHeadingSel)).toBe(boldWordOffset);

    // Inline link URL middle
    const linkMid = raw.indexOf('a.com') + 1;
    const richLinkSel = mapRawOffsetToRichSelection(alignment, richDoc, linkMid);
    expect(mapRichSelectionToRawOffset(alignment, raw.length, richLinkSel)).toBe(linkMid);

    // Hard breaks: before '  \n' and start of line 2 & line 3
    const beforeBr1 = raw.indexOf('  \n第二行');
    const selBeforeBr1 = mapRawOffsetToRichSelection(alignment, richDoc, beforeBr1);
    expect(mapRichSelectionToRawOffset(alignment, raw.length, selBeforeBr1)).toBe(beforeBr1);

    const startLine2 = raw.indexOf('第二行');
    const selStartLine2 = mapRawOffsetToRichSelection(alignment, richDoc, startLine2);
    expect(mapRichSelectionToRawOffset(alignment, raw.length, selStartLine2)).toBe(startLine2);

    const startLine3 = raw.indexOf('第三行');
    const selStartLine3 = mapRawOffsetToRichSelection(alignment, richDoc, startLine3);
    expect(mapRichSelectionToRawOffset(alignment, raw.length, selStartLine3)).toBe(startLine3);
  });

  it('handles CRLF + BOM + YAML frontmatter without shifting body offsets', () => {
    const raw = '\uFEFF---\r\ntitle: 测试\r\n---\r\n\r\n# 标题\r\n\r\n> 第一行\r\n> 第二行';
    const richDoc = testSchema.node('doc', null, [
      testSchema.node('heading', { level: 1 }, [testSchema.text('标题')]),
      testSchema.node('blockquote', null, [testSchema.node('paragraph', null, [testSchema.text('第一行\n第二行')])]),
    ]);

    const alignment = buildDocumentAlignment(raw, richDoc);

    const line2Mid = raw.indexOf('二行');
    const richSel = mapRawOffsetToRichSelection(alignment, richDoc, line2Mid);
    expect(mapRichSelectionToRawOffset(alignment, raw.length, richSel)).toBe(line2Mid);

    // Cursor inside frontmatter falls back to start of first body block (after frontmatter)
    const fmOffset = raw.indexOf('测试');
    const fmSel = mapRawOffsetToRichSelection(alignment, richDoc, fmOffset);
    expect(fmSel.from).toBeGreaterThanOrEqual(1);
    expect(fmSel.from).toBeLessThanOrEqual(4);
  });

  it('handles GFM task list items and empty list items accurately', () => {
    const raw = '1. [x] 完成 **任务**\n2. ';
    const richDoc = testSchema.node('doc', null, [
      testSchema.node('ordered_list', null, [
        testSchema.node('list_item', null, [testSchema.node('paragraph', null, [testSchema.text('完成 **任务**')])]),
        testSchema.node('list_item', null, [testSchema.node('paragraph', null, [])]),
      ]),
    ]);

    const alignment = buildDocumentAlignment(raw, richDoc);
    const taskWord = raw.indexOf('任务');
    const richTaskSel = mapRawOffsetToRichSelection(alignment, richDoc, taskWord);
    expect(mapRichSelectionToRawOffset(alignment, raw.length, richTaskSel)).toBe(taskWord);

    // Caret inside '[x] ' prefix stays at offset 0 inside item 1's paragraph
    const insideCheckbox = raw.indexOf('x]');
    const checkboxSel = mapRawOffsetToRichSelection(alignment, richDoc, insideCheckbox);
    expect(checkboxSel.from).toBe(mapRawOffsetToRichSelection(alignment, richDoc, raw.indexOf('完成')).from);

    // Empty list item maps to raw position at '2. |'
    const emptyEnd = raw.length;
    const emptySel = mapRawOffsetToRichSelection(alignment, richDoc, emptyEnd);
    expect(mapRichSelectionToRawOffset(alignment, raw.length, emptySel)).toBe(emptyEnd);
  });

  it('falls back degenerate blocks to THAT block start and never crosses into adjacent blocks', () => {
    const raw = [
      '前段正文',
      '',
      '```js',
      'const a = 1;',
      'const b = 2;',
      '```',
      '',
      '| A | B |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '# 保护 {#raw-id}',
      '',
      '后段正文',
    ].join('\n');

    const richDoc = testSchema.node('doc', null, [
      testSchema.node('paragraph', null, [testSchema.text('前段正文')]),
      testSchema.node('code_block', null, [testSchema.text('const a = 1;\nconst b = 2;')]),
      testSchema.node('table', null, [testSchema.node('paragraph', null, [testSchema.text('A')]), testSchema.node('paragraph', null, [testSchema.text('1')])]),
      testSchema.node('croquill_raw_block', { value: '# 保护 {#raw-id}', kind: 'markdown' }),
      testSchema.node('paragraph', null, [testSchema.text('后段正文')]),
    ]);

    const alignment = buildDocumentAlignment(raw, richDoc);

    // Code block fallback stays inside code block start
    const codeMid = raw.indexOf('const b');
    const richCodeSel = mapRawOffsetToRichSelection(alignment, richDoc, codeMid);
    const codeBlockStart = raw.indexOf('```js');
    expect(mapRichSelectionToRawOffset(alignment, raw.length, richCodeSel)).toBe(codeBlockStart);

    // Table fallback stays at table start, not previous code block or next raw block
    const tableCellMid = raw.indexOf('| 1 | 2 |') + 2;
    const richTableSel = mapRawOffsetToRichSelection(alignment, richDoc, tableCellMid);
    const tableStart = raw.indexOf('| A | B |');
    expect(mapRichSelectionToRawOffset(alignment, raw.length, richTableSel)).toBe(tableStart);

    // Raw block NodeSelection <-> rawStart of raw block
    const rawBlockMid = raw.indexOf('#raw-id');
    const richRawSel = mapRawOffsetToRichSelection(alignment, richDoc, rawBlockMid);
    expect(richRawSel).toBeInstanceOf(NodeSelection);
    expect(mapRichSelectionToRawOffset(alignment, raw.length, richRawSel)).toBe(raw.indexOf('# 保护'));

    // Non-empty Rich selection uses head
    const afterStart = raw.indexOf('后段正文');
    const afterBlock = alignment.blocks[alignment.blocks.length - 1];
    const rangeSel = TextSelection.create(richDoc, afterBlock.richPos + 1 + 4, afterBlock.richPos + 1 + 1);
    expect(mapRichSelectionToRawOffset(alignment, raw.length, rangeSel)).toBe(afterStart + 1);
  });

  it.each(['paragraph', 'heading'])('falls back inside a matched %s with an unmapped inline node', type => {
    const before = '前段';
    const marker = type === 'heading' ? '# ' : '';
    const raw = `${before}\n\n${marker}片段前<span>原文</span>片段后\n\n尾段`;
    const first = testSchema.node('paragraph', null, [testSchema.text(before)]);
    const opaque = testSchema.node(type, null, [
      testSchema.text('片段前'), testSchema.node('custom_inline'), testSchema.text('片段后'),
    ]);
    const last = testSchema.node('paragraph', null, [testSchema.text('尾段')]);
    const richDoc = testSchema.node('doc', null, [first, opaque, last]);
    const alignment = buildDocumentAlignment(raw, richDoc);
    const richStart = first.nodeSize + 1;
    const rawStart = raw.indexOf(marker + '片段前');

    for (let offset = 0; offset <= opaque.content.size; offset++) {
      const selection = TextSelection.create(richDoc, richStart + offset);
      expect(mapRichSelectionToRawOffset(alignment, raw.length, selection)).toBe(rawStart);
    }
    for (const offset of [rawStart, raw.indexOf('原文'), raw.indexOf('片段后') + 1]) {
      expect(mapRawOffsetToRichSelection(alignment, richDoc, offset).head).toBe(richStart);
    }
    const tail = raw.indexOf('尾段') + 1;
    const tailSelection = mapRawOffsetToRichSelection(alignment, richDoc, tail);
    expect(tailSelection.head).toBe(first.nodeSize + opaque.nodeSize + 2);
    expect(mapRichSelectionToRawOffset(alignment, raw.length, tailSelection)).toBe(tail);
  });

  it('falls back to its own start when a matched paragraph fails text verification', () => {
    const raw = '前段\n\n源码里的原句\n\n尾段';
    const first = testSchema.node('paragraph', null, [testSchema.text('前段')]);
    const mismatch = testSchema.node('paragraph', null, [testSchema.text('编辑器里的句子')]);
    const last = testSchema.node('paragraph', null, [testSchema.text('尾段')]);
    const richDoc = testSchema.node('doc', null, [first, mismatch, last]);
    const alignment = buildDocumentAlignment(raw, richDoc);
    const richStart = first.nodeSize + 1;
    const rawStart = raw.indexOf('源码');

    const inside = TextSelection.create(richDoc, richStart + 2);
    expect(mapRichSelectionToRawOffset(alignment, raw.length, inside)).toBe(rawStart);
    expect(mapRawOffsetToRichSelection(alignment, richDoc, rawStart + 2).head).toBe(richStart);
  });

  it('rejects unverified raw and structurally mismatched blocks and keeps verified neighbors usable', () => {
    const before = '前段正文';
    const raw = `${before}\n\n<div>\n\n原文\n\n</div>\n\n> 中段正文\n\n后段正文`;
    const first = testSchema.node('paragraph', null, [testSchema.text(before)]);
    const opaque = testSchema.node('croquill_raw_block', { value: '<div>\n\n别的原文\n\n</div>' });
    const mismatch = testSchema.node('blockquote', null, [
      testSchema.node('heading', null, [testSchema.text('未通过校验')]),
    ]);
    const last = testSchema.node('paragraph', null, [testSchema.text('后段正文')]);
    const richDoc = testSchema.node('doc', null, [first, opaque, mismatch, last]);
    const alignment = buildDocumentAlignment(raw, richDoc);

    const rawSelection = NodeSelection.create(richDoc, first.nodeSize);
    const textSelection = TextSelection.create(richDoc, first.nodeSize + opaque.nodeSize + 3);
    for (const selection of [rawSelection, textSelection]) {
      expect(mapRichSelectionToRawOffset(alignment, raw.length, selection)).toBe(before.length);
    }
    for (const offset of [raw.indexOf('原文'), raw.indexOf('> 中段'), raw.indexOf('中段') + 1]) {
      expect(mapRawOffsetToRichSelection(alignment, richDoc, offset).head).toBe(first.nodeSize - 1);
    }

    const lastOffset = raw.indexOf('后段正文') + 1;
    const lastSelection = mapRawOffsetToRichSelection(alignment, richDoc, lastOffset);
    expect(lastSelection.head).toBe(first.nodeSize + opaque.nodeSize + mismatch.nodeSize + 2);
    expect(mapRichSelectionToRawOffset(alignment, raw.length, lastSelection)).toBe(lastOffset);
  });
});

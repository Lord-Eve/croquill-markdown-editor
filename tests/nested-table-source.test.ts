import { describe, expect, it } from 'vitest';
import { preserveTableSource } from '../src/table-source';

const originalRows = ['| A | B |', '| :------ | -------: |', '| 一<br/>二<BR>三 |   旧字  |', '| 剩下 | 不动 |'];
const serializedRows = ['| A                | B  |', '| :--------------- | -: |', '| 一<br/>二<BR>三 | 新字 |', '| 剩下             | 不动 |'];
export const nestedContexts = [
  { name: 'blockquote', first: '> ', rest: '> ' },
  { name: 'list', first: '- ', rest: '  ' },
  { name: 'nested blockquotes', first: '>> ', rest: '>> ' },
  { name: 'quote list quote', first: '> - > ', rest: '>   > ' },
];
const wrap = (rows: string[], first: string, rest: string, newline: string) => rows.map((row, index) => (index ? rest : first) + row).join(newline) + newline;

describe('nested BR table source layout', () => {
  it.each(nestedContexts.flatMap(context => ['\n', '\r\n'].map(newline => ({ ...context, newline }))))('only replaces the edited cell in $name ($newline)', ({ first, rest, newline }) => {
    const original = wrap(originalRows, first, rest, newline);
    const serialized = wrap(serializedRows, first.replace('>>', '> >'), rest.replace('>>', '> >'), '\n');
    expect(preserveTableSource(original, serialized)).toBe(original.replace('旧字', '新字'));
  });

  it.each(nestedContexts)('preserves the nested $name table after an edit elsewhere', ({ first, rest }) => {
    const table = wrap(originalRows, first, rest, '\r\n');
    const original = '无关段落\n\n' + table;
    const serialized = '新无关段落\n\n' + wrap(serializedRows.map(row => row.replace('新字', '旧字')), first, rest, '\n');
    expect(preserveTableSource(original, serialized)).toBe('新' + original);
  });

  it('keeps changes to table containers instead of restoring old nesting', () => {
    const original = wrap(originalRows, '> ', '> ', '\r\n');
    const serialized = wrap(serializedRows, '- ', '  ', '\n');
    expect(preserveTableSource(original, serialized)).toBe(serialized);
  });

  it('keeps inserted rows and changed alignment from the normal writer', () => {
    const original = wrap(originalRows, '> - ', '>   ', '\r\n');
    for (const rows of [[...serializedRows, '| 新行 | 内容 |'], serializedRows.map(row => row.replace(':---------------', '----------------'))]) {
      const serialized = wrap(rows, '> - ', '>   ', '\n');
      expect(preserveTableSource(original, serialized)).toBe(serialized);
    }
  });
});

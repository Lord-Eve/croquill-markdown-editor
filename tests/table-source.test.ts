import { describe, expect, it } from 'vitest';
import { preserveTableSource } from '../src/table-source';

describe('editable BR table source layout', () => {
  it.each(['\n', '\r\n'])('splices a cell edit without reformatting other cells (%j)', newline => {
    const original = ['| 标题一 | 标题二 |', '| :---- | -----: |', '| 一<br/>二<BR>三 |   原文字  |', ''].join(newline);
    const serialized = '| 标题一          | 标题二 |\n| :----------- | --: |\n| 一<br/>二<BR>三 | 新文字 |\n';
    expect(preserveTableSource(original, serialized)).toBe(original.replace('原文字', '新文字'));
  });

  it('applies break insertion and deletion instead of restoring deleted source', () => {
    const original = '| A | B |\n| --- | --- |\n| 一<br />二 | 三 |';
    const serialized = '| A | B |\n| - | - |\n| 一二 | 三<br>四 |\n';
    expect(preserveTableSource(original, serialized)).toBe(original.replace('一<br />二', '一二').replace('三', '三<br>四'));
  });

  it('keeps structural changes from the normal writer', () => {
    const original = '| A | B |\n| --- | --- |\n| 一<br>二 | 三 |\n';
    const serialized = '| A | B |\n| - | - |\n| 一<br>二 | 三 |\n| 新行 | 内容 |\n';
    expect(preserveTableSource(original, serialized)).toBe(serialized);
  });

  it('leaves ordinary tables with the existing writer', () => {
    const original = '| A | B |\n| --- | --- |\n| 一 | 三 |\n';
    const serialized = '| A | B |\n| - | - |\n| 一 | 四 |\n';
    expect(preserveTableSource(original, serialized)).toBe(serialized);
  });
});

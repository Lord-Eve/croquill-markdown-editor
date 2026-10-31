import { describe, expect, it } from 'vitest';
import { preserveRenderedSource } from '../src/rendered-source';

describe('literal source of rendered extensions after edits elsewhere', () => {
  it.each(['\n', '\r\n'])('retains a multi-paragraph alert after inserting an unrelated paragraph (%j)', newline => {
    const alert = ['> [!NOTE]', '> __原始写法__', '>', '> 第二段', '', ''].join(newline);
    const original = '前段' + newline + newline + alert + '尾段' + newline;
    const serialized = '前段\n\n新增段\n\n> [!NOTE]\n> **原始写法**\n>\n> 第二段\n\n尾段\n';
    expect(preserveRenderedSource(original, serialized)).toBe('前段\n\n新增段\n\n' + alert + '尾段\n');
  });

  it.each(['\n', '\r\n'])('retains an alert after deleting an unrelated paragraph (%j)', newline => {
    const alert = ['> [!TIP]', '> __原始写法__', '', ''].join(newline);
    const original = '删除这段' + newline + newline + alert + '尾段' + newline;
    const serialized = '> [!TIP]\n> **原始写法**\n\n尾段\n';
    expect(preserveRenderedSource(original, serialized)).toBe(alert + '尾段\n');
  });

  it('recognizes highlights across formatted child nodes and keeps duplicate source spellings in order', () => {
    const first = '==__相同内容__==\r\n\r\n', second = '==**相同内容**==\n';
    const original = first + second;
    const serialized = '新增段\n\n==**相同内容**==\n\n==**相同内容**==\n';
    expect(preserveRenderedSource(original, serialized)).toBe('新增段\n\n' + first + second);
  });

  it('retains an unchanged formatted highlight while applying a separate highlight edit', () => {
    const first = '==__相同内容__==\r\n\r\n';
    const original = first + '==**相同内容**==\n';
    const serialized = '新增段\n\n==**相同内容**==\n\n==**已编辑内容**==\n';
    expect(preserveRenderedSource(original, serialized)).toBe('新增段\n\n' + first + '==**已编辑内容**==\n');
  });

  it('does not reuse one original source range for multiple identical copies', () => {
    const original = '==__原始写法__==\r\n\r\n尾段\r\n';
    const serialized = '==**原始写法**==\n\n==**原始写法**==\n\n尾段\n';
    expect(preserveRenderedSource(original, serialized)).toBe('==__原始写法__==\r\n\r\n==**原始写法**==\n\n尾段\n');
  });

  it('retains a literal comment after a neighboring block is removed', () => {
    const comment = '<!-- 原文 \r\n  空白 -->';
    const original = '删除段\r\n\r\n' + comment;
    expect(preserveRenderedSource(original, comment + '\n')).toBe(comment);
  });

  it('preserves a required new separator instead of merging distinct paragraphs', () => {
    const original = '==原文==';
    const serialized = '==原文==\n\n新增段\n';
    expect(preserveRenderedSource(original, serialized)).toBe(serialized);
  });

  it('does not restore an old alert over edited content or a different container', () => {
    const original = '> [!NOTE]\r\n> __原文__\r\n';
    for (const serialized of ['> [!NOTE]\n> **新文字**\n', '- > [!NOTE]\n  > **原文**\n']) {
      expect(preserveRenderedSource(original, serialized)).toBe(serialized);
    }
  });

  it('retains a comment continuation prefix and CRLF while another paragraph in the same quote changes', () => {
    const raw = ' <!-- 原样\r\n>\t续行文字\r\n> -->';
    const original = '> ' + raw + '\r\n>\r\n> 原段落\r\n';
    const serialized = '>  <!-- 原样\n>   续行文字\n> -->\n>\n> 已编辑段落\n';
    expect(preserveRenderedSource(original, serialized)).toBe('> ' + raw + '\n>\n> 已编辑段落\n');
  });

  it('retains a comment in an edited list item with the same container context', () => {
    const raw = '<!-- 原样\r\n   续行 -->';
    const original = '- 原段落\r\n\r\n  ' + raw + '\r\n';
    const serialized = '- 已编辑段落\n\n  <!-- 原样\n   续行 -->\n';
    expect(preserveRenderedSource(original, serialized)).toBe('- 已编辑段落\n\n  ' + raw + '\n');
  });

  it('never restores old continuation prefixes after a comment moves to a different quote depth', () => {
    const original = '> <!-- 原样\r\n> 续行 -->\r\n';
    const serialized = '> > <!-- 原样\n> > 续行 -->\n';
    expect(preserveRenderedSource(original, serialized)).toBe(serialized);
  });
});

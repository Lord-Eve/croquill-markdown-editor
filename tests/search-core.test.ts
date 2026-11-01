import { describe, expect, it } from 'vitest';
import { applySourceChanges, defaultSearchOptions, findSourceMatches, normalizedOffset, normalizedSource, replacementProblem, sourceOffset } from '../src/search-core';

describe('literal source search and byte-preserving patches', () => {
  it('finds literal special characters and case variants without regex expansion', () => {
    expect(findSourceMatches('a.b A.B aXb', 'a.b', defaultSearchOptions)).toEqual([{ from: 0, to: 3 }, { from: 4, to: 7 }]);
    expect(findSourceMatches('a.b A.B', 'a.b', { ...defaultSearchOptions, caseSensitive: true })).toEqual([{ from: 0, to: 3 }]);
    expect(findSourceMatches('[x] $& \\', '[x]', defaultSearchOptions)).toHaveLength(1);
    expect(findSourceMatches('abc', '', defaultSearchOptions)).toEqual([]);
    expect(findSourceMatches('aaaa', 'aa', defaultSearchOptions)).toHaveLength(2);
  });
  it('uses Unicode word boundaries, including Chinese, combining marks and astral letters', () => {
    const options = { ...defaultSearchOptions, wholeWord: true };
    expect(findSourceMatches('cat cats bobcat CAT cat_ _cat cat2 cat', 'cat', options)).toHaveLength(3);
    expect(findSourceMatches('中文，中文词；中文。', '中文', options)).toHaveLength(2);
    expect(findSourceMatches('a\u0301 a 𐐀a a𐐀', 'a', options)).toHaveLength(1);
  });
  it('splices only selected ranges, retaining BOM, mixed EOLs, whitespace and literal replacement dollars', () => {
    const source = '\uFEFF# a\r\n\r\n__a__  \n\n| a | <span>a\\|b</span> |\r';
    const matches = findSourceMatches(source, 'a', { ...defaultSearchOptions, caseSensitive: true });
    const result = applySourceChanges(source, [matches[0], matches[1]].map(match => ({ ...match, insert: '$&' })));
    expect(result).toBe('\uFEFF# $&\r\n\r\n__$&__  \n\n| a | <span>a\\|b</span> |\r');
    expect(() => applySourceChanges(source, [{ from: 7, to: 9, insert: '' }, { from: 3, to: 4, insert: '' }])).toThrow();
    expect(() => applySourceChanges(source, [{ from: 0, to: 999, insert: '' }])).toThrow();
  });
  it('maps every logical offset through mixed line endings', () => {
    const source = '\uFEFF甲\r\n乙\n丙\r丁😀\r\n';
    const normalized = normalizedSource(source);
    for (let index = 0; index <= normalized.length; index++) {
      const raw = sourceOffset(source, index);
      expect(normalizedOffset(source, raw)).toBe(index);
      expect(normalizedSource(source.slice(0, raw))).toBe(normalized.slice(0, index));
    }
  });
  it('prevents replacement from splitting tables while allowing escaped pipes and nested tables', () => {
    const source = '> | 一 | 二 |\n> | --- | --- |\n> | <span>甲\\|乙</span> | 查找 |\n';
    expect(replacementProblem(source, source.replace('查找', '替换'))).toBeNull();
    expect(replacementProblem(source, source.replace('查找', '坏|格'))).toContain('表格结构');
    expect(replacementProblem(source, source.replace('查找', '坏\n行'))).toContain('表格结构');
    expect(replacementProblem(source, source.replace('查找', '合法\\|格'))).toBeNull();
  });
  it('keeps metadata outside the table guard and uses full source offsets after BOM/frontmatter', () => {
    const source = '\uFEFF---\r\ncontent: |\r\n  | 甲 | 乙 |\r\n  | --- | --- |\r\n  | 查找 | 不动 |\r\n---\r\n\r\n| 甲 | 乙 |\r\n| --- | --- |\r\n| 查找 | 不动 |\r\n';
    const from = source.lastIndexOf('查找');
    expect(replacementProblem(source, source.slice(0, from) + '坏\n行' + source.slice(from + 2), [{ from, to: from + 2, insert: '坏\n行' }])).toContain('表格结构');
    expect(replacementProblem(source, source.replace('查找', '允许|原文'))).toBeNull();
  });
});

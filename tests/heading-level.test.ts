import { describe, expect, it } from 'vitest';
import { nextHeadingLevel, sourceHeadingChange } from '../src/heading-level';

const apply = (line: string, action: string) => {
  const change = sourceHeadingChange(line, action);
  return change ? line.slice(0, change.from) + change.insert + line.slice(change.to) : line;
};

describe('heading level rules observed in official Typora', () => {
  it('sets a level, and returns to a paragraph when the same level is pressed again', () => {
    expect(nextHeadingLevel('heading3', 0)).toBe(3);
    expect(nextHeadingLevel('heading3', 2)).toBe(3);
    expect(nextHeadingLevel('heading1', 1)).toBe(0);
    expect(nextHeadingLevel('h4', 4)).toBe(0);
    expect(nextHeadingLevel('paragraph', 5)).toBe(0);
  });

  it('raises a paragraph to H6 and stops at H1', () => {
    expect([0, 6, 5, 4, 3, 2, 1].map(level => nextHeadingLevel('heading-up', level))).toEqual([6, 5, 4, 3, 2, 1, 1]);
  });

  it('lowers H6 to a paragraph and leaves a paragraph alone', () => {
    expect([1, 2, 3, 4, 5, 6, 0].map(level => nextHeadingLevel('heading-down', level))).toEqual([2, 3, 4, 5, 6, 0, 0]);
  });

  it('ignores non-heading actions', () => {
    for (const action of ['bold', 'quote', 'heading7', 'heading0', '']) expect(nextHeadingLevel(action, 2)).toBeNull();
  });

  it('rewrites only the ATX prefix of a source line', () => {
    expect(apply('正文', 'heading2')).toBe('## 正文');
    expect(apply('## 标题 **粗** ##', 'heading1')).toBe('# 标题 **粗** ##');
    expect(apply('## 标题', 'heading2')).toBe('标题');
    expect(apply('###   多空格', 'paragraph')).toBe('多空格');
    expect(apply('  ### 缩进', 'heading-up')).toBe('  ## 缩进');
    expect(apply('###### 六级', 'heading-down')).toBe('六级');
    expect(apply('正文', 'heading-up')).toBe('###### 正文');
    expect(apply('##', 'heading3')).toBe('### ');
  });

  it('does not treat #tag, seven hashes or indented code as a heading', () => {
    expect(apply('#标签', 'heading2')).toBe('## #标签');
    expect(apply('####### 七个', 'paragraph')).toBe('####### 七个');
    expect(apply('    # 代码', 'heading-down')).toBe('    # 代码');
  });

  it('reports no change when the line already matches', () => {
    expect(sourceHeadingChange('正文', 'paragraph')).toBeNull();
    expect(sourceHeadingChange('# 一级', 'heading-up')).toBeNull();
    expect(sourceHeadingChange('正文', 'heading-down')).toBeNull();
    expect(sourceHeadingChange('正文', 'bold')).toBeNull();
  });
});

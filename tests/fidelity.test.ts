import { describe, expect, it } from 'vitest';
import { detectUnsafeMarkdown, hasEquivalentMarkdownStructure, markdownOutline } from '../src/fidelity';

describe('Markdown protection', () => {
  it('preserves opaque frontmatter, HTML and extension documents in source', () => {
    for (const text of [
      '---\ntitle: 中文\n---\n\n正文',
      '<details>\n<summary>说明</summary>\n隐藏内容\n</details>',
      '正文[^note]\n\n[^note]: 注释',
      '[[双向链接]]',
      '::: warning\n注意\n:::',
    ]) expect(detectUnsafeMarkdown(text)).not.toBeNull();
  });

  it('does not mistake code samples or CommonMark autolinks for raw HTML', () => {
    expect(detectUnsafeMarkdown('```html\n<div>代码</div>\n```\n\n`<b>示例</b>`')).toBeNull();
    expect(detectUnsafeMarkdown('<https://example.com>')).toBeNull();
    expect(detectUnsafeMarkdown('    <div>缩进代码</div>')).toBeNull();
    expect(detectUnsafeMarkdown('数学 $x^2$\n\n$$\ny^2\n$$')).toBeNull();
  });

  it('accepts equivalent CommonMark/GFM serialization but detects dropped structure', () => {
    expect(hasEquivalentMarkdownStructure('# 标题\r\n\r\n__加粗__\r\n', '# 标题\n\n**加粗**\n')).toBe(true);
    expect(hasEquivalentMarkdownStructure('- [x] 完成\n- [ ] 待办', '* [x] 完成\n* [ ] 待办\n')).toBe(true);
    expect(hasEquivalentMarkdownStructure('![中文](图片 空格.png)', '正文')).toBe(false);
    expect(hasEquivalentMarkdownStructure('| 一 | 二 |\n| --- | --- |\n| 甲 | 乙 |', '一 二 甲 乙')).toBe(false);
    expect(hasEquivalentMarkdownStructure('```ts\nconst a = 1\n```', '```\nconst a = 1\n```')).toBe(false);
    expect(hasEquivalentMarkdownStructure('$x^2$\n\n$$\nx^2 + y^2 = 1\n$$', '$x^2$\n\n$$\nx^2 + y^2 = 1\n$$\n')).toBe(true);
    expect(hasEquivalentMarkdownStructure('售价 $5 and $10', '售价 \\$5 and \\$10')).toBe(true);
  });

  it('outline uses real Markdown headings and ignores fenced samples', () => {
    expect(markdownOutline('# 标题\n\n```md\n## 假标题\n```\n\n二级 **章节**\n---')).toEqual([
      { level: 1, text: '标题', line: 1 },
      { level: 2, text: '二级 章节', line: 7 },
    ]);
    expect(markdownOutline('---\ntitle: 元数据\n---\n\n# 正文')).toEqual([{ level: 1, text: '正文', line: 5 }]);
  });
});

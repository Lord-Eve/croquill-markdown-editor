import { describe, expect, it } from 'vitest';
import { detectUnsafeMarkdown, hasEquivalentMarkdownStructure, markdownOutline, splitFrontmatter, preservedMarkdownBlocks } from '../src/fidelity';

describe('Markdown protection', () => {
  it('only protects metadata that cannot yet be separated safely', () => {
    expect(detectUnsafeMarkdown('+++\ntitle = "text"\n+++')).not.toBeNull();
    expect(detectUnsafeMarkdown('---\ntitle: unfinished')).not.toBeNull();
    for (const value of ['a<b', 'x > y', 'Promise<string>', '<br>', '==高亮==', '[TOC]', '正文[^1]\n\n[^1]: 脚注', '[[链接]]', '::: note\n文本\n:::']) {
      expect(detectUnsafeMarkdown(value)).toBeNull();
    }
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

  it('uses parsed HTML nodes instead of matching angle brackets in ordinary text', () => {
    expect(preservedMarkdownBlocks('价格 a<b 和 x > y')).toHaveLength(0);
    expect(preservedMarkdownBlocks('返回 Promise<string> 类型')[0].categories).toContain('HTML');
    expect(preservedMarkdownBlocks('第一行<br>第二行')[0].categories).toContain('HTML');
  });

  it('keeps metadata separators without swallowing indented body code', () => {
    const header='---\r\ntitle: test\r\n---\r\n\r\n';
    expect(splitFrontmatter(header+'    code').prefix).toBe(header);
    expect(splitFrontmatter(header+'    code').body).toBe('    code');
    expect(hasEquivalentMarkdownStructure(header+'正文',header.replace('test','changed')+'正文')).toBe(false);
  });

  it('outline uses real Markdown headings and ignores fenced samples', () => {
    expect(markdownOutline('# 标题\n\n```md\n## 假标题\n```\n\n二级 **章节**\n---')).toEqual([
      { level: 1, text: '标题', line: 1 },
      { level: 2, text: '二级 章节', line: 7 },
    ]);
    expect(markdownOutline('---\ntitle: 元数据\n---\n\n# 正文')).toEqual([{ level: 1, text: '正文', line: 5 }]);
  });
});

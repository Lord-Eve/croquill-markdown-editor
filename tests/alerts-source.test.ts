import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { alertMarkdownHandlers, alertTypeOf, parseAlerts } from '../src/alerts';

const parser = () => unified().use(remarkParse).use(parseAlerts).use(remarkStringify, { bullet: '-', handlers: alertMarkdownHandlers });

describe('GitHub-style alert syntax', () => {
  it('turns the official marker into an editable alert container', () => {
    const processor = parser();
    const tree = processor.runSync(processor.parse('> [!NOTE]\n> 注意 **正文**'));
    expect(tree.children[0].type).toBe('croquillAlert');
  });

  it.each(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'])('writes the %s marker without escaping and retains editable formatted content', type => {
    const processor = parser();
    const source = `> [!${type}]\n> 注意 **正文**\n>\n> - 一\n> - 二\n`;
    const result = String(processor.processSync(source));
    expect(result).toBe(source);
    expect(result).not.toContain('\\[!');
  });

  it.each(['> [!UNKNOWN]\n> 普通引用', '> \\[!NOTE]\n> 普通引用', '> [!NOTE] 同一行的普通引用'])('does not convert unsupported or ordinary quote text: %s', source => {
    const processor = parser();
    const tree = processor.runSync(processor.parse(source), { value: source });
    expect(tree.children[0].type).toBe('blockquote');
  });

  it.each(['> [!NOTE]', '> [!NOTE]\n>', '> [!NOTE]  \n> 正文'])('keeps a marker-only alert editable and writes a valid marker: %s', source => {
    const processor = parser();
    const tree = processor.runSync(processor.parse(source), { value: source });
    const alert = tree.children[0] as any;
    expect(alert.type).toBe('croquillAlert');
    expect(alert.children.length).toBeGreaterThan(0);
    expect(processor.stringify(tree)).toMatch(/^> \[!NOTE\](?:\n|$)/);
  });

  it('parses nested quote and list content without consuming inner content', () => {
    const processor = parser();
    const source = '> [!IMPORTANT]\n> 重点\n>\n> > 内层引用\n>\n> - 列表\n>   - 子项\n';
    const result = String(processor.processSync(source));
    expect(result).toBe(source);
    const ordinary = unified().use(remarkParse).parse(result).children[0];
    expect(alertTypeOf(ordinary as any, result)).toBe('IMPORTANT');
  });
});

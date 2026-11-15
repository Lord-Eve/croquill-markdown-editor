import { describe, expect, it } from 'vitest';
import { escapeCellPipes, guardLineStart, inlineMarkers, inlineSourceText, inlineSyntaxSpans } from '../src/inline-source';

const show = (run: string) => inlineSyntaxSpans(run).map(span => `${span.kind}:${run.slice(span.from, span.innerFrom)}|${run.slice(span.innerFrom, span.innerTo)}|${run.slice(span.innerTo, span.to)}`);

describe('inline source spans', () => {
  it('finds each construct with its own markers', () => {
    expect(show('前文 **加粗** 中 *斜体* 及 `代码` 和 ~~删除~~ 与 ==高亮== 尾')).toEqual([
      'strong:**|加粗|**', 'em:*|斜体|*', 'code:`|代码|`', 'strike:~~|删除|~~', 'highlight:==|高亮|==',
    ]);
  });

  it('keeps the original marker spelling', () => {
    expect(show('__粗__ 和 _斜_ 及 ``含`反引号`` 与 ~单波浪~')).toEqual(['strong:__|粗|__', 'em:_|斜|_', 'code:``|含`反引号|``', 'strike:~|单波浪|~']);
  });

  it('highlights without surrounding spaces and across formatted children', () => {
    expect(show('第一段的==重点文字==应为黄色')).toEqual(['highlight:==|重点文字|==']);
    expect(show('比较==**粗**、_斜_、`码`==与')).toEqual(['highlight:==|**粗**、_斜_、`码`|==', 'strong:**|粗|**', 'em:_|斜|_', 'code:`|码|`']);
  });

  it('nests and reports outer spans first', () => {
    expect(show('***粗斜*** 与 **粗*内*粗**')).toEqual(['em:*|**粗斜**|*', 'strong:**|粗斜|**', 'strong:**|粗*内*粗|**', 'em:*|内|*']);
  });

  it('treats escapes and entities as spans, never as delimiters', () => {
    expect(show('\\*不是斜体\\* 与 &amp; 及 \\==不是高亮\\==')).toEqual(['escape:\\|*|', 'escape:\\|*|', 'entity:&amp;||', 'escape:\\|=|', 'escape:\\|=|']);
    expect(inlineSyntaxSpans('A&amp;B')[0].value).toBe('&');
    expect(show('&notanentity; 与 a & b')).toEqual([]);
  });

  it('leaves code, unmatched and spaced delimiters alone', () => {
    expect(show('`==代码==` 与 ==未闭合 及 == 空格 == 和 **未闭合')).toEqual(['code:`|==代码==|`']);
    expect(show('a*b 与 2 * 3')).toEqual([]);
  });

  it('does not let a block marker at the start of the run hide inline syntax', () => {
    expect(show('1. **粗**')).toEqual(['strong:**|粗|**']);
    expect(show('# *斜*')).toEqual(['em:*|斜|*']);
    expect(show('> ==亮==')).toEqual(['highlight:==|亮|==']);
  });

  it('spans soft line breaks and stops at inline objects as the file would', () => {
    expect(show('**第一行\n第二行**')).toEqual(['strong:**|第一行\n第二行|**']);
    expect(show('前**￼**后')).toEqual([]);
    expect(show('前 **￼** 后')).toEqual(['strong:**|￼|**']);
  });

  it('gives the visible text', () => {
    expect(inlineSourceText('标题 **粗** 与 `码` \\* &lt; ==亮==')).toBe('标题 粗 与 码 * < 亮');
    expect(inlineSourceText('[文 **字**](https://a.com "标") 与 <https://b.com> 和 www.c.com')).toBe('文 字 与 https://b.com 和 www.c.com');
    expect(inlineSourceText('没有语法')).toBe('没有语法');
  });

  it('recognizes inline links, angle autolinks, and bare autolinks with URL/title ranges', () => {
    const s1 = '[x](<a b> \'v\')';
    expect(inlineSyntaxSpans(s1)).toEqual([{
      kind: 'link', from: 0, to: 14, innerFrom: 1, innerTo: 2,
      urlFrom: 5, urlTo: 8, titleFrom: 10, titleTo: 13, href: 'a b', title: 'v',
    }]);

    const s2 = '[x](u (括号标题))';
    expect(inlineSyntaxSpans(s2)).toEqual([{
      kind: 'link', from: 0, to: 13, innerFrom: 1, innerTo: 2,
      urlFrom: 4, urlTo: 5, titleFrom: 6, titleTo: 12, href: 'u', title: '括号标题',
    }]);

    const s3 = '[n\\]n](u(1))';
    expect(inlineSyntaxSpans(s3)).toEqual([
      { kind: 'link', from: 0, to: 12, innerFrom: 1, innerTo: 5, urlFrom: 7, urlTo: 11, href: 'u(1)' },
      { kind: 'escape', from: 2, to: 4, innerFrom: 3, innerTo: 4 },
    ]);

    const s4 = '[t **b** `c`](u "v")';
    expect(inlineSyntaxSpans(s4)).toEqual([
      { kind: 'link', from: 0, to: 20, innerFrom: 1, innerTo: 12, urlFrom: 14, urlTo: 15, titleFrom: 16, titleTo: 19, href: 'u', title: 'v' },
      { kind: 'strong', from: 3, to: 8, innerFrom: 5, innerTo: 6 },
      { kind: 'code', from: 9, to: 12, innerFrom: 10, innerTo: 11 },
    ]);

    expect(inlineSyntaxSpans('<me@q.com>')).toEqual([
      { kind: 'autolink', from: 0, to: 10, innerFrom: 1, innerTo: 9, href: 'mailto:me@q.com' },
    ]);
    expect(inlineSyntaxSpans('www.y.com')).toEqual([
      { kind: 'autolink', from: 0, to: 9, innerFrom: 0, innerTo: 9, href: 'http://www.y.com' },
    ]);
    expect(inlineSyntaxSpans('me@z.com')).toEqual([
      { kind: 'autolink', from: 0, to: 8, innerFrom: 0, innerTo: 8, href: 'mailto:me@z.com' },
    ]);
    expect(inlineSyntaxSpans('、www.example.com')).toEqual([
      { kind: 'autolink', from: 1, to: 16, innerFrom: 1, innerTo: 16, href: 'http://www.example.com' },
    ]);
    expect(inlineSyntaxSpans('裸网址：www.example.com ==ok==')).toEqual([
      { kind: 'autolink', from: 4, to: 19, innerFrom: 4, innerTo: 19, href: 'http://www.example.com' },
      { kind: 'highlight', from: 20, to: 26, innerFrom: 22, innerTo: 24 },
    ]);
    expect(show('、www.x.com')).toEqual([
      'autolink:|www.x.com|',
    ]);
    expect(show('见、www.x.com 与 &amp;')).toEqual([
      'autolink:|www.x.com|',
      'entity:&amp;||',
    ]);
    expect(show('*斜*、www.x.com &amp;')).toEqual([
      'em:*|斜|*',
      'autolink:|www.x.com|',
      'entity:&amp;||',
    ]);
    expect(show('a\\_b、www.x.com *斜*')).toEqual([
      'escape:\\|_|',
      'autolink:|www.x.com|',
      'em:*|斜|*',
    ]);
    expect(show('*斜、www.e.com &amp;*')).toEqual([
      'em:*|斜、www.e.com &amp;|*',
      'autolink:|www.e.com|',
      'entity:&amp;||',
    ]);
    expect(show('**粗、www.e.com &amp;**')).toEqual([
      'strong:**|粗、www.e.com &amp;|**',
      'autolink:|www.e.com|',
      'entity:&amp;||',
    ]);
    expect(show('~~删、www.e.com &amp;~~')).toEqual([
      'strike:~~|删、www.e.com &amp;|~~',
      'autolink:|www.e.com|',
      'entity:&amp;||',
    ]);
  });

  it('ignores non-links such as escaped brackets, links in code, empty-text links, and unresolved refs', () => {
    expect(inlineSyntaxSpans('\\[e](f)')).toEqual([{ kind: 'escape', from: 0, to: 2, innerFrom: 1, innerTo: 2 }]);
    expect(inlineSyntaxSpans('`[c](d)`')).toEqual([{ kind: 'code', from: 0, to: 8, innerFrom: 1, innerTo: 7 }]);
    expect(inlineSyntaxSpans('[](u)')).toEqual([]);
    expect(inlineSyntaxSpans('[](u)', { emptyLinks: true })).toEqual([
      { kind: 'link', from: 0, to: 5, innerFrom: 1, innerTo: 1, urlFrom: 3, urlTo: 4, href: 'u' },
    ]);
    expect(inlineSyntaxSpans('[]()', { emptyLinks: true })).toEqual([
      { kind: 'link', from: 0, to: 4, innerFrom: 1, innerTo: 1, urlFrom: 3, urlTo: 3, href: '' },
    ]);
    expect(inlineSyntaxSpans('[r][1]')).toEqual([]);
  });
});

describe('writing source text', () => {
  it('escapes only what would start another block', () => {
    const guard = (line: string, first = true) => guardLineStart(line, line, first);
    expect(guard('# 标题')).toBe('\\# 标题');
    expect(guard('#标签')).toBe('#标签');
    expect(guard('- 项')).toBe('\\- 项');
    expect(guard('* 项')).toBe('\\* 项');
    expect(guard('*斜体* 开头')).toBe('*斜体* 开头');
    expect(guard('**粗** 开头')).toBe('**粗** 开头');
    expect(guard('1. 项')).toBe('1\\. 项');
    expect(guard('2024.1.1')).toBe('2024.1.1');
    expect(guard('> 引用')).toBe('\\> 引用');
    expect(guard('---')).toBe('\\---');
    expect(guard('***')).toBe('\\***');
    expect(guard('```js')).toBe('\\```js');
    expect(guard('```码``` 行内')).toBe('```码``` 行内');
    expect(guard('<div>')).toBe('\\<div>');
    expect(guard('<span>')).toBe('\\<span>');
    expect(guard('</div>')).toBe('\\</div>');
    expect(guard('<my-tag attr="1">')).toBe('\\<my-tag attr="1">');
    expect(guard('<https://solo.com>')).toBe('<https://solo.com>');
    expect(guard('<me@q.com>')).toBe('<me@q.com>');
    expect(guard('<3 爱')).toBe('<3 爱');
    expect(guard('[标签]: 链接')).toBe('\\[标签]: 链接');
    expect(guard('  缩进')).toBe('&#x20; 缩进');
    expect(guard('===', false)).toBe('\\===');
    expect(guard('===')).toBe('===');
    expect(guard('--- | ---', false)).toBe('\\--- | ---');
    expect(guard('普通文字 # 不在行首')).toBe('普通文字 # 不在行首');
  });

  it('escapes unescaped pipes in a table cell', () => {
    expect(escapeCellPipes('a|b \\| c \\\\| d')).toBe('a\\|b \\| c \\\\\\| d');
  });

  it('chooses a code fence longer than any run inside', () => {
    expect(inlineMarkers('code', 'a`b')).toEqual(['``', '``']);
    expect(inlineMarkers('code', '`a')).toEqual(['`` ', ' ``']);
    expect(inlineMarkers('strong')).toEqual(['**', '**']);
  });
});

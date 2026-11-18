import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { inlineHtmlRanges, type InlineSyntaxNode } from '../src/inline-html-ranges';

const parser = unified().use(remarkParse).use(remarkGfm);
function firstRun(source: string): InlineSyntaxNode {
  let found: InlineSyntaxNode | undefined;
  function visit(node: InlineSyntaxNode): void {
    if (!found && ['paragraph', 'heading', 'tableCell'].includes(node.type)) found = node;
    else node.children?.forEach(visit);
  }
  visit(parser.parse(source) as InlineSyntaxNode);
  if (!found) throw Error('Fixture does not contain a phrasing run');
  return found;
}

describe('source positions of inline HTML', () => {
  it.each([
    ['<span style="color:red">**粗**</span>', ['span']],
    ['<SPAN><span>同名嵌套</span><kbd>Ctrl</kbd></SPAN>', ['span', 'span', 'kbd']],
    ['<span>**粗 <kbd>Ctrl</kbd>** 与 `code`</span>', ['span', 'kbd']],
    ['<span title=">">内容</span>', ['span']],
    ['<img src="x.png" alt="原样">', ['img']],
    ['<br class="x">', [undefined]],
    ['<wbr>', [undefined]],
    ['<custom-element />', [undefined]],
    ['<!-- 备注 -->', [undefined]],
  ] as const)('classifies each source range in %s', (snippet, tags) => {
    const source = '前文 ' + snippet + ' 后文';
    const ranges = inlineHtmlRanges(firstRun(source), source);
    expect(ranges?.[0]).toMatchObject({ from: 3, to: 3 + snippet.length, raw: snippet });
    expect(ranges?.map(range => range.element?.tag)).toEqual(tags);
    for (const range of ranges!) expect(source.slice(range.from, range.to)).toBe(range.raw);
  });

  it('keeps adjacent fragments separate and leaves bare breaks editable', () => {
    const source = '前 <kbd>Ctrl</kbd><br/><BR /> 后 <!-- 原样 --> <br class="x">';
    expect(inlineHtmlRanges(firstRun(source), source)?.map(range => range.raw)).toEqual([
      '<kbd>Ctrl</kbd>', '<!-- 原样 -->', '<br class="x">',
    ]);
  });

  it('allows a rendered element inside a Markdown wrapper', () => {
    const source = '前 **<span>文字</span>** 后';
    expect(inlineHtmlRanges(firstRun(source), source)).toMatchObject([{
      raw: '<span>文字</span>', element: { tag: 'span' }, innerFrom: source.indexOf('文字'), innerTo: source.indexOf('</span>'),
    }]);
  });

  it.each(['\n', '\r\n'])('takes a multiline pair from the original %j source', newline => {
    const snippet = '<span>第一行' + newline + '第二行</span>';
    const source = '前 ' + snippet + ' 后';
    expect(inlineHtmlRanges(firstRun(source), source)?.[0].raw).toBe(snippet);
  });

  it('keeps escaped pipes in a cell rather than rebuilding decoded text nodes', () => {
    const snippet = '<span data-x="a\\|b">甲\\|乙</span>';
    const source = '| ' + snippet + ' | 备注 |\n| --- | --- |\n| 正文 | 不动 |';
    expect(inlineHtmlRanges(firstRun(source), source)?.[0].raw).toBe(snippet);
  });

  it.each([
    '前 <span>未闭合',
    '前 </span>多余结束',
    '前 <span><kbd>交错</span></kbd>',
    '前 **<span>跨层**</span>',
    '前 <span>**跨层</span>**',
    '前 <div>块级</div>',
    '前 <span>内容\n\n另段 </span>',
    '| <span>跨格 | 结束</span> |\n| --- | --- |\n| 甲 | 乙 |',
  ])('requests block protection for %s', source => {
    expect(inlineHtmlRanges(firstRun(source), source)).toBeNull();
  });

  it('ignores tag-like text in code and CommonMark autolinks', () => {
    const source = '前 `<span>` <https://example.com> 后';
    expect(inlineHtmlRanges(firstRun(source), source)).toEqual([]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { imageDestinations, rebaseImageSources } from '../src/image-paths';

describe('Save As image URL source patches', () => {
  it.each(['\n', '\r\n'])('changes only image destinations, preserving BOM, metadata, alt, title and line endings (%j)', async eol => {
    const source = '\uFEFF' + ['---', 'title: ![fake](keep.png)', '---', '', '# 标题', '', '__不改写__ ![原文\\[alt\\]](./old\\(1\\).png?x=1&amp;y=2#keep "原文标题") 尾部  ', '', '![空格](<图 片.png> \'保留标题\')', '', '> ![引用][Pic]', '>', '> [pic]:', '>   <../图 片.png> "引用标题"', '', '[普通链接]: links/keep.png', '[未用定义]: keep.png', '', '![另一个][pic]', ''].join(eol);
    const resolver = vi.fn(async (sources: string[]) => sources.map((_, index) => `../原目录/${index}.png`));
    const result = await rebaseImageSources(source, resolver);
    expect(resolver.mock.calls[0][0]).toEqual(['./old(1).png?x=1&y=2#keep', '图 片.png', '../图 片.png']);
    expect(result).toBe(source.replace('./old\\(1\\).png', '../原目录/0.png').replace('<图 片.png>', '<../原目录/1.png>').replace('<../图 片.png>', '<../原目录/2.png>'));
  });
  it('deduplicates used references and leaves ordinary links, code, math, comments and absolute images untouched', async () => {
    const source = '![a](a.png) ![again](a.png)\n\n[链接](links/a.png)\n\n`![代码](code.png)`\n\n```md\n![代码](fence.png)\n```\n\n$$\n![公式原文](math.png)\n$$\n\n<!-- ![注释](comment.png) -->\n\n![远程](https://example.com/a.png) ![绝对](/a.png) ![盘符](C:/a.png) ![file](file:///C:/a.png) ![base64](data:image/png;base64,abc)\n';
    const resolver = vi.fn(async (sources:string[]) => sources.map(source=>source==='a.png'?'../old/a.png':null));
    expect(await rebaseImageSources(source, resolver)).toBe(source.replaceAll('](a.png)', '](../old/a.png)'));
    expect(resolver).toHaveBeenCalledOnce(); expect(resolver.mock.calls[0][0]).toEqual(['a.png','/a.png','C:/a.png']);
  });
  it('preserves the raw spelling of encoded fragment/query delimiters and works in nested tables', async () => {
    const source = '> - | 图片 | 原文 |\r\n>   | --- | --- |\r\n>   | ![原文](img.png&#35;anchor "不改") | <kbd>不动\\|原文</kbd> |\r\n';
    expect(await rebaseImageSources(source, async () => ['../old/img.png'])).toBe(source.replace('img.png', '../old/img.png'));
    // The same missing semicolon is literal in Markdown, unlike an HTML src.
    const literal = '![原文](img.png&#35view)';
    expect(await rebaseImageSources(literal, async () => ['../old/img.png%26'])).toBe('![原文](../old/img.png%26#35view)');
  });
  it('leaves source spelling exactly intact when native resolution says it still points to the same image', async () => {
    const source = '![a](./a%20b.png?raw=1 "title")\r\n';
    expect(await rebaseImageSources(source, async () => [null])).toBe(source);
    expect(imageDestinations('普通正文')).toEqual([]);
  });
  it('rejects failed or malformed resolution before returning a changed document', async () => {
    await expect(rebaseImageSources('![a](a.png)', async () => { throw Error('图片不存在'); })).rejects.toThrow('图片不存在');
    await expect(rebaseImageSources('![a](a.png)', async () => [])).rejects.toThrow('结果无效');
    await expect(rebaseImageSources('![a](a.png)', async () => ['含 空格.png'])).rejects.toThrow('结果无效');
  });
});

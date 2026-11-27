import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';
import { currentFile, focusApp, openFileApp } from './app-files-fixture';

describe('splitting multiline paragraphs through the real app', () => {
  let server: ViteDevServer, browser: Browser, page: Page, baseURL: string;
  beforeAll(async () => {
    server = await createTestServer(); await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw Error('No server');
    baseURL = 'http://127.0.0.1:' + address.port; browser = await launchTestBrowser();
  }, 60000);
  afterAll(async () => { await browser?.close(); await server?.close(); });
  beforeEach(async () => { page = await browser.newPage({ viewport: { width: 1200, height: 850 } }); });
  afterEach(async () => { await page?.evaluate(() => (window as any).fileApp?.surface.destroy()); await page?.close(); });

  const text = () => page.evaluate(() => (window as any).fileApp.surface.getMarkdown());
  async function openAfter(source: string, needle = '甲') {
    await openFileApp(page, baseURL, { files: { [currentFile]: source } });
    await focusApp(page, 'rich');
    await page.evaluate(needle => {
      const v = (window as any).fileApp.surface.richView();
      let pos: number | undefined;
      v.state.doc.descendants((node: any, at: number) => {
        if (pos !== undefined || node.type.name !== 'paragraph') return pos === undefined;
        node.descendants((child: any, offset: number) => {
          if (pos !== undefined || !child.isText) return;
          const hit = child.text.indexOf(needle);
          if (hit >= 0) pos = at + 1 + offset + hit + needle.length;
        });
        return false;
      });
      if (pos === undefined) throw Error('Missing text: ' + needle);
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, pos)));
      v.focus();
    }, needle);
  }

  const cases: [string, string, string, string?][] = [
    ['紧贴引用标记', '>甲\n>乙\n', '>甲\n>\n>丙\n>乙\n'],
    ['三行紧贴引用标记', '>甲\n>乙\n>丁\n', '>甲\n>\n>丙\n>乙\n>丁\n'],
    ['引用懒续行', '>甲\n乙\n', '>甲\n>\n>丙\n乙\n'],
    ['段落续行缩进', '甲\n   乙\n', '甲\n\n丙\n   乙\n'],
    ['两个空格硬换行', '甲  \n乙\n', '甲\n\n丙  \n乙\n'],
    ['引用内两个空格硬换行', '> 甲  \n> 乙\n', '> 甲\n>\n> 丙  \n> 乙\n'],
    ['双层引用行尾回车', '>> 甲\n', '>> 甲\n>>\n>> 丙\n'],
    ['单行紧贴引用行尾回车', '>甲\n', '>甲\n>\n>丙\n'],
    ['混合空格引用写法', '> 甲\n>乙\n', '> 甲\n>\n> 丙\n>乙\n'],
    ['行中间拆段', '>甲乙\n>丁\n', '>甲\n>\n>丙乙\n>丁\n', '甲'],
    ['带空格嵌套引用', '> >甲\n> >乙\n', '> >甲\n> >\n> >丙\n> >乙\n'],
    ['提示块紧贴写法', '> [!NOTE]\n>甲\n>乙\n', '> [!NOTE]\n>甲\n>\n>丙\n>乙\n'],
    ['提示块硬换行', '> [!NOTE]\n> 甲  \n> 乙\n', '> [!NOTE]\n> 甲\n>\n> 丙  \n> 乙\n'],
    ['列表项多行段落缩进', '- 项\n\n  甲\n    乙\n', '- 项\n\n  甲\n- 丙\n    乙\n'],
    ['列表项硬换行', '- 甲  \n  乙\n', '- 甲\n- 丙  \n  乙\n'],
    ['已有空引用段落隔开', '>甲\n>\n>乙\n', '>甲\n>\n>丙\n>\n>乙\n'],
    ['带空格单行引用', '> 甲\n', '> 甲\n>\n> 丙\n'],
    ['列表懒续行', '- 甲\n乙\n', '- 甲\n- 丙\n乙\n'],
    ['引用里表格后的多行段落', '> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n>\n>甲\n>乙\n', '> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n>\n>甲\n>\n>丙\n>乙\n'],
  ];

  it.each(cases)('preserves original lines on Enter (%s)', async (_name, original, expected, needle) => {
    await openAfter(original, needle ?? '甲');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('丙');
    expect(await text()).toBe(expected);
    await page.keyboard.press('Control+z');
    expect(await text()).toBe(original);
  });

  it('preserves CRLF line endings when splitting a multiline quote paragraph', async () => {
    const original = '>甲\r\n>乙\r\n';
    const expected = '>甲\r\n>\r\n>丙\r\n>乙\r\n';
    await openAfter(original, '甲');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('丙');
    const saved = await text();
    expect(saved).toBe(expected);
    expect(saved).not.toMatch(/[^\r]\n/);
    await page.keyboard.press('Control+z');
    expect(await text()).toBe(original);
  });

  it('leaves surrounding headings and tables byte-identical when saving after a split', async () => {
    const head = '# 标题 ##\n\n| 列一 | 列二 |\n| :-- | --: |\n| 1 | 2 |\n\n';
    const tail = '\n## 后记\n------\n';
    const original = head + '>甲\n>乙\n' + tail;
    const expected = head + '>甲\n>\n>丙\n>乙\n' + tail;
    await openAfter(original, '甲');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('丙');
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => (window as any).fileApp.writes.length === 1);
    expect(await page.evaluate(() => (window as any).fileApp.writes[0].text)).toBe(expected);
  });
});

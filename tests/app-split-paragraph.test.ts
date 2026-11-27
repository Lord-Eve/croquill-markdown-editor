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
  const caretPos = () => page.evaluate(() => (window as any).fileApp.surface.richView().state.selection.$from.pos);
  const waitAutoSerialize = () => page.waitForFunction(() => {
    const s = (window as any).fileApp.surface;
    return s.richTimer === undefined && !!s.richSnapshot?.eq(s.richView().state.doc);
  }, undefined, { timeout: 5000 });

  async function openAt(source: string, needle = '甲', atStart = false): Promise<number> {
    await openFileApp(page, baseURL, { files: { [currentFile]: source } });
    await focusApp(page, 'rich');
    await page.waitForFunction(() => Date.now() - (window as any).fileApp.surface.richView().input.lastFocus > 200);
    return page.evaluate(({ needle, atStart }) => {
      const v = (window as any).fileApp.surface.richView();
      let pos: number | undefined;
      v.state.doc.descendants((node: any, at: number) => {
        if (pos !== undefined || node.type.name !== 'paragraph') return pos === undefined;
        node.descendants((child: any, offset: number) => {
          if (pos !== undefined || !child.isText) return;
          const hit = child.text.indexOf(needle);
          if (hit >= 0) pos = at + 1 + offset + hit + (atStart ? 0 : needle.length);
        });
        return false;
      });
      if (pos === undefined) throw Error('Missing text: ' + needle);
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, pos)));
      v.focus();
      return pos;
    }, { needle, atStart });
  }

  async function assertThreeMoments(original: string, afterEnter: string, afterType: string, initialPos: number) {
    await page.keyboard.press('Enter');
    await waitAutoSerialize();
    expect(await text()).toBe(afterEnter);

    await page.keyboard.press('Control+z');
    await waitAutoSerialize();
    expect(await text()).toBe(original);
    expect(await caretPos()).toBe(initialPos);

    await page.keyboard.press('Enter');
    await waitAutoSerialize();
    expect(await text()).toBe(afterEnter);

    await page.keyboard.insertText('丙');
    await waitAutoSerialize();
    expect(await text()).toBe(afterType);
  }

  const cases: [string, string, string, string, string?][] = [
    ['紧贴引用标记', '>甲\n>乙\n', '>甲\n>\n>乙\n', '>甲\n>\n>丙乙\n'],
    ['三行紧贴引用标记', '>甲\n>乙\n>丁\n', '>甲\n>\n>乙\n>丁\n', '>甲\n>\n>丙乙\n>丁\n'],
    ['引用懒续行', '>甲\n乙\n', '>甲\n>\n>乙\n', '>甲\n>\n>丙乙\n'],
    ['三行引用懒续行', '>甲\n乙\n丁\n', '>甲\n>\n>乙\n丁\n', '>甲\n>\n>丙乙\n丁\n'],
    ['段落续行缩进', '甲\n   乙\n', '甲\n\n   乙\n', '甲\n\n   丙乙\n'],
    ['两个空格硬换行（拆分点上）', '甲  \n乙\n', '甲\n\n乙\n', '甲\n\n丙乙\n'],
    ['反斜杠硬换行（拆分点上）', '甲\\\n乙\n', '甲\n\n乙\n', '甲\n\n丙乙\n'],
    ['引用内两个空格硬换行（拆分点上）', '> 甲  \n> 乙\n', '> 甲\n>\n> 乙\n', '> 甲\n>\n> 丙乙\n'],
    ['非拆分点两个空格硬换行保留', '甲\n乙  \n丁\n', '甲\n\n乙  \n丁\n', '甲\n\n丙乙  \n丁\n'],
    ['引用内非拆分点两个空格硬换行保留', '> 甲\n> 乙  \n> 丁\n', '> 甲\n>\n> 乙  \n> 丁\n', '> 甲\n>\n> 丙乙  \n> 丁\n'],
    ['双层引用行尾回车', '>> 甲\n', '>> 甲\n', '>> 甲\n>>\n>> 丙\n'],
    ['单行紧贴引用行尾回车', '>甲\n', '>甲\n', '>甲\n>\n>丙\n'],
    ['混合空格引用写法', '> 甲\n>乙\n', '> 甲\n>\n>乙\n', '> 甲\n>\n>丙乙\n'],
    ['行中间拆段', '>甲乙\n>丁\n', '>甲\n>\n>乙\n>丁\n', '>甲\n>\n>丙乙\n>丁\n', '甲'],
    ['带空格嵌套引用', '> >甲\n> >乙\n', '> >甲\n> >\n> >乙\n', '> >甲\n> >\n> >丙乙\n'],
    ['提示块紧贴写法', '> [!NOTE]\n>甲\n>乙\n', '> [!NOTE]\n>甲\n>\n>乙\n', '> [!NOTE]\n>甲\n>\n>丙乙\n'],
    ['提示块硬换行', '> [!NOTE]\n> 甲\n> 乙  \n> 丁\n', '> [!NOTE]\n> 甲\n>\n> 乙  \n> 丁\n', '> [!NOTE]\n> 甲\n>\n> 丙乙  \n> 丁\n'],
    ['列表项多行段落缩进', '- 项\n\n  甲\n    乙\n    丁\n', '- 项\n\n  甲\n- 乙\n    丁\n', '- 项\n\n  甲\n- 丙乙\n    丁\n'],
    ['列表项硬换行', '- 甲  \n  乙\n', '- 甲\n- 乙\n', '- 甲\n- 丙乙\n'],
    ['已有空引用段落隔开', '>甲\n>\n>乙\n', '>甲\n>\n>乙\n', '>甲\n>\n>丙\n>\n>乙\n'],
    ['带空格单行引用', '> 甲\n', '> 甲\n', '> 甲\n>\n> 丙\n'],
    ['列表懒续行（行尾回车）', '- 甲\n乙\n', '- 甲\n- 乙\n', '- 甲\n- 丙乙\n'],
    ['列表懒续行（行中间拆段）', '- 甲乙\n丁\n', '- 甲\n- 乙\n丁\n', '- 甲\n- 丙乙\n丁\n', '甲'],
    ['引用里表格后的多行段落', '> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n>\n>甲\n>乙\n', '> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n>\n>甲\n>\n>乙\n', '> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n>\n>甲\n>\n>丙乙\n'],
  ];

  it.each(cases)('preserves original lines across all three moments (%s)', async (_name, original, afterEnter, afterType, needle) => {
    const pos = await openAt(original, needle ?? '甲', false);
    await assertThreeMoments(original, afterEnter, afterType, pos);
  });

  it.each([
    ['引用下一行开头', '>甲\n>乙\n>丁\n', '>甲\n>\n>乙\n>丁\n', '>甲\n>\n>丙乙\n>丁\n'],
    ['两个空格硬换行下一行开头', '甲  \n乙\n', '甲\n\n乙\n', '甲\n\n丙乙\n'],
  ])('eats the preceding line break when pressing Enter at line start (%s)', async (_name, original, afterEnter, afterType) => {
    const pos = await openAt(original, '乙', true);
    await assertThreeMoments(original, afterEnter, afterType, pos);
  });

  it('never emits <br /> or rewrites existing lines on double Enter at end of line', async () => {
    await openAt('>甲\n>乙\n>丁\n', '甲', false);
    await page.keyboard.press('Enter');
    await waitAutoSerialize();
    await page.keyboard.press('Enter');
    await waitAutoSerialize();
    const quoteSaved = await text();
    expect(quoteSaved).not.toContain('<br');
    expect(quoteSaved).toContain('>甲\n');
    expect(quoteSaved).toContain('>乙\n>丁\n');
    expect(quoteSaved).not.toContain('> 甲');
    expect(quoteSaved).not.toContain('> 乙');

    // Also test rapid consecutive double Enter before the idle serializer runs.
    await openAt('>甲\n>乙\n>丁\n', '甲', false);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await waitAutoSerialize();
    const rapidQuoteSaved = await text();
    expect(rapidQuoteSaved).not.toContain('<br');
    expect(rapidQuoteSaved).toContain('>甲\n');
    expect(rapidQuoteSaved).toContain('>乙\n>丁\n');
    expect(rapidQuoteSaved).not.toContain('> 甲');
    expect(rapidQuoteSaved).not.toContain('> 乙');

    await openAt('甲\n乙\n', '甲', false);
    await page.keyboard.press('Enter');
    await waitAutoSerialize();
    await page.keyboard.press('Enter');
    await waitAutoSerialize();
    const plainSaved = await text();
    expect(plainSaved).not.toContain('<br');
    expect(plainSaved).toContain('甲\n');
    expect(plainSaved).toContain('\n乙\n');
  });

  it('preserves CRLF line endings across Enter, Ctrl+z, and typing', async () => {
    const original = '>甲\r\n>乙\r\n';
    const afterEnter = '>甲\r\n>\r\n>乙\r\n';
    const afterType = '>甲\r\n>\r\n>丙乙\r\n';
    const pos = await openAt(original, '甲', false);
    await page.keyboard.press('Enter');
    await waitAutoSerialize();
    const mid = await text();
    expect(mid).toBe(afterEnter);
    expect(mid).not.toMatch(/[^\r]\n/);
    await page.keyboard.press('Control+z');
    await waitAutoSerialize();
    expect(await text()).toBe(original);
    expect(await caretPos()).toBe(pos);
    await page.keyboard.press('Enter');
    await waitAutoSerialize();
    await page.keyboard.insertText('丙');
    await waitAutoSerialize();
    const saved = await text();
    expect(saved).toBe(afterType);
    expect(saved).not.toMatch(/[^\r]\n/);
  });

  it('closes and reopens multiline inline markers when eating a break on Enter', async () => {
    const original = '**甲\n乙**\n';
    const pos = await openAt(original, '甲', false);
    await page.keyboard.press('Enter');
    await waitAutoSerialize();
    expect(await text()).toBe('**甲**\n\n**乙**\n');
    await page.keyboard.press('Control+z');
    await waitAutoSerialize();
    expect(await text()).toBe(original);
    expect(await caretPos()).toBe(pos);
  });

  it('ignores Enter during IME composition without eating breaks or splitting', async () => {
    const original = '>甲\n>乙\n';
    await openAt(original, '甲', false);
    const prevented = await page.evaluate(() => {
      document.activeElement!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      const event = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(prevented).toBe(false);
    expect(await text()).toBe(original);
  });

  it('leaves surrounding headings and tables byte-identical after Enter and after typing', async () => {
    const head = '# 标题 ##\n\n| 列一 | 列二 |\n| :-- | --: |\n| 1 | 2 |\n\n';
    const tail = '\n## 后记\n------\n';
    const original = head + '>甲\n>乙\n' + tail;
    const afterEnter = head + '>甲\n>\n>乙\n' + tail;
    const afterType = head + '>甲\n>\n>丙乙\n' + tail;
    await openAt(original, '甲', false);
    await page.keyboard.press('Enter');
    await waitAutoSerialize();
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => (window as any).fileApp.writes.length === 1);
    expect(await page.evaluate(() => (window as any).fileApp.writes[0].text)).toBe(afterEnter);

    await page.keyboard.insertText('丙');
    await waitAutoSerialize();
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => (window as any).fileApp.writes.length === 2);
    expect(await page.evaluate(() => (window as any).fileApp.writes[1].text)).toBe(afterType);
  });
});

// SPIKE runner: prints what real key presses do in the prototype. Not a regression test.
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createTestServer } from '../server';
import { launchTestBrowser } from '../browser';

describe('inline source spike', () => {
  let server: ViteDevServer, browser: Browser, page: Page;
  beforeAll(async () => {
    server = await createTestServer(); await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw Error('No server');
    browser = await launchTestBrowser(); page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    page.on('pageerror', error => console.log('SPIKE pageerror', error.message));
    await page.goto('http://127.0.0.1:' + address.port + '/tests/spike/inline.html');
    await page.waitForFunction(() => 'spike' in window, undefined, { timeout: 50000 });
  }, 60000);
  afterAll(async () => { await browser?.close(); await server?.close(); });
  const snap = () => page.evaluate(() => (window as any).spike.snapshot());
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 30)))));
  const load = (lines: string[], block = 0, offset = 0) => page.evaluate(({ lines, block, offset }) => { const s = (window as any).spike; s.load(lines); s.caret(block, offset); }, { lines, block, offset });
  const show = (label: string, s: any) => console.log(`SPIKE ${label.padEnd(26)} ${s.caret}   [显示:${s.visible || '无'}] [隐藏${s.hidden}] x=${s.x}`);
  async function presses(label: string, key: string, count: number) {
    let previous = await snap(); show(label + ' 起点', previous); let stuck = 0;
    for (let i = 1; i <= count; i++) {
      await page.keyboard.press(key); await settle(); const now = await snap();
      const moved = now.caret !== previous.caret; if (!moved) stuck++;
      show(`${label} ${key}#${i}${moved ? '' : ' (没动)'}`, now); previous = now;
    }
    console.log(`SPIKE ${label}: ${count} 次按键，${stuck} 次光标没动`);
  }
  const sample = '前文 **加粗文字** 中间 *斜体文字* 以及 `行内代码` 和 ~~删除线~~ 结尾';

  it('initial render and click', async () => {
    await load([sample, '普通段落'], 1, 0); await settle();
    const first = await snap(); console.log('SPIKE 初始样式', first.styled, '| 可见标记:', first.visible || '无', '| 隐藏标记数:', first.hidden);
    const point = await page.evaluate(() => { const v = (window as any).spike.view, r = v.coordsAtPos(1 + 7); return { x: r.left, y: (r.top + r.bottom) / 2 }; });
    await page.mouse.click(point.x, point.y); await settle(); show('点击加粗文字中间', await snap());
    const end = await page.evaluate(() => { const v = (window as any).spike.view, r = v.coordsAtPos(1 + 2); return { x: r.left, y: (r.top + r.bottom) / 2 }; });
    await page.mouse.click(end.x, end.y); await settle(); show('点击“前文”内', await snap());
  }, 60000);

  it('arrow keys through markers', async () => {
    await load([sample], 0, 7); await settle(); await presses('加粗内向右', 'ArrowRight', 7);
    await load([sample], 0, 0); await settle(); await presses('段首向右', 'ArrowRight', 9);
    await load([sample], 0, 14); await settle(); await presses('加粗后向左', 'ArrowLeft', 9);
    await load([sample], 0, sample.length); await settle(); await presses('段尾向左', 'ArrowLeft', 8);
  }, 60000);

  it('editing a marker, typing, undo', async () => {
    await load([sample], 0, 10); await settle(); show('光标在两个星号之间', await snap());
    await page.keyboard.press('Backspace'); await settle(); const after = await snap(); show('退格删一个星号', after);
    console.log('SPIKE 删星号后样式:', after.styled, '| 源码:', JSON.stringify(await page.evaluate(() => (window as any).spike.markdown())));
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('End'); await settle();
    await page.keyboard.press('Control+z'); await settle(); const undone = await snap(); show('离开后 Ctrl+Z', undone);
    console.log('SPIKE 撤销后样式:', undone.styled, '| 源码:', JSON.stringify(await page.evaluate(() => (window as any).spike.markdown())));
    await load([sample], 0, 7); await settle(); await page.keyboard.insertText('新'); await settle(); show('加粗内输入“新”', await snap());
    await page.keyboard.press('Home'); await settle(); await page.keyboard.press('Control+z'); await settle(); show('离开后撤销输入', await snap());
    await load(['普通文字'], 0, 2); await settle();
    for (const ch of ['*', '*', '粗', '*', '*']) { await page.keyboard.insertText(ch); await settle(); }
    const typed = await snap(); show('逐字输入 **粗**', typed); console.log('SPIKE 输入后样式:', typed.styled);
  }, 60000);

  it('selection, nesting, fidelity', async () => {
    await load([sample], 0, 2); await settle();
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight'); await settle();
    const selected = await snap(); show('Shift+右 5 次', selected);
    console.log('SPIKE 选中文字:', JSON.stringify(await page.evaluate(() => window.getSelection()!.toString())));
    await load(['外 ***粗斜*** 和 **粗*内斜*粗** 尾'], 0, 6); await settle(); const nested = await snap(); show('嵌套：光标在粗斜内', nested); console.log('SPIKE 嵌套样式:', nested.styled);
    await page.evaluate(() => (window as any).spike.caret(0, 17)); await settle(); show('嵌套：光标在内斜内', await snap());
    await page.evaluate(() => (window as any).spike.caret(0, 14)); await settle(); show('嵌套：光标在外层粗内', await snap());
    const odd = ['__下划线加粗__ 和 _下划线斜体_', '转义 \\*不是斜体\\* 和 a*b 以及 2*3*4', '``含`反引号`` 代码', '未闭合 **加粗 和 孤立 * 星号'];
    await load(odd, 0, 0); await settle();
    console.log('SPIKE 保真:', (await page.evaluate(() => (window as any).spike.markdown())) === odd.join('\n\n') + '\n' ? '源码逐字符一致' : '源码变了');
    console.log('SPIKE 特殊写法样式:', (await snap()).styled);
    await page.evaluate(() => (window as any).spike.caret(1, 0)); await page.keyboard.insertText('改'); await settle();
    console.log('SPIKE 编辑第二段后:', JSON.stringify(await page.evaluate(() => (window as any).spike.markdown())));
  }, 60000);

  it('composition near markers', async () => {
    await load([sample], 0, 7); await settle();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 }); await settle(); show('组词中 zhong', await snap());
    await cdp.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 }); await settle(); show('组词中 zhongwen', await snap());
    await cdp.send('Input.insertText', { text: '中文' }); await settle(); const done = await snap(); show('上屏“中文”', done);
    console.log('SPIKE 组词后源码:', JSON.stringify(await page.evaluate(() => (window as any).spike.markdown())), '| 样式:', done.styled);
    await load([sample], 0, 5); await settle(); show('光标在 ** 之前', await snap());
    await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 }); await settle(); show('标记前组词 ni', await snap());
    await cdp.send('Input.insertText', { text: '你' }); await settle(); show('标记前上屏“你”', await snap());
    console.log('SPIKE 源码:', JSON.stringify(await page.evaluate(() => (window as any).spike.markdown())));
  }, 60000);
});

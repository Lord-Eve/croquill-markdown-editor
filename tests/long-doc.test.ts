import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';
import { fidelitySamples, metadataSamples } from './fixtures/fidelity-samples';

const examples = new URL('../examples/', import.meta.url);
const samples = [
  ...readdirSync(examples).filter(n => n.endsWith('.md')).map(name => ({ name, source: readFileSync(new URL(name, examples), 'utf8') })),
  ...fidelitySamples.map(({name,syntax}) => ({ name, source: ['首段','第二段',syntax,'倒数第二段','最后一段'].join('\r\n\r\n') })),
  ...metadataSamples.map((header,i) => ({ name:'元数据' + i, source: header + '首段\n\n第二段\n\n第三段\n\n末段' })),
];
describe('long document publishing', () => {
  let server: ViteDevServer, browser: Browser, page: Page;
  beforeAll(async () => {
    server = await createTestServer(); await server.listen();
    browser = await launchTestBrowser();
    page = await browser.newPage();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw Error('Missing test port');
    await page.goto('http://127.0.0.1:' + address.port + '/tests/harness.html');
    await page.addScriptTag({type:'module',content:"import * as checks from '/tests/fixtures/long-doc-editor.ts'; window.checks=checks;"});
    await page.waitForFunction(() => !!(window as any).checks);
  },60000);
  afterAll(async () => { await browser?.close(); await server?.close(); });

  it.each(samples)('$name matches the complete writer across edit operations', async ({name,source}) => {
    const result = await page.evaluate(([n,s]) => (window as any).checks.corpus(n,s), [name,source]);
    if (result.differences.length) console.info(name, result.differences.join(', '));
    expect(result.protected || result.cases > 0).toBe(true);
  },30000);

  it('keeps both shared parser dialects unchanged and retains the open document', async () => {
    await page.evaluate(() => (window as any).checks.sharedTrees());
  });

  it('keeps every mapped block aligned over 50 seeded edits', async () => {
    await page.evaluate(() => (window as any).checks.repeated());
  });

  const before = '开头\n\n第二段\n\n', after = '\n\n第三段\n\n第四段\n\n倒数第二段\n\n末段';
  it.each([
    ['front matter','---\ntitle: test\n---\n\n',after,'字'],
    ['raw block',before + '<details>内容</details>\n\n',after,'字'],
    ['TOC',before + '[TOC]\n\n',after,'字'],
    ['footnote',before, '\n\n[^a]: 正文' + after,'字'],
    ['reference',before,after + '\n\n[a]: /url','[a]'],
    ['list continuation',before + '- 项目\n\n',after,'- '],
    ['table continuation',before + '| 表 |\n| --- |\n| 格 |\n\n',after,'|'],
    ['exact source',before,after,'字'],
    ['missing index',before,after,'字'],
    ['changed context',before,after,'字'],
  ])('falls back for %s', async (reason,prefix,suffix,insert) => {
    await page.evaluate(args => (window as any).checks.fallback(...args),[prefix,suffix,insert,reason]);
  });
});

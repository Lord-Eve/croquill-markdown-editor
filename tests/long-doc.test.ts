import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
    // Count the tokenizer entry point, including callers outside our AST cache.
    await page.route('**/node_modules/.vite-tests/deps/*.js*', async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace(/function fromMarkdown\(value, encoding, options\) \{/g,
        '$&\nif (value === window.countedSource) window.fullParses++;');
      await route.fulfill({ response, body });
    });
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw Error('Missing test port');
    await page.goto('http://127.0.0.1:' + address.port + '/tests/harness.html');
    await page.addScriptTag({type:'module',content:"import * as checks from '/tests/fixtures/long-doc-editor.ts'; window.checks=checks;"});
    await page.waitForFunction(() => !!(window as any).checks);
  },60000);
  afterAll(async () => { await browser?.close(); await server?.close(); });

  it('tokenizes the original body once when opening the rich editor', async () => {
    const source = '# 唯一解析\n\n' + '正文与 **标记**。\n\n'.repeat(150) + '$x+1$\n\n- 项目\n-\n';
    const result = await page.evaluate(async text => {
      (window as any).countedSource = text;
      (window as any).fullParses = 0;
      return (window as any).checks.checkOpening(text);
    }, source);
    expect(result).toEqual({ same: true, parses: 1 });
  });

  it('matches the complete opening gate and block index for every local example', async () => {
    for (const dir of [examples, new URL('private/', examples)]) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir).filter(n => n.endsWith('.md'))) {
        const source = readFileSync(new URL(encodeURIComponent(name), dir), 'utf8');
        expect(await page.evaluate(async text => (await (window as any).checks.checkOpening(text)).same, source)).toBe(true);
      }
    }
  }, 60000);

  it.each(samples)('$name matches the complete writer across edit operations', async ({name,source}) => {
    const result = await page.evaluate(([n,s]) => (window as any).checks.corpus(n,s), [name,source]);
    if (result.differences.length) console.info(name, result.differences.join(', '));
    expect(result.protected || result.cases > 0).toBe(true);
  },30000);

  it('keeps both shared parser dialects unchanged and retains the open document', async () => {
    await page.evaluate(() => (window as any).checks.sharedTrees());
  });

  const sample = readFileSync(new URL('save-untouched.md', examples), 'utf8');
  const edits = [
    ...['河岸手记', '夜航', '潮汐记录', '船舷', '绳结', '灯芯', '春', '老桥', '星轮', '木桨', '放缆',
      'echo tide', '蓝色浮标', '南岸灯塔', 'a+b', '船长', '礁石', '收起风帆'].map(target => ['insert', target, target, target + '字']),
    ['split', '甲板上', '甲板上', '甲板上\n\n'],
    ['break', '甲板上', '甲板上', '甲板上\n'],
    ['join', '船舷投下了倒影。', '钟声。\n\n\n\n  船舷', '钟声。  船舷'],
    ['delete', '物资清单', '物资清单\n\n', ''],
    ['paste', '灯芯', '灯芯', '灯芯粘贴内容'],
    ['row', '石滩', '| 石滩 | 三公里 |', '| 石滩 | 三公里 |\n| 新 | 新 |'],
    ['item', '木桨', '+ 木桨', '+ 木桨\n+ 新桨'],
    ['composition', '海图', '海图', '海图字'],
  ];
  for (const [action, target, old, replacement] of edits) {
    it.each(['public', 'short'])('%s preserves exact bytes on ' + action + ' at ' + target, async size => {
      const block = sample.split(/\n{2,}/).find(s => s.includes(target))!;
      const short = action === 'join' ? '甲板上听见钟声。\n\n\n\n  船舷投下了倒影。' :
        action === 'delete' ? block + '\n\n尾页' : '卷首\n====\n\n' + block + '\n\n尾页';
      const source = size === 'public' ? sample : short;
      const result = await page.evaluate(args => (window as any).checks.editSource(...args), [source, target, action]);
      expect(source).toContain(old);
      expect(result.saved).toBe(source.replace(old, replacement));
    });
  }
  it.each(['CRLF', 'BOM', 'BOM + CRLF'])('preserves transport bytes and undo for %s', async format => {
    let source = format.includes('CRLF') ? sample.replace(/\n/g, '\r\n') : sample;
    if (format.includes('BOM')) source = '\uFEFF' + source;
    for (const target of ['河岸手记', '老桥', 'echo tide', '收起风帆']) {
      const result = await page.evaluate(args => (window as any).checks.editSource(...args), [source, target, 'insert']);
      expect(result.saved).toBe(source.replace(target, target + '字'));
      expect(result.undone).toBe(source);
    }
  });
  it.each([
    ['  首段\n\n  次段\n\n\n', '次段', 'insert', '  首段\n\n  次段字\n\n\n'],
    ['  首段\n\n  次段\n\n\n', '首段', 'delete', '  次段\n\n\n'],
    ['### 页首 ###\n\n尾页\n\n\n', '尾页', 'delete', '### 页首 ###\n\n\n'],
    ['卷首\n====\n\n003)   上船\n004)   下船', '下船', 'insert', '卷首\n====\n\n003)   上船\n004)   下船字'],
    ['卷首\n====\n\n003)   上船\n004)   下船', '下船', 'item', '卷首\n====\n\n003)   上船\n004)   下船\n004)   新桨'],
    ['|春|秋|\n|:---|---:|\n|甲|乙|', '乙', 'row', '|春|秋|\n|:---|---:|\n|甲|乙|\n|新|新|'],
    ['>  岸边\n>    空船\n>  灯火', '空船', 'insert', '>  岸边\n>    空船字\n>  灯火'],
    ['~~~~text\r\n岸边\n空船\r灯火\r\n~~~~', '空船', 'insert', '~~~~text\r\n岸边\n空船字\r灯火\r\n~~~~'],
  ])('preserves boundary spelling in %s', async (source, target, action, expected) => {
    const result = await page.evaluate(args => (window as any).checks.editSource(...args), [source, target, action]);
    expect(result.saved).toBe(expected);
  });
  it.each(samples.filter(s => s.name.endsWith('.md')))('$name keeps every other byte on typing', async ({source}) => {
    const result = await page.evaluate(s => (window as any).checks.editSource(s, '', 'insert'), source);
    expect(result.saved).toBe(source.replace(result.target, result.target + '字'));
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
    ['mismatched source range',before,after,'保留输入'],
  ])('falls back for %s', async (reason,prefix,suffix,insert) => {
    await page.evaluate(args => (window as any).checks.fallback(...args),[prefix,suffix,insert,reason]);
  });
});

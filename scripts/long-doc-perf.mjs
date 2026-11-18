import { readFile, readdir } from 'node:fs/promises';
import { createTestServer } from '../tests/server.ts';
import { launchTestBrowser } from '../tests/browser.ts';

const examples = new URL('../examples/', import.meta.url);
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round((sorted[mid] + sorted[(sorted.length - 1) >> 1]) * 5) / 10;
};

async function measure(page, url, sample) {
  await page.route('**/*', async route => {
    const request = new URL(route.request().url());
    if (request.origin !== url) return route.abort();
    if (request.pathname !== '/src/main.ts') return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() + '\nwindow.bench = { surface, session, updateStats };' });
  });
  await page.goto(url);
  await page.waitForFunction(() => window.bench);
  const open = await page.evaluate(async sample => {
    const b = window.bench;
    b.frames = () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    const start = performance.now();
    await b.surface.load(sample);
    await b.frames();
    const elapsed = performance.now() - start;
    if (b.surface.mode !== 'rich') throw Error('Rich mode unavailable');
    b.session.edit(sample); b.updateStats();
    const view = b.surface.richView();
    let pos;
    view.state.doc.forEach((node, offset) => {
      if (pos == null && offset >= view.state.doc.content.size / 2 && node.type.name === 'paragraph' && node.firstChild?.isText) pos = offset + 2;
    });
    if (pos == null) throw Error('No editable paragraph');
    view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(pos))).scrollIntoView());
    view.focus(); await b.frames();
    b.keys = [];
    view.dom.addEventListener('keydown', () => {
      const start = performance.now();
      requestAnimationFrame(() => b.keys.push(performance.now() - start));
    }, true);
    const flush = b.surface.getMarkdown.bind(b.surface);
    b.surface.getMarkdown = () => {
      const start = performance.now();
      const text = flush();
      b.idle = performance.now() - start;
      return text;
    };
    return elapsed;
  }, sample);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('x');
    await page.waitForFunction(n => window.bench.keys.length >= n, i + 1);
  }
  await page.waitForFunction(() => window.bench.idle !== undefined);
  return page.evaluate(async open => {
    const b = window.bench, idle = b.idle, view = b.surface.richView();
    view.dispatch(view.state.tr.insertText('x'));
    const start = performance.now(); b.surface.getMarkdown(); const save = performance.now() - start;
    async function switchTo(mode) {
      const start = performance.now(); await b.surface.setMode(mode); await b.frames(); return performance.now() - start;
    }
    return { open, keys: b.keys, idle, save, source: await switchTo('source'), rich: await switchTo('rich') };
  }, open);
}

async function main() {
  const parts = await Promise.all(['inline-source.md', 'br-in-table.md', 'wikilinks-attributes.md'].map(name => readFile(new URL(name, examples), 'utf8')));
  const corpus = parts.join('\n\n');
  const samples = [Array(Math.max(1, Math.round(102400 / Buffer.byteLength(corpus)))).fill(corpus).join('\n\n')];
  const privateDir = new URL('private/', examples);
  const names = await readdir(privateDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const name = names.filter(n => /\.md$/i.test(n)).sort()[0];
  if (name) samples.push(await readFile(new URL(encodeURIComponent(name), privateDir), 'utf8'));
  const server = await createTestServer();
  let browser;
  try {
    await server.listen(); browser = await launchTestBrowser();
    const url = 'http://127.0.0.1:' + server.httpServer.address().port;
    console.log('| bytes | lines | open ms | key ms | idle ms | save ms | source ms | rich ms |');
    console.log('|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const base of samples) for (const multiplier of [1, 4]) {
      const sample = Array(multiplier).fill(base).join('\n\n'), runs = [];
      for (let i = 0; i < 3; i++) {
        const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
        try { runs.push(await measure(page, url, sample)); } finally { await page.close(); }
      }
      console.log('|', [Buffer.byteLength(sample), sample.split('\n').length,
        ...['open', 'keys', 'idle', 'save', 'source', 'rich'].map(key => median(runs.flatMap(run => run[key])))].join(' | '), '|');
    }
  } finally { await browser?.close(); await server.close(); }
}

// Playwright errors can contain serialized arguments. Never echo them for local samples.
main().catch(() => { console.error('测速未完成。'); process.exitCode = 1; });

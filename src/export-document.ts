import { languages } from '@codemirror/language-data';
import { LanguageDescription } from '@codemirror/language';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import { renderMarkdownDom } from './render-markdown';
import theme from './markdown-theme.css?raw';
import alerts from './alerts.css?raw';
import styles from './export.css?raw';

export type ExportFormat = 'html' | 'pdf';
export function exportName(path: string, format: ExportFormat) {
  return path.replace(/\.[^./\\]+$/, '') + '.' + format;
}

export async function exportDocument(markdown: string, name: string, activeTheme: string, format: ExportFormat,
    readImage: (src: string) => Promise<string>): Promise<string> {
  const doc = document.implementation.createHTMLDocument(name);
  const element = (tag: string, text?: string) => {
    const el = doc.createElement(tag);
    if (text !== undefined) el.textContent = text;
    return el;
  };
  doc.documentElement.lang = 'zh-CN';
  doc.documentElement.dataset.theme = format === 'pdf' ? 'light' : activeTheme === 'dark' ? 'dark' : 'light';
  const charset = element('meta'); charset.setAttribute('charset', 'utf-8');
  const policy = element('meta'); policy.setAttribute('http-equiv', 'Content-Security-Policy');
  policy.setAttribute('content', "default-src 'none'; img-src 'self' file: data: https: http:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  doc.head.prepend(charset, policy);
  doc.head.append(element('style', theme.replaceAll('.milkdown .milkdown-code-block', '#write pre') +
    alerts.replaceAll('.milkdown .ProseMirror', '#write') + styles));
  const main = element('article'); main.id = 'write'; doc.body.append(main);
  const pending: Promise<void>[] = [];
  renderMarkdownDom(doc, main, markdown, {
    highlightCode: (lang, value, code) => {
      const language = LanguageDescription.matchLanguageName(languages, lang);
      if (language) pending.push(language.load().then(support => {
        const fragment = doc.createDocumentFragment(); let last = 0;
        highlightTree(support.language.parser.parse(value), classHighlighter, (from, to, classes) => {
          const token = element('span', value.slice(from, to)); token.className = classes;
          fragment.append(value.slice(last, from), token); last = to;
        });
        fragment.append(value.slice(last)); code.replaceChildren(fragment);
      }));
    },
  });
  if (format === 'pdf') {
    const cache = new Map<string, Promise<string>>();
    for (const img of main.querySelectorAll('img[src]')) {
      const src = img.getAttribute('src')!;
      if (/^(https?:|data:|\/\/)/i.test(src)) continue;
      if (!cache.has(src)) cache.set(src, readImage(src));
      pending.push(cache.get(src)!.then(data => { img.setAttribute('src', data); }));
    }
  }
  await Promise.all(pending);
  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}

interface FileWebview extends EventTarget { postMessageWithAdditionalObjects(message: unknown, files: File[]): void }

/** Resolve the real File supplied by HTML drop, retaining WebView2 HTML DnD. */
export async function droppedDocumentPath(file: File): Promise<string> {
  const webview = (window as unknown as { chrome?: { webview?: FileWebview } }).chrome?.webview;
  if (!webview?.postMessageWithAdditionalObjects) throw Error('当前运行环境不能取得拖入文件的路径，请使用“文件 → 打开”。');
  const id = crypto.getRandomValues(new Uint32Array(1))[0];
  return new Promise((resolve, reject) => {
    const finish = (error: unknown, path?: string) => { clearTimeout(timer); webview.removeEventListener('message', reply); if (error) reject(error); else resolve(path!); };
    const reply = (event: Event) => {
      const data: unknown = (event as MessageEvent).data;
      if (typeof data !== 'string' || !data.startsWith(`croquill-file-drop:${id}:`)) return;
      const result = data.slice(`croquill-file-drop:${id}:`.length), separator = result.indexOf('\n');
      if (separator < 0) { finish(Error('拖入文件的路径响应无效。')); return; }
      const status = result.slice(0, separator), value = result.slice(separator + 1);
      if (status !== 'ok') { finish(Error(value || '无法取得拖入文件的路径。')); return; }
      if (!/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value) || !/\.(?:md|markdown|mdown|mkd)$/i.test(value)) { finish(Error('拖入的文件不是有效 Markdown 路径。')); return; }
      finish(null, value);
    };
    const timer = window.setTimeout(() => finish(Error('取得拖入文件路径超时，原文档已保留。请使用“文件 → 打开”。')), 5000);
    webview.addEventListener('message', reply);
    try { webview.postMessageWithAdditionalObjects(`croquill-file-drop:${id}`, [file]); } catch (error) { finish(error); }
  });
}

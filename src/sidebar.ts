export interface FolderEntry { name: string; path: string; isDirectory: boolean }
export interface FolderListing { root: string; path: string; entries: FolderEntry[] }
interface FileSidebarOptions {
  root: HTMLElement;
  pickFolder: () => Promise<string | null>;
  listFolder: (root: string, path?: string) => Promise<FolderListing>;
  openFile: (path: string) => Promise<void>;
  onError: (message: string) => void;
}
interface FolderNode extends FolderEntry {
  expanded?: boolean;
  loading?: boolean;
  children?: FolderNode[];
  error?: string;
}
const normalizedPath = (path: string) => path.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
const basename = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;

/** Read-only, lazily expanded folder navigation; document switching belongs to the session. */
export class FileSidebar {
  private folder: string | null = null;
  private entries: FolderNode[] = [];
  private activeFile: string | null = null;
  private generation = 0;
  private picking = false;
  private loading = false;
  private error = '';
  private readonly tree = document.createElement('div');
  private readonly folderLabel = document.createElement('div');
  private readonly refreshButton = document.createElement('button');

  constructor(private readonly options: FileSidebarOptions) {
    const toolbar = document.createElement('div'); toolbar.className = 'file-toolbar';
    const openButton = document.createElement('button');
    openButton.type = 'button'; openButton.textContent = '打开文件夹'; openButton.title = '选择本地 Markdown 文件夹';
    openButton.onclick = () => { void this.chooseFolder(); };
    this.refreshButton.type = 'button'; this.refreshButton.textContent = '↻';
    this.refreshButton.title = '刷新文件夹'; this.refreshButton.setAttribute('aria-label', '刷新文件夹');
    this.refreshButton.onclick = () => { void this.refresh(); };
    toolbar.append(openButton, this.refreshButton);
    this.folderLabel.className = 'file-root-name';
    this.tree.className = 'file-tree'; this.tree.setAttribute('aria-label', 'Markdown 文件');
    options.root.replaceChildren(toolbar, this.folderLabel, this.tree);
    this.render();
    try {
      const saved = localStorage.getItem('croquill-folder');
      if (saved) void this.loadRoot(saved);
    } catch { /* Browsing still works when preferences are unavailable. */ }
  }

  async chooseFolder(): Promise<void> {
    if (this.picking) return;
    this.picking = true;
    try {
      const selected = await this.options.pickFolder();
      if (selected) await this.loadRoot(selected);
    } catch (error) { this.report(error); }
    finally { this.picking = false; this.render(); }
  }

  async refresh(): Promise<void> {
    if (this.folder) await this.loadRoot(this.folder);
  }

  setActiveFile(path: string | null): void {
    if (path === this.activeFile) return;
    this.activeFile = path;
    // Title updates also happen while typing. Only selection attributes need changing.
    this.tree.querySelectorAll<HTMLButtonElement>('[data-file-path]').forEach(button => {
      const active = !!path && normalizedPath(button.dataset.filePath!) === normalizedPath(path);
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
  }

  private async loadRoot(path: string): Promise<void> {
    const generation = ++this.generation;
    this.loading = true; this.error = ''; this.render();
    try {
      const listing = await this.options.listFolder(path);
      if (generation !== this.generation) return;
      this.folder = listing.root;
      this.entries = listing.entries.map(entry => ({ ...entry }));
      try { localStorage.setItem('croquill-folder', listing.root); } catch { /* Optional preference. */ }
    } catch (error) {
      if (generation !== this.generation) return;
      this.report(error);
      const resetLoading = (nodes: FolderNode[]) => nodes.forEach(node => {
        node.loading = false;
        if (node.children) resetLoading(node.children);
      });
      resetLoading(this.entries);
    } finally {
      if (generation === this.generation) { this.loading = false; this.render(); }
    }
  }

  private async toggle(node: FolderNode): Promise<void> {
    node.expanded = !node.expanded;
    if (!node.expanded || node.children || node.loading) { this.render(); return; }
    const generation = this.generation;
    node.loading = true; node.error = undefined; this.render();
    try {
      const listing = await this.options.listFolder(this.folder!, node.path);
      if (generation !== this.generation) return;
      node.children = listing.entries.map(entry => ({ ...entry }));
    } catch (error) {
      if (generation !== this.generation) return;
      node.error = '无法读取，折叠后再展开可重试';
      this.options.onError(String(error));
    } finally {
      if (generation === this.generation) { node.loading = false; this.render(); }
    }
  }

  private report(error: unknown): void {
    this.error = `无法读取文件夹：${String(error)}`;
    this.options.onError(this.error);
  }

  private render(): void {
    this.refreshButton.disabled = !this.folder || this.loading;
    this.folderLabel.textContent = this.folder ? basename(this.folder) : '';
    this.folderLabel.title = this.folder || '';
    this.folderLabel.hidden = !this.folder;
    this.tree.setAttribute('aria-busy', String(this.loading));
    const fragment = document.createDocumentFragment();
    const note = (text: string, className = 'file-empty', depth = 0) => {
      const p = document.createElement('p'); p.className = className; p.textContent = text;
      p.style.setProperty('--depth', String(depth)); fragment.append(p);
    };
    if (this.error) note(this.error, 'file-error');
    if (!this.folder) {
      note(this.loading ? '正在读取文件夹…' : '选择文件夹，在这里切换文档。');
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'file-empty-button'; button.textContent = '打开文件夹…';
      button.onclick = () => { void this.chooseFolder(); }; fragment.append(button);
    } else if (!this.entries.length) note(this.loading ? '正在读取文件夹…' : '此文件夹没有 Markdown 文档。');
    const appendNodes = (nodes: FolderNode[], depth: number) => {
      for (const node of nodes) {
        const row = document.createElement('button'); row.type = 'button'; row.className = 'file-row';
        row.disabled = this.loading;
        row.title = node.path; row.style.setProperty('--depth', String(depth));
        const chevron = document.createElement('span'); chevron.className = 'file-chevron';
        chevron.setAttribute('aria-hidden', 'true');
        chevron.textContent = node.isDirectory ? (node.expanded ? '⌄' : '›') : '';
        const label = document.createElement('span'); label.className = 'file-name'; label.textContent = node.name;
        row.append(chevron, label);
        if (node.isDirectory) {
          row.setAttribute('aria-expanded', String(!!node.expanded));
          row.onclick = () => { void this.toggle(node); };
        } else {
          row.dataset.filePath = node.path;
          const active = !!this.activeFile && normalizedPath(node.path) === normalizedPath(this.activeFile);
          row.classList.toggle('active', active);
          if (active) row.setAttribute('aria-current', 'page');
          row.onclick = () => { void this.options.openFile(node.path).catch(error => this.options.onError(String(error))); };
        }
        fragment.append(row);
        if (node.isDirectory && node.expanded) {
          if (node.loading) note('正在读取…', 'file-empty', depth + 1);
          else if (node.error) note(node.error, 'file-error', depth + 1);
          else if (node.children?.length) appendNodes(node.children, depth + 1);
          else note('没有 Markdown 文档', 'file-empty', depth + 1);
        }
      }
    };
    appendNodes(this.entries, 0);
    const focusedPath = (document.activeElement as HTMLElement | null)?.closest<HTMLButtonElement>('.file-row')?.title;
    this.tree.replaceChildren(fragment);
    if (focusedPath) Array.from(this.tree.querySelectorAll<HTMLButtonElement>('.file-row')).find(row => row.title === focusedPath)?.focus();
  }
}

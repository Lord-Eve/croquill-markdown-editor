import { sameDocumentPath } from './document-path';

export const recentDocumentsKey = 'croquill-recent-documents';
interface StoragePort { getItem(key: string): string | null; setItem(key: string, value: string): void }
export class RecentDocuments {
  private files: string[] = [];
  private last: string | null = null;
  constructor(private readonly storage: StoragePort) {
    try {
      const saved: unknown = JSON.parse(storage.getItem(recentDocumentsKey) || 'null');
      if (!saved || typeof saved !== 'object') return;
      const { files, last } = saved as { files?: unknown; last?: unknown };
      if (Array.isArray(files)) for (const path of files) if (this.valid(path) && !this.files.some(existing => sameDocumentPath(existing, path))) { this.files.push(path); if (this.files.length === 10) break; }
      if (this.valid(last) && this.files.some(path => sameDocumentPath(path, last))) this.last = last;
    } catch { /* A damaged or unavailable preference must not prevent editing. */ }
  }
  private valid(path: unknown): path is string { return typeof path === 'string' && /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(path) && path.length <= 32768 && !/[\u0000\r\n]/.test(path); }
  get paths(): readonly string[] { return [...this.files]; }
  get lastPath(): string | null { return this.last; }
  opened(path: string): void {
    if (!this.valid(path)) return;
    this.files = [path, ...this.files.filter(existing => !sameDocumentPath(existing, path))].slice(0, 10); this.last = path; this.persist();
  }
  forget(path: string): void {
    this.files = this.files.filter(existing => !sameDocumentPath(existing, path));
    if (sameDocumentPath(this.last, path)) this.last = null;
    this.persist();
  }
  fresh(): void { this.last = null; this.persist(); }
  private persist(): void { try { this.storage.setItem(recentDocumentsKey, JSON.stringify({ files: this.files, last: this.last })); } catch { /* Read-only settings must not block opening/saving a file. */ } }
}

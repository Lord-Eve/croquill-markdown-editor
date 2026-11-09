import { sameDocumentPath } from './document-path';

export type Newline = 'lf' | 'crlf' | 'cr' | 'mixed';
export interface DocumentFile { path: string; text: string; bom: boolean; newline: Newline; revision: string }
export interface FilePort {
  openPath(): Promise<string | null>;
  savePath(current: string | null): Promise<string | null>;
  read(path: string): Promise<DocumentFile>;
  write(path: string, text: string, bom: boolean, newline: Newline, expectedRevision?: string): Promise<{revision: string}>;
  confirmSave(name: string): Promise<'save' | 'discard' | 'cancel'>;
  prepareSaveAs?(from: string, to: string, text: string): Promise<string>;
}
interface SessionEvents { opened?(file: DocumentFile): void; saved?(path: string): void; fresh?(): void }
export class DocumentSession {
  path: string | null = null;
  text = '';
  savedText = '';
  bom = false;
  newline: Newline = 'lf';
  revision: string | undefined;
  private pending = false;
  private unavailable = false;
  constructor(readonly port: FilePort, private readonly events: SessionEvents = {}) {}
  get dirty() { return this.pending || this.unavailable || this.text !== this.savedText; }
  get name() { return this.path?.split(/[\\/]/).pop() || '未命名'; }
  markPending() { this.pending = true; }
  markUnavailable() { this.unavailable = true; }
  edit(text: string) { this.text = text; this.pending = false; }
  async save(as = false): Promise<boolean> {
    const path = as || !this.path ? await this.port.savePath(this.path) : this.path;
    if (!path) return false;
    const snapshot = this.text;
    const moved = this.path !== null && !sameDocumentPath(path, this.path);
    const prepared = moved && this.port.prepareSaveAs ? await this.port.prepareSaveAs(this.path!, path, snapshot) : snapshot;
    if (prepared !== snapshot && this.text !== snapshot) throw Error('另存为准备期间内容又有修改，尚未写入。当前文档已保留，请再次保存。');
    const result = await this.port.write(path, prepared, this.bom, this.newline, sameDocumentPath(path, this.path) ? this.revision : undefined);
    if (prepared !== snapshot && this.text !== snapshot) throw Error('副本已经写入，但保存期间又有修改。当前编辑内容仍留在原文档，请再次另存为。');
    if (prepared !== snapshot) this.text = prepared;
    this.path = path;
    this.revision = result.revision;
    this.savedText = prepared;
    this.unavailable = false;
    this.events.saved?.(path);
    return true;
  }
  async mayLeave(): Promise<boolean> {
    if (!this.dirty) return true;
    const choice = await this.port.confirmSave(this.name);
    if (choice === 'cancel') return false;
    return choice === 'discard' || (await this.save() && !this.dirty);
  }
  async fresh(): Promise<boolean> {
    if (!await this.mayLeave()) return false;
    this.pending = false; this.unavailable = false; this.path = null; this.text = ''; this.savedText = ''; this.bom = false; this.newline = 'lf'; this.revision = undefined;
    this.events.fresh?.();
    return true;
  }
  async open(path?: string): Promise<boolean> {
    // Pick first: cancelling Open must not discard the current unsaved document.
    const selected = path ?? await this.port.openPath();
    if (!selected || !await this.mayLeave()) return false;
    const file = await this.port.read(selected);
    this.pending = false; this.unavailable = false;
    this.path = file.path; this.text = file.text; this.savedText = file.text;
    this.bom = file.bom; this.newline = file.newline; this.revision = file.revision;
    this.events.opened?.(file);
    return true;
  }
}

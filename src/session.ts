export type Newline = 'lf' | 'crlf' | 'cr' | 'mixed';
export interface DocumentFile { path: string; text: string; bom: boolean; newline: Newline; revision: string }
export interface FilePort {
  openPath(): Promise<string | null>;
  savePath(current: string | null): Promise<string | null>;
  read(path: string): Promise<DocumentFile>;
  write(path: string, text: string, bom: boolean, newline: Newline, expectedRevision?: string): Promise<{revision: string}>;
  confirmSave(name: string): Promise<'save' | 'discard' | 'cancel'>;
}
export class DocumentSession {
  path: string | null = null;
  text = '';
  savedText = '';
  bom = false;
  newline: Newline = 'lf';
  revision: string | undefined;
  constructor(readonly port: FilePort) {}
  get dirty() { return this.text !== this.savedText; }
  get name() { return this.path?.split(/[\\/]/).pop() || '未命名'; }
  edit(text: string) { this.text = text; }
  async save(as = false): Promise<boolean> {
    const path = as || !this.path ? await this.port.savePath(this.path) : this.path;
    if (!path) return false;
    const snapshot = this.text;
    const result = await this.port.write(path, snapshot, this.bom, this.newline, path === this.path ? this.revision : undefined);
    this.path = path;
    this.revision = result.revision;
    this.savedText = snapshot;
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
    this.path = null; this.text = ''; this.savedText = ''; this.bom = false; this.newline = 'lf'; this.revision = undefined;
    return true;
  }
  async open(path?: string): Promise<boolean> {
    // Pick first: cancelling Open must not discard the current unsaved document.
    const selected = path ?? await this.port.openPath();
    if (!selected || !await this.mayLeave()) return false;
    const file = await this.port.read(selected);
    this.path = file.path; this.text = file.text; this.savedText = file.text;
    this.bom = file.bom; this.newline = file.newline; this.revision = file.revision;
    return true;
  }
}

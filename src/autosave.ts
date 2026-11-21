import type { DocumentSession } from './session';

interface AutosaveOptions {
  session: DocumentSession;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  snapshot(): string;
  composing(): boolean;
  blocked(): boolean;
  updated(): void;
  report(message: string, conflict: boolean): Promise<void>;
}

export class Autosave {
  enabled: boolean;
  private paused = false;
  private firstEdit?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<boolean>;
  private lastError?: string;

  constructor(private readonly options: AutosaveOptions) {
    this.enabled = options.storage.getItem('croquill-autosave') === 'true';
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.options.storage.setItem('croquill-autosave', String(enabled));
    this.cancelTimer();
    if (this.options.session.dirty) this.changed();
  }

  private cancelTimer() {
    clearTimeout(this.timer);
    this.firstEdit = undefined;
  }

  resetDocument() {
    this.cancelTimer();
    this.paused = false;
    this.lastError = undefined;
  }

  changed() {
    if (!this.enabled || this.paused || !this.options.session.path) return;
    clearTimeout(this.timer);
    const now = Date.now();
    this.firstEdit ??= now;
    this.timer = setTimeout(() => {
      // compositionend and the manual operation's finally block re-arm us.
      if (this.options.composing() || this.options.blocked() || this.active) return;
      void this.save();
    }, Math.max(0, Math.min(1000, this.firstEdit + 5000 - now)));
  }

  resume() {
    if (this.firstEdit !== undefined) this.changed();
  }

  async settle() { await this.active; }

  async beforeLeave(): Promise<boolean> {
    if (!this.enabled || this.paused || !this.options.session.path || this.options.composing()) return false;
    return this.save();
  }

  private save(): Promise<boolean> {
    if (this.active) return this.active;
    this.cancelTimer();
    const { session } = this.options;
    session.edit(this.options.snapshot());
    if (!session.dirty) return Promise.resolve(true);
    this.active = session.save().then(ok => {
      this.lastError = undefined;
      return ok && !session.dirty;
    }).catch(async error => {
      const message = String(error);
      this.paused = message.includes('原文件已被其他程序修改或移走');
      if (this.paused) this.cancelTimer();
      if (message !== this.lastError) {
        this.lastError = message;
        await this.options.report(message, this.paused);
      }
      return false;
    }).finally(() => {
      this.active = undefined;
      this.options.updated();
      this.resume();
    });
    return this.active;
  }
}

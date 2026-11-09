export type GlobalCommand = 'save' | 'saveAs' | 'open' | 'new' | 'find' | 'replace' | 'mode' | 'folder' | 'sidebar';
export function globalCommand(event: KeyboardEvent): GlobalCommand | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  // IME/non-Latin layouts can change `key` even when no composition is active.
  const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
  if (event.key === '/' || event.code === 'Slash' && !event.shiftKey) return 'mode';
  switch (key) {
    case 's': return event.shiftKey ? 'saveAs' : 'save';
    case 'o': return event.shiftKey ? 'folder' : 'open';
    case 'n': return event.shiftKey ? null : 'new';
    case 'f': return event.shiftKey ? null : 'find';
    case 'h': return event.shiftKey ? null : 'replace';
    case 'm': return event.shiftKey ? 'mode' : null;
    case 'l': return event.shiftKey ? 'sidebar' : null;
    default: return null;
  }
}

/** Register above editor/node-view handlers, and consume each shortcut once. */
export function installGlobalShortcuts(options: { composing(): boolean; modal(): boolean; execute(command: GlobalCommand): void; menu(event: KeyboardEvent): void }): () => void {
  const handle = (event: KeyboardEvent) => {
    if (event.isComposing || options.composing() || options.modal()) return;
    const command = globalCommand(event);
    if (!command) { options.menu(event); return; }
    event.preventDefault(); event.stopImmediatePropagation();
    if (!event.repeat) options.execute(command);
  };
  window.addEventListener('keydown', handle, { capture: true });
  return () => window.removeEventListener('keydown', handle, { capture: true });
}

export interface MenuCommand { action?: string; format?: string; path?: string }

/** Keep the pressed item through popup closure and consume its whole gesture. */
export function installMenuPointerRouting(bar: HTMLElement, execute: (command: MenuCommand) => void): () => void {
  let pending: { pointer: number; rect: DOMRect; command: MenuCommand } | null = null;
  let suppressClick = false;
  const reset = () => { suppressClick = false; };
  const down = (event: PointerEvent) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLElement>('.menu button[data-action],.menu button[data-format]') : null;
    if (!button || !bar.contains(button) || event.button !== 0 || !event.isPrimary) return;
    pending = { pointer: event.pointerId, rect: button.getBoundingClientRect(), command: { action: button.dataset.action, format: button.dataset.format, path: button.dataset.path } };
    event.preventDefault(); event.stopPropagation(); bar.setPointerCapture(event.pointerId);
  };
  const up = (event: PointerEvent) => {
    if (!pending || pending.pointer !== event.pointerId) return;
    const pressed = pending; pending = null; suppressClick = true;
    event.preventDefault(); event.stopPropagation();
    bar.querySelectorAll('details[open]').forEach(node => node.removeAttribute('open'));
    if (event.clientX >= pressed.rect.left && event.clientX <= pressed.rect.right && event.clientY >= pressed.rect.top && event.clientY <= pressed.rect.bottom) execute(pressed.command);
  };
  const cancel = () => { pending = null; suppressClick = true; };
  const click = (event: MouseEvent) => { if (suppressClick && event.detail > 0) { suppressClick = false; event.preventDefault(); event.stopImmediatePropagation(); } };
  document.addEventListener('pointerdown', reset, true);
  document.addEventListener('click', click, true);
  document.addEventListener('pointerdown', down, true); bar.addEventListener('pointerup', up, true); bar.addEventListener('pointercancel', cancel, true);
  return () => {
    document.removeEventListener('pointerdown', reset, true); document.removeEventListener('click', click, true);
    document.removeEventListener('pointerdown', down, true); bar.removeEventListener('pointerup', up, true); bar.removeEventListener('pointercancel', cancel, true);
  };
}

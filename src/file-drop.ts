/** File lists are protected during dragover; the Files type remains available. */
export function hasFileTransfer(data: DataTransfer | null): boolean {
  return !!data && (data.files.length > 0 || data.types.includes('Files'));
}

/** Only editor roots accept files. Text/HTML editor drags keep their native behavior. */
export function protectFileDrops(page: Window, editorRoots: readonly HTMLElement[]): void {
  const guard = (event: DragEvent) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    const insideEditor = event.target instanceof Node && editorRoots.some(root => !root.hidden && !root.inert && root.contains(event.target as Node));
    if (!insideEditor) event.stopImmediatePropagation();
  };
  page.addEventListener('dragover', guard, { capture: true });
  page.addEventListener('drop', guard, { capture: true });
}

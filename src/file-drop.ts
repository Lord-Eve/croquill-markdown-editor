/** File lists are protected during dragover; the Files type remains available. */
export function hasFileTransfer(data: DataTransfer | null): boolean {
  return !!data && (data.files.length > 0 || data.types.includes('Files'));
}

/** Documents open across the window; images stay in editor roots. Keep text drags native. */
export function protectFileDrops(page: Window, editorRoots: readonly HTMLElement[], openMarkdown?: (files: File[]) => void): void {
  const guard = (event: DragEvent) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files || []);
    if (openMarkdown && files.some(file => /\.(?:md|markdown|mdown|mkd)$/i.test(file.name))) {
      event.stopImmediatePropagation();
      if (event.type === 'drop') openMarkdown(files);
      return;
    }
    const insideEditor = event.target instanceof Node && editorRoots.some(root => !root.hidden && !root.inert && root.contains(event.target as Node));
    if (!insideEditor) event.stopImmediatePropagation();
  };
  page.addEventListener('dragover', guard, { capture: true });
  page.addEventListener('drop', guard, { capture: true });
}

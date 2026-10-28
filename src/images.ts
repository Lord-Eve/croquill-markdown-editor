/** Image bytes travel over IPC only; Markdown receives the returned relative URL. */
export type ImageSource = { path: string } | { file: File; clipboard?: boolean };
export interface ImageImportPort {
  documentPath(): string | null;
  saveDocument(): Promise<boolean>;
  warn(message: string): void;
  persist(args: { documentPath: string; sourcePath?: string; dataBase64?: string; fileName?: string }): Promise<string>;
  now?(): Date;
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(file.name);
}
export function clipboardImageName(date: Date): string {
  const part = (n: number) => String(n).padStart(2, '0');
  return `image-${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}.png`;
}
async function asPng(file: File): Promise<Blob> {
  if (file.type === 'image/png') return file;
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法转换剪贴板图片');
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法转换剪贴板图片')), 'image/png'));
  } finally { bitmap.close(); }
}
async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export class ImageImporter {
  constructor(private readonly port: ImageImportPort) {}
  async import(source: ImageSource): Promise<string | null> {
    if (!this.port.documentPath() && !await this.port.saveDocument()) {
      this.port.warn('请先保存文档，再插入图片');
      return null;
    }
    const documentPath = this.port.documentPath();
    if (!documentPath) throw new Error('请先保存文档，再插入图片');
    if ('path' in source) return this.port.persist({ documentPath, sourcePath: source.path });
    const file = source.clipboard ? await asPng(source.file) : source.file;
    return this.port.persist({ documentPath, dataBase64: await base64(file), fileName: source.clipboard ? clipboardImageName(this.port.now?.() ?? new Date()) : source.file.name });
  }
}

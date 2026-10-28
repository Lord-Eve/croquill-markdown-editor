import { describe, expect, it, vi } from 'vitest';
import { ImageImporter, clipboardImageName } from '../src/images';

describe('image file import', () => {
  it('copies a selected local path without reading it into Markdown', async () => {
    const persist = vi.fn(async () => '日记.assets/中文%20照片.png');
    const saveDocument = vi.fn();
    const importer = new ImageImporter({ documentPath: () => 'D:\\笔记\\日记.md', saveDocument, warn: vi.fn(), persist });
    expect(await importer.import({ path: 'D:\\图片\\中文 照片.png' })).toBe('日记.assets/中文%20照片.png');
    expect(persist).toHaveBeenCalledWith({ documentPath: 'D:\\笔记\\日记.md', sourcePath: 'D:\\图片\\中文 照片.png' });
    expect(saveDocument).not.toHaveBeenCalled();
  });
  it('saves an untitled document before importing image bytes', async () => {
    let path: string | null = null;
    const persist = vi.fn(async () => '日记.assets/image-20261028153012.png');
    const importer = new ImageImporter({ documentPath: () => path, saveDocument: async () => { path = 'D:\\笔记\\日记.md'; return true; }, warn: vi.fn(), persist, now: () => new Date(2026, 9, 28, 15, 30, 12) });
    expect(await importer.import({ file: new File([new Uint8Array([1, 2, 3])], 'clipboard.png', { type: 'image/png' }), clipboard: true })).toBe('日记.assets/image-20261028153012.png');
    expect(persist).toHaveBeenCalledWith({ documentPath: path, dataBase64: 'AQID', fileName: 'image-20261028153012.png' });
  });
  it('cancels without writing bytes when document Save is cancelled', async () => {
    const persist = vi.fn(); const warn = vi.fn();
    const importer = new ImageImporter({ documentPath: () => null, saveDocument: async () => false, warn, persist });
    expect(await importer.import({ path: 'D:\\图片\\photo.png' })).toBeNull();
    expect(persist).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('请先保存文档，再插入图片');
  });
  it('does not import an image when saving the document fails', async () => {
    const persist = vi.fn();
    const importer = new ImageImporter({ documentPath: () => null, saveDocument: async () => { throw new Error('只读'); }, warn: vi.fn(), persist });
    await expect(importer.import({ path: 'D:\\图片\\photo.png' })).rejects.toThrow('只读');
    expect(persist).not.toHaveBeenCalled();
  });
  it('pads all fields of the local timestamp name', () => {
    expect(clipboardImageName(new Date(2026, 0, 2, 3, 4, 5))).toBe('image-20260102030405.png');
  });
});

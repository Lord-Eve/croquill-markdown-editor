import { describe, expect, it, vi } from 'vitest';
import { DocumentSession, type DocumentFile, type FilePort, type Newline } from '../src/session';

const currentPath = 'D:\\写作 文件\\当前文档.md';
const nextPath = 'D:\\写作 文件\\下一篇.md';

function file(overrides: Partial<DocumentFile> = {}): DocumentFile {
  return { path: currentPath, text: '# 原文\n\n中文段落。\n', bom: true, newline: 'crlf', revision: 'revision-1', ...overrides };
}

function setup() {
  const port = {
    openPath: vi.fn<FilePort['openPath']>().mockResolvedValue(nextPath),
    savePath: vi.fn<FilePort['savePath']>().mockResolvedValue(currentPath),
    read: vi.fn<FilePort['read']>().mockImplementation(async path => file({ path })),
    write: vi.fn<FilePort['write']>().mockResolvedValue({ revision: 'revision-2' }),
    confirmSave: vi.fn<FilePort['confirmSave']>().mockResolvedValue('cancel'),
  };
  return { port, session: new DocumentSession(port) };
}

async function opened() {
  const fixture = setup();
  await fixture.session.open(currentPath);
  fixture.port.read.mockClear();
  return fixture;
}

function snapshot(session: DocumentSession) {
  return {
    path: session.path, text: session.text, savedText: session.savedText,
    bom: session.bom, newline: session.newline, revision: session.revision, dirty: session.dirty,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

describe('DocumentSession 保存', () => {
  it('未命名文档取消另存为后保留全部内容和未保存状态', async () => {
    const { port, session } = setup();
    session.edit('尚未保存的中文草稿。');
    port.savePath.mockResolvedValue(null);
    const before = snapshot(session);

    expect(await session.save()).toBe(false);
    expect(snapshot(session)).toEqual(before);
    expect(port.write).not.toHaveBeenCalled();
  });

  it('已打开文档取消另存为后保留路径、版本与 dirty', async () => {
    const { port, session } = await opened();
    session.edit('修改后的中文。');
    port.savePath.mockResolvedValue(null);
    const before = snapshot(session);

    expect(await session.save(true)).toBe(false);
    expect(port.savePath).toHaveBeenCalledWith(currentPath);
    expect(snapshot(session)).toEqual(before);
    expect(port.write).not.toHaveBeenCalled();
  });

  it('原路径写入失败时保留文档、dirty 与原版本', async () => {
    const { port, session } = await opened();
    session.edit('写入失败也不能丢失。');
    port.write.mockRejectedValue(new Error('只读文件，拒绝写入'));
    const before = snapshot(session);

    await expect(session.save()).rejects.toThrow('拒绝写入');
    expect(snapshot(session)).toEqual(before);
    expect(port.savePath).not.toHaveBeenCalled();
  });

  it('另存为写入失败时不会把当前路径改成失败目标', async () => {
    const { port, session } = await opened();
    session.edit('保留当前文档。');
    port.savePath.mockResolvedValue(nextPath);
    port.write.mockRejectedValue(new Error('目标目录不可写'));
    const before = snapshot(session);

    await expect(session.save(true)).rejects.toThrow('不可写');
    expect(snapshot(session)).toEqual(before);
    expect(port.write).toHaveBeenCalledWith(nextPath, session.text, true, 'crlf', undefined);
  });

  it('保存成功后更新版本并清除 dirty', async () => {
    const { port, session } = await opened();
    session.edit('保存成功的中文。');

    expect(await session.save()).toBe(true);
    expect(port.write).toHaveBeenCalledWith(currentPath, '保存成功的中文。', true, 'crlf', 'revision-1');
    expect(session.savedText).toBe('保存成功的中文。');
    expect(session.revision).toBe('revision-2');
    expect(session.dirty).toBe(false);
  });

  it('另存为成功后采用新路径，不传递旧文件版本', async () => {
    const { port, session } = await opened();
    session.edit('另存的新文档。');
    port.savePath.mockResolvedValue(nextPath);

    expect(await session.save(true)).toBe(true);
    expect(port.write).toHaveBeenCalledWith(nextPath, '另存的新文档。', true, 'crlf', undefined);
    expect(session.path).toBe(nextPath);
    expect(session.dirty).toBe(false);
  });

  it('异步写入期间的新编辑仍保留 dirty，保存基线仅对应已写入快照', async () => {
    const { port, session } = await opened();
    const pending = deferred<{ revision: string }>();
    port.write.mockReturnValue(pending.promise);
    session.edit('点击保存时的正文。');
    const saving = session.save();
    expect(port.write).toHaveBeenCalledWith(currentPath, '点击保存时的正文。', true, 'crlf', 'revision-1');

    session.edit('保存过程中继续输入。');
    pending.resolve({ revision: 'revision-snapshot' });
    expect(await saving).toBe(true);
    expect(session.text).toBe('保存过程中继续输入。');
    expect(session.savedText).toBe('点击保存时的正文。');
    expect(session.dirty).toBe(true);
    expect(session.revision).toBe('revision-snapshot');
  });

  it.each<Newline>(['lf', 'crlf', 'cr', 'mixed'])('保存时传递读取到的 BOM 与 %s 换行元数据', async newline => {
    const { port, session } = setup();
    port.read.mockResolvedValue(file({ newline, bom: true }));
    await session.open(currentPath);

    expect(await session.save()).toBe(true);
    expect(port.write).toHaveBeenCalledWith(currentPath, file().text, true, newline, 'revision-1');
    expect(session.bom).toBe(true);
    expect(session.newline).toBe(newline);
  });

  it('无 BOM 文档保存时不会自行添加 BOM', async () => {
    const { port, session } = setup();
    port.read.mockResolvedValue(file({ bom: false }));
    await session.open(currentPath);
    await session.save();

    expect(port.write).toHaveBeenCalledWith(currentPath, file().text, false, 'crlf', 'revision-1');
  });
});

describe('DocumentSession 新建与打开前的未保存处理', () => {
  it.each(['fresh', 'open'] as const)('%s：选择取消时完整保留旧文档', async action => {
    const { port, session } = await opened();
    session.edit('需要保留的未保存修改。');
    port.confirmSave.mockResolvedValue('cancel');
    const before = snapshot(session);

    expect(await (action === 'fresh' ? session.fresh() : session.open(nextPath))).toBe(false);
    expect(snapshot(session)).toEqual(before);
    expect(port.write).not.toHaveBeenCalled();
    expect(port.read).not.toHaveBeenCalled();
    expect(port.confirmSave).toHaveBeenCalledWith('当前文档.md');
  });

  it.each(['fresh', 'open'] as const)('%s：选择不保存后执行动作', async action => {
    const { port, session } = await opened();
    session.edit('明确放弃的修改。');
    port.confirmSave.mockResolvedValue('discard');
    port.read.mockResolvedValue(file({ path: nextPath, text: '下一篇正文', bom: false, newline: 'lf', revision: 'next-revision' }));

    expect(await (action === 'fresh' ? session.fresh() : session.open(nextPath))).toBe(true);
    expect(port.write).not.toHaveBeenCalled();
    expect(session.dirty).toBe(false);
    if (action === 'fresh') {
      expect(snapshot(session)).toEqual({ path: null, text: '', savedText: '', bom: false, newline: 'lf', revision: undefined, dirty: false });
    } else {
      expect(session.path).toBe(nextPath);
      expect(session.text).toBe('下一篇正文');
      expect(session.revision).toBe('next-revision');
    }
  });

  it.each(['fresh', 'open'] as const)('%s：选择保存后先写入旧文档再执行动作', async action => {
    const { port, session } = await opened();
    session.edit('切换前必须保存的正文。');
    port.confirmSave.mockResolvedValue('save');
    const operations: string[] = [];
    port.write.mockImplementation(async () => { operations.push('write'); return { revision: 'saved-before-leave' }; });
    port.read.mockImplementation(async path => { operations.push('read'); return file({ path, text: '下一篇' }); });

    expect(await (action === 'fresh' ? session.fresh() : session.open(nextPath))).toBe(true);
    expect(port.write).toHaveBeenCalledWith(currentPath, '切换前必须保存的正文。', true, 'crlf', 'revision-1');
    expect(operations).toEqual(action === 'fresh' ? ['write'] : ['write', 'read']);
    expect(session.path).toBe(action === 'fresh' ? null : nextPath);
    expect(session.dirty).toBe(false);
  });

  it.each(['fresh', 'open'] as const)('%s：选择保存但取消另存为时停留原文档', async action => {
    const { port, session } = setup();
    session.edit('还没有路径的草稿。');
    port.confirmSave.mockResolvedValue('save');
    port.savePath.mockResolvedValue(null);
    const before = snapshot(session);

    expect(await (action === 'fresh' ? session.fresh() : session.open(nextPath))).toBe(false);
    expect(snapshot(session)).toEqual(before);
    expect(port.read).not.toHaveBeenCalled();
    expect(port.write).not.toHaveBeenCalled();
  });

  it.each(['fresh', 'open'] as const)('%s：离开前保存失败时保留旧文档', async action => {
    const { port, session } = await opened();
    session.edit('不能因写入失败而丢失。');
    port.confirmSave.mockResolvedValue('save');
    port.write.mockRejectedValue(new Error('磁盘写入失败'));
    const before = snapshot(session);

    await expect(action === 'fresh' ? session.fresh() : session.open(nextPath)).rejects.toThrow('磁盘写入失败');
    expect(snapshot(session)).toEqual(before);
    expect(port.read).not.toHaveBeenCalled();
  });

  it('打开对话框取消时不触发保存或放弃提示', async () => {
    const { port, session } = await opened();
    session.edit('取消打开后继续写。');
    port.openPath.mockResolvedValue(null);
    const before = snapshot(session);

    expect(await session.open()).toBe(false);
    expect(snapshot(session)).toEqual(before);
    expect(port.confirmSave).not.toHaveBeenCalled();
    expect(port.read).not.toHaveBeenCalled();
    expect(port.write).not.toHaveBeenCalled();
  });

  it('选择不保存后读取新文件失败，旧文档仍然可编辑并保留 dirty', async () => {
    const { port, session } = await opened();
    session.edit('即使新文件打不开也保留这里。');
    port.confirmSave.mockResolvedValue('discard');
    port.read.mockRejectedValue(new Error('文件不存在'));
    const before = snapshot(session);

    await expect(session.open(nextPath)).rejects.toThrow('文件不存在');
    expect(snapshot(session)).toEqual(before);
  });

  it('已保存文档读取新文件失败时保留原路径和原文', async () => {
    const { port, session } = await opened();
    port.read.mockRejectedValue(new Error('UTF-8 解码失败'));
    const before = snapshot(session);

    await expect(session.open(nextPath)).rejects.toThrow('UTF-8 解码失败');
    expect(snapshot(session)).toEqual(before);
    expect(port.confirmSave).not.toHaveBeenCalled();
  });

  it('离开前异步保存期间继续编辑时不执行新建', async () => {
    const { port, session } = await opened();
    const pending = deferred<{ revision: string }>();
    port.confirmSave.mockResolvedValue('save');
    port.write.mockReturnValue(pending.promise);
    session.edit('准备离开时的内容。');

    const leaving = session.fresh();
    await vi.waitFor(() => expect(port.write).toHaveBeenCalledTimes(1));
    session.edit('保存时新增的内容必须留住。');
    pending.resolve({ revision: 'revision-snapshot' });

    expect(await leaving).toBe(false);
    expect(session.path).toBe(currentPath);
    expect(session.text).toBe('保存时新增的内容必须留住。');
    expect(session.dirty).toBe(true);
  });

  it('无修改的新建与打开无需提示保存', async () => {
    const { port, session } = setup();
    expect(await session.fresh()).toBe(true);
    expect(await session.open(nextPath)).toBe(true);
    expect(port.confirmSave).not.toHaveBeenCalled();
    expect(port.write).not.toHaveBeenCalled();
  });
});

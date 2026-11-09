import { describe, expect, it, vi } from 'vitest';
import { DocumentSession, type FilePort } from '../src/session';

function fixture() {
  const port: FilePort = { openPath: async () => null, savePath: async () => 'E:/新目录/新.md', confirmSave: async () => 'save', read: async path => ({path,text:'![图](old.assets/a.png)\r\n',bom:true,newline:'crlf',revision:'old'}), write: vi.fn(async () => ({revision:'new'})), prepareSaveAs: vi.fn(async (_from, _to, text) => text.replace('old.assets/a.png','file:///D:/笔记/old.assets/a.png')) };
  const events = { opened: vi.fn(), saved: vi.fn(), fresh: vi.fn() }, session = new DocumentSession(port, events); return { port, events, session };
}
describe('Save As image preparation and session commit', () => {
  it('prepares before the one safe write and adopts exactly the written source only after success', async () => {
    const { port, session, events } = fixture(); await session.open('D:/笔记/old.md');
    expect(await session.save(true)).toBe(true); expect(port.prepareSaveAs).toHaveBeenCalledWith('D:/笔记/old.md','E:/新目录/新.md','![图](old.assets/a.png)\r\n');
    expect(port.write).toHaveBeenCalledWith('E:/新目录/新.md','![图](file:///D:/笔记/old.assets/a.png)\r\n',true,'crlf',undefined);
    expect(session.text).toBe(session.savedText); expect(session.dirty).toBe(false); expect(session.path).toBe('E:/新目录/新.md'); expect(events.saved).toHaveBeenCalledWith(session.path);
  });
  it.each(['prepare','write'])('keeps original path, source, saved revision and history on %s failure', async phase => {
    const { port, session, events } = fixture(); await session.open('D:/笔记/old.md'); session.edit(session.text+'新字'); const before = {path:session.path,text:session.text,saved:session.savedText,revision:session.revision};
    if (phase==='prepare') port.prepareSaveAs=async()=>{throw Error('图片缺失');}; else port.write=async()=>{throw Error('只读文件');};
    await expect(session.save(true)).rejects.toThrow(); expect({path:session.path,text:session.text,saved:session.savedText,revision:session.revision}).toEqual(before); expect(session.dirty).toBe(true); expect(events.saved).not.toHaveBeenCalled();
  });
  it('does not rewrite or drop edits made while image preparation is pending', async () => {
    const { port, session } = fixture(); await session.open('D:/笔记/old.md'); let finish!:(text:string)=>void;
    port.prepareSaveAs=()=>new Promise(resolve=>{finish=resolve;}); const saving=session.save(true); await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
    session.edit('后来的文字和原路径图片'); finish('已转换的旧快照'); await expect(saving).rejects.toThrow('尚未写入'); expect(port.write).not.toHaveBeenCalled(); expect(session.text).toBe('后来的文字和原路径图片'); expect(session.path).toBe('D:/笔记/old.md');
  });
  it('keeps the active document at the old path if new edits arrive during the transformed write', async () => {
    const { port, session, events } = fixture(); await session.open('D:/笔记/old.md'); let finish!:(result:{revision:string})=>void;
    port.write=()=>new Promise(resolve=>{finish=resolve;}); const saving=session.save(true); await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
    session.edit('新字和旧相对路径'); finish({revision:'copy'}); await expect(saving).rejects.toThrow('副本已经写入'); expect(session.path).toBe('D:/笔记/old.md'); expect(session.text).toBe('新字和旧相对路径'); expect(session.revision).toBe('old'); expect(events.saved).not.toHaveBeenCalled();
  });
  it('uses the original revision and skips path preparation for equivalent Windows paths', async () => {
    const { port, session } = fixture(); await session.open('D:/笔记/old.md'); port.savePath=async()=> 'd:\\笔记\\OLD.md'; await session.save(true);
    expect(port.prepareSaveAs).not.toHaveBeenCalled(); expect(port.write).toHaveBeenCalledWith('d:\\笔记\\OLD.md',session.text,true,'crlf','old');
  });
  it('keeps a known missing current file dirty across flushes until it is safely saved elsewhere', async () => {
    const {session}=fixture();await session.open('D:/笔记/old.md');session.markUnavailable();session.edit(session.text);expect(session.dirty).toBe(true);
    await session.save(true);expect(session.dirty).toBe(false);
  });
});

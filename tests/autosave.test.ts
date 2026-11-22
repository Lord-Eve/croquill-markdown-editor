import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Autosave } from '../src/autosave';
import { DocumentSession } from '../src/session';

async function setup(named = true) {
  let composing = false;
  const memory = new Map<string,string>();
  const storage = { getItem: (k:string) => memory.get(k) ?? null, setItem: (k:string,v:string) => { memory.set(k,v); } };
  const write = vi.fn(async (_path:string, _text:string, _bom:boolean, _newline:string, _revision?:string) => ({ revision:'new' }));
  const confirmSave = vi.fn(async () => 'cancel' as const), report = vi.fn(async () => {});
  const session = new DocumentSession({
    read: async path => ({ path, text:'原文', revision:'old', newline:'lf', bom:false }),
    openPath: async () => 'other.md', savePath: async () => null, write, confirmSave,
    saveBeforeLeave: (): Promise<boolean> => auto.beforeLeave(),
  });
  const options = { session, storage, snapshot: () => session.text, composing: () => composing, blocked: () => false, updated: () => {}, report };
  const auto = new Autosave(options);
  if (named) await session.open('doc.md');
  function edit(text:string) { session.edit(text); auto.changed(); }
  return { auto, options, session, write, confirmSave, report, edit,
    composing: (active:boolean) => { composing = active; if (!active) auto.resume(); } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('默认关闭，记住开关，开启时保存已有修改，干净文档不写盘', async () => {
  const { auto, options, write, edit } = await setup();
  expect(auto.enabled).toBe(false);
  auto.setEnabled(true); await vi.advanceTimersByTimeAsync(5000); expect(write).not.toHaveBeenCalled();
  auto.setEnabled(false); edit('已有修改'); await vi.advanceTimersByTimeAsync(5000); expect(write).not.toHaveBeenCalled();
  auto.setEnabled(true); expect(new Autosave(options).enabled).toBe(true);
  await vi.advanceTimersByTimeAsync(999); expect(write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(write).toHaveBeenCalledExactlyOnceWith('doc.md','已有修改',false,'lf','old');
});
it('连续输入第五秒写入当前快照，未命名文档只在离开时询问', async () => {
  const named = await setup(), fresh = await setup(false);
  for (const f of [named, fresh]) f.auto.setEnabled(true);
  for (let i = 0; i < 10; i++) { named.edit(String(i)); fresh.edit(String(i)); await vi.advanceTimersByTimeAsync(500); }
  expect(named.write).toHaveBeenCalledExactlyOnceWith('doc.md','9',false,'lf','old');
  expect(fresh.write).not.toHaveBeenCalled(); expect(await fresh.session.fresh()).toBe(false);
  expect(fresh.confirmSave).toHaveBeenCalledOnce();
});
it('组词期间不写，直到上屏后写入完整的词', async () => {
  const f = await setup(); f.auto.setEnabled(true); f.composing(true); f.edit('pin');
  await vi.advanceTimersByTimeAsync(6000); expect(f.write).not.toHaveBeenCalled();
  f.edit('拼音'); f.composing(false); await vi.advanceTimersByTimeAsync(1000);
  expect(f.write).toHaveBeenCalledExactlyOnceWith('doc.md','拼音',false,'lf','old');
});
it('慢写入期间保留之后的编辑，下一次独占写入包含全部文字', async () => {
  const f = await setup(); f.auto.setEnabled(true);
  let release!: (r: {revision:string}) => void;
  f.write.mockImplementationOnce(() => new Promise(r => { release = r; }));
  f.edit('甲'); await vi.advanceTimersByTimeAsync(1000);
  f.edit('甲乙'); await vi.advanceTimersByTimeAsync(5000);
  expect(f.write).toHaveBeenCalledTimes(1); release({ revision:'first' }); await f.auto.settle();
  expect(f.session.dirty).toBe(true); expect(f.session.savedText).toBe('甲');
  await vi.advanceTimersByTimeAsync(1); expect(f.session.dirty).toBe(false);
  expect(f.write).toHaveBeenLastCalledWith('doc.md','甲乙',false,'lf','first');
});
it('版本冲突暂停本文档，失败的切换退回询问，重新打开后可保存', async () => {
  const f = await setup(); f.auto.setEnabled(true); f.edit('甲');
  f.write.mockRejectedValueOnce('原文件已被其他程序修改或移走');
  expect(await f.session.open()).toBe(false); expect(f.confirmSave).toHaveBeenCalledOnce();
  expect(f.report).toHaveBeenCalledWith('原文件已被其他程序修改或移走',true);
  f.edit('乙'); await vi.advanceTimersByTimeAsync(6000); expect(f.write).toHaveBeenCalledTimes(1);
  f.auto.resetDocument(); f.edit('丙'); await vi.advanceTimersByTimeAsync(1000); expect(f.session.savedText).toBe('丙');
});
it('冲突会取消写入期间排队的定时保存', async () => {
  const f = await setup(); f.auto.setEnabled(true);
  let conflict!: (error: Error) => void;
  f.write.mockImplementationOnce(() => new Promise((_resolve, reject) => { conflict = reject; }));
  f.edit('甲乙'); await vi.advanceTimersByTimeAsync(1000);
  f.composing(true); f.edit('甲nihao乙');
  conflict(new Error('原文件已被其他程序修改或移走')); await f.auto.settle();
  f.edit('甲你好乙'); f.composing(false); await vi.advanceTimersByTimeAsync(5000);
  expect(f.write).toHaveBeenCalledTimes(1); expect(f.session.savedText).toBe('原文');
  expect(f.session.text).toBe('甲你好乙'); expect(f.session.dirty).toBe(true);
});
it('只读错误只提示一次，下一次修改重试；成功切换及关窗直接保存', async () => {
  const f = await setup(); f.auto.setEnabled(true); f.write.mockRejectedValue('只读');
  f.edit('甲'); await vi.advanceTimersByTimeAsync(5000); expect(f.write).toHaveBeenCalledTimes(1);
  f.edit('乙'); await vi.advanceTimersByTimeAsync(5000); expect(f.write).toHaveBeenCalledTimes(2);
  expect(f.report).toHaveBeenCalledTimes(1); expect(f.session.dirty).toBe(true);
  f.write.mockResolvedValue({ revision:'new' });
  expect(await f.session.open()).toBe(true); f.edit('丙'); expect(await f.session.mayLeave()).toBe(true);
  expect(f.confirmSave).not.toHaveBeenCalled(); expect(f.session.savedText).toBe('丙');
});

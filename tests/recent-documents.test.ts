import { describe, expect, it } from 'vitest';
import { RecentDocuments, recentDocumentsKey } from '../src/recent-documents';

function storage(initial: string | null = null) { let value = initial; return { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } }; }
describe('persistent recent documents', () => {
  it('retains ten newest paths, moves repeats to the front, and remembers the last active document', () => {
    const saved = storage(), history = new RecentDocuments(saved);
    for (let index = 0; index < 12; index++) history.opened(`D:/笔记/${index}.md`);
    expect(history.paths).toHaveLength(10); expect(history.paths.at(-1)).toBe('D:/笔记/2.md');
    history.opened('d:\\笔记\\5.MD');
    const reopened = new RecentDocuments(saved); expect(reopened.paths).toHaveLength(10); expect(reopened.paths[0]).toBe('d:\\笔记\\5.MD'); expect(reopened.lastPath).toBe('d:\\笔记\\5.MD');
    expect(recentDocumentsKey).toBe('croquill-recent-documents');
  });
  it('removes missing paths including their restore target but retains other recent entries', () => {
    const saved = storage(), history = new RecentDocuments(saved); history.opened('D:/a.md'); history.opened('D:/b.md'); history.forget('d:\\B.md');
    expect(new RecentDocuments(saved).paths).toEqual(['D:/a.md']); expect(new RecentDocuments(saved).lastPath).toBeNull();
  });
  it('new documents clear restoration without erasing the recent list', () => {
    const saved = storage(), history = new RecentDocuments(saved); history.opened('/notes/a.md'); history.fresh();
    expect(new RecentDocuments(saved).paths).toEqual(['/notes/a.md']); expect(new RecentDocuments(saved).lastPath).toBeNull();
  });
  it('retains POSIX case, filters corrupt entries, and survives unavailable preference storage', () => {
    const history = new RecentDocuments(storage(JSON.stringify({ files: ['/A.md', '/a.md', '/A.md', 3, null, '', 'relative.md', 'https://example.com/a.md'], last: '/missing.md' })));
    expect(history.paths).toEqual(['/A.md', '/a.md']); expect(history.lastPath).toBeNull();
    expect(new RecentDocuments(storage('{broken')).paths).toEqual([]);
    const unavailable = new RecentDocuments({ getItem() { throw Error('blocked'); }, setItem() { throw Error('quota'); } });
    expect(() => unavailable.opened('D:/good.md')).not.toThrow(); expect(unavailable.lastPath).toBe('D:/good.md');
  });
});

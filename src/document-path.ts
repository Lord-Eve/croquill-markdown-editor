/** Windows paths are case-insensitive; POSIX paths retain their case. */
export function documentPathKey(path: string): string {
  return /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(path) ? path.replace(/\\/g, '/').toLowerCase() : path;
}
export function sameDocumentPath(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && documentPathKey(left) === documentPathKey(right);
}

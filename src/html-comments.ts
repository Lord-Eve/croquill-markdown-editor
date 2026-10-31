/** One complete comment, optionally followed by source whitespace on its line. */
export function isHtmlComment(value: string): boolean {
  const opening = /^[ \t]*<!--/.exec(value);
  const end = value.indexOf('-->');
  return !!opening && end >= opening[0].length && /^[ \t]*$/.test(value.slice(end + 3));
}

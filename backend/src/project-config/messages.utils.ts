/** `a redis`, `an application`. */
export function article(kind: string): string {
  return `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}`;
}

import { BadRequestException } from '@nestjs/common';

/**
 * Characters that let a path escape the **double-quoted** shell word it is
 * interpolated into.
 *
 * One set, in one place, because the two callers need the same one and had it
 * twice: `patch/patch-repo.service.ts` guards a path going into the
 * double-quoted word of `cat "…"`, and `docker/docker.utils.ts` guards one
 * going into the double-quoted words of `mkdir -p "…"` and the redirect beside
 * it. The set looks over-broad for a quoted word and is not: `$` and a
 * backtick substitute a command *inside* double quotes too, so a quoted
 * interpolation is not on its own a fix, and everything else here is either
 * the quote that would end the word, the backslash that would escape it, or a
 * newline that would start a new command.
 *
 * **The context is load-bearing, and stating it wrongly shipped the injection
 * twice.** This set was for a while the *only* defence at
 * `getCreateFileCommand`, whose `mkdir -p` words were unquoted — and in an
 * unquoted word `;` `&` `|` `(` `)` `>` `<` and whitespace separate or
 * redirect without needing a quote of their own, none of which are here. So
 * `a$(id)/` was refused while `x;touch /root/flag #/` ran as the account that
 * drives Docker (reopened). The answer was to quote that word, not to
 * widen this set per caller: a second charset is a second thing to keep
 * correct forever, and being wrong about *which* characters a context needs is
 * the failure itself. **Every caller quotes; this set is what still gets
 * through a quote.**
 *
 * A path that matches is **refused, not escaped** — `assertShellSafePath`
 * throws `BadRequestException('Invalid path')`. Every legitimate value in
 * either position is an operator-authored constant, so nothing real is lost,
 * and a refusal only has to stay complete where an escaping routine would have
 * to stay correct forever: escaping alone would have needed single quotes and
 * therefore a rule for `'` as well.
 */
export const SHELL_UNSAFE = /["`$\\\n\r]/;

/**
 * Refuses `value` with `BadRequestException('Invalid path')` when it carries a
 * `SHELL_UNSAFE` character. Callers that also confine the path (a traversal or
 * a single-segment check) answer those with the same refusal, so a caller
 * cannot be told apart by which rule it broke.
 *
 * Not a licence to interpolate bare: this refuses what escapes a *quoted*
 * word, so a caller that calls it and then leaves the word unquoted is
 * unguarded. Quote first, call this second.
 */
export function assertShellSafePath(value: string): void {
  if (SHELL_UNSAFE.test(value)) {
    throw new BadRequestException('Invalid path');
  }
}

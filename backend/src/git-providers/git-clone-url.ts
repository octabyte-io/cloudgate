import { z } from 'zod';

/**
 * What a clone URL for the `git` source may look like: an
 * `http(s)://`, `ssh://` or `git://` URL with a host and a path, or the scp
 * form `user@host:path` (`git@github.com:acme/api.git`).
 *
 * Only the shape: whether the repository exists is the clone's question, and
 * a token in an https URL's userinfo stays allowed. It used to be a
 * bare `z.string()`, so `not a url` was saved with "The next Deployment clones
 * it" and failed at that clone. The console's form copies this pattern
 * (`frontend/src/lib/forms/git-url.ts`).
 *
 * No form admits `file://` or a bare path, so a clone on the build host cannot
 * read another tenant's checkout off the same disk; and no user or host starts
 * with `-`, in the scp form or after `://`: git would read a leading one as an
 * option, and git hands an ssh URL's `user@host` to `ssh` as one word, which
 * reads it as one too (`ssh://-oProxyCommand=…/x`, `git@-oProxyCommand…:x`).
 * The clone line passes `--` and `protocol.file.allow=never` as well
 * (`git-clone-lines.ts`).
 *
 * The host is ASCII letters, digits, dots and hyphens or a bracketed IPv6
 * literal, and nothing in the URL is a backslash: what a clone on the
 * platform host is checked against is the host {@link cloneUrlDial} reads,
 * and git dials the one curl or ssh reads, so a URL the two could split
 * differently is refused here and again by {@link cloneUrlDial}, which
 * {@link gitCloneUrlSchema} also applies.
 */
export const GIT_CLONE_URL =
  /^(?:(?:https?|ssh|git):\/\/(?:[^\s/?#@\\-][^\s/?#@\\]*@)?(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?\/[^\s\\]+|[A-Za-z0-9._][A-Za-z0-9._-]*@[A-Za-z0-9.][A-Za-z0-9.-]*:[^\s\\]+)$/;

export const GIT_CLONE_URL_MESSAGE =
  'Give a clone URL: https://host/owner/repo.git, ssh://git@host/owner/repo.git or git@host:owner/repo.git';

/**
 * A clone URL under {@link GIT_CLONE_URL}, refused with its sentence: the one
 * rule the console's routes and a Project config's `git:` source both apply.
 */
export const gitCloneUrlSchema = z
  .string()
  .regex(GIT_CLONE_URL, GIT_CLONE_URL_MESSAGE)
  .refine((url) => cloneUrlDial(url) !== null, GIT_CLONE_URL_MESSAGE);

/**
 * A `customGitUrl` as the update routes take it. `''` stays legal beside
 * `null`, as the unset spelling a client may already send; the deploy names
 * either as "no git URL is set".
 */
export const customGitUrlSchema = gitCloneUrlSchema
  .or(z.literal(''))
  .nullable();

/** Where a clone URL makes git connect, as {@link cloneUrlDial} reads it. */
export interface CloneDial {
  /**
   * What git dials with: curl for `http(s)://`, ssh for `ssh://` and the scp
   * form, git's own daemon protocol for `git://`.
   */
  readonly transport: 'http' | 'ssh' | 'git';
  /** Lower-cased, and an IPv6 literal without its brackets. */
  readonly host: string;
  /** The URL's own, or the transport's default. */
  readonly port: number;
}

const DEFAULT_PORT = { http: 80, https: 443, ssh: 22, git: 9418 } as const;

/**
 * `scheme://[userinfo@]host[:port]` and whatever follows. The userinfo holds no
 * `@`, so the authority has one and both parsers split it there; the host is
 * the {@link GIT_CLONE_URL} host and nothing else.
 */
const URL_FORM =
  /^(https?|ssh|git):\/\/(?:([^/?#@]*)@)?([A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?(?:[/?#]|$)/i;

/** `user@host:path`, git's scp form, as {@link GIT_CLONE_URL} admits it. */
const SCP_FORM = /^[A-Za-z0-9._][A-Za-z0-9._-]*@([A-Za-z0-9.][A-Za-z0-9.-]*):/;

/**
 * Whitespace, a control character or a backslash anywhere. WHATWG drops a tab
 * or a newline and reads a backslash as `/` in an http(s) URL; curl keeps
 * both, so `http://example.com\@127.0.0.1/` is `example.com` to one and
 * `127.0.0.1` to the other.
 */
// eslint-disable-next-line no-control-regex -- control characters are what this refuses
const AMBIGUOUS = /[\s\x00-\x1f\x7f\\]/;

/**
 * The transport, host and port git dials for a clone URL, or `null` when this
 * cannot say for certain which host that is.
 *
 * **Refuse rather than guess.** The address check reads the host here and git
 * reads it with curl or ssh, so every string the two might read differently
 * is `null`: whitespace, a control character or a backslash anywhere; a
 * second `@`; a host with a `%`, a non-ASCII letter or a trailing dot (curl
 * strips the dot, so a pin for the dotted name would not match); and an
 * http(s) host WHATWG rewrites to another (`2130706433`, `0x7f.1`, a
 * compressible IPv6 literal), checked by asking `URL` itself. A connection's
 * base URL (`https://gitlab.example.com`) reads the same way, with no path.
 */
export function cloneUrlDial(url: string): CloneDial | null {
  if (AMBIGUOUS.test(url)) return null;

  const scp = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? null : SCP_FORM.exec(url);
  const found = scp ? null : URL_FORM.exec(url);
  const written = scp?.[1] ?? found?.[3];
  if (!written || written.endsWith('.')) return null;

  if (found?.[2]?.startsWith('-')) return null;
  const scheme = scp
    ? 'ssh'
    : (found?.[1]?.toLowerCase() as keyof typeof DEFAULT_PORT);
  const port = found?.[4] ? Number(found[4]) : DEFAULT_PORT[scheme];
  if (port < 1 || port > 65535) return null;

  if (!scp) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.hostname.toLowerCase() !== written.toLowerCase()) return null;
  }

  return {
    transport: scheme === 'https' ? 'http' : scheme,
    host: written.replace(/^\[|\]$/g, '').toLowerCase(),
    port,
  };
}

/**
 * The host a clone URL makes git dial, as {@link cloneUrlDial} reads it, or
 * `''` when it reads none. Read by the address check a clone on the platform
 * host gets, where `''` passes no check, so a URL this cannot read is refused
 * rather than dialled.
 */
export function cloneUrlHost(url: string): string {
  return cloneUrlDial(url)?.host ?? '';
}

import { updateApplicationSchema } from '../../src/applications/dto/application.dto';
import { updateComposeSchema } from '../../src/compose/dto/compose.dto';
import {
  cloneUrlDial,
  cloneUrlHost,
  customGitUrlSchema,
} from '../../src/git-providers/git-clone-url';

/**
 * The `git` source's clone URL is checked for shape: `not a url` was
 * saved with "The next Deployment clones it".
 */
describe('customGitUrlSchema', () => {
  it.each([
    'https://git.example.com/acme/api.git',
    'http://git.internal/acme/api',
    'https://deploy:token@git.example.com/a/b.git',
    'ssh://git@git.example.com:2222/acme/api.git',
    'git://git.example.com/acme/api.git',
    'git@github.com:acme/api.git',
    'deploy@10.0.0.7:repos/api.git',
  ])('takes %s', (url) => {
    expect(customGitUrlSchema.safeParse(url).success).toBe(true);
  });

  it.each([
    'not a url',
    'github.com/acme/api',
    'https://git.example.com',
    'ftp://git.example.com/acme/api.git',
    'git@github.com',
    ' https://git.example.com/acme/api.git',
    'file:///etc/cloudgate/applications/other/code',
    // A leading `-` is read by git or ssh as an option, whatever form
    // follows it and wherever it sits: the scp form's user or host, an
    // `ssh://` URL's user or host.
    '-oProxyCommand=touch@host:x',
    '--upload-pack=touch@host:x',
    'git@-oProxyCommand=touch:x',
    'git@-host.example.com:x',
    'ssh://-oProxyCommand=touch/acme/api.git',
    'ssh://git@-oProxyCommand=touch/acme/api.git',
    'ssh://-oProxyCommand=touch@host/acme/api.git',
    'https://-host.example.com/acme/api.git',
  ])('refuses %s', (url) => {
    expect(customGitUrlSchema.safeParse(url).success).toBe(false);
  });

  it('keeps null and the empty string as unset', () => {
    expect(customGitUrlSchema.safeParse(null).success).toBe(true);
    expect(customGitUrlSchema.safeParse('').success).toBe(true);
  });

  it('is the rule on both update routes that take a clone URL', () => {
    expect(
      updateApplicationSchema.safeParse({ customGitUrl: 'not a url' }).success,
    ).toBe(false);
    expect(
      updateComposeSchema.safeParse({ customGitUrl: 'not a url' }).success,
    ).toBe(false);
  });
});

/**
 * A clone on the platform host is checked by the host `cloneUrlHost` reads
 * and dialled by git, which hands an http(s) URL to curl and an ssh one to
 * ssh. Where the two parsers could read a different host out of one string,
 * the check vouched for a host git never dialled: `http://example.com\@127.0.0.1/`
 * is `example.com` to WHATWG (a backslash ends a special URL's authority) and
 * `127.0.0.1` to curl (the backslash is userinfo). Each of these is refused,
 * by the save rule and by the reader the check uses, rather than guessed at.
 */
describe('cloneUrlDial', () => {
  it.each([
    ['http://example.com\\@127.0.0.1:4000/x.git', 'a backslash before an @'],
    ['http://example.com\\/x.git', 'a backslash in the authority'],
    ['https://git.example.com/acme\\web.git', 'a backslash in the path'],
    ['http://a@b@127.0.0.1/x.git', 'two @ in the authority'],
    ['http://127.0.0.%31/x.git', 'a percent-encoded host'],
    ['http://git.example.com%40127.0.0.1/x.git', 'a percent-encoded @'],
    ['http://git.exa mple.com/x.git', 'a space in the host'],
    ['http://git.example.com\t/x.git', 'a tab in the host'],
    ['http://git.example.com/x\u0001.git', 'a control character'],
    ['http://2130706433/x.git', 'a host WHATWG rewrites to another'],
    ['http://0x7f.1/x.git', 'a hexadecimal IPv4 spelling'],
    ['http://git.example.com./x.git', 'a trailing dot curl strips'],
    ['http://gït.example.com/x.git', 'a non-ASCII host'],
    ['ssh://git@git.example.com\\@10.0.0.1/x.git', 'a backslash in an ssh URL'],
    ['git@git.example.com\\@10.0.0.1:x.git', 'a backslash in the scp form'],
  ])('reads no host out of %s (%s)', (url) => {
    expect(cloneUrlDial(url)).toBeNull();
    expect(cloneUrlHost(url)).toBe('');
    expect(customGitUrlSchema.safeParse(url).success).toBe(false);
  });

  it.each([
    [
      'https://deploy:t%40k@git.example.com/a/b.git',
      { transport: 'http', host: 'git.example.com', port: 443 },
    ],
    [
      'http://Git.Example.com:8080/a/b.git',
      { transport: 'http', host: 'git.example.com', port: 8080 },
    ],
    [
      'https://[2001:db8::1]/a/b.git',
      { transport: 'http', host: '2001:db8::1', port: 443 },
    ],
    [
      'ssh://git@git.example.com:2222/acme/api.git',
      { transport: 'ssh', host: 'git.example.com', port: 2222 },
    ],
    [
      'git@github.com:acme/api.git',
      { transport: 'ssh', host: 'github.com', port: 22 },
    ],
    [
      'git://git.example.com/acme/api.git',
      { transport: 'git', host: 'git.example.com', port: 9418 },
    ],
    // A connection's base URL, which has no repository path of its own.
    [
      'https://gitlab.example.com',
      { transport: 'http', host: 'gitlab.example.com', port: 443 },
    ],
  ])('reads %s as the host and port git dials', (url, dial) => {
    expect(cloneUrlDial(url)).toEqual(dial);
  });
});

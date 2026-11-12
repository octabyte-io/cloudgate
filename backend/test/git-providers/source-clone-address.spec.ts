import { BadRequestException } from '@nestjs/common';
import type { CloneSource } from '../../src/git-providers/source-clone.service';
import { SourceCloneService } from '../../src/git-providers/source-clone.service';
import type { GiteaService } from '../../src/git-providers/strategies/gitea/gitea.service';
import type { GithubService } from '../../src/git-providers/strategies/github/github.service';
import type { GitlabService } from '../../src/git-providers/strategies/gitlab/gitlab.service';
import { PLATFORM_HOST_CLONE_REFUSED_CODE } from '../../src/git-providers/platform-host-clone';
import {
  OUTBOUND_ADDRESS_REFUSED_CODE,
  outboundAddressRefused,
} from '../../src/outbound/outbound-address-guard';
import type {
  OutboundAddressGuard,
  OutboundScope,
} from '../../src/outbound/outbound-address-guard';
import { publicAddressOf } from '../../src/outbound/outbound-address';
import type { AddressResolver } from '../../src/outbound/outbound-address';

/**
 * A clone that runs on the platform host dials the repository's host from
 * that box, so a customer's clone URL — a plain git URL, or the base URL of
 * their Gitea or GitLab connection — must not point it at loopback, a private
 * range or the metadata address, the rule `OutboundAddressGuard`
 * applies to every other dial a customer chooses the host of. The refusal is
 * the guard's own, naming the field the host came from, and it comes before
 * any program exists to run.
 *
 * A clone on a customer's own Server dials from their machine, onto their
 * network, and is not checked. GitHub and Bitbucket clones dial their own
 * fixed hosts.
 */
describe('SourceCloneService.cloneProgram, on where a clone on the platform host may dial', () => {
  const resolve: AddressResolver = (host) => {
    const table: Record<string, string[]> = {
      'git.example.com': ['93.184.216.34'],
      'internal.example.com': ['10.0.0.5'],
    };
    const found = table[host];
    return found
      ? Promise.resolve(found)
      : Promise.reject(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }));
  };

  /**
   * The guard as every Service here sees it: the customer's, so not exempt.
   * The exemption, and the dial-time pinning, are the guard's own suite's
   * (`outbound-address-guard.spec.ts`); what is in question here is which
   * host, field and place a clone asks it about, and when.
   */
  const asked: OutboundScope[] = [];
  /** A Service of the instance organization, whose dials are exempt (ADR-0013). */
  const INSTANCE_SERVICE = 'svc_instance';
  const guard = {
    addressToDial: async (host: string, scope: OutboundScope) => {
      asked.push(scope);
      if (
        'serviceId' in scope.place &&
        scope.place.serviceId === INSTANCE_SERVICE
      ) {
        return host;
      }
      const address = await publicAddressOf(host, resolve);
      if (address === null) throw outboundAddressRefused(scope.field);
      return address;
    },
    actsForInstance: (scope: OutboundScope) => {
      asked.push(scope);
      return Promise.resolve(
        'serviceId' in scope.place &&
          scope.place.serviceId === INSTANCE_SERVICE,
      );
    },
  } as unknown as OutboundAddressGuard;

  beforeEach(() => {
    asked.length = 0;
  });

  const clones = (urls: { gitlabUrl?: string; giteaUrl?: string } = {}) =>
    new SourceCloneService(
      {
        getGithubToken: () => Promise.resolve('ghs'),
      } as unknown as GithubService,
      {
        refreshToken: () =>
          Promise.resolve({
            gitlabUrl: urls.gitlabUrl ?? 'https://gitlab.com',
            accessToken: 'glpat',
          }),
      } as unknown as GitlabService,
      {
        refreshToken: () =>
          Promise.resolve({
            giteaUrl: urls.giteaUrl ?? 'https://gitea.com',
            accessToken: 'gt',
          }),
      } as unknown as GiteaService,
      guard,
    );

  const source = (overrides: Partial<CloneSource>): CloneSource =>
    ({
      appName: 'web-app',
      sourceType: 'git',
      enableSubmodules: false,
      customGitUrl: 'https://git.example.com/acme/web.git',
      customGitBranch: 'main',
      gitlabOwner: 'acme',
      gitlabRepository: 'web',
      gitlabBranch: 'main',
      gitlabPathNamespace: 'acme/web',
      giteaOwner: 'acme',
      giteaRepository: 'web',
      giteaBranch: 'main',
      gitlab: { gitProviderId: 'gp_gitlab' },
      gitea: { gitProviderId: 'gp_gitea' },
      ...overrides,
    }) as unknown as CloneSource;

  const onPlatformHost = { serverId: null, serviceId: 'svc_customer' };

  async function refusalOf(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      if (!(error instanceof BadRequestException)) throw error;
      return error.getResponse() as { code: string; field: string };
    }
    throw new Error('expected a refusal, and the clone was emitted');
  }

  it.each([
    [
      'a URL WHATWG and curl read different hosts out of',
      'http://git.example.com\\@127.0.0.1:4000/acme/web.git',
    ],
    ['an http URL to loopback', 'http://127.0.0.1:3000/acme/web.git'],
    ['an https URL to the metadata address', 'https://169.254.169.254/x/y.git'],
    ['an ssh URL to a private range', 'ssh://git@192.168.1.10/acme/web.git'],
    ['an scp-form URL to a private range', 'git@10.1.2.3:acme/web.git'],
    [
      'a name that lands in a private range',
      'https://internal.example.com/a/b.git',
    ],
  ])('refuses %s, naming customGitUrl', async (_what, customGitUrl) => {
    const refusal = await refusalOf(
      clones().cloneProgram(source({ customGitUrl }), '/out', {
        on: onPlatformHost,
      }),
    );

    expect(refusal).toMatchObject({
      code: OUTBOUND_ADDRESS_REFUSED_CODE,
      field: 'customGitUrl',
    });
    expect(asked.map((scope) => scope.place)).toContainEqual({
      serviceId: 'svc_customer',
    });
  });

  it.each([
    ['gitlab', { gitlabUrl: 'http://10.0.0.9' }, 'gitlabUrl', 'gp_gitlab'],
    ['gitea', { giteaUrl: 'http://127.0.0.1:3000' }, 'giteaUrl', 'gp_gitea'],
  ] as const)(
    "refuses a %s connection's private base URL, naming its field, as that connection's dial",
    async (sourceType, urls, field, gitProviderId) => {
      const refusal = await refusalOf(
        clones(urls).cloneProgram(source({ sourceType }), '/out', {
          on: onPlatformHost,
        }),
      );

      expect(refusal).toMatchObject({
        code: OUTBOUND_ADDRESS_REFUSED_CODE,
        field,
      });
      expect(asked.map((scope) => scope.place)).toContainEqual({
        gitProviderId,
      });
    },
  );

  it('clones a public repository on the platform host', async () => {
    const { command } = await clones().cloneProgram(source({}), '/out', {
      on: onPlatformHost,
    });

    expect(command).toContain('git.example.com/acme/web.git');
  });

  it("clones a private address on a customer's own Server", async () => {
    const { command } = await clones().cloneProgram(
      source({ customGitUrl: 'https://10.1.2.3/acme/web.git' }),
      '/out',
      { on: { serverId: 'srv_customer', serviceId: 'svc_customer' } },
    );

    expect(command).toContain('10.1.2.3');
    expect(asked).toEqual([]);
  });

  /** The program's words with shell-quote's escapes taken off. */
  const unquoted = (command: string) => command.replace(/\\/g, '');

  /**
   * The address the guard checked is the one git dials: curl is handed it for
   * the URL's host and port, so git makes no lookup of its own for a rebind to
   * answer differently, and follows no redirect to a host nobody checked.
   */
  it('pins an http clone on the platform host to the checked address and follows no redirect', async () => {
    const { command } = await clones().cloneProgram(source({}), '/out', {
      on: onPlatformHost,
    });

    expect(unquoted(command)).toContain(
      'git -c protocol.file.allow=never -c http.curloptResolve=git.example.com:443:93.184.216.34 -c http.followRedirects=false clone',
    );
  });

  it.each([
    ['gitlab', { gitlabUrl: 'https://git.example.com' }],
    ['gitea', { giteaUrl: 'https://git.example.com:8443' }],
  ] as const)(
    "pins a %s clone to its connection's checked address",
    async (sourceType, urls) => {
      const { command } = await clones(urls).cloneProgram(
        source({ sourceType }),
        '/out',
        { on: onPlatformHost },
      );

      expect(unquoted(command)).toMatch(
        /-c http\.curloptResolve=git\.example\.com:(443|8443):93\.184\.216\.34 -c http\.followRedirects=false clone/,
      );
    },
  );

  it('connects an ssh clone on the platform host to the checked address', async () => {
    const { command } = await clones().cloneProgram(
      source({
        customGitUrl: 'ssh://git@git.example.com:2222/acme/web.git',
        customGitSSHKey: { privateKey: 'KEY' },
      } as Partial<CloneSource>),
      '/out',
      { on: onPlatformHost },
    );

    expect(command).toContain('ssh-keyscan -p 2222 93.184.216.34 ');
    expect(command).toContain('-o HostName=93.184.216.34');
    // The name git hands ssh is never looked up: ssh connects to the address.
    expect(command).not.toContain('ssh-keyscan -p 2222 git.example.com');
  });

  it('refuses a git:// URL on the platform host, which nothing can pin', async () => {
    const refusal = await refusalOf(
      clones().cloneProgram(
        source({ customGitUrl: 'git://git.example.com/acme/web.git' }),
        '/out',
        { on: onPlatformHost },
      ),
    );

    expect(refusal).toMatchObject({
      code: PLATFORM_HOST_CLONE_REFUSED_CODE,
      field: 'customGitUrl',
    });
  });

  /**
   * `--recurse-submodules` has git dial every URL in the repository's own
   * `.gitmodules`, which the customer writes and nothing checks — GitHub and
   * Bitbucket repositories included.
   */
  it.each(['git', 'github', 'gitlab', 'gitea', 'bitbucket'] as const)(
    'refuses submodules for a %s clone on the platform host',
    async (sourceType) => {
      const refusal = await refusalOf(
        clones().cloneProgram(
          source({
            sourceType,
            enableSubmodules: true,
            owner: 'acme',
            repository: 'web',
            branch: 'main',
            bitbucketOwner: 'acme',
            bitbucketRepository: 'web',
            bitbucketBranch: 'main',
            github: { githubId: 'gh' },
            bitbucket: { bitbucketUsername: 'u', apiToken: 't' },
          } as unknown as Partial<CloneSource>),
          '/out',
          { on: onPlatformHost },
        ),
      );

      expect(refusal).toMatchObject({
        code: PLATFORM_HOST_CLONE_REFUSED_CODE,
        field: 'enableSubmodules',
      });
    },
  );

  it("keeps an instance organization's clone on the platform host as it was", async () => {
    const { command } = await clones().cloneProgram(
      source({
        customGitUrl: 'http://10.0.0.5/acme/web.git',
        enableSubmodules: true,
      }),
      '/out',
      { on: { serverId: null, serviceId: INSTANCE_SERVICE } },
    );

    expect(command).toContain('--recurse-submodules');
    // Not pinned, and redirects are git's default.
    expect(command).not.toContain('curloptResolve');
    expect(command).not.toContain('followRedirects');
  });

  it("neither pins nor refuses submodules on a customer's own Server", async () => {
    const { command } = await clones().cloneProgram(
      source({ enableSubmodules: true }),
      '/out',
      { on: { serverId: 'srv_customer', serviceId: 'svc_customer' } },
    );

    expect(command).toContain('--recurse-submodules');
    expect(command).not.toContain('curloptResolve');
  });
});

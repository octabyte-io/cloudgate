import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { parse } from 'yaml';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { DockerResourceService } from '../../src/settings/docker-resource.service';
import {
  withDnsChallengeResolver,
  withDnsCredentials,
  withoutEnvKeys,
} from '../../src/settings/dns-challenge.utils';
import { TraefikFilesService } from '../../src/settings/traefik-files.service';

/**
 * The DNS-challenge's two writes, as pure functions and at the two services that apply
 * them: the DNS-01 resolver in a machine's `traefik.yml`, and the DNS
 * credentials in its Traefik env.
 *
 * The expected YAML is written out by hand rather than built from the
 * function's own output, and the storage path is the literal every install
 * writes (`server-setup.ts`' `ACME_STORAGE`).
 */

const STORAGE = '/etc/cloudgate/traefik/dynamic/acme.json';

const WITH_LETSENCRYPT = `# the operator's own note
entryPoints:
  web:
    address: ":80"
certificatesResolvers:
  letsencrypt:
    acme:
      email: ops@example.com
      storage: ${STORAGE}
      httpChallenge:
        entryPoint: web
`;

type Resolvers = Record<
  string,
  {
    acme: {
      email?: string;
      storage?: string;
      dnsChallenge?: { provider: string };
      httpChallenge?: { entryPoint: string };
    };
  }
>;

const resolversIn = (yaml: string): Resolvers =>
  (parse(yaml) as { certificatesResolvers: Resolvers }).certificatesResolvers;

describe('withDnsChallengeResolver', () => {
  it('adds letsencrypt-dns beside letsencrypt with its email and storage', () => {
    const written = withDnsChallengeResolver(WITH_LETSENCRYPT, 'cloudflare');

    expect(resolversIn(written)).toEqual({
      letsencrypt: {
        acme: {
          email: 'ops@example.com',
          storage: STORAGE,
          httpChallenge: { entryPoint: 'web' },
        },
      },
      'letsencrypt-dns': {
        acme: {
          email: 'ops@example.com',
          storage: STORAGE,
          dnsChallenge: { provider: 'cloudflare' },
        },
      },
    });
    // The operator's comment survives the write.
    expect(written).toContain("# the operator's own note");
  });

  it('replaces the provider of a resolver already there', () => {
    const once = withDnsChallengeResolver(WITH_LETSENCRYPT, 'cloudflare');
    const twice = withDnsChallengeResolver(once, 'route53');

    expect(resolversIn(twice)['letsencrypt-dns']).toEqual({
      acme: {
        email: 'ops@example.com',
        storage: STORAGE,
        dnsChallenge: { provider: 'route53' },
      },
    });
  });

  it('removes the resolver and leaves letsencrypt as it was', () => {
    const added = withDnsChallengeResolver(WITH_LETSENCRYPT, 'cloudflare');
    const removed = withDnsChallengeResolver(added, null);

    expect(resolversIn(removed)).toEqual(resolversIn(WITH_LETSENCRYPT));
  });

  it('refuses with 409 a config that has no letsencrypt resolver to copy from', () => {
    expect(() =>
      withDnsChallengeResolver(
        'entryPoints:\n  web:\n    address: ":80"\n',
        'cloudflare',
      ),
    ).toThrow(ConflictException);
  });
});

describe('withDnsCredentials', () => {
  it('appends the credentials, and a credential wins over a same-named key', () => {
    expect(
      withDnsCredentials(['A=1', 'CF_DNS_API_TOKEN=old', 'B=2'], {
        CF_DNS_API_TOKEN: 'new',
        CF_ZONE_API_TOKEN: 'z#1=${{x}}',
      }),
    ).toEqual([
      'A=1',
      'B=2',
      'CF_DNS_API_TOKEN=new',
      // Carried verbatim: no dotenv `#` and no `${{…}}` resolution.
      'CF_ZONE_API_TOKEN=z#1=${{x}}',
    ]);
  });

  it('returns the env unchanged when the machine has no credentials', () => {
    expect(withDnsCredentials(['A=1'], undefined)).toEqual(['A=1']);
  });
});

describe('withoutEnvKeys', () => {
  it('drops an entry by its key and never by a prefix or a value', () => {
    expect(
      withoutEnvKeys(['TOKEN=1', 'TOKEN_2=2', 'OTHER=TOKEN=3'], ['TOKEN']),
    ).toEqual(['TOKEN_2=2', 'OTHER=TOKEN=3']);
  });
});

describe('DockerResourceService', () => {
  it('withholds the named keys from the env it reads, before the lines are joined', async () => {
    const execAsync = jest
      .fn()
      .mockResolvedValueOnce({ stdout: 'service\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: JSON.stringify(['A=1', 'CF_DNS_API_TOKEN=secret\nB=forged']),
        stderr: '',
        exitCode: 0,
      });
    const service = new DockerResourceService({
      execAsync,
    } as unknown as RemoteExecService);

    const env = await service.readEnvironmentVariables(
      'cloudgate-traefik',
      null,
      ['CF_DNS_API_TOKEN'],
    );

    expect(env).toBe('A=1');
  });
});

describe('TraefikFilesService', () => {
  let root: string;
  let service: TraefikFilesService;
  const onDisk = () => fs.readFileSync(path.join(root, 'traefik.yml'), 'utf8');

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-dns-challenge-')),
    );
    service = new TraefikFilesService({} as RemoteExecService, () => root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes and removes the resolver in the machine’s traefik.yml', async () => {
    fs.writeFileSync(path.join(root, 'traefik.yml'), WITH_LETSENCRYPT);

    await service.writeDnsChallengeResolver('cloudflare', null);
    expect(resolversIn(onDisk())['letsencrypt-dns']?.acme.dnsChallenge).toEqual(
      { provider: 'cloudflare' },
    );

    await service.writeDnsChallengeResolver(null, null);
    expect(resolversIn(onDisk())).not.toHaveProperty('letsencrypt-dns');
  });

  it('refuses a write on a machine with no traefik.yml, and a removal there is already done', async () => {
    await expect(
      service.writeDnsChallengeResolver('cloudflare', null),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.writeDnsChallengeResolver(null, null),
    ).resolves.toBeUndefined();
    // Nothing was written on the way to being refused.
    expect(fs.existsSync(path.join(root, 'traefik.yml'))).toBe(false);
  });

  it('moves the DNS resolver’s ACME email with letsencrypt’s', async () => {
    fs.writeFileSync(path.join(root, 'traefik.yml'), WITH_LETSENCRYPT);
    await service.writeDnsChallengeResolver('cloudflare', null);

    service.updateLetsEncryptEmail('new@example.com');

    const resolvers = resolversIn(onDisk());
    expect(resolvers.letsencrypt.acme.email).toBe('new@example.com');
    expect(resolvers['letsencrypt-dns'].acme.email).toBe('new@example.com');
  });

  it('moves letsencrypt’s email alone on a machine with no DNS resolver', () => {
    fs.writeFileSync(path.join(root, 'traefik.yml'), WITH_LETSENCRYPT);

    service.updateLetsEncryptEmail('new@example.com');

    expect(resolversIn(onDisk())).toEqual({
      letsencrypt: {
        acme: {
          email: 'new@example.com',
          storage: STORAGE,
          httpChallenge: { entryPoint: 'web' },
        },
      },
    });
  });
});

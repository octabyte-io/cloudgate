import { elideEncodedPayloads } from '../../src/common/logging/error-payloads';
import type { Registry } from '../../src/registries/registry.schema';
import {
  dockerLoginCommand,
  getAuthConfig,
  getImageName,
  getRegistryTag,
} from '../../src/registries/registry.utils';
import { SHELL_PAYLOAD } from '../utils/shell-safety';

const baseRegistry: Registry = {
  registryId: 'reg_1',
  name: 'docker-hub',
  imagePrefix: null,
  username: 'octabyte',
  password: 'registry-secret-token',
  url: '',
  registryType: 'cloud',
  createdAt: '2026-07-17T00:00:00.000Z',
  organizationId: 'org_1',
};

describe('getAuthConfig', () => {
  it('builds the dockerode auth object for Docker Hub (empty url)', () => {
    expect(getAuthConfig(baseRegistry)).toEqual({
      username: 'octabyte',
      password: 'registry-secret-token',
      serveraddress: '',
    });
  });

  it('builds the dockerode auth object for a self-hosted registry', () => {
    expect(
      getAuthConfig({
        ...baseRegistry,
        url: 'registry.example.com:5000',
        registryType: 'selfHosted',
      }),
    ).toEqual({
      username: 'octabyte',
      password: 'registry-secret-token',
      serveraddress: 'registry.example.com:5000',
    });
  });
});

/**
 * This builder used to take the password and `shEscape` it into the
 * pipeline; it now takes the *name of the variable holding it*, and the value
 * never enters a command string at all.
 *
 * There was no unit spec for it before — the shape was pinned only through
 * `error-payloads.spec.ts`, which asserted the *mask* over it, and through the
 * two call sites' own specs. That is exactly the arrangement in which a
 * credential builder can change meaning without anything naming the change, so
 * the property gets its own describe.
 */
describe('dockerLoginCommand', () => {
  it('references the holder and escapes the registry and the user', () => {
    expect(
      dockerLoginCommand(
        'registry.acme.dev',
        'pusher',
        'CG_REGISTRY_PASSWORD_0',
      ),
    ).toBe(
      `printf %s "$CG_REGISTRY_PASSWORD_0" | docker login 'registry.acme.dev' -u 'pusher' --password-stdin`,
    );
  });

  /**
   * Double quotes, not single, and not `quote()`d — `build-env.ts`'s
   * `envFlagWord` records the same trap. Single quotes or an escaped `$` would
   * pass `docker login` the nine literal characters of the holder's name, and
   * the login would fail with a message about a wrong password.
   */
  it('leaves the expansion live, which is the whole mechanism', () => {
    const command = dockerLoginCommand('ghcr.io', 'acme', 'CG_HOLDER');

    expect(command).toContain('"$CG_HOLDER"');
    expect(command).not.toContain("'$CG_HOLDER'");
    expect(command).not.toContain('\\$');
  });

  /**
   * The two operator-controlled words are still the ones that were always
   * escaped: `registry.url` carries a charset (`registryUrlSchema`) and
   * `username` deliberately carries none, and both reach a shell.
   */
  it('keeps the url and the username shell-inert', () => {
    const command = dockerLoginCommand(
      `ghcr.io${SHELL_PAYLOAD}`,
      `acme${SHELL_PAYLOAD}`,
      'CG_HOLDER',
    );

    // Everything hostile is inside a single-quoted run, so the only words the
    // shell sees are `printf`, `%s`, the expansion, `docker`, `login`, `-u` and
    // the flag.
    expect(command).not.toMatch(/[;&|][^']*$/);
    expect(command.split("'").length % 2).toBe(1);
  });

  it('says nothing for a missing url or user, as it always did', () => {
    expect(dockerLoginCommand(null, undefined, 'CG_HOLDER')).toBe(
      `printf %s "$CG_HOLDER" | docker login '' -u '' --password-stdin`,
    );
  });

  /**
   * The point of the change, stated where the builder lives: there is nothing
   * in the emitted string for `STDIN_CREDENTIAL` to elide, so the journalled
   * copy of a refused login is byte-identical to the command — which keeps the
   * holder's *name* in the diagnosis, where `'[credential elided]'` used to
   * stand.
   */
  it('emits a command the journal can print unchanged', () => {
    const command = dockerLoginCommand('ghcr.io', 'acme', 'CG_HOLDER');

    expect(elideEncodedPayloads(command)).toBe(command);
  });
});

describe('getRegistryTag', () => {
  it('prefixes with the lowercased username for Docker Hub (empty url)', () => {
    expect(
      getRegistryTag(
        { ...baseRegistry, username: 'OctaByte' },
        'my-app:latest',
      ),
    ).toBe('octabyte/my-app:latest');
  });

  it('prefers the imagePrefix over the username', () => {
    expect(
      getRegistryTag(
        { ...baseRegistry, imagePrefix: 'Team-X' },
        'my-app:latest',
      ),
    ).toBe('team-x/my-app:latest');
  });

  it('fully qualifies the tag with the registry url and keeps only the repository name', () => {
    expect(
      getRegistryTag(
        { ...baseRegistry, url: 'registry.example.com:5000' },
        'docker.io/myuser/myrepo:tag',
      ),
    ).toBe('registry.example.com:5000/octabyte/myrepo:tag');
  });
});

describe('getImageName', () => {
  it('defaults to appName:latest when no registry is involved', () => {
    expect(getImageName({ appName: 'api' })).toBe('api:latest');
  });

  it('uses the docker image verbatim for docker-sourced applications', () => {
    expect(
      getImageName({
        appName: 'api',
        dockerImage: 'nginx:1.27',
        registry: baseRegistry,
      }),
    ).toBe('nginx:1.27');
  });

  it('resolves the registry tag for appName:latest when pushing through a registry', () => {
    expect(
      getImageName({
        appName: 'api',
        registry: { ...baseRegistry, url: 'registry.example.com' },
      }),
    ).toBe('registry.example.com/octabyte/api:latest');
  });
});

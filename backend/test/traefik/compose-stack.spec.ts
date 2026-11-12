import { execFileSync } from 'node:child_process';
import { quote } from 'shell-quote';
import { parse } from 'yaml';
import { cloudgateDirectoryOn } from '../../src/common/config/cloudgate-directory';
import type {
  ComposeDomain,
  DeployableComposeSource,
} from '../../src/compose/compose.types';
import {
  composeStackRoutingCommand,
  composeTeardownCommand,
  getBuildComposeCommand,
} from '../../src/compose/compose.utils';
import {
  composeStackServiceHost,
  createComposeStackTraefikConfig,
} from '../../src/traefik/config/compose-stack';
import { composeStackConfigName } from '../../src/traefik/config/names';

// A `stack` Compose's Domains are routed by a file-provider config, the
// way an Application's are, because Swarm keeps `deploy.labels` on the service
// and the `docker` provider reads containers only. These pin the builder, the
// deploy's write of it, and the Delete's removal of it.

const domain = (overrides: Partial<ComposeDomain> = {}): ComposeDomain => ({
  host: 'blog.example.com',
  serviceName: 'wordpress',
  port: 8080,
  https: false,
  uniqueConfigKey: 7,
  ...overrides,
});

const stack = (
  overrides: Partial<DeployableComposeSource> = {},
): DeployableComposeSource => ({
  appName: 'wp-stack',
  composeType: 'stack',
  sourceType: 'github',
  composePath: './docker-compose.yml',
  command: '',
  isolatedDeployment: false,
  env: null,
  serverId: null,
  environment: { env: null, project: { env: null } },
  ...overrides,
});

const ROUTING_FILE = `${cloudgateDirectoryOn(null)}/traefik/dynamic/compose+wp-stack.yml`;

describe('createComposeStackTraefikConfig', () => {
  it('routes each Domain to `<appName>_<service>` on its port, with the Application router names', () => {
    const config = createComposeStackTraefikConfig('wp-stack', [
      domain({ https: true, certificateType: 'letsencrypt' }),
      domain({
        host: 'api.example.com',
        serviceName: 'api',
        port: null,
        uniqueConfigKey: 8,
        path: '/v1',
        stripPath: true,
      }),
    ]);

    expect(config.http?.routers).toEqual({
      'wp-stack-router-7': {
        rule: 'Host(`blog.example.com`)',
        service: 'wp-stack-service-7',
        middlewares: ['redirect-to-https'],
        entryPoints: ['web'],
      },
      'wp-stack-router-websecure-7': {
        rule: 'Host(`blog.example.com`)',
        service: 'wp-stack-service-7',
        middlewares: [],
        entryPoints: ['websecure'],
        tls: { certResolver: 'letsencrypt' },
      },
      'wp-stack-router-8': {
        rule: 'Host(`api.example.com`) && (PathPrefix(`/v1/`) || Path(`/v1`))',
        service: 'wp-stack-service-8',
        middlewares: ['stripprefix-wp-stack-8'],
        entryPoints: ['web'],
      },
    });
    expect(config.http?.services).toEqual({
      'wp-stack-service-7': {
        loadBalancer: {
          servers: [{ url: 'http://wp-stack_wordpress:8080' }],
          passHostHeader: true,
        },
      },
      'wp-stack-service-8': {
        loadBalancer: {
          servers: [{ url: 'http://wp-stack_api:80' }],
          passHostHeader: true,
        },
      },
    });
    expect(config.http?.middlewares).toEqual({
      'stripprefix-wp-stack-8': { stripPrefix: { prefixes: ['/v1'] } },
    });
  });

  it('never names a forward-auth gate, which a Compose Domain cannot have', () => {
    const config = createComposeStackTraefikConfig('wp-stack', [
      domain({ forwardAuthEnabled: true }),
    ]);
    expect(JSON.stringify(config)).not.toContain('forward-auth');
  });

  it('names the service by its stack, so two stacks’ `web` never meet', () => {
    expect(composeStackServiceHost('shop', 'web')).toBe('shop_web');
    expect(composeStackServiceHost('blog', 'web')).toBe('blog_web');
  });

  it('keeps the file out of any Application’s name', () => {
    // `+` is outside APP_NAME_REGEX, so `<appName>.yml` can never be this.
    expect(composeStackConfigName('wp-stack')).toBe('compose+wp-stack');
    expect(composeStackConfigName('wp-stack')).not.toMatch(/^[a-zA-Z0-9._-]+$/);
  });
});

describe('composeStackRoutingCommand', () => {
  it('writes the builder’s config, byte for byte, to the stack’s file', () => {
    const domains = [domain({ https: true, certificateType: 'letsencrypt' })];
    const command = composeStackRoutingCommand(stack(), domains);

    const encoded = /echo "([A-Za-z0-9+/=]+)" \| base64 -d > (\S+)/.exec(
      command,
    );
    expect(encoded?.[2]).toBe(quote([ROUTING_FILE]));
    const written = Buffer.from(encoded?.[1] ?? '', 'base64').toString('utf8');
    expect(parse(written)).toEqual(
      createComposeStackTraefikConfig('wp-stack', domains),
    );
    // A failed write fails the deploy rather than leaving it unrouted.
    expect(command).toContain('exit 1');
  });

  it('removes the file for a stack with no Domain, and for every docker-compose deploy', () => {
    const rm = `rm -f ${quote([ROUTING_FILE])}`;
    expect(composeStackRoutingCommand(stack(), [])).toBe(rm);
    expect(
      composeStackRoutingCommand(stack({ composeType: 'docker-compose' }), [
        domain(),
      ]),
    ).toBe(rm);
  });

  it('addresses a named Server’s own dynamic directory', () => {
    const command = composeStackRoutingCommand(
      stack({ serverId: 'srv-1' }),
      [],
    );
    expect(command).toBe(
      `rm -f ${quote([`${cloudgateDirectoryOn('srv-1')}/traefik/dynamic/compose+wp-stack.yml`])}`,
    );
  });
});

describe('getBuildComposeCommand', () => {
  it('writes a stack’s routing once the stack deploy has succeeded', () => {
    const command = getBuildComposeCommand(
      stack(),
      'services:\n  wordpress:\n    image: wordpress:6\n',
      [domain()],
    );
    const deployAt = command.indexOf('stack deploy');
    const routingAt = command.indexOf(`> ${quote([ROUTING_FILE])}`);
    expect(deployAt).toBeGreaterThan(-1);
    expect(routingAt).toBeGreaterThan(deployAt);
    // The converted file carries no Traefik label.
    expect(command).not.toContain('traefik.swarm.network');
    // And the whole script still parses as POSIX sh.
    expect(() => execFileSync('sh', ['-n', '-c', command])).not.toThrow();
  });
});

describe('composeTeardownCommand', () => {
  it('takes a stack’s routing file down with the rest of it', () => {
    expect(composeTeardownCommand(null, 'wp-stack', false)).toContain(
      `rm -f ${quote([ROUTING_FILE])}`,
    );
  });
});

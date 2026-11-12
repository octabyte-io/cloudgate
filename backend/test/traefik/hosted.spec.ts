import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';
import { runHostedTraefikConfig } from '../../src/commands/hosted-traefik-config';
import { REALTIME_GATEWAY_PATHS } from '../../src/realtime/gateway-paths';
import type { FileConfig } from '../../src/traefik/config/file-types';

/**
 * The Hosted instance's Traefik routing, as `deploy/install.sh` writes
 * it: the command's output, read back as YAML and asked where a request goes.
 */
const HOST = 'cloudgate.octabyte.app';
const CONSOLE = 'http://172.18.0.1:3000';
const API = 'http://172.18.0.1:4000';

function run(argv: string[]) {
  let out = '';
  const err: string[] = [];
  const code = runHostedTraefikConfig(argv, {
    out: (text) => (out += text),
    err: (line) => err.push(line),
  });
  return { code, out, err };
}

function written(): FileConfig {
  const result = run([
    '--host',
    HOST,
    '--console-url',
    CONSOLE,
    '--api-url',
    API,
  ]);
  expect(result.code).toBe(0);
  return parse(result.out) as FileConfig;
}

/**
 * Where Traefik sends a request: the matching routers on the entry point, the
 * longest rule first (Traefik's default priority), to its service's server.
 * The rules here use only Host, Path, PathPrefix, `&&`, `||` and parentheses.
 */
function upstream(
  config: FileConfig,
  entryPoint: 'web' | 'websecure',
  host: string,
  pathname: string,
): { url: string; router: string } | null {
  const routers = Object.entries(config.http?.routers ?? {})
    .filter(([, router]) => router.entryPoints?.includes(entryPoint))
    .sort(([, a], [, b]) => b.rule.length - a.rule.length);
  for (const [name, router] of routers) {
    const expression = router.rule
      .replace(/Host\(`([^`]*)`\)/g, (_, h: string) => String(h === host))
      .replace(/PathPrefix\(`([^`]*)`\)/g, (_, p: string) =>
        String(pathname.startsWith(p)),
      )
      .replace(/Path\(`([^`]*)`\)/g, (_, p: string) => String(pathname === p));
    if (evaluate(expression)) {
      const service = config.http?.services?.[router.service];
      return { url: service!.loadBalancer!.servers[0].url, router: name };
    }
  }
  return null;
}

/** A rule reduced to `true`/`false`, `&&`, `||` and parentheses, evaluated. */
function evaluate(expression: string): boolean {
  let e = expression.replace(/\s+/g, '');
  expect(e).toMatch(/^[truefals&|()]+$/);
  for (;;) {
    const next = e
      .replace(/\((true|false)\)/g, '$1')
      .replace(/(true|false)&&(true|false)/g, (_, a: string, b: string) =>
        String(a === 'true' && b === 'true'),
      )
      .replace(
        /(?<!&&)(true|false)\|\|(true|false)(?!&&)/g,
        (_, a: string, b: string) => String(a === 'true' || b === 'true'),
      );
    if (next === e) break;
    e = next;
  }
  if (e !== 'true' && e !== 'false') throw new Error(`cannot reduce ${e}`);
  return e === 'true';
}

describe('runHostedTraefikConfig', () => {
  it.each(REALTIME_GATEWAY_PATHS)('sends %s to the API on HTTPS', (gateway) => {
    expect(upstream(written(), 'websecure', HOST, gateway)?.url).toBe(API);
  });

  it.each([
    '/',
    '/sign-in',
    '/backend/projects',
    '/api/auth/get-session',
    '/terminals',
    '/listen-deployment/x',
  ])('sends %s to the console on HTTPS', (pathname) => {
    expect(upstream(written(), 'websecure', HOST, pathname)?.url).toBe(CONSOLE);
  });

  it('sends the Gateway’s calls straight to the API, as Settings > Web server does', () => {
    expect(
      upstream(written(), 'websecure', HOST, '/ai/my-model/v1/chat')?.url,
    ).toBe(API);
  });

  it('asks Let’s Encrypt for the certificate on every HTTPS router', () => {
    for (const router of Object.values(written().http!.routers!)) {
      if (!router.entryPoints!.includes('websecure')) continue;
      expect(router.tls).toEqual({ certResolver: 'letsencrypt' });
    }
  });

  it('answers plain HTTP only with the redirect to HTTPS', () => {
    for (const pathname of ['/', '/listen-deployment', '/ai/m/v1/x']) {
      const match = upstream(written(), 'web', HOST, pathname);
      expect(match).not.toBeNull();
      expect(written().http!.routers![match!.router].middlewares).toEqual([
        'redirect-to-https',
      ]);
    }
  });

  it('answers no other hostname', () => {
    expect(
      upstream(written(), 'websecure', 'evil.example.com', '/'),
    ).toBeNull();
  });

  it('names nothing Settings > Web server writes, so the two files never collide', () => {
    const names = [
      ...Object.keys(written().http!.routers!),
      ...Object.keys(written().http!.services!),
    ];
    for (const name of names) expect(name).toMatch(/^hosted-/);
  });

  it.each([
    [['--console-url', CONSOLE, '--api-url', API], /Missing --host/],
    [
      [
        '--host',
        'Host`) || Host(`x',
        '--console-url',
        CONSOLE,
        '--api-url',
        API,
      ],
      /not a lower-case hostname/,
    ],
    [
      ['--host', HOST, '--console-url', 'ftp://x', '--api-url', API],
      /--console-url .* not an http\(s\) origin/,
    ],
    [
      ['--host', HOST, '--console-url', CONSOLE, '--api-url', `${API}/path`],
      /--api-url .* not an http\(s\) origin/,
    ],
  ])('refuses %j with exit 2 and prints nothing', (argv, message) => {
    const result = run(argv);
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(result.err.join('\n')).toMatch(message);
  });
});

/**
 * The census that keeps the list honest: every `@WebSocketGateway` in the
 * backend is one of the paths the Hosted instance routes to the API, and every
 * listed path is a gateway. A seventh gateway left off the list would be sent
 * to the console on the Hosted instance and never connect.
 */
describe('REALTIME_GATEWAY_PATHS', () => {
  it('is exactly the paths the backend’s WebSocket gateways answer on', () => {
    const src = path.resolve(__dirname, '../../src');
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
          const text = fs.readFileSync(full, 'utf8');
          for (const match of text.matchAll(/@WebSocketGateway\(([^)]*)\)/g)) {
            const gateway = /path:\s*'([^']+)'/.exec(match[1]);
            if (!gateway)
              throw new Error(`${full}: a gateway with no literal path`);
            found.push(gateway[1]);
          }
        }
      }
    };
    walk(src);

    expect([...found].sort()).toEqual([...REALTIME_GATEWAY_PATHS].sort());
  });
});

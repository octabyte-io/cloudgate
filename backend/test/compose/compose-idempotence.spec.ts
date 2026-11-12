import {
  parseComposeFile,
  writeDomainsToCompose,
} from '../../src/compose/compose.utils';
import type {
  ComposeDomain,
  ComposeSpecSource,
} from '../../src/compose/compose.types';

// The converted file is re-converted in normal operation, so the
// conversion has to be idempotent. `ComposeService.readComposeFile` returns the
// stored `composeFile` column only for a `raw` source; for every git flavour it
// reads the path `getBuildComposeCommand` overwrote with the converted file on
// the first deploy, and `ComposeService.getConverted` feeds that back through
// `writeDomainsToCompose`. Before the fix the per-domain routing labels were the
// one unguarded insert in `addDomainsToComposeSpec`, so the Converted tab
// reported every router, service and middleware label twice.
//
// A separate file from `compose-domains.spec.ts` because every test here asks
// one question of a pair of outputs rather than an assertion of one, and the
// once/twice harness is the point.

const BASE_COMPOSE = `services:
  wordpress:
    image: wordpress:6
  db:
    image: mariadb:11
`;

const source = (
  overrides: Partial<ComposeSpecSource> = {},
): ComposeSpecSource => ({
  appName: 'wp-stack',
  composeType: 'docker-compose',
  isolatedDeployment: false,
  ...overrides,
});

const domain = (overrides: Partial<ComposeDomain> = {}): ComposeDomain => ({
  host: 'blog.example.com',
  serviceName: 'wordpress',
  port: 80,
  https: false,
  uniqueConfigKey: 1,
  ...overrides,
});

/**
 * The once-applied file and the same call fed its own output — the pair every
 * test in this file compares. Deploy and Converted tab differ by exactly this:
 * one runs on the author's file, the other on what the last deploy wrote.
 */
const passes = (
  compose: ComposeSpecSource,
  content: string,
  domains: ComposeDomain[],
) => {
  const once = writeDomainsToCompose(compose, content, domains);
  return { once, twice: writeDomainsToCompose(compose, once, domains) };
};

const labelsOf = (yaml: string, serviceName = 'wordpress') =>
  parseComposeFile(yaml)?.services?.[serviceName]?.labels;

const deployLabelsOf = (yaml: string, serviceName = 'wordpress') =>
  parseComposeFile(yaml)?.services?.[serviceName]?.deploy?.labels;

describe('writeDomainsToCompose applied to its own output', () => {
  it('returns the same file for a docker-compose stack with a plain http domain', () => {
    const { once, twice } = passes(source(), BASE_COMPOSE, [domain()]);

    // The hand-written list, not a recomputation: this is what the Converted
    // tab has to show after any number of deploys.
    expect(labelsOf(once)).toEqual([
      'traefik.enable=true',
      'traefik.docker.network=cloudgate-network',
      'traefik.http.routers.wp-stack-1-web.rule=Host(`blog.example.com`)',
      'traefik.http.routers.wp-stack-1-web.entrypoints=web',
      'traefik.http.services.wp-stack-1-web.loadbalancer.server.port=80',
      'traefik.http.routers.wp-stack-1-web.service=wp-stack-1-web',
    ]);
    expect(twice).toBe(once);
  });

  it('returns the same file for a stack row, which gets no labels at all', () => {
    const { once, twice } = passes(
      source({ composeType: 'stack' }),
      BASE_COMPOSE,
      [domain()],
    );

    // A stack is routed by the file provider, so neither block is written.
    expect(deployLabelsOf(once)).toBeUndefined();
    expect(labelsOf(once)).toBeUndefined();
    expect(twice).toBe(once);
  });

  // The converted file of a git-sourced stack deployed before stacks were
  // routed by the file provider carries the labels that deploy injected into
  // `deploy.labels` — the file `getConverted` and the next deploy's injector
  // are both fed. They routed nothing, and they have to go rather than ride
  // along forever.
  describe('a stack whose converted file carries an earlier deploy’s labels', () => {
    const CONVERTED_BEFORE_696 = `services:
  wordpress:
    image: wordpress:6
    deploy:
      replicas: 2
      labels:
        - traefik.enable=true
        - traefik.swarm.network=cloudgate-network
        - traefik.http.routers.wp-stack-1-web.rule=Host(\`blog.example.com\`)
        - traefik.http.routers.wp-stack-1-web.entrypoints=web
        - traefik.http.services.wp-stack-1-web.loadbalancer.server.port=80
        - traefik.http.routers.wp-stack-1-web.service=wp-stack-1-web
        - traefik.http.routers.wp-stack-1-web.middlewares=redirect-to-https@file
        - traefik.http.routers.wp-stack-1-websecure.rule=Host(\`blog.example.com\`)
        - traefik.http.routers.wp-stack-1-websecure.entrypoints=websecure
        - traefik.http.services.wp-stack-1-websecure.loadbalancer.server.port=80
        - traefik.http.routers.wp-stack-1-websecure.service=wp-stack-1-websecure
        - traefik.http.routers.wp-stack-1-websecure.middlewares=stripprefix-wp-stack-1
        - traefik.http.routers.wp-stack-1-websecure.tls.certresolver=letsencrypt
        - traefik.http.middlewares.stripprefix-wp-stack-1.stripprefix.prefixes=/api
        - traefik.http.routers.wp-stack-9-web.rule=Host(\`gone.example.com\`)
        - com.example.owner=platform
        - traefik.http.routers.mine.rule=Host(\`mine.example.com\`)
    networks:
      - cloudgate-network
      - default
  worker:
    image: busybox
    deploy:
      labels:
        - traefik.enable=true
        - traefik.swarm.network=cloudgate-network
        - traefik.http.routers.wp-stack-4-web.rule=Host(\`old.example.com\`)
networks:
  cloudgate-network:
    external: true
`;

    it('takes out every label Cloudgate minted for this stack, a deleted Domain’s included', () => {
      const { once, twice } = passes(
        source({ composeType: 'stack' }),
        CONVERTED_BEFORE_696,
        [domain({ https: true, certificateType: 'letsencrypt' })],
      );

      // The author's own labels stay, Traefik's among them; `traefik.enable`
      // goes with the minted labels it was written beside.
      expect(deployLabelsOf(once)).toEqual([
        'com.example.owner=platform',
        'traefik.http.routers.mine.rule=Host(`mine.example.com`)',
      ]);
      expect(parseComposeFile(once)?.services?.wordpress.deploy?.replicas).toBe(
        2,
      );
      // A block left empty goes, so the file reads as if never labelled.
      expect(parseComposeFile(once)?.services?.worker.deploy).toBeUndefined();
      expect(once).not.toMatch(/traefik\.swarm\.network|wp-stack-\d+-/);
      expect(twice).toBe(once);
    });

    it('takes them out when the stack is isolated and has no Domain left', () => {
      // The domain-less isolated arm of `writeDomainsToCompose` skips the
      // injector entirely, so it has to be stripped on its own.
      const { once } = passes(
        source({ composeType: 'stack', isolatedDeployment: true }),
        CONVERTED_BEFORE_696.replace(
          /traefik\.swarm\.network=cloudgate-network/g,
          'traefik.swarm.network=wp-stack',
        ),
        [],
      );

      expect(once).not.toMatch(/traefik\.swarm\.network|wp-stack-\d+-/);
      expect(deployLabelsOf(once)).toEqual([
        'com.example.owner=platform',
        'traefik.http.routers.mine.rule=Host(`mine.example.com`)',
      ]);
    });

    it('leaves another stack’s labels, and a docker-compose file’s, alone', () => {
      // Named for a different appName: not this stack's to take.
      const other = CONVERTED_BEFORE_696.replace(/wp-stack-/g, 'shop-');
      expect(
        deployLabelsOf(
          writeDomainsToCompose(source({ composeType: 'stack' }), other, []),
        ),
      ).toContain('traefik.http.routers.shop-1-web.entrypoints=web');
      // A docker-compose Compose never reads `deploy.labels`, and is unchanged.
      expect(
        deployLabelsOf(
          writeDomainsToCompose(source(), CONVERTED_BEFORE_696, []),
        ),
      ).toContain('traefik.swarm.network=cloudgate-network');
    });
  });

  it('duplicates neither router of an https domain, which contributes two', () => {
    const { once, twice } = passes(source(), BASE_COMPOSE, [
      domain({ https: true, certificateType: 'letsencrypt' }),
    ]);

    // An https domain mints a `web` redirect router *and* a `websecure` one, so
    // this is the shape that produced ten duplicated labels: everything below
    // except the two that always had a guard.
    expect(labelsOf(once)).toEqual([
      'traefik.enable=true',
      'traefik.docker.network=cloudgate-network',
      'traefik.http.routers.wp-stack-1-web.rule=Host(`blog.example.com`)',
      'traefik.http.routers.wp-stack-1-web.entrypoints=web',
      'traefik.http.services.wp-stack-1-web.loadbalancer.server.port=80',
      'traefik.http.routers.wp-stack-1-web.service=wp-stack-1-web',
      'traefik.http.routers.wp-stack-1-web.middlewares=redirect-to-https@file',
      'traefik.http.routers.wp-stack-1-websecure.rule=Host(`blog.example.com`)',
      'traefik.http.routers.wp-stack-1-websecure.entrypoints=websecure',
      'traefik.http.services.wp-stack-1-websecure.loadbalancer.server.port=80',
      'traefik.http.routers.wp-stack-1-websecure.service=wp-stack-1-websecure',
      'traefik.http.routers.wp-stack-1-websecure.tls.certresolver=letsencrypt',
    ]);
    expect(twice).toBe(once);
  });

  it('duplicates neither the middleware definition nor its router reference', () => {
    const { once, twice } = passes(source(), BASE_COMPOSE, [
      domain({ path: '/api', stripPath: true }),
    ]);

    // `stripprefix` is defined once by Traefik's own rule (on the web/custom
    // entrypoint only) and referenced by the router. A second definition of the
    // same middleware is the duplicate that would be hardest to read past.
    expect(labelsOf(once)).toEqual([
      'traefik.enable=true',
      'traefik.docker.network=cloudgate-network',
      'traefik.http.routers.wp-stack-1-web.rule=Host(`blog.example.com`) && (PathPrefix(`/api/`) || Path(`/api`))',
      'traefik.http.routers.wp-stack-1-web.entrypoints=web',
      'traefik.http.services.wp-stack-1-web.loadbalancer.server.port=80',
      'traefik.http.routers.wp-stack-1-web.service=wp-stack-1-web',
      'traefik.http.middlewares.stripprefix-wp-stack-1.stripprefix.prefixes=/api',
      'traefik.http.routers.wp-stack-1-web.middlewares=stripprefix-wp-stack-1',
    ]);
    expect(twice).toBe(once);
  });

  it('duplicates nothing for an https domain that also strips a path prefix', () => {
    const { once, twice } = passes(source(), BASE_COMPOSE, [
      domain({
        https: true,
        certificateType: 'letsencrypt',
        path: '/api',
        stripPath: true,
      }),
    ]);

    // Both entrypoints and a middleware at once — the densest label set the
    // generator emits, and the one whose duplication is hardest to read past:
    // `stripprefix` is *defined* on the web entrypoint so Traefik registers it
    // once, and *referenced* by the websecure router, where the request lands.
    expect(labelsOf(once)).toEqual([
      'traefik.enable=true',
      'traefik.docker.network=cloudgate-network',
      'traefik.http.routers.wp-stack-1-web.rule=Host(`blog.example.com`) && (PathPrefix(`/api/`) || Path(`/api`))',
      'traefik.http.routers.wp-stack-1-web.entrypoints=web',
      'traefik.http.services.wp-stack-1-web.loadbalancer.server.port=80',
      'traefik.http.routers.wp-stack-1-web.service=wp-stack-1-web',
      'traefik.http.middlewares.stripprefix-wp-stack-1.stripprefix.prefixes=/api',
      'traefik.http.routers.wp-stack-1-web.middlewares=redirect-to-https@file',
      'traefik.http.routers.wp-stack-1-websecure.rule=Host(`blog.example.com`) && (PathPrefix(`/api/`) || Path(`/api`))',
      'traefik.http.routers.wp-stack-1-websecure.entrypoints=websecure',
      'traefik.http.services.wp-stack-1-websecure.loadbalancer.server.port=80',
      'traefik.http.routers.wp-stack-1-websecure.service=wp-stack-1-websecure',
      'traefik.http.routers.wp-stack-1-websecure.middlewares=stripprefix-wp-stack-1',
      'traefik.http.routers.wp-stack-1-websecure.tls.certresolver=letsencrypt',
    ]);
    expect(twice).toBe(once);
  });

  it('duplicates nothing when two domains share one service', () => {
    const { once, twice } = passes(source(), BASE_COMPOSE, [
      domain(),
      domain({ host: 'shop.example.com', uniqueConfigKey: 2 }),
    ]);

    const labels = labelsOf(once) as string[];
    // Two domains route the same service, so the second pass finds a list that
    // already holds both sets and each domain's own guard has to see past the
    // other's labels.
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain(
      'traefik.http.routers.wp-stack-2-web.rule=Host(`shop.example.com`)',
    );
    expect(twice).toBe(once);
  });

  // This test was rewritten, and the reason is worth keeping: as first written
  // it attached the domain **to** the map-labelled service and asserted the
  // output was the untouched map — which pinned as deliberate the very defect
  // was later filed. `addDomainsToComposeSpec` refuses that combination now
  // (`mapFormLabelsRefusal`, asserted in `compose-domains.spec.ts`), so what is
  // left here is the half that is still true and still worth a pin: Cloudgate
  // never rewrites a map, and an *unrouted* service's map survives both passes
  // byte-for-byte.
  it('leaves an unrouted service’s map-form labels untouched on both passes', () => {
    const authored = `services:
  wordpress:
    image: wordpress:6
    labels:
      com.example.owner: platform
      com.example.tier: 1
  db:
    image: mariadb:11
`;

    const { once, twice } = passes(source(), authored, [
      domain({ serviceName: 'db' }),
    ]);

    // The map form is never converted to a list, never appended to, and never
    // reordered. Nothing about the duplicate filter or the map-form refusal may
    // start writing into a map.
    expect(labelsOf(once)).toEqual({
      'com.example.owner': 'platform',
      'com.example.tier': 1,
    });
    expect(twice).toBe(once);
    // Nothing was joined to the routed network on the way to being left alone:
    // the injector visits routed services only, and this one has no domain.
    expect(
      parseComposeFile(once)?.services?.wordpress.networks,
    ).toBeUndefined();
    expect(parseComposeFile(once)?.services?.db.networks).toEqual([
      'cloudgate-network',
      'default',
    ]);
  });

  it("keeps an author's own traefik label, including one Cloudgate also writes", () => {
    const authored = `services:
  wordpress:
    image: wordpress:6
    labels:
      - traefik.http.routers.mine.rule=Host(\`mine.example.com\`)
      - traefik.http.routers.mine.entrypoints=web
      - traefik.enable=true
      - my.label=kept
`;

    const { once, twice } = passes(source(), authored, [domain()]);
    const labels = labelsOf(once) as string[];

    // Filtering next to author content is the one way this fix could delete
    // something it must not. The author's routers are not this stack's domain
    // rows, so no generated label can ever match one…
    expect(labels).toContain(
      'traefik.http.routers.mine.rule=Host(`mine.example.com`)',
    );
    expect(labels).toContain('traefik.http.routers.mine.entrypoints=web');
    expect(labels).toContain('my.label=kept');
    // …and `traefik.enable=true`, the one label an author can write that
    // Cloudgate writes too, is kept once rather than either duplicated or
    // dropped — its own guard already decided that, and the filter must not
    // second-guess it.
    expect(labels.filter((label) => label === 'traefik.enable=true')).toEqual([
      'traefik.enable=true',
    ]);
    expect(twice).toBe(once);
  });

  it('leaves the isolated domainless arm, which takes no labels, unaffected', () => {
    const { once, twice } = passes(
      source({ isolatedDeployment: true }),
      BASE_COMPOSE,
      [],
    );

    // This arm never enters `addDomainsToComposeSpec` — it round-trips through
    // `parseComposeFileOrThrow` and takes only the platform defaults. It was
    // already idempotent, and the assertion is here so that a change to the
    // label guard has to keep saying so.
    expect(once).not.toContain('traefik');
    expect(parseComposeFile(once)?.networks).toBeUndefined();
    expect(parseComposeFile(once)?.services?.wordpress).toEqual({
      image: 'wordpress:6',
      restart: 'unless-stopped',
      logging: {
        driver: 'json-file',
        options: { 'max-size': '10m', 'max-file': '3' },
      },
    });
    expect(twice).toBe(once);
  });

  it('applies the platform defaults once for a routed stack too', () => {
    const { once, twice } = passes(source(), BASE_COMPOSE, [domain()]);

    // `applyComposeDefaults` writes with `??=`, so the second pass finds both
    // keys present and changes nothing. Named here because the double injection
    // was filed against the defaults and the defaults turned out to be the
    // innocent half.
    expect(once.match(/restart: unless-stopped/g)).toHaveLength(2);
    expect(once.match(/driver: json-file/g)).toHaveLength(2);
    expect(twice).toBe(once);
  });
});

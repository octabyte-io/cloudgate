import {
  addDomainsToComposeSpec,
  applyComposeDefaults,
  composeServiceUsesMapFormLabels,
  parseComposeFile,
  writeDomainsToCompose,
} from '../../src/compose/compose.utils';
import type {
  ComposeDomain,
  ComposeSpecSource,
} from '../../src/compose/compose.types';
import { readComposeHostClaimsFromSpec } from '../../src/compose/compose-labels';

// addDomainsToComposeSpec as a pure function: domains arrive as plain inputs
// (the domains table lands in Phase 30), labels follow
// createComposeDomainLabels, and the shared network is cloudgate-network.

const BASE_COMPOSE = `services:
  wordpress:
    image: wordpress:6
  db:
    image: mariadb:11
`;

/** `containerLogOptions()`' defaults — the log cap, extended to compose. */
const CAP = { 'max-size': '10m', 'max-file': '3' };

const domain = (overrides: Partial<ComposeDomain> = {}): ComposeDomain => ({
  host: 'blog.example.com',
  serviceName: 'wordpress',
  port: 80,
  https: false,
  uniqueConfigKey: 1,
  ...overrides,
});

describe('addDomainsToComposeSpec', () => {
  it('injects Traefik labels and the shared network for a plain http domain', () => {
    const spec = addDomainsToComposeSpec(
      {
        appName: 'wp-stack',
        composeType: 'docker-compose',
        isolatedDeployment: false,
      },
      BASE_COMPOSE,
      [domain()],
    );

    expect(spec?.services?.wordpress.labels).toEqual([
      'traefik.enable=true',
      'traefik.docker.network=cloudgate-network',
      'traefik.http.routers.wp-stack-1-web.rule=Host(`blog.example.com`)',
      'traefik.http.routers.wp-stack-1-web.entrypoints=web',
      'traefik.http.services.wp-stack-1-web.loadbalancer.server.port=80',
      'traefik.http.routers.wp-stack-1-web.service=wp-stack-1-web',
    ]);
    // The routed service joins the shared network (plus its default one)…
    expect(spec?.services?.wordpress.networks).toEqual([
      'cloudgate-network',
      'default',
    ]);
    // …the untouched service does not…
    expect(spec?.services?.db.networks).toBeUndefined();
    expect(spec?.services?.db.labels).toBeUndefined();
    // …and the network is declared external at the root.
    expect(spec?.networks).toEqual({
      'cloudgate-network': { external: true },
    });
  });

  it('turns TLS on with no resolver for a domain served by a stored certificate', () => {
    const spec = addDomainsToComposeSpec(
      {
        appName: 'wp-stack',
        composeType: 'docker-compose',
        isolatedDeployment: false,
      },
      BASE_COMPOSE,
      [domain({ https: true, certificateType: 'stored' })],
    );

    const labels = spec?.services?.wordpress.labels as string[];
    expect(labels).toContain(
      'traefik.http.routers.wp-stack-1-websecure.tls=true',
    );
    expect(labels.filter((label) => label.includes('certresolver'))).toEqual(
      [],
    );
  });

  it('adds a websecure router with redirect and certresolver for an https letsencrypt domain', () => {
    const spec = addDomainsToComposeSpec(
      {
        appName: 'wp-stack',
        composeType: 'docker-compose',
        isolatedDeployment: false,
      },
      BASE_COMPOSE,
      [domain({ https: true, certificateType: 'letsencrypt' })],
    );

    expect(spec?.services?.wordpress.labels).toEqual([
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
  });

  it('matches a path prefix and strips it before proxying when asked', () => {
    const spec = addDomainsToComposeSpec(
      {
        appName: 'wp-stack',
        composeType: 'docker-compose',
        isolatedDeployment: false,
      },
      BASE_COMPOSE,
      [domain({ path: '/api', stripPath: true })],
    );

    expect(spec?.services?.wordpress.labels).toEqual([
      'traefik.enable=true',
      'traefik.docker.network=cloudgate-network',
      'traefik.http.routers.wp-stack-1-web.rule=Host(`blog.example.com`) && (PathPrefix(`/api/`) || Path(`/api`))',
      'traefik.http.routers.wp-stack-1-web.entrypoints=web',
      'traefik.http.services.wp-stack-1-web.loadbalancer.server.port=80',
      'traefik.http.routers.wp-stack-1-web.service=wp-stack-1-web',
      'traefik.http.middlewares.stripprefix-wp-stack-1.stripprefix.prefixes=/api',
      'traefik.http.routers.wp-stack-1-web.middlewares=stripprefix-wp-stack-1',
    ]);
  });

  // The path matches on a segment boundary, so `/api` never takes
  // `/apix`; a path already ending in `/` is its own plain prefix.
  it.each([
    [
      '/api',
      'Host(`blog.example.com`) && (PathPrefix(`/api/`) || Path(`/api`))',
    ],
    ['/api/', 'Host(`blog.example.com`) && PathPrefix(`/api/`)'],
    ['/', 'Host(`blog.example.com`)'],
  ])('routes path %s with the rule %s', (path, rule) => {
    const spec = addDomainsToComposeSpec(
      {
        appName: 'wp-stack',
        composeType: 'docker-compose',
        isolatedDeployment: false,
      },
      BASE_COMPOSE,
      [domain({ path })],
    );
    expect(spec?.services?.wordpress.labels).toContain(
      `traefik.http.routers.wp-stack-1-web.rule=${rule}`,
    );
    // `start` re-reads the converted file through the label guard, which
    // refuses a rule it cannot bound to a hostname; the `||` sits inside
    // the `&&` with Host, so the claim is still exactly the domain's host.
    expect(readComposeHostClaimsFromSpec(spec)).toEqual([
      expect.objectContaining({ host: 'blog.example.com' }),
    ]);
  });

  // Swarm keeps `deploy.labels` on the service, where Traefik's docker
  // provider never reads them, so a stack is routed by a file-provider config
  // (`createComposeStackTraefikConfig`) and its file gets the network only.
  it('joins a stack’s routed service to the shared network and gives it no label', () => {
    const spec = addDomainsToComposeSpec(
      { appName: 'wp-stack', composeType: 'stack', isolatedDeployment: false },
      BASE_COMPOSE,
      [domain()],
    );

    expect(spec?.services?.wordpress.labels).toBeUndefined();
    expect(spec?.services?.wordpress.deploy).toBeUndefined();
    expect(spec?.services?.wordpress.networks).toEqual([
      'cloudgate-network',
      'default',
    ]);
    expect(spec?.networks).toEqual({ 'cloudgate-network': { external: true } });
  });

  it('joins an isolated stack to the per-app network Traefik is connected to', () => {
    const spec = addDomainsToComposeSpec(
      {
        appName: 'wp-stack',
        composeType: 'docker-compose',
        isolatedDeployment: true,
      },
      BASE_COMPOSE,
      [domain()],
    );

    // An isolated deployment routes over the network the deploy script creates
    // and connects Traefik to — `<appName>`, not cloudgate-network.
    expect(spec?.services?.wordpress.labels).toEqual([
      'traefik.enable=true',
      'traefik.docker.network=wp-stack',
      'traefik.http.routers.wp-stack-1-web.rule=Host(`blog.example.com`)',
      'traefik.http.routers.wp-stack-1-web.entrypoints=web',
      'traefik.http.services.wp-stack-1-web.loadbalancer.server.port=80',
      'traefik.http.routers.wp-stack-1-web.service=wp-stack-1-web',
    ]);
    expect(spec?.services?.wordpress.networks).toEqual(['wp-stack', 'default']);
    // Only the routed service joins it; the rest of the stack stays on default.
    expect(spec?.services?.db.networks).toBeUndefined();
    // The deploy script creates the network before `up`, so the file declares
    // it external rather than asking compose to make it.
    expect(spec?.networks).toEqual({ 'wp-stack': { external: true } });
  });

  it('declares no network for an isolated stack with nothing routed', () => {
    const spec = addDomainsToComposeSpec(
      {
        appName: 'wp-stack',
        composeType: 'docker-compose',
        isolatedDeployment: true,
      },
      BASE_COMPOSE,
      [],
    );

    // Nothing joins the per-app network, so the file has no reason to require
    // it. `addDomainsToComposeSpec` is domains and networks only; the platform
    // defaults (restart policy and log cap) are `applyComposeDefaults`' job, and
    // `writeDomainsToCompose` is where the two meet.
    expect(spec?.networks).toBeUndefined();
    expect(spec?.services?.wordpress.networks).toBeUndefined();
  });

  it('joins an isolated stack to its own network, with no label', () => {
    const spec = addDomainsToComposeSpec(
      { appName: 'wp-stack', composeType: 'stack', isolatedDeployment: true },
      BASE_COMPOSE,
      [domain()],
    );

    expect(spec?.services?.wordpress.deploy).toBeUndefined();
    expect(spec?.services?.wordpress.networks).toEqual(['wp-stack', 'default']);
    expect(spec?.networks).toEqual({ 'wp-stack': { external: true } });
  });

  it('keeps an isolated service on the networks the file already gave it', () => {
    const spec = addDomainsToComposeSpec(
      {
        appName: 'wp-stack',
        composeType: 'docker-compose',
        isolatedDeployment: true,
      },
      `services:
  wordpress:
    image: wordpress:6
    networks:
      - frontend
networks:
  frontend: {}
`,
      [domain()],
    );

    expect(spec?.services?.wordpress.networks).toEqual([
      'frontend',
      'wp-stack',
      'default',
    ]);
    expect(spec?.networks).toEqual({
      frontend: {},
      'wp-stack': { external: true },
    });
  });

  it('preserves existing labels and networks on the routed service', () => {
    const spec = addDomainsToComposeSpec(
      {
        appName: 'wp-stack',
        composeType: 'docker-compose',
        isolatedDeployment: false,
      },
      `services:
  wordpress:
    image: wordpress:6
    labels:
      - my.label=kept
    networks:
      - frontend
networks:
  frontend: {}
`,
      [domain()],
    );

    expect(spec?.services?.wordpress.labels).toEqual([
      'traefik.enable=true',
      'traefik.docker.network=cloudgate-network',
      'traefik.http.routers.wp-stack-1-web.rule=Host(`blog.example.com`)',
      'traefik.http.routers.wp-stack-1-web.entrypoints=web',
      'traefik.http.services.wp-stack-1-web.loadbalancer.server.port=80',
      'traefik.http.routers.wp-stack-1-web.service=wp-stack-1-web',
      'my.label=kept',
    ]);
    expect(spec?.services?.wordpress.networks).toEqual([
      'frontend',
      'cloudgate-network',
      'default',
    ]);
    expect(spec?.networks).toEqual({
      frontend: {},
      'cloudgate-network': { external: true },
    });
  });

  it('rejects a domain whose service does not exist in the compose file', () => {
    expect(() =>
      addDomainsToComposeSpec(
        {
          appName: 'wp-stack',
          composeType: 'docker-compose',
          isolatedDeployment: false,
        },
        BASE_COMPOSE,
        [domain({ serviceName: 'ghost' })],
      ),
    ).toThrow(
      'Domain "blog.example.com" is attached to service "ghost" which does not exist in the compose file',
    );
  });

  // Before this the map form skipped every Traefik label and the function
  // carried on — the service was joined to the routed network and the network
  // declared external at the root, so the Converted tab showed wiring that reads
  // as configured while Traefik held no router for the host. The negative
  // assertions below are the point of this group: nothing is emitted on the way
  // to the refusal.
  describe('a routed service whose labels are a map', () => {
    const MAP_LABELLED = `services:
  wordpress:
    image: wordpress:6
    labels:
      com.example.owner: platform
  db:
    image: mariadb:11
`;

    const STACK_MAP_LABELLED = `services:
  wordpress:
    image: wordpress:6
    deploy:
      labels:
        com.example.owner: platform
`;

    it('refuses the domain instead of skipping its labels, naming the service and the block', () => {
      expect(() =>
        addDomainsToComposeSpec(
          {
            appName: 'wp-stack',
            composeType: 'docker-compose',
            isolatedDeployment: false,
          },
          MAP_LABELLED,
          [domain()],
        ),
      ).toThrow(
        'Domain "blog.example.com" is attached to service "wordpress", which declares "labels" as a map — Cloudgate adds Traefik routing labels only to the list form. Rewrite that service\'s labels as a list of "key=value" entries, or attach this domain to a service that already uses one',
      );
    });

    // A stack gets no labels, so how its `deploy.labels` are written is
    // not a reason to refuse anything.
    it('routes a stack whose deploy.labels are a map, leaving the map alone', () => {
      const spec = addDomainsToComposeSpec(
        {
          appName: 'wp-stack',
          composeType: 'stack',
          isolatedDeployment: false,
        },
        STACK_MAP_LABELLED,
        [domain()],
      );
      expect(spec?.services?.wordpress.deploy?.labels).toEqual({
        'com.example.owner': 'platform',
      });
      expect(spec?.services?.wordpress.networks).toEqual([
        'cloudgate-network',
        'default',
      ]);
    });

    it('leaves the spec unwired, so no output can suggest the domain is routed', () => {
      // The spec the throw abandons is the one the old code returned: this
      // asserts the caller gets nothing at all rather than a file whose network
      // wiring reads as configured. `parseComposeFile` on the same input is the
      // independent record of what the author actually wrote.
      let thrown: unknown;
      try {
        addDomainsToComposeSpec(
          {
            appName: 'wp-stack',
            composeType: 'docker-compose',
            isolatedDeployment: false,
          },
          MAP_LABELLED,
          [domain()],
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      const authored = parseComposeFile(MAP_LABELLED);
      expect(authored?.services?.wordpress.networks).toBeUndefined();
      expect(authored?.networks).toBeUndefined();
    });

    it('takes a map-labelled service that no domain names', () => {
      // The map form is only ever a refusal for a service a Domain row actually
      // points at. The injector visits routed services only, so an unrouted
      // sidecar's map is not this rule's business.
      const spec = addDomainsToComposeSpec(
        {
          appName: 'wp-stack',
          composeType: 'docker-compose',
          isolatedDeployment: false,
        },
        MAP_LABELLED,
        [domain({ serviceName: 'db' })],
      );

      expect(spec?.services?.wordpress.labels).toEqual({
        'com.example.owner': 'platform',
      });
      expect(spec?.services?.wordpress.networks).toBeUndefined();
      expect(spec?.services?.db.labels).toEqual([
        'traefik.enable=true',
        'traefik.docker.network=cloudgate-network',
        'traefik.http.routers.wp-stack-1-web.rule=Host(`blog.example.com`)',
        'traefik.http.routers.wp-stack-1-web.entrypoints=web',
        'traefik.http.services.wp-stack-1-web.loadbalancer.server.port=80',
        'traefik.http.routers.wp-stack-1-web.service=wp-stack-1-web',
      ]);
    });
  });

  // Cosmetic: the routed-network label used to splice at a hardcoded
  // index `1` while every other insert in that block counted from
  // `indexOf('traefik.enable=true')`. The two agree only when Cloudgate
  // `unshift`ed `enable` itself.
  it('puts the routed-network label beside an author-written traefik.enable', () => {
    const spec = addDomainsToComposeSpec(
      {
        appName: 'wp-stack',
        composeType: 'docker-compose',
        isolatedDeployment: false,
      },
      `services:
  wordpress:
    image: wordpress:6
    labels:
      - my.first=label
      - traefik.enable=true
`,
      [domain()],
    );

    // Hand-written, not recomputed: the network label sits directly after the
    // `enable` the author wrote, not at index 1 ahead of the author's own label.
    expect(spec?.services?.wordpress.labels).toEqual([
      'my.first=label',
      'traefik.enable=true',
      'traefik.docker.network=cloudgate-network',
      'traefik.http.routers.wp-stack-1-web.rule=Host(`blog.example.com`)',
      'traefik.http.routers.wp-stack-1-web.entrypoints=web',
      'traefik.http.services.wp-stack-1-web.loadbalancer.server.port=80',
      'traefik.http.routers.wp-stack-1-web.service=wp-stack-1-web',
    ]);
  });
});

// The map-form refusal's pre-flight half: the same rule as the injector's
// throw, asked of a caller that holds the file before the injector would run.
// `DomainsService` asks it on `POST /domains` and `PATCH /domains/:id` for a
// raw stack; the e2e cases live in `test/domains/domains.e2e-spec.ts`.
describe('composeServiceUsesMapFormLabels', () => {
  const MAP_LABELLED = `services:
  wordpress:
    image: wordpress:6
    labels:
      com.example.owner: platform
`;

  it('reports the map form for a docker-compose service, and never for a stack', () => {
    expect(
      composeServiceUsesMapFormLabels(
        'docker-compose',
        MAP_LABELLED,
        'wordpress',
      ),
    ).toBe(true);
    // A stack gets no labels at all, so its map is nothing to refuse.
    expect(
      composeServiceUsesMapFormLabels(
        'stack',
        `services:
  wordpress:
    deploy:
      labels:
        com.example.owner: platform
`,
        'wordpress',
      ),
    ).toBe(false);
  });

  it('reports no map form for the list form, for the other flavour’s block, or for absent labels', () => {
    expect(
      composeServiceUsesMapFormLabels(
        'docker-compose',
        `services:
  wordpress:
    labels:
      - com.example.owner=platform
`,
        'wordpress',
      ),
    ).toBe(false);
    // A `stack` is injected into nowhere, a top-level map included.
    expect(
      composeServiceUsesMapFormLabels('stack', MAP_LABELLED, 'wordpress'),
    ).toBe(false);
    expect(
      composeServiceUsesMapFormLabels('docker-compose', BASE_COMPOSE, 'db'),
    ).toBe(false);
  });

  it('fails open on an empty file, unreadable YAML and a service the file does not declare', () => {
    // Each of these is some other guard's refusal — the empty-file throw, the
    // unknown-service throw — and none of them is one `POST /domains` has ever
    // made. A pre-flight that answered `true` here would be inventing refusals.
    expect(
      composeServiceUsesMapFormLabels('docker-compose', '', 'wordpress'),
    ).toBe(false);
    expect(
      composeServiceUsesMapFormLabels(
        'docker-compose',
        'services: [oh: no: :',
        'wordpress',
      ),
    ).toBe(false);
    expect(
      composeServiceUsesMapFormLabels('docker-compose', MAP_LABELLED, 'ghost'),
    ).toBe(false);
  });
});

describe('writeDomainsToCompose', () => {
  it('returns the compose file as YAML with the injected labels', () => {
    const yaml = writeDomainsToCompose(
      {
        appName: 'wp-stack',
        composeType: 'docker-compose',
        isolatedDeployment: false,
      },
      BASE_COMPOSE,
      [domain()],
    );

    expect(yaml).toContain('traefik.enable=true');
    expect(yaml).toContain(
      'traefik.http.routers.wp-stack-1-web.rule=Host(`blog.example.com`)',
    );
    expect(yaml).toContain('external: true');
  });

  it('still declares the shared network for a non-isolated stack with no domains', () => {
    const yaml = writeDomainsToCompose(
      {
        appName: 'wp-stack',
        composeType: 'docker-compose',
        isolatedDeployment: false,
      },
      BASE_COMPOSE,
      [],
    );

    // Nothing is routed, so no service gains labels or a network — but the
    // root declaration lands anyway. This is what the deploy writes and so
    // what GET /compose/:id/converted reports for a domainless stack.
    expect(yaml).not.toContain('traefik');
    expect(yaml).toContain('cloudgate-network');
    expect(parseComposeFile(yaml)?.networks).toEqual({
      'cloudgate-network': { external: true },
    });
    expect(parseComposeFile(yaml)?.services?.wordpress).toEqual({
      image: 'wordpress:6',
      restart: 'unless-stopped',
      logging: { driver: 'json-file', options: CAP },
    });
  });

  it('declares the per-app network external for an isolated stack with a domain', () => {
    const yaml = writeDomainsToCompose(
      {
        appName: 'wp-stack',
        composeType: 'docker-compose',
        isolatedDeployment: true,
      },
      BASE_COMPOSE,
      [domain()],
    );

    expect(yaml).not.toContain('cloudgate-network');
    expect(yaml).toContain('traefik.docker.network=wp-stack');
    expect(parseComposeFile(yaml)?.networks).toEqual({
      'wp-stack': { external: true },
    });
    expect(parseComposeFile(yaml)?.services?.wordpress.networks).toEqual([
      'wp-stack',
      'default',
    ]);
  });
});

// The two platform defaults Cloudgate writes into the *converted* file — the
// copy it owns — rather than into the operator's own (`restart:` and
// `logging:`). Both are decided by one rule, so both are asserted against
// it: presence of the key is the author's statement, absence is the product's
// default. The negative assertions carry the weight here — a `stack` row must
// get no `restart:`, a declared key must come back unchanged, and an isolated
// domain-less stack must get the defaults *without* getting routed.
describe('writeDomainsToCompose platform defaults', () => {
  const source = (
    overrides: Partial<ComposeSpecSource> = {},
  ): ComposeSpecSource => ({
    appName: 'wp-stack',
    composeType: 'docker-compose',
    isolatedDeployment: false,
    ...overrides,
  });

  const services = (yaml: string) => parseComposeFile(yaml)?.services ?? {};

  it('gives every service of a docker-compose stack unless-stopped and the log cap', () => {
    const written = services(writeDomainsToCompose(source(), BASE_COMPOSE, []));

    for (const name of ['wordpress', 'db']) {
      expect(written[name].restart).toBe('unless-stopped');
      expect(written[name].logging).toEqual({
        driver: 'json-file',
        options: CAP,
      });
    }
  });

  it('caps a stack-type row but gives it no restart, which docker stack deploy would only warn about', () => {
    const written = services(
      writeDomainsToCompose(source({ composeType: 'stack' }), BASE_COMPOSE, []),
    );

    // `logging:` maps onto TaskTemplate.LogDriver, so Swarm gets the cap…
    expect(written.wordpress.logging).toEqual({
      driver: 'json-file',
      options: CAP,
    });
    // …but `restart:` is ignored by `docker stack deploy`, which prints
    // "Ignoring unsupported options: restart" on every deploy, and Swarm's own
    // deploy.restart_policy already defaults to `condition: any`. The two keys
    // take different gates on purpose; this is the assertion that stops a later
    // reader making them symmetrical.
    expect(written.wordpress.restart).toBeUndefined();
    expect(written.db.restart).toBeUndefined();
  });

  it('leaves an author-declared restart alone, including a bare no and a falsy one', () => {
    const authored = `services:
  wordpress:
    image: wordpress:6
    restart: always
  db:
    image: mariadb:11
    restart: no
  cache:
    image: redis:7
    restart: false
`;

    const yaml = writeDomainsToCompose(source(), authored, []);
    const written = services(yaml);

    // The product does not upgrade a choice the author made…
    expect(written.wordpress.restart).toBe('always');
    // …and `restart: no` is the value the decision turns on: it is the one an
    // author most plausibly meant, and the one a product that second-guessed
    // presence would overwrite. `yaml`'s YAML 1.2 core schema reads it as the
    // string "no" rather than 1.1's boolean false, and the round trip emits it
    // back unquoted, so what Docker reads is what the author wrote.
    expect(written.db.restart).toBe('no');
    expect(yaml).toContain('restart: no');
    // The falsy case, which is what `??=` is actually load-bearing for: an
    // explicit `restart: false` parses as the boolean and a truthiness check
    // would overwrite it with `unless-stopped`. Do not "tidy" `??=` into one.
    expect(written.cache.restart).toBe(false);
    expect(yaml).not.toContain('unless-stopped');
  });

  it('leaves an author-declared logging block whole rather than merging into it', () => {
    const authored = `services:
  wordpress:
    image: wordpress:6
    logging:
      driver: none
  db:
    image: mariadb:11
    logging:
      driver: json-file
`;

    const written = services(writeDomainsToCompose(source(), authored, []));

    // Replaced, never merged: no `options` key appears beside a driver the
    // author chose. A "helpful" merge is what this pins against.
    expect(written.wordpress.logging).toEqual({ driver: 'none' });
    // The residual the decision accepts, pinned so that changing the decision
    // has to change a test that says what the decision was: an author who
    // writes an unbounded json-file block keeps it uncapped.
    expect(written.db.logging).toEqual({ driver: 'json-file' });
  });

  it('reads the log ceiling from the env on every call, not at import', () => {
    // Through the pure function, with the env handed in…
    const spec = applyComposeDefaults(
      source(),
      parseComposeFile(BASE_COMPOSE) ?? {},
      { CONTAINER_LOG_MAX_SIZE: '50m', CONTAINER_LOG_MAX_FILE: '5' },
    );
    expect(spec.services?.wordpress.logging).toEqual({
      driver: 'json-file',
      options: { 'max-size': '50m', 'max-file': '5' },
    });

    // …and through the deploy path's own entry point, which reads process.env.
    // §2.8: a value captured at import silently misses a .env entry, so the
    // override has to land on a module that was imported long before it was set.
    const before = { ...process.env };
    try {
      process.env.CONTAINER_LOG_MAX_SIZE = '50m';
      process.env.CONTAINER_LOG_MAX_FILE = '5';
      expect(
        services(writeDomainsToCompose(source(), BASE_COMPOSE, [])).wordpress
          .logging,
      ).toEqual({
        driver: 'json-file',
        options: { 'max-size': '50m', 'max-file': '5' },
      });
    } finally {
      process.env = before;
    }
  });

  it('repeats the logging block per service instead of emitting a YAML alias', () => {
    const threeServices = `${BASE_COMPOSE}  cache:
    image: redis:7
`;

    const yaml = writeDomainsToCompose(source(), threeServices, []);

    // `stringify` aliases a repeated object by default (`&a1` / `*a1`), which
    // would put a reference rather than the block itself in the file an operator
    // reads on the Converted tab. Invisible to an object-level assertion,
    // because the parser resolves the alias back into an equal object.
    expect(yaml.match(/driver: json-file/g)).toHaveLength(3);
    expect(yaml).not.toMatch(/\*a\d/);
    expect(yaml).not.toMatch(/&a\d/);
  });

  it('defaults an isolated domainless stack without routing it', () => {
    const yaml = writeDomainsToCompose(
      source({ isolatedDeployment: true }),
      BASE_COMPOSE,
      [],
    );

    // This is the shape the early return used to hand back verbatim, so it was
    // the one shape that deployed uncapped and unrestarted.
    expect(services(yaml).wordpress.restart).toBe('unless-stopped');
    expect(services(yaml).wordpress.logging).toEqual({
      driver: 'json-file',
      options: CAP,
    });
    // Removing the early return must not have started routing it: no labels,
    // no per-service network, and no external network at the root.
    expect(yaml).not.toContain('traefik');
    expect(services(yaml).wordpress.networks).toBeUndefined();
    expect(parseComposeFile(yaml)?.networks).toBeUndefined();
  });

  it('still rejects an empty file on the isolated domainless path', () => {
    // `deployment-engine.service.ts` needs this to throw before the clone's
    // `rm -rf` touches the target, and `compose.service.ts` turns it into the
    // Converted tab's 400. The early return used to return '' instead.
    expect(() =>
      writeDomainsToCompose(source({ isolatedDeployment: true }), '', []),
    ).toThrow('Compose file is empty');
    expect(() => writeDomainsToCompose(source(), '', [])).toThrow(
      'Compose file is empty',
    );
  });

  it('leaves the injected Traefik labels in the order addDomainsToComposeSpec built them', () => {
    const yaml = writeDomainsToCompose(source(), BASE_COMPOSE, [domain()]);

    // `addDomainsToComposeSpec` splices by index (`labels.indexOf(...) + 1`,
    // `labels.splice(1, 0, …)`), so the label list is position-sensitive and a
    // second pass over the same services is exactly the shape that could
    // disturb it. Same expectation as the first test in this file.
    expect(services(yaml).wordpress.labels).toEqual([
      'traefik.enable=true',
      'traefik.docker.network=cloudgate-network',
      'traefik.http.routers.wp-stack-1-web.rule=Host(`blog.example.com`)',
      'traefik.http.routers.wp-stack-1-web.entrypoints=web',
      'traefik.http.services.wp-stack-1-web.loadbalancer.server.port=80',
      'traefik.http.routers.wp-stack-1-web.service=wp-stack-1-web',
    ]);
  });
});

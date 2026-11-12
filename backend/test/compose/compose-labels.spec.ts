import {
  DOCKER_LABEL_NAMESPACE,
  REFUSED_LABEL_NAMESPACES,
} from '../../src/native/docker-locks';
import { COMPOSE_REFUSED_LABEL_NAMESPACES } from '../../src/compose/compose-labels';
import {
  readComposeHostClaims,
  writeDomainsToCompose,
} from '../../src/compose/compose.utils';
import type {
  ComposeDomain,
  ComposeSpecSource,
} from '../../src/compose/compose.types';

// H-83: an author's own `traefik.*` router labels reach the deployed spec
// verbatim on every branch — `addDomainsToComposeSpec` only ever *adds*, and it
// leaves map-form labels untouched entirely. The static half of the guard lives
// at the emitter (`writeDomainsToCompose`), which is the one function every
// branch passes through: the raw injection in `deployment-engine.service.ts`,
// `getBuildComposeCommand` for every git flavour, and `GET /compose/:id/converted`.
//
// Ownership is decided elsewhere — a literal host is refused or admitted by
// `DomainsService.assertHostsUnclaimed`, which needs a database. What this
// layer refuses is everything no ownership query could ever make safe: a
// hostname pattern nobody can own, a rule that is not bounded to a hostname at
// all, a rule this parser cannot fully read, and a host literal that is not yet
// a hostname because compose has still to interpolate it.

const STACK: ComposeSpecSource = {
  appName: 'wp-stack',
  composeType: 'docker-compose',
  isolatedDeployment: false,
};

const SWARM_STACK: ComposeSpecSource = { ...STACK, composeType: 'stack' };

/** A compose file whose `web` service carries exactly the given label lines. */
const withListLabels = (...labels: string[]) => `services:
  web:
    image: nginx:alpine
    labels:
${labels.map((label) => `      - ${JSON.stringify(label)}`).join('\n')}
`;

/** The same labels in map form — what the injector documents it never touches. */
const withMapLabels = (labels: Record<string, string>) => `services:
  web:
    image: nginx:alpine
    labels:
${Object.entries(labels)
  .map(
    ([key, value]) => `      ${JSON.stringify(key)}: ${JSON.stringify(value)}`,
  )
  .join('\n')}
`;

/** Swarm reads labels from `deploy.labels`; the guard has to look there too. */
const withDeployLabels = (...labels: string[]) => `services:
  web:
    image: nginx:alpine
    deploy:
      labels:
${labels.map((label) => `        - ${JSON.stringify(label)}`).join('\n')}
`;

/**
 * `'verbatim'`, because every case in this file is about the guard's own
 * wording — which label it named and which hostname it quoted back.
 *
 * `writeDomainsToCompose` defaults to `'summary'`: its unnamed
 * caller is `DeploymentEngineService.deployCompose`, whose `catch` forwards
 * `error.message` to a customer-supplied webhook, and a refusal quotes an
 * `encryptedText` column. The summary form is asserted in
 * `compose-refusal-notification.spec.ts` against the sink that made it
 * necessary; here the argument is passed explicitly so that a reader of these
 * expectations knows which of the two they are reading.
 */
const convert = (content: string, stack: ComposeSpecSource = STACK) =>
  writeDomainsToCompose(stack, content, [], 'verbatim');

describe('compose label guard — hostname patterns nobody can own', () => {
  it('refuses a HostRegexp router rule', () => {
    expect(() =>
      convert(
        withListLabels(
          'traefik.enable=true',
          'traefik.http.routers.r.rule=HostRegexp(`^.+\\.example\\.com$`)',
        ),
      ),
    ).toThrow(/HostRegexp/);
  });

  it('refuses a HostSNIRegexp router rule on a tcp router', () => {
    expect(() =>
      convert(
        withListLabels('traefik.tcp.routers.r.rule=HostSNIRegexp(`^.+$`)'),
      ),
    ).toThrow(/HostSNIRegexp/);
  });

  it("refuses appwrite's wildcard-subdomain rule, the surface being closed", () => {
    // The real blueprint line, byte for byte (the published appwrite
    // blueprint's docker-compose.yml). Expected collateral, and intended: a claim
    // on every subdomain of a shared ingress is the takeover surface itself.
    expect(() =>
      convert(
        withListLabels(
          'traefik.enable=true',
          'traefik.constraint-label-stack=appwrite',
          'traefik.http.routers.appwrite-sites-wildcard.rule=HostRegexp(`^.+\\.${_APP_DOMAIN_SITES}$$`)',
        ),
      ),
    ).toThrow(/HostRegexp/);
  });
});

describe('compose label guard — rules not bounded to a hostname', () => {
  it('refuses a rule with no host matcher at all', () => {
    // `PathPrefix(`/`)` matches every hostname that reaches this Traefik.
    expect(() =>
      convert(withListLabels('traefik.http.routers.r.rule=PathPrefix(`/`)')),
    ).toThrow(/bounded to a hostname/);
  });

  it('refuses a disjunction whose other branch is unbounded', () => {
    expect(() =>
      convert(
        withListLabels(
          'traefik.http.routers.r.rule=Host(`mine.example.com`) || PathPrefix(`/`)',
        ),
      ),
    ).toThrow(/bounded to a hostname/);
  });

  it('refuses a negated host matcher', () => {
    expect(() =>
      convert(
        withListLabels('traefik.http.routers.r.rule=!Host(`mine.example.com`)'),
      ),
    ).toThrow(/bounded to a hostname/);
  });

  it('admits a conjunction, which can only narrow the host set', () => {
    expect(() =>
      convert(
        withListLabels(
          'traefik.http.routers.r.rule=Host(`mine.example.com`) && PathPrefix(`/api`)',
        ),
      ),
    ).not.toThrow();
  });

  it('admits a disjunction of host matchers', () => {
    expect(
      readComposeHostClaims(
        withListLabels(
          'traefik.http.routers.r.rule=Host(`a.example.com`) || Host(`b.example.com`)',
        ),
      ).map((claim) => claim.host),
    ).toEqual(['a.example.com', 'b.example.com']);
  });
});

describe('compose label guard — rules the parser cannot fully read', () => {
  it('refuses a rule that is not an expression at all', () => {
    expect(() =>
      convert(withListLabels('traefik.http.routers.r.rule=${RULE}')),
    ).toThrow(/could not be parsed/);
  });

  it('refuses an unbalanced rule', () => {
    expect(() =>
      convert(
        withListLabels('traefik.http.routers.r.rule=Host(`a.example.com`'),
      ),
    ).toThrow(/could not be parsed/);
  });

  it('refuses a matcher this Traefik does not have', () => {
    expect(() =>
      convert(
        withListLabels(
          'traefik.http.routers.r.rule=Host(`a.example.com`) && Frobnicate(`x`)',
        ),
      ),
    ).toThrow(/Frobnicate/);
  });

  it('refuses an empty rule', () => {
    expect(() =>
      convert(withListLabels('traefik.http.routers.r.rule=')),
    ).toThrow(/could not be parsed/);
  });
});

describe('compose label guard — host literals that are not yet hostnames', () => {
  it('refuses a host literal compose has still to interpolate', () => {
    // The whole point of checking ownership before the deploy is lost if the
    // value checked is not the value Docker sees: `${DOMAIN}` is settled from
    // the stack's own env file on the build server, after every check has run.
    expect(() =>
      convert(withListLabels('traefik.http.routers.r.rule=Host(`${DOMAIN}`)')),
    ).toThrow(/interpolat/i);
  });

  it('refuses a host literal that is not a hostname', () => {
    expect(() =>
      convert(
        withListLabels('traefik.http.routers.r.rule=Host(`not a hostname`)'),
      ),
    ).toThrow(/Invalid domain name/);
  });

  it('refuses a Host() with no argument', () => {
    expect(() =>
      convert(withListLabels('traefik.http.routers.r.rule=Host()')),
    ).toThrow(/could not be parsed/);
  });
});

describe('compose label guard — every place a label can hide', () => {
  it('reads map-form labels, which the injector leaves untouched', () => {
    expect(() =>
      convert(
        withMapLabels({
          'traefik.enable': 'true',
          'traefik.http.routers.r.rule': 'HostRegexp(`^.+$`)',
        }),
      ),
    ).toThrow(/HostRegexp/);
  });

  it('reads deploy.labels, where a swarm stack keeps its labels', () => {
    expect(() =>
      convert(
        withDeployLabels('traefik.http.routers.r.rule=HostRegexp(`^.+$`)'),
        SWARM_STACK,
      ),
    ).toThrow(/HostRegexp/);
  });

  it('reads deploy.labels on a docker-compose stack too', () => {
    expect(() =>
      convert(
        withDeployLabels('traefik.http.routers.r.rule=HostRegexp(`^.+$`)'),
      ),
    ).toThrow(/HostRegexp/);
  });

  it('reads labels on every service, not only the first', () => {
    expect(() =>
      convert(`services:
  a:
    image: nginx:alpine
  b:
    image: nginx:alpine
    labels:
      - "traefik.http.routers.r.rule=HostRegexp(\`^.+$\`)"
`),
    ).toThrow(/HostRegexp/);
  });

  it('matches the router-rule key case-insensitively, as Traefik does', () => {
    expect(() =>
      convert(withListLabels('Traefik.HTTP.Routers.R.Rule=HostRegexp(`^.+$`)')),
    ).toThrow(/HostRegexp/);
  });
});

describe('compose label guard — tls.domains certificate claims (H-85)', () => {
  // H-85. `tls.domains[*].main`/`.sans` is a *certificate* claim, not a routing
  // one, so `ROUTER_RULE_KEY` never read it — and it is reachable by a caller the
  // rule half has already admitted: route `Host(`mine.example.com`)`, which the
  // guard allows, then ask for a certificate for somebody else's hostname.
  //
  // Cloudgate writes this field nowhere (see the module docblock), so unlike the
  // rule half there is no generated shape to admit and the rule is unconditional.

  it('refuses a tls.domains main naming a hostname, so ownership is checked', () => {
    // Admitted or refused is the ownership half's answer; what this pins is that
    // the hostname is *extracted* rather than ignored.
    expect(
      readComposeHostClaims(
        withListLabels(
          'traefik.http.routers.r.rule=Host(`mine.example.com`)',
          'traefik.http.routers.r.tls.certresolver=letsencrypt',
          'traefik.http.routers.r.tls.domains[0].main=victim.example.com',
        ),
      ).map((claim) => claim.host),
    ).toEqual(['mine.example.com', 'victim.example.com']);
  });

  it('reports the claiming label, so a refusal can name it', () => {
    expect(
      readComposeHostClaims(
        withListLabels(
          'traefik.http.routers.r.tls.domains[0].main=victim.example.com',
        ),
      ),
    ).toEqual([
      {
        host: 'victim.example.com',
        label: 'traefik.http.routers.r.tls.domains[0].main',
      },
    ]);
  });

  it('treats every element of a comma-separated sans list as its own claim', () => {
    expect(
      readComposeHostClaims(
        withListLabels(
          'traefik.http.routers.r.tls.domains[0].sans=a.example.com,b.example.com, c.example.com',
        ),
      ).map((claim) => claim.host),
    ).toEqual(['a.example.com', 'b.example.com', 'c.example.com']);
  });

  it('reads every index of the domains slice, not only the first', () => {
    expect(
      readComposeHostClaims(
        withListLabels(
          'traefik.http.routers.r.tls.domains[0].main=a.example.com',
          'traefik.http.routers.r.tls.domains[1].main=b.example.com',
          'traefik.http.routers.r.tls.domains[12].sans=c.example.com',
        ),
      )
        .map((claim) => claim.host)
        .sort(),
    ).toEqual(['a.example.com', 'b.example.com', 'c.example.com']);
  });

  it("reads a tcp router's tls.domains too", () => {
    expect(
      readComposeHostClaims(
        withListLabels(
          'traefik.tcp.routers.r.tls.domains[0].main=sni.example.com',
        ),
      ).map((claim) => claim.host),
    ).toEqual(['sni.example.com']);
  });

  it('refuses a wildcard in main — the HostRegexp case, one field over', () => {
    expect(() =>
      convert(
        withListLabels(
          'traefik.http.routers.r.tls.domains[0].main=*.example.com',
        ),
      ),
    ).toThrow(/wildcard/i);
  });

  it('refuses a wildcard anywhere in a sans list', () => {
    expect(() =>
      convert(
        withListLabels(
          'traefik.http.routers.r.tls.domains[0].sans=ok.example.com,*.example.com',
        ),
      ),
    ).toThrow(/wildcard/i);
  });

  it('refuses a value compose has still to interpolate', () => {
    expect(() =>
      convert(
        withListLabels('traefik.http.routers.r.tls.domains[0].main=${DOMAIN}'),
      ),
    ).toThrow(/interpolat/i);
  });

  it('refuses a value that is not a hostname', () => {
    expect(() =>
      convert(
        withListLabels(
          'traefik.http.routers.r.tls.domains[0].main=not a hostname',
        ),
      ),
    ).toThrow(/Invalid domain name/);
  });

  it('refuses a tls.domains key that names no hostname at all', () => {
    expect(() =>
      convert(withListLabels('traefik.http.routers.r.tls.domains[0].main=')),
    ).toThrow(/names no hostname/);
  });

  it('refuses a tls.domains key shaped in a way this guard cannot read', () => {
    // Fail closed on the *key*, not only the value: a key in this family that
    // the strict pattern misses must be refused rather than skipped, or the
    // guard's coverage depends on having predicted every spelling. H-74's lesson
    // applied one level up.
    expect(() =>
      convert(
        withListLabels(
          'traefik.http.routers.r.tls.domains.0.main=victim.example.com',
        ),
      ),
    ).toThrow(/cannot read/i);
  });

  it('reads tls.domains in map form and in deploy.labels', () => {
    expect(
      readComposeHostClaims(
        withMapLabels({
          'traefik.http.routers.r.tls.domains[0].main': 'a.example.com',
        }),
      ).map((claim) => claim.host),
    ).toEqual(['a.example.com']);
    expect(
      readComposeHostClaims(
        withDeployLabels(
          'traefik.http.routers.r.tls.domains[0].main=b.example.com',
        ),
      ).map((claim) => claim.host),
    ).toEqual(['b.example.com']);
  });

  it('matches the tls.domains key case-insensitively, as Traefik does', () => {
    expect(
      readComposeHostClaims(
        withListLabels(
          'Traefik.HTTP.Routers.R.TLS.Domains[0].Main=a.example.com',
        ),
      ).map((claim) => claim.host),
    ).toEqual(['a.example.com']);
  });

  it('leaves the tls labels Cloudgate itself writes alone', () => {
    // `tls.certresolver` and `tls=true` are the two Cloudgate mints
    // (`createComposeDomainLabels`); neither names a hostname, so neither is a
    // claim and neither may be refused.
    expect(() =>
      convert(
        withListLabels(
          'traefik.http.routers.r.rule=Host(`mine.example.com`)',
          'traefik.http.routers.r.tls=true',
          'traefik.http.routers.r.tls.certresolver=letsencrypt',
          'traefik.http.routers.r.tls.options=modern@file',
        ),
      ),
    ).not.toThrow();
  });
});

describe('compose label guard — the com.docker namespace (H-82 on this path)', () => {
  it('refuses a com.docker label key', () => {
    expect(() =>
      convert(withListLabels('com.docker.compose.project=someone-elses-app')),
    ).toThrow(/com.docker/);
  });

  it('refuses a com.docker label key in map form', () => {
    expect(() =>
      convert(withMapLabels({ 'com.docker.compose.project': 'other' })),
    ).toThrow(/com.docker/);
  });

  it('takes the docker arm from the shared list rather than a second copy', () => {
    expect(COMPOSE_REFUSED_LABEL_NAMESPACES).toHaveLength(1);
    expect(COMPOSE_REFUSED_LABEL_NAMESPACES[0].pattern).toBe(
      DOCKER_LABEL_NAMESPACE,
    );
    expect(REFUSED_LABEL_NAMESPACES).toContain(
      COMPOSE_REFUSED_LABEL_NAMESPACES[0],
    );
  });

  it('does not refuse the traefik namespace wholesale', () => {
    // The gating answer: a blanket `traefik.*` refusal breaks the product's own
    // default catalogue, which is why H-56's shape cannot be copied here.
    expect(() => convert(withListLabels('traefik.enable=true'))).not.toThrow();
  });
});

describe('compose label guard — the default catalogue keeps working', () => {
  // Real label shapes from the published wikijs, qbittorrent, fivem and
  // crowdsec blueprints. None of these four carries a router rule; if the
  // guard breaks any of them, the guard is wrong, not the blueprint.

  it('wikijs deploys — traefik.enable plus a constraint label, unquoted', () => {
    expect(() =>
      convert(
        withListLabels(
          'traefik.enable=true',
          'traefik.constraint-label-stack=wikijs',
        ),
      ),
    ).not.toThrow();
  });

  it('qbittorrent deploys — a quoted traefik.enable and nothing else', () => {
    expect(() => convert(withListLabels('traefik.enable=true'))).not.toThrow();
  });

  it('fivem deploys — a quoted traefik.enable and nothing else', () => {
    expect(() => convert(withListLabels('traefik.enable=true'))).not.toThrow();
  });

  it('crowdsec deploys — its deliberate traefik.enable=false opt-out', () => {
    expect(() => convert(withListLabels('traefik.enable=false'))).not.toThrow();
  });

  it('a bare label key with no value is not a claim', () => {
    expect(() => convert(withListLabels('traefik.enable'))).not.toThrow();
  });

  it('a compose file with no labels at all deploys', () => {
    expect(() =>
      convert(`services:
  web:
    image: nginx:alpine
`),
    ).not.toThrow();
  });
});

describe('readComposeHostClaims', () => {
  it('reports the host a router rule claims, with the label that claims it', () => {
    expect(
      readComposeHostClaims(
        withListLabels(
          'traefik.enable=true',
          'traefik.http.routers.r.rule=Host(`mine.example.com`)',
        ),
      ),
    ).toEqual([
      {
        host: 'mine.example.com',
        label: 'traefik.http.routers.r.rule',
      },
    ]);
  });

  it('reports a HostSNI claim from a tcp router', () => {
    expect(
      readComposeHostClaims(
        withListLabels('traefik.tcp.routers.r.rule=HostSNI(`sni.example.com`)'),
      ).map((claim) => claim.host),
    ).toEqual(['sni.example.com']);
  });

  it('lowercases and trims a claim, because DNS and Traefik are case-blind', () => {
    expect(
      readComposeHostClaims(
        withListLabels(
          'traefik.http.routers.r.rule=Host(` MiNe.Example.COM `)',
        ),
      ).map((claim) => claim.host),
    ).toEqual(['mine.example.com']);
  });

  it('reports every claim across services, labels and deploy.labels', () => {
    expect(
      readComposeHostClaims(`services:
  a:
    image: nginx:alpine
    labels:
      - "traefik.http.routers.a.rule=Host(\`a.example.com\`)"
  b:
    image: nginx:alpine
    deploy:
      labels:
        "traefik.http.routers.b.rule": "Host(\`b.example.com\`)"
`)
        .map((claim) => claim.host)
        .sort(),
    ).toEqual(['a.example.com', 'b.example.com']);
  });

  it('reports nothing for a file that claims nothing', () => {
    expect(
      readComposeHostClaims(withListLabels('traefik.enable=true')),
    ).toEqual([]);
  });

  it('reports nothing for an empty file rather than throwing', () => {
    // `writeDomainsToCompose` owns the empty-file refusal; a guard that threw
    // its own message here would change which error the Converted tab shows.
    expect(readComposeHostClaims('')).toEqual([]);
  });
});

describe('compose label guard — Cloudgate’s own generated labels pass it', () => {
  // Load-bearing for `POST /compose/:id/start`, which runs the *converted* file
  // already on disk: the guard is run over content that already carries the
  // injector's output, so it must read those labels as ordinary claims and
  // admit them. It can, because a generated rule is `Host(...)` over a host
  // that came from this stack's own domain rows.
  const domain: ComposeDomain = {
    host: 'mine.example.com',
    serviceName: 'web',
    port: 80,
    https: true,
    uniqueConfigKey: 1,
    certificateType: 'letsencrypt',
    path: '/api',
    stripPath: false,
    internalPath: '/',
  } as unknown as ComposeDomain;

  it('re-reads its own converted output without refusing it', () => {
    const converted = writeDomainsToCompose(
      STACK,
      `services:
  web:
    image: nginx:alpine
`,
      [domain],
    );
    expect(converted).toContain('traefik.http.routers.');
    expect(() => convert(converted)).not.toThrow();
    expect(readComposeHostClaims(converted).map((claim) => claim.host)).toEqual(
      ['mine.example.com', 'mine.example.com'],
    );
  });
});

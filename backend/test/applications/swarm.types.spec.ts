import {
  endpointSpecSwarmSchema,
  labelsSwarmSchema,
  restartPolicySwarmSchema,
  updateConfigSwarmSchema,
  toEndpointProtocol,
  toPublishMode,
} from '../../src/applications/swarm.types';

/**
 * H-56. Every leaf of the Swarm service spec was a bare `z.string()`, and the
 * leaves reach the Docker service spec as values. Two of them are constrained
 * here at the schema: `labelsSwarm`, whose keys Traefik's default-install
 * `providers.docker` reads as router configuration, and `endpointSpec`'s
 * `Protocol`/`PublishMode`, which `mechanize.ts` used to `as`-cast to the
 * Docker union without checking.
 */
describe('labelsSwarmSchema', () => {
  /**
   * The live shape: a `traefik.http.routers…` label on one tenant's service is
   * a router the shared ingress honours. Reproduced end to end against
   * `traefik:v3.6.7` — a hijack router out-prioritised the file-provider router
   * Cloudgate writes and served the attacker's container for another tenant's
   * host. The namespace is refused whatever the rest of the key says.
   */
  const refusedKeys = [
    'traefik.enable',
    'traefik.http.routers.hijack.rule',
    'traefik.http.services.x.loadbalancer.server.port',
    'traefik.tcp.routers.y.rule',
    'traefik', // the bare segment
  ];

  it.each(refusedKeys)(
    'refuses a label in the traefik namespace: %s',
    (key) => {
      expect(labelsSwarmSchema.safeParse({ [key]: 'anything' }).success).toBe(
        false,
      );
    },
  );

  /**
   * Pre-emptive, and asserted as such: Traefik 3.6 lowercases a key before it
   * matches the prefix, so `TRAEFIK.` is inert today. The rule refuses it
   * anyway, against a future config that changes the provider's prefix — this
   * pins that coverage without claiming the uppercase form is a live break.
   */
  it('also refuses the namespace case-insensitively (pre-emptive)', () => {
    expect(
      labelsSwarmSchema.safeParse({ 'TRAEFIK.HTTP.routers.x.rule': 'v' })
        .success,
    ).toBe(false);
  });

  it('accepts an ordinary label whose key merely contains the word', () => {
    // `traefikish` is not the `traefik` segment, and a value naming traefik is
    // inert — only keys are configuration.
    const parsed = labelsSwarmSchema.safeParse({
      'com.acme.traefikish': 'v',
      role: 'traefik-adjacent',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an empty label map and ordinary keys', () => {
    expect(labelsSwarmSchema.safeParse({}).success).toBe(true);
    expect(
      labelsSwarmSchema.safeParse({ 'com.example.team': 'payments' }).success,
    ).toBe(true);
  });

  /**
   * H-82, the same shape one level down: a tenant's labels must not outrank
   * **Cloudgate's ownership model** any more than they may outrank another
   * tenant's router.
   *
   * `com.docker.swarm.service.name`, `com.docker.compose.project` and
   * `com.docker.stack.namespace` are the three keys that decide which
   * organization owns a container (`realtime/container-access.service.ts`
   * `OWNER_LABELS`, and the `docker ps` listing filter in
   * `docker-ops.service.ts`). They were accepted keys with **entirely
   * unconstrained values**, and `ContainerSpec.Labels` is what puts them on the
   * task containers `docker ps` then lists.
   *
   * Two reachable consequences, both proven at the parsers: a value containing
   * the ` | ` those listings are split on makes the row misparse, so the real
   * owner is discarded and replaced by a fragment; and a value naming another
   * organization's app makes the container claim an owner it does not have.
   *
   * The attack surface is a caller's **own** container either way — nobody can
   * label a container they do not own — which is why this is refused as
   * hardening rather than treated as a cross-tenant read.
   */
  const refusedDockerKeys = [
    'com.docker.compose.project',
    'com.docker.swarm.service.name',
    'com.docker.stack.namespace',
    'com.docker.compose.service',
    'com.docker.swarm.task.name',
    'com.docker', // the bare namespace
  ];

  it.each(refusedDockerKeys)(
    "refuses a label in docker's own namespace: %s",
    (key) => {
      expect(labelsSwarmSchema.safeParse({ [key]: 'anything' }).success).toBe(
        false,
      );
    },
  );

  /**
   * Anchored to a whole segment, so a key that merely *starts with* the letters
   * is still an ordinary label. `com.dockerish` is not `com.docker`.
   */
  it('accepts a key that only begins with the same letters', () => {
    expect(
      labelsSwarmSchema.safeParse({
        'com.dockerish.team': 'payments',
        'com.example.docker.note': 'inert',
      }).success,
    ).toBe(true);
  });
});

describe('labelsSwarmSchema and the reserved io.cloudgate namespace', () => {
  it('refuses a key in it, at the key, naming it with the reason', () => {
    const parsed = labelsSwarmSchema.safeParse({
      'io.cloudgate.environment': 'forged',
      team: 'payments',
    });

    expect(parsed.success).toBe(false);
    const issues = parsed.error?.issues ?? [];
    expect(issues.map((issue) => issue.path)).toEqual([
      ['io.cloudgate.environment'],
    ]);
    expect(issues[0].message).toMatch(
      /io\.cloudgate.*reserved.*offending label: io\.cloudgate\.environment/,
    );
  });

  it('accepts a key that only begins with the same letters', () => {
    expect(
      labelsSwarmSchema.safeParse({ 'io.cloudgateish.team': 'v' }).success,
    ).toBe(true);
  });
});

/**
 * The three free-text values are Docker's documented lists, and
 * the console's save refuses anything else at the field, with the list.
 */
describe('restartPolicySwarmSchema', () => {
  it.each(['none', 'on-failure', 'any'])('takes %s', (Condition) => {
    expect(restartPolicySwarmSchema.safeParse({ Condition }).success).toBe(
      true,
    );
  });

  it('refuses a condition outside Docker’s list, at Condition', () => {
    const parsed = restartPolicySwarmSchema.safeParse({ Condition: 'always' });

    const issues = parsed.error?.issues ?? [];
    expect(issues.map((issue) => issue.path)).toEqual([['Condition']]);
    expect(issues[0].message).toMatch(/none, on-failure or any/);
  });
});

describe('updateConfigSwarmSchema', () => {
  it('takes each order and failure action Docker documents', () => {
    for (const Order of ['stop-first', 'start-first']) {
      for (const FailureAction of ['pause', 'continue', 'rollback']) {
        expect(
          updateConfigSwarmSchema.safeParse({
            Parallelism: 1,
            Order,
            FailureAction,
          }).success,
        ).toBe(true);
      }
    }
  });

  it('refuses an order and a failure action outside Docker’s lists, each at its field', () => {
    const parsed = updateConfigSwarmSchema.safeParse({
      Parallelism: 1,
      Order: 'blue-green',
      FailureAction: 'retry',
    });

    const messages = Object.fromEntries(
      (parsed.error?.issues ?? []).map((issue) => [
        issue.path.join('.'),
        issue.message,
      ]),
    );
    expect(Object.keys(messages).sort()).toEqual(['FailureAction', 'Order']);
    expect(messages.Order).toMatch(/stop-first or start-first/);
    expect(messages.FailureAction).toMatch(/pause, continue or rollback/);
  });
});

describe('endpointSpecSwarmSchema', () => {
  it('accepts the Docker protocol and publish-mode unions', () => {
    const parsed = endpointSpecSwarmSchema.safeParse({
      Ports: [
        { Protocol: 'tcp', PublishMode: 'ingress', TargetPort: 80 },
        { Protocol: 'udp', PublishMode: 'host', TargetPort: 53 },
        { Protocol: 'sctp', TargetPort: 9 },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a Protocol outside the Docker union', () => {
    expect(
      endpointSpecSwarmSchema.safeParse({
        Ports: [{ Protocol: 'http', TargetPort: 80 }],
      }).success,
    ).toBe(false);
  });

  it('refuses a PublishMode outside the Docker union', () => {
    expect(
      endpointSpecSwarmSchema.safeParse({
        Ports: [{ PublishMode: 'nodeport', TargetPort: 80 }],
      }).success,
    ).toBe(false);
  });
});

/**
 * The emitter-side half of the endpointSpec fix (H-56): `mechanize.ts` reads a
 * stored value that a `.partial()` PATCH or a pre-rule row could have left
 * outside the union, and used to `as`-cast it straight to the Docker API. These
 * narrowers do the cast with a membership check instead, so only a union member
 * ever leaves.
 */
describe('toEndpointProtocol', () => {
  it('passes a Docker protocol through unchanged', () => {
    expect(toEndpointProtocol('udp')).toBe('udp');
    expect(toEndpointProtocol('sctp')).toBe('sctp');
  });

  it('defaults an absent or out-of-union value to tcp rather than casting it', () => {
    expect(toEndpointProtocol(undefined)).toBe('tcp');
    expect(toEndpointProtocol('')).toBe('tcp');
    expect(toEndpointProtocol('http')).toBe('tcp');
  });
});

describe('toPublishMode', () => {
  it('passes a Docker publish mode through unchanged', () => {
    expect(toPublishMode('ingress')).toBe('ingress');
    expect(toPublishMode('host')).toBe('host');
  });

  it('defaults an absent or out-of-union value to host rather than casting it', () => {
    expect(toPublishMode(undefined)).toBe('host');
    expect(toPublishMode('nodeport')).toBe('host');
  });
});

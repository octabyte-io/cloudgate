import { z } from 'zod';
import { SetupWebMonitoringBodyDto } from '../../src/admin/dto/admin.dto';
import { SetupMonitoringBodyDto } from '../../src/monitoring/dto/monitoring.dto';

/**
 * The claim the console is built on, checked rather than assumed.
 *
 * `frontend/src/lib/api/endpoints/monitoring.ts` declares **one**
 * `MetricsConfigInput` for `POST /monitoring/servers/:serverId/setup` and
 * `POST /admin/setup-monitoring`, and says why in as many words: *"One type for
 * both routes because the two zod schemas are identical, member for member and
 * refusal for refusal … That is checked rather than assumed: it is what lets
 * one form serve both hosts."* Nothing checked it. `MonitoringSetupModal` is
 * that one form, `metricsFields` its one field list and `toMetricsConfig` its
 * one body builder, so a divergence is not a tidiness note — it is the console
 * sending a body one of its two hosts refuses.
 *
 * And they had diverged. An earlier fix made `token` optional on the admin schema, for
 * the three cases ADR 0019's write-path consequence requires — omitted keeps,
 * `''` clears, anything else rotates — and left `token: z.string()` required on
 * the per-Server one. That was invisible until the fix projected the token out of
 * the nested `server` on a service read, which is the shape `toMetricsConfig`
 * omits the field for. So the console's shared form could build a body the
 * per-Server route answered `400` to, on the one route whose read had just
 * stopped carrying the value it would otherwise have re-submitted.
 *
 * **Derived, not tabulated.** The battery is generated from the leaf paths of a
 * valid body — omit each, null it, wrong-type it, empty-string it, zero and
 * negative it — so a field added to either schema is exercised with no edit
 * here, which is the property the two docblocks in `dto/` cannot state about
 * each other. What is asserted is agreement and never a particular verdict:
 * this file is deliberately silent on whether a given body *should* be refused,
 * because that is each schema's own docblock's business and pinning it twice is
 * how the two would drift again in the other direction.
 *
 * The one difference that is not a divergence is the `type` discriminator,
 * which **neither** schema accepts — the per-Server route forces `'Remote'` and
 * the instance-wide one `'Cloudgate'`, in the service and not in validation — so
 * there is nothing here for a body to disagree about.
 */

type Schema = z.ZodType<unknown, unknown>;

const perServer = SetupMonitoringBodyDto.schema as unknown as Schema;
const webServer = SetupWebMonitoringBodyDto.schema as unknown as Schema;

/** A body both schemas accept, and the base every mutation below is one edit from. */
const validBody = () => ({
  metricsConfig: {
    server: {
      refreshRate: 60,
      port: 4500,
      token: 'metrics-token-1',
      urlCallback: 'http://cloudgate.example.com/api/notifications/receive',
      retentionDays: 2,
      cronJob: '0 0 * * *',
      thresholds: { cpu: 70, memory: 80 },
    },
    containers: {
      refreshRate: 60,
      services: { include: ['api'], exclude: ['sidecar'] },
    },
  },
});

/** The dotted leaf paths of a value. Arrays are leaves. */
function leavesOf(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) =>
    leavesOf(v, prefix ? `${prefix}.${key}` : key),
  );
}

/** A deep clone of `body` with `path` set to `value`, or deleted for `OMIT`. */
const OMIT = Symbol('omit');
function mutate(body: unknown, path: string, value: unknown): unknown {
  const clone = structuredClone(body) as Record<string, unknown>;
  const keys = path.split('.');
  let node = clone;
  for (const key of keys.slice(0, -1)) {
    node = node[key] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1];
  if (value === OMIT) delete node[last];
  else node[last] = value;
  return clone;
}

/** Every edit applied at every leaf: one body, one label. */
function battery(): { label: string; body: unknown }[] {
  const cases: { label: string; body: unknown }[] = [
    { label: 'the valid body', body: validBody() },
    { label: 'no metricsConfig at all', body: {} },
    { label: 'metricsConfig null', body: { metricsConfig: null } },
  ];
  const edits: [string, unknown][] = [
    ['omitted', OMIT],
    ['null', null],
    ['a number where it may not be', 7],
    ['a string where it may not be', 'x'],
    ['an empty string', ''],
    ['zero', 0],
    ['negative', -1],
    ['one', 1],
    ['an empty array', []],
    ['an object', {}],
  ];
  for (const path of leavesOf(validBody())) {
    for (const [label, value] of edits) {
      cases.push({
        label: `${path} ${label}`,
        body: mutate(validBody(), path, value),
      });
    }
  }
  return cases;
}

/** `{ ok }` for a refusal, `{ ok, parsed }` for an acceptance. */
function verdict(schema: Schema, body: unknown) {
  const result = schema.safeParse(body);
  return result.success
    ? { ok: true, parsed: JSON.stringify(result.data) }
    : { ok: false };
}

describe('SetupMonitoringBodyDto agrees with SetupWebMonitoringBodyDto, member for member and refusal for refusal', () => {
  const cases = battery();

  /**
   * The premise. A battery that accepted everything, or refused everything,
   * would make the agreement assertion below vacuous — which is exactly what a
   * schema pair compared by `toEqual` on their internals can degenerate into
   * when zod changes shape underneath.
   */
  it('is a battery with both verdicts in it', () => {
    const verdicts = cases.map(({ body }) => verdict(perServer, body).ok);

    expect({
      total: cases.length > 100,
      accepted: verdicts.filter(Boolean).length > 0,
      refused: verdicts.filter((ok) => !ok).length > 0,
    }).toEqual({ total: true, accepted: true, refused: true });
  });

  it('answers every body in the battery identically', () => {
    // Named rather than diffed: the failure says which body, and what each
    // route did with it, instead of printing two zod trees.
    const disagreements = cases
      .map(({ label, body }) => ({
        label,
        perServer: verdict(perServer, body),
        webServer: verdict(webServer, body),
      }))
      .filter(
        ({ perServer: a, webServer: b }) =>
          JSON.stringify(a) !== JSON.stringify(b),
      );

    expect(disagreements).toEqual([]);
  });

  /**
   * The three cases spelled out, because they are the ones that diverged and
   * the ones the console depends on. Not a second copy of the assertion above:
   * that one says the two routes agree, and this one says *what* they agree on,
   * so a change that made both required would still be caught here.
   */
  it('takes an omitted token, an empty one and a value on both routes', () => {
    const withToken = (token: unknown) =>
      mutate(validBody(), 'metricsConfig.server.token', token);

    for (const [label, schema] of [
      ['per-Server', perServer],
      ['web server', webServer],
    ] as const) {
      expect({
        label,
        omitted: verdict(schema, withToken(OMIT)).ok,
        empty: verdict(schema, withToken('')).ok,
        value: verdict(schema, withToken('metrics-token-2')).ok,
      }).toEqual({ label, omitted: true, empty: true, value: true });
    }
  });

  /**
   * Neither accepts the discriminator, which is why the two schemas can be
   * identical at all while the two routes write different values for it.
   */
  it('accepts no `type` from either caller', () => {
    const withType = mutate(
      validBody(),
      'metricsConfig.server.type',
      'Cloudgate',
    );

    for (const [label, schema] of [
      ['per-Server', perServer],
      ['web server', webServer],
    ] as const) {
      const parsed = verdict(schema, withType);
      expect({ label, carriesType: parsed.parsed?.includes('"type"') }).toEqual(
        {
          label,
          carriesType: false,
        },
      );
    }
  });
});

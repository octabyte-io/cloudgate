import {
  exclusionsForAppName,
  partialExclusionsForAppName,
} from '../../src/monitoring/collectors/container-stats.collector';
import {
  ownerCandidates,
  unresolvedAppNameRefusal,
} from '../../src/monitoring/monitoring.service';
import { defaultMetricsConfig } from '../../src/servers/server.schema';
import type { MetricsConfig } from '../../src/servers/server.schema';

/**
 * What `GET /monitoring/metrics/containers` says about a name it cannot resolve.
 *
 * The route resolves an `appName` against **stored rows**, so a name the
 * operator excluded and a name nobody has ever heard of are the same "no rows"
 * to it — and it refused both with one sentence offering two causes: nothing
 * running matches the name, or the first sample has not landed yet. Driven on a
 * box with the name in both boxes of the setup dialog: `docker ps` showed
 * `app-nk3zbo.1.yzdmso… Up 3 days`, `docker service ls` showed `app-nk3zbo 1/1`,
 * and `container_metric` held 0 rows for it against 21 for the included service
 * beside it. So the first cause was false, the second was false for ever, and
 * the one cause that was true — the exclusion two fields above — was the only
 * one not offered.
 *
 * The sentence is what is worth pinning, so the sentence is what is exported and
 * tested: reaching it through `MonitoringService.getContainerMetrics` would mean
 * faking a database, which is not a boundary. That the route really reaches this
 * function is pinned in `monitoring.e2e-spec.ts`, against a real Postgres.
 *
 * Configs are written out from `defaultMetricsConfig` with only the two lists
 * replaced, so a wrong expectation cannot agree with the code by sharing a
 * factory with it.
 */
function configWith(services: {
  include: string[];
  exclude: string[];
}): MetricsConfig {
  return {
    ...defaultMetricsConfig,
    containers: { ...defaultMetricsConfig.containers, services },
  };
}

describe('unresolvedAppNameRefusal', () => {
  it('names the exclusion for a name the operator put in both lists', () => {
    const message = unresolvedAppNameRefusal(
      'app-nk3zbo',
      configWith({
        include: ['app-t64tnx', 'app-nk3zbo'],
        exclude: ['app-nk3zbo'],
      }),
    );

    expect(message).toContain('"app-nk3zbo"');
    expect(message).toContain('exclude list');
    expect(message).toContain('an exclusion beats an inclusion');
    expect(message).toContain('nothing will be until that entry is removed');
    // The two causes that are false here, neither of which may survive: the
    // container is running, and no first sample is ever coming.
    expect(message).not.toContain('nothing running here that you can read');
    expect(message).not.toContain('has not stored its first sample yet');
  });

  it('quotes the entry that matched, which is not always the name asked for', () => {
    // The lists match as substrings, so the entry an operator has to go and
    // delete can be shorter than the service they were looking for.
    const message = unresolvedAppNameRefusal(
      'app-nk3zbo',
      configWith({ include: ['app-nk3zbo'], exclude: ['nk3zbo', 'buildkit'] }),
    );

    expect(message).toContain('"nk3zbo"');
    expect(message).not.toContain('buildkit');
  });

  it('names an entry that excludes only some replicas, without claiming all of them', () => {
    // The console's picker displays `app-nk3zbo` with `.1` beside it, so a `.1`
    // entry is what an operator reading that list types. It excludes replica 1
    // and says nothing about replica 2 — so the entry is named as *a* cause and
    // the two original causes stay on as the alternatives they still are.
    const message = unresolvedAppNameRefusal(
      'app-nk3zbo',
      configWith({ include: ['app-nk3zbo'], exclude: ['app-nk3zbo.1'] }),
    );

    expect(message).toContain('"app-nk3zbo.1"');
    expect(message).toContain('not necessarily all');
    expect(message).toContain('it may be the reason');
    expect(message).toContain(
      'Otherwise nothing running here that you can read matches that name',
    );
    // The certain sentence's promise is exactly what this case may not make.
    expect(message).not.toContain('never collected');
    expect(message).not.toContain(
      'nothing will be until that entry is removed',
    );
  });

  it('prefers the certain sentence when both kinds of entry are present', () => {
    // `nk3zbo` catches everything `app-nk3zbo` can reach, so the hedge would be
    // an understatement: the stronger true sentence wins.
    const message = unresolvedAppNameRefusal(
      'app-nk3zbo',
      configWith({
        include: ['app-nk3zbo'],
        exclude: ['app-nk3zbo.1', 'nk3zbo'],
      }),
    );

    expect(message).toContain('nothing will be until that entry is removed');
    expect(message).toContain('"nk3zbo"');
    expect(message).not.toContain('not necessarily all');
  });

  it('keeps the two-cause sentence for a name that is not excluded', () => {
    const message = unresolvedAppNameRefusal(
      'redis-12sp3x',
      configWith({ include: ['app-nk3zbo'], exclude: ['buildkit'] }),
    );

    expect(message).toBe(
      'No container you can read has been sampled under "redis-12sp3x" on ' +
        'this server. Either nothing running here that you can read matches ' +
        'that name, or collection has not stored its first sample yet.',
    );
  });

  /**
   * A target whose collection was stopped (token cleared, the setup's
   * `cronJob` kept) is not going to store a first sample, so "not stored its
   * first sample yet" is the one cause that cannot be true — the stop is.
   */
  it('names the stop, not a first sample to come, for a stopped target', () => {
    const stopped: MetricsConfig = {
      server: { ...defaultMetricsConfig.server, cronJob: '0 3 * * *' },
      containers: {
        ...defaultMetricsConfig.containers,
        services: { include: ['app-nk3zbo'], exclude: [] },
      },
    };

    expect(unresolvedAppNameRefusal('redis-12sp3x', stopped)).toBe(
      'No container you can read has been sampled under "redis-12sp3x" on ' +
        'this server. Either nothing running here that you can read matches ' +
        'that name, or it was not sampled before collection on this target ' +
        'was stopped — nothing new is stored until it is started again.',
    );
  });

  it('keeps it for a target whose config could not be read at all', () => {
    // `findTarget` answers undefined for a web server that has no settings row
    // yet. Nothing is known about exclusions then, so nothing is claimed.
    expect(unresolvedAppNameRefusal('app-nk3zbo', undefined)).toContain(
      'Either nothing running here that you can read matches that name',
    );
  });

  it('hedges the same way for a broad include and one excluded service', () => {
    // The same relation seen from the other end: `app` included and
    // `app-nk3zbo` excluded catches some containers under `app` and not others.
    const message = unresolvedAppNameRefusal(
      'app',
      configWith({ include: ['app'], exclude: ['app-nk3zbo'] }),
    );

    expect(message).toContain('"app-nk3zbo"');
    expect(message).toContain('not necessarily all');
    expect(message).toContain(
      'Otherwise nothing running here that you can read matches that name',
    );
  });

  it('claims nothing from an entry that neither contains the name nor is contained by it', () => {
    // `app-nk` asked about and `nk3zbo` excluded: a container named
    // `app-nk3zbo.1.…` contains both, so the entry really could be suppressing
    // this name — and deciding that needs the container listing, which is the
    // one thing a refusal for "nothing was ever stored" does not have. The
    // recorded boundary in `partialExclusionsForAppName`: containment is where
    // certainty about the config ends.
    const message = unresolvedAppNameRefusal(
      'app-nk',
      configWith({ include: ['app-nk'], exclude: ['nk3zbo'] }),
    );

    expect(message).toBe(
      'No container you can read has been sampled under "app-nk" on this ' +
        'server. Either nothing running here that you can read matches that ' +
        'name, or collection has not stored its first sample yet.',
    );
  });

  /**
   * The route answers a name the caller may not read exactly as it answers a
   * name nothing matches (ADR-0067, ADR-0008), so this sentence is the refusal
   * too: it may not claim that nothing was sampled, only that nothing *this
   * caller can read* was.
   */
  it('never claims that nothing was sampled, whatever arm answers', () => {
    const answers = [
      unresolvedAppNameRefusal('shop-web', undefined),
      unresolvedAppNameRefusal(
        'shop-web',
        configWith({ include: ['shop'], exclude: ['shop-web.1'] }),
      ),
      unresolvedAppNameRefusal(
        'shop-web',
        configWith({ include: ['shop'], exclude: ['buildkit'] }),
      ),
    ];

    for (const answer of answers) {
      expect(answer).not.toContain('ever been sampled');
      expect(answer).toMatch(
        /^No container you can read has been sampled under "shop-web" on this server\. /,
      );
    }
  });

  /**
   * The platform host's config is the operator's (ADR-0013), so a caller
   * without instance authority is answered without it: the route hands
   * `undefined` in, and nothing about the exclude list or a stopped collection
   * comes out.
   */
  it('says nothing about the config it was not handed', () => {
    const message = unresolvedAppNameRefusal('shop-web', undefined);

    expect(message).not.toContain('exclude list');
    expect(message).not.toContain('stopped');
  });
});

/**
 * The rule underneath it, beside `shouldMonitorContainer` because it is that
 * rule asked backwards — with an `appName` in hand instead of a container.
 */
describe('exclusionsForAppName', () => {
  it('matches an entry that is a substring of the name, as collection does', () => {
    expect(exclusionsForAppName('app-nk3zbo', ['nk3zbo'])).toEqual(['nk3zbo']);
    expect(exclusionsForAppName('app-nk3zbo', ['app-nk3zbo'])).toEqual([
      'app-nk3zbo',
    ]);
  });

  it('does not let a blank entry exclude the world', () => {
    // '' is a substring of every string; a line of whitespace in the textarea
    // survives as far as the stored config.
    expect(exclusionsForAppName('app-nk3zbo', ['', '   '])).toEqual([]);
  });

  it('is empty for a config that carries no exclude list', () => {
    expect(exclusionsForAppName('app-nk3zbo', undefined)).toEqual([]);
  });

  it('keeps the certain and the partial arm disjoint', () => {
    // An equal entry is certain and must not also be reported as partial:
    // `a.includes(e) && e.includes(a)` holds only when the two are the same.
    const exclude = ['app-nk3zbo'];

    expect(exclusionsForAppName('app-nk3zbo', exclude)).toEqual(['app-nk3zbo']);
    expect(partialExclusionsForAppName('app-nk3zbo', exclude)).toEqual([]);
  });

  it('reports an entry the name sits inside as partial, and never as certain', () => {
    const exclude = ['app-nk3zbo.1'];

    expect(exclusionsForAppName('app-nk3zbo', exclude)).toEqual([]);
    expect(partialExclusionsForAppName('app-nk3zbo', exclude)).toEqual([
      'app-nk3zbo.1',
    ]);
  });

  it('does not let a blank entry look like a partial match either', () => {
    expect(partialExclusionsForAppName('app-nk3zbo', ['', '  '])).toEqual([]);
  });
});

/**
 * The names a stored series could have been deployed under, which the metrics
 * read hands to the container gate to decide whether the caller may read it.
 * A container is named *after* its Service, so the Service's name is a
 * prefix of the series ending right before a `-` or `_`.
 */
describe('ownerCandidates', () => {
  it("maps an Application's series to its own name", () => {
    expect(ownerCandidates('app-x1y2z3')).toEqual(['app-x1y2z3', 'app']);
  });

  it("maps a compose replica's series to its project", () => {
    expect(ownerCandidates('proj-x1y2z3-web-1')).toContain('proj-x1y2z3');
  });

  it("maps a stack service's series to its namespace", () => {
    expect(ownerCandidates('proj-x1y2z3_web')).toContain('proj-x1y2z3');
  });

  it('never offers an empty name', () => {
    expect(ownerCandidates('-a_b')).toEqual(['-a_b', '-a']);
  });
});

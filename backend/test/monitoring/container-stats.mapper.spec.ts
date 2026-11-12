import {
  DOCKER_STATS_COMMAND,
  getServiceName,
  parseContainerStatsOutput,
  shouldMonitorContainer,
} from '../../src/monitoring/collectors/container-stats.collector';

// One docker stats line in the Go agent's --format shape; expectations are
// worked by hand through processContainerMetrics (monitor.go): '%' trimmed,
// MiB/GiB relabeled MB/GB, net/block units kept verbatim (kB stays kB).
const STATS_LINE = JSON.stringify({
  BlockIO: '1.2MB / 3.4MB',
  CPUPerc: '12.34%',
  ID: 'abc123',
  MemPerc: '25.50%',
  MemUsage: '512.5MiB / 2GiB',
  Name: 'testapp-x1',
  NetIO: '1.45kB / 656B',
});

const services = { include: ['testapp'], exclude: [] };

/** The same line under another name and id — what one `docker stats` tick is. */
function lineFor(name: string, id: string): string {
  return STATS_LINE.replace('"ID":"abc123"', `"ID":"${id}"`).replace(
    '"Name":"testapp-x1"',
    `"Name":"${name}"`,
  );
}

describe('parseContainerStatsOutput', () => {
  it('maps a docker stats line to the Go agent record shape', () => {
    const [record] = parseContainerStatsOutput(STATS_LINE, services);

    expect(record).toEqual({
      CPU: 12.34,
      Memory: {
        percentage: 25.5,
        used: 512.5,
        total: 2,
        usedUnit: 'MB',
        totalUnit: 'GB',
      },
      Network: {
        input: 1.45,
        output: 656,
        inputUnit: 'kB',
        outputUnit: 'B',
      },
      BlockIO: {
        read: 1.2,
        write: 3.4,
        readUnit: 'MB',
        writeUnit: 'MB',
      },
      Container: 'abc123',
      ID: 'abc123',
      Name: 'testapp-x1',
    });
  });

  /**
   * The fixture is two **Swarm task names**, which is what this test claimed to
   * be about and was not: it used `testapp-x1` / `testapp-x2`, names no runtime
   * in this product produces. A swarm task is `<service>.<replica>.<id>`.
   */
  it('keeps only the first container per service name (swarm replicas)', () => {
    const output = [
      lineFor('testapp.1.t6gam9u4jp96f6iecyjqjb6te', 'abc123'),
      lineFor('testapp.2.nm80qhkq0z5v7f2yv4c1x9r3s', 'def456'),
    ].join('\n');

    const records = parseContainerStatsOutput(output, services);
    expect(records).toHaveLength(1);
    expect(records[0].ID).toBe('abc123');
  });

  /**
   * **This is the box's own measurement, as a test**. Two Applications on
   * one host, both included, both printed by `docker stats`: over 102 collection
   * ticks exactly 102 rows were stored, and `app-zk77rz` was sampled zero times
   * while `app-cslg4y` reached 79. Both task names reduced to `app`, so the
   * dedup dropped the second for ever.
   *
   * The expected names are written out rather than derived, so this cannot pass
   * by agreeing with whatever `getServiceName` happens to compute (§1.7).
   */
  it('stores every Application when one tick sees two swarm services', () => {
    const output = [
      lineFor('app-cslg4y.1.t6gam9u4jp96f6iecyjqjb6te', 'abc123'),
      lineFor('app-zk77rz.1.nm80qhkq0z5v7f2yv4c1x9r3s', 'def456'),
    ].join('\n');

    const records = parseContainerStatsOutput(output, {
      include: ['app-cslg4y', 'app-zk77rz'],
      exclude: [],
    });

    expect(records.map((record) => record.Name)).toEqual([
      'app-cslg4y.1.t6gam9u4jp96f6iecyjqjb6te',
      'app-zk77rz.1.nm80qhkq0z5v7f2yv4c1x9r3s',
    ]);
    expect(records.map((record) => record.ID)).toEqual(['abc123', 'def456']);
  });

  /** The platform host's own containers collapsed onto `cloudgate` too. */
  it('stores two platform containers that share a dash-delimited prefix', () => {
    const output = [
      lineFor('cloudgate-traefik', 'aaa111'),
      lineFor('cloudgate-postgres', 'bbb222'),
    ].join('\n');

    const records = parseContainerStatsOutput(output, {
      include: ['cloudgate-'],
      exclude: [],
    });

    expect(records.map((record) => record.Name)).toEqual([
      'cloudgate-traefik',
      'cloudgate-postgres',
    ]);
  });

  it('drops containers not matched by include and skips broken lines', () => {
    const output = [
      'not json',
      STATS_LINE.replace('"Name":"testapp-x1"', '"Name":"other-app-1"'),
      STATS_LINE,
    ].join('\n');

    const records = parseContainerStatsOutput(output, services);
    expect(records).toHaveLength(1);
    expect(records[0].Name).toBe('testapp-x1');
  });
});

describe('shouldMonitorContainer', () => {
  it('exclude wins over include, include empty means monitor everything', () => {
    expect(
      shouldMonitorContainer('web-redis-1', {
        include: ['web'],
        exclude: ['redis'],
      }),
    ).toBe(false);
    expect(
      shouldMonitorContainer('api-1', { include: ['web'], exclude: [] }),
    ).toBe(false);
    expect(
      shouldMonitorContainer('anything-1', { include: [], exclude: [] }),
    ).toBe(true);
  });
});

describe('getServiceName', () => {
  /**
   * Every expectation here is a name copied from a real box and a service name
   * read off it by eye — not one recomputed by splitting the string the way the
   * function does (§1.7). `app-<6 chars>` is how Cloudgate names an
   * Application's swarm service, so these two are the pair the bug was measured on.
   */
  it('reduces a swarm task name to the service that owns it', () => {
    expect(getServiceName('app-cslg4y.1.t6gam9u4jp96f6iecyjqjb6te')).toBe(
      'app-cslg4y',
    );
    expect(getServiceName('app-zk77rz.1.nm80qhkq0z5v7f2yv4c1x9r3s')).toBe(
      'app-zk77rz',
    );
    expect(getServiceName('/mystack_web.3.abcdefghijklmnopqrstuvwxy')).toBe(
      'mystack_web',
    );
  });

  it('reduces two replicas of one swarm service to one name', () => {
    expect(getServiceName('app-cslg4y.1.t6gam9u4jp96f6iecyjqjb6te')).toBe(
      getServiceName('app-cslg4y.2.nm80qhkq0z5v7f2yv4c1x9r3s'),
    );
  });

  it('drops a compose replica index and keeps the rest of the name', () => {
    expect(getServiceName('/web-app-1')).toBe('web-app');
    expect(getServiceName('myproj-web-12')).toBe('myproj-web');
    expect(getServiceName('single')).toBe('single');
  });

  /**
   * Nothing after the last dash is a replica index here, so nothing is dropped.
   * The old rule dropped it anyway and folded these two onto `cloudgate`, which
   * is the platform host's half of the bug.
   */
  it('keeps a dash-delimited name that carries no replica index', () => {
    expect(getServiceName('cloudgate-traefik')).toBe('cloudgate-traefik');
    expect(getServiceName('cloudgate-postgres')).toBe('cloudgate-postgres');
    expect(getServiceName('redis-cache')).toBe('redis-cache');
  });
});

describe('DOCKER_STATS_COMMAND', () => {
  it('uses the Go agent format string verbatim', () => {
    expect(DOCKER_STATS_COMMAND).toBe(
      `docker stats --no-stream --format '{"BlockIO":"{{.BlockIO}}","CPUPerc":"{{.CPUPerc}}","ID":"{{.ID}}","MemPerc":"{{.MemPerc}}","MemUsage":"{{.MemUsage}}","Name":"{{.Name}}","NetIO":"{{.NetIO}}"}'`,
    );
  });
});

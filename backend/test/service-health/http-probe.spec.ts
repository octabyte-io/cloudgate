import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  classifyProbeError,
  KEYWORD_READ_LIMIT_BYTES,
  probeHttp,
  statusIsExpected,
} from '../../src/service-health/http-probe';
import { probeTcp } from '../../src/service-health/tcp-probe';

/**
 * The HTTP Probe against a real loopback server: up or down and never a
 * third state, with the short class a down Probe is recorded as.
 */
describe('probeHttp', () => {
  let server: Server;
  let base: string;
  const options = { timeoutMs: 500, expectedStatuses: ['2xx'] };

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/hang') return;
      const status = Number(req.url?.slice(1)) || 200;
      res.statusCode = status;
      res.end('secret body');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('connects to the address it is given, asking for the Domain by name', async () => {
    const port = (server.address() as AddressInfo).port;
    let host: string | undefined;
    server.once('request', (req) => {
      host = req.headers.host;
    });

    // A name nothing resolves: the Probe reaches the server only by dialling
    // the address the guard checked, with no lookup of its own.
    const outcome = await probeHttp(
      new URL(`http://shop.unresolvable.invalid:${port}/204`),
      { ...options, address: '127.0.0.1' },
    );

    expect(outcome).toMatchObject({ verdict: 'up', errorClass: null });
    expect(host).toBe(`shop.unresolvable.invalid:${port}`);
  });

  it('reads a 2xx as up with its latency', async () => {
    const outcome = await probeHttp(new URL(`${base}/204`), options);

    expect(outcome).toMatchObject({ verdict: 'up', errorClass: null });
    expect(outcome.latencyMs).toEqual(expect.any(Number));
  });

  it('reads an unexpected status as down, naming the status and nothing of the body', async () => {
    const outcome = await probeHttp(new URL(`${base}/503`), options);

    expect(outcome).toMatchObject({
      verdict: 'down',
      errorClass: 'status 503',
    });
    expect(JSON.stringify(outcome)).not.toContain('secret');
  });

  it('reads a status the operator listed as up, redirects included', async () => {
    const outcome = await probeHttp(new URL(`${base}/301`), {
      ...options,
      expectedStatuses: ['2xx', '301'],
    });

    expect(outcome.verdict).toBe('up');
  });

  it('reads a server that never answers as down with timeout', async () => {
    const outcome = await probeHttp(new URL(`${base}/hang`), options);

    expect(outcome).toEqual({
      verdict: 'down',
      latencyMs: null,
      errorClass: 'timeout',
    });
  });

  it('reads a refused connection as down with refused', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, '127.0.0.1', resolve),
    );
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));

    const outcome = await probeHttp(
      new URL(`http://127.0.0.1:${port}/`),
      options,
    );

    expect(outcome).toEqual({
      verdict: 'down',
      latencyMs: null,
      errorClass: 'refused',
    });
  });

  it('reads a host DNS cannot resolve as down with dns', async () => {
    const outcome = await probeHttp(
      new URL('http://cloudgate-uptime-check.invalid/'),
      { ...options, timeoutMs: 5000 },
    );

    expect(outcome).toMatchObject({ verdict: 'down', errorClass: 'dns' });
  });
});

describe('probeHttp with a keyword and a header', () => {
  let server: Server;
  let base: string;
  const options = { timeoutMs: 500, expectedStatuses: ['2xx'] };

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/echo') {
        res.end(`got ${String(req.headers['x-probe-token'] ?? 'nothing')}`);
        return;
      }
      if (req.url === '/split') {
        // The keyword arrives across two writes.
        res.write('all systems op');
        setTimeout(() => res.end('erational'), 20);
        return;
      }
      if (req.url === '/big') {
        res.write('x'.repeat(KEYWORD_READ_LIMIT_BYTES));
        res.end('operational');
        return;
      }
      if (req.url === '/slow-body') {
        res.write('still');
        return; // the body never ends
      }
      res.statusCode = req.url === '/503' ? 503 : 200;
      res.end('secret body, operational');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('reads a body with the keyword as up', async () => {
    const outcome = await probeHttp(new URL(`${base}/`), {
      ...options,
      keyword: 'operational',
    });

    expect(outcome).toMatchObject({ verdict: 'up', errorClass: null });
  });

  it('reads a body without it as down with keyword missing, and carries none of the body', async () => {
    const outcome = await probeHttp(new URL(`${base}/`), {
      ...options,
      keyword: 'all green',
    });

    expect(outcome).toMatchObject({
      verdict: 'down',
      errorClass: 'keyword missing',
    });
    expect(JSON.stringify(outcome)).not.toContain('secret');
  });

  it('finds a keyword split across two chunks', async () => {
    const outcome = await probeHttp(new URL(`${base}/split`), {
      ...options,
      keyword: 'operational',
    });

    expect(outcome.verdict).toBe('up');
  });

  it('looks no further than the read limit', async () => {
    const outcome = await probeHttp(new URL(`${base}/big`), {
      ...options,
      keyword: 'operational',
    });

    expect(outcome).toMatchObject({
      verdict: 'down',
      errorClass: 'keyword missing',
    });
  });

  it('judges the status before the keyword', async () => {
    const outcome = await probeHttp(new URL(`${base}/503`), {
      ...options,
      keyword: 'operational',
    });

    expect(outcome).toMatchObject({
      verdict: 'down',
      errorClass: 'status 503',
    });
  });

  it('holds a body that never ends to the timeout', async () => {
    const outcome = await probeHttp(new URL(`${base}/slow-body`), {
      ...options,
      keyword: 'operational',
    });

    expect(outcome).toMatchObject({ verdict: 'down', errorClass: 'timeout' });
  });

  it('sends the header, and without one sends nothing', async () => {
    const withHeader = await probeHttp(new URL(`${base}/echo`), {
      ...options,
      keyword: 'got s3cr3t',
      header: { name: 'X-Probe-Token', value: 's3cr3t' },
    });
    const without = await probeHttp(new URL(`${base}/echo`), {
      ...options,
      keyword: 'got nothing',
    });

    expect([withHeader.verdict, without.verdict]).toEqual(['up', 'up']);
  });
});

describe('probeTcp', () => {
  it('reads a completed handshake as up and a closed port as refused', async () => {
    const listener = createTcpServer((socket) => socket.end());
    await new Promise<void>((resolve) =>
      listener.listen(0, '127.0.0.1', resolve),
    );
    const { port } = listener.address() as AddressInfo;
    const up = await probeTcp('127.0.0.1', port, { timeoutMs: 500 });
    await new Promise((resolve) => listener.close(resolve));
    const refused = await probeTcp('127.0.0.1', port, { timeoutMs: 500 });

    expect(up).toMatchObject({ verdict: 'up', errorClass: null });
    expect(up.latencyMs).toEqual(expect.any(Number));
    expect(refused).toEqual({
      verdict: 'down',
      latencyMs: null,
      errorClass: 'refused',
    });
  });

  it('reads a host that never answers as down', async () => {
    // TEST-NET-1 (RFC 5737) is never routed: a timeout, or an unreachable
    // network where the machine says so first.
    const silent = await probeTcp('192.0.2.1', 9, { timeoutMs: 300 });

    expect(silent.verdict).toBe('down');
    expect(['timeout', 'connection']).toContain(silent.errorClass);
  });
});

describe('statusIsExpected', () => {
  it('matches a class across its hundred and an exact code only itself', () => {
    expect(statusIsExpected(299, ['2xx'])).toBe(true);
    expect(statusIsExpected(301, ['2xx'])).toBe(false);
    expect(statusIsExpected(401, ['2xx', '401'])).toBe(true);
    expect(statusIsExpected(402, ['401'])).toBe(false);
  });
});

describe('classifyProbeError', () => {
  it('names each class by its code, and anything else connection', () => {
    expect(classifyProbeError({ code: 'ENOTFOUND' })).toBe('dns');
    expect(classifyProbeError({ code: 'ECONNREFUSED' })).toBe('refused');
    expect(classifyProbeError({ code: 'ETIMEDOUT' })).toBe('timeout');
    expect(classifyProbeError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })).toBe(
      'tls',
    );
    expect(classifyProbeError({ code: 'ECONNRESET' })).toBe('connection');
    expect(classifyProbeError(new Error('no code'))).toBe('connection');
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:tls';
import type { Server as TlsServer } from 'node:tls';

import { readServedCertificate } from '../../src/domains/served-certificate';

/**
 * The served-certificate read (#130) against local TLS servers: one serving
 * a certificate a local CA signed for `localhost`, as Let's Encrypt's would
 * be, and one serving a self-signed certificate named as Traefik's default
 * is. The certificates are made here with `openssl`, so no key is kept in
 * the tree.
 */
describe('readServedCertificate', () => {
  let dir: string;
  let ca: string;
  const servers: Array<TlsServer | Server> = [];
  const keep = <T extends TlsServer | Server>(server: T): T => {
    // Every socket is ended here, so closing the servers does not wait on one.
    server.on('connection', (socket) => {
      socket.on('error', () => {});
      sockets.add(socket);
    });
    servers.push(server);
    return server;
  };
  const sockets = new Set<{ destroy(): void }>();

  function openssl(...args: string[]) {
    execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  }
  const read = (name: string) => readFileSync(join(dir, name), 'utf8');

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'served-cert-'));
    // A CA, and a leaf it signs for localhost, as an ACME issuer would.
    openssl(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-keyout',
      'ca.key',
      '-out',
      'ca.pem',
      '-subj',
      "/O=Let's Encrypt Test/CN=R10 Test",
    );
    openssl(
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'leaf.key',
      '-out',
      'leaf.csr',
      '-subj',
      '/CN=localhost',
    );
    writeFileSync(join(dir, 'leaf.ext'), 'subjectAltName=DNS:localhost\n');
    openssl(
      'x509',
      '-req',
      '-in',
      'leaf.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-days',
      '2',
      '-extfile',
      'leaf.ext',
      '-out',
      'leaf.pem',
    );
    // Traefik's own, served until a certificate is issued.
    openssl(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-keyout',
      'default.key',
      '-out',
      'default.pem',
      '-subj',
      '/CN=TRAEFIK DEFAULT CERT',
      '-addext',
      'subjectAltName=DNS:1b2c3d.traefik.default',
    );
    ca = read('ca.pem');
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      servers.map((server) => new Promise((done) => server.close(done))),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  async function serving(cert: string, key: string): Promise<number> {
    const server = keep(
      createServer({ cert: read(cert), key: read(key) }, (socket) =>
        socket.end(),
      ),
    );
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return (server.address() as { port: number }).port;
  }

  it('reports a certificate a trusted CA issued for the host as valid, with its issuer and expiry', async () => {
    const port = await serving('leaf.pem', 'leaf.key');

    const served = await readServedCertificate('localhost', { port, ca });

    expect(served.valid).toBe(true);
    expect(served.issuer).toBe("Let's Encrypt Test");
    const notAfter = new Date(served.notAfter!).getTime();
    expect(notAfter).toBeGreaterThan(Date.now());
    expect(notAfter).toBeLessThan(Date.now() + 3 * 24 * 3600 * 1000);
  });

  it("reports Traefik's default certificate as not valid", async () => {
    const port = await serving('default.pem', 'default.key');

    const served = await readServedCertificate('localhost', { port, ca });

    expect(served.valid).toBe(false);
    expect(served.issuer).toBe('TRAEFIK DEFAULT CERT');
    expect(typeof served.notAfter).toBe('string');
  });

  it('reports a trusted certificate for another name as not valid', async () => {
    const port = await serving('leaf.pem', 'leaf.key');

    // 127.0.0.1 is not a name the certificate covers.
    const served = await readServedCertificate('127.0.0.1', { port, ca });

    expect(served.valid).toBe(false);
  });

  it('reports nothing served when the port refuses, or does not answer in time', async () => {
    const closed = createNetServer();
    await new Promise<void>((done) => closed.listen(0, '127.0.0.1', done));
    const refusedPort = (closed.address() as { port: number }).port;
    await new Promise((done) => closed.close(done));

    expect(
      await readServedCertificate('localhost', { port: refusedPort, ca }),
    ).toEqual({ valid: false, issuer: null, notAfter: null });

    // Accepts the connection and never speaks TLS.
    const silent = keep(createNetServer(() => {}));
    await new Promise<void>((done) => silent.listen(0, '127.0.0.1', done));
    const silentPort = (silent.address() as { port: number }).port;
    expect(
      await readServedCertificate('localhost', {
        port: silentPort,
        ca,
        timeoutMs: 200,
      }),
    ).toEqual({ valid: false, issuer: null, notAfter: null });
  });
});

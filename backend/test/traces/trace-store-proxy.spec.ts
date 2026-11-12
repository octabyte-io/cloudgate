import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { HttpException } from '@nestjs/common';
import express from 'express';
import request from 'supertest';
import {
  forwardToTraceStore,
  underFrameBase,
} from '../../src/traces/trace-store-proxy';

/**
 * What the proxy does to every answer it forwards from a Trace store
 * (ADR-0075): the store is untrusted, so each answer, a page or anything else,
 * is served sandboxed into an opaque origin, readable from that origin without
 * credentials, and with the store's base path moved under the frame's token.
 *
 * A real HTTP server stands in for the store and a bare Express app for the
 * route, so what is asserted is the bytes and headers a browser would get.
 * Expected values are spelled out (§1.7).
 */

const STORE_BASE = '/backend/traces/app-1/ui';
const FRAME_BASE = '/backend/traces/app-1/ui/t/tok.sig';
const SANDBOX = 'sandbox allow-scripts allow-forms allow-popups';

interface StoreAnswer {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

let store: Server;
let storePort: number;
let storeAnswers: (req: IncomingMessage) => StoreAnswer;
let heard: string[];

const app = express();
app.use((req, res) => {
  forwardToTraceStore({
    req,
    res,
    connection: {
      options: { host: '127.0.0.1', port: storePort },
      close: () => undefined,
    },
    path: `${STORE_BASE}${req.url}`,
    queryCredential: 'query-secret',
    storeBasePath: STORE_BASE,
    frameBasePath: FRAME_BASE,
  }).catch((error: HttpException) => {
    res.status(error.getStatus()).json({ message: error.message });
  });
});

beforeAll(async () => {
  store = createServer((req: IncomingMessage, res: ServerResponse) => {
    heard.push(req.url ?? '');
    const answer = storeAnswers(req);
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  });
  await new Promise<void>((resolve) => store.listen(0, '127.0.0.1', resolve));
  storePort = (store.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => store.close(() => resolve()));
});

beforeEach(() => {
  heard = [];
});

const page =
  '<!doctype html><html><head>' +
  `<base href="${STORE_BASE}/" data-inject-target="BASE_URL" />` +
  '<script>window.config = 1;</script>' +
  '<script type="module" crossorigin src="./static/index.js"></script>' +
  '</head><body><div id="root"></div></body></html>';

const framedPage =
  '<!doctype html><html><head>' +
  `<base href="${FRAME_BASE}/" data-inject-target="BASE_URL" />` +
  '<script>window.config = 1;</script>' +
  '<script type="module" crossorigin src="./static/index.js"></script>' +
  '</head><body><div id="root"></div></body></html>';

/** An answer with no headers of its own. */
const noHeaders: Record<string, string> = {};

/** Headers a store could send to escape or widen what it is served under. */
const HOSTILE_HEADERS = {
  'content-security-policy': "script-src * 'unsafe-inline'",
  'content-security-policy-report-only': "default-src 'none'",
  'x-frame-options': 'DENY',
  'access-control-allow-origin': 'https://evil.example',
  'access-control-allow-credentials': 'true',
  'referrer-policy': 'unsafe-url',
  'clear-site-data': '"cookies"',
  'service-worker-allowed': '/',
  'set-cookie': 'better-auth.session_token=x; Path=/',
};

/** What every forwarded answer must be served with, whatever it is. */
function expectSandboxed(res: request.Response): void {
  const policy = String(res.headers['content-security-policy']);
  expect(policy.split('; ')).toContain(SANDBOX);
  // An opaque origin: the flags that would undo it are never granted.
  expect(policy).not.toContain('allow-same-origin');
  expect(policy).not.toContain('allow-top-navigation');
  expect(res.headers['content-security-policy-report-only']).toBeUndefined();
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['access-control-allow-origin']).toBe('*');
  expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  expect(res.headers['referrer-policy']).toBe('no-referrer');
  expect(res.headers['x-frame-options']).toBeUndefined();
  expect(res.headers['clear-site-data']).toBeUndefined();
  expect(res.headers['service-worker-allowed']).toBeUndefined();
  expect(res.headers['set-cookie']).toBeUndefined();
}

describe('forwardToTraceStore', () => {
  it('serves a page sandboxed, under the frame token, with its own head script hashed as served', async () => {
    storeAnswers = () => ({
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        ...HOSTILE_HEADERS,
      },
      body: page,
    });

    const res = await request(app).get('/search');

    expect(res.status).toBe(200);
    expect(heard).toEqual([`${STORE_BASE}/search`]);
    expectSandboxed(res);
    expect(res.text).toBe(framedPage);
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; " +
        // `window.config = 1;`'s hash, from `openssl dgst -sha256 -binary`.
        "script-src 'self' 'sha256-b7GhnDeSTKp2mWfbBifSDQAP29vql3MfdbjKoYzEk3U='; " +
        "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
        "font-src 'self' data:; connect-src 'self'; " +
        "frame-ancestors 'self'; base-uri 'self'; form-action 'none'; " +
        "object-src 'none'; sandbox allow-scripts allow-forms allow-popups",
    );
    // It names this viewer's token, so nothing caches it.
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('decodes a compressed page to move it under the token, and sends it uncompressed', async () => {
    storeAnswers = () => ({
      status: 200,
      headers: {
        'content-type': 'text/html',
        'content-encoding': 'gzip',
        etag: '"store-etag"',
      },
      body: gzipSync(page),
    });

    const res = await request(app)
      .get('/search')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
    expectSandboxed(res);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers['content-length']).toBe(
      String(Buffer.byteLength(framedPage)),
    );
    expect(res.text).toBe(framedPage);
  });

  it('serves a script sandboxed too, so it never runs as the console', async () => {
    storeAnswers = () => ({
      status: 200,
      headers: { 'content-type': 'text/javascript', ...HOSTILE_HEADERS },
      body: `fetch("/backend/settings/traefik", { credentials: "include" });`,
    });

    const res = await request(app).get('/static/index.js');

    expect(res.status).toBe(200);
    expectSandboxed(res);
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; script-src 'self'; " +
        "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
        "font-src 'self' data:; connect-src 'self'; " +
        "frame-ancestors 'self'; base-uri 'self'; form-action 'none'; " +
        "object-src 'none'; sandbox allow-scripts allow-forms allow-popups",
    );
    // Streamed as the store sent it: only a page is rewritten.
    expect(res.text).toBe(
      `fetch("/backend/settings/traefik", { credentials: "include" });`,
    );
  });

  it.each([
    ['JSON', 'application/json', '{"data":["checkout"]}'],
    ['a page served as something else', 'text/plain', page],
    ['a page with no content type', '', page],
  ])('serves %s sandboxed', async (_label, contentType, body) => {
    storeAnswers = () => ({
      status: 200,
      headers: contentType ? { 'content-type': contentType } : noHeaders,
      body,
    });

    const res = await request(app).get('/api/services');

    expectSandboxed(res);
  });

  it('serves an error answer from the store sandboxed', async () => {
    storeAnswers = () => ({
      status: 500,
      headers: { 'content-type': 'text/html' },
      body: '<script>alert(1)</script>',
    });

    const res = await request(app).get('/search');

    expect(res.status).toBe(500);
    expectSandboxed(res);
  });

  it('keeps a redirect into the store’s base path under the token', async () => {
    storeAnswers = () => ({
      status: 301,
      headers: { location: `${STORE_BASE}/`, 'content-type': 'text/html' },
      body: '',
    });

    const res = await request(app).get('/');

    expect(res.status).toBe(301);
    expect(res.headers.location).toBe(`${FRAME_BASE}/`);
    expectSandboxed(res);
  });
});

describe('underFrameBase', () => {
  it('moves every whole use of the base path, and no longer path that starts with it', () => {
    expect(
      underFrameBase(
        `<base href="${STORE_BASE}/"><a href="${STORE_BASE}">x</a>` +
          `<a href="${STORE_BASE}?q=1"></a><a href="${STORE_BASE}-other/"></a>` +
          `<a href="${STORE_BASE}x/"></a>`,
        STORE_BASE,
        FRAME_BASE,
      ),
    ).toBe(
      `<base href="${FRAME_BASE}/"><a href="${FRAME_BASE}">x</a>` +
        `<a href="${FRAME_BASE}?q=1"></a><a href="${STORE_BASE}-other/"></a>` +
        `<a href="${STORE_BASE}x/"></a>`,
    );
  });

  it('reads the base path literally, not as a pattern', () => {
    expect(underFrameBase('/a.b/ /aXb/', '/a.b', '/t')).toBe('/t/ /aXb/');
  });
});

import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request as ExpressRequest } from 'express';
import type { Auth } from '../../src/auth/auth.config';
import type { SsoDialScope } from '../../src/auth/sso-dial-scope';
import {
  AuthController,
  toWebRequest,
  untrustedPeerReporter,
  UNTRUSTED_PEER_WARNINGS,
} from '../../src/auth/auth.controller';
import { trustedProxyRanges } from '../../src/common/config/trust-proxy';

/**
 * What an operator is told when `TRUST_PROXY` and the actual ingress disagree.
 *
 * `TRUST_PROXY` is checked for syntax at boot and never for fit, so a range
 * naming a proxy nothing goes through — or one that can be walked around — runs
 * indefinitely without a word. The trusted-proxy fix made both states safe and
 * neither visible. These are the two things said about it, and the two things
 * deliberately not said: no request is refused and no boot is aborted, because a
 * misconfigured ingress must not take sign-in down.
 *
 * A unit spec because neither line is reachable e2e: supertest connects from
 * loopback, so a peer outside a declared range cannot be produced over a real
 * socket, and the boot line is emitted once per process before any request.
 */

/**
 * The minimum of an Express request the warning path reads.
 *
 * `trusts` is the app's compiled `trust proxy fn`, stood in for by exact
 * membership: Express is the boundary here, and what this path asks it is one
 * yes-or-no question about one address. Whether `127.0.0.1` falls inside
 * `127.0.0.1/8` is `proxy-addr`'s arithmetic and is not Cloudgate's to re-assert
 * — re-deriving it in the fixture would be the second address matcher the code
 * under test exists to avoid.
 *
 * `ip` stays on the fixture although nothing in `toWebRequest` reads it any
 * more, and the reason is the finding: **`req.ip` and the trust matcher can
 * disagree**, and until H-07 this path believed the first of them. A fixture
 * that cannot express the disagreement cannot hold the fix.
 */
function expressRequest(
  overrides: {
    peer?: string;
    ip?: string;
    forwardedFor?: string;
    trusts?: readonly string[];
  } = {},
): ExpressRequest {
  const trusted = overrides.trusts ?? [];
  return {
    protocol: 'http',
    originalUrl: '/api/auth/sign-in/email',
    method: 'POST',
    // Express derives `req.ip` from the chain only when the peer is a declared
    // proxy *and* the chain names somebody else; otherwise it answers the peer.
    ip: overrides.ip ?? overrides.peer,
    app: {
      get: (setting: string) =>
        setting === 'trust proxy fn'
          ? (address: string) => trusted.includes(address)
          : undefined,
    },
    socket: { remoteAddress: overrides.peer },
    headers: {
      host: 'console.cloudgate.test',
      ...(overrides.forwardedFor === undefined
        ? {}
        : { 'x-forwarded-for': overrides.forwardedFor }),
    },
    body: { email: 'grace@example.com', password: 'hunter2' },
    get: (name: string) =>
      name === 'host' ? 'console.cloudgate.test' : undefined,
  } as unknown as ExpressRequest;
}

/** `TRUST_PROXY=10.0.0.0/8` — a load balancer declared by its range. */
const DECLARED_RANGE = trustedProxyRanges('10.0.0.0/8');

/** An `AuthController` built on one `TRUST_PROXY` value and nothing else. */
function controllerFor(trustProxy: string | undefined): AuthController {
  const config = {
    get: (key: string) => (key === 'TRUST_PROXY' ? trustProxy : undefined),
  } as unknown as ConfigService;
  const passthrough = {
    run: <T>(_request: unknown, work: () => Promise<T>) => work(),
  } as unknown as SsoDialScope;
  return new AuthController({} as Auth, config, passthrough);
}

describe('untrustedPeerReporter', () => {
  describe('a request from outside the declared range', () => {
    it('is reported once for that peer, and never again', () => {
      const warn = jest.fn();
      const report = untrustedPeerReporter(DECLARED_RANGE, warn);
      const outside = expressRequest({
        peer: '198.51.100.9',
        forwardedFor: '1.2.3.4',
      });

      toWebRequest(outside, DECLARED_RANGE, report);
      toWebRequest(outside, DECLARED_RANGE, report);
      toWebRequest(outside, DECLARED_RANGE, report);

      expect(warn).toHaveBeenCalledTimes(1);
    });

    /**
     * The line has to be actionable without opening the source: what was declared,
     * what arrived, and what the backend did about it.
     */
    it('names what was declared, what arrived, and the consequence', () => {
      const warn = jest.fn();

      untrustedPeerReporter(DECLARED_RANGE, warn)('198.51.100.9');

      const [message] = warn.mock.calls[0] as [string];
      expect(message).toContain('10.0.0.0/8');
      expect(message).toContain('198.51.100.9');
      expect(message).toContain('the socket peer recorded');
      expect(message).toContain('TRUST_PROXY');
    });

    /**
     * A second ingress is a handful of peers; the reason to bound the set is the
     * case where it is not. Every distinct peer that connects would otherwise be
     * retained for the life of the process, which is an unbounded set a stranger
     * fills by connecting — a leak with a remote trigger, on the path an install
     * in this state is already being probed on.
     */
    it('stops after a bounded number of distinct peers', () => {
      const warn = jest.fn();
      const report = untrustedPeerReporter(DECLARED_RANGE, warn);

      for (let i = 0; i < UNTRUSTED_PEER_WARNINGS; i++) {
        report(`198.51.100.${i}`);
      }
      expect(warn).toHaveBeenCalledTimes(UNTRUSTED_PEER_WARNINGS);

      report('203.0.113.1');
      report('203.0.113.2');

      expect(warn).toHaveBeenCalledTimes(UNTRUSTED_PEER_WARNINGS);
    });

    it('keeps the bound small enough to be a bound', () => {
      expect(UNTRUSTED_PEER_WARNINGS).toBeLessThanOrEqual(64);
    });
  });
});

describe('toWebRequest', () => {
  describe('the cases that must stay silent', () => {
    /**
     * The proxy is doing its job: the peer is inside the declared range, so
     * Express reads the chain past it and `req.ip` is the client rather than the
     * hop. Nothing was ignored and there is nothing to say.
     */
    it('says nothing for a correctly declared single-ingress proxy', () => {
      const warn = jest.fn();

      toWebRequest(
        expressRequest({
          peer: '10.0.0.9',
          ip: '203.0.113.7',
          forwardedFor: '203.0.113.7',
          trusts: ['10.0.0.9'],
        }),
        DECLARED_RANGE,
        untrustedPeerReporter(DECLARED_RANGE, warn),
      );

      expect(warn).not.toHaveBeenCalled();
    });

    /**
     * The shipped topology, and the line H-07 found it emitting.
     *
     * At `TRUST_PROXY=loopback` the console forwards from the box itself, so the
     * chain it stamps names only the declared peer: `x-forwarded-for: 127.0.0.1`
     * from `127.0.0.1`. Express steps past the peer, finds an entry it has
     * already trusted, runs out, and answers the peer — so `req.ip === peer`,
     * exactly as it does for a caller from outside the range. On the live box
     * that earned one warning per boot telling the operator that `127.0.0.1` is
     * "outside" `127.0.0.1/8` and inviting them to close the path around their
     * own console. Nothing was ignored, no path exists to close, and this is the
     * ordinary shape here — a probe on the box, or the SSH tunnel `docs/deploy.md`
     * §3 recommends.
     */
    it('says nothing when the declared proxy forwards a chain naming only itself', () => {
      const warn = jest.fn();
      const loopback = trustedProxyRanges('loopback');

      toWebRequest(
        expressRequest({
          peer: '127.0.0.1',
          forwardedFor: '127.0.0.1',
          trusts: ['127.0.0.1'],
        }),
        loopback,
        untrustedPeerReporter(loopback, warn),
      );

      expect(warn).not.toHaveBeenCalled();
    });

    /**
     * A request Express did not build has no compiled matcher to ask, and an
     * unanswerable question is not evidence of a second ingress. Nest's testing
     * harness arrives this way, alongside the upgrade paths that carry no socket.
     */
    it('says nothing about a request that carries no Express app', () => {
      const warn = jest.fn();
      const bare = expressRequest({
        peer: '198.51.100.9',
        forwardedFor: '1.2.3.4',
      });
      delete (bare as { app?: unknown }).app;

      toWebRequest(
        bare,
        DECLARED_RANGE,
        untrustedPeerReporter(DECLARED_RANGE, warn),
      );

      expect(warn).not.toHaveBeenCalled();
    });

    /**
     * The shipped default. Nothing is declared, so the chain is replaced rather
     * than peer-checked and there is no mismatch to report — a caller
     * sending a header on a single-host install is not a deployment fault, and one
     * line per stranger who tries would be exactly the noise that gets this
     * filtered away.
     */
    it('says nothing when TRUST_PROXY is unset, however the caller arrives', () => {
      const warn = jest.fn();
      const nothingDeclared = trustedProxyRanges(undefined);

      toWebRequest(
        expressRequest({ peer: '198.51.100.9', forwardedFor: '1.2.3.4' }),
        nothingDeclared,
        untrustedPeerReporter(nothingDeclared, warn),
      );

      expect(warn).not.toHaveBeenCalled();
    });

    /**
     * Without a chain nothing was ignored, and the peer's own address is what gets
     * recorded either way. Warning here would also libel a correct install: a
     * proxy that forwards without setting `x-forwarded-for` is indistinguishable
     * from a direct caller, and this line must not accuse one of being the other.
     */
    it('says nothing when no forwarded header arrived', () => {
      const warn = jest.fn();

      toWebRequest(
        expressRequest({ peer: '198.51.100.9' }),
        DECLARED_RANGE,
        untrustedPeerReporter(DECLARED_RANGE, warn),
      );

      expect(warn).not.toHaveBeenCalled();
    });
  });
});

// The constructor is the unit under test: the line is decided from
// configuration and emitted once, before any request (§1.7).
describe('AuthController', () => {
  /**
   * `trustsHopCountOnly` still answers `true` for a *list* of counts, and since
   * the boot check, that answer is unreachable in production: `isTrustProxyValue` refuses
   * `1,2` at boot, so no such value ever reaches this constructor. Kept as the
   * function's boundary rather than pinned as a case — the warning's wording is
   * about a count naming a position, which a list of counts does not stop being.
   */
  describe('the boot line a hop count earns', () => {
    let warn: jest.SpyInstance;

    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warn.mockRestore();
    });

    /**
     * The mitigation the trusted-proxy decision comment depends on. It is decidable from
     * configuration, so it is said once at boot rather than once per request — and
     * it has to carry the remedy, because naming a throttle nobody can find the
     * cause of is worse than saying nothing.
     */
    it('names the shared-limiter consequence and the range remedy, once', () => {
      controllerFor('1');

      expect(warn).toHaveBeenCalledTimes(1);
      const [message] = warn.mock.calls[0] as [string];
      expect(message).toContain('TRUST_PROXY');
      expect(message).toContain('shared by every user at once');
      expect(message).toContain('per-client limiting');
      expect(message).toContain('range');
      // Refusing the value at boot was weighed and deliberately not committed to,
      // so the line must not promise it.
      expect(message).not.toMatch(/will (no longer|stop)/i);
    });

    it.each([undefined, '', '10.0.0.0/8', 'loopback', '1,10.0.0.0/8'])(
      'says nothing at boot for TRUST_PROXY=%s',
      (value) => {
        controllerFor(value);

        expect(warn).not.toHaveBeenCalled();
      },
    );

    /**
     * `TRUST_PROXY=0` is what an operator writes to say *nothing is in front of
     * me* (0eaa47d). On such an install the recorded address is the client's own
     * and the throttle is already per-client, so there is no consequence to name —
     * and a warning on the value that means "no proxy" would read as the setting
     * being wrong when it is exactly right.
     */
    it('says nothing at boot when the hop count is zero', () => {
      controllerFor('0');

      expect(warn).not.toHaveBeenCalled();
    });
  });
});

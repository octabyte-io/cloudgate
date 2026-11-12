import { AsyncLocalStorage } from 'node:async_hooks';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Agent, buildConnector } from 'undici';
import type { Dispatcher } from 'undici';
import type { FetchClient } from '../git-providers/fetch.provider';
import { organizationOfPlace } from '../common/work-place';
import type { WorkPlace } from '../common/work-place';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { PermissionService } from '../rbac/permission.service';
import {
  ADDRESS_RESOLVER,
  bareHost,
  publicAddressOf,
} from './outbound-address';
import type { AddressResolver } from './outbound-address';
import { OwnAddresses } from './own-addresses';

/**
 * The refusal code a client branches on (ADR-0005) when a customer-supplied
 * host would have the platform host dial loopback, a private or link-local
 * range, or the cloud metadata address.
 */
export const OUTBOUND_ADDRESS_REFUSED_CODE = 'OUTBOUND_ADDRESS_REFUSED';

/**
 * The 400 for a refused dial, naming the field the host came from.
 *
 * One sentence for every way it is refused — a private literal, a name that
 * lands in a private range, a name that does not resolve: which of those it
 * was is a fact about the host's own network, and a customer is not owed it
 * (`PRIVATE_DESTINATION_REFUSAL` in `ai-destination.ts` and
 * `SERVER_ADDRESS_REFUSAL` are the precedent). The field is what they can act
 * on, so it leads the message and travels as `field` too.
 *
 * A 400 rather than the AI check's 403, after `serverAddressRefused`: here the
 * refusal is about the value and the Organization it belongs to, which is
 * checked at the dial, long after the request that saved it — there is often
 * no caller to be forbidden anything.
 */
export function outboundAddressRefused(field: string): BadRequestException {
  return new BadRequestException({
    message: `${field} must be a public address: this Cloudgate does not dial loopback, link-local, private or metadata addresses for it`,
    code: OUTBOUND_ADDRESS_REFUSED_CODE,
    field,
  });
}

/** Whether `error` is {@link outboundAddressRefused}'s, so a caller can pass it on whole. */
export function isOutboundAddressRefusal(
  error: unknown,
): error is BadRequestException {
  if (!(error instanceof BadRequestException)) return false;
  const body = error.getResponse();
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { code?: unknown }).code === OUTBOUND_ADDRESS_REFUSED_CODE
  );
}

/**
 * What a dial is for: the row it acts for — a notification channel's
 * Organization, an Uptime check's Service, a Gitea or GitLab connection's
 * `git_provider` — and the field its host came from.
 */
export interface OutboundScope {
  /** Whose dial this is, read only when the answer is needed. */
  place: WorkPlace;
  /** The request field the host was set in, as the refusal names it. */
  field: string;
}

/** What the guarded connector fails a connection with; named, so it can be told apart. */
class OutboundAddressRefusedError extends Error {
  readonly code = OUTBOUND_ADDRESS_REFUSED_CODE;
}

type Connector = ReturnType<typeof buildConnector>;

/**
 * An undici connector that resolves the host once, refuses a non-public
 * answer, and connects to the address it checked — for *every* connection,
 * including the redirect hops `fetch` follows on its own, since each one
 * opens through the dispatcher. A TLS connection keeps the name as its
 * `servername`, so SNI and the certificate check are against the host the URL
 * named, not the address.
 *
 * `own` answers the box's own addresses to refuse as well, asked at every
 * connection ({@link OwnAddresses.listOnHosted}: on the Hosted instance only).
 */
export function guardedConnector(
  resolve: AddressResolver,
  base: Connector = buildConnector({}),
  own: () => Promise<readonly string[]> = () => Promise.resolve([]),
): Connector {
  return (options, callback) => {
    const host = bareHost(options.hostname);
    own()
      .then((ownAddresses) => publicAddressOf(host, resolve, ownAddresses))
      .then(
        (address) => {
          if (address === null) {
            callback(new OutboundAddressRefusedError(host), null);
            return;
          }
          base(
            {
              ...options,
              hostname: address,
              servername:
                options.servername ?? (address === host ? undefined : host),
            },
            callback,
          );
        },
        (error: Error) => callback(error, null),
      );
  };
}

/**
 * Whether `error` is the guarded connector's refusal, wherever fetch hung it.
 * Read by its code, not `instanceof`, as `classifyProbeError` reads errors.
 */
function isConnectorRefusal(error: unknown): boolean {
  for (let at: unknown = error, depth = 0; at && depth < 5; depth += 1) {
    if ((at as { code?: unknown }).code === OUTBOUND_ADDRESS_REFUSED_CODE) {
      return true;
    }
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}

/** The host a fetch's `input` names, as `URL.hostname` spells it. */
function hostOf(input: Parameters<FetchClient>[0]): string {
  const href =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  return new URL(href).hostname;
}

/**
 * Where the platform host may dial on a customer's say-so — a notification
 * channel's webhook or SMTP host, an uptime check's Domain, a Gitea or GitLab
 * URL — applied **at the dial**, not where the value was saved.
 *
 * **At the dial, and dialling what was checked.** A check where the URL enters
 * (the AI destination's shape) leaves two gaps this closes: rows saved before
 * the check, and a name whose records change after it. So the host is resolved
 * once, every address it resolves to must be public, and the connection goes
 * to the address that was checked — {@link fetchFor} through an undici
 * dispatcher whose connector does exactly that, {@link addressToDial} by
 * handing a non-HTTP caller (SMTP, the uptime Probe) the address to connect
 * to. There is no second lookup for a rebind to slip between.
 *
 * **The exemption is the AI destination's, asked of the dial.** ADR-0013 makes
 * pointing the platform host at a private network an instance-wide act, held
 * by the instance organization's owners and admins (`ai-destination.ts`). A
 * notification or a probe fires on a timer with no caller to ask, so the
 * question becomes: does the dial act for the **instance organization**? Its
 * rows were set by people who already have a root shell on the host
 * (ADR-0010), and refusing them buys nothing — the AI check's own reasoning,
 * and the same one `AiService` gives for not re-checking a stored destination
 * a plain member triggers.
 *
 * **Everywhere, not on the Hosted instance alone**, because the AI check is
 * everywhere. On the single-organization install `deploy/install.sh`
 * produces, that one Organization *is* the instance organization, so a
 * self-hosted operator's webhook to the LAN, their Gitea on `10.0.0.5` and
 * their uptime check of an internal Domain keep working unchanged; what is
 * refused is a second Organization — on the Hosted instance, every customer —
 * pointing the box at a network it is not on.
 */
/**
 * The dispatcher every `globalThis.fetch` uses while {@link
 * OutboundAddressGuard.runWithGuardedFetch} runs, and none outside it.
 *
 * It exists for code that dials with the global `fetch` and takes no fetch of
 * ours: the SSO plugin (`@better-auth/sso`, and better-auth's token exchange
 * and JWKS reads under it) calls `betterFetch`, which reads
 * `globalThis.fetch` at every call and has no option to swap it (ADR-0076). A
 * check of the URL before the plugin runs leaves the window between that
 * lookup and the plugin's own, which a name with a short TTL can rebind into;
 * inside this scope the plugin's connections go through the same guarded
 * connector as {@link OutboundAddressGuard.fetchFor}, which dials the address
 * it checked and checks every redirect hop again.
 *
 * Installed once, on first use, and a no-op outside the scope: every other
 * `fetch` in the process keeps the default dispatcher.
 */
const guardedFetchScope = new AsyncLocalStorage<Dispatcher>();
let scopedFetchInstalled = false;

function installScopedFetch(): void {
  if (scopedFetchInstalled) return;
  const original = globalThis.fetch;
  const scoped = (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const dispatcher = guardedFetchScope.getStore();
    if (!dispatcher) return original(input, init);
    return original(input, { ...init, dispatcher } as RequestInit);
  };
  globalThis.fetch = scoped;
  scopedFetchInstalled = true;
}

@Injectable()
export class OutboundAddressGuard {
  /**
   * One pool of guarded connections for every non-exempt dial. Pooling is
   * safe because a connection only ever exists to an address that was
   * checked; an exempt dial never shares it, since it goes through the
   * transport's own dispatcher instead.
   */
  private readonly dispatcher: Agent;

  constructor(
    @Inject(ADDRESS_RESOLVER) private readonly resolve: AddressResolver,
    private readonly permissions: PermissionService,
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly own: OwnAddresses,
  ) {
    this.dispatcher = new Agent({
      connect: guardedConnector(resolve, undefined, () => own.listOnHosted()),
    });
  }

  /**
   * The address to connect to for `host`: `host` itself when the dial acts
   * for the instance organization, otherwise the public address it was
   * checked at. Throws {@link outboundAddressRefused}.
   */
  async addressToDial(host: string, scope: OutboundScope): Promise<string> {
    if (await this.isExempt(scope)) return host;
    const address = await this.publicAddressOf(host);
    if (address === null) throw outboundAddressRefused(scope.field);
    return address;
  }

  /**
   * `base` with every connection guarded — a fetch that refuses with
   * {@link outboundAddressRefused} rather than reach a non-public address,
   * unless the dial acts for the instance organization, which gets `base`
   * untouched. `base` stays the transport (`FETCH_CLIENT`, which a suite
   * replaces), so the guard rides on it as an undici `dispatcher` option.
   *
   * **Checked twice, and the second check is the one that holds.** The URL's
   * host is checked before the request so a refusal comes back as the 400
   * naming the field; the connector then checks again at every connection and
   * dials what *it* checked, which is what a rebind between the two, or a
   * redirect to an internal address, runs into. That second refusal surfaces
   * as `fetch`'s own failure: `fetch` rebuilds an error from another realm
   * rather than pass it on, so its code is not always there to be read, and
   * {@link isConnectorRefusal} translates it only when it is.
   */
  fetchFor(base: FetchClient, scope: OutboundScope): FetchClient {
    return async (input: Parameters<FetchClient>[0], init?: RequestInit) => {
      if (await this.isExempt(scope)) return base(input, init);
      if ((await this.publicAddressOf(hostOf(input))) === null) {
        throw outboundAddressRefused(scope.field);
      }
      try {
        return await base(input, {
          ...init,
          dispatcher: this.dispatcher,
        } as RequestInit);
      } catch (error) {
        if (isConnectorRefusal(error)) {
          throw outboundAddressRefused(scope.field);
        }
        throw error;
      }
    };
  }

  /**
   * Runs `work` with every `globalThis.fetch` it makes guarded: dialled at the
   * public address its host was checked at, redirects checked again, and a
   * non-public one refused as the connection is made. For a library that
   * fetches by itself; see {@link guardedFetchScope}. The caller decides
   * whether the work is exempt (the instance organization's) and skips this
   * when it is.
   */
  runWithGuardedFetch<T>(work: () => Promise<T>): Promise<T> {
    installScopedFetch();
    return guardedFetchScope.run(this.dispatcher, work);
  }

  /**
   * Whether a dial for `scope` acts for the instance organization, and so is
   * exempt from the address rule (ADR-0013). For a caller that builds its own
   * dial (a pinned `git` command) and must apply the one exemption this guard
   * applies.
   */
  actsForInstance(scope: OutboundScope): Promise<boolean> {
    return this.isExempt(scope);
  }

  /**
   * The address rule this guard applies: {@link publicAddressOf}, refusing
   * the box's own addresses too on the Hosted instance, as
   * `ServerAddressGuard` does for a Server (ADR-0053). Without them a
   * customer's URL at the box's public IP had the box dial itself on any port.
   */
  private async publicAddressOf(host: string): Promise<string | null> {
    return publicAddressOf(host, this.resolve, await this.own.listOnHosted());
  }

  /** Whether the dial acts for the instance organization (ADR-0013). */
  private async isExempt({ place }: OutboundScope): Promise<boolean> {
    const organization = await organizationOfPlace(this.db, place);
    // A row that is gone acts for nobody, and nobody is exempt.
    if (organization === null) return false;
    return organization === (await this.permissions.instanceOrganizationId());
  }
}

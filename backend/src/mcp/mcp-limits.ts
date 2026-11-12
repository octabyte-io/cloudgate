/**
 * The numbers and revision lists the MCP endpoint answers by
 * (ADR-0025). Constants, with no operator setting, and each one pinned where a
 * change to it would otherwise go unnoticed.
 */

/**
 * How long one tool may run before the dispatcher stops waiting and answers
 * the `failed` outcome, with an audit row (ADR-0025).
 *
 * Well below the console's 240 s idle `proxyTimeout` (`frontend/next.config.ts`)
 * so a slow tool is a result the agent can read, never a socket the proxy cut.
 * `frontend/server/mcp-deadline.test.mjs` reads this line and reds when the two
 * cross, so it stays a plain numeric literal.
 */
export const TOOL_DEADLINE_MS = 30_000;

/**
 * The revision served on the per-request-envelope ("modern") leg. The SDK
 * answers any other envelope revision with the spec's 400 and `-32022` itself;
 * the list is ours so the dispatcher can write the `unsupported-revision` row
 * for the same requests.
 */
export const MODERN_REVISIONS = ['2026-07-28'] as const;

/**
 * The 2025-era Streamable HTTP revisions still served, newest first — every
 * earlier revision that a client we document speaks only (ADR-0025). Dropping
 * one is a decision with a release note, never a silent SDK bump.
 */
export const LEGACY_REVISIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
] as const;

/** Every revision served, which overrides the SDK's defaults. */
export const SERVED_REVISIONS: readonly string[] = [
  ...MODERN_REVISIONS,
  ...LEGACY_REVISIONS,
];

/**
 * The oldest revision served. A 2025-era request naming anything older —
 * `2024-11-05` and its HTTP+SSE transport — is refused rather than negotiated
 * up, which the SDK would otherwise do for an `initialize` (it counter-offers
 * its newest legacy revision). A *newer* unknown revision on `initialize` is
 * left to the SDK's ordinary negotiation, which is the spec's behaviour.
 */
export const OLDEST_SERVED_REVISION =
  LEGACY_REVISIONS[LEGACY_REVISIONS.length - 1];

/**
 * The revision a 2025-era request that names none is taken to speak: no
 * `MCP-Protocol-Version` header and no `initialize` means `2025-03-26`, by
 * the protocol's backwards-compatibility rule — whether or not it is served.
 */
export const UNDECLARED_LEGACY_REVISION = '2025-03-26';

/** Cache hint on `tools/list` (2026-07-28 leg only; 2025-era results carry none). */
export const TOOLS_LIST_TTL_MS = 300_000;

/**
 * `read_deployment_log`'s window: the lines a call answers when
 * it names none, and the most it answers however many it names — a request
 * above the cap is answered at the cap, not refused.
 */
export const LOG_WINDOW_DEFAULT_LINES = 100;
export const LOG_WINDOW_MAX_LINES = 500;

/**
 * The most bytes one window may carry, set as the `tail` exec's `maxBuffer`
 * on the machine holding the log. Stated rather than inherited: Node's local
 * default is the same 1 MiB, but the SSH branch has no cap of its own, and 500
 * lines of a build that prints progress bars can be far larger than that. A
 * window past it answers a declared failure asking for fewer lines.
 */
export const LOG_WINDOW_MAX_BYTES = 1024 * 1024;

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BASELINE } from './route-permissions.baseline';

/**
 * `PermissionsGuard`'s fail-open, made **documented** rather than silent.
 *
 * The guard's third statement is `if (!required) return true;` — a route
 * carrying no `@RequirePermission` passes through it — and the two routes the
 * `service: ['update']` change was first filed about, `PATCH /compose/:id` and
 * `PATCH /applications/:id`, carry none. So the guard is not a second defect
 * beside the missing action: for those routes it is *why* the only gate was the
 * service layer's `checkServiceAccess`, whose `action` defaults to `'read'`.
 *
 * **Making the guard fail closed was rejected**, and this file is the
 * proportionate answer that replaced it. 113 of the 307 mutating handlers in
 * `src` deliberately carry no decorator and are gated in the service layer
 * instead — on `requireInstanceAuthority`, on `ensureEnterprise`, on a webhook
 * signature, on "acts on the caller's own record" — so fail-closed would refuse
 * a third of the product's writes. The guard's own docblock states the contract
 * (*"Routes without the metadata pass through"*) and that contract is
 * load-bearing.
 *
 * What is achievable is that the pass-through be **written down**. Every
 * undecorated mutating handler is listed in `BASELINE`
 * (`route-permissions.baseline.ts`) with the gate that actually protects it,
 * so a new one goes red and has to be added on purpose, with its gate named
 * by whoever adds it. A reader who wants to make the guard fail
 * closed finds this list first and sees the size of what it would break.
 *
 * The shape is `describe-names.spec.ts`'s and `workload-presence.spec.ts`'s
 * `describe('backend/test')` block's, for their stated reason: nothing in
 * ESLint can hold this. `no-restricted-syntax` sees one file's AST, and
 * deciding whether a handler is gated means reading the service it delegates
 * to and the service that one delegates to. So it is checked from here — walk,
 * collect, assert the list is empty.
 *
 * **The gates are named, not merely acknowledged.** Every value is checked
 * against `src`: each mixed-case identifier in it has to be a word `src`
 * actually contains, so a typo, a renamed method or a placeholder fails rather
 * than sitting there reassuring a reader. The handler that genuinely has no
 * gate says `NONE:` and is counted separately, so the count cannot grow
 * without an edit to the number below. It was four until
 * `POST /templates/preview` and the two AI probes were gated, which is the
 * direction that number is allowed to move.
 */

const backendRoot = join(__dirname, '..', '..');

/**
 * Verbs that can change something. `@Get` is out of scope. `@All` is in:
 * it serves every verb, a `POST` and a `DELETE` included, so an undecorated
 * one is as open as an undecorated `@Post` (the Trace store proxy is an
 * `@Public()` `@All`, whose token-and-entitlement gate is written down in
 * `BASELINE` for that reason).
 */
const MUTATING_VERBS = ['Post', 'Patch', 'Put', 'Delete', 'All'] as const;

/** Every `.ts` file under `dir`, recursively. */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (entry.isFile() && path.endsWith('.ts')) found.push(path);
  }
  return found;
}

interface Handler {
  /** Path relative to `backend/`, so a failure is a thing you can open. */
  readonly file: string;
  readonly verb: string;
  readonly handler: string;
  readonly decorated: boolean;
}

/**
 * The decorator block above a method, read upwards.
 *
 * Parsed by *method* rather than by verb decorator on purpose: Nest applies
 * `@Post`, `@HttpCode` and `@RequirePermission` in any order, so a scanner
 * anchored on the verb has to guess how far to look and in which direction.
 * The method declaration is the fixed point, and the block above it is
 * contiguous — a blank line, a docblock or a `//` comment is part of it, a
 * statement ends it.
 */
const DECLARATION =
  /^ {2}(?:(?:public|private|protected)\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/;

function decoratorsAbove(lines: string[], index: number): string {
  const found: string[] = [];
  for (let i = index - 1; i >= 0; i -= 1) {
    const text = lines[i].trim();
    if (
      text === '' ||
      text.startsWith('*') ||
      text.startsWith('//') ||
      text.startsWith('/*')
    ) {
      continue;
    }
    if (!text.startsWith('@')) break;
    found.push(text);
  }
  return found.join(' ');
}

/** Every mutating handler in `src/**\/*.controller.ts`. */
function mutatingHandlers(): Handler[] {
  const handlers: Handler[] = [];
  const controllers = walk(join(backendRoot, 'src'))
    .filter((file) => file.endsWith('.controller.ts'))
    .sort();

  for (const file of controllers) {
    const lines = readFileSync(file, 'utf8').split('\n');
    // A `@RequirePermission` at column zero is the class-level one, which the
    // guard reads through `getAllAndOverride` and which therefore covers every
    // handler in the file.
    const classLevel = lines.some((line) =>
      line.startsWith('@RequirePermission'),
    );

    lines.forEach((line, index) => {
      const declared = DECLARATION.exec(line);
      if (!declared || declared[1] === 'constructor') return;
      if (line.trim().startsWith('@')) return;

      const decorators = decoratorsAbove(lines, index);
      const verb = MUTATING_VERBS.find((candidate) =>
        decorators.includes(`@${candidate}(`),
      );
      if (!verb) return;

      handlers.push({
        file: relative(backendRoot, file),
        verb: verb.toUpperCase(),
        handler: declared[1],
        decorated: decorators.includes('@RequirePermission') || classLevel,
      });
    });
  }
  return handlers;
}

/** What BASELINE keys on: stable when the lines around it move (§1.2). */
const key = ({ file, verb, handler }: Handler) =>
  `${file} :: ${verb} ${handler}`;

const undecorated = () =>
  mutatingHandlers().filter((found) => !found.decorated);

/**
 * Every mixed-case word in `src`, which is what a named gate has to be built
 * out of. Lower-case-only tokens (`service`, `read`, `create`) and
 * all-upper-case ones (`NONE`, `POST`) are prose or statement literals and are
 * not checked; a `checkServiceAccess` or a `ForwardAuthService` is a claim
 * about the tree and is.
 */
function mixedCaseWordsInSrc(): Set<string> {
  const words = new Set<string>();
  for (const file of walk(join(backendRoot, 'src'))) {
    for (const [word] of readFileSync(file, 'utf8').matchAll(
      /[A-Za-z_$][\w$]*/g,
    )) {
      words.add(word);
    }
  }
  return words;
}

const isChecked = (word: string) =>
  /[A-Z]/.test(word) && /[a-z]/.test(word) && word.length > 2;

describe('CODING_STANDARDS.md', () => {
  describe("§1.2, on PermissionsGuard's documented fail-open", () => {
    it('leaves no undecorated mutating handler whose gate is not written down', () => {
      const unlisted = undecorated()
        .map(key)
        .filter((entry) => !(entry in BASELINE));

      expect(unlisted).toEqual([]);
    });

    /**
     * The load-bearing half, and the same one `describe-names.spec.ts` states:
     * without it the list is an append-only amnesty and the test above can be
     * satisfied by writing the new route down. It can shrink — a handler that
     * gains a `@RequirePermission` leaves — and it cannot grow without an
     * argument in review about why this one also has to be gated in the
     * service layer.
     */
    it('holds the list at the size it was frozen at, or smaller', () => {
      // 114 → 116 for PUT and DELETE /settings/traefik/dns-challenge. The
      // argument: they are two more of the Traefik family whose target forks on
      // `serverId` — instance authority on the platform host, owner/ admin plus
      // `checkServerAccess` on a Server — and no statement can say that:
      // `traefikFiles:write` is grantable to a custom role, which ADR-0013's
      // third consequence rules out for the host branch. Their siblings
      // (`writeTraefikEnv`, `updateTraefikPorts`) sit here for the same reason.
      // 116 → 117 for POST /settings/traefik/request-metrics (Enable request
      // metrics): the spec binds it to "the existing Traefik restart gate",
      // which is `traefikTargetAuthority` on the same fork. 117 → 119 for a
      // census change, which added no route to this list: it began reading
      // `@All`, and the two `@Public()` catch-alls it then saw (better- auth's
      // handler and the MCP endpoint's 405) had been there all along. 119 → 120
      // for the Gateway, `@Public()` like `POST /mcp`: an Agent key is its only
      // guard, and the statement it checks (`service: call`) is on the AI
      // model's own Application, which only the service knows. 120 → 122 for
      // POST /settings/cloud-runs-concurrency and
      // /settings/cloud-run-time-limit: install-wide limits on the platform
      // host's Cloud run pool, under instance authority exactly like their
      // siblings `updateBuildsConcurrency` and `updateRequestedPreviewMaxTtl`,
      // which no grantable statement can say (ADR-0013). 122 → 124 for the
      // Operator suspend and lift: they act on another Organization than the
      // caller's, under instance authority held in the Instance organization
      // (ADR-0050), which no statement on the active Organization can say. 124
      // → 125 for the Operator Enterprise switch, for the same reason. 125 →
      // 128 for the Proven domains add, check and remove: SSO's own
      // `ensureEnterprise` gate, as every other SSO write on this list. 128 →
      // 129 for the license check-now: `LicenseService.assertOwner`, as every
      // other license write. 129 → 130 for the Starter → Business upgrade:
      // `BillingService.assertAdmin`, as every other billing write. 130 → 132
      // for the downgrade to Starter and Keep Business, the same gate. 132 →
      // 134 for Cancel trial and Keep <plan>, the same gate. 134 → 135 for
      // "Stop paying for it": the Paying Organization's owner or
      // admin, checked in the service as every other billing write. 135 →
      // 136 for the Operator's Server markup and margin floor: instance
      // settings under instance authority, as the other Operator writes.
      // 136 → 137 for the Operator's Delete of a machine nothing owns, under
      // instance authority too.
      // 137 → 141 for the Operator's abuse actions (#1401): forward and
      // close an abuse report, power a Bought Server off and on, under the
      // same gate.
      // 141 → 143 for the Operator's reprice of Bought Servers, its preview
      // and its confirm (#1400): the same Operator gate.
      // 143 → 144 for the Trace store proxy (ADR-0075), which was decorated
      // and is now `@Public()`: the frame it serves is sandboxed, so its
      // requests carry no session, and its frame token names the Member the
      // service re-runs `checkServiceAccess` as.
      expect(Object.keys(BASELINE).length).toBeLessThanOrEqual(144);
    });

    /**
     * And the other way a baseline rots: an entry whose handler was decorated,
     * renamed or deleted stays behind as a standing amnesty for that name, so
     * a later re-introduction of an ungated route passes. Every entry has to
     * name a live handler.
     */
    it('carries no entry for a handler that is no longer undecorated', () => {
      const live = new Set(undecorated().map(key));

      expect(Object.keys(BASELINE).filter((entry) => !live.has(entry))).toEqual(
        [],
      );
    });

    /**
     * What makes the list a record of gates rather than a list of exemptions.
     * A gate is only written down if the words it is written out of exist —
     * `SettingsService.requireInstanceAuthority` has to name a method
     * `requireInstanceAuthority` on something called `SettingsService`, and a
     * rename of either fails here instead of leaving a sentence that is no
     * longer true.
     */
    it('names a gate out of words src actually contains', () => {
      const known = mixedCaseWordsInSrc();
      const unknown = Object.entries(BASELINE).flatMap(([entry, gate]) =>
        [...gate.matchAll(/[A-Za-z_$][\w$]*/g)]
          .map(([word]) => word)
          .filter(isChecked)
          .filter((word) => !known.has(word))
          .map((word) => `${entry} :: ${word}`),
      );

      expect(unknown).toEqual([]);
    });

    /**
     * The handlers with no authorization at all beyond a session. Each is a
     * `@Post` that writes nothing — a version comparison against Docker Hub is
     * what is left — which is why they were recorded rather than fixed
     * inside a permission change. The count is frozen so a second cannot arrive
     * quietly, and the number is what a reviewer argues about.
     *
     * **It was four, and each departure is why the number is worth arguing
     * about.** `POST /templates/preview` was on this list as a template render
     * that writes nothing, and writing nothing is not the same as disclosing
     * nothing: it read an `environmentId` or a `serverId` the caller was not
     * entitled to and rendered the Project's name and the Server's ip address
     * into its answer. What earns a `NONE:` is taking the whole subject
     * from the request body and resolving no organization-owned row — which is
     * a narrower property than "writes nothing", and is the one found the
     * two AI probes did not have either.
     */
    it('holds the ungated count at one', () => {
      const ungated = Object.entries(BASELINE)
        .filter(([, gate]) => gate.startsWith('NONE:'))
        .map(([entry]) => entry);

      expect(ungated).toHaveLength(1);
    });
  });
});

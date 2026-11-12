import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * `ComposeService.createByTemplate`'s precondition, made **checked** rather
 * than documented (surfaced by a cross-organization sweep).
 *
 * The method inserts a Compose row and has no `PermissionCtx`. Its private
 * `findEnvironmentOrganization` therefore resolves `data.environmentId`
 * unscoped — any Environment on the instance — and the organization it returns
 * is what the method's own H-83 claimable check then runs against. It is safe
 * today for exactly one reason: both callers resolve the same `environmentId`
 * inside the requester's organization *first*, with
 * `findParentEnvironment(ctx, input.environmentId)` and then
 * `checkServiceAccess(ctx, parent.projectId, 'create')`. No controller reaches
 * the method.
 *
 * **Why the docblock is not sufficient on its own.** It said "guarded by the
 * caller" and nothing more, and that sentence reads as detail rather than as
 * the only thing between this sink and a Compose inserted into another
 * organization's Environment, with the hostname-ownership question asked of the
 * wrong organization on the way. H-20 named the shape: two writers reaching one
 * sink, each carrying its own copy of the rule, and a third one arriving later
 * with none. A third caller is not hypothetical here; `createByTemplate` is the
 * insert every "deploy a pre-built stack" path is going to want.
 *
 * **What the real fix is, and why this file exists instead.** Taking a
 * `PermissionCtx` and doing the org-scoped resolve in the sink needs no list at
 * all, and is the right end state — it is a signature change across
 * `ai.service.ts` and its suites (the `template.toml` deploy, its other
 * caller, was removed in #1364), i.e. outside the
 * file set the routable guard was implemented in. Until then the property is
 * held from here, and this file is what a reader who wants to make that change
 * finds first.
 *
 * The shape is `test/coding-standards/route-permissions.spec.ts`'s and
 * `composed-creates.spec.ts`'s, for their stated reason: nothing in ESLint can
 * hold this. Deciding whether a call site is guarded means reading the method
 * that contains it and recognising an org-scoped lookup of the same expression.
 * So it is checked from here — walk, resolve one hop, assert the list is empty.
 */

const backendRoot = join(__dirname, '..', '..');

/**
 * Every caller of `createByTemplate` in `src`, frozen. It can grow — a third
 * pre-built-stack path is a normal thing to add — but not silently: an
 * addition here says "I have read the precondition above and my caller carries
 * it", and the per-caller assertion below still has to agree.
 *
 * It is also the anti-rot half, and the more important one. If the method is
 * ever renamed, the walk finds nothing and every per-caller assertion passes
 * over an empty set; the count assertion is what says so.
 */
const CALLERS: readonly string[] = ['ai/ai.service.ts:AiService.deploy'];

/**
 * The lookups that answer "is this `environmentId` inside the requester's
 * organization". Both are private methods holding the same
 * `eq(project.organizationId, ctx.session.activeOrganizationId)` predicate as
 * `ComposeService.findParentEnvironment`; a new one has to be added here on
 * purpose, and its own scoping read while adding it.
 */
const SCOPED_ENVIRONMENT_LOOKUPS = ['findParentEnvironment'] as const;

/** Every `.ts` under `src`, `compose.service.ts` itself excluded. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!entry.name.endsWith('.ts')) return [];
    if (full.endsWith(join('compose', 'compose.service.ts'))) return [];
    return [full];
  });
}

interface CallSite {
  /** `ai/ai.service.ts:AiService.deploy` — the key {@link CALLERS} lists. */
  id: string;
  /** The enclosing method's body, for the one-hop resolution below. */
  body: string;
  /** The expression passed as `environmentId:` in the call's object literal. */
  environmentIdExpression: string | null;
}

/**
 * Resolution is deliberately **one hop**: the enclosing method's own body and
 * the expression the call passes. Anything threaded through a private helper
 * inside the caller would not be recognised, which is the point — the guard has
 * to be readable where the call is, which is where a reader looks for it too.
 */
function callSites(): CallSite[] {
  const found: CallSite[] = [];
  for (const file of sourceFiles(join(backendRoot, 'src'))) {
    const source = readFileSync(file, 'utf-8');
    if (!source.includes('createByTemplate(')) continue;
    const path = relative(join(backendRoot, 'src'), file).split('\\').join('/');
    const className = /export class (\w+)/.exec(source)?.[1] ?? '?';
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      // Only a call. A docblock mentioning the method by name is a reference,
      // not a writer reaching the sink.
      if (!/\.createByTemplate\(/.test(line) || /^\s*(\*|\/\/)/.test(line)) {
        return;
      }
      // Walk back to the enclosing method's signature and forward to its close,
      // both at the class's own two-space indent.
      let start = index;
      while (
        start > 0 &&
        !/^ {2}(?:private |public )?async \w+\(/.test(lines[start])
      ) {
        start -= 1;
      }
      const methodName = /async (\w+)\(/.exec(lines[start])?.[1] ?? '?';
      let end = index;
      while (end < lines.length - 1 && lines[end] !== '  }') end += 1;
      const body = lines.slice(start, end + 1).join('\n');
      // From *this* line's offset, not the file's first match: a file holding
      // two calls must read two argument lists.
      const lineOffset = lines.slice(0, index).join('\n').length;
      const call = source.slice(
        source.indexOf('.createByTemplate(', lineOffset),
      );
      const argument = call.slice(0, call.indexOf('});') + 1);
      found.push({
        id: `${path}:${className}.${methodName}`,
        body,
        environmentIdExpression:
          /environmentId:\s*([^,\n]+)/.exec(argument)?.[1]?.trim() ?? null,
      });
    });
  }
  return found;
}

describe('ComposeService.createByTemplate, and the callers its safety depends on', () => {
  const sites = callSites();

  it('are exactly the frozen set', () => {
    // Sorted so the failure names the newcomer rather than a reordering, and
    // non-empty so a rename of the method cannot quietly empty this file.
    expect(sites.map((site) => site.id).sort()).toEqual([...CALLERS].sort());
    expect(sites.length).toBeGreaterThan(0);
  });

  it.each(CALLERS)(
    '%s resolves the environmentId it passes inside the caller organization first',
    (caller) => {
      const site = sites.find((candidate) => candidate.id === caller);
      expect(site).toBeDefined();
      const expression = site?.environmentIdExpression;
      // The call has to name the id at all: a caller passing it through a
      // spread would defeat the check below without failing it.
      expect(expression).toEqual(expect.stringMatching(/\S/));
      const scoped = SCOPED_ENVIRONMENT_LOOKUPS.some((lookup) =>
        new RegExp(
          // `findParentEnvironment(ctx, input.environmentId)` — the same
          // expression, scoped by the same ctx, in this method's own body.
          `${lookup}\\(\\s*ctx\\s*,\\s*${(expression ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[,)]`,
        ).test(site?.body ?? ''),
      );
      expect(scoped).toBe(true);
    },
  );

  it('is reached by no controller', () => {
    // The other half of "guarded by the caller": a route that called it
    // directly would carry only `PermissionsGuard`, which passes an
    // undecorated handler through (`route-permissions.spec.ts`), and nothing
    // would have resolved the environment at all.
    const controllers = sourceFiles(join(backendRoot, 'src')).filter((file) =>
      file.endsWith('.controller.ts'),
    );
    const reaching = controllers.filter((file) =>
      /\.createByTemplate\(/.test(readFileSync(file, 'utf-8')),
    );
    expect(reaching).toEqual([]);
  });
});

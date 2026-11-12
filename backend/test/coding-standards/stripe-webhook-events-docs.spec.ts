import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HANDLED_EVENT_TYPES } from '../../src/cloud/billing/stripe-webhook-events';

/**
 * #1414: the Hosted instance's Stripe webhook endpoint was subscribed to 11
 * of the 13 events the backend handles, because the list lived only in
 * `stripe-webhook-events.ts` and no page told whoever sets the endpoint up.
 *
 * `docs/deploy.md` now lists them, and this holds the list to
 * `HANDLED_EVENT_TYPES`, the declaration the webhook controller accepts and
 * `BillingWebhookService`'s handler map is typed over, in both directions: an
 * event the backend handles and the page leaves out reds here, and so does
 * one the page names that the backend no longer handles (Stripe would get a
 * 400 for it). The last `describe` runs {@link problemsIn} on drifted copies.
 */

const repoRoot = join(__dirname, '..', '..', '..');
const PAGE = 'docs/deploy.md';
const page = readFileSync(join(repoRoot, PAGE), 'utf8');
const HEADING = '### The Stripe webhook endpoint';

/** The events the page's section lists, one `` - `type` `` bullet each. */
function listedEvents(text: string): string[] | undefined {
  const start = text.indexOf(`\n${HEADING}\n`);
  if (start === -1) return undefined;
  const rest = text.slice(start + HEADING.length + 2);
  const end = rest.search(/^#{1,3} /m);
  const section = end === -1 ? rest : rest.slice(0, end);
  return [...section.matchAll(/^- `([a-z_.]+)`/gm)].map((m) => m[1]);
}

function problemsIn(text: string): string[] {
  const listed = listedEvents(text);
  if (!listed) return [`${PAGE} has no "${HEADING}" section`];
  const handled: readonly string[] = HANDLED_EVENT_TYPES;
  return [
    ...handled
      .filter((type) => !listed.includes(type))
      .map((type) => `${PAGE} does not list handled event ${type}`),
    ...listed
      .filter((type) => !handled.includes(type))
      .map(
        (type) => `${PAGE} lists ${type}, which the webhook does not handle`,
      ),
  ];
}

describe('docs/deploy.md — the Stripe webhook endpoint subscribes to exactly the handled events', () => {
  it('lists exactly the events the billing webhook handles', () => {
    expect(problemsIn(page)).toEqual([]);
  });

  describe('the gate', () => {
    const listed = (types: readonly string[]) =>
      `\n${HEADING}\n\n${types.map((t) => `- \`${t}\``).join('\n')}\n\n## Next\n`;

    it('reds on a handled event the page leaves out', () => {
      expect(problemsIn(listed(HANDLED_EVENT_TYPES.slice(1)))).toEqual([
        `${PAGE} does not list handled event ${HANDLED_EVENT_TYPES[0]}`,
      ]);
    });

    it('reds on a listed event the webhook does not handle', () => {
      expect(
        problemsIn(listed([...HANDLED_EVENT_TYPES, 'invoice.created'])),
      ).toEqual([
        `${PAGE} lists invoice.created, which the webhook does not handle`,
      ]);
    });

    it('reds when the section is gone', () => {
      expect(problemsIn('# Deploying\n')).toEqual([
        `${PAGE} has no "${HEADING}" section`,
      ]);
    });
  });
});

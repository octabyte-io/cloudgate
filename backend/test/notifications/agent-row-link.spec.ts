import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENTS_SECTION_PATH,
  agentRowAnchor,
} from '../../src/notifications/agent-rate-limit-notifier.adapter';
import { EVENT_FLAG_COLUMNS } from '../../src/notifications/events/notification-event';

/**
 * What the "Agent rate limited" Notification promises about the console,
 * held against the console's own source rather than a second copy of a string —
 * the argument `deployment-link.spec.ts` makes for the deploy link:
 * nothing in `backend/` knows what the console serves, so a link can only be
 * checked by reading `frontend/src`.
 */

const consoleSrc = join(__dirname, '..', '..', '..', 'frontend', 'src');

describe('agentRowAnchor', () => {
  it('names a page the console serves', () => {
    const page = join(
      consoleSrc,
      'app',
      '(console)',
      AGENTS_SECTION_PATH,
      'page.tsx',
    );

    expect(existsSync(page)).toBe(true);
  });

  it("is the id the console puts on the Agent's row", () => {
    const row = readFileSync(
      join(consoleSrc, 'features', 'agents', 'agent-rate-limited.tsx'),
      'utf8',
    );
    const consoleAnchor =
      /function agentRowAnchor\(agentId: string\): string \{\s*return `([^`$]*)\$\{agentId\}`;/.exec(
        row,
      );

    expect(consoleAnchor).not.toBeNull();
    expect(agentRowAnchor('a1')).toBe(`${consoleAnchor![1]}a1`);
  });
});

describe('EVENT_FLAG_COLUMNS', () => {
  // The console's switches are a hand copy of these columns. One missing there
  // is an event nobody can opt into — which for an opt-in event, off by
  // default, is an event that never reaches anyone.
  it('has a switch in the console for every flag', () => {
    const endpoint = readFileSync(
      join(consoleSrc, 'lib', 'api', 'endpoints', 'notifications.ts'),
      'utf8',
    );
    const block = /export const EVENT_FLAGS = \[([^\]]*)\] as const;/.exec(
      endpoint,
    );
    expect(block).not.toBeNull();
    const consoleFlags = [...block![1].matchAll(/"([A-Za-z]+)"/g)].map(
      ([, flag]) => flag,
    );

    expect(consoleFlags.sort()).toEqual(
      Object.values(EVENT_FLAG_COLUMNS).sort(),
    );
  });
});

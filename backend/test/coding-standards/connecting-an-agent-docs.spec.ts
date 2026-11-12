import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UNLICENSED_BUILDS_CONCURRENCY } from '../../src/deployment-queue/concurrency';
import { MIN_MASKED_CREDENTIAL_LENGTH } from '../../src/destinations/s3-credentials';
import {
  LOG_WINDOW_DEFAULT_LINES,
  LOG_WINDOW_MAX_BYTES,
  LOG_WINDOW_MAX_LINES,
  MODERN_REVISIONS,
  LEGACY_REVISIONS,
  OLDEST_SERVED_REVISION,
  TOOL_DEADLINE_MS,
} from '../../src/mcp/mcp-limits';
import { READ_BUDGET, WRITE_BUDGET } from '../../src/mcp/rate-bucket';
import { EPISODE_QUIET_MS } from '../../src/mcp/rate-limit-episodes';

/**
 * Spec Testing Decisions §4: *"every number
 * `docs/connecting-an-agent.md` states equals its constant."*
 *
 * The page is where an operator plans around the MCP endpoint's limits, and
 * every one of them is a constant with no setting — so a page that says "120
 * a minute" after the bucket moved to 100 is the only place the change would
 * go unnoticed. Each number the page states is read by an anchored pattern and
 * compared with the constant that decides it, imported rather than copied.
 *
 * **Every number, not the ones we thought of.** After the pinned phrases are
 * cut out, whatever digits are left must be protocol vocabulary (an HTTP
 * status or a JSON-RPC code, which no operator setting or Cloudgate constant
 * moves). A new number written into the page reds here until it gets a
 * pattern and a constant — so the page cannot grow an unpinned claim.
 *
 * Two numbers are written as words because the sentence reads that way ("one
 * build at a time", "an hour with no 429"); their patterns read the word.
 *
 * The page also names all eight limits as its `###` headings under `##
 * Limits`, and carries no client snippet: the console's Connect panel owns
 * those (`frontend/src/features/agents/connect-snippets.ts`, pinned by its own
 * parse spec), and a copy here would drift from it silently.
 *
 * The last `describe` is the gate on the gate: an empty problem list is this
 * spec's passing state, so {@link problemsIn} is run against drifted copies of
 * the page that must each be reported.
 */

const repoRoot = join(__dirname, '..', '..', '..');
const PAGE = 'docs/connecting-an-agent.md';
const page = readFileSync(join(repoRoot, PAGE), 'utf8');

/** The eight limits, as the page's headings name them, in order. */
const LIMITS = [
  'Rate limits',
  'Coalescing',
  'One build at a time per Server without a licence',
  'What the mask cannot hide',
  'Protocol revisions',
  'The deadline',
  'The log window',
  'Requests carrying an Origin header',
] as const;

/** Numbers the page may state that no Cloudgate constant decides. */
const PROTOCOL_CODES = new Set([
  // HTTP statuses the endpoint answers.
  '400',
  '401',
  '403',
  '405',
  '406',
  '415',
  '429',
  // JSON-RPC error codes, written with their minus sign on the page.
  '32602',
  '32022',
]);

const WORDS: Readonly<Record<string, number>> = { a: 1, an: 1, one: 1 };

const count = (text: string): number =>
  WORDS[text.toLowerCase()] ?? Number(text);

const DATE = String.raw`\d{4}-\d{2}-\d{2}`;
const dates = (text: string): string[] =>
  text.match(new RegExp(DATE, 'g')) ?? [];

interface Pin {
  /** What the number is, for a failure message. */
  readonly what: string;
  /** Global and anchored to its phrase; every match is checked. */
  readonly pattern: RegExp;
  /** The captures every match must carry. */
  readonly expected: readonly string[];
  /** Reads a capture into what `expected` holds; `String` when omitted. */
  readonly read?: (capture: string) => string;
}

const PINS: readonly Pin[] = [
  {
    what: 'READ_BUDGET',
    pattern: /\*\*Reads\*\*: (\d+) a minute, with a burst of (\d+)/g,
    expected: [String(READ_BUDGET.perMinute), String(READ_BUDGET.burst)],
  },
  {
    what: 'WRITE_BUDGET',
    pattern: /\*\*Writes\*\*: (\d+) a minute, with a burst of (\d+)/g,
    expected: [String(WRITE_BUDGET.perMinute), String(WRITE_BUDGET.burst)],
  },
  {
    what: 'EPISODE_QUIET_MS, in hours',
    pattern: /after (an|one|\d+) hours? with no 429/gi,
    expected: [String(EPISODE_QUIET_MS / 3_600_000)],
    read: (capture) => String(count(capture)),
  },
  {
    what: 'UNLICENSED_BUILDS_CONCURRENCY',
    pattern: /builds (one|\d+) Deployments? at a time/gi,
    expected: [String(UNLICENSED_BUILDS_CONCURRENCY)],
    read: (capture) => String(count(capture)),
  },
  {
    what: 'MIN_MASKED_CREDENTIAL_LENGTH',
    pattern: /(\d+) characters/g,
    expected: [String(MIN_MASKED_CREDENTIAL_LENGTH)],
  },
  {
    what: 'MODERN_REVISIONS',
    pattern: new RegExp(`^- \\*\\*2026-era\\*\\*: (.*)$`, 'gm'),
    expected: [MODERN_REVISIONS.join(' ')],
    read: (capture) => dates(capture).join(' '),
  },
  {
    what: 'LEGACY_REVISIONS',
    pattern: new RegExp(`^- \\*\\*2025-era\\*\\*: (.*)$`, 'gm'),
    expected: [LEGACY_REVISIONS.join(' ')],
    read: (capture) => dates(capture).join(' '),
  },
  {
    // "a 2025-era request": the year names a family of served revisions.
    what: 'a revision era, the year of a served revision',
    pattern: /\b(\d{4})-era\b/g,
    expected: ['served'],
    read: (year) =>
      [...MODERN_REVISIONS, ...LEGACY_REVISIONS].some((revision) =>
        revision.startsWith(`${year}-`),
      )
        ? 'served'
        : `no served revision in ${year}`,
  },
  {
    what: 'OLDEST_SERVED_REVISION',
    pattern: new RegExp(`older than \`(${DATE})\``, 'g'),
    expected: [OLDEST_SERVED_REVISION],
  },
  {
    // Not a constant — the revision the SDK's defaults would still accept —
    // so what is pinned is that it is one the endpoint refuses.
    what: 'a refused revision, older than OLDEST_SERVED_REVISION',
    pattern: new RegExp(`including \`(${DATE})\``, 'g'),
    expected: ['refused'],
    read: (capture) =>
      capture < OLDEST_SERVED_REVISION ? 'refused' : `served ${capture}`,
  },
  {
    what: 'TOOL_DEADLINE_MS, in seconds',
    pattern: /(\d+)[- ]seconds?/g,
    expected: [String(TOOL_DEADLINE_MS / 1000)],
  },
  {
    what: 'LOG_WINDOW_DEFAULT_LINES',
    pattern: /the last (\d+) lines/g,
    expected: [String(LOG_WINDOW_DEFAULT_LINES)],
  },
  {
    what: 'LOG_WINDOW_MAX_LINES',
    pattern: /(?:never more than|answered at) (\d+)/g,
    expected: [String(LOG_WINDOW_MAX_LINES)],
  },
  {
    what: 'LOG_WINDOW_MAX_BYTES, in MiB',
    pattern: /(\d+) MiB/g,
    expected: [String(LOG_WINDOW_MAX_BYTES / 1024 / 1024)],
  },
];

/** A fenced block a client would read as its config, or a client's config key. */
const SNIPPET_SHAPES: readonly [string, RegExp][] = [
  ['a fenced json block', /^```\s*jsonc?\b/im],
  ['a fenced toml block', /^```\s*toml\b/im],
  ['mcpServers', /mcpServers/],
  ['mcp_servers', /mcp_servers/],
];

/** The `###` headings under `## Limits`, up to the next `##`. */
function limitHeadings(text: string): string[] {
  const section = /^## Limits\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text);
  if (!section) return [];
  return [...section[1].matchAll(/^### (.+?)\s*$/gm)].map(([, title]) => title);
}

/** Everything wrong with `text` as the page; empty when it is right. */
function problemsIn(text: string): string[] {
  const problems: string[] = [];
  let rest = text;

  for (const { what, pattern, expected, read = String } of PINS) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length === 0)
      problems.push(`${what}: the page no longer states it`);
    for (const match of matches) {
      const found = match.slice(1).map((capture) => read(capture));
      if (JSON.stringify(found) !== JSON.stringify(expected)) {
        problems.push(
          `${what}: "${match[0]}" says ${found.join(', ')}, the constant says ${expected.join(', ')}`,
        );
      }
    }
    rest = rest.replace(pattern, ' ');
  }

  for (const [number] of rest.matchAll(new RegExp(`${DATE}|\\d+`, 'g'))) {
    if (!PROTOCOL_CODES.has(number)) {
      problems.push(`an unpinned number: ${number}`);
    }
  }

  const headings = limitHeadings(text);
  if (JSON.stringify(headings) !== JSON.stringify(LIMITS)) {
    problems.push(
      `the Limits headings are [${headings.join(' | ')}], not the eight limits`,
    );
  }

  for (const [shape, pattern] of SNIPPET_SHAPES) {
    if (pattern.test(text)) problems.push(`a client snippet: ${shape}`);
  }

  return problems;
}

describe('docs/connecting-an-agent.md — every number it states read from the constant that decides it, the eight limits, and no client snippet', () => {
  it('states every number as its constant, names all eight limits, and carries no client snippet', () => {
    expect(problemsIn(page)).toEqual([]);
  });

  it('names the endpoint and the header an Agent connects with', () => {
    expect(page).toContain('`/mcp`');
    expect(page).toContain('Authorization: Bearer');
  });

  describe('the gate on the gate: a drifted page is reported', () => {
    const drifted = (from: string | RegExp, to: string): string[] => {
      const text = page.replace(from, to);
      expect(text).not.toBe(page);
      return problemsIn(text);
    };

    it('reds when a stated budget drifts from READ_BUDGET', () => {
      expect(
        drifted(
          `**Reads**: ${READ_BUDGET.perMinute} a minute`,
          `**Reads**: ${READ_BUDGET.perMinute + 1} a minute`,
        ),
      ).toEqual([expect.stringMatching(/^READ_BUDGET: /)]);
    });

    it('reds when the deadline drifts, wherever the page states it', () => {
      const seconds = TOOL_DEADLINE_MS / 1000;
      const problems = drifted(`${seconds} seconds`, `${seconds + 15} seconds`);
      expect(problems).toEqual([
        expect.stringMatching(/^TOOL_DEADLINE_MS, in seconds: /),
      ]);
    });

    it('reds when a word-number drifts from UNLICENSED_BUILDS_CONCURRENCY', () => {
      expect(
        drifted(
          /builds one Deployment at a time/,
          'builds 2 Deployments at a time',
        ),
      ).toEqual([expect.stringMatching(/^UNLICENSED_BUILDS_CONCURRENCY: /)]);
    });

    it('reds when a served revision is dropped from the list', () => {
      expect(drifted(`\`${LEGACY_REVISIONS[1]}\`, `, '')).toEqual([
        expect.stringMatching(/^LEGACY_REVISIONS: /),
      ]);
    });

    it('reds on a number no pattern pins', () => {
      expect(
        drifted(/^## Limits$/m, '## Limits\n\nUp to 7 keys per Agent.'),
      ).toEqual(['an unpinned number: 7']);
    });

    it('reds when a pinned statement is deleted', () => {
      expect(drifted(/\*\*Writes\*\*: [^\n]*/, '**Writes**: fewer.')).toEqual([
        'WRITE_BUDGET: the page no longer states it',
      ]);
    });

    it('reds when a limit loses its heading', () => {
      expect(drifted(/^### Coalescing$/m, '#### Coalescing')).toEqual([
        expect.stringMatching(/^the Limits headings are /),
      ]);
    });

    it('reds on a client snippet', () => {
      expect(
        drifted(
          /^## Limits$/m,
          '```json\n{ "mcpServers": { "cloudgate": {} } }\n```\n\n## Limits',
        ),
      ).toEqual([
        'a client snippet: a fenced json block',
        'a client snippet: mcpServers',
      ]);
      expect(
        drifted(
          /^## Limits$/m,
          '```toml\n[mcp_servers.cloudgate]\n```\n\n## Limits',
        ),
      ).toEqual([
        'a client snippet: a fenced toml block',
        'a client snippet: mcp_servers',
      ]);
    });
  });
});

describe('CHANGELOG.md — the section above the first tagged version answers the personal-key question', () => {
  const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const unreleased =
    /^## Unreleased\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(changelog)?.[1] ??
    '';

  it('asks the question and answers both halves: a script keeps its key, an AI agent gets an Agent', () => {
    expect(unreleased).toContain(
      'I have a script that uses an API key today. What do I do?',
    );
    expect(unreleased).toContain('Your key is now called a *personal key*');
    expect(unreleased).toContain('A personal key is refused there.');
    expect(unreleased).toContain(PAGE);
  });
});

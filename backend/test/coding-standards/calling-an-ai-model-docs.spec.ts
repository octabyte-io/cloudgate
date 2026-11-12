import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aiModelEndpoint } from '../../src/ai-models/ai-model-endpoint';
import { aiUsageOutcomeEnum } from '../../src/gateway/ai-usage.schema';
import { USAGE_RAW_RETENTION_DAYS } from '../../src/token-spend/token-spend';
import {
  AI_MODEL_NOT_FOUND,
  KEY_REFUSED,
  NOT_ANSWERING,
  NOT_FORWARDED,
  NOT_RUNNING,
  wrongModel,
} from '../../src/gateway/gateway-refusals';
import type { GatewayRefusal } from '../../src/gateway/gateway-refusals';

/**
 * Spec story 99: `docs/calling-an-ai-model.md` *"matches the
 * shipped endpoint, codes and console wording"*, and recommends one caller
 * Agent per calling Service.
 *
 * The page is what an operator wires a chat front end or a vector store by, so
 * every claim an SDK or a console would contradict is read from where it is
 * decided rather than copied:
 *
 * - **The refusals table** is exactly the gateway's refusals, each row its
 *   status and its message as the gateway sends it (`gateway-refusals.ts`), so
 *   a reworded refusal or a new one reds here until the page says it.
 * - **The endpoint** is the one `aiModelEndpoint` builds, the helper the Model
 *   tab, `get_service` and the gateway's route share.
 * - **How a call ended** names the usage row's outcomes, `ai_usage_outcome`.
 * - **How long a usage entry is kept** is `USAGE_RAW_RETENTION_DAYS`.
 * - **Every console label the page bolds** is checked against the frontend
 *   source that renders it, so a renamed button reds here.
 *
 * The last `describe` is the gate on the gate: an empty problem list is this
 * spec's passing state, so {@link problemsIn} is run against drifted copies.
 */

const repoRoot = join(__dirname, '..', '..', '..');
const PAGE = 'docs/calling-an-ai-model.md';
const page = readFileSync(join(repoRoot, PAGE), 'utf8');
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');

/** Every refusal the gateway sends, as the table's rows must state them. */
const REFUSALS: readonly GatewayRefusal[] = [
  KEY_REFUSED,
  AI_MODEL_NOT_FOUND,
  NOT_FORWARDED,
  wrongModel('<model>'),
  NOT_RUNNING,
  NOT_ANSWERING,
];

/** The endpoint as the page spells it, with its two placeholders. */
const ENDPOINT = aiModelEndpoint('https://<console domain>', '<AI model id>')!;

const RECOMMENDATION = 'one caller Agent per calling Service';

/**
 * Console labels the page names in bold, each with the frontend file that
 * renders it and the text that file carries (the label itself unless given).
 */
const CONSOLE_WORDING: readonly {
  label: string;
  file: string;
  source?: string;
}[] = [
  {
    label: 'Add an AI model',
    file: 'frontend/src/features/environment/panels/services.tsx',
  },
  {
    label: 'Model',
    file: 'frontend/src/lib/shell/tabs/application.ts',
    source: 'label: "Model"',
  },
  {
    label: 'Connect a client',
    file: 'frontend/src/features/application/model/model-connect-card.tsx',
  },
  {
    label: 'Endpoint',
    file: 'frontend/src/features/application/model/model-connect-card.tsx',
    source: '>Endpoint<',
  },
  {
    label: 'Create a caller Agent',
    file: 'frontend/src/features/application/model/model-connect-card.tsx',
  },
  {
    label: 'Agents that can call it',
    file: 'frontend/src/features/application/model/model-connect-card.tsx',
  },
  {
    label: 'Caller',
    file: 'frontend/src/lib/api/endpoints/roles.ts',
    source: 'agentCaller: "Caller"',
  },
  {
    label: 'Manage access',
    file: 'frontend/src/features/agents/agent-row.tsx',
  },
  {
    label: 'Suspend',
    file: 'frontend/src/features/agents/agent-row.tsx',
    source: '"Suspend"',
  },
  {
    label: 'Token spend',
    file: 'frontend/src/features/application/model/token-spend-card.tsx',
    source: 'title="Token spend"',
  },
  {
    label: 'Removed',
    file: 'frontend/src/features/application/model/token-spend-card.tsx',
    source: '<Chip>Removed</Chip>',
  },
  {
    label: 'Token spend, 30 days',
    file: 'frontend/src/features/environment/environment-facts-card.tsx',
  },
  {
    label: 'Services',
    file: 'frontend/src/lib/shell/tabs/environment.ts',
    source: 'label: "Services"',
  },
  {
    label: 'Variables',
    file: 'frontend/src/lib/shell/tabs/application.ts',
    source: 'label: "Variables"',
  },
  {
    label: 'Add a provider',
    file: 'frontend/src/features/integrations/ai/ai-spec.tsx',
  },
];

const sources = new Map(
  CONSOLE_WORDING.map(({ file }) => [
    file,
    readFileSync(join(repoRoot, file), 'utf8'),
  ]),
);

/** A table row: `| <status> | \`<message>\` | …`. */
const ROW = /^\| (\d{3}) \| `([^`]+)` \|/gm;

/** Everything wrong with `text` as the page; empty when it is right. */
function problemsIn(
  text: string,
  frontend: ReadonlyMap<string, string> = sources,
): string[] {
  const problems: string[] = [];

  const rows = [...text.matchAll(ROW)].map(
    ([, status, message]) => `${status} ${message}`,
  );
  const expected = REFUSALS.map(
    ({ status, message }) => `${status} ${message}`,
  );
  for (const refusal of expected) {
    if (!rows.includes(refusal)) {
      problems.push(`a refusal the table does not state: ${refusal}`);
    }
  }
  for (const row of rows) {
    if (!expected.includes(row)) {
      problems.push(`a table row the gateway does not send: ${row}`);
    }
  }

  if (!text.includes(ENDPOINT)) {
    problems.push(`the endpoint is not spelled ${ENDPOINT}`);
  }

  const ended = /^- How the call ended: (.*)$/m.exec(text)?.[1] ?? '';
  const outcomes = [...ended.matchAll(/`([^`]+)`/g)].map(([, name]) => name);
  if (
    JSON.stringify(outcomes) !== JSON.stringify(aiUsageOutcomeEnum.enumValues)
  ) {
    problems.push(
      `the outcomes are [${outcomes.join(', ')}], not ai_usage_outcome's`,
    );
  }

  for (const { label, file, source = label } of CONSOLE_WORDING) {
    if (!text.includes(`**${label}**`)) {
      problems.push(`the page no longer names **${label}**`);
    }
    if (!frontend.get(file)?.includes(source)) {
      problems.push(`${file} no longer carries ${source}`);
    }
  }

  const kept = [...text.matchAll(/kept for (\d+) days/g)].map(([, n]) => n);
  if (
    JSON.stringify(kept) !== JSON.stringify([String(USAGE_RAW_RETENTION_DAYS)])
  ) {
    problems.push(
      `the retention is stated as [${kept.join(', ')}] days, the constant says ${USAGE_RAW_RETENTION_DAYS}`,
    );
  }

  if (!text.includes(RECOMMENDATION)) {
    problems.push(`the page no longer recommends ${RECOMMENDATION}`);
  }

  return problems;
}

describe('docs/calling-an-ai-model.md — the gateway’s endpoint, refusals and outcomes, and the console’s wording, as shipped', () => {
  it('states every refusal, the endpoint, the outcomes and the console labels as the code has them, and recommends one caller Agent per Service', () => {
    expect(problemsIn(page)).toEqual([]);
  });

  it('is linked from the README', () => {
    expect(readme.includes(PAGE)).toBe(true);
  });

  describe('the gate on the gate: a drifted page is reported', () => {
    const drifted = (from: string | RegExp, to: string): string[] => {
      const text = page.replace(from, to);
      expect(text).not.toBe(page);
      return problemsIn(text);
    };

    it('reds when a refusal’s message is reworded', () => {
      expect(drifted(`\`${KEY_REFUSED.message}\``, '`Unauthorized`')).toEqual([
        `a refusal the table does not state: 401 ${KEY_REFUSED.message}`,
        'a table row the gateway does not send: 401 Unauthorized',
      ]);
    });

    it('reds when a refusal’s row is dropped', () => {
      expect(drifted(new RegExp(`^\\| 503 .*\\n`, 'm'), '')).toEqual([
        `a refusal the table does not state: 503 ${NOT_RUNNING.message}`,
      ]);
    });

    it('reds when the endpoint drifts from aiModelEndpoint', () => {
      expect(
        drifted(/\/ai\/<AI model id>\/v1/g, '/gateway/<AI model id>/v1'),
      ).toEqual([`the endpoint is not spelled ${ENDPOINT}`]);
    });

    it('reds when an outcome goes missing', () => {
      expect(drifted(/, `client-aborted`/, '')).toEqual([
        expect.stringMatching(/^the outcomes are /),
      ]);
    });

    it('reds when the console renames a label the page names', () => {
      const renamed = new Map(sources);
      const card =
        'frontend/src/features/application/model/model-connect-card.tsx';
      renamed.set(
        card,
        sources.get(card)!.replaceAll('Create a caller Agent', 'New caller'),
      );
      expect(problemsIn(page, renamed)).toEqual([
        `${card} no longer carries Create a caller Agent`,
      ]);
    });

    it('reds when the retention drifts from USAGE_RAW_RETENTION_DAYS', () => {
      expect(
        drifted(
          `kept for ${USAGE_RAW_RETENTION_DAYS} days`,
          `kept for ${USAGE_RAW_RETENTION_DAYS + 1} days`,
        ),
      ).toEqual([expect.stringMatching(/^the retention is stated as /)]);
    });

    it('reds when the recommendation is dropped', () => {
      expect(drifted(RECOMMENDATION, 'a caller Agent')).toEqual([
        `the page no longer recommends ${RECOMMENDATION}`,
      ]);
    });
  });
});

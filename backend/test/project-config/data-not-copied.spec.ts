import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  PlanNote,
  ProjectConfig,
  SavedService,
} from '../../src/project-config';

function parsed(text: string): ProjectConfig {
  const result = parseProjectConfig(text);
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.config;
}

function config(entries: Record<string, string>): string {
  return `version: 1\nservices:\n${Object.entries(entries)
    .map(([name, kind]) => `  ${name}:\n    kind: ${kind}\n`)
    .join('')}`;
}

function savedRedis(configName: string): SavedService {
  return {
    serviceType: 'redis',
    serviceId: `redis-${configName}`,
    name: configName,
    configName,
    settings: {
      description: null,
      cpuLimit: null,
      memoryLimit: null,
      dockerImage: 'redis:8',
    },
    variables: { env: [] },
  };
}

function dataNotes(
  text: string,
  saved: SavedService[],
  previous: string,
): PlanNote[] {
  const outcome = planEnvironment({
    config: parsed(text),
    saved,
    deployTarget: { kind: 'server', serverId: 'srv-1' },
    context: { previous: parsed(previous) },
  });
  if (!outcome.ok) {
    throw new Error(outcome.refusals.map((one) => one.message).join('; '));
  }
  return outcome.notes.filter((note) => note.kind === 'data-not-copied');
}

/**
 * Spec "Plan lines": a database a plan replaces — a kind change,
 * or a rename, which is a destroy plus a create — says the new one starts
 * empty, since nothing of the old one's data is copied into it, whatever the
 * old one's Delete keeps.
 */
describe('planEnvironment: a replaced database starts empty', () => {
  it('says so for a kind change, under the one Config name', () => {
    expect(
      dataNotes(
        config({ cache: 'postgres' }),
        [savedRedis('cache')],
        config({ cache: 'redis' }),
      ),
    ).toEqual([
      {
        kind: 'data-not-copied',
        configName: 'cache',
        message:
          "cache: the new cache starts empty; cache's data is not copied",
      },
    ]);
  });

  it('says so for a rename: a destroy and a create of the same kind', () => {
    expect(
      dataNotes(
        config({ sessions: 'redis' }),
        [savedRedis('cache')],
        config({ cache: 'redis' }),
      ),
    ).toEqual([
      {
        kind: 'data-not-copied',
        configName: 'sessions',
        message:
          "sessions: the new sessions starts empty; cache's data is not copied",
      },
    ]);
  });

  it('says nothing for a destroy with no replacement, or a new database beside an unchanged one', () => {
    expect(
      dataNotes(
        config({ web: 'web' }),
        [savedRedis('cache')],
        config({ cache: 'redis' }),
      ),
    ).toEqual([]);
    expect(
      dataNotes(
        config({ cache: 'redis', pg: 'postgres' }),
        [savedRedis('cache')],
        config({ cache: 'redis' }),
      ),
    ).toEqual([]);
  });
});

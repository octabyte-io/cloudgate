import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanNote,
  SavedService,
} from '../../src/project-config';

/** The CLI line of spec #146, after its `⚠`, for a Service named `name`. */
const warning = (name: string) =>
  `${name} will run on the machine Cloudgate itself runs on. If it is lost, so are this Service and Cloudgate's records. Add a Server, or use Cloudgate Hosted: https://cloudgate.octabyte.app`;

const TWO = `version: 1
services:
  blog-web:
    kind: web
    port: 8080
    source: { image: "ghost:5.96" }
  cache:
    kind: redis
`;

const cache: SavedService = {
  serviceType: 'redis',
  serviceId: 'redis-cache',
  name: 'cache',
  configName: 'cache',
  settings: {
    description: null,
    cpuLimit: null,
    memoryLimit: null,
    dockerImage: 'redis:8',
  },
  variables: { env: [] },
};

function sameMachineNotes(
  options: {
    deployTarget?: DeployTarget;
    sameMachine?: boolean;
    saved?: SavedService[];
  } = {},
): PlanNote[] {
  const parsed = parseProjectConfig(TWO);
  if (!parsed.ok) throw new Error(parsed.refusal.message);
  const outcome = planEnvironment({
    config: parsed.config,
    saved: options.saved ?? [],
    deployTarget: options.deployTarget ?? { kind: 'platform-host' },
    context: { previous: null },
    ...(options.sameMachine === undefined
      ? {}
      : { sameMachine: options.sameMachine }),
  });
  if (!outcome.ok) {
    throw new Error(outcome.refusals.map((one) => one.message).join('; '));
  }
  return outcome.notes.filter((note) => note.kind === 'same-machine');
}

/**
 * Spec #146, "Plan": a create that lands on Cloudgate's own machine (the
 * platform host, or a Server whose `sameMachine` is true) carries the
 * Same-machine warning, once per create. The caller says whether the Deploy
 * target is that machine; the Hosted instance never says so.
 */
describe('planEnvironment: the Same-machine warning', () => {
  it("notes each create on Cloudgate's own machine once, by its Config name", () => {
    expect(sameMachineNotes({ sameMachine: true })).toEqual([
      {
        kind: 'same-machine',
        configName: 'blog-web',
        message: warning('blog-web'),
      },
      { kind: 'same-machine', configName: 'cache', message: warning('cache') },
    ]);
  });

  it('notes a create on a same-machine Server', () => {
    const notes = sameMachineNotes({
      deployTarget: { kind: 'server', serverId: 'srv-1' },
      sameMachine: true,
    });

    expect(notes.map((note) => note.configName)).toEqual(['blog-web', 'cache']);
  });

  it('notes nothing for a Service the Environment already has', () => {
    const notes = sameMachineNotes({ sameMachine: true, saved: [cache] });

    expect(notes.map((note) => note.configName)).toEqual(['blog-web']);
  });

  it("notes nothing where the Deploy target is not Cloudgate's own machine", () => {
    expect(sameMachineNotes({ sameMachine: false })).toEqual([]);
    expect(sameMachineNotes()).toEqual([]);
  });
});

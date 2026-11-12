import { LogReadBudget } from '../../src/project-config/runtime-log/log-read-budget';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

/**
 * Every tab of the watched Services asks every `everyMs` for a minute, as
 * the console polls; answers how many reads each Service was let make.
 */
function aMinuteOfTabs(
  budget: LogReadBudget,
  services: readonly { project: string; service: string }[],
  everyMs = 250,
): Map<string, number> {
  const reads = new Map<string, number>();
  for (let at = NOW; at < NOW + MINUTE; at += everyMs) {
    for (const { project, service } of services) {
      budget.watch(project, service, at);
      if (budget.take(project, service, at)) {
        reads.set(service, (reads.get(service) ?? 0) + 1);
      }
    }
  }
  return reads;
}

const total = (reads: Map<string, number>, ...services: string[]) =>
  services.reduce((sum, service) => sum + (reads.get(service) ?? 0), 0);

/** S19b: about 30 log reads a minute per Google project id. */
describe('LogReadBudget', () => {
  it('lets one watched Service read about 30 times a minute, however often its tabs ask', () => {
    const reads = aMinuteOfTabs(new LogReadBudget(), [
      { project: 'shop-prod', service: 'web' },
    ]);

    expect(reads.get('web')).toBeLessThanOrEqual(30);
    expect(reads.get('web')).toBeGreaterThanOrEqual(28);
  });

  it('shares the 30 a minute among the Services watched in one project', () => {
    const reads = aMinuteOfTabs(new LogReadBudget(), [
      { project: 'shop-prod', service: 'web' },
      { project: 'shop-prod', service: 'api' },
      { project: 'shop-prod', service: 'admin' },
    ]);

    expect(total(reads, 'web', 'api', 'admin')).toBeLessThanOrEqual(30);
    expect(total(reads, 'web', 'api', 'admin')).toBeGreaterThanOrEqual(27);
    // Each gets its share: the interval stretches, no Service starves.
    for (const service of ['web', 'api', 'admin']) {
      expect(reads.get(service)).toBeGreaterThanOrEqual(9);
      expect(reads.get(service)).toBeLessThanOrEqual(10);
    }
  });

  it('keeps a separate 30 a minute for each Google project', () => {
    const reads = aMinuteOfTabs(new LogReadBudget(), [
      { project: 'shop-prod', service: 'web' },
      { project: 'shop-prod', service: 'api' },
      { project: 'blog-prod', service: 'blog' },
    ]);

    expect(total(reads, 'web', 'api')).toBeLessThanOrEqual(30);
    expect(total(reads, 'web', 'api')).toBeGreaterThanOrEqual(28);
    expect(reads.get('blog')).toBeGreaterThanOrEqual(28);
    expect(reads.get('blog')).toBeLessThanOrEqual(30);
  });

  it('stretches the interval as more Services in the project are watched, and shrinks it as they stop', () => {
    const budget = new LogReadBudget();
    budget.watch('shop-prod', 'web', NOW);
    expect(budget.intervalMs('shop-prod', NOW)).toBe(2_000);
    budget.watch('shop-prod', 'api', NOW);
    budget.watch('blog-prod', 'blog', NOW);
    expect(budget.intervalMs('shop-prod', NOW)).toBe(4_000);
    expect(budget.intervalMs('blog-prod', NOW)).toBe(2_000);

    // `api`'s tabs closed: once none has asked for a while it is not watched.
    budget.watch('shop-prod', 'web', NOW + 60_000);
    expect(budget.intervalMs('shop-prod', NOW + 60_000)).toBe(2_000);
  });

  it('never goes over 30 in a minute when newly watched Services each read at once', () => {
    const budget = new LogReadBudget();
    let reads = 0;
    // A new Service is watched every second and asks at once: the
    // per-Service interval alone would let each one in.
    for (let second = 0; second < 60; second++) {
      const at = NOW + second * 1_000;
      const service = `web-${second}`;
      budget.watch('shop-prod', service, at);
      if (budget.take('shop-prod', service, at)) reads++;
    }
    expect(reads).toBeLessThanOrEqual(30);
  });

  it('backs a project off after a quota refusal, longer each time, and says it is delayed', () => {
    const budget = new LogReadBudget();
    budget.watch('shop-prod', 'web', NOW);
    expect(budget.take('shop-prod', 'web', NOW)).toBe(true);
    expect(budget.delayed('shop-prod', NOW)).toBe(false);

    budget.refused('shop-prod', NOW);
    expect(budget.delayed('shop-prod', NOW)).toBe(true);
    budget.watch('shop-prod', 'web', NOW + 29_000);
    expect(budget.take('shop-prod', 'web', NOW + 29_000)).toBe(false);
    // Another project is not held back.
    budget.watch('blog-prod', 'blog', NOW + 1_000);
    expect(budget.take('blog-prod', 'blog', NOW + 1_000)).toBe(true);

    budget.watch('shop-prod', 'web', NOW + 30_000);
    expect(budget.take('shop-prod', 'web', NOW + 30_000)).toBe(true);
    budget.refused('shop-prod', NOW + 30_000);
    budget.watch('shop-prod', 'web', NOW + 89_000);
    expect(budget.take('shop-prod', 'web', NOW + 89_000)).toBe(false);
    expect(budget.delayed('shop-prod', NOW + 89_000)).toBe(true);
    expect(budget.take('shop-prod', 'web', NOW + 90_000)).toBe(true);

    // A read that works clears the delay, and the next back-off starts short again.
    budget.answered('shop-prod');
    expect(budget.delayed('shop-prod', NOW + 90_000)).toBe(false);
    budget.refused('shop-prod', NOW + 100_000);
    budget.watch('shop-prod', 'web', NOW + 130_000);
    expect(budget.take('shop-prod', 'web', NOW + 130_000)).toBe(true);
  });
});

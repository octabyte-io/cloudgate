import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  gpuCountsOf,
  gpuReservationRefusal,
  heldGpusOf,
  RUNNING_TASK_GPUS_COMMAND,
} from '../../src/settings/gpu-counts';
import { gpuSetupOf } from '../../src/settings/gpu-setup-state';

const BY_CARD_ID = gpuSetupOf(
  '[{"NamedResourceSpec":{"Kind":"GPU","Value":"GPU-a1"}},' +
    '{"NamedResourceSpec":{"Kind":"GPU","Value":"GPU-b2"}},' +
    '{"NamedResourceSpec":{"Kind":"GPU","Value":"GPU-c3"}}]',
);
const BY_COUNT = gpuSetupOf(
  '[{"DiscreteResourceSpec":{"Kind":"GPU","Value":2}}]',
);
const NOT_SET_UP = gpuSetupOf('null');

/**
 * Captured from a real Docker 29.9.1 Swarm (`docker:dind` started with
 * `--node-generic-resource GPU=GPU-fake-uuid-1` and `…-2`), running two
 * services made with `--generic-resource GPU=1` and one made without:
 * `docker inspect --type task` of the three running tasks, and what
 * {@link RUNNING_TASK_GPUS_COMMAND} printed for them.
 */
const fixture = (name: string) =>
  readFileSync(resolve(__dirname, 'fixtures', name), 'utf8');
const RUNNING_TASKS = JSON.parse(
  fixture('running-tasks.inspect.json'),
) as Record<string, unknown>[];
const RUNNING_TASK_GPUS_STDOUT = fixture('running-task-gpus.stdout.txt');

describe('heldGpusOf', () => {
  it('reads the GPUs Swarm assigned each running task, by its service', () => {
    expect(
      heldGpusOf(
        [
          'svc-1 [{"NamedResourceSpec":{"Kind":"GPU","Value":"GPU-a1"}}]',
          'svc-2 null',
          'svc-3 [{"NamedResourceSpec":{"Kind":"GPU","Value":"GPU-b2"}},{"NamedResourceSpec":{"Kind":"gpu","Value":"GPU-c3"}}]',
          'svc-4 [{"DiscreteResourceSpec":{"Kind":"SSD","Value":1}}]',
          '',
        ].join('\n'),
      ),
    ).toEqual([
      { serviceId: 'svc-1', gpus: 1 },
      { serviceId: 'svc-2', gpus: 0 },
      { serviceId: 'svc-3', gpus: 2 },
      { serviceId: 'svc-4', gpus: 0 },
    ]);
  });

  it('reads no running task as nothing held', () => {
    expect(heldGpusOf('')).toEqual([]);
    expect(heldGpusOf('\n')).toEqual([]);
  });

  it('reads what the command printed on a real Swarm: a card each, and null for the task reserving none', () => {
    expect(heldGpusOf(RUNNING_TASK_GPUS_STDOUT)).toEqual([
      { serviceId: 'h45im9whj1opzfk5lrj57j8y3', gpus: 1 },
      { serviceId: 'q7cf8ph62j30i7fpyq4xq4zpz', gpus: 1 },
      { serviceId: 'nvv4fcib7b81n4yg135o5dnqq', gpus: 0 },
    ]);
  });
});

describe('RUNNING_TASK_GPUS_COMMAND', () => {
  // Its Go template, which only a real `docker inspect` runs: the mocked exec
  // output of every other pin never saw it name a field Docker lacks.
  const template = /--format '(.*)'$/.exec(RUNNING_TASK_GPUS_COMMAND)?.[1];

  it('reads a field the real task JSON has, by index so a task without it prints null', () => {
    const match =
      /^\{\{\.ServiceID\}\} \{\{json \(index \. "(\w+)"\)\}\}$/.exec(
        template ?? '',
      );
    expect(match).not.toBeNull();
    const field = match![1];
    expect(
      RUNNING_TASKS.filter((task) => field in task).map(
        (task) => task.ServiceID,
      ),
    ).toEqual(['h45im9whj1opzfk5lrj57j8y3', 'q7cf8ph62j30i7fpyq4xq4zpz']);
    // What Docker printed is that field of each task, `null` where omitted.
    expect(
      RUNNING_TASKS.map(
        (task) =>
          `${String(task.ServiceID)} ${JSON.stringify(task[field] ?? null)}`,
      ).join('\n'),
    ).toBe(RUNNING_TASK_GPUS_STDOUT.trimEnd());
  });
});

describe('gpuCountsOf', () => {
  it('counts the cards advertised by ID, less those running tasks hold', () => {
    expect(
      gpuCountsOf(BY_CARD_ID, [
        { serviceId: 'svc-1', gpus: 1 },
        { serviceId: 'svc-2', gpus: 0 },
      ]),
    ).toEqual({ gpuSetup: 'card-id', cards: 3, free: 2 });
  });

  it('never answers fewer than none free', () => {
    expect(
      gpuCountsOf(BY_CARD_ID, [
        { serviceId: 'svc-1', gpus: 2 },
        { serviceId: 'svc-2', gpus: 2 },
      ]),
    ).toMatchObject({ cards: 3, free: 0 });
  });

  it('answers no cards for a machine that does not qualify, with its state', () => {
    expect(gpuCountsOf(BY_COUNT, [])).toEqual({
      gpuSetup: 'count',
      cards: 0,
      free: 0,
    });
    expect(gpuCountsOf(NOT_SET_UP, [])).toEqual({
      gpuSetup: 'none',
      cards: 0,
      free: 0,
    });
  });
});

describe('gpuReservationRefusal', () => {
  const counts = {
    gpuSetup: 'card-id' as const,
    cards: 2,
    free: 0,
    runtimeConfigured: true,
  };

  it('admits a reservation up to the card count, whatever is free now', () => {
    expect(gpuReservationRefusal(counts, 2, 'gpu-1')).toBeNull();
    expect(gpuReservationRefusal(counts, 1, 'gpu-1')).toBeNull();
  });

  it('admits no reservation anywhere', () => {
    expect(
      gpuReservationRefusal(
        { gpuSetup: 'none', cards: 0, free: 0, runtimeConfigured: false },
        0,
        'gpu-1',
      ),
    ).toBeNull();
  });

  it('refuses more GPUs per copy than the Server has', () => {
    expect(gpuReservationRefusal(counts, 3, 'gpu-1')).toBe(
      'gpu-1 has 2 GPUs, so it cannot hold 3 per copy',
    );
    expect(
      gpuReservationRefusal(
        { gpuSetup: 'card-id', cards: 1, free: 1, runtimeConfigured: true },
        2,
        'gpu-1',
      ),
    ).toBe('gpu-1 has 1 GPU, so it cannot hold 2 per copy');
  });

  it('refuses a Server not set up, and one set up the old way', () => {
    expect(
      gpuReservationRefusal(
        { gpuSetup: 'none', cards: 0, free: 0, runtimeConfigured: false },
        1,
        'gpu-1',
      ),
    ).toBe('gpu-1 is not set up for GPUs; run GPU setup on it first');
    expect(
      gpuReservationRefusal(
        { gpuSetup: 'count', cards: 0, free: 0, runtimeConfigured: false },
        1,
        'gpu-1',
      ),
    ).toBe(
      'gpu-1 was set up for GPUs the old way, which cannot reserve a card; run GPU setup on it again',
    );
  });

  it('refuses a Server whose cards are advertised by ID but whose runtime cannot hand one over', () => {
    // Set up before the fix: `swarm-resource` inside a table, so Swarm assigns a
    // card the container never gets. ADR-0039: refused, never started.
    const unconfigured = { ...counts, runtimeConfigured: false };
    expect(gpuReservationRefusal(unconfigured, 1, 'gpu-1')).toBe(
      'gpu-1 is not set up to hand a reserved card to its container; run GPU setup on it again',
    );
    expect(gpuReservationRefusal(unconfigured, 3, 'gpu-1')).toBe(
      'gpu-1 is not set up to hand a reserved card to its container; run GPU setup on it again',
    );
    expect(gpuReservationRefusal(unconfigured, 0, 'gpu-1')).toBeNull();
  });
});

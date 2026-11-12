import { Readable } from 'node:stream';

import type Docker from 'dockerode';

import { SwarmCronRunPlace } from '../../src/cron-services/swarm-cron-run-place';
import type { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { makeApp } from '../deployment-engine/application.fixture';

/** A Docker that answers what each test gives it. */
function fakeDocker(over: {
  createService?: jest.Mock;
  listTasks?: jest.Mock;
  inspect?: jest.Mock;
  remove?: jest.Mock;
  logs?: jest.Mock;
}) {
  const service = {
    inspect: over.inspect ?? jest.fn().mockResolvedValue({}),
    remove: over.remove ?? jest.fn().mockResolvedValue(undefined),
    logs: over.logs ?? jest.fn().mockResolvedValue(Buffer.alloc(0)),
  };
  const docker = {
    createService: over.createService ?? jest.fn().mockResolvedValue({}),
    listTasks: over.listTasks ?? jest.fn().mockResolvedValue([]),
    getService: jest.fn().mockReturnValue(service),
  };
  return { docker, service };
}

function placeOn(docker: unknown, getRemoteDocker?: jest.Mock) {
  const factory = {
    getRemoteDocker: getRemoteDocker ?? jest.fn().mockResolvedValue(docker),
  };
  return {
    place: new SwarmCronRunPlace(factory as unknown as RemoteDockerFactory),
    factory,
  };
}

const mark = {
  job: 'shop-run-abc',
  image: 'shop:1',
  startedBy: { kind: 'timetable' as const },
};

function frame(stream: 1 | 2, text: string): Buffer {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

const notFound = () =>
  Object.assign(new Error('no such service'), { statusCode: 404 });

describe('SwarmCronRunPlace', () => {
  describe('naming a run', () => {
    it('names the job after the Service plus a run id, within Swarm’s 63', () => {
      const { place } = placeOn({});
      expect(place.jobName('shop-api-x1')).toMatch(
        /^shop-api-x1-run-[0-9a-z]{8}$/,
      );
      const long = place.jobName('a'.repeat(80));
      expect(long).toHaveLength(63);
      expect(long).toMatch(/^a+-run-[0-9a-z]{8}$/);
    });

    it('describes the job as a Swarm job', () => {
      const { place } = placeOn({});
      expect(place.describeJob('shop-run-abc')).toBe(
        "Swarm job 'shop-run-abc'",
      );
    });
  });

  describe('starting a run', () => {
    it('creates the one-off job on the Service’s Server, from the image, with its wired variables', async () => {
      const { docker } = fakeDocker({});
      const { place, factory } = placeOn(docker);
      const app = makeApp({ serverId: 'srv-1' });

      await place.start(app, {
        job: 'shop-run-abc',
        image: 'shop:1',
        wiredEnv: () => Promise.resolve({ DB_URL: 'postgres://x' }),
      });

      expect(factory.getRemoteDocker).toHaveBeenCalledWith('srv-1');
      const [settings] = docker.createService.mock.calls[0] as [
        Docker.CreateServiceOptions,
      ];
      expect(settings.Name).toBe('shop-run-abc');
      expect(settings.Mode).toEqual({
        ReplicatedJob: { MaxConcurrent: 1, TotalCompletions: 1 },
      });
      const spec = settings.TaskTemplate as {
        ContainerSpec: { Image: string; Env?: string[] };
      };
      expect(spec.ContainerSpec.Image).toBe('shop:1');
      expect(spec.ContainerSpec.Env).toContain('DB_URL=postgres://x');
    });

    it('throws, starting nothing, when the wired variables cannot be built', async () => {
      const { docker } = fakeDocker({});
      const { place } = placeOn(docker);

      await expect(
        place.start(makeApp(), {
          job: 'j',
          image: 'i',
          wiredEnv: () => Promise.reject(new Error('source gone')),
        }),
      ).rejects.toThrow('source gone');
      expect(docker.createService).not.toHaveBeenCalled();
    });

    it('throws when the Server cannot be reached', async () => {
      const { place } = placeOn(
        {},
        jest.fn().mockRejectedValue(new Error('ssh refused')),
      );
      await expect(
        place.start(makeApp(), {
          job: 'j',
          image: 'i',
          wiredEnv: () => Promise.resolve({}),
        }),
      ).rejects.toThrow('ssh refused');
    });
  });

  describe('watching a run', () => {
    it('answers null while its task has not ended', async () => {
      const { docker } = fakeDocker({
        listTasks: jest
          .fn()
          .mockResolvedValue([{ Status: { State: 'running' } }]),
      });
      const job = await placeOn(docker).place.reach({
        serverId: null,
        cronRun: mark,
      });

      await expect(job.ending()).resolves.toBeNull();
      expect(docker.listTasks).toHaveBeenCalledWith({
        filters: { service: ['shop-run-abc'] },
      });
    });

    it('answers the ended task’s exit code, state and error', async () => {
      const { docker } = fakeDocker({
        listTasks: jest.fn().mockResolvedValue([
          { Status: { State: 'running' } },
          {
            Status: {
              State: 'failed',
              Err: 'task: non-zero exit (3)',
              ContainerStatus: { ExitCode: 3 },
            },
          },
        ]),
      });
      const job = await placeOn(docker).place.reach({
        serverId: null,
        cronRun: mark,
      });

      await expect(job.ending()).resolves.toEqual({
        exitCode: 3,
        state: 'failed',
        err: 'task: non-zero exit (3)',
      });
    });

    it('answers no exit code for a task rejected before its container ran', async () => {
      const { docker } = fakeDocker({
        listTasks: jest
          .fn()
          .mockResolvedValue([
            { Status: { State: 'rejected', Err: 'No such image' } },
          ]),
      });
      const job = await placeOn(docker).place.reach({
        serverId: null,
        cronRun: mark,
      });

      await expect(job.ending()).resolves.toEqual({
        exitCode: null,
        state: 'rejected',
        err: 'No such image',
      });
    });

    it('throws when its Server cannot be reached', async () => {
      const { place } = placeOn(
        {},
        jest.fn().mockRejectedValue(new Error('down')),
      );
      await expect(
        place.reach({ serverId: 'srv-1', cronRun: mark }),
      ).rejects.toThrow('down');
    });
  });

  describe('copying its output', () => {
    it('answers stdout and stderr in order, from Docker’s framed answer', async () => {
      const { docker } = fakeDocker({
        logs: jest
          .fn()
          .mockResolvedValue(
            Buffer.concat([frame(1, 'one\n'), frame(2, 'two\n')]),
          ),
      });
      const job = await placeOn(docker).place.reach({
        serverId: null,
        cronRun: mark,
      });

      await expect(job.output()).resolves.toBe('one\ntwo\n');
    });

    it('reads a streamed answer to its end', async () => {
      const { docker } = fakeDocker({
        logs: jest
          .fn()
          .mockResolvedValue(Readable.from([frame(1, 'a'), frame(1, 'b\n')])),
      });
      const job = await placeOn(docker).place.reach({
        serverId: null,
        cronRun: mark,
      });

      await expect(job.output()).resolves.toBe('ab\n');
    });
  });

  describe('removing its job', () => {
    it('answers true once the job is removed, or already gone', async () => {
      const gone = fakeDocker({
        remove: jest.fn().mockRejectedValue(notFound()),
      });
      const removed = fakeDocker({});

      for (const { docker } of [gone, removed]) {
        const job = await placeOn(docker).place.reach({
          serverId: null,
          cronRun: mark,
        });
        await expect(job.remove()).resolves.toBe(true);
      }
    });

    it('answers false, without throwing, when removing it fails', async () => {
      const { docker } = fakeDocker({
        remove: jest.fn().mockRejectedValue(new Error('daemon busy')),
      });
      const job = await placeOn(docker).place.reach({
        serverId: null,
        cronRun: mark,
      });

      await expect(job.remove()).resolves.toBe(false);
    });
  });

  describe('finding a run again', () => {
    it('finds a job Swarm still has as there', async () => {
      const { docker } = fakeDocker({});
      const job = await placeOn(docker).place.reach({
        serverId: null,
        cronRun: mark,
      });

      await expect(job.find()).resolves.toEqual({ there: true });
    });

    it('finds a job Swarm no longer has as gone, with its last task’s ending', async () => {
      const { docker } = fakeDocker({
        inspect: jest.fn().mockRejectedValue(notFound()),
        listTasks: jest
          .fn()
          .mockResolvedValue([
            { Status: { State: 'complete', ContainerStatus: { ExitCode: 0 } } },
          ]),
      });
      const job = await placeOn(docker).place.reach({
        serverId: null,
        cronRun: mark,
      });

      await expect(job.find()).resolves.toEqual({
        there: false,
        ending: { exitCode: 0, state: 'complete', err: null },
      });
    });

    it('finds a gone job with no task to read as gone with no ending', async () => {
      const { docker } = fakeDocker({
        inspect: jest.fn().mockRejectedValue(notFound()),
        listTasks: jest.fn().mockRejectedValue(new Error('no tasks')),
      });
      const job = await placeOn(docker).place.reach({
        serverId: null,
        cronRun: mark,
      });

      await expect(job.find()).resolves.toEqual({ there: false, ending: null });
    });

    it('throws on any other answer than not found', async () => {
      const { docker } = fakeDocker({
        inspect: jest.fn().mockRejectedValue(new Error('daemon down')),
      });
      const job = await placeOn(docker).place.reach({
        serverId: null,
        cronRun: mark,
      });

      await expect(job.find()).rejects.toThrow('daemon down');
    });
  });
});

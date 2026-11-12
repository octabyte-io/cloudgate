import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  ConfigRefusal,
  DeployTarget,
  PlanOutcome,
  ProjectConfig,
  SavedService,
} from '../../src/project-config';

/** A config with one `uploads` entry of these lines. */
function uploads(...lines: string[]): string {
  return `version: 1\nservices:\n  uploads:\n${lines.map((line) => `    ${line}`).join('\n')}\n`;
}

function parsed(text: string): ProjectConfig {
  const result = parseProjectConfig(text);
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.config;
}

function refused(text: string): ConfigRefusal {
  const result = parseProjectConfig(text);
  if (result.ok) throw new Error('parsed, but a refusal was expected');
  return result.refusal;
}

const SERVER: DeployTarget = { kind: 'server', serverId: 'srv-1' };

function plan(
  text: string,
  saved: SavedService[] = [],
  options: { previous?: string; deployTarget?: DeployTarget } = {},
): PlanOutcome {
  return planEnvironment({
    config: parsed(text),
    saved,
    deployTarget: options.deployTarget ?? SERVER,
    context: {
      previous:
        options.previous === undefined ? null : parsed(options.previous),
    },
  });
}

function planned(...args: Parameters<typeof plan>) {
  const outcome = plan(...args);
  if (!outcome.ok) {
    throw new Error(
      `refused: ${outcome.refusals.map((r) => r.message).join('; ')}`,
    );
  }
  return outcome;
}

function savedBucket(
  configName: string,
  description: string | null = null,
): SavedService {
  return {
    serviceType: 'bucket',
    serviceId: `bucket-${configName}`,
    name: configName,
    configName,
    settings: { description, bucketName: `${configName}-a1b2c3d4` },
    variables: { env: [] },
  };
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

describe('parseProjectConfig', () => {
  describe('a kind: bucket entry', () => {
    it('reads a bucket with its kind and description only', () => {
      expect(
        parsed(uploads('kind: bucket', 'description: Product photos')).services
          .uploads,
      ).toEqual({
        kind: 'bucket',
        managed: false,
        description: 'Product photos',
        env: [],
      });
      expect(parsed(uploads('kind: bucket')).services.uploads).toEqual({
        kind: 'bucket',
        managed: false,
        env: [],
      });
    });

    it.each([
      ['size: small', 'uploads.size'],
      ['env: [AWS_REGION]', 'uploads.env'],
      ['region: eu-west-1', 'uploads.region'],
      ['versioning: true', 'uploads.versioning'],
      ['name: my-bucket', 'uploads.name'],
    ])('refuses %s, naming %s', (line, at) => {
      expect(refused(uploads('kind: bucket', line))).toEqual({
        reason: 'invalid',
        at,
        message: `${at}: it is not a field Cloudgate knows`,
      });
    });
  });
});

describe('planEnvironment', () => {
  describe('kind: bucket', () => {
    it('creates a bucket on the Server Deploy target, its description its one field', () => {
      const { steps, notes } = planned(
        uploads('kind: bucket', 'description: Product photos'),
      );

      expect(steps).toEqual([
        {
          action: 'create',
          configName: 'uploads',
          kind: 'bucket',
          placement: SERVER,
          fields: [{ field: 'description', from: null, to: 'Product photos' }],
        },
      ]);
      expect(notes).toEqual([]);
    });

    it('creates one on the platform host too', () => {
      const platform: DeployTarget = { kind: 'platform-host' };
      const { steps } = planned(uploads('kind: bucket'), [], {
        deployTarget: platform,
      });

      expect(steps).toEqual([
        {
          action: 'create',
          configName: 'uploads',
          kind: 'bucket',
          placement: platform,
          fields: [],
        },
      ]);
    });

    it('changes nothing for a bucket that matches, whatever its real name', () => {
      expect(
        planned(uploads('kind: bucket', 'description: Photos'), [
          savedBucket('uploads', 'Photos'),
        ]).steps,
      ).toEqual([]);
    });

    it('changes a bucket whose description differs', () => {
      expect(
        planned(uploads('kind: bucket', 'description: Photos'), [
          savedBucket('uploads'),
        ]).steps,
      ).toEqual([
        {
          action: 'change',
          configName: 'uploads',
          kind: 'bucket',
          serviceType: 'bucket',
          serviceId: 'bucket-uploads',
          name: 'uploads',
          fields: [{ field: 'description', from: null, to: 'Photos' }],
        },
      ]);
    });

    it('plans a rename as a destroy and a create, noting that the files are not copied', () => {
      const { steps, notes } = planned(
        'version: 1\nservices:\n  photos:\n    kind: bucket\n',
        [savedBucket('uploads')],
        { previous: uploads('kind: bucket') },
      );

      expect(
        steps.map((step) => [
          step.action,
          'configName' in step && step.configName,
        ]),
      ).toEqual([
        ['create', 'photos'],
        ['destroy', 'uploads'],
      ]);
      expect(notes).toEqual([
        {
          kind: 'files-not-copied',
          configName: 'uploads',
          message:
            'uploads: the bucket is destroyed and its files are not copied; a bucket renamed or given another kind is a new, empty one',
        },
      ]);
    });

    it('plans a kind change from a bucket as a destroy and a create, noting that the files are not copied', () => {
      const { steps, notes } = planned(uploads('kind: redis'), [
        savedBucket('uploads'),
      ]);

      expect(steps).toMatchObject([
        { action: 'destroy', configName: 'uploads', kind: 'bucket' },
        { action: 'create', configName: 'uploads', kind: 'redis' },
      ]);
      expect(notes).toEqual([
        expect.objectContaining({
          kind: 'files-not-copied',
          configName: 'uploads',
        }),
      ]);
    });

    it('plans a kind change into a bucket as a destroy and a create, noting that nothing is copied into it', () => {
      const { steps, notes } = planned(uploads('kind: bucket'), [
        savedRedis('uploads'),
      ]);

      expect(steps).toMatchObject([
        { action: 'destroy', configName: 'uploads', kind: 'redis' },
        { action: 'create', configName: 'uploads', kind: 'bucket' },
      ]);
      expect(notes).toEqual([
        {
          kind: 'files-not-copied',
          configName: 'uploads',
          message:
            'uploads: the redis is replaced by a new, empty bucket; nothing is copied into it',
        },
      ]);
    });

    // A Cloud account makes it as an S3 bucket, read from AWS; once
    // refused here as a kind the cloud could not make yet.
    it('plans a bucket with a Cloud account as the Deploy target as one it makes there', () => {
      const outcome = plan(uploads('kind: bucket'), [], {
        deployTarget: {
          kind: 'cloud',
          cloudAccountId: 'ca-1',
          region: 'eu-west-1',
        },
      });

      expect(outcome).toMatchObject({
        ok: true,
        steps: [
          {
            action: 'create',
            kind: 'bucket',
            placement: { kind: 'cloud' },
            cloudRead: { status: 'reading' },
          },
        ],
      });
    });
  });

  describe('a bucket with no Domain', () => {
    function withDomain(hasDomain: boolean): SavedService {
      const found = savedBucket('uploads');
      if (found.serviceType !== 'bucket') throw new Error('not a bucket');
      return { ...found, settings: { ...found.settings, hasDomain } };
    }

    it('notes that presigned URLs and browser uploads stop working, changing nothing', () => {
      const outcome = planned(uploads('kind: bucket'), [withDomain(false)]);

      expect(outcome.steps).toEqual([]);
      expect(outcome.notes).toEqual([
        {
          kind: 'bucket-no-domain',
          configName: 'uploads',
          message:
            'uploads: the bucket has no Domain, so its endpoint is the internal URL and presigned URLs and browser uploads stop working; add a Domain on its page',
        },
      ]);
    });

    it('notes nothing while it has a Domain', () => {
      expect(
        planned(uploads('kind: bucket'), [withDomain(true)]).notes,
      ).toEqual([]);
    });

    it('notes nothing for a bucket the plan creates, which gets a generated Domain', () => {
      expect(planned(uploads('kind: bucket')).notes).toEqual([]);
    });
  });
});

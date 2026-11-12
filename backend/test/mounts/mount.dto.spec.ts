import path from 'node:path';
import { getCreateFileCommand } from '../../src/docker/docker.utils';
import {
  createMountSchema,
  updateMountSchema,
} from '../../src/mounts/dto/mount.dto';

// The traversal rule decided what a caller-supplied file-mount `filePath` may be, and the
// answer is enforced here rather than in the service (§2.4: the global pipe
// validates, once). These cases are the ones the rule exists for.

const filesDirectory = '/etc/cloudgate/applications/blog-app/files';

const validBody = {
  type: 'file' as const,
  content: 'hello world',
  mountPath: '/app/config.json',
  serviceId: 'svc-1',
};

/** Where `getCreateFileCommand` would actually put this filePath. */
const wouldWriteTo = (filePath: string): string =>
  path.join(filesDirectory, filePath);

describe('createMountSchema', () => {
  it('accepts a file mount whose path names a file under the service files directory', () => {
    expect(
      createMountSchema.safeParse({ ...validBody, filePath: 'config.json' })
        .success,
    ).toBe(true);
    expect(
      createMountSchema.safeParse({
        ...validBody,
        filePath: 'nginx/conf.d/site.conf',
      }).success,
    ).toBe(true);
  });

  it('accepts a trailing slash, which asks for a directory rather than a file', () => {
    // getCreateFileCommand branches on it, so the rule must not eat it.
    expect(getCreateFileCommand(filesDirectory, 'seed/', '')).toContain(
      `mkdir -p "${filesDirectory}/seed`,
    );
    expect(
      createMountSchema.safeParse({ ...validBody, filePath: 'seed/' }).success,
    ).toBe(true);
  });

  it('refuses a filePath that escapes the service files directory', () => {
    // The expectation comes from the collaborator: path.join really does walk
    // out of the base, so the row named one file and the write touched another
    // service's — or the host's.
    expect(wouldWriteTo('../../../traefik/dynamic/traefik.yml')).toBe(
      '/etc/cloudgate/traefik/dynamic/traefik.yml',
    );

    const refused = createMountSchema.safeParse({
      ...validBody,
      filePath: '../../../traefik/dynamic/traefik.yml',
    });
    expect(refused.success).toBe(false);
    expect(refused.error!.issues[0].message).toBe(
      'filePath must stay inside the service files directory',
    );
  });

  it('refuses a filePath that escapes only after a leading segment', () => {
    expect(
      wouldWriteTo('conf/../../../../../../root/.ssh/authorized_keys'),
    ).toBe('/root/.ssh/authorized_keys');
    expect(
      createMountSchema.safeParse({
        ...validBody,
        filePath: 'conf/../../../../../../root/.ssh/authorized_keys',
      }).success,
    ).toBe(false);
  });

  it('refuses a filePath that walks out to the sibling service next door', () => {
    expect(wouldWriteTo('../../shop-app/files/config.json')).toBe(
      '/etc/cloudgate/applications/shop-app/files/config.json',
    );
    expect(
      createMountSchema.safeParse({
        ...validBody,
        filePath: '../../shop-app/files/config.json',
      }).success,
    ).toBe(false);
  });

  it('refuses an absolute filePath rather than silently confining it', () => {
    // path.join does not honour it, it re-roots it — so the row says
    // /etc/passwd and the file is somewhere else entirely.
    expect(wouldWriteTo('/etc/passwd')).toBe(`${filesDirectory}/etc/passwd`);
    expect(
      createMountSchema.safeParse({ ...validBody, filePath: '/etc/passwd' })
        .success,
    ).toBe(false);
  });

  it('refuses a filePath naming the files directory itself', () => {
    for (const filePath of ['', '.', './', '..']) {
      expect(
        createMountSchema.safeParse({ ...validBody, filePath }).success,
      ).toBe(false);
    }
  });

  it('leaves a mount that carries no filePath alone', () => {
    // Only file mounts have one; the schema enforces no field by type, so the
    // rule must not turn absence into a refusal.
    expect(
      createMountSchema.safeParse({
        type: 'volume',
        volumeName: 'blog-uploads',
        mountPath: '/app/uploads',
        serviceId: 'svc-1',
      }).success,
    ).toBe(true);
  });

  // An earlier fix made `mountPath` conditional on `serviceType`, not on `type`.
  // `TemplatesService` and `AiService` reach `MountsService.create` with a
  // hand-built compose file mount and had been passing `mountPath: ''` past a
  // field the schema called required; nothing ever assembles a compose stack's
  // mount rows into a deploy spec, so there is no container target to name.
  describe('mountPath', () => {
    it('accepts a compose file mount that names none', () => {
      expect(
        createMountSchema.safeParse({
          type: 'file',
          filePath: './conf/app.ini',
          content: 'password = hunter2',
          serviceType: 'compose',
          serviceId: 'svc-1',
        }).success,
      ).toBe(true);
    });

    it('refuses an application file mount that names none', () => {
      // The case that decided the discriminant: `generateFileMounts` sets
      // `Target: mount.mountPath` for every file mount, so making absence legal
      // for all of them would store a mount the next deploy fails on.
      const refused = createMountSchema.safeParse({
        type: 'file',
        filePath: 'config.json',
        content: 'hello world',
        serviceId: 'svc-1',
      });
      expect(refused.success).toBe(false);
      expect(refused.error!.issues[0].path).toEqual(['mountPath']);
      // The sentence itself, not just the path (H-70). It is the only place the
      // condition is stated to a caller — `openapi.json` cannot carry it as a
      // `required` entry, so the 400's message is what tells the person which
      // field to add and when it is needed. Nothing else in the tree pinned it,
      // so a rewrite of the wording was a silent contract change; here it is a
      // red test. The same condition is published as the property's
      // `description` in `openapi.json`, which `test/openapi/openapi.spec.ts`
      // byte-pins.
      expect(refused.error!.issues[0].message).toBe(
        "mountPath is required unless serviceType is 'compose'",
      );
    });

    it('refuses a bind or a volume mount that names none', () => {
      expect(
        createMountSchema.safeParse({
          type: 'bind',
          hostPath: '/srv/blog',
          serviceId: 'svc-1',
        }).success,
      ).toBe(false);
      expect(
        createMountSchema.safeParse({
          type: 'volume',
          volumeName: 'blog-uploads',
          serviceId: 'svc-1',
        }).success,
      ).toBe(false);
    });
  });

  describe('a mount attached to a Compose stack', () => {
    const composeBody = { serviceType: 'compose' as const, serviceId: 'cmp-1' };

    it('accepts a file mount, which is the one kind a stack consumes', () => {
      // `MountsService` writes it under `{composeDirectory}/{appName}/files`
      // and the operator's own `volumes:` mounts it — the mechanism
      // `TemplatesService` and `AiService` build their config files with.
      expect(
        createMountSchema.safeParse({
          ...composeBody,
          type: 'file',
          filePath: './conf/app.ini',
          content: 'password = hunter2',
        }).success,
      ).toBe(true);
    });

    it.each(['bind', 'volume'] as const)(
      'refuses a %s mount, which nothing would ever read',
      (type) => {
        const refused = createMountSchema.safeParse({
          ...composeBody,
          type,
          mountPath: '/srv/data',
          ...(type === 'bind'
            ? { hostPath: '/srv/blog' }
            : { volumeName: 'blog-uploads' }),
        });

        expect(refused.success).toBe(false);
        expect(refused.error!.issues[0].path).toEqual(['type']);
        expect(refused.error!.issues[0].message).toBe(
          "A Compose stack only takes a 'file' mount; declare a bind or a " +
            "volume in the stack's own compose file",
        );
      },
    );

    it('leaves a bind and a volume mount on every other serviceType alone', () => {
      // The refusal is about the *stack*, not about the kind: an application's
      // bind mount is what `mechanize` builds a swarm service's `Mounts` from.
      for (const serviceType of ['application', 'postgres', 'redis'] as const) {
        expect(
          createMountSchema.safeParse({
            type: 'bind',
            hostPath: '/srv/blog',
            mountPath: '/srv/data',
            serviceType,
            serviceId: 'svc-1',
          }).success,
        ).toBe(true);
        expect(
          createMountSchema.safeParse({
            type: 'volume',
            volumeName: 'blog-uploads',
            mountPath: '/srv/data',
            serviceType,
            serviceId: 'svc-1',
          }).success,
        ).toBe(true);
      }
    });
  });
});

describe('updateMountSchema', () => {
  it('refuses a filePath that escapes the service files directory', () => {
    // The same rule, because `update` rewrites the file at the new path and
    // `remove` rm -rf's it — a create-then-patch would otherwise walk out.
    expect(
      updateMountSchema.safeParse({ filePath: '../../../etc/hosts' }).success,
    ).toBe(false);
    expect(
      updateMountSchema.safeParse({ filePath: 'config.json' }).success,
    ).toBe(true);
  });
});

// H-55. `volumeName` becomes the `Source` of a volume-type mount on the deploy
// spec, and `volume-backups` holds the *same Docker object name* to
// VOLUME_NAME_REGEX while this copy was a bare string. These pin that the two
// sites now agree: a name Docker itself would refuse is refused here too. This
// is consistency with the sibling rule, not the cross-tenant isolation
// boundary — a valid name pointing at another tenant's volume is still valid.
describe('mount volumeName', () => {
  const volumeMount = {
    type: 'volume' as const,
    mountPath: '/app/uploads',
    serviceId: 'svc-1',
  };

  it('accepts a Docker-legal volume name on create and update', () => {
    expect(
      createMountSchema.safeParse({
        ...volumeMount,
        volumeName: 'blog_uploads',
      }).success,
    ).toBe(true);
    expect(
      updateMountSchema.safeParse({ volumeName: 'blog-uploads.v2' }).success,
    ).toBe(true);
  });

  it('refuses a volume name Docker itself would refuse, on create and update', () => {
    // A path-shaped source, and a leading separator: both are outside
    // VOLUME_NAME_REGEX, and neither can name a volume this service mounts.
    for (const volumeName of ['/etc', '../secrets', '.hidden', 'a b']) {
      expect(
        createMountSchema.safeParse({ ...volumeMount, volumeName }).success,
      ).toBe(false);
      expect(updateMountSchema.safeParse({ volumeName }).success).toBe(false);
    }
  });
});

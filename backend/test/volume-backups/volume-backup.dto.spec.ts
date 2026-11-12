import {
  createVolumeBackupSchema,
  restoreVolumeBackupSchema,
  updateVolumeBackupSchema,
} from '../../src/volume-backups/dto/volume-backup.dto';

// H-19 decided what a caller-supplied `volumeName`, `prefix` and
// `backupFileName` may be, and the answer is enforced here rather than in the
// service (§2.4: the global pipe validates, once).
//
// All three were `z.string().min(1)` and reach a shell as root:
// `volume-backup-commands.ts` interpolates them into roughly forty words of
// two generated scripts and `deployment-engine/volume-lock.ts` into a third,
// and the scripts go to `RemoteExecService.execAsyncRemote`. Unlike an
// `appName`, none of them had a mint, a charset or a `quote()` anywhere on
// that path, so `POST /volume-backups/restore` with `{"volumeName":"x$(id)"}`
// ran `id` on the target Server.
//
// **These refusals are the belt, not the braces.** Quoting those words is the
// fix they need and one of them has it; the rest are named in the finding.
// What is asserted here is the accepting half as much as the refusing half: a
// rule that also refuses the names people really use would be walked back
// rather than completed.

const validCreate = {
  name: 'nightly uploads',
  volumeName: 'shop-data',
  prefix: 'daily',
  schedule: '0 3 * * *',
  serviceId: 'svc-1',
  destinationId: 'dst-1',
};

const validRestore = {
  serviceId: 'svc-1',
  serviceType: 'application' as const,
  volumeName: 'shop-data',
  backupFileName: 'main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar',
  destinationId: 'dst-1',
};

/** Each of these ends a command, opens a subshell, substitutes one or splits a
 * word, and every one of them is a legal character in a `z.string().min(1)`. */
const HOSTILE = [
  'x;touch /tmp/pwned #',
  'a$(id)',
  'a`id`',
  'a|id',
  'a&id',
  'a b',
  'a>out',
];

describe('createVolumeBackupSchema', () => {
  it('accepts the volume and prefix names a real backup carries', () => {
    expect(createVolumeBackupSchema.safeParse(validCreate).success).toBe(true);
    expect(
      createVolumeBackupSchema.safeParse({
        ...validCreate,
        // Docker's own rule for `docker volume create`, which is where every
        // one of these ends up: dots, underscores and hyphens after the first
        // character.
        volumeName: 'shop_data.v2-2026',
        prefix: 'team/daily/uploads',
      }).success,
    ).toBe(true);
  });

  it('refuses a volumeName that could leave its shell word', () => {
    for (const volumeName of HOSTILE) {
      expect(
        createVolumeBackupSchema.safeParse({ ...validCreate, volumeName })
          .success,
      ).toBe(false);
    }
  });

  it('refuses a prefix that could leave its shell word', () => {
    for (const prefix of HOSTILE) {
      expect(
        createVolumeBackupSchema.safeParse({ ...validCreate, prefix }).success,
      ).toBe(false);
    }
  });

  it('accepts the compose service names a real stack declares', () => {
    // The field mirrors a key under `services:` in the operator's own
    // compose file, so what it may carry is Docker Compose's rule and not this
    // application's — dots, underscores and hyphens anywhere, which is the set
    // the compose specification's own schema keys `services` on.
    for (const serviceName of ['api', 'web-1', 'redis_cache', 'db.primary']) {
      expect(
        createVolumeBackupSchema.safeParse({ ...validCreate, serviceName })
          .success,
      ).toBe(true);
    }
  });

  it('refuses a serviceName that could leave its shell word', () => {
    // It reaches roughly six words of two generated scripts through
    // `s3AppName` and the two compose labels, and it is the leading segment of
    // the object key the prefix bound made an authorization boundary.
    for (const serviceName of HOSTILE) {
      expect(
        createVolumeBackupSchema.safeParse({ ...validCreate, serviceName })
          .success,
      ).toBe(false);
    }
  });

  it('refuses a serviceName that could make the object key a second segment', () => {
    // A `/` is the one character that would turn `{appName}_{serviceName}`
    // into two path components, which is what `bucketPrefixCandidates` trims
    // `_` for. Compose's own charset has no slash in it, so the bound closes
    // this without a rule of its own.
    expect(
      createVolumeBackupSchema.safeParse({
        ...validCreate,
        serviceName: 'api/../other-app',
      }).success,
    ).toBe(false);
  });

  it('refuses a volumeName Docker itself would refuse to create', () => {
    // A leading `-` reads as a flag rather than a name, which is why Docker's
    // own rule starts at an alphanumeric and why nothing is lost by matching it.
    expect(
      createVolumeBackupSchema.safeParse({
        ...validCreate,
        volumeName: '-shop-data',
      }).success,
    ).toBe(false);
  });
});

describe('updateVolumeBackupSchema', () => {
  it('refuses on the PATCH the create route refuses on', () => {
    // `.partial()`, so a payload naming only this field is the whole test —
    // and a PATCH is how a neighbouring field got round a create-time rule.
    expect(
      updateVolumeBackupSchema.safeParse({ volumeName: 'a$(id)' }).success,
    ).toBe(false);
    expect(
      updateVolumeBackupSchema.safeParse({ prefix: 'a$(id)' }).success,
    ).toBe(false);
    expect(
      updateVolumeBackupSchema.safeParse({ volumeName: 'shop-data' }).success,
    ).toBe(true);
  });

  it('refuses a serviceName on the PATCH and keeps the detach', () => {
    expect(
      updateVolumeBackupSchema.safeParse({ serviceName: 'a$(id)' }).success,
    ).toBe(false);
    expect(
      updateVolumeBackupSchema.safeParse({ serviceName: 'api' }).success,
    ).toBe(true);
    // `null` is how the console clears the stack service, and the column is
    // nullable — a charset that refused it would take the detach away.
    expect(
      updateVolumeBackupSchema.safeParse({ serviceName: null }).success,
    ).toBe(true);
  });
});

describe('restoreVolumeBackupSchema', () => {
  it('accepts the object key a backup run of this volume writes', () => {
    expect(restoreVolumeBackupSchema.safeParse(validRestore).success).toBe(
      true,
    );
  });

  it('refuses a volumeName that could leave its shell word', () => {
    for (const volumeName of HOSTILE) {
      expect(
        restoreVolumeBackupSchema.safeParse({ ...validRestore, volumeName })
          .success,
      ).toBe(false);
    }
  });

  it('refuses a backupFileName that could leave its shell word', () => {
    // It lands in `tar -tf /backup/${…}` inside a `docker run … bash -c "…"`
    // and in five `echo "…"` lines beside it, none of them `quote()`d yet.
    for (const backupFileName of HOSTILE) {
      expect(
        restoreVolumeBackupSchema.safeParse({
          ...validRestore,
          backupFileName,
        }).success,
      ).toBe(false);
    }
  });
});

import {
  createPatchSchema,
  markFileForDeletionSchema,
  saveFileAsPatchSchema,
  updatePatchSchema,
} from '../../src/patch/dto/patch.dto';

/**
 * The DTO half of the patch-parent fix. `PatchService.create` resolved
 * `applicationId ?? composeId`, access-checked that one id, and inserted
 * `...data` — which writes both foreign keys — so a body carrying the caller's
 * own `applicationId` beside another organization's `composeId` landed a
 * `patch` row on the victim's Compose stack, and a patch is a `base64 -d >`
 * into the owning service's build tree. The schema conceded the rule in a
 * comment and enforced nothing; §2.4 says a payload shape rule lives here, so
 * "exactly one of these" is now a `superRefine`.
 *
 * The cross-tenant behaviour itself is asserted over HTTP in
 * `patch-tenancy.e2e-spec.ts`, which needs two organizations and two accounts.
 * What is unit-testable is the rule the refinement states, and — the property
 * §2.2 and ADR-0008 ask for — that its refusal is a function of the *shape* of
 * the body and of nothing about which ids exist, so a caller cannot read one id
 * off another's rejection.
 */
describe('createPatchSchema', () => {
  const body = { filePath: 'src/config.ts', content: 'export const X = 1;\n' };

  it('accepts a body owned by an application, and one owned by a compose stack', () => {
    // `toEqual`, not `toMatchObject`: zod omits an absent optional key
    // entirely, and the absent one is half of what these two assert.
    expect(
      createPatchSchema.parse({ ...body, applicationId: 'app-1' }),
    ).toEqual({ ...body, applicationId: 'app-1' });
    expect(
      createPatchSchema.parse({ ...body, composeId: 'compose-1' }),
    ).toEqual({ ...body, composeId: 'compose-1' });
  });

  it('refuses a body carrying both an applicationId and a composeId', () => {
    const result = createPatchSchema.safeParse({
      ...body,
      applicationId: 'app-1',
      composeId: 'compose-1',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['applicationId'],
        message: 'Exactly one of applicationId or composeId must be provided',
      }),
    ]);
  });

  it('refuses a body carrying neither an applicationId nor a composeId', () => {
    const result = createPatchSchema.safeParse(body);

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['applicationId'],
        message: 'Exactly one of applicationId or composeId must be provided',
      }),
    ]);
  });

  it('refuses both ids identically whichever compose stack the second one names', () => {
    const flatten = (input: unknown) =>
      JSON.stringify(createPatchSchema.safeParse(input).error?.issues);

    // The refinement runs before anything is looked up, so a real neighbouring
    // stack, a stack of the caller's own and an id that names nothing anywhere
    // are one refusal — the pair ADR-0008 requires, at the layer that answers
    // first. Nothing here reaches the database to tell them apart.
    const victims = ['their-compose-id', 'our-compose-id', 'no-such-compose'];
    const refusals = victims.map((composeId) =>
      flatten({ ...body, applicationId: 'app-1', composeId }),
    );
    // Refused, and refused with one body: without the first assertion the
    // second passes vacuously on three successes carrying no issues at all.
    expect(refusals[0]).toBeDefined();
    expect(new Set(refusals).size).toBe(1);
  });

  it('rejects an id sent as an empty string rather than reading it as absent', () => {
    // `''` is falsy, and `applicationId ?? composeId` in the service reads
    // `??` — not `||` — so an empty applicationId would resolve to itself and
    // then fail the FK. It is one id, so the refinement passes it; `min(1)`
    // is deliberately not added, because that would be a new refusal for a
    // payload the API already accepted (the no-new-refusals rule) and the FK is what
    // decides whether an id names a service.
    expect(
      createPatchSchema.safeParse({ ...body, applicationId: '' }).success,
    ).toBe(true);
  });
});

describe('updatePatchSchema', () => {
  it('strips an applicationId or composeId off an update body', () => {
    // A patch cannot be re-pointed at another service: the ids are not in the
    // schema, and a plain `z.object` strips unknown keys rather than passing
    // them through, so `PatchService.update` — which access-checked the row's
    // *current* parent — never sees one. The exposure was create-only, and
    // this is the assertion that says so rather than assuming it.
    expect(
      updatePatchSchema.parse({
        content: 'x\n',
        applicationId: 'app-1',
        composeId: 'compose-1',
      }),
    ).toEqual({ content: 'x\n' });
  });
});

/**
 * A Patch's `filePath` is joined onto the build's checkout and run as a shell
 * program on the build host (`PatchService.generateApplyPatchesCommand`), so
 * the schemas that write one refuse a path that leaves the checkout or carries
 * a character a quoted shell word does not stop. The refusal is a 400
 * naming the field; what the apply step does with a row saved before this
 * rule is pinned in `apply-patches-command.spec.ts`.
 */
describe('patchFilePathProblem', () => {
  const unsafe: [string, string][] = [
    ['ends the double quotes', 'src/a"; touch /tmp/pwned; echo "'],
    ['substitutes a command', 'src/$(id).ts'],
    ['substitutes with backticks', 'src/`id`.ts'],
    ['expands a variable', '$HOME/.ssh/authorized_keys'],
    ['escapes with a backslash', 'src\\..\\..\\x'],
    ['smuggles a newline', 'src/a.ts\ntouch /tmp/pwned'],
    ['carries a NUL', 'src/a.ts\0.txt'],
    ['is absolute', '/etc/default/cloudgate-backend'],
    ['climbs out with a leading ..', '../../etc/passwd'],
    ['climbs out after descending', 'src/../../../etc/passwd'],
    ['is a bare ..', '..'],
    ['ends in ..', 'src/..'],
    ['names the checkout itself', '.'],
  ];

  const issuesOf = (result: {
    success: boolean;
    error?: { issues: { path: PropertyKey[] }[] };
  }) => result.error?.issues.map((issue) => issue.path);

  it.each(unsafe)('is refused on create when it %s', (_why, filePath) => {
    const result = createPatchSchema.safeParse({
      filePath,
      content: 'x\n',
      applicationId: 'app-1',
    });
    expect(result.success).toBe(false);
    expect(issuesOf(result)).toEqual([['filePath']]);
  });

  it.each(unsafe)('is refused on update when it %s', (_why, filePath) => {
    const result = updatePatchSchema.safeParse({ filePath });
    expect(result.success).toBe(false);
    expect(issuesOf(result)).toEqual([['filePath']]);
  });

  it.each(unsafe)(
    'is refused by the editor save and delete-mark when it %s',
    (_why, filePath) => {
      const target = { id: 'app-1', type: 'application' as const, filePath };
      expect(
        saveFileAsPatchSchema.safeParse({ ...target, content: 'x' }).success,
      ).toBe(false);
      expect(markFileForDeletionSchema.safeParse(target).success).toBe(false);
    },
  );

  it.each([
    'src/config.ts',
    'README.md',
    '.github/workflows/ci (copy).yml',
    './src/index.ts',
    'a..b/c...d.txt',
    'docker-compose.yml',
  ])('accepts the repository path %s', (filePath) => {
    expect(
      createPatchSchema.safeParse({
        filePath,
        content: '',
        applicationId: 'app-1',
      }).success,
    ).toBe(true);
    expect(updatePatchSchema.safeParse({ filePath }).success).toBe(true);
  });
});

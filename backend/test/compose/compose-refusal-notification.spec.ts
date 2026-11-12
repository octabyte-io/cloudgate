import type { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { BadRequestException } from '@nestjs/common';
import { ComposeService } from '../../src/compose/compose.service';
import type { DeployableCompose } from '../../src/compose/compose.types';
import type { DomainsService } from '../../src/domains/domains.service';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import type { PatchService } from '../../src/patch/patch.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { SourceCloneService } from '../../src/git-providers/source-clone.service';
import type { BitbucketService } from '../../src/git-providers/strategies/bitbucket/bitbucket.service';
import type { GiteaService } from '../../src/git-providers/strategies/gitea/gitea.service';
import type { GitlabService } from '../../src/git-providers/strategies/gitlab/gitlab.service';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import { withArgvExec } from '../utils/exec-double';

/**
 * **What a compose refusal is allowed to say to a third party.**
 *
 * `compose.composeFile` is `encryptedText` (ADR 0015), and that ADR's
 * echo bullet asks two questions of every echo — *who can see it, and is that
 * the audience the column already has*. `DeploymentEngineService.deployCompose`
 * puts one string into two sinks with two different answers:
 * `appendErrorToLog`, whose reader is behind the same entitlement as the column
 * (fine, the argument used to keep a schedule's log echo verbatim), and
 * `notifier.buildError`, which fans out to email, mattermost, telegram,
 * pushover and a **customer-supplied webhook** (not fine).
 *
 * So this file asserts on **what the notifier receives**, not on what the
 * refusal says. The refusal's own wording is `compose-file-parseable.spec.ts`'
 * and `compose-labels.spec.ts`' business; what is pinned here is the sink.
 *
 * `ComposeService` is the **real** one, because the whole claim is about a
 * refusal it raises: a double that resolved would assert nothing. Only its
 * `domains` collaborator is stubbed, and only because the ownership query needs
 * a database — the two refusal classes here are decided before it is reached.
 */

/** A token shaped like something an operator would be sorry to see forwarded. */
const SECRET = 'MARIADB_ROOT_PASSWORD=hunter2-in-the-clear';

/**
 * A compose file that will not parse **and** whose failure interpolates the
 * operator's own bytes into `yaml`'s base message.
 *
 * A block scalar header is one of the three shapes measured on
 * yaml 2.9.0: `Block scalar header includes extra characters: ${source}` puts
 * the header token in the sentence before the first newline, which is the half
 * `boundUpstreamYamlMessage` keeps. So this is not a caret-diagram leak that a
 * `split('\n')[0]` removes — it is in the sentence itself.
 */
const UNPARSEABLE_WITH_SECRET = `services:
  db:
    command: |${SECRET}
      x
`;

/**
 * A compose file that parses and whose own Traefik label the ownership guard
 * refuses — the `ComposeLabelRefusal` half. The wildcard arm is chosen because
 * its message quotes the hostname back (`checkedClaim`), so the refusal carries
 * two operator-authored tokens: the label key and the value.
 */
const REFUSED_LABEL_HOST = 'wildcard-secret.example.com';
const REFUSED_LABEL_KEY = 'traefik.http.routers.hunter2-router.rule';
const LABEL_REFUSED = `services:
  db:
    image: mariadb:11
    labels:
      - ${REFUSED_LABEL_KEY}=Host(\`*.${REFUSED_LABEL_HOST}\`)
`;

function makeComposeService(): ComposeService {
  const domains = {
    findComposeDomains: jest.fn().mockResolvedValue([]),
    assertHostsUnclaimedInOrganization: jest.fn().mockResolvedValue(undefined),
  };
  const blank = {} as never;
  return new ComposeService(
    blank as DrizzleDB,
    blank,
    blank,
    domains as unknown as DomainsService,
    { sleep: () => Promise.resolve(), now: () => 0 },
    blank,
    blank,
    blank as GitlabService,
    blank as GiteaService,
    blank as BitbucketService,
    // The Stop hook; nothing here Stops a Service.
    {} as never,
    // InstanceMode; nothing here creates a stack.
    {} as never,
  );
}

function makeEngine(composeService: ComposeService) {
  const execAsync = jest.fn(() =>
    Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  );
  const remoteExec = withArgvExec({
    execAsync,
    execAsyncRemote: execAsync,
  }) as unknown as RemoteExecService;
  const notifier = {
    buildSuccess: jest.fn().mockResolvedValue(undefined),
    buildError: jest.fn().mockResolvedValue(undefined),
  };
  const recorder = {
    create: jest.fn().mockResolvedValue({
      deploymentId: 'dep-1',
      logPath: '/etc/cloudgate/logs/stack-1/dep-1.log',
      cancelled: new AbortController().signal,
    }),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    closeCancelWindow: jest.fn(),
  };
  const blank = {} as never;
  const engine = new DeploymentEngineService(
    remoteExec,
    blank,
    blank,
    composeService,
    {
      findComposeDomains: jest.fn().mockResolvedValue([]),
    } as unknown as DomainsService,
    new SourceCloneService(blank, blank, blank, blank),
    {
      generateApplyPatchesCommand: jest.fn().mockResolvedValue(''),
    } as unknown as PatchService,
    recorder,
    notifier,
    blank,
    // The database the host line reads. It is read ahead of every refusal
    // here, and a read that fails names the Server by id instead — so the
    // refusal's own reason is still what reaches the notifier.
    blank,
    { isHosted: false } as InstanceMode,
  );
  return { engine, notifier, recorder, execAsync };
}

function makeStack(composeFile: string): DeployableCompose {
  return {
    composeId: 'cmp-1',
    appName: 'stack-1',
    name: 'Stack One',
    description: '',
    composeFile,
    env: '',
    composeType: 'docker-compose',
    sourceType: 'raw',
    composePath: './docker-compose.yml',
    command: '',
    isolatedDeployment: false,
    serverId: 'srv-1',
    composeStatus: 'idle',
    environment: {
      environmentId: 'env-1',
      env: '',
      project: { projectId: 'proj-1', organizationId: 'org-1', env: '' },
    },
  } as unknown as DeployableCompose;
}

/** The `errorMessage` the build-failure notification carried. */
async function notifiedMessage(composeFile: string): Promise<string> {
  const { engine, notifier } = makeEngine(makeComposeService());
  await expect(engine.deployCompose(makeStack(composeFile))).rejects.toThrow();
  expect(notifier.buildError).toHaveBeenCalledTimes(1);
  const [notified] = notifier.buildError.mock.calls[0] as [
    { errorMessage: string },
  ];
  return notified.errorMessage;
}

describe('DeploymentEngineService.deployCompose, on what a refusal tells a third party', () => {
  it('carries no byte of the compose file when the file will not parse', async () => {
    const errorMessage = await notifiedMessage(UNPARSEABLE_WITH_SECRET);

    expect(errorMessage).not.toContain(SECRET);
    expect(errorMessage).not.toContain('hunter2');
    // It still says what refused, and where in the file: a line and a column
    // are positions rather than bytes, so they cost the operator's audience
    // nothing and are what an operator navigates by.
    expect(errorMessage).toBe(
      'Compose file is not valid YAML at line 3, column 15',
    );
  });

  it('carries neither the label nor the hostname when a label is refused', async () => {
    const errorMessage = await notifiedMessage(LABEL_REFUSED);

    expect(errorMessage).not.toContain(REFUSED_LABEL_HOST);
    expect(errorMessage).not.toContain(REFUSED_LABEL_KEY);
    expect(errorMessage).not.toContain('hunter2');
    expect(errorMessage).toContain('A label in the compose file was refused');
    // The reason survives — it is Cloudgate's own prose and it is the thing an
    // operator acts on. Only the two interpolated tokens go.
    expect(errorMessage).toContain('wildcard');
  });

  it('says the same thing to the deployment log, on this transport', async () => {
    // The log and the notification are handed one string by `deployCompose`'s
    // `catch`, so closing the notification necessarily summarizes the log too.
    // Pinned rather than left implicit: it is the cost of fixing this without
    // editing the engine, and the ADR paragraph in `compose.service.ts` names
    // the one line that would buy the log its verbatim words back.
    const { engine, execAsync } = makeEngine(makeComposeService());
    await expect(
      engine.deployCompose(makeStack(UNPARSEABLE_WITH_SECRET)),
    ).rejects.toThrow();

    // `execAsyncRemote(serverId, command, …)`: the program is the second word.
    const written = (execAsync.mock.calls as unknown[][])
      .map((call) => String(call[1]))
      .join('\n');
    const decoded = written.replace(
      /echo "([A-Za-z0-9+/=]+)"/g,
      (_match, base64: string) => Buffer.from(base64, 'base64').toString(),
    );
    expect(decoded).toContain('Compose file is not valid YAML');
    expect(decoded).not.toContain(SECRET);
  });
});

describe('ComposeService.assertComposeContentClaimable, on what it tells the author', () => {
  it('quotes the parser back verbatim on the request paths', async () => {
    // The other half of the decision, and the reason the split is by *audience*
    // rather than by refusal: a caller who sent these bytes, or who owns the
    // stack they are stored on, is exactly the audience the column already has.
    // `'verbatim'` is what `ComposeService`' own five call sites pass.
    const service = makeComposeService();

    await expect(
      service.assertComposeContentClaimable(
        { organizationId: 'org-1', serverId: 'srv-1' },
        UNPARSEABLE_WITH_SECRET,
        'verbatim',
      ),
    ).rejects.toThrow(
      new BadRequestException(
        `Compose file is not valid YAML: Block scalar header includes extra characters: |${SECRET} at line 3, column 15`,
      ),
    );
  });

  it('names the label and the hostname on the request paths', async () => {
    const service = makeComposeService();

    await expect(
      service.assertComposeContentClaimable(
        { organizationId: 'org-1', serverId: 'srv-1' },
        LABEL_REFUSED,
        'verbatim',
      ),
    ).rejects.toThrow(REFUSED_LABEL_KEY);
  });
});

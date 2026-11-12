import { AiService } from '../../src/ai/ai.service';
import type { DeployAiDto } from '../../src/ai/dto/ai.dto';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import {
  collaborators,
  ctx,
  DEPLOYER,
  journal,
  permissionsStub,
  refusalOf,
  roleWithout,
  unreached,
} from './composed-create.fixture';
import type { Journal, RoleStatements } from './composed-create.fixture';

/** The Environment row `findParentEnvironment` selects. */
const ENVIRONMENT = {
  environmentId: 'env-1',
  projectId: 'proj-1',
  projectName: 'Acme Payroll',
};

/**
 * One domain and **two** config files. This route's loops run
 * domains-then-mounts — the mirror of the sibling's order — so a refusal in the
 * second loop used to land with the stack, the grant *and the domain* already
 * written and neither config file attached, and a refusal on the second config
 * file with the first one written.
 */
const DEPLOY: DeployAiDto = {
  environmentId: 'env-1',
  id: 'chatwoot',
  name: 'Chatwoot',
  description: 'a suggestion the operator accepted',
  dockerCompose: 'services:\n  app:\n    image: chatwoot/chatwoot:v3\n',
  envVariables: 'SECRET_KEY_BASE=abc',
  domains: [{ host: 'chatwoot.example.com', port: 3000, serviceName: 'app' }],
  configFiles: [
    { filePath: './conf/app.ini', content: 'first = file' },
    { filePath: './conf/extra.ini', content: 'second = file' },
  ],
};

interface QueryChain {
  from: () => QueryChain;
  innerJoin: () => QueryChain;
  where: () => QueryChain;
  limit: () => Promise<(typeof ENVIRONMENT)[]>;
}

function harness(role: RoleStatements = DEPLOYER): {
  service: AiService;
  state: Journal;
} {
  const state = journal();

  const chain: QueryChain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => Promise.resolve([ENVIRONMENT]),
  };
  const db = { select: () => chain } as unknown as DrizzleDB;

  const permissions = permissionsStub(state, role, [ENVIRONMENT.projectId]);
  const { compose, domains, mounts } = collaborators(state, permissions);

  const service = new AiService(
    db,
    unreached('TEXT_GENERATOR'),
    unreached('FETCH_CLIENT'),
    unreached('ADDRESS_RESOLVER'),
    permissions,
    // No `serverId` in the body, so this deploy targets the platform host and
    // neither collaborator is reached — ADR-0008's "there is no `server` row to
    // find" arm, which is also why no `server: ['read']` appears below.
    unreached('ServersService'),
    unreached('SettingsService'),
    compose,
    domains,
    mounts,
    unreached('OutboundAddressGuard'),
  );
  return { service, state };
}

/**
 * `AiService.deploy`'s half of the pre-flight — the sibling of
 * `test/templates/composed-create-preflight.spec.ts`, which carries the
 * argument and the unit cases for `composedCreateStatements` itself.
 *
 * Both routes are one operation spelled twice: authorize at the Project, insert
 * the compose row, grant it, then populate. Nothing scopes those to each other,
 * so every refusal the population loops could give used to arrive with the
 * stack committed and owned by the caller. This route is the one where the
 * regression was actually caught (`ai.e2e-spec.ts` happens to build a custom
 * role), and it is the one where the domains loop runs first — so the
 * half-built stack it produced had a router and no config files, which is the
 * shape an operator cannot tell from a working one.
 */
describe('AiService.deploy', () => {
  it('creates nothing on the way to refusing a caller who may not attach a config file', async () => {
    const { service, state } = harness(roleWithout('volume', 'create'));

    const refusal = await refusalOf(service.deploy(ctx, DEPLOY));

    expect(refusal).toEqual({ status: 403, message: 'Permission denied' });
    // The three writes that did not happen, in one object so a regression
    // names *which* half of the stack it left behind rather than stopping at
    // the first assertion (§2.2). Before the fix this route claimed
    // `volume: ['create']` for the first time inside the mounts loop, which
    // runs *after* the domains loop, so the refusal arrived with the stack
    // committed, granted to this caller, and carrying the domain row but
    // neither config file.
    expect({
      created: state.created,
      granted: state.granted,
      attached: state.attached,
    }).toEqual({ created: [], granted: [], attached: [] });
  });

  it('creates nothing on the way to refusing a caller who may not attach a domain', async () => {
    const { service, state } = harness(roleWithout('domain', 'create'));

    const refusal = await refusalOf(service.deploy(ctx, DEPLOY));

    expect(refusal.status).toBe(403);
    // The three writes that did not happen, in one object so a regression
    // names *which* half of the stack it left behind rather than stopping at
    // the first assertion (§2.2).
    expect({
      created: state.created,
      granted: state.granted,
      attached: state.attached,
    }).toEqual({ created: [], granted: [], attached: [] });
  });

  /**
   * The gate `a73a43c` narrowed and did not close: both loops run
   * `checkServiceAccess(…, 'read')`, whose role half is `service: ['read']`,
   * and this route only ever asks for `'create'`. A licensed role holding
   * `service: ['create']` without `'read'` was therefore refused inside the
   * loops, with the stack standing.
   */
  it('creates nothing on the way to refusing a caller holding create without read', async () => {
    const { service, state } = harness(roleWithout('service', 'read'));

    const refusal = await refusalOf(service.deploy(ctx, DEPLOY));

    expect(refusal.status).toBe(403);
    // The three writes that did not happen, in one object so a regression
    // names *which* half of the stack it left behind rather than stopping at
    // the first assertion (§2.2).
    expect({
      created: state.created,
      granted: state.granted,
      attached: state.attached,
    }).toEqual({ created: [], granted: [], attached: [] });
    expect(state.statements.at(-1)).toEqual({ service: ['read'] });
  });

  /**
   * The positive half, and where the claims sit: after this method's own
   * `checkServiceAccess(projectId, 'create')` and before the compose insert.
   */
  it('claims every statement its loops need before it writes anything, then attaches the definition', async () => {
    const { service, state } = harness();

    const created = await service.deploy(ctx, DEPLOY);

    expect(created).toMatchObject({ composeId: 'compose-1' });
    expect(state.statements).toEqual([
      // The role half of this route's own `checkServiceAccess(projectId,
      // 'create')`.
      { service: ['create'] },
      // The pre-flight.
      { service: ['read'] },
      { domain: ['create'] },
      { volume: ['create'] },
      // Then the loops, domains first on this route, reaching the same gates a
      // second time on a caller already known to hold them.
      { domain: ['create'] },
      { service: ['read'] },
      { volume: ['create'] },
      { service: ['read'] },
      { volume: ['create'] },
      { service: ['read'] },
    ]);
    expect(state.granted).toEqual(['compose-1']);
    expect(state.attached).toEqual([
      'domain chatwoot.example.com',
      'mount ./conf/app.ini',
      'mount ./conf/extra.ini',
    ]);
  });

  /**
   * The conditional half: a suggestion carrying neither a domain nor a config
   * file reaches neither gate today and must not start paying for one, so a
   * role holding no `domain` and no `volume` action still deploys it.
   */
  it('claims no domain or volume statement for a suggestion that populates neither', async () => {
    const role: RoleStatements = { ...DEPLOYER, domain: [], volume: [] };
    const { service, state } = harness(role);

    await service.deploy(ctx, {
      ...DEPLOY,
      domains: undefined,
      configFiles: undefined,
    });

    expect(state.statements).toEqual([{ service: ['create'] }]);
    expect(state.granted).toEqual(['compose-1']);
    expect(state.attached).toEqual([]);
  });
});

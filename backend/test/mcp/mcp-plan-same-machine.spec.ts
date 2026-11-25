import { getPlan, requestPlan } from '../../src/mcp/tools/project-config.tools';
import type { PlanNote, PlanView } from '../../src/project-config';
import type { ProjectConfigService } from '../../src/project-config';
import type { PermissionCtx } from '../../src/rbac/permission.service';

/**
 * The Same-machine warning is the console's and the CLI's: "MCP tools and
 * Agents are untouched" (spec #146). A plan's `same-machine` note is left out
 * of what `get_plan` and `request_plan` answer; every other note goes through.
 * The real round trip over `POST /mcp` is `mcp-project-config.e2e-spec.ts`'s,
 * whose plan creates on This Cloudgate host and answers no such note.
 */
describe('get_plan and request_plan on a plan with a Same-machine note', () => {
  const variableNote = {
    kind: 'variable-without-value',
    configName: 'shop',
    list: 'env',
    variable: 'DATABASE_URL',
    message: 'shop asks for DATABASE_URL, which has no value here.',
  } as unknown as PlanNote;
  const sameMachineNote = {
    kind: 'same-machine',
    configName: 'cache',
    message:
      "cache will run on the machine Cloudgate itself runs on. If it is lost, so are this Service and Cloudgate's records. Add a Server, or use Cloudgate Hosted: https://cloudgate.octabyte.app",
  } as unknown as PlanNote;
  const made = {
    planId: 'plan-1',
    steps: [],
    notes: [sameMachineNote, variableNote],
  } as unknown as PlanView;

  const service = {
    findPlan: () => Promise.resolve({ plan: made }),
    requestPlan: () => Promise.resolve(made),
  } as unknown as ProjectConfigService;
  const ctx = {} as PermissionCtx;
  const args = { environmentId: 'env-1' };

  it('get_plan answers every note but the Same-machine one', async () => {
    const found = await getPlan.call(service, ctx, args);
    expect(found.plan?.notes).toEqual([variableNote]);
  });

  it('request_plan answers every note but the Same-machine one', async () => {
    const asked = await requestPlan.call(service, ctx, args);
    expect(asked.notes).toEqual([variableNote]);
  });

  it('get_plan still answers no plan as null', async () => {
    const none = {
      findPlan: () => Promise.resolve({ plan: null }),
    } as unknown as ProjectConfigService;
    await expect(getPlan.call(none, ctx, args)).resolves.toEqual({
      plan: null,
    });
  });
});

import { project } from '../../src/mcp/tool-projection';
import { MCP_TOOLS } from '../../src/mcp/tools';
import { getPlan } from '../../src/mcp/tools/project-config.tools';
import type { PlanStep } from '../../src/project-config';

/**
 * An Agent sees a Stack VM's plan lines but never applies them (#1372,
 * spec #1357 US61): get_plan carries the line's machine, disk and price,
 * and no tool applies a plan.
 */

const STEP: PlanStep = {
  action: 'create',
  configName: 'wiki',
  kind: 'compose',
  placement: { kind: 'cloud', cloudAccountId: 'ca-1', region: 'eu-west-1' },
  fields: [],
  stackVm: {
    size: {
      name: 'medium',
      from: 'default',
      machineType: 't3.small',
      machine: '2 vCPU, 2 GB',
    },
    region: 'eu-west-1',
    dataDiskGb: 20,
    snapshotDays: 7,
    monthly: {
      machineUsd: 16.64,
      diskUsd: 1.76,
      snapshotsUsd: 1,
      totalUsd: 19.4,
    },
    lines: [
      'wiki Stack VM: no size, starts at medium → t3.small (2 vCPU, 2 GB) in eu-west-1',
    ],
    consoleStackId: 'compose-wiki',
  },
  cloudRead: { status: 'reading' },
};

describe('getPlan, a Stack VM line', () => {
  it("carries the Stack VM's machine, disk, price and lines", () => {
    const answer = project(getPlan.projection, {
      plan: { planId: 'plan-1', steps: [STEP] },
    }) as { plan: { steps: { stackVm: unknown }[] } };
    expect(answer.plan.steps[0].stackVm).toEqual({
      region: 'eu-west-1',
      dataDiskGb: 20,
      snapshotDays: 7,
      lines: [
        'wiki Stack VM: no size, starts at medium → t3.small (2 vCPU, 2 GB) in eu-west-1',
      ],
      size: {
        name: 'medium',
        from: 'default',
        machineType: 't3.small',
        machine: '2 vCPU, 2 GB',
      },
      monthly: {
        machineUsd: 16.64,
        diskUsd: 1.76,
        snapshotsUsd: 1,
        totalUsd: 19.4,
      },
    });
  });

  it('offers no tool that applies a plan', () => {
    const appliers = MCP_TOOLS.filter(
      (tool) =>
        /apply/i.test(tool.name) ||
        /apply/i.test(String(tool.target?.method ?? '')),
    );
    expect(appliers).toEqual([]);
  });
});

import {
  ORGANIZATION_LABEL,
  SERVER_LABEL,
} from '../../src/bought-servers/bought-server-stages.service';
import type { HetznerServer } from '../../src/bought-servers/hetzner/hetzner-cloud.port';
import { orphansAmong } from '../../src/bought-servers/orphan-machines';

function machine(id: number, labels: Record<string, string>): HetznerServer {
  return {
    id,
    name: `cloudgate-${id}`,
    status: 'running',
    serverType: 'cpx22',
    location: 'hel1',
    ipv4: null,
    primaryIpv4Id: null,
    ipv6: null,
    primaryIpv6Id: null,
    backups: false,
    volumeIds: [],
    labels,
    created: '2026-11-01T09:00:00Z',
  };
}

const labelled = (serverId: string) => ({
  [ORGANIZATION_LABEL]: 'org1',
  [SERVER_LABEL]: serverId,
});

describe('orphansAmong: the machines nothing owns', () => {
  it('keeps a labelled machine whose Bought Server is not there', () => {
    const lost = machine(1, labelled('gone'));
    expect(orphansAmong([lost], [])).toEqual([lost]);
  });

  it('never keeps a machine a live Bought Server names by its labels', () => {
    for (const stage of [
      'waiting_for_payment',
      'creating',
      'setting_up',
      'ready',
      'changing',
      'deleting',
    ] as const) {
      expect(
        orphansAmong(
          [machine(1, labelled('bs1'))],
          [{ id: 'bs1', stage, providerServerId: null }],
        ),
      ).toEqual([]);
    }
  });

  it('never keeps a machine a live Bought Server holds by its stored id', () => {
    expect(
      orphansAmong(
        [machine(7, labelled('relabelled'))],
        [{ id: 'bs1', stage: 'ready', providerServerId: 7 }],
      ),
    ).toEqual([]);
  });

  it('keeps a machine whose Bought Server is Deleted or Failed', () => {
    const afterDelete = machine(1, labelled('bs1'));
    const afterFail = machine(2, labelled('bs2'));
    expect(
      orphansAmong(
        [afterDelete, afterFail],
        [
          { id: 'bs1', stage: 'deleted', providerServerId: 1 },
          { id: 'bs2', stage: 'failed', providerServerId: null },
        ],
      ),
    ).toEqual([afterDelete, afterFail]);
  });

  it("leaves alone a machine with none of Cloudgate's labels", () => {
    expect(
      orphansAmong([machine(1, {}), machine(2, { team: 'ops' })], []),
    ).toEqual([]);
  });

  it('keeps a machine carrying only one of the two labels', () => {
    const half = machine(1, { [ORGANIZATION_LABEL]: 'org1' });
    expect(orphansAmong([half], [])).toEqual([half]);
  });
});

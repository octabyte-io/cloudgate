import type {
  TofuFailure,
  TofuShow,
} from '../../src/cloud-accounts/cloud.port';
import { domainRunCheck } from '../../src/project-config/applier/unmade-domains';

const SHOW: TofuShow = { format_version: '1.2', resource_changes: [] };

const cloudRefused: TofuFailure = {
  ok: false,
  reason: 'failed',
  failedAt: 'apply',
  message:
    'Error: Error creating DnsAuthorization: googleapi: Error 400: unrecognized TLD',
};

/**
 * A Domain run fails its unmade Domains only on the cloud's refusal: a
 * stop of the run's own (its plan check, Drift, the lock, an interrupt)
 * is the run's problem and stays on the Deployment.
 */
describe('domainRunCheck', () => {
  it("calls tofu's failure the cloud's refusal when the run's own check let the apply go", () => {
    const run = domainRunCheck(() => null);
    expect(run.beforeApply(SHOW)).toBeNull();
    expect(run.refusedByCloud(cloudRefused)).toBe(true);
  });

  it('calls a failure the cloud refused at plan, before the check was asked, the cloud’s refusal', () => {
    const run = domainRunCheck(() => null);
    expect(run.refusedByCloud({ ...cloudRefused, failedAt: 'plan' })).toBe(
      true,
    );
  });

  it("never calls a failure before the plan (init, the workspace, recording what the run would forget) the cloud's refusal", () => {
    const run = domainRunCheck(() => null);
    expect(
      run.refusedByCloud({
        ok: false,
        reason: 'failed',
        message: 'Nothing was changed: the database is gone',
      }),
    ).toBe(false);
  });

  it("never calls the run's own plan check stopping it the cloud's refusal", () => {
    const stop: TofuFailure = {
      ok: false,
      reason: 'failed',
      message: 'aws_cloudfront_distribution.site was changed in AWS by hand',
    };
    const run = domainRunCheck(() => stop);
    expect(run.beforeApply(SHOW)).toBe(stop);
    expect(run.refusedByCloud(stop)).toBe(false);
  });

  it.each([
    'lock-held',
    'interrupted',
    'unreadable-state',
    'newer-state',
    'install-mismatch',
  ] as const)(
    "never calls a run-level failure (%s) the cloud's refusal",
    (reason) => {
      const run = domainRunCheck(() => null);
      run.beforeApply(SHOW);
      expect(
        run.refusedByCloud({
          ok: false,
          reason,
          failedAt: 'plan',
          message: 'stopped',
        }),
      ).toBe(false);
    },
  );
});

import type { TofuShow } from '../../../src/cloud-accounts/cloud.port';
import { closeMotoGaps } from './moto-gaps';

const DEFAULT_AS_MOTO = {
  acm_certificate_arn: '',
  cloudfront_default_certificate: true,
  minimum_protocol_version: 'TLSv1',
  ssl_support_method: 'sni-only',
};
const DEFAULT_AS_AWS = { ...DEFAULT_AS_MOTO, ssl_support_method: null };
const ISSUED = {
  acm_certificate_arn: 'arn:aws:acm:us-east-1:123456789012:certificate/1',
  cloudfront_default_certificate: null,
  minimum_protocol_version: 'TLSv1.2_2021',
  ssl_support_method: 'sni-only',
};

function distributionPlan(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): TofuShow {
  return {
    resource_changes: [
      {
        address: 'aws_cloudfront_distribution.site',
        type: 'aws_cloudfront_distribution',
        change: { actions: ['update'], before, after },
      },
    ],
  };
}

type Changes = {
  resource_changes: {
    change: { actions: string[]; before: Record<string, unknown> };
  }[];
};

describe('backend/test/cloud-accounts/moto/moto-gaps.ts — closeMotoGaps', () => {
  /**
   * A gap is closed as AWS would have answered the refreshed value, so
   * a change the definition really plans to that field is never hidden.
   */
  describe('the distribution’s viewer certificate', () => {
    it("reads moto's sni-only beside CloudFront's own certificate as AWS's unset, so a plan of no change is no-op", () => {
      const closed = closeMotoGaps(
        distributionPlan(
          { viewer_certificate: [DEFAULT_AS_MOTO] },
          { viewer_certificate: [DEFAULT_AS_AWS] },
        ),
      ) as unknown as Changes;

      expect(closed.resource_changes[0].change.actions).toEqual(['no-op']);
    });

    it("keeps a Domain's certificate put on the distribution as the change it is", () => {
      const closed = closeMotoGaps(
        distributionPlan(
          { viewer_certificate: [DEFAULT_AS_MOTO] },
          { viewer_certificate: [ISSUED] },
        ),
      ) as unknown as Changes;

      expect(closed.resource_changes[0].change.actions).toEqual(['update']);
      expect(
        closed.resource_changes[0].change.before.viewer_certificate,
      ).toEqual([DEFAULT_AS_AWS]);
    });

    it("reads moto's own-certificate flag beside a Domain's certificate as AWS's, so the attached site plans no change", () => {
      const closed = closeMotoGaps(
        distributionPlan(
          {
            viewer_certificate: [
              { ...ISSUED, cloudfront_default_certificate: true },
            ],
          },
          { viewer_certificate: [ISSUED] },
        ),
      ) as unknown as Changes;

      expect(closed.resource_changes[0].change.actions).toEqual(['no-op']);
    });
  });

  /**
   * moto keeps no origin's OAC, so the provider plans the origin anew
   * with its response timeout unknown; closed, an unchanged origin is no
   * change, and a hand change to its bucket stays one.
   */
  describe('the distribution’s origin', () => {
    const ORIGIN = {
      domain_name: 'docs.s3.eu-central-1.amazonaws.com',
      origin_access_control_id: 'E2OAC',
      origin_id: 'site-bucket',
      origin_path: '/deployments/dep_1',
    };
    const originPlan = (
      refreshed: Record<string, unknown>,
      planned: Record<string, unknown>,
    ): TofuShow => ({
      resource_changes: [
        {
          address: 'aws_cloudfront_distribution.site',
          type: 'aws_cloudfront_distribution',
          change: {
            actions: ['update'],
            before: { origin: [refreshed] },
            after: { origin: [planned] },
            after_unknown: {
              origin: [{ response_completion_timeout: true }],
            },
          },
        },
      ],
    });

    it("reads moto's empty OAC, and the timeout it left unknown, as AWS's unchanged origin", () => {
      const closed = closeMotoGaps(
        originPlan(
          // Where the provider puts it: among the others, not last.
          {
            response_completion_timeout: 0,
            ...ORIGIN,
            origin_access_control_id: '',
          },
          ORIGIN,
        ),
      ) as unknown as Changes;

      expect(closed.resource_changes[0].change.actions).toEqual(['no-op']);
    });

    it("keeps a hand change to the origin's bucket as the change it is", () => {
      const closed = closeMotoGaps(
        originPlan(
          {
            ...ORIGIN,
            domain_name: 'someone-elses-site.s3.eu-central-1.amazonaws.com',
            origin_access_control_id: '',
            response_completion_timeout: 0,
          },
          ORIGIN,
        ),
      ) as unknown as Changes;

      expect(closed.resource_changes[0].change.actions).toEqual(['update']);
    });
  });
});

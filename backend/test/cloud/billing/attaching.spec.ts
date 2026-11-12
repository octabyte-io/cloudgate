import { HttpStatus } from '@nestjs/common';

import {
  attachRefusalOf,
  roomLeftOf,
} from '../../../src/cloud/billing/attaching';
import { organizationLimit } from '../../../src/organizations/organization-limit';

const HOPPER = 'Hopper Labs';

describe('attachRefusalOf', () => {
  it('lets an Organization on Business pay for another', () => {
    expect(
      attachRefusalOf({
        name: HOPPER,
        paidBy: null,
        plan: 'business',
        movingToStarter: false,
      }),
    ).toBeNull();
  });

  it('lets an Enterprise Organization pay for another', () => {
    expect(
      attachRefusalOf({
        name: HOPPER,
        paidBy: null,
        plan: 'enterprise',
        movingToStarter: false,
      }),
    ).toBeNull();
  });

  it('refuses an Organization on Starter, and says Business can', () => {
    expect(
      attachRefusalOf({
        name: HOPPER,
        paidBy: null,
        plan: 'starter',
        movingToStarter: false,
      }),
    ).toBe(
      'Hopper Labs is on Starter, which pays for one Organization. On Business, Hopper Labs can pay for more Organizations',
    );
  });

  it('refuses an Organization with no plan, and says Business can', () => {
    expect(
      attachRefusalOf({
        name: HOPPER,
        paidBy: null,
        plan: null,
        movingToStarter: false,
      }),
    ).toBe(
      'Hopper Labs has no plan. On Business, Hopper Labs can pay for more Organizations',
    );
  });

  it('refuses an Organization that is attached itself, naming who pays for it', () => {
    expect(
      attachRefusalOf({
        name: 'Turing Works',
        paidBy: HOPPER,
        plan: 'business',
        movingToStarter: false,
      }),
    ).toBe(
      'Turing Works is paid for by Hopper Labs, and an Organization that is paid for cannot pay for others',
    );
  });

  it('refuses a Business Organization whose move to Starter is waiting, so Starter never pays for others', () => {
    expect(
      attachRefusalOf({
        name: HOPPER,
        paidBy: null,
        plan: 'business',
        movingToStarter: true,
      }),
    ).toBe(
      'Hopper Labs moves to Starter at the end of its paid month. Keep Business to add an Organization to its plan',
    );
  });
});

describe('organizationLimit', () => {
  it('is a 403 carrying ORGANIZATION_LIMIT and the reason', () => {
    const refusal = organizationLimit('Hopper Labs has no plan');

    expect(refusal.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(refusal.getResponse()).toEqual({
      code: 'ORGANIZATION_LIMIT',
      message: 'Hopper Labs has no plan',
    });
  });
});

describe('roomLeftOf', () => {
  it('is what the allowance leaves of the usage, never below zero', () => {
    expect(
      roomLeftOf(
        { plan: 'business', servers: 4, cloudEnvironments: 4 },
        { servers: 1, cloudEnvironments: 6 },
      ),
    ).toEqual({ servers: 3, cloudEnvironments: 0 });
  });

  it('is nothing without a plan', () => {
    expect(
      roomLeftOf(
        { plan: null, servers: 0, cloudEnvironments: 0 },
        { servers: 0, cloudEnvironments: 0 },
      ),
    ).toEqual({ servers: 0, cloudEnvironments: 0 });
  });
});

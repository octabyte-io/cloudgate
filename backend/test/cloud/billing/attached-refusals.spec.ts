import { HttpStatus } from '@nestjs/common';
import {
  organizationsAttached,
  paidByAnotherOrganization,
} from '../../../src/cloud/billing/attached-refusals';

const HOPPER = { id: 'org-hopper', name: 'Hopper Labs' };
const TURING = { id: 'org-turing', name: 'Turing Works' };
const LOVELACE = { id: 'org-lovelace', name: 'Lovelace & Co' };
const BABBAGE = { id: 'org-babbage', name: 'Babbage Engines' };

describe('organizationsAttached', () => {
  it('names the one Attached Organization in the way of a delete', () => {
    const refusal = organizationsAttached(HOPPER, [TURING], 'delete');

    expect(refusal.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(refusal.getResponse()).toEqual({
      code: 'ORGANIZATIONS_ATTACHED',
      message:
        'Hopper Labs pays for Turing Works. Delete it, or stop paying for it, before deleting Hopper Labs',
    });
  });

  it('names each Attached Organization in the way of the move to Starter', () => {
    const refusal = organizationsAttached(
      HOPPER,
      [TURING, LOVELACE, BABBAGE],
      'starter',
    );

    expect(refusal.getResponse()).toEqual({
      code: 'ORGANIZATIONS_ATTACHED',
      message:
        'Hopper Labs pays for Turing Works, Lovelace & Co and Babbage Engines. Delete them, or stop paying for them, before moving Hopper Labs to Starter',
    });
  });
});

describe('paidByAnotherOrganization', () => {
  it('says who pays and who changes the plan, for Checkout, a plan change or Add-ons', () => {
    const refusal = paidByAnotherOrganization(TURING, HOPPER, 'billing');

    expect(refusal.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(refusal.getResponse()).toEqual({
      code: 'PAID_BY_ANOTHER_ORGANIZATION',
      message:
        'Turing Works is paid by Hopper Labs. Only the owners and admins of Hopper Labs change its plan or Add-ons',
    });
  });

  it("is the PRD's wording for an Operator turning Enterprise on", () => {
    const refusal = paidByAnotherOrganization(TURING, HOPPER, 'enterprise');

    expect(refusal.getResponse()).toEqual({
      code: 'PAID_BY_ANOTHER_ORGANIZATION',
      message:
        "Turing Works is paid by Hopper Labs. Turn Enterprise on for Hopper Labs, or Turing Works's owner first pays for it themselves",
    });
  });
});

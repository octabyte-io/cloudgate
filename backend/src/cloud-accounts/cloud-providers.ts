import { Injectable } from '@nestjs/common';

import type { CloudAccount } from '../db/schema';
import { AwsProvider } from './aws/aws-provider';
import type { CloudKind } from './cloud-account.schema';
import type {
  CloudAccountSetup,
  CloudAccountView,
  GoogleCloudAccountSetup,
} from './cloud-accounts.service';
import { byCloud } from './cloud-provider';
import type { PerCloud } from './cloud-provider';
import type { SetupTemplate } from './aws/setup-template';
import type {
  CreateCloudAccountInput,
  SetupCloudAccountInput,
  UpdateCloudAccountInput,
} from './dto/cloud-account.dto';
import { GoogleProvider } from './gcp/google-provider';
import type { GoogleSetupTemplate } from './gcp/setup-script';

/** How a connect check ended: the policy or role version it held the identity to, or what to fix. */
export type ConnectCheckOutcome =
  | { readonly ok: true; readonly policyVersion: number }
  | { readonly ok: false; readonly message: string };

/**
 * **A Cloud account's lifecycle on one cloud** (ADR-0043): what
 * connecting, checking, editing and deleting a Cloud account does there.
 * `AwsProvider` (`aws/aws-provider.ts`) and `GoogleProvider`
 * (`gcp/google-provider.ts`) are the two, registered by `cloud` in
 * {@link CloudProviders}; `CloudAccountsService` keeps what is the same on
 * every cloud — the row, its Organization, its delete guards, its last check
 * — and asks the provider for the rest.
 *
 * A method handed a row or an input of another cloud throws: the service
 * chooses the provider by that row's or input's own `cloud`. A refusal the
 * operator can fix is a `400` naming it; a cloud that never answered, a
 * `502`. Nothing here writes the row, except {@link connect}, which saves
 * it only once its check passes, and a failed use recorded as the last
 * check.
 *
 * What only one cloud has is not here, but on its adapter: the deploy
 * role's session on AWS; the run session and the key change on Google.
 */
export interface CloudProvider {
  readonly cloud: CloudKind;
  /**
   * What connecting needs before the cloud has anything (the Google Cloud spec):
   * a sealed setup token and the template or script to run. Calls nothing
   * in the cloud and keeps nothing; a token handed back keeps its ids.
   */
  setup(
    organizationId: string,
    data: SetupCloudAccountInput,
  ): Promise<CloudAccountSetup | GoogleCloudAccountSetup>;
  /**
   * The Cloud account saved, only if every step of its connect check passed:
   * a duplicate is a 409 before any cloud call, a refusal a
   * 400 that writes nothing.
   */
  connect(
    organizationId: string,
    data: CreateCloudAccountInput,
  ): Promise<CloudAccount>;
  /**
   * The columns an edit writes: a field left out keeps
   * its value, and a changed credential reruns the connect check, its pass
   * written as the last check. A failed re-check is a 400 and writes nothing.
   */
  edit(
    stored: CloudAccount,
    data: UpdateCloudAccountInput,
  ): Promise<Partial<CloudAccount>>;
  /** The connect check on the saved values, as "Check now" runs it. */
  check(stored: CloudAccount): Promise<ConnectCheckOutcome>;
  /** The setup at the current policy or role version, for a connected Cloud account. */
  template(stored: CloudAccount): SetupTemplate | GoogleSetupTemplate;
  /** The region check of a Deploy target there (the Google Cloud spec): its warnings, or a 400 naming the region. */
  checkRegion(stored: CloudAccount, region: string): Promise<string[]>;
  /**
   * Whether it signs in now as its deploy identity, the refusal recorded on
   * the Cloud account like any failed use.
   */
  signIn(
    stored: CloudAccount,
  ): Promise<{ ok: true } | { ok: false; refusal: string }>;
  /** The row as the API shows it: its own cloud's columns, no private half. */
  view(row: CloudAccount): CloudAccountView;
  /** What a Delete leaves in the cloud for the operator to remove, each named. */
  leftovers(row: CloudAccount): string;
}

/** Each cloud's {@link CloudProvider}, by `cloud` (ADR-0043). */
@Injectable()
export class CloudProviders {
  private readonly byItsCloud: PerCloud<CloudProvider>;

  constructor(
    readonly aws: AwsProvider,
    readonly gcp: GoogleProvider,
  ) {
    this.byItsCloud = { aws, gcp };
  }

  /** The provider of `cloud`. */
  of(cloud: CloudKind): CloudProvider {
    return byCloud(cloud, this.byItsCloud);
  }
}

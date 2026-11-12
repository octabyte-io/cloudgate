import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The stored Google plans (S20, "Stored plan files"). Google has no
 * moto, so until the first walk in a real project they are planned offline
 * by the pinned OpenTofu and provider from the generated definitions, with
 * no refresh and a hand-built state where one is needed, and each
 * carries the mark below. The walk (`docs/gcp-walk-by-hand.md`) re-records
 * every one of them from real plans and removes the mark; **a release with a
 * marked fixture is not shipped**: the release workflow's Google validate
 * job fails while one is left. This check lists them, so the list below
 * shrinks only by re-recording, and a new hand-written fixture is named here
 * on purpose.
 */

const GOOGLE_PLANS = join(__dirname, 'fixtures', 'plans', 'google');
/** The stored `tofu output -json` of a Google apply, marked alike. */
const GOOGLE_APPLIES = join(__dirname, 'fixtures', 'applies', 'google');
const MARK = 'not yet from a real project';

interface StoredPlan {
  readonly cloudgate_fixture?: {
    readonly source?: string;
    readonly how?: string;
  };
  readonly format_version?: string;
  readonly resource_changes?: readonly {
    readonly type: string;
    readonly provider_name?: string;
  }[];
}

function storedPlans(): [string, StoredPlan][] {
  return readdirSync(GOOGLE_PLANS)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => [
      file,
      JSON.parse(readFileSync(join(GOOGLE_PLANS, file), 'utf8')) as StoredPlan,
    ]);
}

describe('backend/test/cloud-accounts/fixtures/plans/google', () => {
  it(`lists every stored Google plan still marked "${MARK}"`, () => {
    const marked = storedPlans()
      .filter(([, plan]) => plan.cloudgate_fixture?.source === MARK)
      .map(([file]) => file);

    // Every one re-recorded from a real project by the second walk;
    // a bucket on Cloud Storage's, a static site's and an
    // existing bucket's key account and key by the walk of the bucket
    // and static site spec. A Worker's worker pool, a Private web service
    // with the network's run.app zone and a Cron service's job were
    // re-recorded by the walk of the Worker, Private web and Cron spec; a
    // mysql on Cloud SQL's create and an existing one's endpoint by the
    // mysql walk, and an Existing database's endpoint and zone and an
    // existing Valkey's two endpoints by that walk's re-walk on deploy role
    // version 5. A Compose stack's Stack VM and the network's Cloud NAT
    // (#1362), and its Domains' backends (#1371), are planned offline until
    // a walk re-records them.
    expect(marked).toEqual([
      'network-create-cloud-nat.json',
      'stack-vm-create.json',
      'stack-vm-domains.json',
    ]);
  });

  it(`lists every stored Google apply output still marked "${MARK}"`, () => {
    const marked = readdirSync(GOOGLE_APPLIES)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .filter(
        (file) =>
          (
            JSON.parse(readFileSync(join(GOOGLE_APPLIES, file), 'utf8')) as {
              cloudgate_fixture?: { source?: string };
            }
          ).cloudgate_fixture?.source === MARK,
      );

    // A bucket's HMAC key and an existing bucket's key were
    // re-recorded by the walk of the bucket and static site spec. A Worker's
    // first apply, a Private web service's and a Cron service's were
    // re-recorded by the walk of the Worker, Private web and Cron spec, and
    // an existing Valkey's endpoints by the mysql walk's re-walk on deploy
    // role version 5.
    expect(marked).toEqual([]);
  });

  it('holds only plans of `hashicorp/google`, in `tofu show -json` shape', () => {
    for (const [file, plan] of storedPlans()) {
      expect([file, plan.format_version]).toEqual([file, '1.2']);
      for (const change of plan.resource_changes ?? []) {
        expect([file, change.type, change.provider_name]).toEqual([
          file,
          expect.stringMatching(/^google_/),
          'registry.opentofu.org/hashicorp/google',
        ]);
      }
    }
  });
});
